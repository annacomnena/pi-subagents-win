/**
 * wechat-command-consumer.ts — 微信远程斜杠命令**旁路**消费端（0924）
 *
 * 通道（用户裁定④）：命令在**进 LLM 之前**被识别并本地执行——零 LLM、零转写污染、
 * **不走 outbox 注入路径**（不 newOutboxItem、不 sendUserMessage 用户原文）；
 * 回执走既有 reply intent 机制（runtime/wechat-reply.ts + runtime-host/wechat-reply.ts watcher）
 * 发回微信，故不产生 turn → 不触发 agent_end/agent_settled → **不进广播环路**（防环）。
 *
 * 形态（对齐 registerOutboxBridge：session_start + 启动即扫 + fs.watch 即时唤醒 + tick 兜底，
 * 但 watch **不 debounce**——见下「时序」）：
 *   session_start → 注册 inbox watcher + 立即扫一轮 + interval 兜底 tick。
 *
 * 时序（与 host 侧 runtime-host/wechat-input.ts 的竞态，诚实记录）：
 *   host 注入器对 inbox 的 fs.watch 有 **200ms debounce**（wechat-input.ts startWechatInput），
 *   本消费端在同一 FS 事件上**同步立即**扫描（无 debounce）⇒ 正常路径先于 host 拿下记录
 *   （余量 ≈200ms）。残余：本会话 watch 建立失败/会话晚起时退化为 tick 兜底，可能输掉竞态
 *   → 记录被 host 按今天行为注入（回退，非安全问题）；报告「残余/未决」章节有说明。
 *
 * 授权双轴（用户裁定⑥）：
 *   轴一 = openid 白名单 `channels.wechat.input.allowFrom`（与 wechat-input.ts#L35 同口径：
 *          owner openid 或 allowFrom 全等；未授权记录**不 claim**，交回注入路判 not-allowlisted）；
 *   轴二 = 命令许可白名单（runtime/wechat-remote-command.ts 分级表）。
 * 会话门：仅 **global master owner 会话**消费（readAttachment(masterAddress()).sessionId ===
 *   当前会话）——正是注入路本会投递的目标会话，避免 tab/subagent 抢执行；subagent 恒拒。
 * 能力门（裁定⑤ fail-closed）：`channels.wechat.remoteCommands.enabled === true` 才开扫，
 *   缺省关闭时**零 IO 零副作用**，记录留在 pending → 行为回退到今天（既有注入路照旧）。
 *
 * 终态：inbox 记录 → `state:"consumed"`（Hermes 对照 §6.3「dispatched, not queued」第三态；
 * 既非 injected 也非 rejected）。consumed 记录**永远不会**满足 wechat-reply-hook 的
 * `state !== "injected"` 门 → 回执不可能被当成 marker 轮回执。
 * 幂等（at-least-once 兜底）：`runtime/receipts.ts` 收据 first-wins，键前缀 **`wcmd:`**
 * （命名空间避开 outbox:`outbox:` / `run-` / `msg:` / `cmd:`），key = `wcmd:<sha256(msgId)>`。
 * 顺序 = 标终态 → claim → 执行 → 落回执 → defer 副作用（回执先落盘再 reload，研究 Q1.3）。
 *   崩溃窗口（诚实）：标终态后 / claim 后中断 → 该条命令**丢失不重放**（at-most-once，
 *   宁可丢一条 /reload 也不重复执行敏感操作）。
 */

import { createHash } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	watch as fsWatch,
	writeFileSync,
	type FSWatcher,
} from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { WechatStore, inboxFileName } from "./channel-wechat/store.ts";
import { deriveCommandClientId } from "./channel-wechat/send.ts";
import { deriveCommandIntentId, newReplyIntent, replyIntentDir } from "./runtime/wechat-reply.ts";
import { recordNotificationReceipt } from "./runtime/receipts.ts";
import { masterAddress } from "./runtime/address.ts";
import { readAttachment } from "./runtime/registry.ts";
import { defaultRuntimeDir } from "./runtime/journal.ts";
import { getCurrentSessionId, isSubagent } from "./identity.ts";
import {
	classifyRemoteCommand,
	THINKING_LEVELS,
	type RemoteCommandDeps,
	type RemoteCommandOutcome,
	type RemoteCommandPlan,
} from "./runtime/wechat-remote-command.ts";
import {
	maskWechatOpenId,
	readWechatConfigPath,
	readWechatCreds,
	readWechatEnabled,
	readWechatInputConfig,
	readWechatReceiveEnabled,
	readWechatRemoteCommandConfig,
	readWechatReplyConfig,
	setWechatEnabled,
	setWechatReplyConfig,
	setWechatReplyMode,
	wechatCredsPath,
} from "./runtime-host/wechat-bind.ts";

/** 内部派发命令名（会话类敏感动作借 pi 正规命令派发拿 ExtensionCommandContext.reload() 等）。 */
export const WECHAT_REMOTE_RUN_COMMAND = "wechat-remote-run";

// ── 审计（state/wechat-command-audit.jsonl，0600；只记掩码 + 首 token，不记正文全文）────

function audit(stateDir: string, row: Record<string, unknown>): void {
	try {
		mkdirSync(stateDir, { recursive: true });
		const file = join(stateDir, "wechat-command-audit.jsonl");
		const fd = openSync(file, "a", 0o600);
		try {
			appendFileSync(fd, JSON.stringify(row) + "\n");
		} finally {
			closeSync(fd);
		}
		try {
			chmodSync(file, 0o600);
		} catch {
			/* Windows 尽力 */
		}
	} catch {
		/* 审计 best-effort，绝不打断命令通道 */
	}
}

const shortHash = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 12);
const maskId = (s: string): string => (s.length > 10 ? `${s.slice(0, 6)}…${s.slice(-4)}` : shortHash(s));
/** 审计用首 token（≤32 字符）：命令名可见、参数不落盘（秘密卫生：正文全文不进审计）。 */
const auditCmdToken = (text: string): string => (text.trim().split(/\s+/)[0] ?? "").slice(0, 32);

// ── inbox 记录终态写入（consumed；与 wechat-input.atomicRecord 同款 tmp+rename）────────

function inboxRecordPath(runtimeDir: string, msgId: string): string {
	return join(WechatStore.resolveDir(runtimeDir), "inbox", inboxFileName(msgId));
}

function readInboxRaw(path: string): Record<string, unknown> | null {
	try {
		const v: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
	} catch {
		/* 缺文件/坏 JSON → 不 claim，留待下轮 */
	}
	return null;
}

function writeInboxConsumed(path: string, raw: Record<string, unknown>, at: string): void {
	const next = { ...raw, state: "consumed", consumedAt: at };
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
	renameSync(tmp, path);
}

/** 缺省会话门：本会话是否 global master owner（= 注入路本会投递的目标会话）。 */
function defaultIsOwnerSession(): boolean {
	try {
		const owner = readAttachment(masterAddress());
		const sid = getCurrentSessionId();
		return Boolean(owner && sid && owner.sessionId === sid);
	} catch {
		return false;
	}
}

/** 缺省幂等 claim（跨进程 first-wins；键形 `wcmd:<sha256(msgId)>`，无空白、命名空间隔离）。 */
function defaultClaim(key: string): boolean {
	return recordNotificationReceipt(key, "wechat-command");
}

/** `wcmd:` 收据键（msgId 经 sha256：hex、无空白、与 inbox 文件名解耦）。 */
export function wcmdReceiptKey(msgId: string): string {
	return `wcmd:${createHash("sha256").update(msgId, "utf8").digest("hex")}`;
}

// ── 状态文本（`/wechat status` 与远程回执同源，研究 Q6.1#7 前置重构点）──────────────

/**
 * `/wechat status` 状态文本（纯计算 + 只读 IO）。TUI `/wechat status` 与远程命令回执
 * **共用本函数**，保证两端文案不会漂移。
 */
export function buildWechatStatusText(opts: { configPath?: string; runtimeDir?: string } = {}): string {
	const configPath = opts.configPath ?? readWechatConfigPath();
	const runtimeDir = opts.runtimeDir ?? defaultRuntimeDir();
	let worker = "(状态不可读)";
	try {
		const stats = new WechatStore(join(runtimeDir, "wechat", "receive")).stats();
		worker = `status=${stats.status} polls=${stats.counts.polls} received=${stats.counts.received}`;
	} catch {
		/* tolerant status */
	}
	const creds = readWechatCreds(wechatCredsPath(runtimeDir));
	const botId = creds?.botId;
	const replyCfg = readWechatReplyConfig(configPath);
	const inputCfg = readWechatInputConfig(configPath);
	return [
		`wechat: enabled=${readWechatEnabled(configPath)}`,
		`reply.enabled=${replyCfg.enabled} mode=${replyCfg.mode} scope=${replyCfg.sessionScope}`,
		`receive.enabled=${readWechatReceiveEnabled(configPath)}`,
		`input.enabled=${inputCfg.enabled} allowFrom=${inputCfg.allowFrom.length}`,
		`remoteCommands.enabled=${readWechatRemoteCommandConfig(configPath).enabled}`,
		`worker: ${worker}`,
		`credentials: ${creds ? `已绑定${botId ? ` botId=${botId.length > 6 ? `${botId.slice(0, 3)}…${botId.slice(-2)}` : "…"}` : ""}` : "未绑定"}`,
	].join("\n");
}

// ── 扫描（核心，同步、幂等、可注入）───────────────────────────────────────────

export interface WechatCommandScanOptions {
	runtimeDir?: string;
	configPath?: string;
	stateDir?: string;
	now?: () => Date;
	/** 能力门读取（缺省 readWechatRemoteCommandConfig；false → 零副作用早退）。 */
	readRemoteConfig?: (configPath: string) => { enabled: boolean };
	/** 轴一白名单读取（缺省 readWechatInputConfig）。 */
	readInputConfig?: (configPath: string) => { enabled: boolean; allowFrom: string[] };
	/** owner openid（缺省从 credentials.json 读，同 wechat-input.ts）。 */
	ownerOpenId?: () => string | undefined;
	store?: () => WechatStore;
	/** 会话门（缺省 readAttachment(masterAddress()).sessionId === getCurrentSessionId()）。 */
	isOwnerSession?: () => boolean;
	subagent?: () => boolean;
	/** 跨进程幂等 claim（缺省 receipts first-wins；测试可注入计数 fake）。 */
	claim?: (key: string) => boolean;
	/** 命令执行依赖（必填：生产接 defaultRemoteCommandDeps(pi)，测试接 fake）。 */
	deps: RemoteCommandDeps;
}

export interface WechatCommandScanReport {
	/** 早退原因：disabled（缺省 fail-closed）/ subagent / not-owner / empty（无命令形态 pending）。 */
	reason?: "disabled" | "subagent" | "not-owner" | "empty";
	/** 命令形态的 pending 记录数（含未授权）。 */
	considered: number;
	/** 命令形态但 openid 不在白名单 → 不 claim，交回注入路判 not-allowlisted。 */
	notAllowlisted: number;
	/** claim 赢者（真正执行/拒绝的条数）。 */
	claimed: number;
	/** 收据已在（stale 接管/重复扫描）→ 只收敛终态，不重复执行。 */
	alreadyClaimed: number;
	/** 白名单命中并已执行（safe+sensitive，裁定②免确认）。 */
	accepted: number;
	/** 显式拒绝（danger/unknown/usage）并已写回执。 */
	denied: number;
	/** 执行抛错（回执 = 执行失败，不重放）。 */
	failed: number;
}

const emptyReport = (): WechatCommandScanReport => ({
	considered: 0, notAllowlisted: 0, claimed: 0, alreadyClaimed: 0, accepted: 0, denied: 0, failed: 0,
});

/** 本进程注入回执（intent）正文：>4000 截断（沿用出站 4000+截断纪律）。 */
function receiptText(text: string): string {
	return text.length > 4000 ? `${text.slice(0, 4000)}…[截断]` : text;
}

/**
 * 扫一轮：能力门 → 会话门 → 授权轴一 → 分类 → 标终态 → claim → 执行/拒绝 → 写回执 → 审计。
 * 任何异常内部吞掉（消费端绝不破坏宿主会话）；同步执行（watch 回调内直接跑，无 debounce）。
 */
export function scanWechatRemoteCommands(opts: WechatCommandScanOptions): WechatCommandScanReport {
	const report = emptyReport();
	try {
		const runtimeDir = opts.runtimeDir ?? defaultRuntimeDir();
		const configPath = opts.configPath ?? readWechatConfigPath();
		// ① 能力门（裁定⑤ fail-closed）：缺省关闭 → 零 IO 零副作用，记录留 pending = 今天行为
		if (!(opts.readRemoteConfig ?? readWechatRemoteCommandConfig)(configPath).enabled) {
			report.reason = "disabled";
			return report;
		}
		// ② 会话门：subagent 恒拒；仅 master owner 会话消费
		if ((opts.subagent ?? isSubagent)()) {
			report.reason = "subagent";
			return report;
		}
		if (!(opts.isOwnerSession ?? defaultIsOwnerSession)()) {
			report.reason = "not-owner";
			return report;
		}
		const stateDir = opts.stateDir ?? join(runtimeDir, "state");
		const inputCfg = (opts.readInputConfig ?? readWechatInputConfig)(configPath);
		const ownerOpenId = opts.ownerOpenId
			? opts.ownerOpenId()
			: readWechatCreds(wechatCredsPath(runtimeDir))?.ownerOpenId;
		const store = opts.store ? opts.store() : new WechatStore(WechatStore.resolveDir(runtimeDir));
		const pending = store.readInbox(0)
			.filter((r) => r.state === "pending")
			.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.msgId.localeCompare(b.msgId));
		if (!pending.length) {
			report.reason = "empty";
			return report;
		}
		const now = () => (opts.now ? opts.now() : new Date()).toISOString();
		const dir = replyIntentDir(stateDir);
		for (const rec of pending) {
			const plan: RemoteCommandPlan = classifyRemoteCommand(rec.text);
			// 非命令形态 → 不 claim 不改终态：留给既有注入路（今天行为；路径、散文、模板均不受影响）
			if (plan.kind === "not-command") continue;
			report.considered++;
			// 轴一：openid 白名单（同 wechat-input.ts#L35 全等口径）→ 未授权不 claim，
			// 交回注入路产生既有 `not-allowlisted` rejected 终态 + 审计（今天行为不变）。
			if (!rec.fromId || (rec.fromId !== ownerOpenId && !inputCfg.allowFrom.includes(rec.fromId))) {
				report.notAllowlisted++;
				continue;
			}
			const path = inboxRecordPath(runtimeDir, rec.msgId);
			const raw = readInboxRaw(path);
			if (!raw) continue; // 读不到原记录 → 不 claim，留待下轮
			// 终态先落（consumed）→ 注入路从此看不见它；claim 决定「谁执行」
			try {
				writeInboxConsumed(path, raw, now());
			} catch {
				continue; // 落终态失败 → 重试下轮（未 claim，可安全重来）
			}
			const claimed = (opts.claim ?? defaultClaim)(wcmdReceiptKey(rec.msgId));
			if (!claimed) {
				report.alreadyClaimed++;
				continue;
			}
			report.claimed++;
			// 执行 / 拒绝（回执文本先算出；defer 副作用留到回执落盘之后）
			let outcome: RemoteCommandOutcome;
			let decision: "command-accepted" | "command-denied" | "command-failed";
			let tier: string;
			let reason: string | undefined;
			try {
				if (plan.kind === "exec") {
					outcome = plan.execute(opts.deps);
					decision = "command-accepted";
					tier = plan.tier;
				} else {
					outcome = { text: plan.text };
					decision = "command-denied";
					tier = plan.tier;
					reason = plan.reason;
				}
			} catch (e) {
				outcome = { text: `命令执行失败：${e instanceof Error ? e.message : String(e)}`.slice(0, 4000) };
				decision = "command-failed";
				tier = plan.tier;
				reason = "threw";
			}
			// 回执（reply intent，kind="command"：走既有 watcher，无 connected 门/TTL/mode 门 = 与
			// reply intent 同待遇；但**不产生 turn** ⇒ 不进广播环路）
			const id = deriveCommandIntentId(rec.msgId);
			let intentWritten = false;
			try {
				const created = newReplyIntent(dir, {
					id,
					msgId: rec.msgId,
					outboxId: id,
					fromId: rec.fromId,
					clientId: deriveCommandClientId(rec.msgId, rec.fromId),
					text: receiptText(outcome.text),
					kind: "command",
					...(opts.now ? { now: opts.now() } : {}),
				});
				intentWritten = Boolean(created?.created);
			} catch {
				intentWritten = false;
			}
			audit(stateDir, {
				at: now(),
				decision,
				tier,
				...(reason ? { reason } : {}),
				cmd: auditCmdToken(rec.text),
				msgId: maskId(rec.msgId),
				from: maskWechatOpenId(rec.fromId),
				intent: id,
				intentWritten,
			});
			if (decision === "command-accepted") report.accepted++;
			else if (decision === "command-denied") report.denied++;
			else report.failed++;
			// ③ 副作用延后：回执已落盘（reload 后旧 ctx 即 stale，研究 Q1.3 纪律）
			try {
				outcome.defer?.();
			} catch {
				/* 派发失败：回执措辞已是保守的「已请求执行」，不改写、不重放 */
			}
		}
		if (!report.considered) report.reason = "empty";
	} catch {
		/* 消费端永不抛 */
	}
	return report;
}

// ── 生产依赖接线（配置类直连 wechat-bind；会话类走内部命令派发）──────────────────

/**
 * 生产 RemoteCommandDeps：
 *  - 配置类（/wechat …）→ 同步写 config（与 index.ts `/wechat` handler 同函数）；
 *  - 会话类（/reload /compact /model /thinking）→ `pi.sendUserMessage("/wechat-remote-run …",
 *    { expandPromptTemplates: true })`——pi 正规扩展命令派发（agent-session.js#L1218：
 *    handler 命中即 return，**不构造 messages、不跑模型、不落转写**）。
 *    绝不用用户原文调用 sendUserMessage（那是注入路 = 转写污染，本通道禁用）。
 */
export function defaultRemoteCommandDeps(
	pi: ExtensionAPI,
	opts: { configPath?: string; runtimeDir?: string } = {},
): RemoteCommandDeps {
	const configPath = () => opts.configPath ?? readWechatConfigPath();
	const dispatch = (action: string): void => {
		try {
			const r = pi.sendUserMessage(`/${WECHAT_REMOTE_RUN_COMMAND} ${action}`, { expandPromptTemplates: true }) as unknown;
			if (r && typeof (r as { then?: unknown }).then === "function") {
				(r as Promise<unknown>).catch(() => { /* 派发失败不重放 */ });
			}
		} catch {
			/* best-effort */
		}
	};
	return {
		wechatStatus: () => buildWechatStatusText({ configPath: configPath(), ...(opts.runtimeDir ? { runtimeDir: opts.runtimeDir } : {}) }),
		setWechatEnabled: (on) => setWechatEnabled(on, configPath()),
		setReplyMode: (mode) => setWechatReplyMode(mode, configPath()),
		setReplyEnabled: (on) => setWechatReplyConfig(on, configPath()),
		reload: () => dispatch("reload"),
		compact: () => dispatch("compact"),
		setModel: (id) => dispatch(`model ${id}`),
		setThinking: (level) => dispatch(`thinking ${level}`),
	};
}

/**
 * 内部命令 handler：拿 `ExtensionCommandContext`（ctx.reload 只在此处存在，types.d.ts#L291；
 * 内置命令无按名 invoke API → 等价动作经此派发，研究 Q1.3）。本地手动输入同名命令无害
 * （等价于本机 /reload）；远程输入到不了这里（未入白名单 → 在 classify 恒拒）。
 */
function registerRemoteRunCommand(pi: ExtensionAPI): void {
	pi.registerCommand(WECHAT_REMOTE_RUN_COMMAND, {
		description: "内部：远程斜杠命令的本地等价执行（wechat-command-consumer 派发，勿手动输入）",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const action = (parts[0] ?? "").toLowerCase();
			try {
				if (action === "reload") {
					await ctx.reload();
					return;
				}
				if (action === "compact") {
					ctx.compact();
					return;
				}
				if (action === "model") {
					const id = parts.slice(1).join(" ");
					const models = [...ctx.modelRegistry.getAvailable(), ...ctx.modelRegistry.getAll()];
					const model = models.find((m) => m.id === id);
					if (!model) {
						ctx.ui.notify(`wechat 远程 /model：未找到模型 ${id}`, "warning");
						return;
					}
					const done = await pi.setModel(model);
					ctx.ui.notify(done ? `wechat model=${id}` : `wechat model=${id} 设置失败（provider 未认证）`, done ? "info" : "warning");
					return;
				}
				if (action === "thinking") {
					const level = parts[1] ?? "";
					if (!(THINKING_LEVELS as readonly string[]).includes(level)) {
						ctx.ui.notify(`用法：/thinking ${THINKING_LEVELS.join("|")}`, "warning");
						return;
					}
					pi.setThinkingLevel(level as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
					ctx.ui.notify(`wechat thinking=${level}`, "info");
					return;
				}
				ctx.ui.notify(`wechat-remote-run：无法识别的动作 ${action || "(空)"}`, "warning");
			} catch (e) {
				ctx.ui.notify(`wechat 远程命令执行失败：${e instanceof Error ? e.message : String(e)}`, "warning");
			}
		},
	});
}

export interface RegisterWechatRemoteCommandsOptions extends Omit<WechatCommandScanOptions, "deps"> {
	/** 兜底 tick（缺省 5s，与 host 注入器同拍；正常路径由 fs.watch 即时唤醒）。 */
	intervalMs?: number;
	/** 显式注入 deps（缺省 defaultRemoteCommandDeps(pi)）。 */
	deps?: RemoteCommandDeps;
}

/**
 * 注册：内部命令（立即）+ session_start 起 watch/tick（形态同 registerOutboxBridge）。
 * 返回清理函数（session_shutdown / 扩展重载时由 index.ts collect）。
 */
export function registerWechatRemoteCommands(
	pi: ExtensionAPI,
	opts: RegisterWechatRemoteCommandsOptions = {},
): () => void {
	const runtimeDir = opts.runtimeDir ?? defaultRuntimeDir();
	const deps = opts.deps ?? defaultRemoteCommandDeps(pi, { ...(opts.configPath ? { configPath: opts.configPath } : {}), runtimeDir });
	const scanOpts: WechatCommandScanOptions = { ...opts, runtimeDir, deps };
	try {
		registerRemoteRunCommand(pi);
	} catch {
		/* 注册失败不阻断扩展加载 */
	}
	const receiveDir = join(runtimeDir, "wechat", "receive");
	const inboxDir = join(receiveDir, "inbox");
	let gen = 0;
	let interval: ReturnType<typeof setInterval> | null = null;
	let watcher: FSWatcher | null = null;
	const run = (): void => {
		try {
			scanWechatRemoteCommands(scanOpts);
		} catch {
			/* 消费端永不抛 */
		}
	};
	const ensureWatch = (myGen: number): void => {
		if (watcher || myGen !== gen) return;
		// 只在 receive 树已存在时建 watch（能力缺省关闭且从未收过消息时，不主动造目录）
		if (!existsSync(receiveDir)) return;
		try {
			mkdirSync(inboxDir, { recursive: true });
			const w = fsWatch(inboxDir, { persistent: false }, (_event, filename) => {
				if (myGen !== gen) return;
				// 只对 .json 终态文件响应（.tmp 原子写中间态忽略）
				if (filename && !filename.endsWith(".json")) return;
				run(); // **立即、无 debounce**：先于 host 侧 wechat-input 的 200ms debounce 拿下记录
			});
			w.on("error", () => {
				try {
					w.close();
				} catch {
					/* ignore */
				}
				if (watcher === w) watcher = null;
			});
			watcher = w;
		} catch {
			watcher = null; // watch 不可用 → tick 兜底
		}
	};
	const stop = (): void => {
		gen++;
		if (interval) clearInterval(interval);
		interval = null;
		if (watcher) {
			try {
				watcher.close();
			} catch {
				/* ignore */
			}
			watcher = null;
		}
	};
	const start = (): void => {
		stop();
		// 子 agent 纵深隔离：不建 watch/tick（scan 内还有第二道同名门）
		try {
			if ((opts.subagent ?? isSubagent)()) return;
		} catch {
			return;
		}
		const myGen = gen;
		run(); // 启动即扫（重启 reclaim，不等首个 tick）
		ensureWatch(myGen);
		interval = setInterval(() => {
			if (myGen !== gen) return;
			ensureWatch(myGen); // watch 失败/目录后建：每 tick 重试建立
			run();
		}, opts.intervalMs ?? 5_000);
		interval.unref?.();
	};
	pi.on("session_start", () => {
		try {
			start();
		} catch {
			/* 绝不破坏宿主会话 */
		}
	});
	return () => stop();
}
