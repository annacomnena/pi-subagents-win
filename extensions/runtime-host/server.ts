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
 *   - `WS /v1/events/stream`（G6-P1，唯一升级路径）：journal + transcript 两路 JSON 帧多路复用，
 *     subscribe(base:{seq,logEpoch}) 断线续传 + 30s ping/pong + 本机 token→HttpOnly cookie
 *     fail-closed（token 落 host.json；无/错 token 握手 401；HTTP 端点零变化）。实现全在
 *     runtime-host/ws.ts（手写最小 RFC6455 文本帧，零新依赖）。
 *   - 启动时扫 pending outbox（G6-P2 L4 必修 2）：TTL 超 24h 的 pending 项转 expired +
 *     journal message.expired 回执（sweepExpiredOutboxItems；目标会话永不重启时 pending
 *     不再是永久孤儿——任一项至多存活到下次 host 启动；桥侧另在每个消费 tick 扫）。
 *     唯一读投影例外，best-effort never-throw；POST /v1/commands 仍是唯一命令入口。
 *   - `/v1/sessions` 每条目附服务端权威 `masterProtected`（与 executor 护栏同源
 *     getMasterStatus().attachment.sessionId；G6-P2 L4 必修 4：GUI 不再拿 health 心跳自猜）。
 *
 * 明确不做（G2 计划 §4 / 主会话拍板③）：无 SSE/push（WS 为 G6 增量升级面）；无 journal
 * compaction；无 fs.watch 正确性路径；S3/master-auto/mailbox 接线零改动。
 *
 * 红线：只 import node 内建 + `extensions/runtime/*` 纯函数 + ../timers.ts（session 心跳
 * 纯函数）+ ./snapshot.ts + ./discovery.ts + ./commands.ts（薄 HTTP 层）；
 * **禁** Pi API / extensions/index.ts。
 */

import { spawn } from "node:child_process";
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
	isProcessAlive,
	newInstanceId,
	readHostInfo,
	removeHostInfo,
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
import { SESSION_HEARTBEAT_GRACE_MS, defaultTimersDir, sessionAlive } from "../timers.ts";
import { buildRuntimeSnapshot, type RuntimeSnapshot } from "./snapshot.ts";
import { buildTimelineItems } from "./timeline.ts";
import {
	COMMAND_BODY_LIMIT_BYTES,
	CommandRequestError,
	commandOutcomeHttpResponse,
	parseCommandRequest,
} from "./commands.ts";
import { validateStreamGen } from "../runtime/stream-gen.ts";
import { executeCommand } from "../runtime/command-executor.ts";
import { attachEventStream, WS_PATH, parseCookieToken, tokenMatches } from "./ws.ts";

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
}

export interface RuntimeHostHandle {
	server: Server;
	info: HostInfo;
	/** 优雅关闭：关 server + 按 instanceId 匹配删 host.json（防误删僵尸覆盖后的新文件）。 */
	close(): Promise<void>;
}

export function createRuntimeHostServer(opts: RuntimeHostServerOptions = {}): Promise<RuntimeHostHandle> {
	const instanceId = opts.instanceId ?? newInstanceId();
	const startedAt = new Date().toISOString();
	const self: HostSelfInfo = { instanceId, pid: process.pid, port: 0, startedAt };
	const hostPath = opts.hostPath ?? hostInfoPath();
	// G6-P1：本机 token 启动即生成，落 host.json（同机进程可读）；仅 WS 升级面校验，
	// 绝不出现在 /v1/* HTTP 响应（HostSelfInfo 不含 token）。
	const hostToken = generateHostToken();

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
	// 或 Cookie sw_host_token（同源 UI 无感）；无/错 token → 401，不读 body。只覆盖本写端点，
	// GET 读投影维持 P1 现状（本机 loopback 只读面）。
	const authorizeCommand = (req: IncomingMessage): boolean => {
		const h = req.headers["x-command-token"];
		const headerToken = typeof h === "string" && h.length > 0 ? h : (Array.isArray(h) ? (h[0] ?? null) : null);
		const presented = headerToken ?? parseCookieToken(req.headers.cookie);
		return tokenMatches(presented, hostToken);
	};
	const handlePostCommand = (req: IncomingMessage, res: ServerResponse): void => {
		if (!authorizeCommand(req)) {
			respondJson(res, 401, {
				error: "unauthorized",
				hint: "POST /v1/commands 需本机 token：X-Command-Token header 或 Cookie sw_host_token（token 见 runtime 目录 host.json）",
			});
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
				const frame = parseCommandRequest(Buffer.concat(chunks).toString("utf8"));
				const outcome = executeCommand(frame, {
					stateDir: opts.stateDir,
					journalPath: opts.journalPath,
					configPath: opts.configPath,
					sessionsDir: opts.sessionsDir, // L4 必修 3：session.message 存在性校验与读投影同源（非默认 sessionsDir 下不再误判 no-session）
				});
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

	const onReq = (req: IncomingMessage, res: ServerResponse): void => {
		let status = 200;
		let body: unknown;
		try {
			const u = new URL(req.url ?? "/", "http://127.0.0.1");
			if (u.pathname === "/v1/commands") {
				// 唯一写端点：仅 POST；GET /v1/commands → 405（读投影不含命令）
				if (req.method === "POST") {
					handlePostCommand(req, res);
					return;
				}
				throw new HttpError(405, { error: "method-not-allowed", hint: "/v1/commands 仅接受 POST（唯一命令入口）；读投影走其余 GET 端点" });
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
					body = {
						version: 1,
						count: sessions.length,
						sessions: sessions.map(({ firstUserText: _firstUserText, ...s }) => ({
							...s,
							...(titles.get(s.sessionId) ?? { title: s.sessionId, titleSource: "id" as const }),
							...(protectedSid !== null && s.sessionId === protectedSid ? { masterProtected: true as const } : {}),
						})),
						masterProtectedSessionId: protectedSid,
					};
					break;
				}
				default: {
					// G6-P1：GET /v1/sessions/:id/transcript?after=<seq>（HTTP 兜底分页，
					// 与 WS transcript 流同一投影函数；after 缺省/0 = 全量快照，>0 = 增量触及行终态）
					const mt = /^\/v1\/sessions\/([^/]+)\/transcript$/.exec(u.pathname);
					if (mt === null) {
						throw new HttpError(404, { error: "not-found", hint: `端点：GET /v1/health | /v1/snapshot | /v1/events | /v1/attention | /v1/interactions | /v1/timeline | /v1/sessions | /v1/sessions/:id/transcript；${WS_PATH}（WS）；POST /v1/commands（唯一命令入口）` });
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
		});
		server.on("error", (e: NodeJS.ErrnoException) => {
			// fail-fast 报端口（risk8：不静默换端口）——:0 下正常不会 EADDRINUSE
			reject(new Error(`runtime-host listen failed: ${e.message}${e.code ? ` (code=${e.code})` : ""}`));
		});
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			const info: HostInfo = { instanceId, pid: process.pid, port, startedAt, protocolVersion: PROTOCOL_VERSION, token: hostToken };
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
			resolvePromise({
				server,
				info,
				close: async () => {
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
				},
			});
		});
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
	/** 僵尸接管（原 host.json 为 stale/dead，已覆盖启动）时的回显说明。 */
	note?: string;
	info: HostInfo | null;
	error?: string;
}

/**
 * 派生独立 `node --experimental-strip-types server.ts` 进程（detached + unref，pi 退出
 * 不连带杀 host——Mode A 回退语义）。等待 host.json 出现且 pid 存活（最多 waitMs，缺省 8s）。
 *
 * host.json 已存在时走**完整三态探活**（classifyHost：pid 存活只是必要条件，health 探活是
 * 权威——PID 重用/进程卡死时 pid 活但探活失败，必判 stale，L4 必修项）：
 *   - `alive`（pid 活 + 探活成功）→ 回显现有（不重起，already:true）
 *   - `stale` / `dead`（僵尸）→ 直接覆盖启动（新 pid/port/host.json），note 回显「检测到僵尸，已接管」
 */
export async function startRuntimeHost(opts?: {
	/** 缺省 = 本文件旁 server.ts（同目录）。 */
	serverPath?: string;
	waitMs?: number;
	hostPath?: string;
}): Promise<HostStartResult> {
	const hostPath = opts?.hostPath ?? hostInfoPath();
	const waitMs = opts?.waitMs ?? 8000;
	const serverPath = opts?.serverPath ?? join(dirname(fileURLToPath(import.meta.url)), "server.ts");

	const existing = readHostInfo(hostPath);
	let zombie: { info: HostInfo; state: HostState } | null = null;
	if (existing) {
		const state = await classifyHost(existing);
		if (state === "alive") {
			return { started: false, already: true, info: existing };
		}
		zombie = { info: existing, state };
	}
	// zombie（stale：pid 在但探活失败；dead：僵尸文件）或无文件 → 直接 spawn，新实例 listen 成功后
	// 原子覆盖 host.json（僵尸覆盖不先 kill 旧 pid——旧实例若仍活着，其退出清理按 instanceId 匹配，
	// 不会误删新文件；新文件带新 startedAt，poll 按时间戳区分新旧）

	return new Promise((resolvePromise) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(
			process.execPath,
			["--experimental-strip-types", serverPath],
			{
				detached: true,
				stdio: "ignore",
				cwd: dirname(serverPath),
				// 钉子进程的 runtime 目录 = hostPath 所在目录（默认场景下与现状一致；测试注入隔离时
				// 子进程写盘位置与本函数读盘位置严格一致）
				env: { ...process.env, PI_RUNTIME_DIR: dirname(hostPath) },
			},
		);
		} catch (e) {
			resolvePromise({ started: false, info: null, error: `spawn failed: ${e instanceof Error ? e.message : String(e)}` });
			return;
		}
		child.unref();
		const startedAt0 = new Date().toISOString();
		const t0 = Date.now();
		const poll = setInterval(() => {
			const info = readHostInfo(hostPath);
			if (info && info.startedAt >= startedAt0 && isProcessAlive(info.pid)) {
				clearInterval(poll);
				resolvePromise({
					started: true,
					info,
					...(zombie ? { note: `检测到僵尸，已接管（原 pid=${zombie.info.pid} ${zombie.state}，已覆盖启动）` } : {}),
				});
				return;
			}
			if (Date.now() - t0 > waitMs) {
				clearInterval(poll);
				try {
					child.kill();
				} catch {
					/* ignore */
				}
				resolvePromise({ started: false, info: null, error: `timeout ${waitMs}ms：host.json 未就绪（server 可能启动失败）` });
			}
		}, 100);
		// 注：poll 不 unref——start 期间必须保持 event loop 存活（裸 node 测试/短命宿主进程下
		// unref 会让进程在等待中直接退出）；命令上下文下 host.json 出现即 resolve（~1s），无悬挂。
	});
}

export interface HostStopResult {
	stopped: boolean;
	info: HostInfo | null;
	reason?: string;
}

/**
 * 停止 host：kill(pid)（Windows 下 SIGTERM → 立即退出；unix 走 server 的 SIGTERM 优雅路径）
 * + 删 host.json（含僵尸文件清理，risk4）。
 */
export function stopRuntimeHost(opts?: { hostPath?: string }): Promise<HostStopResult> {
	const hostPath = opts?.hostPath ?? hostInfoPath();
	const info = readHostInfo(hostPath);
	if (!info) return Promise.resolve({ stopped: false, info: null, reason: "未启动（无 host.json 或不可解析）" });
	try {
		process.kill(info.pid);
	} catch {
		/* pid 可能已退出（僵尸）——继续清理文件 */
	}
	removeHostInfo(hostPath);
	return Promise.resolve({ stopped: true, info });
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
