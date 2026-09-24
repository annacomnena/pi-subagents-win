/**
 * runtime-host/server.ts — G2 只读观察 + G4 唯一写端点（总计划 §25/§26/§27 / G2 计划 §2）
 *
 * 独立 node 入口（`node --experimental-strip-types server.ts`，bind **127.0.0.1:0**——端口
 * 动态，实际端口写 host.json 做发现；多实例固定端口必冲突，主会话拍板①）。不起则不存在
 * = Mode A 回退（§21）；pi 侧仅 `/runtime-host start|stop|status` slash 命令接线（拍板②，
 * 无 master 工具，默认不启动，零行为变化）。
 *
 * 五端点（纯 poll、服务端**无状态**、全部只读、全部 handler never-throw）：
 *   - `GET /v1/health`   组合纯读：getMasterStatus（owner/代际）+ timers sessions/ 心跳
 *     （唯一真实活性信号，15s grace）+ journal 尾部 + **mailbox 只读 pending 计数**
 *     （拍板④：不产事件、never-throw 包裹，失败→0）+ host 自信息。
 *   - `GET /v1/snapshot` 直接 `buildRuntimeSnapshot()`（G1 纯函数 import 复用，不复制），
 *     序列化前把 `RuntimeView.host`（G1 恒 null 预留位，snapshot.ts 零 diff）注入自信息。
 *   - `GET /v1/events?after=<cursor>&type=<opt>&limit=<opt>` journal raw 透传增量。
 *     **cursor = envelope id，排他下界**（只回 `id > after`，按 journal 追加序）；
 *     `after=0`/缺省 = 从头；服务端不存 cursor（无状态，host 重启天然不断）；
 *     失效/越界 → `409 { reason:"cursor-invalid", resync:true }` + 重同步指引（客户端
 *     改走 /v1/snapshot 重建状态 + after=0）；幂等责任在消费端（envelope 自带 id+dedupeKey）。
 *   - `GET /v1/attention?includeResolved=<opt>`（G3）状态聚合投影：`buildAttentionItems`
 *     （attention.ts 纯函数；同源双条 source key 最新胜出；resolved 默认过滤，拍板①）。
 *   - `GET /v1/interactions`（G6-P3）：待决策交互投影（pendingInteractions 思想）——open
 *     attention 1:1 直投 + 可选 response 语义（仅 pending handoff 提案 → master.handoff.accept；
 *     interactions.ts 纯函数，不新增真相；§29 决策仍走既有 POST /v1/commands）。
 *     WS 对应主题 "interactions"（状态投影帧，ws.ts）。
 *   - `GET /v1/timeline?limit=<opt>`（G3）journal 全事件 + 状态条目 + 溯源 enrichment
 *     （timeline.ts 纯函数；at 升序尾部 N 条，默认 200，拍板②）。
 *     与 /v1/events 分工正交（G2 research ④）：events = 低延迟增量，attention/timeline = 首屏全量 + 轮询。
 *   - `POST /v1/commands`（G4）：**唯一命令入口**（mailbox 命令信不消费）。同步执行、
 *     同步回执；业务全在 runtime/command-executor.ts 纯库（本文件只做薄绑定）；方法门
 *     放宽仅此路径（GET 全放行 + POST 仅 /v1/commands，其余 405）。G6-P2 起 fail-closed
 *     token 认证（X-Command-Token header / Cookie sw_host_token，同 P1 token 面；无/错 → 401）。
 *   - `GET /v1/sessions` + `GET /v1/sessions/:id/transcript?after=`（G6-P1）：pi 会话列表 +
 *     转写投影行快照/增量分页（与 WS 同一投影函数）。
 *   - B 案浏览器凭据作用域化：exchange 签发的不再是 host token 本体，而是派生凭据
 *     `sw_gui_token=<HMAC-SHA256(key:"pi:gui-cookie:v1", msg:hostToken)>`（12h 真上限，见
 *     master-injection.deriveGuiToken；重启轮换 hostToken 即失效）。命令面与 WS 流接受
 *     该 cookie；`/v1/bootstrap` 只认 host token 本体（堵自续期）；header/query 位置
 *     永远不认派生值。
 *   - `WS /v1/events/stream`（G6-P1，唯一升级路径）：journal + transcript 两路 JSON 帧多路复用，
 *     subscribe(base:{seq,logEpoch}) 断线续传 + 30s ping/pong + 本机 token→HttpOnly cookie
 *     fail-closed（token 落 host.json；无/错 token 握手 401；HTTP 端点零变化）。实现全在
 *     runtime-host/ws.ts（手写最小 RFC6455 文本帧，零新依赖）。
 *   - 启动时扫 pending outbox（G6-P2 L4 必修 2）：TTL 超 24h 的 pending 项转 expired +
 *     journal message.expired 回执（sweepExpiredOutboxItems；目标会话永不重启时 pending
 *     不再是永久孤儿——任一项至多存活到下次 host 启动；桥侧另在每个消费 tick 扫）。
 *     唯一读投影例外，best-effort never-throw；POST /v1/commands 仍是唯一命令入口。
 *   - 0923 微信 iLink 绑定 5 端点（v1：绑定/解绑/状态）：`POST /v1/wechat/bind/start`（幂等）/
 *     `GET /v1/wechat/bind/status` / `GET /v1/wechat/bind/qr-image`（daemon 代理转 data URL）/
 *     `POST /v1/wechat/bind/cancel` / `POST /v1/wechat/unbind`。鉴权沿用 authorizeCommand 链
 *     （无/错 → 401）；opt-in OFF（config channels.wechat.enabled!==true）→ 上述 5 端点 403 wechat-disabled。
 *   - 0923 L3 UX 修复：`POST /v1/wechat/enable` / `POST /v1/wechat/disable` 写 config
 *     channels.wechat.enabled——置于 opt-in 闸**之前**（否则未启用时无法启用 = 鸡生蛋），
 *     鉴权同链（authorizeCommand，无/错 token → 401，不开新鉴权面）；read-modify-write 保留其余字段
 *     + tmp+rename 原子写（wechat-bind.ts::setWechatEnabled，风格同 gui-autostart::setGuiAutoStart）；
 *     幂等；回执 {enabled} = 当前态；写盘失败 → 500 config-write-failed 如实报错。
 *     bot_token 永不进任何响应/日志（只记存在性）；凭据落 <runtimeDir>/wechat/credentials.json
 *     （0600 尽力 + 原子 rename）；有界异步流程（取码 10s + ≤120s/2.5s 轮询 + 结束即释放，
 *     D14 进程放置）全在 wechat-bind.ts（纯库 + 可注入 fetch）。
 *   - `/v1/sessions` 每条目附服务端权威 `masterProtected`（与 executor 护栏同源
 *     getMasterStatus().attachment.sessionId；G6-P2 L4 必修 4：GUI 不再拿 health 心跳自猜）。
 *   - `/v1/sessions` 每条目另附置顶标记（L3 会话 rail 三件套，session-pin.ts 纯读）：
 *     `isMaster`（全局 master，与 masterProtected 同源）+ `isScopeMaster`（命中某 scope
 *     attachment 且该 scope 解码 basename == 会话 cwd basename；解码失败不标）。均 additive，
 *     仅 true 时挂出。
 *
 * 明确不做（G2 计划 §4 / 主会话拍板③）：无 SSE/push（WS 为 G6 增量升级面）；无 journal
 * compaction；无 fs.watch 正确性路径；S3/master-auto/mailbox 接线零改动。
 *
 * 红线：只 import node 内建 + `extensions/runtime/*` 纯函数 + ../timers.ts（session 心跳
 * 纯函数）+ ./snapshot.ts + ./discovery.ts + ./commands.ts（薄 HTTP 层）；
 * **禁** Pi API / extensions/index.ts。
 */

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAttentionItems } from "./attention.ts";
import { buildInteractions } from "./interactions.ts";
import {
	PROTOCOL_VERSION,
	classifyHost,
	fetchHostHealth,
	generateHostToken,
	hostInfoPath,
	newInstanceId,
	readHostInfo,
	writeHostInfo,
	type HostInfo,
	type HostState,
} from "./discovery.ts";
import { defaultJournalPath, defaultRuntimeDir, listRuntimeEnvelopes } from "../runtime/journal.ts";
import { defaultMailboxDir, mailboxBacklog } from "../runtime/mailbox.ts";
import { getMasterStatus } from "../runtime/master-control.ts";
import {
	outboxDir,
	sweepExpiredOutboxItems,
} from "../runtime/message-outbox.ts";
import {
	defaultSessionsDir,
	findSessionFile,
	listPiSessions,
	projectSession,
} from "../runtime/transcript.ts";
import { resolveSessionTitles } from "./session-title.ts";
import { computeSessionPinFlags } from "./session-pin.ts";
import { SESSION_HEARTBEAT_GRACE_MS, defaultTimersDir, sessionAlive } from "../timers.ts";
import { buildRuntimeSnapshot, type RuntimeSnapshot } from "./snapshot.ts";
import { buildTimelineItems } from "./timeline.ts";
import {
	COMMAND_BODY_LIMIT_BYTES,
	CommandRequestError,
	commandOutcomeHttpResponse,
	decodeCommandBody,
	parseCommandRequest,
} from "./commands.ts";
import { validateStreamGen } from "../runtime/stream-gen.ts";
import { executeCommand, type TrustedMasterInjectionPolicy } from "../runtime/command-executor.ts";
import { piSessionAddress } from "../runtime/address.ts";
import {
	BOOTSTRAP_OTT_TTL_MS,
	auditMasterInjection,
	checkTrustedLocalChannel,
	createBootstrapStore,
	defaultPkgConfigPath,
	deriveGuiToken,
	GUI_COOKIE_MAX_AGE_SECONDS,
	GUI_COOKIE_NAME,
	isLoopbackHostname,
	readGuiEnabled,
} from "../runtime/master-injection.ts";
import { attachEventStream, WS_PATH, parseCookieToken, parseNamedCookie, tokenMatches } from "./ws.ts";
import {
	WechatAlreadyBoundError,
	WechatBindManager,
	WechatCancelledError,
	WechatNoActiveSessionError,
	readWechatCreds,
	readWechatEnabled,
	readWechatReceiveEnabled,
	setWechatEnabled,
	wechatCredsPath,
	type WechatFetch,
} from "./wechat-bind.ts";
import { ChannelSupervisor } from "./channel-supervisor.ts";
import { WechatStore, type InboundRecord } from "../channel-wechat/store.ts";
import { resolveDistDir, serveStatic } from "./static.ts";
import {
	RUNTIME_SCHEMA_VERSION,
	answerChallenge,
	captureProcessStartIdentity,
	computeReleaseId,
	runtimeIdForDir,
	type ChallengeMeta,
} from "./identity.ts";
import {
	acquireRuntimeLock,
	ensureRuntimeDaemon,
	lockPathFor,
	lockHolderAlive,
	readRuntimeLock,
	releaseRuntimeLock,
	stopRuntimeDaemon,
} from "./daemon-lifecycle.ts";

// ── 视图装配（纯读、never-throw；可注入路径/now 供测试隔离）────────

/** /v1/health 契约（G2 计划 §2 + 拍板④ mailbox 计数）。 */
export interface HealthView {
	version: 1;
	host: HostInfo;
	master: {
		attachment: {
			agentAddress: string;
			sessionId: string;
			generation: number;
			attachedAt: string;
			lastHeartbeatAt: string;
			attemptId: string;
		} | null;
		/** readCutover().enabled 归一为 boolean（无 cutover 文件 = false）。 */
		cutover: boolean;
	};
	/**
	 * master owner 三态：null = 无 attachment（未 attach = legacy）；
	 * true = attachment 存在且 owner 会话在 timers sessions/ 心跳目录且龄 < 15s
	 * （**唯一真实活性信号**——lastHeartbeatAt 无周期接线，不能判存活，research ③）；
	 * false = attachment 在但心跳缺失/超龄（stale，非崩溃：tab/subagent 不写此心跳）。
	 */
	masterOwnerAlive: boolean | null;
	/** 枚举 timers/sessions/ 目录（各会话心跳 { sessionId, lastActiveAt } + 龄 < 15s 的 alive）。 */
	sessionHeartbeats: { sessionId: string; lastActiveAt: string; alive: boolean }[];
	journalTail: { lastEnvelopeAt: string | null; lastRecordedAt: string | null; totalEvents: number };
	/** 拍板④：mailbox 全收件箱 pending 合计（只读计数，不产事件；读失败 → 0，never-throw）。 */
	mailboxPending: number;
	generatedAt: string;
}

export interface HostSelfInfo {
	instanceId: string;
	pid: number;
	port: number;
	startedAt: string;
	/** 第一切片新增（§2.2 身份；匿名 health 可见的非敏感字段，token 永不进响应）。 */
	runtimeId?: string;
	releaseId?: string;
	schemaVersion?: number;
	processStartIdentity?: string;
}

export interface HealthOptions {
	host: HostSelfInfo;
	/** timers 根目录（缺省 defaultTimersDir()）。 */
	timersDir?: string;
	/** journal 路径（缺省 defaultJournalPath()）。 */
	journalPath?: string;
	/** mailbox 根目录（缺省 defaultMailboxDir()）。 */
	mailboxDir?: string;
	now?: Date;
}

function iso(d: Date | null | undefined): string {
	try {
		return d && Number.isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString();
	} catch {
		return new Date().toISOString();
	}
}

/** 组装 /v1/health：段级 never-throw（单段失败 → 兜底值，不炸 server）。 */
export function buildHealthView(opts: HealthOptions): HealthView {
	const now = opts.now ?? new Date();
	const timersDir = opts.timersDir ?? defaultTimersDir();
	const journalPath = opts.journalPath ?? defaultJournalPath();
	const mailboxDir = opts.mailboxDir ?? defaultMailboxDir();

	// master 段（owner/代际/cutover）
	let attachment: HealthView["master"]["attachment"] = null;
	let cutover = false;
	let ownerAlive: boolean | null = null;
	try {
		const st = getMasterStatus();
		if (st.attachment) {
			const a = st.attachment;
			attachment = {
				agentAddress: a.agentAddress,
				sessionId: a.sessionId,
				generation: a.generation,
				attachedAt: a.attachedAt,
				lastHeartbeatAt: a.lastHeartbeatAt,
				attemptId: a.attemptId,
			};
		}
		cutover = st.cutover?.enabled ?? false;
		ownerAlive = attachment === null ? null : sessionAlive(timersDir, attachment.sessionId, now, SESSION_HEARTBEAT_GRACE_MS);
	} catch {
		// getMasterStatus/sessionAlive 均 tolerant，此层仅兜意外 IO；失败 → 未 attach 兜底
		attachment = null;
		ownerAlive = null;
	}

	// sessions 心跳枚举（tolerant：目录缺失/坏文件跳过）
	let sessionHeartbeats: HealthView["sessionHeartbeats"] = [];
	try {
		const dir = join(timersDir, "sessions");
		if (existsSync(dir)) {
			for (const f of readdirSync(dir)) {
				if (!f.endsWith(".json") || f.endsWith(".tmp")) continue;
				try {
					const raw = JSON.parse(readFileSync(join(dir, f), "utf8")) as {
						sessionId?: unknown;
						lastActiveAt?: unknown;
					};
					if (typeof raw.sessionId !== "string" || typeof raw.lastActiveAt !== "string") continue;
					sessionHeartbeats.push({
						sessionId: raw.sessionId,
						lastActiveAt: raw.lastActiveAt,
						alive: sessionAlive(timersDir, raw.sessionId, now, SESSION_HEARTBEAT_GRACE_MS),
					});
				} catch {
					/* 坏心跳文件跳过（与 sweepStaleHeartbeats 的 tolerant 读一致） */
				}
			}
			sessionHeartbeats.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
		}
	} catch {
		sessionHeartbeats = [];
	}

	// journal 尾部
	let journalTail: HealthView["journalTail"] = { lastEnvelopeAt: null, lastRecordedAt: null, totalEvents: 0 };
	try {
		const { envelopes } = listRuntimeEnvelopes({ path: journalPath });
		const last = envelopes[envelopes.length - 1];
		journalTail = {
			lastEnvelopeAt: last ? last.at : null,
			lastRecordedAt: last ? (last.recordedAt ?? null) : null,
			totalEvents: envelopes.length,
		};
	} catch {
		journalTail = { lastEnvelopeAt: null, lastRecordedAt: null, totalEvents: 0 };
	}

	// mailbox 只读计数（拍板④：不产事件；never-throw 包裹，失败 → 0）
	let mailboxPending = 0;
	try {
		mailboxPending = mailboxBacklog(mailboxDir).reduce((n, r) => n + r.pending, 0);
	} catch {
		mailboxPending = 0;
	}

	return {
		version: 1,
		host: { ...opts.host, protocolVersion: PROTOCOL_VERSION },
		master: { attachment, cutover },
		masterOwnerAlive: ownerAlive,
		sessionHeartbeats,
		journalTail,
		mailboxPending,
		generatedAt: iso(now),
	};
}

/** /v1/snapshot 视图 = G1 契约 + host 自信息注入（RuntimeView.host 预留位，snapshot.ts 零 diff）。 */
export function buildSnapshotView(
	opts: HostSelfInfo & {
		stateDir?: string;
		mailboxDir?: string;
		journalPath?: string;
		linksPath?: string;
		/** G5.2：master.autoHandoff 切片读用的 config 路径（缺省包根 config.json）。 */
		configPath?: string;
		now?: Date;
	},
): RuntimeSnapshot {
	const base = buildRuntimeSnapshot({
		stateDir: opts.stateDir ?? join(defaultRuntimeDir(), "state"),
		mailboxDir: opts.mailboxDir ?? defaultMailboxDir(),
		journalPath: opts.journalPath ?? defaultJournalPath(),
		linksPath: opts.linksPath,
		configPath: opts.configPath,
		now: opts.now,
	});
	// buildRuntimeSnapshot never-throw（G1 契约）；host 注入 = 纯字段替换，无新抛点。
	return { ...base, runtime: { ...base.runtime, host: { pid: opts.pid, startedAt: opts.startedAt } } };
}

// ── /v1/events 增量读（raw 透传，服务端无状态）────────────────────

export interface ReadEventsAfterOptions {
	journalPath?: string;
	/** cursor = envelope id（排他下界）；"0"/缺省 = 从头。 */
	after?: string;
	/** 可选 type 透传（不过滤时 raw 透传全部 19 类型）。 */
	type?: string;
	/** 最多返回条数（从 cursor 之后**向前**取；缺省不限。上限 10000 防大 backlog 一次回爆。 */
	limit?: number;
}

export interface ReadEventsAfterResult {
	/** cursor 非空但 journal 中找不到（缺失/截断/越界）→ true，server 回 409。 */
	cursorInvalid: boolean;
	envelopes: ReturnType<typeof listRuntimeEnvelopes>["envelopes"];
	/** 最后一条返回 envelope 的 id（无返回 → 回显 after），客户端下次 poll 用。 */
	nextCursor: string;
	after: string;
	count: number;
}

export const EVENTS_LIMIT_MAX = 10000;

export function readEventsAfter(opts: ReadEventsAfterOptions = {}): ReadEventsAfterResult {
	const journalPath = opts.journalPath ?? defaultJournalPath();
	const after = opts.after && opts.after !== "0" ? opts.after : "0";
	const limit =
		opts.limit !== undefined && Number.isInteger(opts.limit) && opts.limit > 0
			? Math.min(opts.limit, EVENTS_LIMIT_MAX)
			: undefined;

	const { envelopes: all } = listRuntimeEnvelopes({ path: journalPath });

	// cursor 定位（排他下界）：找不到 = journal 缺失/截断/越界 → 409 重同步
	let start = 0;
	if (after !== "0") {
		const idx = all.findIndex((e) => e.id === after);
		if (idx < 0) return { cursorInvalid: true, envelopes: [], nextCursor: after, after, count: 0 };
		start = idx + 1;
	}
	let out = all.slice(start);
	if (opts.type !== undefined) out = out.filter((e) => e.type === opts.type);
	if (limit !== undefined) out = out.slice(0, limit);
	return {
		cursorInvalid: false,
		envelopes: out,
		nextCursor: out.length > 0 ? (out[out.length - 1] as { id: string }).id : after,
		after,
		count: out.length,
	};
}

// ── HTTP server（bind 127.0.0.1:0；listen 成功后写 host.json）─────

class HttpError extends Error {
	status: number;
	body: Record<string, unknown>;
	constructor(status: number, body: Record<string, unknown>) {
		super(`http ${status}`);
		this.status = status;
		this.body = body;
	}
}

export interface RuntimeHostServerOptions {
	/** 缺省自动生成 newInstanceId()。 */
	instanceId?: string;
	/** host.json 路径（缺省 hostInfoPath()；测试注入）。 */
	hostPath?: string;
	timersDir?: string;
	stateDir?: string;
	mailboxDir?: string;
	journalPath?: string;
	/** timeline 溯源用 links.jsonl 路径（缺省 defaultLinksPath()；测试注入隔离）。 */
	linksPath?: string;
	/** config.json 路径（auto-handoff.set 用；缺省包根 config.json，测试注入隔离）。 */
	configPath?: string;
	/** G6-P1：pi sessions 根目录（缺省 defaultSessionsDir()；测试注入隔离）。 */
	sessionsDir?: string;
	/** 会话列表标题解析链：tab-runs 台账根目录（缺省 tabRunsDir()＝env PI_TAB_RUNS_DIR 覆盖；测试注入隔离）。 */
	tabRunsDir?: string;
	/** G6-P1：WS live tail 轮询间隔 ms（缺省 250；测试注入更快）。 */
	tailMs?: number;
	/** G6-P1：WS ping 间隔 ms（缺省 30000）。 */
	pingMs?: number;
	/** 第一切片：静态托管的 gui/dist 目录（缺省 resolveDistDir()；测试注入隔离）。 */
	distDir?: string;
	/** 第一切片：启动时等待交接锁释放的最长 ms（缺省 15000；测试用空闲锁，零等待）。 */
	lockWaitMs?: number;
	/** 0923 wechat：runtime 根目录（凭据 <dir>/wechat/credentials.json；缺省 defaultRuntimeDir()；测试注入隔离）。 */
	wechatRuntimeDir?: string;
	/** 0923 wechat：iLink base URL（缺省 https://ilinkai.weixin.qq.com；本地 stub 测试）。 */
	wechatBaseUrl?: string;
	/** 0923 wechat：fetch 注入（缺省 global fetch；测试 fake fetch）。 */
	wechatFetch?: WechatFetch;
	/** 0923 wechat：QR 轮询节拍 ms（缺省 2500；测试注入加速）。 */
	wechatPollIntervalMs?: number;
}

export interface RuntimeHostHandle {
	server: Server;
	info: HostInfo;
	/** 优雅关闭：关 server + 按 instanceId 匹配删 host.json（防误删僵尸覆盖后的新文件）。 */
	close(): Promise<void>;
}

/**
 * daemon 单实例锁获取（§2.2：先取锁再绑定端口；listen 前调用）。
 *   - 无锁/坏锁/僵尸持有人（pid 已死）→ 获取并持有；
 *   - 活 daemon 持有人 → throw（本进程退出，绝不双跑）；
 *   - 活 handoff 持有人 → 直接接管（rm + exclusive-create）：handoff 的唯一合法后继
 *     就是被它 spawn 的 daemon 子进程（父 ensure 持 handoff 等 host.json，子若再等父释锁
 *     则死锁）。并发双 child 时 wx 原子决出唯一胜者，败者下一轮看到活 daemon 即退出。
 */
async function acquireDaemonLockOrThrow(
	hostPath: string,
	entry: { instanceId: string; runtimeId: string; acquiredAt: string },
	waitMs: number,
): Promise<string> {
	const lockPath = lockPathFor(hostPath);
	const full = { kind: "daemon" as const, pid: process.pid, ...entry };
	const t0 = Date.now();
	for (;;) {
		const existing = readRuntimeLock(lockPath);
		if (!existing || !lockHolderAlive(existing)) {
			// 空闲/僵尸/坏文件 → 获取（僵尸先删再取，原子 exclusive-create；
			// 竞争窗口输了则落到循环尾重读决策）。注：同进程重复启动也视为双跑，拒绝。
			try {
				rmSync(lockPath, { force: true });
			} catch {
				/* ignore */
			}
			const ac = acquireRuntimeLock(lockPath, full);
			if (ac.acquired) return lockPath;
		} else if (existing.kind === "daemon") {
			throw new Error(`单实例锁被活 daemon 持有（pid=${existing.pid} instance=${existing.instanceId}）：拒绝双跑`);
		} else {
			// 活 handoff → daemon 直接接管（见函数注释；父的释锁是 instanceId 条件匹配，
			// 接管后父释锁为 no-op，不影响）
			try {
				rmSync(lockPath, { force: true });
			} catch {
				/* ignore */
			}
			const ac = acquireRuntimeLock(lockPath, full);
			if (ac.acquired) return lockPath;
			// 被并发 child 抢先 → 下一轮看到活 daemon 即 throw
		}
		if (Date.now() - t0 > waitMs) {
			throw new Error("单实例锁竞争超时：拒绝启动");
		}
		await new Promise((r) => setTimeout(r, 150));
	}
}

export function createRuntimeHostServer(opts: RuntimeHostServerOptions = {}): Promise<RuntimeHostHandle> {
	const instanceId = opts.instanceId ?? newInstanceId();
	const startedAt = new Date().toISOString();
	const hostPath = opts.hostPath ?? hostInfoPath();
	const distDir = resolveDistDir(opts.distDir);
	// 第一切片身份（§2.2）：runtimeId ← host.json 所在目录规范化；releaseId ← repo 版本 +
	// dist 内容 hash（dist 与 daemon 不可变 release 同步发布）；processStartIdentity 固定 ISO。
	const runtimeId = runtimeIdForDir(dirname(hostPath));
	const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
	const releaseId = computeReleaseId(repoRoot, distDir);
	const processStartIdentity = captureProcessStartIdentity(startedAt);
	const self: HostSelfInfo = { instanceId, pid: process.pid, port: 0, startedAt, runtimeId, releaseId, schemaVersion: RUNTIME_SCHEMA_VERSION, processStartIdentity };
	// G6-P1：本机 token 启动即生成，落 host.json（同机进程可读）；仅 WS 升级面 + challenge
	// HMAC 秘钥用，绝不出现在任何 /v1/* HTTP 响应（匿名 health 只报非敏感就绪信息）。
	const hostToken = generateHostToken();
	const challengeMeta: ChallengeMeta = { instanceId, runtimeId, protocolVersion: PROTOCOL_VERSION, releaseId, schemaVersion: RUNTIME_SCHEMA_VERSION, processStartIdentity };
	// L3：Bootstrap OTT 进程内存签发/核销（单实例 daemon 持有；gui 未启用时只 403，零落盘）
	const bootstrapStore = createBootstrapStore();
	const configPath = opts.configPath ?? defaultPkgConfigPath();
	// 0923 微信 iLink 绑定（v1：绑定/解绑/状态；D14 进程放置：daemon 内有界异步任务，取码 1 次
	// 10s + ≤120s/2.5s 轮询 + 结束即释放，非长驻 worker）。token 永不进任何 HTTP 响应/日志/WS/argv
	// （只记存在性）；凭据落 <runtimeDir>/wechat/credentials.json（0600 尽力 + 原子 rename）。
	const wechat = new WechatBindManager({
		...(opts.wechatRuntimeDir !== undefined ? { runtimeDir: opts.wechatRuntimeDir } : {}),
		...(opts.wechatBaseUrl !== undefined ? { baseUrl: opts.wechatBaseUrl } : {}),
		...(opts.wechatFetch !== undefined ? { fetchImpl: opts.wechatFetch } : {}),
		...(opts.wechatPollIntervalMs !== undefined ? { pollIntervalMs: opts.wechatPollIntervalMs } : {}),
	});
	// 0924 W1：微信接收 worker 监督（D14：长驻长轮询走受监督 worker 子进程）。缺省零行为
	// 变化（receive.enabled 缺省 false → 不 spawn）；仅读端点 /v1/wechat/{worker/status,inbox}
	// 从私有 store 读投影（只读，不触发 poll/claim/注入）。token 永不进任何响应。
	const wechatRuntimeDir = opts.wechatRuntimeDir !== undefined ? opts.wechatRuntimeDir : defaultRuntimeDir();
	const wechatStore = new WechatStore(WechatStore.resolveDir(wechatRuntimeDir));
	const channelSupervisor = new ChannelSupervisor({ runtimeDir: wechatRuntimeDir, configPath });

	const respondJson = (res: ServerResponse, status: number, body: unknown): void => {
		try {
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(body));
		} catch {
			try {
				res.destroy();
			} catch {
				/* ignore */
			}
		}
	};

	// G4：POST /v1/commands——唯一命令入口（body 异步读取后同步执行、同步回执；never-throw）
	// G6-P2：认证补强（fail-closed，同 P1 token）：X-Command-Token header（curl/测试等价通道）
	// 或 Cookie sw_host_token（同源 UI 无感，旧兼容）或 Cookie sw_gui_token=<派生值>
	// （B 案浏览器作用域化凭据）；无/错 token → 401，不读 body。只覆盖本写端点，
	// GET 读投影维持 P1 现状（本机 loopback 只读面）。
	// B 案位置语义：header 只认 hostToken 本体（派生值当 header 用 → tokenMatches 为假 → 401）；
	// cookie 位置认 hostToken 本体或派生值。/v1/bootstrap 另用 authorizeHostOnly（只认本体，堵自续期）。
	const headerTokenOf = (req: IncomingMessage): string | null => {
		const h = req.headers["x-command-token"];
		if (typeof h === "string" && h.length > 0) return h;
		if (Array.isArray(h) && h.length > 0 && typeof h[0] === "string" && h[0].length > 0) return h[0];
		return null;
	};
	/** B 案派生凭据期望值（hostToken 轮换即变；hostToken 为空时 ""= 无派生凭据可接受）。 */
	const guiExpected = (): string => deriveGuiToken(hostToken);
	/** POST /v1/commands 授权：header=hostToken 本体；cookie=本体或派生值。派生值当 header 用恒 401。 */
	const authorizeCommand = (req: IncomingMessage): boolean => {
		const ht = headerTokenOf(req);
		if (ht !== null) return tokenMatches(ht, hostToken);
		if (tokenMatches(parseCookieToken(req.headers.cookie), hostToken)) return true;
		const g = parseNamedCookie(req.headers.cookie, GUI_COOKIE_NAME);
		const exp = guiExpected();
		return g !== null && exp.length > 0 && tokenMatches(g, exp);
	};
	/** 浏览器是否以派生 cookie 呈现（机会式清除与 403 判定用；值对错由 authorizeCommand 定）。 */
	const presentsGuiCookie = (req: IncomingMessage): boolean =>
		parseNamedCookie(req.headers.cookie, GUI_COOKIE_NAME) !== null;
	/** POST /v1/bootstrap 授权（B 案堵自续期）：只认 hostToken 本体（header 或旧 cookie 名位置）；
	 *  sw_gui_token 在任何位置一律不认（派生值≠本体，tokenMatches 恒假 → 401）。 */
	const authorizeHostOnly = (req: IncomingMessage): boolean => {
		const ht = headerTokenOf(req);
		if (ht !== null) return tokenMatches(ht, hostToken);
		return tokenMatches(parseCookieToken(req.headers.cookie), hostToken);
	};
	/** B 案机会式清除：HttpOnly cookie 前端无法自清；`/gui off` 后浏览器下一次请求即被清除。
	 *  触发条件 = 请求携带 sw_gui_token 且 readGuiEnabled 为 false → 403 + 清除 cookie。 */
	const GUI_CLEAR_COOKIE = `${GUI_COOKIE_NAME}=; Max-Age=0; Path=/`;
	const respondGuiOffClear = (res: ServerResponse): void => {
		try {
			res.writeHead(403, {
				"content-type": "application/json",
				"set-cookie": GUI_CLEAR_COOKIE,
			});
			res.end(JSON.stringify({ error: "gui-disabled", hint: "GUI 已关闭（/gui off 后浏览器下一次请求即清除凭据 cookie）；重开请走 /gui open" }));
		} catch {
			try { res.destroy(); } catch { /* ignore */ }
		}
	};
	const handlePostCommand = (req: IncomingMessage, res: ServerResponse): void => {
		if (!authorizeCommand(req)) {
			respondJson(res, 401, {
				error: "unauthorized",
				hint: "POST /v1/commands 需本机 token：X-Command-Token header（host token 本体）或 Cookie sw_host_token / sw_gui_token（token 见 runtime 目录 host.json）",
			});
			try { req.destroy(); } catch { /* ignore */ }
			return;
		}
		// B 案机会式清除：带派生 cookie 但通道已关 → 403 + 清 cookie（HttpOnly 前端无法自清）。
		if (presentsGuiCookie(req) && !readGuiEnabled(configPath)) {
			respondGuiOffClear(res);
			try { req.destroy(); } catch { /* ignore */ }
			return;
		}
		const chunks: Buffer[] = [];
		let size = 0;
		let responded = false;
		req.on("data", (c: Buffer) => {
			if (responded) return;
			size += c.length;
			if (size > COMMAND_BODY_LIMIT_BYTES) {
				responded = true;
				respondJson(res, 413, { error: "payload-too-large", hint: `body 限 ${COMMAND_BODY_LIMIT_BYTES} 字节` });
				try { req.destroy(); } catch { /* ignore */ }
				return;
			}
			chunks.push(c);
		});
		req.on("error", () => {
			if (!responded) {
				responded = true;
				respondJson(res, 400, { error: "request-error" });
			}
		});
		req.on("end", () => {
			if (responded) return;
			responded = true;
			let status = 200;
			let body: unknown;
			try {
				const raw = decodeCommandBody(Buffer.concat(chunks), req.headers["content-type"]);
				// L3 窄路径策略（peek 容错解析；失败→undefined=旧行为，parseCommandRequest 照常 400）：
				// 仅 session.message→当前 master owner 才计算三证据并显式传入 executor。
				let trustedMasterInjection: TrustedMasterInjectionPolicy | undefined;
				try {
					const peek = JSON.parse(raw) as { type?: unknown; to?: unknown };
					const att = getMasterStatus().attachment;
					if (peek?.type === "session.message" && att && peek.to === piSessionAddress(att.sessionId)) {
						const timersDir = opts.timersDir ?? defaultTimersDir();
						const tl = checkTrustedLocalChannel(req, hostToken, self.port);
						trustedMasterInjection = {
							trustedLocal: tl.ok,
							guiEnabled: readGuiEnabled(configPath),
							masterAlive: sessionAlive(timersDir, att.sessionId, new Date(), SESSION_HEARTBEAT_GRACE_MS),
							source: `${req.socket.remoteAddress ?? "?"} host=${req.headers.host ?? "?"} origin=${req.headers.origin ?? "-"} via=${tl.via ?? "none"}${tl.ok ? "" : ` deny=${tl.reason ?? "?"}`}`,
						};
					}
				} catch {
					trustedMasterInjection = undefined;
				}
				const frame = parseCommandRequest(raw);
				const outcome = executeCommand(frame, {
					stateDir: opts.stateDir,
					journalPath: opts.journalPath,
					configPath,
					sessionsDir: opts.sessionsDir, // L4 必修 3：session.message 存在性校验与读投影同源（非默认 sessionsDir 下不再误判 no-session）。
					// R1 注：TOCTOU（预检活→执行时死）落 post-claim 旧护栏 409 会占 key，同 key 重试重放 409，需换 key（fail-closed；claim 顺序不动）。
					...(trustedMasterInjection !== undefined ? { trustedMasterInjection } : {}),
				});
				// M3：窄路径被拒补 denied 审计行（字段同 accepted，无正文；best-effort 不影响回执）。
				// 唯一 denied 落盘点在 server 层：executor 预检/护栏保持零副作用（M2），
				// 此处只记“peek 命中 master 目标且策略已计算”的两类窄路径拒绝
				// （master-session-protected：gui-off/坏 policy；master-offline）。
				if (trustedMasterInjection !== undefined && outcome.status === "rejected" &&
					(outcome.reason === "master-session-protected" || outcome.reason === "master-offline")) {
					try {
						let deniedSid = "?";
						let deniedKey = "?";
						try {
							const dp = JSON.parse(raw) as { to?: unknown; commandKey?: unknown };
							if (typeof dp.to === "string") {
								const m = /^pi:\/\/(.+)$/.exec(dp.to);
								if (m) deniedSid = m[1];
							}
							if (typeof dp.commandKey === "string" && dp.commandKey.length > 0) deniedKey = dp.commandKey;
						} catch {
							/* 解析失败就用占位符，审计不断 */
						}
						auditMasterInjection(outboxStateDirFor(opts), {
							at: new Date().toISOString(),
							by: String(frame.issuedBy),
							targetSessionId: deniedSid,
							source: trustedMasterInjection.source,
							result: "denied",
							commandKey: deniedKey,
						});
					} catch {
						/* 审计 best-effort：失败绝不影响回执 */
					}
				}
				const http = commandOutcomeHttpResponse(outcome);
				status = http.status;
				body = http.body;
			} catch (e) {
				if (e instanceof CommandRequestError) {
					status = e.status;
					body = e.body;
				} else {
					// executeCommand never-throw，此分支仅防未来回归；server 不崩，继续服务
					status = 500;
					body = { error: "internal", message: e instanceof Error ? e.message : String(e) };
				}
			}
			respondJson(res, status, body);
		});
	};

	// 第一切片：POST /v1/challenge——本地受保护通道 nonce 挑战（§2.2）。
	// 服务端用实例秘钥（host.json token）对 client nonce 做 HMAC，回显 nonce + 身份元组；
	// token 本身永不外发；无 token（不应发生，token 启动即生成）→ 503 fail-closed。
	const CHALLENGE_BODY_LIMIT_BYTES = 4096;
	const handlePostChallenge = (req: IncomingMessage, res: ServerResponse): void => {
		const chunks: Buffer[] = [];
		let size = 0;
		let responded = false;
		req.on("data", (c: Buffer) => {
			if (responded) return;
			size += c.length;
			if (size > CHALLENGE_BODY_LIMIT_BYTES) {
				responded = true;
				respondJson(res, 413, { error: "payload-too-large" });
				try { req.destroy(); } catch { /* ignore */ }
				return;
			}
			chunks.push(c);
		});
		req.on("error", () => {
			if (!responded) {
				responded = true;
				respondJson(res, 400, { error: "request-error" });
			}
		});
		req.on("end", () => {
			if (responded) return;
			responded = true;
			try {
				const parsed = JSON.parse(decodeCommandBody(Buffer.concat(chunks), req.headers["content-type"])) as { nonce?: unknown };
				const ans = answerChallenge(hostToken, typeof parsed.nonce === "string" ? parsed.nonce : "", challengeMeta);
				if (!ans) {
					respondJson(res, 400, { error: "bad-challenge", hint: "body 需 {nonce: 8..256 字符随机串}；服务端无秘钥时 503" });
					return;
				}
				respondJson(res, 200, ans);
			} catch {
				respondJson(res, 400, { error: "bad-challenge", hint: "body 需 JSON {nonce}" });
			}
		});
	};

	// L3 bootstrap（B 案作用域化后）：POST /v1/bootstrap 用 host token 本体（本机持 host.json 的进程，
	// 如 `/gui open`）换一次性短时 OTT（60s，单用）；GET /v1/bootstrap/exchange?ott=
	// 用 OTT 换**派生凭据** HttpOnly; SameSite=Strict 同源 cookie（sw_gui_token，12h 真上限；
	// 长 token 与 host token 本体永不进 URL/HTML/JS/cookie）。gui 未启用 → 403 gui-disabled
	// （通道不存在，零落盘）。`/v1/bootstrap` 只认本体（authorizeHostOnly），派生凭据换 OTT
	// 被拒 ⇒ 无自续期，12h 为真上限。
	const BOOTSTRAP_BODY_LIMIT_BYTES = 1024;
	const loopbackSocket = (req: IncomingMessage): boolean => {
		const r = req.socket?.remoteAddress ?? "";
		return r === "127.0.0.1" || r === "::1" || r === "::ffff:127.0.0.1";
	};
	/** M1：bootstrap 面与 commands 窄路径复用同一 Host 精确白名单（master-injection.isLoopbackHostname），关 DNS rebinding 缺口。 */
	const loopbackHost = (req: IncomingMessage): boolean => {
		const h = req.headers.host;
		return typeof h === "string" && isLoopbackHostname(h);
	};
	const handlePostBootstrap = (req: IncomingMessage, res: ServerResponse): void => {
		// B 案堵自续期：只认 host token 本体；sw_gui_token（cookie 或 header 任何位置）一律 401。
		if (!authorizeHostOnly(req)) {
			respondJson(res, 401, { error: "unauthorized", hint: "bootstrap 换 OTT 只认 host token 本体（X-Command-Token header 或 Cookie sw_host_token）；派生凭据 sw_gui_token 不可自续期" });
			try { req.destroy(); } catch { /* ignore */ }
			return;
		}
		// body 丢弃但真实限 1KB（OTT 签发不需要参数；超限 413 防堆积——注释与实现一致）。
		// 溢出后不 destroy（避免 RST 客户端）：只计数不存，end 时统一回执，本机回环面可接受。
		let bootSize = 0;
		let bootOverflow = false;
		let bootResponded = false;
		req.on("data", (c: Buffer) => {
			if (bootResponded) return;
			bootSize += c.length;
			if (bootSize > BOOTSTRAP_BODY_LIMIT_BYTES) bootOverflow = true;
		});
		req.on("end", () => {
			if (bootResponded) return;
			bootResponded = true;
			if (bootOverflow) {
				respondJson(res, 413, { error: "payload-too-large", hint: `body 限 ${BOOTSTRAP_BODY_LIMIT_BYTES} 字节（OTT 签发不需要参数）` });
				return;
			}
			if (!loopbackSocket(req)) {
				respondJson(res, 403, { error: "non-loopback", hint: "bootstrap 只接受本机回环连接" });
				return;
			}
			if (!loopbackHost(req)) {
				respondJson(res, 403, { error: "non-loopback-host", hint: "bootstrap Host 必须为本机回环名（与 /v1/commands 窄路径同一白名单）" });
				return;
			}
			if (!readGuiEnabled(configPath)) {
				respondJson(res, 403, { error: "gui-disabled", hint: "GUI 未显式启用：先 /gui on（含本机受信通道与风险提示）" });
				return;
			}
			const { ott, expiresAt } = bootstrapStore.mint(BOOTSTRAP_OTT_TTL_MS);
			respondJson(res, 200, { ott, expiresAt, expiresInSec: BOOTSTRAP_OTT_TTL_MS / 1000 });
		});
		req.on("error", () => {
			if (!bootResponded) {
				bootResponded = true;
				respondJson(res, 400, { error: "request-error" });
			}
		});
	};
	const handleBootstrapExchange = (req: IncomingMessage, res: ServerResponse, u: URL): void => {
		// M1：先验 socket+Host（Host 失败不核销 OTT，短路在 consume 之前），再验 gui+OTT。
		// B 案机会式清除：gui-off 时浏览器下一次请求（此处为 exchange）即被清除 cookie。
		if (!loopbackSocket(req) || !loopbackHost(req)) {
			respondJson(res, 403, { error: "non-loopback", hint: "bootstrap 只接受本机回环连接与回环 Host（与 /v1/commands 窄路径同一白名单）" });
			return;
		}
		if (!readGuiEnabled(configPath)) {
			if (presentsGuiCookie(req)) {
				respondGuiOffClear(res);
				return;
			}
			respondJson(res, 403, { error: "bad-bootstrap", hint: "GUI 未启用；重走 /gui open" });
			return;
		}
		if (!bootstrapStore.consume(u.searchParams.get("ott"))) {
			respondJson(res, 403, { error: "bad-bootstrap", hint: "OTT 无效/过期/已用；重走 /gui open" });
			return;
		}
		// B 案：签发派生凭据 cookie（值 = HMAC-SHA256(key:"pi:gui-cookie:v1", msg:hostToken)，hex；
		// host token 本体不再进任何 cookie；重启轮换 hostToken ⇒ 派生值变 ⇒ 旧 cookie 自动失效）。
		try {
			res.writeHead(302, {
				"location": "/",
				"set-cookie": `${GUI_COOKIE_NAME}=${deriveGuiToken(hostToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${GUI_COOKIE_MAX_AGE_SECONDS}`,
				"content-type": "text/plain",
			});
			res.end("bootstrap ok, redirecting to /");
		} catch {
			try { res.destroy(); } catch { /* ignore */ }
		}
	};

	// 0923 微信 iLink 绑定（v1）：7 端点薄绑定，业务全在 wechat-bind.ts（纯库 + 可注入 fetch）。
	// 鉴权链 = authorizeCommand（header 本体 / cookie 本体或 B 案派生 sw_gui_token；无/错 → 401）；
	// opt-in 闸 = readWechatEnabled（config channels.wechat.enabled===true；缺省 OFF）→ 未启用时其余
	// 端点 403 wechat-disabled（enable/disable 在闸**之前**处理，避开鸡生蛋；GUI 入口始终渲染）。
	// token 永不进任何响应（状态只回存在性）；QR 图片由 daemon 代理转 data URL（≤200KB/10s，
	// 失败回退 URL 文本）；POST body 不消费（客户端发空对象），drain 保 keep-alive 不被残留字节污染。
	const WECHAT_DISABLED_BODY: Record<string, unknown> = {
		error: "wechat-disabled",
		hint: "微信通道未启用：点 GUI「微信连接」页的「启用微信连接」按钮（POST /v1/wechat/enable），或手工设 config.json channels.wechat.enabled=true",
	};
	const WECHAT_UNAUTHORIZED_BODY: Record<string, unknown> = {
		error: "unauthorized",
		hint: "/v1/wechat/* 需本机 token：X-Command-Token header（host token 本体）或 Cookie sw_host_token / sw_gui_token（token 见 runtime 目录 host.json）",
	};
	// MF2（0924 L4 复核）：receive opt-in 闸体——两个 W1 只读端点另检 channels.wechat.receive.enabled
	//（缺省 false，D7 零侵入）；wechat.enabled=true 但 receive.enabled=false → 403（与既有 opt-in
	// 403 同语义），且零副作用（闸在 stats/readInbox 之前，不触 sync、不读写 store）。
	const WECHAT_RECEIVE_DISABLED_BODY: Record<string, unknown> = {
		error: "wechat-receive-disabled",
		hint: "微信消息接收未启用：设 config.json channels.wechat.receive.enabled=true（缺省 false，零行为变化）",
	};
	const drainWechatBody = (req: IncomingMessage): void => {
		let size = 0;
		req.on("data", (c: Buffer) => {
			size += c.length;
			if (size > 4096) {
				try { req.destroy(); } catch { /* ignore */ }
			}
		});
		req.on("error", () => { /* ignore */ });
	};
	const handleWechat = (req: IncomingMessage, res: ServerResponse, u: URL): void => {
		if (!authorizeCommand(req)) {
			respondJson(res, 401, WECHAT_UNAUTHORIZED_BODY);
			try { req.destroy(); } catch { /* ignore */ }
			return;
		}
		const p = u.pathname;
		// L3 UX 修复：enable/disable 置于 opt-in 闸**之前**（否则未启用时无法启用 = 鸡生蛋）。
		// 写 config channels.wechat.enabled（read-modify-write 保留其余字段 + tmp+rename 原子写）；
		// 幂等（同值重写）；回执 {enabled} = 写后当前态；写盘失败 → 500 如实报错，不谎称成功。
		if ((p === "/v1/wechat/enable" || p === "/v1/wechat/disable") && req.method === "POST") {
			drainWechatBody(req);
			const w = setWechatEnabled(p === "/v1/wechat/enable", configPath);
			if (!w.ok) {
				respondJson(res, 500, { error: "config-write-failed", message: w.error ?? "config.json 写入失败", enabled: readWechatEnabled(configPath) });
				return;
			}
			// W1 联动：enable/disable 后对账 worker（sync 幂等：应运行且未运行 → spawn；不应 → 收掉）
			void channelSupervisor.sync();
			respondJson(res, 200, { enabled: readWechatEnabled(configPath) });
			return;
		}
		if (!readWechatEnabled(configPath)) {
			respondJson(res, 403, WECHAT_DISABLED_BODY);
			try { req.destroy(); } catch { /* ignore */ }
			return;
		}
		if (p === "/v1/wechat/bind/start" && req.method === "POST") {
			// 幂等：同未过期会话重调返回同一 qr+expiresAt；已绑定 → 409 already-bound（需先解绑）。
			// 取码 10s 超时 → 本请求最长 ~10s（GUI 客户端 15s 上限）；失败 → 502（含 ret≠0/字段缺失）。
			drainWechatBody(req);
			wechat.start().then((r) => {
				respondJson(res, 200, { state: "waiting" as const, qr: r });
			}).catch((e: unknown) => {
				if (e instanceof WechatAlreadyBoundError) {
					respondJson(res, 409, { error: "already-bound", hint: "已有绑定中的微信凭据；先 POST /v1/wechat/unbind 解绑" });
				} else if (e instanceof WechatCancelledError) {
					respondJson(res, 409, { error: "cancelled", hint: "绑定流程已取消" });
				} else {
					respondJson(res, 502, { error: "bind-failed", message: e instanceof Error ? e.message : String(e) });
				}
			});
			return;
		}
		if (p === "/v1/wechat/bind/status" && req.method === "GET") {
			// 状态投影（pending/scanned/bound/expired/error/idle；token 永不出现，bot id 只报存在性）
			respondJson(res, 200, wechat.getState());
			return;
		}
		if (p === "/v1/wechat/bind/qr-image" && req.method === "GET") {
			// daemon 代理取图转 data URL（防浏览器直连第三方；≤200KB/10s；失败回退 {dataUrl:null,url,error}
			// 由 GUI 显示 URL 文本 + 复制）。无在途会话 → 409 no-active-session。
			wechat.fetchQrImage().then((r) => {
				respondJson(res, 200, r);
			}).catch((e: unknown) => {
				if (e instanceof WechatNoActiveSessionError) {
					respondJson(res, 409, { error: "no-active-session", hint: "无进行中的绑定会话（先 POST /v1/wechat/bind/start 生成二维码）" });
				} else {
					respondJson(res, 502, { error: "qr-image-failed", message: e instanceof Error ? e.message : String(e) });
				}
			});
			return;
		}
		if (p === "/v1/wechat/bind/cancel" && req.method === "POST") {
			// 取消在途流程（不删已有凭据；已绑定不受影响）；幂等
			drainWechatBody(req);
			wechat.cancel();
			respondJson(res, 200, wechat.getState());
			return;
		}
		if (p === "/v1/wechat/unbind" && req.method === "POST") {
			// 解绑 = 取消在途 + unlink 凭据（不留空壳）→ 回 idle；removed = 是否删到了文件
			drainWechatBody(req);
			const removed = wechat.unbind();
			// W1 联动：凭据已删 → supervisor 对账收掉 worker（不应运行）
			void channelSupervisor.sync();
			respondJson(res, 200, { ...wechat.getState(), removed });
			return;
		}
		// MF2（0924 L4 复核）：两个 W1 只读端点在鉴权 + wechat.enabled 闸之后另检
		// channels.wechat.receive.enabled——false → 403，不谈 stats/readInbox（零副作用）。
		// 仅拦 GET（非 GET 方法保持既有 405 语义）；绑定面端点行为不变。
		if ((p === "/v1/wechat/worker/status" || p === "/v1/wechat/inbox") && req.method === "GET" && !readWechatReceiveEnabled(configPath)) {
			respondJson(res, 403, WECHAT_RECEIVE_DISABLED_BODY);
			try { req.destroy(); } catch { /* ignore */ }
			return;
		}
		// W1 只读端点：worker 状态投影（脱敏：无 token/正文；不触发 poll/claim/注入，§4.8）
		if (p === "/v1/wechat/worker/status" && req.method === "GET") {
			const st = wechatStore.stats();
			const sup = channelSupervisor.status();
			respondJson(res, 200, {
				version: 1,
				enabled: readWechatEnabled(configPath) && readWechatReceiveEnabled(configPath),
				required: readWechatEnabled(configPath) && readWechatReceiveEnabled(configPath) && readWechatCreds(wechatCredsPath(wechatRuntimeDir)) !== null,
				running: sup.running,
				status: st.status,
				lastPollAt: st.lastPollAt,
				backlog: st.backlog,
				dedupeSize: st.dedupeSize,
				lastError: st.lastError,
			});
			return;
		}
		// W1 只读端点：脱敏 inbox 列表（from 前缀脱敏 / text 截断；state=pending 即「尚未注入」）
		if (p === "/v1/wechat/inbox" && req.method === "GET") {
			const qRaw = u.searchParams.get("limit");
			const qn = qRaw !== null ? Number(qRaw) : NaN;
			const limit = Number.isInteger(qn) && qn > 0 ? Math.min(qn, 200) : 50;
			const recs = wechatStore.readInbox(limit);
			const maskFrom = (id: string): string => (id.length <= 6 ? `${id.slice(0, 1)}…` : `${id.slice(0, 4)}…`);
			const trunc = (t: string): string => (t.length > 80 ? `${t.slice(0, 80)}…` : t);
			respondJson(res, 200, {
				version: 1,
				count: recs.length,
				messages: recs.map((r: InboundRecord) => ({
					msgId: r.msgId,
					from: maskFrom(r.fromId),
					nickname: r.fromNickname,
					text: trunc(r.text),
					receivedAt: r.receivedAt,
					state: r.state,
					...(r.artifactPending === true ? { artifactPending: true } : {}),
				})),
			});
			return;
		}
		respondJson(res, 405, { error: "method-not-allowed", hint: "/v1/wechat/*：POST enable | disable | bind/start | bind/cancel | unbind；GET bind/status | bind/qr-image | worker/status | inbox" });
	};

	const onReq = (req: IncomingMessage, res: ServerResponse): void => {
		let status = 200;
		let body: unknown;
		try {
			const u = new URL(req.url ?? "/", "http://127.0.0.1");
			// 第一切片：同源静态托管（GET / + /assets/*；/v1/* 在此返回 false → 走 API 路由，永不 SPA fallback）
			if (serveStatic(req, res, { distDir })) return;
			if (u.pathname === "/v1/challenge") {
				if (req.method === "POST") {
					handlePostChallenge(req, res);
					return;
				}
				throw new HttpError(405, { error: "method-not-allowed", hint: "/v1/challenge 仅接受 POST {nonce}（本地身份挑战）" });
			}
			if (u.pathname === "/v1/bootstrap") {
				if (req.method === "POST") {
					handlePostBootstrap(req, res);
					return;
				}
				throw new HttpError(405, { error: "method-not-allowed", hint: "/v1/bootstrap 仅接受 POST（本机 token 换一次性 OTT）" });
			}
			if (u.pathname === "/v1/bootstrap/exchange") {
				if (req.method === "GET") {
					handleBootstrapExchange(req, res, u);
					return;
				}
				throw new HttpError(405, { error: "method-not-allowed", hint: "/v1/bootstrap/exchange 仅接受 GET ?ott=（换 HttpOnly 同源 cookie）" });
			}
			if (u.pathname === "/v1/commands") {
				// 唯一写端点：仅 POST；GET /v1/commands → 405（读投影不含命令）
				if (req.method === "POST") {
					handlePostCommand(req, res);
					return;
				}
				throw new HttpError(405, { error: "method-not-allowed", hint: "/v1/commands 仅接受 POST（唯一命令入口）；读投影走其余 GET 端点" });
			}
			// 0923 微信 iLink 绑定 7 端点（v1：绑定/解绑/状态 + enable/disable 开关）：鉴权沿用
			// authorizeCommand 链（无/错 → 401，同 /v1/commands 面）；opt-in OFF（enabled!==true）→
			// 5 个绑定端点 403 wechat-disabled（enable/disable 不受闸限制；GUI「微信连接」入口始终渲染）。
			// token 永不进任何响应。
			if (u.pathname.startsWith("/v1/wechat/")) {
				handleWechat(req, res, u);
				return;
			}
			if (req.method !== "GET") {
				throw new HttpError(405, { error: "method-not-allowed", hint: "读投影仅 GET；写操作唯一入口 POST /v1/commands" });
			}
			switch (u.pathname) {
				case "/v1/health":
					body = buildHealthView({
						host: { ...self, port: self.port },
						timersDir: opts.timersDir,
						journalPath: opts.journalPath,
						mailboxDir: opts.mailboxDir,
					});
					break;
				case "/v1/snapshot":
					body = buildSnapshotView({
						...self,
						stateDir: opts.stateDir,
						mailboxDir: opts.mailboxDir,
						journalPath: opts.journalPath,
						linksPath: opts.linksPath,
						configPath: opts.configPath,
					});
					break;
				case "/v1/events": {
					const q = u.searchParams;
					const ev = readEventsAfter({
						journalPath: opts.journalPath,
						after: q.get("after") ?? undefined,
						type: q.get("type") ?? undefined,
						limit: q.get("limit") !== undefined ? Number(q.get("limit")) : undefined,
					});
					if (ev.cursorInvalid) {
						throw new HttpError(409, {
							reason: "cursor-invalid",
							resync: true,
							hint: "cursor 在 journal 中不存在（缺失/截断）——请 GET /v1/snapshot 重建状态后以 after=0 重取",
						});
					}
					body = { version: 1, after: ev.after, count: ev.count, nextCursor: ev.nextCursor, envelopes: ev.envelopes };
					break;
				}
				case "/v1/attention": {
					// G3（拍板①）：includeResolved=1 看历史（resolved 默认过滤）
					const includeResolved = (u.searchParams.get("includeResolved") ?? "") === "1";
					const att = buildAttentionItems({
						stateDir: opts.stateDir,
						mailboxDir: opts.mailboxDir,
						includeResolved,
					});
					body = { version: 1, count: att.length, attention: att };
					break;
				}
				case "/v1/interactions": {
					// G6-P3：待决策交互投影（只读纯函数重算既有 state；§29 决策走 POST /v1/commands）
					const ix = buildInteractions({ stateDir: opts.stateDir, mailboxDir: opts.mailboxDir });
					body = { version: 1, count: ix.length, interactions: ix };
					break;
				}
				case "/v1/timeline": {
					// G3（拍板②）+ G5.2：limit（默认 200，at 升序尾部 N 条）+ before=（历史翻页排他上界）
					const q = u.searchParams;
					const tlRaw = q.get("limit");
					const tl = buildTimelineItems({
						stateDir: opts.stateDir,
						journalPath: opts.journalPath,
						linksPath: opts.linksPath,
						limit: tlRaw !== undefined ? Number(tlRaw) : undefined,
						before: q.get("before") ?? undefined,
					});
					body = { version: 1, count: tl.length, timeline: tl };
					break;
				}
				case "/v1/sessions": {
					// G6-P1：pi 会话列表（首行头快读，不全读；startedAt 降序）
					const sessions = listPiSessions(opts.sessionsDir ?? defaultSessionsDir());
					// 会话可读标题解析链（P1 台账 → P2 首条 user 剥前缀 → P3 shortId 兜底）；
					// firstUserText 是解析链副产品，仅服务端内部用，不上线（契约只加 title/titleSource）
					const titles = resolveSessionTitles(sessions, opts.tabRunsDir);
					// G6-P2 L4 必修 4：Master 禁输入标识改服务端权威——与 executor 护栏同源
					// （getMasterStatus().attachment.sessionId，护栏二同款读法）投影到列表条目；
					// GUI 不再拿 health 心跳自猜。POST 真 403 仍是最后防线（护栏在 executor）。
					let protectedSid: string | null = null;
					try {
						protectedSid = getMasterStatus().attachment?.sessionId ?? null;
					} catch {
						protectedSid = null;
					}
					// L3 置顶数据源（会话 rail 三件套）：isMaster = 全局 master（与 masterProtected 同源）；
					// isScopeMaster = 命中某 scope attachment 且该 scope 解码 basename == 会话 cwd basename
					//（解码失败不标；session-pin.ts 纯读 never-throw；字段 additive，仅 true 挂出）。
					const pins = computeSessionPinFlags(sessions);
					body = {
						version: 1,
						count: sessions.length,
						sessions: sessions.map(({ firstUserText: _firstUserText, ...s }) => {
							const pin = pins.get(s.sessionId);
							return {
								...s,
								...(titles.get(s.sessionId) ?? { title: s.sessionId, titleSource: "id" as const }),
								...(protectedSid !== null && s.sessionId === protectedSid ? { masterProtected: true as const } : {}),
								...(pin?.isMaster ? { isMaster: true as const } : {}),
								...(pin?.isScopeMaster ? { isScopeMaster: true as const } : {}),
							};
						}),
						masterProtectedSessionId: protectedSid,
					};
					break;
				}
				default: {
					// G6-P1：GET /v1/sessions/:id/transcript?after=<seq>（HTTP 兜底分页，
					// 与 WS transcript 流同一投影函数；after 缺省/0 = 全量快照，>0 = 增量触及行终态）
					const mt = /^\/v1\/sessions\/([^/]+)\/transcript$/.exec(u.pathname);
					if (mt === null) {
						throw new HttpError(404, { error: "not-found", hint: `端点：GET /（静态）| /assets/*（静态）| /v1/health | /v1/snapshot | /v1/events | /v1/attention | /v1/interactions | /v1/timeline | /v1/sessions | /v1/sessions/:id/transcript；${WS_PATH}（WS）；POST /v1/commands（唯一命令入口）| POST /v1/challenge（本地身份挑战）| POST /v1/bootstrap + GET /v1/bootstrap/exchange（本机 OTT 换 cookie，gui on 限定）| /v1/wechat/{enable,disable} + bind/{start,status,qr-image,cancel} + /v1/wechat/unbind（微信 iLink 绑定与 opt-in 开关）` });
					}
					const sessionId = decodeURIComponent(mt[1]);
					const file = findSessionFile(opts.sessionsDir ?? defaultSessionsDir(), sessionId);
					if (file === null) {
						throw new HttpError(404, { error: "session-not-found", sessionId });
					}
					const afterRaw = u.searchParams.get("after");
					const after = afterRaw !== null && /^\d+$/.test(afterRaw) ? parseInt(afterRaw, 10) : 0;
					const proj = projectSession(file, after);
					// G6-P1 L4：head 带持久代际 gen（同首行重写/轮转检出；客户端重订阅带 base.gen）
					const gen = validateStreamGen(`session:${sessionId}`, file, proj.logEpoch);
					body = {
						version: 1,
						sessionId,
						mode: after > 0 ? "delta" : "snapshot",
						head: { seq: proj.head, logEpoch: proj.logEpoch, gen },
						count: proj.rows.length,
						rows: proj.rows,
						skippedUnknown: proj.skippedUnknown,
						name: proj.name,
					};
				}
			}
		} catch (e) {
			if (e instanceof HttpError) {
				status = e.status;
				body = e.body;
			} else {
				// 全部 handler never-throw → 500 JSON（server 不崩，继续服务）
				status = 500;
				body = { error: "internal", message: e instanceof Error ? e.message : String(e) };
			}
		}
		respondJson(res, status, body);
	};

	return new Promise((resolvePromise, reject) => {
		// §2.2：先取跨进程独占锁，再绑定端口/写账。活 daemon 已持锁 → 本进程直接拒绝启动
		// （防双跑）；交接期 handoff 锁 → 等待后获取。锁失败 = 启动失败（fail-closed）。
		const lockWaitMs = opts.lockWaitMs ?? 15000;
		void acquireDaemonLockOrThrow(hostPath, { instanceId, runtimeId, acquiredAt: startedAt }, lockWaitMs).then((lockPath) => {
			startListening(lockPath);
		}).catch((e) => {
			reject(e instanceof Error ? e : new Error(String(e)));
		});
		const startListening = (lockPath: string): void => {
			const server = createServer(onReq);
		// G6-P1：唯一 WS 升级路径 /v1/events/stream（幂等挂载；HTTP 路由零变化）
		// G6-P3：stateDir/mailboxDir 透传——interactions 主题与 GET 端点同源（测试注入隔离一致）
		attachEventStream(server, {
			token: hostToken,
			journalPath: opts.journalPath,
			sessionsDir: opts.sessionsDir,
			stateDir: opts.stateDir,
			mailboxDir: opts.mailboxDir,
			tailMs: opts.tailMs,
			pingMs: opts.pingMs,
			configPath, // WS 派生 cookie 分支的 gui 门用（与 server 侧同一 configPath）
		});
		server.on("error", (e: NodeJS.ErrnoException) => {
			// 锁已持有但端口绑定失败 → 释锁后拒绝（不留僵尸锁；:0 下正常不会 EADDRINUSE）
			releaseRuntimeLock(lockPath, instanceId);
			reject(new Error(`runtime-host listen failed: ${e.message}${e.code ? ` (code=${e.code})` : ""}`));
		});
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			// §2.2/§9：host.json 原子发布含 {runtimeId,instanceId,pid,processStartIdentity,
			// releaseId,protocolVersion,schemaVersion,port,token}（仅当前用户可读，0600）。
			const info: HostInfo = { instanceId, pid: process.pid, port, startedAt, protocolVersion: PROTOCOL_VERSION, token: hostToken, runtimeId, releaseId, schemaVersion: RUNTIME_SCHEMA_VERSION, processStartIdentity };
			self.port = port;
			writeHostInfo(info, hostPath); // 原子写（tmp+rename）；失败不炸（易失投影）
			// G6-P2 L4 必修 2：host 启动扫 pending outbox → TTL 转 expired + journal 回执。
			// 覆盖「目标会话永不重启」的孤儿面：任一项至多存活到下次 host 启动；桥侧另在每个
			// 消费 tick 扫（活跃会话更快收敛）。best-effort never-throw（投影面，不阻塞启动）。
			try {
				sweepExpiredOutboxItems(outboxDir(outboxStateDirFor(opts)), {
					...(opts.journalPath !== undefined ? { journalPath: opts.journalPath } : {}),
					by: "runtime-host",
				});
			} catch {
				/* 启动扫描失败不炸 host */
			}
			// 0924 W1：接收 worker 监督启动（初始 sync + 周期对账；receive.enabled 缺省 false → 零行为）
			try {
				channelSupervisor.start();
			} catch {
				/* 监督面 never-throw：启动失败不炸 host */
			}
			resolvePromise({
				server,
				info,
				close: async () => {
					// 0923 wechat：停有界绑定流程（不动磁盘——bound 凭据跨重启保留）
					try {
						wechat.dispose();
					} catch {
						/* ignore */
					}
				// 0924 W1：先收掉接收 worker 子进程（不变量 §4.7：daemon 退出不留孤儿），再关 server
				try {
					await channelSupervisor.dispose();
				} catch {
					/* 监督面 never-throw */
				}
					await new Promise<void>((r) => {
						try {
							server.close(() => r());
						} catch {
							r();
						}
						// 兜底：keep-alive 连接可能挂住 close 回调
						setTimeout(() => r(), 500).unref?.();
					});
					// 按 instanceId 匹配才删（僵尸覆盖后不误删新实例的文件）
					try {
						const cur = readHostInfo(hostPath);
						if (cur && cur.instanceId === instanceId) rmSync(hostPath, { force: true });
					} catch {
						/* ignore */
					}
					// 释 daemon 单实例锁（条件匹配 instanceId，防误删接管后的新锁，§2.3）
					releaseRuntimeLock(lockPath, instanceId);
				},
			});
		});
		};
	});
}

// ── slash 命令用的进程控制（start 已跑 → 回显现有；stop 清理僵尸文件）──

/** 启动扫描用的 outbox state 根（与 executor 同款缺省；env PI_RUNTIME_DIR 隔离）。 */
function outboxStateDirFor(opts: RuntimeHostServerOptions): string {
	return opts.stateDir ?? join(defaultRuntimeDir(), "state");
}

export interface HostStartResult {
	started: boolean;
	/** 已在跑（回显现有）= true。 */
	already?: boolean;
	/** 僵尸接管（原 host.json 为 dead，已覆盖启动）时的回显说明。 */
	note?: string;
	/** fail-closed：pid 活但超时/身份不符/锁占用 → uncertain，不复用、不重建、不 kill。 */
	uncertain?: boolean;
	info: HostInfo | null;
	error?: string;
}

/**
 * 第一切片：委托 daemon-lifecycle.ensureRuntimeDaemon（§2 单实例/接管契约）。
 * 语义变化（相对旧三态覆盖）：`stale`（pid 活但探活失败）不再直接覆盖启动，
 * 改走 uncertain fail-closed（防 pid 复用误杀/覆盖活锁；恢复路径见 daemon-lifecycle
 * stopRuntimeDaemon force 分支）；`dead`/坏文件仍在确已持锁后重建并注记。
 * spawn 形状 §2.1：detached:true + stdio:ignore + windowsHide:false + unref。
 */
export async function startRuntimeHost(opts?: {
	/** 缺省 = 本文件旁 server.ts（同目录）。 */
	serverPath?: string;
	waitMs?: number;
	hostPath?: string;
}): Promise<HostStartResult> {
	const r = await ensureRuntimeDaemon({
		...(opts?.hostPath !== undefined ? { hostPath: opts.hostPath } : {}),
		...(opts?.serverPath !== undefined ? { serverPath: opts.serverPath } : {}),
		...(opts?.waitMs !== undefined ? { waitMs: opts.waitMs } : {}),
	});
	return {
		started: r.ok && !r.already,
		...(r.already ? { already: true as const } : {}),
		...(r.note !== undefined ? { note: r.note } : {}),
		...(r.uncertain ? { uncertain: true as const } : {}),
		info: r.info,
		...(r.error !== undefined ? { error: r.error } : {}),
	};
}

export interface HostStopResult {
	stopped: boolean;
	/** fail-closed：未确权停机，不 kill 不删（见 reason；force 可走 legacy 分支）。 */
	uncertain?: boolean;
	info: HostInfo | null;
	reason?: string;
}

/**
 * 第一切片：委托 daemon-lifecycle.stopRuntimeDaemon（§2.3/§2.4）。
 * 旧裸 kill 语义替换为 fail-closed：alive → kill + 条件删；dead → 只清文件不 kill；
 * stale/锁被陌生持有人占用 → uncertain（不 kill 不删）。`force:true` 保留 legacy
 * 裸 kill 分支（wedged 实例人工恢复用）。
 */
export function stopRuntimeHost(opts?: { hostPath?: string; force?: boolean }): Promise<HostStopResult> {
	return stopRuntimeDaemon({
		...(opts?.hostPath !== undefined ? { hostPath: opts.hostPath } : {}),
		...(opts?.force === true ? { force: true as const } : {}),
	}).then((r) => ({
		stopped: r.stopped,
		...(r.uncertain ? { uncertain: true as const } : {}),
		info: r.info,
		...(r.reason !== undefined ? { reason: r.reason } : {}),
	}));
}

/** status 回显：host.json 内容 + 探活结果（alive/stale/dead/missing）。 */
export async function runtimeHostStatus(opts?: { hostPath?: string; timeoutMs?: number }): Promise<{
	state: HostState;
	info: HostInfo | null;
	health: unknown | null;
}> {
	const hostPath = opts?.hostPath ?? hostInfoPath();
	const info = readHostInfo(hostPath);
	if (!info) return { state: "missing", info: null, health: null };
	const state = await classifyHost(info, { timeoutMs: opts?.timeoutMs });
	const health = state === "alive" ? await fetchHostHealth(info.port, { timeoutMs: opts?.timeoutMs }) : null;
	return { state, info, health };
}

// ── 独立入口（standalone：node --experimental-strip-types server.ts）──

function isMainModule(): boolean {
	try {
		const entry = process.argv[1] ? resolve(process.argv[1]) : "";
		return entry !== "" && entry === fileURLToPath(import.meta.url);
	} catch {
		return false;
	}
}

if (isMainModule()) {
	createRuntimeHostServer()
		.then(({ info, close }) => {
			console.log(`runtime-host listening on 127.0.0.1:${info.port} (instanceId=${info.instanceId}, pid=${info.pid}, host.json=${hostInfoPath()})`);
			const shutdown = (): void => {
				void close().then(() => process.exit(0)).catch(() => process.exit(1));
			};
			process.on("SIGINT", shutdown);
			process.on("SIGTERM", shutdown);
		})
		.catch((e) => {
			console.error(`runtime-host 启动失败：${e instanceof Error ? e.message : String(e)}`);
			process.exit(1);
		});
}
