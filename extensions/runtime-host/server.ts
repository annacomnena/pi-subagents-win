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
 *   - `POST /v1/commands`（G4）：**唯一 HTTP 命令入口**（mailbox 命令信由
 *     `extensions/mailbox-consumer.ts` 的专属链消费——仅 master_default 域、fencing claim 链，
 *     不经本端点）。同步执行、
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
 *   - `GET /v1/runs?limit&includeRecentCalls&sessionId`（2026-10-22 档 A；2026-10-26 P1A 加 `sessionId`）：
 *     async subagent run 的**只读**卡片投影（`subagent-kill.ts::listAsyncRunCards`）。三态
 *     `liveness=alive|dead|unknown`：pid 为活数 → alive / 死数 → dead / **无 pid → unknown**
 *     （实测 152/154 无 pid 是常态；`unknown` 永不当 running 展示，也不当失败）。独立端点而不塞
 *     `/v1/snapshot`：后者已 412 KB 且 runs 占 81%。ETag 排除 `asof`；纯读零写盘。
 *     P1A（右侧栏「本会话派发」数据面）：`?sessionId=a,b`（≤5 个、**fail-closed 且在条件请求之前**，
 *     否则 `If-None-Match: *` 会把非法参数洗成 304）→ 规范化（去重 + locale 无关排序）后
 *     在 `listAsyncRunCards` **内部、limit 之前**过滤（`link.sessionId` 或 `link.ownerSessionId` 命中）；
 *     `total` = 过滤后可读数；新增 `attribution`/`attributionDetail`（分母 = 过滤前、去重后的可读 run）
 *     与卡片 `dispatchedBy`/`durationMs`。缺省无该参数 = 本机全量，**且 links 读失败不影响全量**
 *     （只把 attribution 降为 `unavailable`）。
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

import { appendFileSync, chmodSync, existsSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, rmSync, statSync, type Stats } from "node:fs";
// S2（2026-10-30）：daemon 侧须自己拉起可见 WT tab，需要 `where wt.exe`
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
	DAEMON_LOCK_WAIT_MS,
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
	projectSessionTail,
} from "../runtime/transcript.ts";
import { resolveSessionTitles, tabRunsDir } from "./session-title.ts";
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
import { readLiveness } from "../runtime/liveness.ts";
// 2026-10-30 会话存活状态机（S2 探针 + GUI「活跃中」筛选共用单一事实源）
import {
	defaultTabRunsDir,
	listTabDispatches,
	probeSessionsForDispatch,
	readTabState,
	sessionBucketForCwd,
} from "../tab-runs.ts";
import { isProcessAlive } from "../runtime/liveness.ts";
import {
	activityOf,
	livenessFromEvidence,
	livenessFromTabState,
	mergeEvidence,
	type LivenessEvidence,
	type SessionLivenessVerdict,
} from "../runtime/session-liveness.ts";
import { readSessionUsage } from "../runtime/session-usage.ts";
import { readNotify } from "../runtime/notify-bridge.ts";
import { ackIncident, deliveryDir } from "../delivery-ledger.ts";
import { UPLOAD_MAX_BYTES, pruneUploads, saveUpload, uploadsDir } from "./uploads.ts";
import { executeCommand, type TrustedMasterInjectionPolicy } from "../runtime/command-executor.ts";
// 2026-10-30 S2：向已死会话发消息时拉起它（owner 裁决：GUI 专属、新开可见 WT tab）
import { decideSendAction, isSpawnPermitted, resumeTabTitle } from "../runtime/session-resume.ts";
import { parseObjectAddress } from "../runtime/address.ts";
import { spawnPiTab } from "../tab-launch-core.ts";
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
	readWechatReplyConfig,
	setWechatEnabled,
	setWechatInputConfig,
	readWechatInputConfig,
	maskWechatOpenId,
	wechatOpenIdHash,
	wechatCredsPath,
	type WechatFetch,
} from "./wechat-bind.ts";
import { ChannelSupervisor } from "./channel-supervisor.ts";
// B 对账通道（切片 1）：独立进程内的 10s 周期对账（kill switch PI_DELIVERY_RECONCILER=0）。
import { startDeliveryReconcilerLoop, type DeliveryReconcilerLoopHandle } from "./delivery-reconciler-loop.ts";
import { setAutonomyEnabled } from "./autonomy-config.ts";
import { readAutonomyConfig } from "../runtime/autonomy/config.ts";
import { readFrontierSnapshot, readWakeGateState } from "../runtime/autonomy/collect.ts";
import { readKillSwitch } from "../runtime/autonomy/kill-switch.ts";
import { ARTIFACT_REF_RE, startWechatInput } from "./wechat-input.ts";
import { startWechatReplyWatcher } from "./wechat-reply.ts";
import { listReplyIntents, replyIntentDir } from "../runtime/wechat-reply.ts";
import { readAttachment } from "../runtime/registry.ts";
import { DEFAULT_RUNS_DIR, listAsyncRunCards } from "../subagent-kill.ts";
import { defaultLinksPath, readLinksWithStats, type LinkRecord } from "../links.ts";
import { masterAddress } from "../runtime/address.ts";
import { WechatStore, type InboundRecord } from "../channel-wechat/store.ts";
import { resolveDistDir, serveStatic } from "./static.ts";
import { latestControlRequest } from "../runtime/session-control.ts";
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
	/**
	 * 进程内存（additive，2026-10-20）。
	 *
	 * 动因：AGENTS.md R-2「静默失效不可接受」—— 本机曾因内存耗尽崩过一次并导致 pi 包损坏 4 次，
	 * 而此前 `/v1/health` **一个内存字段都没有**，异常完全不可观测。
	 *
	 * 口径：单位 MB（保留 1 位小数，避免前端自己除）；`sampledAt` + `sampleAgeMs` 按 R-2.2
	 * 给**年龄**而不是只给绝对值 —— 读的人必须能判断「这个数是不是几分钟前的」。
	 */
	memory: {
		/** 进程 RSS（含 native/共享，最能反映「进程占了多少」）。 */
		rssMb: number;
		/** V8 堆已用（GC 后可回收的部分）。 */
		heapUsedMb: number;
		heapTotalMb: number;
		/** Buffer/ArrayBuffer 等堆外分配（大文件读的主要去处）。 */
		externalMb: number;
		/** 采样时刻（ISO）。 */
		sampledAt: string;
		/** 距采样多少毫秒（R-2.2：状态展示必须给年龄）。 */
		sampleAgeMs: number;
		/** 是否超过告警阈值（当前阈值见 MEMORY_WARN_RSS_MB）。 */
		rssWarn: boolean;
		/**
		 * 最大会话文件（additive，2026-10-20）。
		 *
		 * 动因：已知事故（GUI 卡顿 / daemon 单请求耗时暴涨）的元凶往往是**单个巨型会话文件**
		 * （本机实测有一个 152MB 的 .jsonl，其中 151MB 是 1273 条 message 行）。
		 * 此前只能翻目录才发现，这里直接暴露「多大 + 是谁」，并把体积超阈值标出来。
		 * 口径：只做 stat 扫描（不读内容），与 /v1/sessions 同源目录；失败 → null（never-throw）。
		 */
		maxSessionFile: {
			bytes: number;
			mb: number;
			/** 会话 id（从文件名解析；解析不出 → null）。 */
			sessionId: string | null;
			/** 相对会话根目录的路径（含 cwd 子目录），便于定位。 */
			relPath: string;
			/** 是否超过告警阈值（当前阈值见 SESSION_FILE_WARN_MB）。 */
			warn: boolean;
		} | null;
	};
	/**
	 * 微信接收通道存活信号（2026-10-20，落实 AGENTS.md R-2「静默失效不可接受」）。
	 *
	 * 事故背景：worker 死后 pid 被系统复用 ⇒ supervisor 永久 skipped-stale ⇒ 通道静默死
	 * 18.5 小时，而 /v1/health 里**一个字都没有**，没人发现。
	 * 这里给出独立的存活读数（不依赖 supervisor 自己报告 running）：
	 *   - lastPollAgeMs：worker 最后一次成功轮询距今（**真实活性**，不是状态文件里的 status 字符串）
	 *   - stale：超过 WECHAT_POLL_STALE_MS 未轮询 ⇒ true（GUI 应显式告警）
	 *
	 * 注意：**故意不放 supervisor 的 running**（那需要把实例传进来）。理由：本段存在的全部意义是
	 * 「独立于 supervisor 自述的证据」；塞一个恒为 false 的字段比没有字段更糟（2026-10-20 自查发现
	 * 第一版就有这个恒假字段，已删）。要看 supervisor 自述请用 GET /v1/wechat/worker/status。
	 */
	wechat: {
		/** config: channels.wechat.enabled */
		enabled: boolean;
		/** config: channels.wechat.receive.enabled */
		receiveEnabled: boolean;
		/** 凭据在位（能跑的前提） */
		credsPresent: boolean;
		/** worker 最后一次轮询时刻（state.json.lastPollAt）；null = 从未 */
		lastPollAt: string | null;
		/** 最后一次轮询距今（ms）；null = 从未轮询 */
		lastPollAgeMs: number | null;
		/** 超阈值未轮询（enabled && receiveEnabled && credsPresent 时才有意义） */
		stale: boolean;
		lastError: string | null;
	};
	/**
	 * 交付失败账本（additive，2026-10-21）。
	 *
	 * 动因（Item 53 未决项，实测取证）：`ackIncident` / `listOpenIncidents` 全仓**零调用**，
	 * 106 条 incident 积压至今（ack 数 0，最旧 4.8 天，91/106 > 1 天）。
	 * 设计声称「incident 是 durable 可见出口，显式 ack 才清」，但**既无可见面也无 ack 入口** ⇒
	 * 有状态、无出口 = AGENTS R-2 的静默失效形状。本段给它一个**只读**可见面。
	 *
	 * 按 R-2.2：给**年龄**（`oldestAgeMs`）而不只是绝对时间，且超阈值显式 `stale`。
	 */
	delivery: {
		/** 未 ack 的 incident 数（= listOpenIncidents 长度）。 */
		openIncidents: number;
		/** 最旧的未 ack incident 距今（ms）；null = 无未 ack。 */
		oldestAgeMs: number | null;
		/** 按 reason 前缀（`deadline-exceeded` 等）分组计数。 */
		byReason: Record<string, number>;
		/** 最旧超阈值 ⇒ true（这是“有人在等你处理”的信号，不是错误）。 */
		stale: boolean;
		/** 本次读数取自何时（缓存可能命中，必须让读的人知道年龄）。 */
		sampledAt: string;
	};
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
	/** 会话目录（缺省 defaultSessionsDir()；`maxSessionFileBytes` 的扫描根，测试注入隔离）。 */
	sessionsDir?: string;
	/** 配置路径（缺省 defaultPkgConfigPath()；wechat 通道存活读数用）。 */
	configPath?: string;
	/** runtime 目录（缺省 defaultRuntimeDir()；wechat 凭据/state 读数用）。 */
	runtimeDir?: string;
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
/**
 * RSS 告警阈值（MB）。本机物理 31.1GB；历史事故是「内核池 + 句柄暴涨 ⇒ 物理内存 99.4%」，
 * 那种状态下写文件会随机失败。daemon 正常在 100-400MB，超过 1.5GB 基本可判定异常
 * （例如读入了不该读的巨型文件）。阈值故意给宽：宁可少报，也不要天天喊狼来了。
 */
const MEMORY_WARN_RSS_MB = 1536;

/**
 * 单个会话文件的告警阈值（MB）。本机实测最大 152MB（1273 条 message 占 151MB）。
 * 8MB 是「p99 会话（9.3MB）」量级的分界：超过它，首屏尾窗解析就会到百毫秒级，
 * 且这类文件只会越长越大（pi 只追加写）。
 */
const SESSION_FILE_WARN_MB = 8;

/**
 * 扫会话目录找最大 .jsonl（stat-only，不读内容）。never-throw：任何 IO 失败 → null。
 *
 * 为什么单独做而不是复用 `listPiSessions`：那个函数会**读每个文件的头**（939 个文件 ≈ 25ms 起，
 * 冷缓存更贵），而 health 每 2s 一次。这里只要 size，用 stat 即可；一次 readdir + N 次 stat。
 */
/**
 * 最大会话文件扫描缓存（2026-10-20）。实测：941 个文件 stat-only = **41-52ms**，
 * 而 health 每 2s 一次 ⇒ 不加缓存就是新一处 stat 风暴（与刚删掉的 `/v1/sessions` 指纹同类）。
 *
 * 失效条件：会话根目录与一层子目录的 `(mtimeMs, size)` 指纹变化 —— pi 新建会话 / 追加写
 * 都会改目录 mtime（子目录条目变化）或文件 size；两者都不变时最大值不可能变。
 * 额外加 TTL 兜底（60s）：NTFS 目录 mtime 在某些写模式下可能延迟刷新。
 */
const SESSION_SCAN_TTL_MS = 60_000;
let sessionScanCache: { fp: string; at: number; value: HealthView["memory"]["maxSessionFile"] } | null = null;

/** 会话根 + 一层子目录的 `(mtimeMs,size)` 指纹（stat-only，O(目录数) 而非 O(文件数)）。失败 → null。 */
/**
 * 判定某会话的存活状态。**用 pid，不用命令行匹配**。
 *
 * ── 2026-10-30 第二次事故（这次是真正的根因）──
 *
 * 第一版枚举 node.exe 命令行找 sessionId。**但 pi tab 的常态启动形态是**
 * `pi --tab-run-id X @prompt.md` —— **命令行里根本没有 sessionId**！
 * 实测：活着的 tab `pid 90508` 正是此形态 ⇒ 永远判 no-live-process ⇒ dead
 * ⇒ 每发一条消息拉起一个 tab。
 *
 * 正确判据：`tab-runs/<runId>.state.json` 里的 `sessionPath`（tab 自己的会话文件）
 * + `pid`。`sessionPath` 是**直接映射**，不靠任何内容匹配（bootstrap prompt 前缀
 * 已被证明不可靠：`lms-<scope>` 类 tab 的 prompt 是「你是 agent://…」开头，
 * 而 `probeSessionsForDispatch` 依赖「根据<mode>进行工作<taskId>」前缀 ⇒ 返回 0 条）。
 *
 * 非 tab 会话（`pi --session <file>` 直接起的，如主会话）回落到命令行**精确匹配**
 * `--session <该会话文件>`；匹配不到只判 unknown（**不是 dead**，因为 @prompt
 * 等形态命令行也看不到 sessionId）。
 */
/**
 * 批量建索：一次算出「所有 tab state」与「所有会话的 activity」。
 *
 * 为什么必须批量：`/v1/sessions` 有 1000+ 会话，单条调用 `probeSessionLiveness`
 * 每次都要遍历 500 条 tab dispatch ⇒ O(N×500) ≈ 50 万次 readTabState，
 * 实测直接把请求拖到 curl 超时（我自己引入的性能事故）。
 *
 * 批量版只做两轮 O(N+M)：
 *   1. 遍历一遍 tab dispatch → 建 `sessionId → {runId, pid, alive}` 映射
 *   2. 遍历一遍会话 → O(1) 查表
 */
export function buildLivenessIndex(sessionsDir: string): Map<string, SessionLivenessVerdict> {
	const index = new Map<string, SessionLivenessVerdict>();
	const runsDir = defaultTabRunsDir();
	/** sessionId → 最强的 tab 证据（**alive 优先**，与 mergeEvidence 同规则） */
	const bySession = new Map<string, { runId: string; pid: number; alive: boolean }>();

	try {
		const dispatches = listTabDispatches(runsDir, 500);
		const states: Array<{ id: string; st: NonNullable<ReturnType<typeof readTabState>>; cwd?: string; dispatchedAt?: string }> = [];
		for (const d of dispatches) {
			const st = readTabState(runsDir, d.id);
			if (!st || typeof st.pid !== "number") continue;
			states.push({ id: d.id, st, cwd: d.cwd, dispatchedAt: d.dispatchedAt });
			const sp = typeof st.sessionPath === "string" ? st.sessionPath : "";
			if (!sp) continue; // 旧记录无 sessionPath ⇒ 走下面的 legacy 兜底
			// 从路径里抽 sessionId：`<ts>_<sessionId>.jsonl`
			const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(sp);
			if (!m) continue;
			const sid = m[1];
			const alive = isProcessAlive(st.pid);
			const prev = bySession.get(sid);
			// alive 优先（与 mergeEvidence 一致）。旧规则是 dead 优先，导致
			// 「同一会话旧实例已死 + 新实例活着」时报 dead ⇒ 列表显示 inactive，
			// 并且调用方会以为该会话需要拉起。
			if (!prev || (alive && !prev.alive)) {
				bySession.set(sid, { runId: d.id, pid: st.pid, alive });
			}
		}

		// legacy 兜底（旧 state 无 sessionPath）：同 cwd 桶 + dispatchedAt 与会话 timestamp
		// 相差 < 10min 就近配对。只对**尚未**入索引的会话做，且只产出真实 pid 证据。
		const legacy = states.filter((x) => !(typeof x.st.sessionPath === "string" && x.st.sessionPath));
		if (legacy.length > 0) {
			// 阶段 1：为每个尚未配对的会话找最近的 legacy 候选（只收集，不落定）
			const candidates: Array<{ sessionId: string; tabId: string; pid: number; delta: number }> = [];
			for (const s of listPiSessions(sessionsDir)) {
				if (bySession.has(s.sessionId)) continue;
				if (!s.cwd) continue;
				const bucket = sessionBucketForCwd(s.cwd);
				const sessTs = Date.parse(s.startedAt);
				if (!Number.isFinite(sessTs)) continue;
				let best: { id: string; pid: number; delta: number } | null = null;
				for (const x of legacy) {
					if (!x.cwd || sessionBucketForCwd(x.cwd) !== bucket) continue;
					const dm = Date.parse(x.dispatchedAt ?? "");
					if (!Number.isFinite(dm)) continue;
					const delta = Math.abs(dm - sessTs);
					if (delta > 10 * 60_000) continue;
					if (!best || delta < best.delta) best = { id: x.id, pid: x.st.pid!, delta };
				}
				if (best) candidates.push({ sessionId: s.sessionId, tabId: best.id, pid: best.pid, delta: best.delta });
			}
			// 阶段 2：互扣筛选（同一 tab 被多会话争抢 ⇒ 全弃用）
			//
			// 2026-10-31 实测事故（sol §8.6 预警）：同 cwd 隔 2 分半的两个会话
			// `01a175ba` / `01a175bd` 都被配给同一个 `pid 433784`（已死）。旧逻辑
			// 只看「时间最近」没有任何身份依据。共享的 legacy 配对必然至少一个错，
			// 且无法判断是哪个 ⇒ **全部弃用**降为 unknown 比随便选一个安全：
			// 宁可该会话需用户手动恢复，也不能因邻居的记录把活会话误判死而重复开窗。
			for (const c of filterContestedLegacyPairs(candidates)) {
				bySession.set(c.sessionId, { runId: c.tabId, pid: c.pid, alive: isProcessAlive(c.pid) });
			}
		}
	} catch {
		/* 索引建失败 → 全部回落 unknown，不影响主流程 */
	}

	// 所有会话先默认 unknown（最保守：不拉起）；命中的改写
	let all: Array<{ sessionId: string; cwd?: string }> = [];
	try {
		all = listPiSessions(sessionsDir).map((s) => ({ sessionId: s.sessionId, cwd: s.cwd }));
	} catch {
		all = [];
	}

	// 命令行证据：**整个周期只枚举一次进程表**（不是每条会话一次）。
	// sol 2026-10-30 指出：旧索引完全不含命令行来源 ⇒ 与单条 probe 判据不一致，
	// 「被拉起的新实例」在列表里不可见（恒为旧 pid 的 dead）。
	// 注：一次 PowerShell ~2s，因此索引内联仍只适合低频调用；高频列表应异步缓存
	// （sol 建议的 freshness/error 模型，尚未实施，此处先保证**判据正确**）。
	const liveBySid = new Map<string, number>();
	try {
		const base = scanSessionCommandLines();
		for (const [sid, pid] of base) liveBySid.set(sid, pid);
	} catch {
		/* 枚举失败 → 不加命令行证据（不当作“无活实例”） */
	}

	for (const s of all) {
		const hit = bySession.get(s.sessionId);
		const livePid = liveBySid.get(s.sessionId);
		// 合并：命令行 alive 高于 tab 历史 dead（与 mergeEvidence 同规则）
		let evidence: LivenessEvidence | null = null;
		if (hit) {
			evidence = hit.alive
				? { kind: "tab-pid-alive", runId: hit.runId, pid: hit.pid }
				: { kind: "tab-pid-dead", runId: hit.runId, pid: hit.pid };
		}
		if (livePid !== undefined) {
			const cmdEv: LivenessEvidence = { kind: "session-flag-alive", pid: livePid };
			evidence = evidence ? mergeEvidence([evidence, cmdEv]) : cmdEv;
		}
		if (!evidence) continue;
		const selPid = "pid" in evidence && evidence.pid > 0 ? evidence.pid : (hit?.pid ?? undefined);
		index.set(s.sessionId, {
			sessionId: s.sessionId,
			liveness: livenessFromEvidence(evidence),
			evidence,
			...(hit ? { runId: hit.runId } : {}),
			...(selPid !== undefined ? { pid: selPid } : {}),
		});
	}
	// 命令行命中但无 tab 记录的会话（典型：被拉起后的新实例）也必须入索引
	for (const [sid, pid] of liveBySid) {
		if (index.has(sid)) continue;
		const evidence: LivenessEvidence = { kind: "session-flag-alive", pid };
		index.set(sid, { sessionId: sid, liveness: "alive", evidence, pid });
	}
	return index;
}

/**
 * 缓存版 `buildLivenessIndex`（GUI 列表专用）。
 *
 * 为何需要：批量索引里含一次 PowerShell 进程枚举，实测 2753ms。
 * `/v1/sessions` 在 GUI 端可能每 6s 一次轮询 ⇒ 不缓存就是“把超时事故重演”。
 *
 * freshness 语义（sol 建议的最小实现）：
 * - TTL 内复用快照（GUI 的 activity 只是展示，陈旧 5s 无害）
 * - **POST 决策不用本缓存**：真正 spawn 前必须走 `probeSessionLiveness` 实时核验
 * - 缓存过期时同步重建（不后台刷新，避免与 shutdown 竞争）
 */
const LIVENESS_INDEX_TTL_MS = 5_000;
let livenessIndexCache: { at: number; dir: string; index: Map<string, SessionLivenessVerdict> } | null = null;

function getCachedLivenessIndex(sessionsDir: string): Map<string, SessionLivenessVerdict> {
	const now = Date.now();
	const c = livenessIndexCache;
	if (c !== null && c.dir === sessionsDir && now - c.at < LIVENESS_INDEX_TTL_MS) return c.index;
	const index = buildLivenessIndex(sessionsDir);
	livenessIndexCache = { at: Date.now(), dir: sessionsDir, index };
	return index;
}

/** 供测试/命令失效缓存（daemon 重启或显式刷新时用）。 */
export function invalidateLivenessIndexCache(): void {
	livenessIndexCache = null;
}

/**
 * legacy 配对结果互扣筛选（**纯函数**，便于单测）。
 *
 * 输入：`候选 = [{ sessionId, tabId }]`（同一 tab 可被多个会话列为候选）。
 * 输出：只保留那些 **tab 记录未被多个会话争抢** 的配对。
 *
 * 为何要丢：同一 tab 被多个会话共享 ⇒ 至少有一个是错的，且**无法判断是哪个**
 * （没有身份依据，只有「同 cwd + 时间接近」）。此时全丢 → 那些会话降为 unknown
 * （不自动拉起，用户可手动开），优先保证不因邻居的 tab 记录把活会话误判死。
 *
 * 2026-10-31 实测：`01a175ba` / `01a175bd`（同 cwd 隔 2 分半）都被配给 `pid 433784`。
 */
export function filterContestedLegacyPairs(
	candidates: ReadonlyArray<{ sessionId: string; tabId: string }>,
): Array<{ sessionId: string; tabId: string }> {
	const owners = new Map<string, Set<string>>();
	for (const c of candidates) {
		const set = owners.get(c.tabId) ?? new Set<string>();
		set.add(c.sessionId);
		owners.set(c.tabId, set);
	}
	return candidates.filter((c) => (owners.get(c.tabId)?.size ?? 0) === 1);
}

/**
 * 枚举一次进程表，返回 `sessionId → pid` 映射（活着的 pi 进程）。
 * 供 `buildLivenessIndex` 批量使用（一次 PowerShell），不逐条调用。
 * never-throw：失败返回空 Map（代表“没拿到命令行证据”，**不代表无活实例**）。
 */
function scanSessionCommandLines(): Map<string, number> {
	const out = new Map<string, number>();
	try {
		const sidRe = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl/i;
		if (process.platform === "win32") {
			const script =
				`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ` +
				`Where-Object { $_.CommandLine -like '*pi-coding-agent*cli.js*' } | ` +
				`ForEach-Object { "" + $_.ProcessId + "|" + $_.CommandLine }`;
			const text = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
				encoding: "utf8", timeout: 15_000, windowsHide: true,
			});
			for (const line of text.split(/\r?\n/)) {
				const bar = line.indexOf("|");
				if (bar <= 0) continue;
				const pid = Number.parseInt(line.slice(0, bar).trim(), 10);
				const cmd = line.slice(bar + 1);
				if (!Number.isInteger(pid) || pid <= 0) continue;
				if (!cmd.includes("--session")) continue;
				const m = sidRe.exec(cmd);
				if (m) out.set(m[1], pid);
			}
			return out;
		}
		const text = execFileSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8", timeout: 15_000 });
		for (const line of text.split("\n")) {
			const mm = /^\s*(\d+)\s+(.*)$/.exec(line);
			if (!mm || !mm[2].includes("--session")) continue;
			const m = sidRe.exec(mm[2]);
			if (m) out.set(m[1], Number.parseInt(mm[1], 10));
		}
	} catch {
		/* never-throw */
	}
	return out;
}

function probeSessionLiveness(sessionId: string, sessionsDir: string): SessionLivenessVerdict {
	if (!sessionId) {
		return { sessionId, liveness: "unknown", evidence: { kind: "probe-unavailable", reason: "empty-session-id" } };
	}
	const evidences: LivenessEvidence[] = [];
	let runId: string | undefined;
	let pid: number | undefined;

	// ① 主路径：枚举 tab state，按 **sessionPath 里的 sessionId** 直接匹配。
	//    比 `probeSessionsForDispatch`（依赖 bootstrap prompt 前缀）可靠得多。
	try {
		const runsDir = defaultTabRunsDir();
		for (const d of listTabDispatches(runsDir, 500)) {
			const st = readTabState(runsDir, d.id);
			if (!st) continue;
			// sessionPath 里含该会话的 sessionId 才算命中（用 sessionId 回查，不用内容猜测）
			const sp = typeof st.sessionPath === "string" ? st.sessionPath : "";
			if (!sp.includes(sessionId)) continue;
			runId = d.id;
			pid = st.pid;
			const r = livenessFromTabState(st, isProcessAlive);
			if (r.evidenceKind === "tab-pid-alive") {
				evidenceListPush(evidences, { kind: "tab-pid-alive", runId: d.id, pid: st.pid! });
			} else if (r.evidenceKind === "tab-pid-dead") {
				evidenceListPush(evidences, { kind: "tab-pid-dead", runId: d.id, pid: st.pid! });
			}
			// 同一会话理论上只有一条 tab；不 break 以便收集多份证据（merge 会取最强）
		}
	} catch {
		evidenceListPush(evidences, { kind: "probe-unavailable", reason: "tab-state-read-failed" });
	}

	// ② 旧 state 兜底（本修复之前写的 state **没有 sessionPath**）：
	//    利用「同一 cwd 桶内，tab 的 dispatchedAt 与该会话文件的创建时间接近」
	//    来配对 —— 只在尚未找到任何证据时启用，且**只产出 alive/dead 证据**
	//    （真实 pid + isProcessAlive，不是猜测）。
	//    为什么需要：修好 `writeState` 只会让**将来**的 tab 有 sessionPath，
	//    现存 18 个 tab state 全部缺该字段（实测 18/18 ABSENT）。
	if (evidences.length === 0) {
		try {
			const file = findSessionFile(sessionsDir, sessionId);
			const rec = file !== null ? readSessionHeaderRecord(file) : null;
			const sessionCwd = typeof rec?.cwd === "string" ? rec.cwd : null;
			const sessionTs = typeof rec?.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
			if (sessionCwd && Number.isFinite(sessionTs)) {
				const bucket = sessionBucketForCwd(sessionCwd);
				const runsDir = defaultTabRunsDir();
				// 候选：同桶 + 无 sessionPath（旧记录）+ dispatchedAt 在会话创建后 10 分钟内
				let best: { id: string; delta: number; pid?: number } | null = null;
				for (const d of listTabDispatches(runsDir, 500)) {
					if (!d.cwd || sessionBucketForCwd(d.cwd) !== bucket) continue;
					const st = readTabState(runsDir, d.id);
					if (!st || typeof st.pid !== "number") continue;
					if (typeof st.sessionPath === "string" && st.sessionPath) continue; // 新记录已在主路径处理
					const dm = Date.parse(d.dispatchedAt);
					if (!Number.isFinite(dm)) continue;
					const delta = Math.abs(dm - sessionTs);
					if (delta > 10 * 60_000) continue; // 超过 10 分钟不认为是同一会话
					if (!best || delta < best.delta) best = { id: d.id, delta, pid: st.pid };
				}
				if (best) {
					runId = best.id;
					pid = best.pid;
					evidenceListPush(
						evidences,
						isProcessAlive(best.pid!)
							? { kind: "tab-pid-alive", runId: best.id, pid: best.pid! }
							: { kind: "tab-pid-dead", runId: best.id, pid: best.pid! },
					);
				}
			}
		} catch {
			evidenceListPush(evidences, { kind: "probe-unavailable", reason: "legacy-match-failed" });
		}
	}

	// ③ 回落：命令行精确含 `--session <该会话文件>`
	try {
		const file = findSessionFile(sessionsDir, sessionId);
		if (file) {
			const probe = probeCommandLineForSessionFlag(file);
			if (probe.kind === "found") evidenceListPush(evidences, { kind: "session-flag-alive", pid: probe.pid });
			else if (probe.kind === "absent") evidenceListPush(evidences, { kind: "session-flag-absent" });
			else evidenceListPush(evidences, { kind: "probe-unavailable", reason: "cmdline-probe-failed" });
		}
	} catch {
		evidenceListPush(evidences, { kind: "probe-unavailable", reason: "cmdline-probe-threw" });
	}

	const evidence = mergeEvidence(evidences);
	// 顶层 `pid` / `runId` 必须从**最终选中的证据**派生。
	// 旧实现用的是循环变量 `runId` / `pid`（最后一个访问的旧 tab，242324）——
	// 当选中证据是 `session-flag-alive(291780)` 时，对外却报旧 pid，调用方/日志全被误导。
	const selectedRunId = "runId" in evidence ? evidence.runId : undefined;
	const selectedPid = "pid" in evidence && evidence.pid > 0 ? evidence.pid : undefined;
	return {
		sessionId,
		liveness: livenessFromEvidence(evidence),
		evidence,
		...(selectedRunId ?? runId ? { runId: selectedRunId ?? runId } : {}),
		...(selectedPid !== undefined ? { pid: selectedPid } : {}),
	};
}

function evidenceListPush(arr: LivenessEvidence[], e: LivenessEvidence): void {
	arr.push(e);
}

/** 读会话文件首行（`{type:"session", cwd}`）。never-throw。 */
function readSessionHeaderRecord(file: string): { type?: unknown; cwd?: unknown; timestamp?: unknown } | null {
	try {
		const head = readFileSync(file, "utf8").split("\n", 1)[0] ?? "";
		return JSON.parse(head) as { type?: unknown; cwd?: unknown; timestamp?: unknown };
	} catch {
		return null;
	}
}

/**
 * 命令行探针结果。**必须带真实 pid** —— 旧实现只返回 `"found"`，然后在调用处
 * 伪造 `pid: 0`，导致对外报的 pid 与实际活进程脱节（sol 2026-10-30 指出）。
 * never-throw：探针失败返回 `error`（调用方判 unknown，**不判 dead**）。
 */
type CommandLineProbe = { kind: "found"; pid: number } | { kind: "absent" } | { kind: "error" };

/**
 * 命令行里有**精确**的 `--session <该会话文件>` 吗。仅用于非 tab 会话回落判定。
 *
 * ⚠ 已知局限（sol 指出，本次不修，记在此防遗忘）：
 * `includes("--session") && includes(base)` 并未证明 base 就是 `--session` 的**参数**
 * （理论上命令行可在别处出现该文件名），也没证明加载后没有切到其它会话。
 * 当前实测到的 291780 命令行确实直接带目标文件，不是靠裸 UUID 推断。
 * 真正加固应解析 argv 并校验会话身份（配合 session_start 实例登记）。
 */
function probeCommandLineForSessionFlag(sessionFile: string): CommandLineProbe {
	try {
		const base = sessionFile.split(/[\\/]/).pop() ?? sessionFile;
		if (process.platform === "win32") {
			// 一并取 ProcessId（旧脚本只取 CommandLine ⇒ 拿不到 pid）
			const script =
				`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ` +
				`Where-Object { $_.CommandLine -like '*pi-coding-agent*cli.js*' } | ` +
				`ForEach-Object { "" + $_.ProcessId + "|" + $_.CommandLine }`;
			const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
				encoding: "utf8", timeout: 10_000, windowsHide: true,
			});
			for (const line of out.split(/\r?\n/)) {
				const bar = line.indexOf("|");
				if (bar <= 0) continue;
				const pid = Number.parseInt(line.slice(0, bar).trim(), 10);
				const cmd = line.slice(bar + 1);
				if (!Number.isInteger(pid) || pid <= 0) continue;
				if (cmd.includes("--session") && cmd.includes(base)) return { kind: "found", pid };
			}
			return { kind: "absent" };
		}
		// POSIX：`ps -ax -o pid=,command=` 同时在一次调用里拿 pid
		const out = execFileSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8", timeout: 10_000 });
		for (const line of out.split("\n")) {
			const m = /^\s*(\d+)\s+(.*)$/.exec(line);
			if (!m) continue;
			if (m[2].includes("--session") && m[2].includes(base)) return { kind: "found", pid: Number.parseInt(m[1], 10) };
		}
		return { kind: "absent" };
	} catch {
		return { kind: "error" };
	}
}


/**
 * 读会话文件头记录的 cwd（S2 拉起前置检查）。
 *
 * 只读**首行**（`{type:"session", cwd}`），不整文件解析：
 * 大会话文件可能几十 MB，而 cwd 只在首行。never-throw（读不出 → null）。
 */
function readSessionCwdFromFile(file: string): string | null {
	try {
		const head = readFileSync(file, "utf8").split("\n", 1)[0] ?? "";
		const rec = JSON.parse(head) as { type?: unknown; cwd?: unknown };
		return rec.type === "session" && typeof rec.cwd === "string" ? rec.cwd : null;
	} catch {
		return null;
	}
}

/**
 * S2 生产实现：拉起已死会话（新开一个**可见** WT tab）。
 *
 * owner 裁决（2026-10-30）：「新开一个可见 wt tab。这样用户想去 wt 中看也行
 * 想在 gui 继续说话也行」。
 *
 * 复用 `spawnPiTab`（含 wt 探活 + preflight + fail-closed），但**不传 prompt**：
 * 续接会话不需要 bootstrap 文本（历史已在会话里），而 `--session` 已由
 * `sessionFile` 字段翻译成 argv。
 *
 * 注意：本函数在 **daemon 进程**里跑。`findWindowsTerminal` / `findPiCli` 都在
 * `index.ts`（扩展加载侧，daemon 不可达，否则会把整个扩展图拖进 daemon）。
 * 所以这里用最小本地实现：`where wt.exe` + `PI_CLI_PATH`/`process.argv[1]` 推导。
 * **两者都缺 ⇒ 如实返回 error（不静默降级）**，让 GUI 看到「无法拉起」。
 */
function defaultSpawnSessionTab(args: { sessionFile: string; cwd: string; title: string }): { runId?: string; error?: string } {
	// ① wt.exe：仍用 `where`（WindowsApps 受保护，existsSync 不可靠）
	let wtPath: string | null = null;
	try {
		wtPath = execFileSync("where", ["wt.exe"], { encoding: "utf8", shell: true }).split("\n")[0].trim() || null;
	} catch {
		wtPath = null;
	}
	if (!wtPath) return { error: "未找到 Windows Terminal (wt.exe)，无法拉起会话" };

	// ② pi CLI：PI_CLI_PATH 优先；否则用当前 node 跑 pi 的 cli.js（daemon 自身就是 node）
	let piCli = process.env.PI_CLI_PATH && existsSync(process.env.PI_CLI_PATH) ? process.env.PI_CLI_PATH : "";
	if (!piCli) {
		// 从 daemon 的 argv 推：daemon 用 `node --import loader server.ts` 起的，
		// 拿不到 pi cli 路径 ⇒ 尝试 npm 全局标准位置（与 index.ts 候选链同思路的窄子集）。
		for (const cand of [
			join(dirname(process.execPath), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
			join(process.env.APPDATA ?? "", "npm", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
		]) {
			if (cand && existsSync(cand)) { piCli = cand; break; }
		}
	}
	if (!piCli) return { error: "未找到 pi CLI（可设 PI_CLI_PATH），无法拉起会话" };

	const r = spawnPiTab({
		wtPath,
		piCli,
		cwd: args.cwd,
		title: args.title,
		// 续接不需要 bootstrap 文本：历史已在会话里。空串占位（wtPromptArg 会内联为空）。
		prompt: "",
		sessionFile: args.sessionFile,
	});
	return r.error ? { error: r.error } : { runId: r.runId ?? args.title };
}

function sessionsDirFingerprint(sessionsDir: string): string | null {
	try {
		const parts: string[] = [];
		const root = statSync(sessionsDir);
		parts.push(`.|${root.mtimeMs}|${root.size}`);
		for (const name of readdirSync(sessionsDir)) {
			const full = join(sessionsDir, name);
			let st: Stats;
			try {
				st = statSync(full);
			} catch {
				continue;
			}
			if (st.isDirectory()) parts.push(`${name}|${st.mtimeMs}|${st.size}`);
		}
		return parts.join(String.fromCharCode(10));
	} catch {
		return null;
	}
}

/** 后台刷新在飞标记（防同一时刻多个 health 请求各自起一次扫描）。 */
let sessionScanRefreshing = false;

/**
 * 最大会话文件（**永不阻塞**）。
 *
 * 2026-10-20 实测修：原实现冷启动时在 health 请求线程里同步扫 941 个文件 ——
 * 正常 41-52ms，I/O 饥饿时 **9.8s**，而 health 探针超时只有 1500ms ⇒ 新建实例
 * 被判 `stale`（`test:runtime-host-server` T8 实测红：'stale' !== 'alive'）。
 * health 是**探活**端点，绝不能被一次目录扫描拖到超时。
 *
 * 现在的语义：
 *   - 缓存有效（指纹一致且未过 TTL）⇒ 直接返回；
 *   - 否则返回**上一次已知值**（冷启动首帧为 null），并用 setImmediate 后台刷新。
 * ⇒ health 永远只付「指纹」的成本；扫描成本落在后台，不阻塞任何请求。
 */
function largestSessionFileCached(sessionsDir: string, now: Date): HealthView["memory"]["maxSessionFile"] {
	const fp = sessionsDirFingerprint(sessionsDir);
	const nowMs = now.getTime();
	const fresh =
		sessionScanCache !== null &&
		fp !== null &&
		sessionScanCache.fp === fp &&
		nowMs - sessionScanCache.at < SESSION_SCAN_TTL_MS;
	if (fresh) return sessionScanCache!.value;
	// 需要刷新：后台做，本次返回上次已知值
	if (!sessionScanRefreshing) {
		sessionScanRefreshing = true;
		setImmediate(() => {
			try {
				const value = largestSessionFile(sessionsDir);
				const fp2 = fp ?? sessionsDirFingerprint(sessionsDir);
				if (fp2 !== null) sessionScanCache = { fp: fp2, at: Date.now(), value };
			} catch {
				/* never-throw：后台刷新失败保留旧值 */
			} finally {
				sessionScanRefreshing = false;
			}
		});
	}
	return sessionScanCache?.value ?? null;
}

function largestSessionFile(sessionsDir: string): HealthView["memory"]["maxSessionFile"] {
	let best: { bytes: number; relPath: string } | null = null;
	const walk = (dir: string, rel: string, depth: number): void => {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of entries) {
			const full = join(dir, name);
			let st: Stats;
			try {
				st = statSync(full);
			} catch {
				continue; // 扫描间隙消失的条目：跳过（与 listPiSessions 容错一致）
			}
			if (st.isDirectory()) {
				if (depth < 1) walk(full, `${rel}${name}/`, depth + 1); // 与 listPiSessions 同构：只下一层
				continue;
			}
			if (!name.endsWith(".jsonl")) continue;
			if (best === null || st.size > best.bytes) best = { bytes: st.size, relPath: `${rel}${name}` };
		}
	};
	try {
		walk(sessionsDir, "", 0);
	} catch {
		return null;
	}
	if (best === null) return null;
	const mb = Math.round((best.bytes / (1024 * 1024)) * 10) / 10;
	// 文件名形状 `<ts>_<sessionId>.jsonl`；解析不出就给 null（不猜）
	const m = /_([0-9a-f-]{36})\.jsonl$/i.exec(best.relPath);
	return {
		bytes: best.bytes,
		mb,
		sessionId: m !== null ? m[1]! : null,
		relPath: best.relPath,
		warn: mb >= SESSION_FILE_WARN_MB,
	};
}

/** 采样进程内存（never-throw：memoryUsage 本身不抛，这里只是防御性包裹）。 */
function sampleMemory(now: Date, sessionsDir: string): HealthView["memory"] {
	const sampledAt = iso(now);
	let rss = 0;
	let heapUsed = 0;
	let heapTotal = 0;
	let external = 0;
	try {
		const m = process.memoryUsage();
		rss = m.rss;
		heapUsed = m.heapUsed;
		heapTotal = m.heapTotal;
		external = m.external;
	} catch {
		/* 取不到就给 0（不影响其它字段） */
	}
	const mb = (n: number): number => Math.round((n / (1024 * 1024)) * 10) / 10;
	const rssMb = mb(rss);
	return {
		rssMb,
		heapUsedMb: mb(heapUsed),
		heapTotalMb: mb(heapTotal),
		externalMb: mb(external),
		sampledAt,
		// 采样与响应同一时刻生成 ⇒ 年龄恒 0；保留字段是为了**契约形状固定**：
		// 将来若改成缓存采样（避免每 2s 都调 memoryUsage），这里会自然变成非零年龄。
		sampleAgeMs: 0,
		rssWarn: rssMb >= MEMORY_WARN_RSS_MB,
		maxSessionFile: largestSessionFileCached(sessionsDir, now),
	};
}

/**
 * 读「流式快照」（2026-10-20）。由 pi 扩展在 `message_update` 时覆盖写（节流 150ms）。
 *
 * never-throw：不存在 / 坏 JSON / 陈旧 → null（GUI 当「没在流式」处理）。
 * 陈旧阈值 60s：正常流式每 150ms 就刷新一次，60s 不更新只能是进程崩溃留下的残留。
 */
const STREAMING_STALE_MS = 60_000;

function readStreamingSnapshot(sessionId: string): Record<string, unknown> | null {
	const p = join(defaultRuntimeDir(), "state", "streaming", `${sessionId}.json`);
	try {
		const raw = readFileSync(p, "utf8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		if (parsed === null || typeof parsed !== "object") return null;
		if (parsed.sessionId !== sessionId) return null;
		const at = typeof parsed.at === "string" ? Date.parse(parsed.at) : Number.NaN;
		if (!Number.isFinite(at)) return null;
		const ageMs = Date.now() - at;
		if (ageMs > STREAMING_STALE_MS || ageMs < -STREAMING_STALE_MS) return null; // 陈旧 / 时钟异常
		return { ...parsed, ageMs };
	} catch {
		return null;
	}
}

/**
 * 读「会话正忙」标记（2026-10-20，停止按钮可点性）。
 *
 * 由 pi 扩展在 `agent_start`/`turn_start` 写、`agent_settled`/`agent_end` 删，
 * 忙期间每 15s 心跳刷新 `at`。这里只读。
 *
 * never-throw：不存在 / 坏 JSON / 陈旧 → null。
 * 陈旧阈值 45s（= 心跳 15s 的 3 倍）：长工具期间靠心跳续命，超过 45s 不更新
 * 只能是进程崩溃留下的残留 ⇒ 不认（否则按钮永远可点）。
 */
const BUSY_STALE_MS = 45_000;

function readBusySnapshot(sessionId: string): Record<string, unknown> | null {
	const p = join(defaultRuntimeDir(), "state", "session-busy", `${sessionId}.json`);
	try {
		const raw = readFileSync(p, "utf8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		if (parsed === null || typeof parsed !== "object") return null;
		if (parsed.sessionId !== sessionId) return null;
		if (parsed.busy !== true) return null;
		const at = typeof parsed.at === "string" ? Date.parse(parsed.at) : Number.NaN;
		if (!Number.isFinite(at)) return null;
		const ageMs = Date.now() - at;
		if (ageMs > BUSY_STALE_MS || ageMs < -BUSY_STALE_MS) return null;
		return { ...parsed, ageMs };
	} catch {
		return null;
	}
}

/** 微信通道「多久没轮询算死」：长轮询单次可达 30-60s，取 5 分钟（宽裕但能抓住真死）。 */
const WECHAT_POLL_STALE_MS = 5 * 60 * 1000;

/**
 * 采样微信接收通道存活状态（2026-10-20）。
 *
 * 为什么必须单独给读数：supervisor 的 running 是它**自己**的内存视图，
 * 而 2026-10-20 的事故正是「supervisor 认为有残留 worker 所以不 spawn，而 worker 早死了」——
 * 自己报告的状态不可自证。这里读 worker 真正写的 state.json.lastPollAt（独立证据）。
 *
 * never-throw：任何读失败都降级为 null/false，不让 health 500。
 */
// ── 交付失败账本采样（2026-10-21，Item 53 未决项）────────────────
//
// 为何需要缓存：`delivery/` 目录当前 **1357 个文件**（含 attempt/incident 两类），
// health 每 2s 一次 ⇒ 裸扫会造成新的 stat 风暴（Item 57 刚删掉一个同类）。
//
// ⚠️ 首版写了「指纹 + TTL」缓存，被自己的回归测试抓出**陈旧 bug**：
// `ttlOk`（TTL 未到）与 `fresh`（指纹一致**且** TTL 内）被混用 ⇒ 指纹已变但 TTL 未到时
// 仍复用旧值 ⇒ ack 后 health 计数不降（实测 2 !== 0）。
//
// 实测冷扫只需 **7.1ms / 106 条**（远低于 health 基线 17ms）⇒ **不缓存最简单且无陈旧风险**。
// 若未来 incident 量级增至数千，再引入「目录 mtime + 文件数」双字段指纹缓存（R-3）。
/** 最旧 incident 超此年龄 ⇒ `stale`（“有人在等你处理”）。 */
export const DELIVERY_INCIDENT_STALE_MS = 60 * 60 * 1000;

function scanOpenIncidents(dir: string, nowMs: number): Omit<HealthView["delivery"], "sampledAt"> {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return { openIncidents: 0, oldestAgeMs: null, byReason: {}, stale: false };
	}
	let open = 0;
	let oldest: number | null = null;
	const byReason: Record<string, number> = {};
	for (const f of entries) {
		if (!f.includes(".incident.") || !f.endsWith(".json")) continue;
		let inc: { incidentId?: string; reason?: string; createdAt?: string; ackedAt?: string };
		try {
			inc = JSON.parse(readFileSync(join(dir, f), "utf8")) as typeof inc;
		} catch {
			continue;
		}
		if (!inc?.incidentId || inc.ackedAt) continue;
		open += 1;
		const at = typeof inc.createdAt === "string" ? Date.parse(inc.createdAt) : Number.NaN;
		if (Number.isFinite(at)) {
			const age = Math.max(0, nowMs - at);
			if (oldest === null || age > oldest) oldest = age;
		}
		const key = (inc.reason ?? "unknown").split("(")[0] ?? "unknown";
		byReason[key] = (byReason[key] ?? 0) + 1;
	}
	return {
		openIncidents: open,
		oldestAgeMs: oldest,
		byReason,
		stale: oldest !== null && oldest > DELIVERY_INCIDENT_STALE_MS,
	};
}

function sampleDeliveryLedger(now: Date, runtimeDir: string): HealthView["delivery"] {
	// 直扫（无缓存）：年龄天然按 now 计算，不存在「缓存使读数变年轻」的 R-2.2 风险。
	return { ...scanOpenIncidents(deliveryDir(runtimeDir), now.getTime()), sampledAt: iso(now) };
}

function sampleWechatChannel(now: Date, configPath: string, runtimeDir: string): HealthView["wechat"] {
	const base: HealthView["wechat"] = {
		enabled: false,
		receiveEnabled: false,
		credsPresent: false,
		lastPollAt: null,
		lastPollAgeMs: null,
		stale: false,
		lastError: null,
	};
	try {
		base.enabled = readWechatEnabled(configPath);
		base.receiveEnabled = readWechatReceiveEnabled(configPath);
		base.credsPresent = readWechatCreds(wechatCredsPath(runtimeDir)) !== null;
	} catch {
		return base;
	}
	try {
		const statePath = join(WechatStore.resolveDir(runtimeDir), "state.json");
		const raw = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
		const lastPollAt = typeof raw.lastPollAt === "string" ? raw.lastPollAt : null;
		base.lastPollAt = lastPollAt;
		if (lastPollAt !== null) {
			const at = Date.parse(lastPollAt);
			if (Number.isFinite(at)) base.lastPollAgeMs = Math.max(0, now.getTime() - at);
		}
		base.lastError = typeof raw.lastError === "string" ? raw.lastError : null;
	} catch {
		/* 无 state.json：视为从未轮询 */
	}
	// stale 只在「本该跑」时才成立：没开/没凭据不告警（否则噪音）
	base.stale =
		base.enabled &&
		base.receiveEnabled &&
		base.credsPresent &&
		(base.lastPollAgeMs === null || base.lastPollAgeMs > WECHAT_POLL_STALE_MS);
	return base;
}

/**
 * 读「会话可用命令」快照（2026-10-20 GUI 斜杠命令）。
 *
 * 由 pi 扩展写（`session_start` 基线 + 每轮 `message_start` 懒刷新）。
 * 陈旧阈值 1h：命令集在会话期内基本不变；过期太狠只说明进程早没了。
 *
 * never-throw：缺失 / 坏 JSON → null（GUI 回退到「只给自由输入」）。
 */
const COMMANDS_STALE_MS = 60 * 60 * 1000;

function readCommandsSnapshot(sessionId: string): Record<string, unknown> | null {
	const p = join(defaultRuntimeDir(), "state", "commands", `${sessionId}.json`);
	try {
		const raw = readFileSync(p, "utf8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		if (parsed === null || typeof parsed !== "object") return null;
		if (parsed.sessionId !== sessionId) return null;
		if (!Array.isArray(parsed.commands)) return null;
		const at = typeof parsed.at === "string" ? Date.parse(parsed.at) : Number.NaN;
		const ageMs = Number.isFinite(at) ? Date.now() - at : Number.POSITIVE_INFINITY;
		if (ageMs > COMMANDS_STALE_MS) return null;
		return { ...parsed, ageMs };
	} catch {
		return null;
	}
}

/** `/v1/incidents` 只读投影：未 ack 的交付失败账本（Item 53 未决项）。 */
export interface IncidentsView {
	version: 1;
	generatedAt: string;
	openCount: number;
	items: {
		incidentId: string;
		runId: string;
		eventId: string;
		reason: string;
		createdAt: string;
		/** 距今（ms）—— R-2.2：必须给年龄，不能只给绝对时间。 */
		ageMs: number;
	}[];
}

export function buildIncidentsView(now: Date, runtimeDir: string = defaultRuntimeDir()): IncidentsView {
	const dir = deliveryDir(runtimeDir);
	const nowMs = now.getTime();
	const items: IncidentsView["items"] = [];
	let entries: string[] = [];
	try {
		entries = readdirSync(dir);
	} catch {
		/* never-throw：无目录 = 无 incident */
	}
	for (const f of entries) {
		if (!f.includes(".incident.") || !f.endsWith(".json")) continue;
		let inc: { incidentId?: string; runId?: string; eventId?: string; reason?: string; createdAt?: string; ackedAt?: string };
		try {
			inc = JSON.parse(readFileSync(join(dir, f), "utf8")) as typeof inc;
		} catch {
			continue;
		}
		if (!inc?.incidentId || inc.ackedAt) continue;
		const at = typeof inc.createdAt === "string" ? Date.parse(inc.createdAt) : Number.NaN;
		items.push({
			incidentId: inc.incidentId,
			runId: inc.runId ?? "-",
			eventId: inc.eventId ?? "-",
			reason: inc.reason ?? "unknown",
			createdAt: inc.createdAt ?? "",
			ageMs: Number.isFinite(at) ? Math.max(0, nowMs - at) : 0,
		});
	}
	items.sort((a, b) => b.ageMs - a.ageMs);
	return { version: 1, generatedAt: iso(now), openCount: items.length, items };
}

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
		memory: sampleMemory(now, opts.sessionsDir ?? defaultSessionsDir()),
		wechat: sampleWechatChannel(now, opts.configPath ?? defaultPkgConfigPath(), opts.runtimeDir ?? defaultRuntimeDir()),
		delivery: sampleDeliveryLedger(now, opts.runtimeDir ?? defaultRuntimeDir()),
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

// ── L2 perf（plans/20260930_gui_perf_diagnosis.md §5 B1）：读投影条件请求支持（additive）──
// 动因：GUI 6s 档全量轮询 sessions/snapshot 实测 ~104 KB/s 持续带宽 + /v1/sessions 每拍全量
// 重建 ~313ms（797 会话 readHead×N + 标题解析链）。机制：响应带 ETag（sha1，node:crypto，
// 零新依赖）；客户端带 If-None-Match 且命中 → 304 空体。**不带该头的旧客户端照常 200 全量**
// ——完全 additive，契约零变化（304 仅在客户端主动携带 INM 时发生）。

/** ETag（强校验器形式 "<sha1hex>"）。 */
function sha1Etag(s: string): string {
	return `"${createHash("sha1").update(s).digest("hex")}"`;
}

// ── /v1/runs 的 `?sessionId=` 校验（2026-10-26 P1A，右侧栏数据面）─────────────
// 纪律：**fail-closed 且在条件请求之前**。若先跑 matchEtag，客户端带 `If-None-Match: *` 就会把
// 非法参数变成 304「假成功」——非法输入必须看得见地 400。

/** 单次查询允许的**原始** token 数上限（去重前计数：`a,a,a,a,a,a` 也算 6）。 */
export const RUNS_SESSION_SCOPE_MAX_TOKENS = 5;
/** 允许的会话 id 字符集（pi 会话 UUID / `tab_*` 都在内；拒绝空白与分隔符混淆）。 */
const RUNS_SESSION_ID_CHARS = /^[A-Za-z0-9_.:-]+$/;

/**
 * 解析 `?sessionId=`（逗号分隔多值）→ **去重 + 确定性排序**后的规范化 scope。
 *
 * 同一规范化结果同时用于：过滤、ETag 输入（因此 `?sessionId=b,a` 与 `?sessionId=a,b` 必须同 ETag
 * ——排序用 locale 无关的 `Array.prototype.sort()`，不用 `localeCompare`）。
 * 缺省（无该参数）⇒ `[]` = 本机全量。
 */
export function parseRunsSessionScope(params: URLSearchParams): string[] {
	const all = params.getAll("sessionId");
	if (all.length === 0) return [];
	if (all.length > 1) {
		throw new HttpError(400, {
			error: "bad-session-scope",
			hint: "sessionId 只能出现一次（多值用逗号分隔，如 ?sessionId=a,b）",
		});
	}
	const raw = all[0] ?? "";
	if (raw.length === 0) {
		throw new HttpError(400, { error: "bad-session-scope", hint: "sessionId 不得为空串（不要本机全量请省略该参数）" });
	}
	const tokens = raw.split(",");
	if (tokens.length > RUNS_SESSION_SCOPE_MAX_TOKENS) {
		throw new HttpError(400, {
			error: "bad-session-scope",
			hint: `sessionId 最多 ${RUNS_SESSION_SCOPE_MAX_TOKENS} 个（实际 ${tokens.length}）`,
		});
	}
	for (const t of tokens) {
		if (t.length === 0) {
			throw new HttpError(400, { error: "bad-session-scope", hint: "sessionId 含空 token（如 `a,,b` / 首尾逗号）" });
		}
		if (!RUNS_SESSION_ID_CHARS.test(t)) {
			throw new HttpError(400, {
				error: "bad-session-scope",
				hint: `sessionId 含非法字符：${JSON.stringify(t)}（只允许 [A-Za-z0-9_.:-]）`,
			});
		}
	}
	return [...new Set(tokens)].sort();
}

/** `links.jsonl` 解析异常率上限（超此値 ⇒ 账本不可信 ⇒ `unavailable`）。 */
const RUNS_LINKS_BAD_LINE_RATIO = 0.1;

/**
 * 为 `/v1/runs` 读 async 归属账本（never-throw）。
 *
 * 返回 `null` ⇒ 归属元数据不可用（`attribution:"unavailable"`），两种情形：
 * 1. 文件不可读（权限/IO 错——`readLinksWithStats` 会抛，这里接住）；
 * 2. 解析异常率 > 10%（坏行占比过高：账本已被写坏，此时不得把“读不出”当“没有派发”）。
 *
 * 关键：**这条失败链只降级归属元数据，不影响卡片本身**（缺省查询仍 200 全量）。
 */
function readRunsLinksForAttribution(linksPath?: string): LinkRecord[] | null {
	try {
		const stats = readLinksWithStats(linksPath ?? defaultLinksPath());
		if (stats.badLines > 0 && stats.badLines > stats.lines * RUNS_LINKS_BAD_LINE_RATIO) return null;
		return stats.links;
	} catch {
		return null;
	}
}

/** If-None-Match 命中判定（支持逗号分隔列表 / W/ 弱前缀 / `*`）。 */
function matchEtag(req: IncomingMessage, etag: string): boolean {
	const inm = req.headers["if-none-match"];
	if (typeof inm !== "string" || inm.length === 0) return false;
	return inm.split(",").some((raw) => {
		const t = raw.trim();
		return t === "*" || t.replace(/^W\//, "") === etag;
	});
}

/** 304 空体响应（RFC 9110：304 不得带 body；ETag 头回显允许）。 */
function respondNotModified(res: ServerResponse, etag: string): void {
	try {
		res.writeHead(304, { etag });
		res.end();
	} catch {
		try {
			res.destroy();
		} catch {
			/* ignore */
		}
	}
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
	/**
	 * 2026-10-30 owner 裁决 S2：向已死会话发消息时**拉起它**（新开可见 WT tab）。
	 * 注入形状：接收 sessionFile + cwd + title，返回 runId 或 error。
	 * **缺省 undefined ⇒ 不拉起**（回落现状：只写 outbox，等它自己起来消费）。
	 * 测试完全注入，不碰真实 wt.exe。
	 */
	spawnSessionTab?: (args: { sessionFile: string; cwd: string; title: string }) => { runId?: string; error?: string };
	/** 2026-10-22：async run 记录目录（缺省 `subagent-kill.ts::DEFAULT_RUNS_DIR`，即 env
	 *  PI_SUBAGENT_RUNS_DIR 口径）。测试注入夹具目录；**不得读真实目录**。 */
	runsDir?: string;
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
	/** GUI 图片输入 S1：上传落盘根目录（缺省 defaultRuntimeDir()；测试注入隔离）。 */
	uploadsRuntimeDir?: string;	/** 0923 wechat：iLink base URL（缺省 https://ilinkai.weixin.qq.com；本地 stub 测试）。 */
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
	// GUI 图片输入 S1：上传落盘根目录（`<dir>/uploads`；缺省 defaultRuntimeDir()；测试注入隔离）。
	const uploadsRuntimeDir = opts.uploadsRuntimeDir !== undefined ? opts.uploadsRuntimeDir : defaultRuntimeDir();
	const wechatStore = new WechatStore(WechatStore.resolveDir(wechatRuntimeDir));
	const channelSupervisor = new ChannelSupervisor({
		runtimeDir: wechatRuntimeDir,
		configPath,
		// 2026-10-20 修（可观测性）：原来不传 log ⇒ record() 恒为 no-op ⇒ supervisor 的所有动作
		// （spawn / skipped-stale / auth-required-hold / sync-error）**零日志**。
		// 微信通道静默死 18.5 小时期间，日志里一条记录都没有，正是这个缺口。
		log: (m: string): void => { try { console.error(m); } catch { /* ignore */ } },
	});
	const stopWechatInput = startWechatInput({ runtimeDir: wechatRuntimeDir, configPath, timersDir: opts.timersDir ?? defaultTimersDir(), stateDir: opts.stateDir ?? join(defaultRuntimeDir(), "state") });
	const stopWechatReply = startWechatReplyWatcher({ runtimeDir: wechatRuntimeDir, configPath, stateDir: opts.stateDir ?? join(defaultRuntimeDir(), "state") });

	const respondJson = (res: ServerResponse, status: number, body: unknown, etag?: string): void => {
		try {
			res.writeHead(status, { "content-type": "application/json", ...(etag !== undefined ? { etag } : {}) });
			res.end(JSON.stringify(body));
		} catch {
			try {
				res.destroy();
			} catch {
				/* ignore */
			}
		}
	};

	// L2 perf：/v1/sessions 指纹快路缓存（server 实例生命周期；单线程无锁；body 串 ~330KB 量级）。

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
				// ── S2（2026-10-30 owner）：向**已死会话**发消息 ⇒ 先拉起它（新开可见 WT tab）──
				// 门控：只允许 GUI（trustedLocal ∧ guiEnabled）。微信端只能与 global 通信，
				// 不发 session.message，天然够不到。
				// 缺省 opts.spawnSessionTab === undefined ⇒ 不拉起（零行为变化）。
				let resumeOutcome: { action: string; reason: string } | null = null;
				try {
					const peekForResume = JSON.parse(raw) as { type?: unknown; to?: unknown; payload?: unknown };
					if (peekForResume?.type === "session.message" && typeof peekForResume.to === "string") {
						const parsedTo = parseObjectAddress(peekForResume.to);
						if (parsedTo?.scheme === "pi" && opts.spawnSessionTab) {
							const targetSid = parsedTo.value;
							// ⚠️ 2026-10-30 两次事故修正：
							// ① 【首次】不能用 sessionAlive() 当「进程活着」——它读的是
							//    timers/sessions/<sid>.json 的 lastActiveAt（「最近 15s 有活动」），
							//    模型思考 >15s 就心跳过期 ⇒ 误判 dead ⇒ 每发一句拉起一个 tab。
							// ② 【二次】也不能枚举命令行找 sessionId —— pi tab 的**常态**启动形态是
							//    `pi --tab-run-id X @prompt.md`，命令行里**根本没有 sessionId**！
							//    实测活着的 tab pid 90508 正是此形态 ⇒ 永远判 dead。
							// 正确做法：用 tab state 里的 pid（`tab-runs-runtime.ts:250` 自写），
							// 非 tab 会话才回落命令行精确匹配 `--session <文件>`。
							const sd = opts.sessionsDir ?? defaultSessionsDir();
							const verdict = probeSessionLiveness(targetSid, sd);
							const liveness = verdict.liveness;
							const file = findSessionFile(sd, targetSid);
							const tl = checkTrustedLocalChannel(req, hostToken, self.port);
							const decision = decideSendAction({
								sessionFile: file,
								liveness,
								sessionCwd: file !== null ? readSessionCwdFromFile(file) : null,
								cwdExists: (c) => { try { return statSync(c).isDirectory(); } catch { return false; } },
								permitted: isSpawnPermitted({ trustedLocal: tl.ok, guiEnabled: readGuiEnabled(configPath) }),
							});
							resumeOutcome = { action: decision.action, reason: decision.reason, liveness, evidence: verdict.evidence };
							if (decision.action === "spawn-then-send") {
								const sessionCwd = readSessionCwdFromFile(decision.sessionFile) ?? process.cwd();
								const r = opts.spawnSessionTab({ sessionFile: decision.sessionFile, cwd: sessionCwd, title: resumeTabTitle(targetSid) });
								// 注意：`probe` 变量已不存在（改用 `verdict`）——旧代码引用它会被外层 catch 吞掉，
								// 导致“拉起失败”永远不登账。这里用 verdict.evidence 代替。
								if (r.error) resumeOutcome = { action: "spawn-failed", reason: r.error.slice(0, 120), evidence: verdict.evidence };
							}
						}
					}
				} catch { resumeOutcome = null; /* never-throw：拉起失败不影响发消息主路径 */ }
				const outcome = executeCommand(frame, {
					stateDir: opts.stateDir,
					journalPath: opts.journalPath,
					configPath,
					sessionsDir: opts.sessionsDir, // L4 必修 3：session.message 存在性校验与读投影同源（非默认 sessionsDir 下不再误判 no-session）。
					// GUI 图片输入 S2：附件 id → 绝对路径的解析根（与 /v1/uploads 落盘根**同源**）。
					uploadsDir: uploadsDir(uploadsRuntimeDir),
					// R1 注：TOCTOU（预检活→执行时死）落 post-claim 旧护栏 409 会占 key，同 key 重试重放 409，需换 key（fail-closed；claim 顺序不动）。
					...(trustedMasterInjection !== undefined ? { trustedMasterInjection } : {}),
				});
				// S2：拉起结果并入回执（可观测；不影响原有 outcome 语义）
				if (resumeOutcome !== null && resumeOutcome.action !== "send") {
					(outcome as { resume?: unknown }).resume = resumeOutcome;
				}
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
	const safeReplyError = (value: string | undefined): string | null => {
		if (!value) return null;
		// Only expose a short classifier summary; never return arbitrary persisted data.
		// 0925 P0 L4-S1：策略拒绝/过期也是可解释终态——加 broadcast-unauthorized / broadcast-expired，
		// 否则「策略拒绝」在 /v1/wechat/reply/status 上被投影成泛化 "send-error"（被读成传输失败）。
		const kind = /^(auth|rate_limited|protocol|transient|attempts-exhausted|send-result-unknown|broadcast-unauthorized|broadcast-expired)/.exec(value)?.[1];
		return kind ? kind : "send-error";
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
		// W3d: read-only reply projection; authorize first, then the shared wechat opt-in gate.
		if (p === "/v1/wechat/reply/status" && req.method === "GET") {
			if (!readWechatEnabled(configPath)) { respondJson(res, 403, WECHAT_DISABLED_BODY); return; }
			const items = listReplyIntents(replyIntentDir(outboxStateDirFor(opts)));
			const counts = { pending: 0, sent: 0, failed: 0, unknown: 0 };
			for (const item of items) counts[item.status]++;
			let audits: { at?: string; event?: string; reason?: string; error?: string }[] = [];
			try { audits = readFileSync(join(outboxStateDirFor(opts), "wechat-reply-audit.jsonl"), "utf8").split("\\n").filter(Boolean).slice(-500).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }); } catch {}
			const auditTimes = audits.map((a) => a.at).filter((at): at is string => typeof at === "string");
			const lastAt = [...items.map((item) => item.updatedAt), ...auditTimes].sort().at(-1) ?? null;
			// 0925 P0 L4-S1：event:"denied"（broadcast-unauthorized）并入失败列表，且 denied/TTL 审计行
			// 无 error 字段、分类在 reason 上 → 回落读 reason（仍过白名单，绝不透传任意持久化数据）。
			const failed = [...items.filter((item) => item.error && item.status !== "sent").map((item) => ({ at: item.updatedAt, message: safeReplyError(item.error) })), ...audits.filter((a) => a.event === "failed" || a.event === "unknown" || a.event === "denied" || (a.event === "skipped" && a.reason === "no-credentials")).map((a) => ({ at: a.at ?? "", message: safeReplyError(a.error ?? a.reason) ?? (a.reason === "no-credentials" ? "no-credentials" : null) }))].filter((x) => x.message).sort((a, b) => b.at.localeCompare(a.at))[0];
			const replyCfg = readWechatReplyConfig(configPath);
			respondJson(res, 200, { enabled: replyCfg.enabled, mode: replyCfg.mode, counts, lastAt, lastError: failed?.message ?? null });
			return;
		}
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
		// L4 MF-1（0924）：input/set **不得**置于 opt-in 闸之前——`wechat.enabled=false` 时必须与
		// status/senders 同为 403（规格 §1）；此处无鸡生蛋问题（启用通道走 enable/disable）。
		if (!readWechatEnabled(configPath)) {
			respondJson(res, 403, WECHAT_DISABLED_BODY);
			try { req.destroy(); } catch { /* ignore */ }
			return;
		}
		if (p === "/v1/wechat/input/set" && req.method === "POST") {
			let raw = "";
			req.setEncoding("utf8");
			req.on("data", (chunk: string) => { raw += chunk; });
			req.on("end", () => {
				try {
					const body = JSON.parse(raw || "{}") as { enabled?: unknown; allowFrom?: unknown; add?: unknown; remove?: unknown };
					if ((body.enabled !== undefined && typeof body.enabled !== "boolean") || (body.allowFrom !== undefined && (!Array.isArray(body.allowFrom) || body.allowFrom.some(x => typeof x !== "string"))) || (body.add !== undefined && (!Array.isArray(body.add) || body.add.some(x => typeof x !== "string"))) || (body.remove !== undefined && (!Array.isArray(body.remove) || body.remove.some(x => typeof x !== "string")))) { respondJson(res, 400, { error: "invalid-body" }); return; }
					const result = setWechatInputConfig({ ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}), ...(Array.isArray(body.allowFrom) ? { allowFrom: body.allowFrom as string[] } : {}), ...(Array.isArray(body.add) ? { add: body.add as string[] } : {}), ...(Array.isArray(body.remove) ? { remove: body.remove as string[] } : {}) }, configPath);
					// L4 MF-2（0924）：响应**不得**回显完整 openid（规格 §1：完整 openid 仅出现在
					// /senders 与 GUI 内存）——改为与 status 同形的 {id, masked} 投影。
					const cfg = readWechatInputConfig(configPath);
					if (result.ok) { const n = wechatStore.reevaluateRejected([...cfg.allowFrom, readWechatCreds(wechatCredsPath(wechatRuntimeDir))?.ownerOpenId ?? ""]); if (n) { try { const stateDir = join(wechatRuntimeDir, "state"); mkdirSync(stateDir, { recursive: true }); const auditPath = join(stateDir, "wechat-input-audit.jsonl"); const fd = openSync(auditPath, "a", 0o600); try { appendFileSync(fd, JSON.stringify({ at: new Date().toISOString(), decision: "reevaluated", reason: "sender-now-allowed", count: n }) + "\n"); } finally { closeSync(fd); } try { chmodSync(auditPath, 0o600); } catch {} } catch {} } }
					respondJson(res, result.ok ? 200 : 500, result.ok
						? { enabled: cfg.enabled, allowFromCount: cfg.allowFrom.length, allowFrom: cfg.allowFrom.map((id) => ({ id: wechatOpenIdHash(id), masked: maskWechatOpenId(id) })) }
						: { error: "config-write-failed" });
				} catch { respondJson(res, 400, { error: "invalid-body" }); }
			});
			return;
		}
		if (!readWechatEnabled(configPath)) {
			respondJson(res, 403, WECHAT_DISABLED_BODY);
			try { req.destroy(); } catch { /* ignore */ }
			return;
		}
		if ((p === "/v1/wechat/input/status" || p === "/v1/wechat/senders") && req.method === "GET") {
			const input = readWechatInputConfig(configPath);
			if (p === "/v1/wechat/input/status") {
				const att = readAttachment(masterAddress());
				const timers = opts.timersDir ?? defaultTimersDir();
				const alive = !!att && sessionAlive(timers, att.sessionId, new Date(), SESSION_HEARTBEAT_GRACE_MS);
				let last: Record<string, unknown> = {};
				try { const lines = readFileSync(join(wechatRuntimeDir, "state", "wechat-input-audit.jsonl"), "utf8").trim().split("\n"); last = JSON.parse(lines[lines.length - 1] || "{}"); } catch {}
				respondJson(res, 200, { enabled: input.enabled, allowFrom: input.allowFrom.map(id => ({ id: wechatOpenIdHash(id), masked: maskWechatOpenId(id) })), allowFromCount: input.allowFrom.length, allowFromMasked: input.allowFrom.map(maskWechatOpenId), masterAlive: alive, ...(att ? { masterSid12: att.sessionId.slice(0, 12) } : {}), lastDecision: last.decision ?? null, lastReason: last.reason ?? null, lastAt: last.at ?? null });
				return;
			}
			const grouped = new Map<string, { fromId: string; nickname: string | null; lastAt: string; msgCount: number }>();
			for (const rec of wechatStore.readInbox(0)) { if (!rec.fromId) continue; const g = grouped.get(rec.fromId); if (!g) grouped.set(rec.fromId, { fromId: rec.fromId, nickname: rec.fromNickname, lastAt: rec.receivedAt, msgCount: 1 }); else { g.msgCount++; if (rec.receivedAt > g.lastAt) { g.lastAt = rec.receivedAt; g.nickname = rec.fromNickname; } } }
			respondJson(res, 200, [...grouped.values()].sort((a,b) => b.lastAt.localeCompare(a.lastAt)).slice(0,20).map(x => ({ fromId: x.fromId, fromNicknameMasked: x.nickname, lastAt: x.lastAt, msgCount: x.msgCount, allowlisted: input.allowFrom.includes(x.fromId) })));
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
			const bindState = wechat.getState();
			if (bindState.state === "bound") { const owner = readWechatCreds(wechatCredsPath(wechatRuntimeDir))?.ownerOpenId; if (owner) { const n = wechatStore.reevaluateRejected([owner]); if (n) { try { const stateDir = join(wechatRuntimeDir, "state"); mkdirSync(stateDir, { recursive: true }); const auditPath = join(stateDir, "wechat-input-audit.jsonl"); const fd = openSync(auditPath, "a", 0o600); try { appendFileSync(fd, JSON.stringify({ at: new Date().toISOString(), decision: "reevaluated", reason: "owner-now-allowed", count: n }) + "\n"); } finally { closeSync(fd); } try { chmodSync(auditPath, 0o600); } catch {} } catch {} } } }
			respondJson(res, 200, bindState);
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
		if ((p === "/v1/wechat/worker/status" || p === "/v1/wechat/inbox" || p === "/v1/wechat/quarantine") && req.method === "GET" && !readWechatReceiveEnabled(configPath)) {
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
		if (p === "/v1/wechat/quarantine" && req.method === "GET") {
			const n = Number(u.searchParams.get("limit")); const limit = Number.isInteger(n) && n > 0 ? Math.min(n, 200) : 50;
			let entries: { msgId: string | null; reason: string; at: string }[] = [];
			try { const raw = readFileSync(join(wechatStore.dir, "quarantine.jsonl"), "utf8"); entries = raw.split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }).slice(-limit).reverse(); } catch {}
			const rejected = wechatStore.readInbox(0).filter(x => x.state === "rejected").map(x => ({ msgId: x.msgId.slice(0,8), reason: x.rejectedReason === "write-failed" ? "写入失败（结果不确定，未自动重试）" : x.rejectedReason === "not-allowlisted" ? "白名单外（拒绝）" : "拒绝", at: x.receivedAt }));
			const visible = [...rejected, ...entries].slice(0, limit);
			// L4-S6：诊断面补**命令审计行数**（state/wechat-command-audit.jsonl）——consumed 记录不
			// 落上面的 rejected 列表，命令通道的活动只能从审计文件看（只记掩码+首 token，无正文/token）。
			let commandAuditLines = 0;
			try { commandAuditLines = readFileSync(join(wechatRuntimeDir, "state", "wechat-command-audit.jsonl"), "utf8").split("\n").filter((l) => l.trim() !== "").length; } catch { /* 无审计文件 = 0 行 */ }
			respondJson(res, 200, { count: visible.length, entries: visible, commandAuditLines }); return;
		}
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
					// M1（0925）：附件只透传**相对路径**（无绝对盘符、无 URL/key；A10/A17 哨兵锁死）
					// L4-S4：投影侧套**同一形状门**（与注入侧共用 wechat-input.ARTIFACT_REF_RE 单一来源，
					// 不维护第二份宽松规则）——形状不符（`..`/绝对路径/盘符/URL/非 sha 名）⇒ 不透传。
					...(typeof r.artifactRef === "string" && ARTIFACT_REF_RE.test(r.artifactRef) ? { artifactRef: r.artifactRef } : {}),
				})),
			});
			return;
		}
		respondJson(res, 405, { error: "method-not-allowed", hint: "/v1/wechat/*：POST enable | disable | bind/start | bind/cancel | unbind；GET bind/status | bind/qr-image | worker/status | inbox" });
	};

	const onReq = (req: IncomingMessage, res: ServerResponse): void => {
		let status = 200;
		let body: unknown;
		// L2 perf：snapshot 200 路径的 ETag 附件（304 路径在 case 内提前 return）
		let snapshotEtag: string | undefined;
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
			if (u.pathname === "/v1/uploads") {
				// GUI 图片输入 S1：图片**只落盘**（附件 + 路径），不进命令载荷（那面仍 64KB 上限）、
				// 也不把 base64 写进会话 JSONL。鉴权沿用 authorizeCommand（无/错 → 401）。
				if (!authorizeCommand(req)) {
					respondJson(res, 401, { error: "unauthorized", hint: "POST /v1/uploads 需本机 token（X-Command-Token 或 sw_host_token/sw_gui_token cookie）" });
					try { req.destroy(); } catch { /* ignore */ }
					return;
				}
				if (req.method !== "POST") {
					throw new HttpError(405, { error: "method-not-allowed", hint: "/v1/uploads 仅接受 POST 原始图片字节（Content-Type 不参与判定，按魔数嗅探）" });
				}
				const chunks: Buffer[] = [];
				let size = 0;
				let responded = false;
				req.on("data", (c: Buffer) => {
					if (responded) return;
					size += c.length;
					if (size > UPLOAD_MAX_BYTES) {
						responded = true;
						respondJson(res, 413, { error: "payload-too-large", hint: `单张图片上限 ${UPLOAD_MAX_BYTES} 字节（不截断、不降级；请压缩后重传）` });
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
						// 机会式有界清理（never-throw）：控制磁盘不无限增长
						pruneUploads({ runtimeDir: uploadsRuntimeDir });
						const saved = saveUpload({ runtimeDir: uploadsRuntimeDir, bytes: Buffer.concat(chunks) });
						if (!saved.ok) {
							respondJson(res, saved.reason === "too-large" ? 413 : 400, { error: saved.reason, hint: saved.detail });
							return;
						}
						respondJson(res, 200, { uploadId: saved.uploadId, path: saved.path, bytes: saved.bytes, mediaType: saved.mediaType });
					} catch (e) {
						respondJson(res, 500, { error: "upload-write-failed", hint: String((e as Error).message ?? e) });
					}
				});
				return;
			}
			if (u.pathname === "/v1/commands") {
				// 唯一写端点：仅 POST；GET /v1/commands → 405（读投影不含命令）
				if (req.method === "POST") {
					handlePostCommand(req, res);
					return;
				}
				throw new HttpError(405, { error: "method-not-allowed", hint: "/v1/commands 仅接受 POST（唯一命令入口）；读投影走其余 GET 端点" });
			}
			// ack 一个交付失败 incident（Item 53 未决项：显式 ack 才清——**故意不做自动 ack**，
			// 设计红线：不能因为 toast/通知发送成功就当作已处理）。
			const incAck = /^\/v1\/incidents\/([A-Za-z0-9_.-]+)\/ack$/.exec(u.pathname);
			if (incAck !== null) {
				if (req.method !== "POST") throw new HttpError(405, { error: "method-not-allowed", hint: "ack 仅 POST" });
				if (!authorizeCommand(req)) { respondJson(res, 401, { error: "unauthorized" }); try { req.destroy(); } catch { /* ignore */ } return; }
				const okAck = ackIncident(deliveryDir(opts.runtimeDir ?? defaultRuntimeDir()), incAck[1]!, "gui", Date.now());
				// 幂等：已 ack / 不存在 ⇒ 200 但 acked=false（不报错、不重复扣计数）
				respondJson(res, 200, { incidentId: incAck[1], acked: okAck });
				return;
			}
			// 0923 微信 iLink 绑定 7 端点（v1：绑定/解绑/状态 + enable/disable 开关）：鉴权沿用
			// authorizeCommand 链（无/错 → 401，同 /v1/commands 面）；opt-in OFF（enabled!==true）→
			// 5 个绑定端点 403 wechat-disabled（enable/disable 不受闸限制；GUI「微信连接」入口始终渲染）。
			// token 永不进任何响应。
			if (u.pathname === "/v1/autonomy/set" || u.pathname === "/v1/autonomy/status" || u.pathname === "/v1/autonomy/frontier") {
				if (!authorizeCommand(req)) { respondJson(res, 401, { error: "unauthorized" }); try { req.destroy(); } catch {} return; }
				if (u.pathname === "/v1/autonomy/set" && req.method === "POST") {
					let raw = ""; req.setEncoding("utf8");
					req.on("data", (chunk: string) => { raw += chunk; if (raw.length > 4096) { try { req.destroy(); } catch {} } });
					req.on("end", () => {
						let on: unknown; try { on = (JSON.parse(raw || "{}") as { enabled?: unknown }).enabled; } catch { on = undefined; }
						if (typeof on !== "boolean") { respondJson(res, 400, { error: "invalid-body" }); return; }
						const result = setAutonomyEnabled(on, configPath);
						if (!result.ok) { respondJson(res, 500, { error: "config-write-failed", message: result.error }); return; }
						respondJson(res, 200, { enabled: readAutonomyConfig({ configPath }).enabled });
					}); return;
				}
				if (u.pathname === "/v1/autonomy/status" && req.method === "GET") {
					const cfg = readAutonomyConfig({ configPath }); const kill = readKillSwitch({ stateDir: opts.stateDir });
					const frontier = readFrontierSnapshot({ stateDir: opts.stateDir }); const gate = readWakeGateState({ stateDir: opts.stateDir });
					respondJson(res, 200, { enabled: cfg.enabled, kill: kill ? `on (${kill.reason})` : "off", frontier: frontier ? new Date(frontier.asof).toISOString() : null, wakeGate: gate?.lastReason ? `${gate.lastReason} @ ${gate.lastDecisionAt}` : null }); return;
				}
				// 2026-09-30 主动性设置页：只读读盘即返回完整 FrontierSnapshot（不重计算）。
				// 复用 readFrontierSnapshot 容忍读：快照缺失/坏 JSON/字段漂移 → null（区分「无文件」与「0 项目基线帧」；
				// 授权与 status 同档 authorizeCommand）。不改 /v1/autonomy/status 形状（向后兼容）。
				if (u.pathname === "/v1/autonomy/frontier" && req.method === "GET") {
					respondJson(res, 200, readFrontierSnapshot({ stateDir: opts.stateDir })); return;
				}
				respondJson(res, 405, { error: "method-not-allowed" }); return;
			}
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
						// delivery 段（incident 可见面）必须与 ack 端点读**同一个** runtimeDir，
						// 否则测试/多实例场景会读默认目录（实测：不传则读到真实 13 条而非夹具 2 条）。
						runtimeDir: opts.runtimeDir,
					});
					break;
				case "/v1/incidents":
					// 只读：未 ack 的交付失败账本（Item 53 未决项：此前 ackIncident/listOpenIncidents
					// 全仓零调用 ⇒ 106 条 incident 无任何可见面）。按 R-2.2 带**年龄**。
					body = buildIncidentsView(new Date(), opts.runtimeDir);
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
					{
						// L2 perf（B1）：ETag 排除 generatedAt —— 响应时间戳非状态（诊断实测相邻调用
						// 唯一 diff 字段）；其余状态体参与哈希，真实状态变化自然 miss → 200 全量。
						const stableJson = JSON.stringify({ ...(body as Record<string, unknown>), generatedAt: undefined });
						snapshotEtag = sha1Etag(stableJson);
						if (matchEtag(req, snapshotEtag)) {
							respondNotModified(res, snapshotEtag);
							return;
						}
					}
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
				case "/v1/runs": {
					// 2026-10-22 档 A（GUI 运行态可视化）：async subagent run 的**只读**卡片投影。
					// 动因：run json 的外部读取面此前只有工具 `subagent-win`（status/list/recent-calls）+
					// 进程内 TUI 面板，daemon 侧**零端点** ⇒ GUI 完全看不到 subagent 在跑什么。
					// 为何独立端点而不塞 /v1/snapshot：实测 snapshot 已 412 KB 且 runs 占 81%，
					// 追加 154 份 run 即便只投影 min-card 也要 +80 KB（+19.5%），且 buildRunsSection 是同步投影。
					// 数据源 = `subagent-kill.ts::DEFAULT_RUNS_DIR`（PI_SUBAGENT_RUNS_DIR 口径）；**纯读、零写盘**。
					const runsQ = u.searchParams;
					// ① 校验**先于** ETag 判定（fail-closed；否则 `If-None-Match: *` 会把非法参数洗成 304）。
					const runsScope = parseRunsSessionScope(runsQ);
					const runsLimitRaw = runsQ.get("limit");
					const runsLimit = runsLimitRaw === null ? undefined : Number(runsLimitRaw);
					const includeRecentCalls = (runsQ.get("includeRecentCalls") ?? "") === "1";
					// ② links 读取（never-throw）：失败/解析异常率 >10% ⇒ 归属元数据 unavailable，
					// **但不影响卡片本身** —— 缺省查询（本机全量）绝不因账本坏掉而变空。
					const runsLinks = readRunsLinksForAttribution(opts.linksPath);
					const cards = listAsyncRunCards(opts.runsDir ?? DEFAULT_RUNS_DIR, {
						...(runsLimit !== undefined && Number.isFinite(runsLimit) ? { limit: runsLimit } : {}),
						includeRecentCalls,
						links: runsLinks,
						sessionScope: runsScope,
					});
					// ETag 排除 asof（响应时间戳不是状态；否则每拍都 miss）——手法同 /v1/snapshot。
					// asof 也**不在**卡片里放任何 `now-` 相对量：相对量会让 ETag 永不命中，年龄由 GUI 用
					// lastActivity 自己算。
					const runsBody = {
						version: 1 as const,
						asof: new Date().toISOString(),
						count: cards.runs.length,
						total: cards.total,
						attribution: cards.attribution,
						attributionDetail: cards.attributionDetail,
						runs: cards.runs,
					};
					const runsEtag = sha1Etag(JSON.stringify({ ...runsBody, asof: undefined }));
					if (matchEtag(req, runsEtag)) {
						respondNotModified(res, runsEtag);
						return;
					}
					respondJson(res, 200, runsBody, runsEtag);
					return;
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
					// L2 perf（B1）：指纹快路 + 条件请求。指纹命中 → 复用缓存 body 串（免 readHead×N
					// + 标题解析链，诊断实测 ~313ms → ~20ms/拍）；未命中 → 原路径全量构建并更新缓存。
					// 响应恒带 ETag；If-None-Match 命中 → 304 空体（旧客户端不带该头 → 照常 200 全量）。
					const sessDir = opts.sessionsDir ?? defaultSessionsDir();
					// L2 perf（2026-10-20 第二轮）：**删掉指纹快路**。实测 `sessionsBodyFingerprint` 要 stat
					// 约 1071(sessions) + 3177(tab-runs) + 21(registry) = **130-146ms/拍**（每 6s 一次，在事件循环上）；
					// 而它想省掉的「全量重建」在 readHead/标题缓存落地后只要 ~33ms ⇒ 指纹已是**纯开销**，
					// 还多一类陈旧缓存风险。条件请求（ETag/304）保留：带宽节省不变。
					let bodyJson: string | null = null;
					let bodyEtag: string | null = null;
					{
							const sessions = listPiSessions(sessDir);
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
						// 存活索引：一次遍历建表。含一次 PowerShell 进程枚举（~2.4s）⇒ 必须缓存，
						// 不能每 6s 一次的列表轮询都重跑（否则重演一次超时事故）。
						const livenessIndex = getCachedLivenessIndex(sessDir);
						body = {
							version: 1,
							count: sessions.length,
							sessions: sessions.map(({ firstUserText: _firstUserText, ...s }) => {
								const pin = pins.get(s.sessionId);
								// 契约字段是 titleSource（GUI types.ts 与 SessionList 全 tab 组折叠判据均读它）；
								// SessionTitle.source 是解析链内部字段名，上线时显式映射，不再直接 spread。
								const t = titles.get(s.sessionId);
								const lv = livenessIndex.get(s.sessionId);
								// 活跃状态（owner 2026-10-30：「最近更新/按创建」→「最近更新/活跃中」）。
								// 与 mtime **正交**：刚读过但进程已退 ⇒ mtime 新但 inactive；
								// 进程活着但长思考 ⇒ mtime 旧但 active；缺证据 ⇒ unknown（不当作 inactive）。
								// 用索引表 O(1) 查，不逐条跑探针（那是 O(N×500) 性能事故）。
								const activity = lv ? activityOf(lv.liveness) : ("unknown" as const);
								return {
									...s,
									title: t !== undefined ? t.title : s.sessionId,
									activity,
									...(lv && typeof lv.pid === "number" ? { pid: lv.pid } : {}),
									titleSource: t !== undefined ? t.source : ("id" as const),
									...(protectedSid !== null && s.sessionId === protectedSid ? { masterProtected: true as const } : {}),
									...(pin?.isMaster ? { isMaster: true as const } : {}),
									...(pin?.isScopeMaster ? { isScopeMaster: true as const } : {}),
								};
							}),
							masterProtectedSessionId: protectedSid,
						};
							bodyJson = JSON.stringify(body);
							bodyEtag = sha1Etag(bodyJson);
					}
					if (matchEtag(req, bodyEtag)) {
						respondNotModified(res, bodyEtag);
						return;
					}
					try {
						res.writeHead(200, { "content-type": "application/json", etag: bodyEtag });
						res.end(bodyJson);
					} catch {
						try {
							res.destroy();
						} catch {
							/* ignore */
						}
					}
					return;
				}
				default: {
					// 流式快照（2026-10-20）：pi 扩展在 message_update 时覆盖写 state/streaming/<sid>.json，
					// 这里只读快照给 GUI 做「正在思考」的临时块。会话不在流式 → 404（GUI 静默忽略）。
					// 陈旧保护：快照带 `at`，超过 STREAMING_STALE_MS 视为残留（进程崩溃）→ 404，不让幽灵块常驻。
					// 会话可用命令（2026-10-20 GUI 斜杠命令）：给命令面板与补全用。
					// 快照缺失（扩展未加载 / 未 /reload）→ 404 ⇒ GUI 回退到「只给自由输入」。
					const mcmd = /^\/v1\/session-commands\/([^/]+)$/.exec(u.pathname);
					if (mcmd !== null) {
						const sid = decodeURIComponent(mcmd[1]);
						if (!/^[A-Za-z0-9_-]+$/.test(sid)) throw new HttpError(400, { error: "bad-session-id" });
						const cs = readCommandsSnapshot(sid);
						if (cs === null) throw new HttpError(404, { error: "no-commands-snapshot", sessionId: sid });
						body = cs;
						break;
					}
					// 会话正忙标记（2026-10-20 停止按钮）：turn 级信号，覆盖「点发送 → 第一个 token」
					// 与「工具跑完 → 下一段输出」两段空白（流式快照在这两段都是 404）。
					// 忙 → 200；空闲/陈旧 → 404（GUI 当「空闲」处理）。
					const mbz = /^\/v1\/session-busy\/([^/]+)$/.exec(u.pathname);
					if (mbz !== null) {
						const sid = decodeURIComponent(mbz[1]);
						if (!/^[A-Za-z0-9_-]+$/.test(sid)) throw new HttpError(400, { error: "bad-session-id" });
						const bz = readBusySnapshot(sid);
						if (bz === null) throw new HttpError(404, { error: "not-busy", sessionId: sid });
						body = bz;
						break;
					}
					const mstr = /^\/v1\/streaming\/([^/]+)$/.exec(u.pathname);
					if (mstr !== null) {
						const sid = decodeURIComponent(mstr[1]);
						if (!/^[A-Za-z0-9_-]+$/.test(sid)) throw new HttpError(400, { error: "bad-session-id" });
						const snap = readStreamingSnapshot(sid);
						if (snap === null) throw new HttpError(404, { error: "not-streaming", sessionId: sid });
						body = snap;
						break;
					}
					// 会话控制指令回执（2026-10-20 停止按钮）：读 `state/session-control/` 里
					// 该会话**最近一条**请求（abort 的 aborted / not-streaming / stale-ctx）。
					// 无请求 → 404（GUI 当「没点过停止」处理，不显示状态）。
					const mctl = /^\/v1\/session-control\/([^/]+)$/.exec(u.pathname);
					if (mctl !== null) {
						const sid = decodeURIComponent(mctl[1]);
						if (!/^[A-Za-z0-9_-]+$/.test(sid)) throw new HttpError(400, { error: "bad-session-id" });
						const latest = latestControlRequest(sid);
						if (latest === null) throw new HttpError(404, { error: "no-control-request", sessionId: sid });
						body = { version: 1, sessionId: sid, request: latest, ageMs: Date.now() - Date.parse(latest.requestedAt) };
						break;
					}
					// 2026-10-21：notify 桥（GUI 侧）。
					// 为何需要：ctx.ui.notify 是 TUI-only（types.d.ts:80），本仓 137 个
					// notify 调用点 GUI 全看不到（如 /today-usage 输出完整统计但 GUI 空白）。
					// 按字节 offset 增量读，**只读一个天文件**（不扫目录、不全量读）。
					const mn = /^\/v1\/notify\/([^/]+)$/.exec(u.pathname);
					if (mn !== null) {
						const nSid = decodeURIComponent(mn[1]!);
						const afterRaw = u.searchParams.get("after");
						const afterN = afterRaw === null ? undefined : Number(afterRaw);
						body = { version: 1, sessionId: nSid, ...readNotify(nSid, Number.isFinite(afterN) ? afterN : undefined, new Date(), opts.runtimeDir) };
						break;
					}
					// G6-P1：GET /v1/sessions/:id/transcript?after=<seq>（HTTP 兜底分页，
					// 与 WS transcript 流同一投影函数；after 缺省/0 = 全量快照，>0 = 增量触及行终态）
					// 2026-10-21：会话当前轮次上下文用量（长度/占比/缓存比例）。
					// 数据源 = 会话 JSONL 最后一条带 usage 的 assistant（尾部块读，不全量读）。
					const mu = /^\/v1\/sessions\/([^/]+)\/usage$/.exec(u.pathname);
					if (mu !== null) {
						const usageSid = decodeURIComponent(mu[1]!);
						const usageFile = findSessionFile(opts.sessionsDir ?? defaultSessionsDir(), usageSid);
						if (usageFile === null) throw new HttpError(404, { error: "no-session", sessionId: usageSid });
						// contextWindow 取自 master-liveness 的 windowTokens（与 pi readPressure() 同源）；
						// 取不到 ⇒ null（不猜，不让 GUI 自己编一个窗口值）。
						let win: number | null = null;
						try {
							const live = readLiveness();
							win = typeof live?.windowTokens === "number" && live.windowTokens > 0 ? live.windowTokens : null;
						} catch {
							win = null;
						}
						body = { version: 1, sessionId: usageSid, ...readSessionUsage(usageFile, win) };
						break;
					}
					const mt = /^\/v1\/sessions\/([^/]+)\/transcript$/.exec(u.pathname);
					if (mt === null) {
						throw new HttpError(404, { error: "not-found", hint: `端点：GET /（静态）| /assets/*（静态）| /v1/health | /v1/snapshot | /v1/events | /v1/attention | /v1/interactions | /v1/timeline | /v1/sessions | /v1/runs | /v1/sessions/:id/transcript；${WS_PATH}（WS）；POST /v1/commands（唯一命令入口）| POST /v1/challenge（本地身份挑战）| POST /v1/bootstrap + GET /v1/bootstrap/exchange（本机 OTT 换 cookie，gui on 限定）| /v1/wechat/{enable,disable} + bind/{start,status,qr-image,cancel} + /v1/wechat/unbind（微信 iLink 绑定与 opt-in 开关）` });
					}
					const sessionId = decodeURIComponent(mt[1]);
					const file = findSessionFile(opts.sessionsDir ?? defaultSessionsDir(), sessionId);
					if (file === null) {
						throw new HttpError(404, { error: "session-not-found", sessionId });
					}
					const afterRaw = u.searchParams.get("after");
					const after = afterRaw !== null && /^\d+$/.test(afterRaw) ? parseInt(afterRaw, 10) : 0;
					// L2 perf（2026-10-20，用户诉求「从最新消息开始读，别一下拉全部」）：
					// `?tail=N` ⇒ 只返回最新 N 行（尾部字节窗投影，不整文件解析）。
					// 缺省（无 tail、after=0）行为**逐字节不变**（全量快照）；after>0 仍是增量，与 tail 互斥。
					const tailRaw = u.searchParams.get("tail");
					const tail = tailRaw !== null && /^[0-9]+$/.test(tailRaw) ? parseInt(tailRaw, 10) : 0;
					const useTail = tail > 0 && after === 0;
					const proj = useTail ? projectSessionTail(file, { rows: tail }) : projectSession(file, after);
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
						// additive（2026-10-20）：tail 模式下的窗口元信息；缺省/全量时不出现在响应里
						...(useTail ? { tail: true as const, hasOlder: (proj as { hasOlder?: boolean }).hasOlder === true } : {}),
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
		respondJson(res, status, body, snapshotEtag);
	};

	return new Promise((resolvePromise, reject) => {
		// §2.2：先取跨进程独占锁，再绑定端口/写账。活 daemon 已持锁 → 本进程直接拒绝启动
		// （防双跑）；交接期 handoff 锁 → 等待后获取。锁失败 = 启动失败（fail-closed）。
		// 不变式：父 ensure 等 host.json 的时长必须 **大于** 本值（ENSURE_READY_WAIT_MS），
		// 否则父会在子仍在等锁时杀掉子（2026-10-23 事故）。
		const lockWaitMs = opts.lockWaitMs ?? DAEMON_LOCK_WAIT_MS;
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
			// B 对账通道接线（唯一接线点）：随 host 生命周期 start/stop；`PI_DELIVERY_RECONCILER=0`
			// ⇒ 零动作不启动。stateDir 与 outbox sweep 同源（状态文件 + 定向唤醒 spool 都在其中）；
			// never-throw：接线失败不炸 host（B 缺席 = 退化为单通道 A，如实可观测）。
			let deliveryReconciler: DeliveryReconcilerLoopHandle | null = null;
			try {
				deliveryReconciler = startDeliveryReconcilerLoop({
					stateDir: outboxStateDirFor(opts),
					...(opts.linksPath !== undefined ? { linksPath: opts.linksPath } : {}),
					log: (msg: string): void => { try { console.error(msg); } catch { /* ignore */ } },
				});
			} catch {
				/* B 接线 never-throw：启动失败不炸 host */
			}
			resolvePromise({
				server,
				info,
				close: async () => {
					// B 对账循环随 host 生命周期停止（先停：不再产生新的对账副作用）
					try {
						deliveryReconciler?.stop();
					} catch {
						/* 停循环 never-throw */
					}
					stopWechatInput();
					stopWechatReply();
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
	createRuntimeHostServer({
		// S2（2026-10-30 owner）：向已死会话发消息时拉起它（新开可见 WT tab）。
		// daemon 是独立 detached 进程（不经 index.ts），所以 spawn 实现必须在此注入。
		spawnSessionTab: defaultSpawnSessionTab,
	})
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
