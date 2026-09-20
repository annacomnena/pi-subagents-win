/**
 * mailbox-consumer.ts — Mailbox 真消费端（Phase 4d，A5 F10/F16/F17）
 *
 * 单封顺序（F16，任一点崩溃可证 at-least-once）：
 *   list 圈定 → fencing 预检 → 定向 claim → fencing 复检 → preInject 门
 *   → sendUserMessage 注入 → postInject 确认 → .notified 补认领（best-effort）
 *   → ackLetter
 *
 * F17 旧信保护：sentAt/issuedAt 早于 cutover.enabledAt 的信一律跳过
 * （pre-cutover-legacy），留给 legacy——9903 信即此类，永不重注。
 * 未切换（flag 关/无 registry）时本消费端零动作（legacy 原行为）。
 *
 * 命令信接线（0920 backlog A，仅 agent://master_default 域）：command 分支不再一律
 * deferred——recipient 全等 masterAddress() 时走确定性执行链：fileId claim → F16
 * fencing 复检 → executeCommand(frame) 进程内直调 → 纯报告回执 → ack（三态全终态，
 * 不重投）。红线：命令信绝不进 LLM 注入——executor 在 claim 链内执行，LLM 只收结果
 * 报告。ws/scope 域命令信维持 command-deferred 现状（行为零变化；已知边界：这两域
 * 命令信会被 LLM 唤醒链 claim 当触发器消费）。
 *
 * 注册形态同 report 监听器：session_start（仅主会话）+ interval tick。
 * 所有异常内部吞掉，绝不破坏宿主会话。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	ackLetter,
	claimLetters,
	defaultMailboxDir,
	listLetters,
	mailboxDirFor,
	type Letter,
} from "./runtime/mailbox.ts";
import { executeCommand, type CommandOutcome, type ExecuteCommandOptions } from "./runtime/command-executor.ts";
import type { CommandFrame } from "./runtime/protocol.ts";
import { masterAddress, type ObjectAddress } from "./runtime/address.ts";
import { readAttachment, readCutover } from "./runtime/registry.ts";
import { resolveRecipient } from "./runtime/resolver.ts";
import { auditSuppression, postInject, preInject } from "./injection-gate.ts";
import { claimNotified } from "./event-bus.ts";
import { defaultTabRunsDir } from "./tab-runs.ts";
import { isMainSession, isSubagent, durableSessionIdentity } from "./identity.ts";
import { NO_POLL_HINT } from "./no-poll.ts";
import { auditWakeSpawnFailed, confirmWakeSpawn, evaluateWakes, type WakeDecision } from "./runtime/wake.ts";
import {
	auditScopeWakeSpawnFailed,
	confirmScopeWakeSpawn,
	evaluateScopeWake,
	localMasterAddress,
	localMasterScope,
	silentScopeGenesis,
	takeoverStaleScopeOwner,
	type ScopeWakeDecision,
} from "./runtime/scope.ts";

export interface ConsumeOptions {
	sessionId: string | undefined;
	recipient?: ObjectAddress;
	mailboxDir?: string;
	/** .notified 认领目录（缺省真实 tab-runs；测试传隔离目录） */
	runsDir?: string;
	/** 注入实现（生产接 pi.sendUserMessage，测试传 fake） */
	sendUserMessage?: (body: string, opts?: { deliverAs?: string }) => void;
	/** executeCommand 选项透传（stateDir/configPath/commandsDir/journalPath；测试注入隔离用） */
	executeCommandOptions?: ExecuteCommandOptions;
}

export interface ConsumeEntry {
	messageId: string;
	action: "injected" | "skipped" | "executed";
	reason?: string;
}

export interface ConsumeReport {
	owner: string | null;
	consumed: ConsumeEntry[];
}

/** 信件领域时间（F17 比较用）。 */
function letterTime(letter: Letter): string {
	return letter.frame.frame === "message" ? letter.frame.sentAt : letter.frame.issuedAt;
}

/** 信标识（与 consumer-scan 同规则）。 */
function describeLetter(letter: Letter): string {
	return letter.frame.frame === "message" ? letter.frame.id : `cmd:${letter.frame.commandKey}`;
}

/** 收据键（与 consumer-scan 同规则；派生不出 → msg:<id> 兜底）。 */
function receiptKeyFor(letter: Letter): string {
	if (letter.frame.frame === "command") return `cmd:${letter.frame.commandKey}`;
	const subject = letter.frame.subject;
	const details = letter.frame.body.details as { status?: string } | undefined;
	if (subject && subject.startsWith("run://tab/") && details?.status) {
		return `run-${subject.slice("run://tab/".length)}-${details.status}`;
	}
	return `msg:${letter.frame.id}`;
}

function holderOf(sessionId: string): string {
	return `mailbox-consumer:${sessionId}`;
}

/**
 * master_default spool 的 pending 命令信（dir-list 帮手，照 scope.ts listScopeWakeLetters
 * 模式）：command 帧无 frame.id、spool 落盘时才分配文件名=messageId（F7 不变量），
 * 故 claim/ack 必须用 spool 文件名（fileId）。listLetters 不回文件名（mailbox API 零改动）。
 */
function listPendingCommandLetters(recipient: ObjectAddress, mailboxDir: string): Array<{ fileId: string; letter: Letter }> {
	const dir = mailboxDirFor(recipient, mailboxDir);
	if (!existsSync(dir)) return [];
	const out: Array<{ fileId: string; letter: Letter }> = [];
	for (const f of readdirSync(dir)) {
		if (!f.endsWith(".json")) continue;
		try {
			const letter = JSON.parse(readFileSync(join(dir, f), "utf8")) as Letter;
			if (letter.status !== "pending") continue;
			if (letter.frame.frame !== "command") continue;
			out.push({ fileId: f.slice(0, -".json".length), letter });
		} catch {
			continue;
		}
	}
	return out;
}

/** 已审计过的 pre-cutover 键（进程内去重：tick 每轮重扫不再重复记审计；审计是诊断性的） */
const auditedPreCutover = new Set<string>();

/**
 * 消费一轮（owner 会话调用）。返回报告；任何单封失败不影响其余。
 */
export function consumeMailboxOnce(opts: ConsumeOptions): ConsumeReport {
	const report: ConsumeReport = { owner: null, consumed: [] };
	try {
		return consumeMailboxOnceInner(opts);
	} catch {
		return report; // 顶层兜底：消费端永不抛
	}
}

function consumeMailboxOnceInner(opts: ConsumeOptions): ConsumeReport {
	const report: ConsumeReport = { owner: null, consumed: [] };
	const recipient = opts.recipient ?? masterAddress();
	const mailboxDir = opts.mailboxDir ?? defaultMailboxDir();
	const cutover = readCutover();
	const attachment = readAttachment(recipient);
	if (!cutover?.enabled || !attachment) return { owner: null, consumed: [] }; // 未切换：零动作
	if (!opts.sessionId || opts.sessionId !== attachment.sessionId) {
		return { owner: attachment.sessionId, consumed: [] }; // 非 owner：零动作（抑制审计由 legacy 门负责）
	}
	const owner = attachment.sessionId;
	report.owner = owner;

	// 命令信 fileId 索引（仅 master_default 域；commandKey → pending fileId 队列，同键多封
	// 各领一个 fileId——重放信由 executor 幂等回放 outcome，逐封 ack 终态）
	const commandFileIds = new Map<string, string[]>();
	if (recipient === masterAddress()) {
		try {
			for (const { fileId, letter } of listPendingCommandLetters(recipient, mailboxDir)) {
				if (letter.frame.frame !== "command") continue;
				const list = commandFileIds.get(letter.frame.commandKey);
				if (list) list.push(fileId);
				else commandFileIds.set(letter.frame.commandKey, [fileId]);
			}
		} catch {
			commandFileIds.clear(); // 索引失败 → 命令信落 claim-missed（safe，不破坏 message 链）
		}
	}

	const pending = listLetters(recipient, "pending", mailboxDir);
	for (const letter of pending) {
		const messageId = describeLetter(letter);
		try {
			// F17：cutover 前的旧信留给 legacy（每键只审计一次，防 tick 刷屏）
			if (letterTime(letter) < cutover.enabledAt) {
				const auditKey = receiptKeyFor(letter);
				if (!auditedPreCutover.has(auditKey)) {
					auditedPreCutover.add(auditKey);
					auditSuppression(
						{ key: auditKey, sessionId: opts.sessionId, path: "mailbox-consumer" },
						"pre-cutover-legacy",
						{ sessionId: attachment.sessionId, generation: attachment.generation },
					);
				}
				reportPush(report, messageId, "skipped", "pre-cutover-legacy");
				continue;
			}
			// command 帧（0920 backlog A）：域路由拍板 v1 只接线 agent://master_default——
			// recipient 全等门外的 ws/scope 域维持 command-deferred 现状（信保持 pending，
			// 行为零变化；已知边界：投到这两域的命令信会被 LLM 唤醒链 claim 消费）。
			if (letter.frame.frame === "command") {
				if (recipient !== masterAddress()) {
					reportPush(report, messageId, "skipped", "command-deferred");
					continue;
				}
				// 定向 claim：command 帧无 frame.id，用 spool 文件名（fileId，F7）
				const fileId = commandFileIds.get(letter.frame.commandKey)?.shift();
				if (!fileId) {
					reportPush(report, messageId, "skipped", "claim-missed");
					continue;
				}
				const taken = claimLetters(recipient, { claimedBy: holderOf(opts.sessionId), mailboxDir, ids: [fileId], limit: 1 });
				if (taken.length === 0) {
					reportPush(report, messageId, "skipped", "claim-missed");
					continue;
				}
				// F16 fencing 复检必须先于 execute：失去 owner 身份的会话不得执行命令
				const fresh = resolveRecipient(recipient);
				if (!fresh || fresh.sessionId !== opts.sessionId) {
					reportPush(report, messageId, "skipped", "generation-moved");
					continue; // 已 claim 的信留给 stale 回收
				}
				// 红线：命令信绝不进 LLM 注入——executor 进程内确定性执行（never-throw 三态），
				// 跳过 preInject 统一门与 buildInjectBody 注入路径（命令侧去重 = executor wx claim）。
				let outcome: CommandOutcome;
				try {
					outcome = executeCommand(letter.frame, opts.executeCommandOptions);
				} catch (e) {
					outcome = { status: "failed", reason: "failed", error: e instanceof Error ? e.message : String(e), replayed: false };
				}
				reportPush(report, messageId, "executed", `command-${outcome.status}${outcome.status === "rejected" ? `:${outcome.reason}` : ""}`);
				// 回执：向 owner 会话发一条纯报告 followUp（无任何待执行指令语义；不走 preInject
				// 门——回执重复无害）。best-effort，失败不影响 ack。
				try {
					opts.sendUserMessage?.(buildCommandReceiptBody(letter.frame, outcome), { deliverAs: "followUp" });
				} catch {
					/* best-effort */
				}
				// 三态全终态 ack、不重投：rejected 在 executor 幂等 claim 之前拒、不占键，重投必再拒；
				// failed 留 pending/claimed 会经 10min stale reclaim 无限空转——重试语义由 issuer
				// 换新 commandKey 重发承担。
				ackLetter(recipient, fileId, { mailboxDir });
				continue;
			}
			// 定向 claim（单封）
			const frameId = letter.frame.frame === "message" ? letter.frame.id : undefined;
			const taken = frameId
				? claimLetters(recipient, { claimedBy: holderOf(opts.sessionId), mailboxDir, ids: [frameId], limit: 1 })
				: [];
			if (taken.length === 0) {
				reportPush(report, messageId, "skipped", "claim-missed");
				continue;
			}
			// F16：claim 后 fencing 复检
			const fresh = resolveRecipient(recipient);
			if (!fresh || fresh.sessionId !== opts.sessionId) {
				reportPush(report, messageId, "skipped", "generation-moved");
				continue; // 已 claim 的信留给 stale 回收（不丢）
			}
			// 统一门（S6：消费端传谁的 recipient 就按谁的归属判；缺省全局逐字节不变，零回归）
			const key = receiptKeyFor(letter);
			const verdict = preInject({ key, sessionId: opts.sessionId, path: "mailbox-consumer", ...(opts.recipient ? { recipient: opts.recipient } : {}) });
			if (!verdict.inject) {
				if (verdict.reason === "already-injected") {
					ackLetter(recipient, frameId!, { mailboxDir }); // 活干完了，收尾 ack
					reportPush(report, messageId, "skipped", "already-injected-acked");
				} else {
					reportPush(report, messageId, "skipped", verdict.reason);
				}
				continue;
			}
			// 注入
			let ok = false;
			try {
				opts.sendUserMessage?.(buildInjectBody(letter), { deliverAs: "followUp" });
				ok = true;
			} catch {
				ok = false;
			}
			postInject({ key, sessionId: opts.sessionId, path: "mailbox-consumer" }, ok);
			if (!ok) {
				reportPush(report, messageId, "skipped", "inject-failed");
				continue;
			}
			// .notified 补认领（best-effort：堵 legacy 路径重注，terra 三路去重）
			try {
				if (letter.frame.frame === "message" && letter.frame.subject?.startsWith("run://tab/")) {
					claimNotified(opts.runsDir ?? defaultTabRunsDir(), letter.frame.subject.slice("run://tab/".length));
				}
			} catch {
				/* best-effort */
			}
			ackLetter(recipient, frameId!, { mailboxDir });
			reportPush(report, messageId, "injected");
		} catch {
			reportPush(report, messageId, "skipped", "error");
		}
	}
	return { owner, consumed: report.consumed };
}

function reportPush(report: ConsumeReport, messageId: string, action: "injected" | "skipped" | "executed", reason?: string): void {
	report.consumed.push({ messageId, action, reason });
}

/**
 * 命令回执正文（0920 backlog A5）：type/key + status + summary/reason/error + replayed
 * 标注。固化纯报告模板——回执是报告不是指令，防 LLM 把回执当待执行命令。
 */
function buildCommandReceiptBody(frame: CommandFrame, outcome: CommandOutcome): string {
	const head = `📬 命令回执：${frame.type}（key=${frame.commandKey}）→ ${outcome.status}${outcome.replayed ? "（重放：同 commandKey 已执行过，回放首次结果，零二次副作用）" : ""}`;
	const line =
		outcome.status === "accepted"
			? `结果: ${outcome.summary}`
			: outcome.status === "rejected"
				? `拒绝原因: ${outcome.reason}${outcome.detail ? `（${outcome.detail}）` : ""}`
				: `失败: ${outcome.reason}${outcome.error ? `（${outcome.error}）` : ""}`;
	return [head, line, "（本条是确定性执行器的纯结果报告；命令信已执行并 ack，无需任何后续动作。）"].join("\n");
}

/** 注入正文（与 followUp 同风格，标注 mailbox 路径来源）。command 分支已删：命令信走
 * executor 确定性执行（红线：绝不进 LLM 注入），本函数只服务 message 注入。 */
function buildInjectBody(letter: Letter): string {
	const details = letter.frame.body.details as { tabRunId?: string; taskId?: string } | undefined;
	const task = details?.taskId ? ` task=${details.taskId}` : "";
	return [
		`📬 Tab ${details?.tabRunId ?? letter.frame.subject} 已完成（mailbox REPORT${task}）`,
		`摘要: ${letter.frame.body.summary.slice(0, 500)}`,
		`下一步: 用 reclaim-tabs 确认并编排后续；本消息已在 mailbox ack，不会重复。`,
		// 完成类消息（command 分支不附；与 event-bus 完成体同一常量，cutover 切流前后纪律一致）
		NO_POLL_HINT,
	].join("\n");
}

/**
 * 注册主会话消费循环（形态同 report 监听器：session_start + interval tick）。
 * flag 关/非 owner 时 tick 为空转（零行为变化）。
 */
export function registerMailboxConsumer(
	pi: {
		on: (event: string, cb: (event: unknown, ctx?: { sessionManager?: { sessionId?: string } }) => void) => void;
		sendUserMessage?: (body: string, opts?: { deliverAs?: string }) => void;
	},
	opts: { mailboxDir?: string; intervalMs?: number } = {},
): () => void {	let interval: ReturnType<typeof setInterval> | null = null;
	let sessionGen = 0;
	pi.on("session_start", (_event, ctx) => {
		try {
			if (isSubagent()) return;
			// 消费注册 ownership-gated（M1，与 event-bus watcher 同不变量）：cutover 启用时
			// 「owner 是谁谁消费」（UUID 域，与 attach 写入侧同域——tab 形态 owner 重启前也可消费）；
			// 未启用/无 registry → legacy 回退 isMainSession（零变化）；子 agent 恒不消费。
			const sid = (ctx as { sessionManager?: { sessionId?: string } } | undefined)?.sessionManager?.sessionId;
			const cut = readCutover();
			const att = readAttachment(masterAddress());
			const eligible = cut?.enabled && att
				? Boolean(sid && sid === att.sessionId)
				: isMainSession();
			if (!eligible) return;
		} catch {
			return;
		}
		const myGen = ++sessionGen;
		const closed = (): boolean => myGen !== sessionGen;
		if (interval) clearInterval(interval);
		const sid = ctx?.sessionManager?.sessionId;
		const send = pi.sendUserMessage?.bind(pi);
		interval = setInterval(() => {
			if (closed()) return;
			try {
				consumeMailboxOnce({ sessionId: sid, mailboxDir: opts.mailboxDir, sendUserMessage: send });
			} catch {
				/* 消费端永不破坏会话 */
			}
		}, opts.intervalMs ?? 10_000);
		interval.unref?.();
	});
	return () => {
		sessionGen++;
		if (interval) clearInterval(interval);
		interval = null;
	};
}

/**
 * 注册 Sub-Master 唤醒循环（Phase 5c）：与消费循环同形态但独立 interval。
 * tick 内：evaluateWakes（纯评估+claim）→ spawn（调用方注入）→ confirm/audit。
 * cutover 关/非 owner/无 ws/无信时全程空转（零行为变化）。
 * spawn 抛错 → auditWakeSpawnFailed，信留 claimed（stale 恢复），tick 继续。
 */
export function registerWakeLoop(
	pi: {
		on: (event: string, cb: (event: unknown, ctx?: { sessionManager?: { sessionId?: string } }) => void) => void;
	},
	opts: {
		spawn: (decision: WakeDecision, sessionId: string | undefined) => string;
		mailboxDir?: string;
		stateDir?: string;
		runsDir?: string;
		intervalMs?: number;
	},
): () => void {
	let interval: ReturnType<typeof setInterval> | null = null;
	let sessionGen = 0;
	pi.on("session_start", (_event, ctx) => {
		try {
			if (isSubagent()) return;
			// 消费注册 ownership-gated（M1，与 event-bus watcher 同不变量）：cutover 启用时
			// 「owner 是谁谁消费」（UUID 域，与 attach 写入侧同域——tab 形态 owner 重启前也可消费）；
			// 未启用/无 registry → legacy 回退 isMainSession（零变化）；子 agent 恒不消费。
			const sid = (ctx as { sessionManager?: { sessionId?: string } } | undefined)?.sessionManager?.sessionId;
			const cut = readCutover();
			const att = readAttachment(masterAddress());
			const eligible = cut?.enabled && att
				? Boolean(sid && sid === att.sessionId)
				: isMainSession();
			if (!eligible) return;
		} catch {
			return;
		}
		const myGen = ++sessionGen;
		const closed = (): boolean => myGen !== sessionGen;
		if (interval) clearInterval(interval);
		const sid = ctx?.sessionManager?.sessionId;
		interval = setInterval(() => {
			if (closed()) return;
			try {
				const decisions = evaluateWakes({
					sessionId: sid,
					mailboxDir: opts.mailboxDir,
					stateDir: opts.stateDir,
					runsDir: opts.runsDir,
				});
				for (const d of decisions) {
					if (!d.fire) continue;
					try {
						const tabRunId = opts.spawn(d, sid);
						confirmWakeSpawn(d.workstreamId, tabRunId, {
							stateDir: opts.stateDir,
							mailboxDir: opts.mailboxDir,
							sessionId: sid!,
						});
					} catch (e) {
						auditWakeSpawnFailed(d.workstreamId, e instanceof Error ? e.message : String(e), {
							stateDir: opts.stateDir,
							sessionId: sid,
						});
					}
				}
			} catch {
				/* 唤醒循环永不破坏会话 */
			}
		}, opts.intervalMs ?? 30_000);
		interval.unref?.();
	});
	return () => {
		sessionGen++;
		if (interval) clearInterval(interval);
		interval = null;
	};
}

/**
 * 注册 Local Master v1 唤醒循环（per-repo，0920）：与 registerWakeLoop 同形态但独立 interval。
 *
 * session_start（子 agent 恒跳过）：
 *   1. 静默 genesis（S2）：本 scope 无 owner → 静默认领（有 owner / 身份 unknown /
 *      attach 失败全静默 no-op，不重试不上报；不调 triggerOwnershipRecheck）；
 *   2. 本会话是本 scope owner（新认领或在位）→ 启动 tick；否则零动作
 *      （脑裂回归：同仓第二会话不注册消费端，在位者 attachment 无感）。
 * tick：evaluateScopeWake（cutover off / 无 owner / 无 wake 类信 / in-flight → 空转，Q4）
 *   → spawn（调用方注入，cwd 由调用方按 decision.repoCwd 传 scope 仓 toplevel）
 *   → confirmScopeWakeSpawn（wake-state 以 <scope> 命名 + 同 holder ack）；
 *   spawn 抛错 → per-scope attention（wake-spawn-failed），信留 claimed（stale 恢复）。
 * 不碰全局 event-bus 注册逻辑；scope 消费端只吃 wake/命令类信（S7 谓词在 evaluate 内）。
 */
export function registerScopeWakeLoop(
	pi: {
		on: (event: string, cb: (event: unknown, ctx?: { sessionManager?: { sessionId?: string } }) => void) => void;
	},
	opts: {
		/** scope 解析 cwd（缺省 session_start 时 process.cwd()；测试注入用） */
		cwd?: string;
		spawn: (decision: ScopeWakeDecision, sessionId: string | undefined) => string;
		mailboxDir?: string;
		stateDir?: string;
		runsDir?: string;
		intervalMs?: number;
	},
): () => void {
	let interval: ReturnType<typeof setInterval> | null = null;
	let sessionGen = 0;
	pi.on("session_start", (_event, ctx) => {
		try {
			if (isSubagent()) return;
			const sid = durableSessionIdentity(ctx ?? null);
			if (!sid || sid === "unknown") return; // 身份 unknown → 静默 no-op（M1 哨兵，与 genesis 同纪律）
			const cwd = opts.cwd ?? process.cwd();
			const scope = localMasterScope(cwd);
			const addr = localMasterAddress(scope);
			// Genesis 检查点三分支（0920 backlog B9；触发时机仍仅 session_start，无后台 reaper）：
			//   unowned → silentScopeGenesis（不变）；
			//   owned + 非本会话 → 尝试 stale 接管（判据：scope liveness 身份严格匹配 + attachment
			//     pid 死；pid 活 / liveness 缺失 / 身份不匹配 → skip，与 v0「有 owner 一律不动」
			//     同保守度；竞争败者经 registry CAS generation-mismatch 自然回落 skip）；
			//   owned + 本会话 → 直接透传（在位 owner）。
			// 三层防线语义保持：预检在此处、owner-active 门在 scope.ts、wx/lease 单赢在 registry。
			let att = readAttachment(addr);
			if (!att) {
				// 静默 genesis：仅无 owner 时认领（失败静默，永不抛）
				silentScopeGenesis(sid, cwd);
				att = readAttachment(addr);
			} else if (att.sessionId !== sid) {
				const r = takeoverStaleScopeOwner(sid, cwd);
				if (r.outcome === "took-over") {
					// 新 owner TUI notify（best-effort；journal 审计已由 takeoverMasterWithAudit 落账）
					try {
						const ui = (ctx as unknown as { ui?: { notify?: (msg: string, level: string) => void } } | undefined)?.ui;
						ui?.notify?.(`已接管僵尸 scope ${r.scope}（上代 gen ${r.prevGeneration} / 旧会话 ${r.prevSessionId.slice(0, 8)}）`, "info");
					} catch {
						/* 通知尽力而为 */
					}
				}
				att = readAttachment(addr);
			}
			// 仅当本会话是本 scope owner（新接管或在位）才注册唤醒循环；否则零动作
			if (!att || att.sessionId !== sid) return;
			const myGen = ++sessionGen;
			const closed = (): boolean => myGen !== sessionGen;
			if (interval) clearInterval(interval);
			interval = setInterval(() => {
				if (closed()) return;
				try {
					const d = evaluateScopeWake({
						sessionId: sid,
						scope,
						mailboxDir: opts.mailboxDir,
						stateDir: opts.stateDir,
						runsDir: opts.runsDir,
					});
					if (!d.fire) return;
					try {
						const tabRunId = opts.spawn(d, sid);
						confirmScopeWakeSpawn(scope, tabRunId, {
							stateDir: opts.stateDir,
							mailboxDir: opts.mailboxDir,
							sessionId: sid,
						});
					} catch (e) {
						auditScopeWakeSpawnFailed(scope, e instanceof Error ? e.message : String(e), opts.stateDir);
					}
				} catch {
					/* 唤醒循环永不破坏会话 */
				}
			}, opts.intervalMs ?? 30_000);
			interval.unref?.();
		} catch {
			/* genesis/注册失败永不破坏会话 */
		}
	});
	return () => {
		sessionGen++;
		if (interval) clearInterval(interval);
		interval = null;
	};
}
