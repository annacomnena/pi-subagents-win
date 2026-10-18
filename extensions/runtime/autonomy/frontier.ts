/**
 * runtime/autonomy/frontier.ts — Decision Frontier 投影（纯函数，零 IO，不 import node:fs）。
 *
 * Task 2002 · plans/0923_autonomy_suite_v1_plan.md（设计要点 b/d）。规格 §7/§10/§25。
 *
 * 输入（全部只读、可手工构造，测试零 IO）：
 *   - GlobalViewSnapshot（extensions/runtime/global-view.ts collectGlobalView 产物，只读复用）
 *   - mailbox backlog 计数（mailbox.ts mailboxBacklog 产物形状；本层 v1 只透传，不消费）
 *   - 上一份 frontier 快照（null = 首帧基线）
 *
 * C5 映射表（固化在代码与测试 A3）：tab phase（composeTabStatus 产物）→ 项目派生态。
 *   waiting / orphaned / unconfirmed 永不映射为 Completed（永不 terminal）；
 *   unconfirmed → resultMissing（**仅标注缺口，不再直达 stagnation**）；orphaned 喂 watchdog 检查 6
 *   （collect 装配层取 pidAlive===false）。
 *
 * ⑨ stagnation（2026-10-17 监管 P0 重定义，plans/20261017_stagnation_supervision_plan.md §B）：
 *   判据 = 「监管账本 active ∧ phase=waiting ∧ stop=stop ∧ idle > pushMs」，由六态机
 *   `deriveTabSupervisionState` 派生；**没有账本条目 = NOT_MONITORED = 静默**。
 *   旧判据（`nonTerm.some(staleOver) || resultMissing`，resultMissing 无时基直达）零区分度
 *   （实测 3 个项目全 true，其中两个在跑/被用户暂停）→ 已拆除。
 *
 * §25 九条触发规则的 v1 评测范围：
 *   ②③⑤⑨ 实做（对照 prev 的边沿触发）；①（gate awaiting→ok）⑦（timer overdue 0→正）approx 并带 approx 标注；
 *   ④ needs_global / ⑥ risk 无载体 → record-only，永不进 triggers（红线条款 9：不猜）；
 *   ⑧ expected-event（0928 P2 加载）：账本存在时按 **level**（open∧overdue∧未 ack）进 triggers，
 *   账本不存在（inputs.expectations === undefined）→ 维持 record-only(no-carrier)（常量本身不改）。
 *
 * meaningful_state_version（§10）：per-project 单调计数，只对九类语义变化 +1（同帧多条去重为 +1）；
 *   age/stale 墙钟文本波动是噪声——本层根本不消费这些展示文本（约束 9：只消费结构化字段），天然不 bump。
 *
 * 快照是派生缓存（C4）：可删；删除/损坏后仅丢失一次 diff 基线，重建回到 baseline 模式自愈，不风暴。
 *   本层绝不反向写 recentwork Status，不是第二进度真相源。
 */
import type { GateStatus } from "../global-view.ts";

// normalizeExactPath：recent-scopes.ts 的同函数本地副本（双写；_test 的 tripwire 防漂移——
// 同 master-auto "proposalPercent 双写 tripwire" 先例）。本地副本目的：保持本模块依赖图零 node:fs
// （约束 4：推导层不 import node:fs），且与 global-view 内部 aggs 键同一口径（attention 匹配用）。
export function normalizeExactPath(p: string): string {
	let s = p.replace(/\\/g, "/");
	s = s.replace(/^[A-Za-z]:/, (m) => m.toLowerCase());
	s = s.replace(/\/+$/, "");
	return s.toLowerCase();
}

export type FrontierRule =
	| "blocked_to_ready" // ① approx：gate awaiting→ok（"等人"解除视作解除阻塞）
	| "working_to_completed" // ② 实做
	| "working_to_failed" // ③ 实做
	| "needs_global" // ④ record-only（journal 无该语义事件，L1A §3.2）
	| "needs_user" // ⑤ 实做
	| "risk_high" // ⑥ record-only（无 risk 载体）
	| "deadline_urgency" // ⑦ approx：timer overdue 0→正（auto-push timer ≠ 真 deadline，明示近似）
	| "expected_event_timeout" // ⑧（0928 P2）：账本存在时 level 触发；无账本 → record-only(no-carrier)
	| "stagnation" // ⑨ 实做
	| "blocked_overdue" // BLOCKED_USER ∧ idle > userMs（超龄无人处理：周期提醒，节流 ≤1 次/小时/runId）
	| "ws_mail_backlog"; // 未消费 ws-mail 到信

export interface FrontierTrigger {
	rule: FrontierRule;
	project: string;
	evidence: string;
	approximate: boolean;
	/** ⑧（0928 P2 加法）：触发对应的期望主键 + 修订号（wake 级 ack 表按 `<id>:r<rev>` 键）。 */
	requestId?: string;
	requestRev?: number;
	/** blocked_overdue：逾期最重的 runId（节流键；其余规则缺省）。 */
	runId?: string;
}

export type ProjectState = "Working" | "Blocked" | "Completed" | "Failed" | "Cancelled";

/**
 * 监管语义状态（方案 §B.1 六态，每 tick 纯派生 + 账本显式字段；P0 只显示、零推动）。
 *
 *   NOT_MONITORED — runId 不在监管账本 open 集（**静默**：用户没要求监管 ⇒ 不报）
 *   ACTIVE        — 账本 active ∧ (stop=toolUse ∨ idle<SOFT)  【toolUse 豁免在此】
 *   DONE          — 账本 open ∧ 该 runId 已 terminal（不报，等主会话关账）
 *   PAUSED_USER   — 账本显式 status="paused"（用户说"先做别的"时写入）
 *   BLOCKED_USER  — 账本 active ∧ needsHuman ∨ 仓 attention>0（在等人/等决策：提醒但不推动）
 *   STALLED       — 账本 active ∧ phase=waiting ∧ stop=stop ∧ idle∈[PUSH,∞) ∧ 非 BLOCKED/DONE
 */
export type SupervisionState = "NOT_MONITORED" | "ACTIVE" | "PAUSED_USER" | "BLOCKED_USER" | "DONE" | "STALLED";

/** 阈值缺省（方案 §A.1；与 runtime/supervision.ts::SUPERVISION_THRESHOLDS 同源常量，本层零 IO 不得 import 该文件）。 */
export const SUPERVISION_THRESHOLDS = {
	softMs: 5 * 60_000,
	pushMs: 15 * 60_000,
	userMs: 30 * 60_000,
	hangMs: 60 * 60_000,
} as const;

/**
 * blocked_overdue 节流窗（1h；≤1 次/小时/runId，沿用 push 预算纪律）。
 *
 * 语义登记：节流状态**只**落在 frontier 快照的 `blockedOverdueLastAt` 上（派生缓存，C4）。
 * 若 frontier.json 被删/损坏 ⇒ 基线帧重建 ⇒ 节流状态丢失 ⇒ 同一 runId 最多**多提醒一次**
 *（“宁可重发，不可漏发”，与 AGENTS R-5 取舍方向一致；不另立第二真相源）。
 */
export const BLOCKED_OVERDUE_THROTTLE_MS = 3_600_000;

/** 监管输入（collect 只读账本后装配；`undefined` ⟺ 账本目录不存在 ⟺ 全 NOT_MONITORED）。 */
export interface FrontierSupervision {
	runId: string;
	/** 账本持久状态：active | paused。 */
	status: "active" | "paused";
	/** 阈值覆盖（账本可覆盖缺省；P0 不接 config）。 */
	softMs?: number;
	pushMs?: number;
	userMs?: number;
	/** epoch 推动记录条数（P1 才增长；P0 恒 0）。 */
	epochPushes: number;
	/**
	 * 显式静默标记（2026-10-18 默认监管翻转）：true ⇒ 派生 **NOT_MONITORED**（不问不动），
	 * 但条目仍在账本 open/ 集里留档。缺失 = 未静默。
	 */
	optOut?: boolean;
}

/** 项目派生监管字段（进快照供 status/watchdog 显示；权威意图仍在账本）。 */
export interface ProjectSupervision {
	state: SupervisionState;
	/** 该项目最严重 tab 的 idle（ms）；null = 无 idle 载体（无 state.lastActivityAt，不猜）。 */
	idleMs: number | null;
	/** 该项目所有在监管 tab 的 epoch 推动次数合计。 */
	epochPushes: number;
}

export interface ProjectFrontier {
	/** 归一化 repoPath（normalizeExactPath 口径，同 global-view aggs 键）。 */
	project: string;
	/** v1 永不发出 "Blocked"（无阻塞载体，不猜）；Working 含 waiting/orphaned/resultMissing 变体（variant 标注）。 */
	state: ProjectState;
	/** C5 变体标注：waiting | orphaned | resultMissing | null（多 tab 时按 orphaned > resultMissing > waiting 取最严重）。 */
	variant: string | null;
	/** 规则① approx 载体：per-repo recentwork gate（TabDetail.gate 同仓同值）。 */
	gate: GateStatus;
	/** 本帧可见 tab：runId → phase（②③ run 级边沿检测用；含 hidden 回填判别）。 */
	runs: Record<string, string>;
	/** ⑤ 载体：any(tab.needsHuman ∨ tab.gate==="awaiting") ∨ 仓 attention>0（terminal 无 result 可见待审）。 */
	needsUser: boolean;
	/** C5 裁定：unconfirmed → resultMissing（仅标注 result 缺口；2026-10-17 起不再直达 stagnation）。 */
	resultMissing: boolean;
	/**
	 * ⑨ 载体（2026-10-17 监管 P0 重定义）：`supervision.state === "STALLED"`。
	 * 旧语义（`非终态 staleOver(45min) ∨ resultMissing`）已拆除：前者无分级时基、后者与时间无关。
	 */
	stagnation: boolean;
	/**
	 * ⑨b 载体（2026-10-18 G1-1）：存在「监管账本 active ∧ 派生 BLOCKED_USER ∧ idleMs > userMs」的 tab。
	 * 与 `stagnation` **正交**（STALLED vs BLOCKED_USER 互斥）：它回答的是「已卡住并在等人，而且已经
	 * 超龄超过 USER 阈值太久」——周期提醒，不是边沿。
	 */
	blockedOverdue: boolean;
	/**
	 * 本帧**选中要去提醒**的那个 runId（超龄集合里 idle 最重者；供证据/展示）。
	 * 2026-10-18 返工 R1：语义从「节流键」收窄为「本帧候选」——节流账按 runId 记（见 blockedOverdueLastAt）。
	 */
	blockedOverdueRunId?: string;
	/**
	 * 全部满足 BLOCKED_USER ∧ idle>userMs 的 runId（按 idle 降序去重）；无则缺省。
	 * 2026-10-18 返工 R1：项目内多个 tab 可同时超龄，全部收集才能做到 per-runId 节流。
	 */
	blockedOverdueRunIds?: string[];
	/**
	 * blocked_overdue 节流账（runId → 上次提醒时刻 epoch ms；≤1 次/小时/runId）。
	 * 按 runId 而非按项目记：项目内 tab 交替成为「最重」时，各自节流互不覆盖（否则同一 runId
	 * 会在窗内被重复提醒）。只落派生缓存；`frontier.json` 被删 ⇒ 最多多提醒一次（R-5 方向）。
	 */
	blockedOverdueLastAt?: Record<string, number>;
	/** 监管派生态（P0 新增）：state 六态 + idleMs + epoch 推动次数。无账本 = NOT_MONITORED。 */
	supervision: ProjectSupervision;
	/** ⑦ approx 载体：TabDetail.overdue（repo 级 timer overdue 回填值）。 */
	overdue: number;
	/** ⑧ 载体（0928 P2 加法）：该项目全部未关闭超期的期望 id（排序；一 id 一文件，新声明不覆盖旧记录）。 */
	overdueRequests: string[];
	/** §10：只对九类语义变化 +1，噪声不 bump。 */
	meaningfulStateVersion: number;
}

export interface FrontierSnapshot {
	asof: number;
	projects: ProjectFrontier[];
	triggers: FrontierTrigger[];
	/** true = 首帧（prev=null）：只建基线，不算触发，防冷启动风暴。 */
	baseline: boolean;
}

export interface FrontierDiff {
	triggers: FrontierTrigger[];
	recordOnly: string[];
	/** >0 ⇔ 至少一条非 approximate 的真触发（approx 触发计入 diff、标注近似，供 Wake Gate 降级为 no-wake/ordinary）。 */
	meaningfulChanges: number;
}

/**
 * E2.1 结构化输入契约（plans/0924_graph_E2_1_impl_plan.md §3）：graph 派生源可赋值的**最小子集**。
 * `GlobalViewSnapshot` 是它的结构化超集（`details: TabDetail[]` 含本接口全字段；
 * `history: HiddenTabEntry[]` 含 `{id,reason}`）→ v2 调用点零改。
 * 键口径 = `normalizeExactPath`（与 graph `normalizeRepoKey` 逐字节同体，R4 单一口径）；适配器直接
 * 消费已归一 `GraphProjectView.project` 键，本层 `tabsByRepo` 再归一为幂等。
 */
export interface FrontierSourceTab {
	runId: string;
	/** exact-path 归一键（适配器直接用 GraphProjectView.project；buildFrontier 内部再归一幂等）。 */
	repoPath: string;
	phase: string;
	/** 最后一条 assistant 消息的 stopReason（stop | toolUse | length | aborted | error | unknown）。
	 *  2026-10-17 监管 P0：此前只在 TabDetail 上有、未进 carrier ⇒ autonomy 侧看不见
	 *  「正在跑工具 vs 真空闲」，是语义分类缺失的第一刀。 */
	stop: string;
	/** 距最后一次活动（state.lastActivityAt）的毫秒数；null = 无载体（不猜）。
	 *  监管 P0：SOFT/PUSH/USER 分档只能由**结构化时间**派生（旧 staleOver 是 45min 布尔）。 */
	idleMs: number | null;
	needsHuman: boolean;
	gate: GateStatus;
	staleOver: boolean;
	overdue: number;
	/**
	 * 结果缺失：`composeTabStatus().resultMissing` 透传（terminal ∧ resultMissing = 「终态但没结果」待审）。
	 * 2026-10-18 RF-1：监管 DONE 与 BLOCKED_USER 的分界必须由它区分 —— 只看 `phase` 无法区分
	 * 「tab-finish 写了 completed」与「state 自称 completed 但 result.json 不存在」。
	 */
	resultMissing: boolean;
	/** MF3：watchdog 检查 6（autonomy/collect.ts#L153-L154）消费；无 state.pid → null。 */
	pidAlive: boolean | null;
}

export interface FrontierSourceSnapshot {
	/** 全量 attention 投影：归一键、仅 >0 项；缺项=0（G-A 口径，frontier.ts#L201/#L216）。 */
	attentionByRepo: Record<string, number>;
	details: readonly FrontierSourceTab[];
	/** v2 生产恒空（MF1）；适配器恒 emit []。 */
	history: readonly { id: string; reason: string }[];
}

export interface FrontierInputs {
	snapshot: FrontierSourceSnapshot;
	backlog: { recipient: string; pending: number; claimed: number }[];
	prev: FrontierSnapshot | null;
	now: number;
	/**
	 * ⑧ 期望账本输入（0928 P2 加法；collect 装配：只含 **open** 记录，ack 表已并入 noticeAcked）。
	 * `undefined` ⟺ 本进程可见的账本目录不存在 ⟺ 真 no-carrier（recordOnly 维持 3 条）；
	 * `[]`/列表 = 账本存在（recordOnly 降为 2 条，⑧ 已有载体，可进 triggers）。
	 */
	expectations?: readonly FrontierExpectation[];
	/**
	 * 监管账本输入（2026-10-17 监管 P0；collect 装配：只含 **open** 条目）。
	 * `undefined` ⟺ 本进程可见的监管账本目录不存在 ⟺ 全部 NOT_MONITORED（静默，不报）。
	 */
	supervision?: readonly FrontierSupervision[];
}

/** ⑧ 期望输入（纯函数零 IO：collect 读账本后装配）。deadlineAt = epoch ms。 */
export interface FrontierExpectation {
	requestId: string;
	projectKey: string;
	deadlineAt: number;
	/** 本轮 deadline 修订号（ack 表键 `<requestId>:r<rev>`）。 */
	rev: number;
	/** 本条超期 notice 是否已随一次放行的唤醒被处理（r9：wake 级只报一次）。 */
	noticeAcked: boolean;
}

/** ④⑥⑧ 在 v1 无语义载体 → 每帧发出 record-only 标记（永不进 triggers；红线条款 9：不猜）。 */
export const RECORD_ONLY_NOCARRIER: string[] = [
	"needs_global:record-only(no-carrier)",
	"risk_high:record-only(no-carrier)",
	"expected_event_timeout:record-only(no-carrier)",
];

/**
 * C5 映射表（固化）：tab phase（composeTabStatus 产物）→ 项目派生态。
 *   completed → Completed（✔terminal，result 已在：result>state 判链保证）
 *   failed    → Failed（✔terminal）
 *   cancelled → Cancelled（✔terminal）
 *   working / attached / dispatched → Working（✘）
 *   waiting     → Working(waiting)（✘，永不进 Completed；gate=awaiting 时喂 needs_user）
 *   orphaned    → Working(orphaned)（✘，永不进 Completed；喂 watchdog 检查 6）
 *   unconfirmed → Working(resultMissing)（✘，永不进 Completed；C5 裁定走 stagnation）
 *   其余（unknown 等）→ Working 非终态（不在 C5 表 → 不猜，绝不 terminal）
 */
export function mapPhaseToProjectState(phase: string): { state: ProjectState; variant: string | null; terminal: boolean } {
	switch (phase) {
		case "completed":
			return { state: "Completed", variant: null, terminal: true };
		case "failed":
			return { state: "Failed", variant: null, terminal: true };
		case "cancelled":
			return { state: "Cancelled", variant: null, terminal: true };
		case "waiting":
			return { state: "Working", variant: "waiting", terminal: false };
		case "orphaned":
			return { state: "Working", variant: "orphaned", terminal: false };
		case "unconfirmed":
			return { state: "Working", variant: "resultMissing", terminal: false };
		case "working":
		case "attached":
		case "dispatched":
			return { state: "Working", variant: null, terminal: false };
		default:
			return { state: "Working", variant: null, terminal: false };
	}
}

/** 多 tab 变体取最严重：orphaned(0) > resultMissing(1) > waiting(2) > 无(3)（确定性排序）。 */
const VARIANT_RANK: Record<string, number> = { orphaned: 0, resultMissing: 1, waiting: 2 };

/** 项目级六态取最严重（确定性序；数值越小越严重）。 */
const SUPERVISION_RANK: Record<SupervisionState, number> = {
	STALLED: 0,
	BLOCKED_USER: 1,
	PAUSED_USER: 2,
	ACTIVE: 3,
	DONE: 4,
	NOT_MONITORED: 5,
};

/**
 * 单 tab 监管六态派生（纯函数；方案 §B.1 判据逐条可机械检查）。
 *
 * 严格优先级（短路顺序即优先级，无歧义）：
 *   1. 无账本条目                     → NOT_MONITORED（**治今天 3/3 全 true 的关键门**）
 *   1b. 账本 optOut=true              → NOT_MONITORED（用户显式「这个别管」，静默留档）
 *   2. 账本 status="paused"           → PAUSED_USER（用户显式停：不报、不推）
 *   3. 账本 active ∧ phase=unconfirmed ∧ stop≠aborted → BLOCKED_USER（RF-1：未回报，需人核实）
 *   3b. 账本 active ∧ 终态 phase ∧ resultMissing=true → BLOCKED_USER（同上：终态但无结果）
 *   4. 账本 active ∧ 已 terminal      → DONE（提示主会话回收关账，不报停滞）
 *   5. 账本 active ∧ 需人 / attention → BLOCKED_USER（在等人：提醒但不推动）
 *   5b. 账本 active ∧ stop="error"    → BLOCKED_USER（已报错卡死，需人介入重派）
 *   6. 账本 active ∧ stop=toolUse     → ACTIVE（**toolUse 豁免**：在跑长工具，即使 idle 50min）
 *   7. 账本 active ∧ phase=waiting ∧ stop=stop ∧ idle>pushMs → STALLED
 *   8. 其余（working/attached/dispatched / idle 未超线 / idle 无载体）→ ACTIVE（不猜＝不报）
 *
 * 注（方案 §A.2 边角）：phase=waiting ∧ stop=toolUse 落入第 6 条 → ACTIVE（保守，不报停滞）。
 *
 * ## 3 / 3b 的插入位置为何在「DONE 之后之前、toolUse 豁免之前」（2026-10-18 RF-1）
 * - 必须在 2（paused）之后：用户显式暂停优先于一切自动判定（否则暂停的 tab 又被报成待审）。
 * - 必须**在 4（DONE）之前**：DONE 的语义是「已完成，该回收关账」；而「终态但没 result」恰恰
 *   是“不确定是否真完成”。若先判 DONE，就会把『没回报』伪装成『完成』（RF-1 硬约束 1 的反例）。
 * - 必须在 6（toolUse 豁免）之前：豁免的前提是「在跑长工具」，而 terminal/兜底形状已经**不再跑了**；
 *   若排在后面，一个残留 stop=toolUse 的终态 tab 会被豁免成 ACTIVE，需人核实的信号又消失。
 * - `stop==="aborted"` 例外保留在 3 之外：aborted = 用户/上层**主动中断**本回合，"没回报"是预期结果，
 *   不是静默卡死（`_test_runtime_supervision_default_on` 5(d) 已冻结该语义）。
 */
export function deriveTabSupervisionState(input: {
	tab: FrontierSourceTab;
	/** 账本条目；undefined = 该 runId 未被监管。 */
	ledger: FrontierSupervision | undefined;
	/** 仓 attention>0（⑤ 载体，与 needsUser 同口径）。 */
	attention: number;
}): SupervisionState {
	const { tab, ledger, attention } = input;
	if (!ledger) return "NOT_MONITORED";
	// 显式静默（`/supervise optout`）：账本仍留档，但派生面与「未登记」等价（不问不动）。
	if (ledger.optOut === true) return "NOT_MONITORED";
	if (ledger.status === "paused") return "PAUSED_USER";
	// 3) RF-1：兜底结果（tab 回合结束但没 tab-finish）⇒ 不是 DONE、也不是 STALLED，而是「需人核实」。
	// `aborted` 例外：用户/上层主动中断本回合，"没回报"是预期，不是静默卡死（见上方优先级注释）。
	if (tab.phase === "unconfirmed" && tab.stop !== "aborted") return "BLOCKED_USER";
	// 3b) RF-1：终态 phase 但 result.json 缺失 ⇒ 不是 DONE（DONE = 可以回收关账）。
	if (tab.resultMissing === true && mapPhaseToProjectState(tab.phase).terminal) return "BLOCKED_USER";
	if (mapPhaseToProjectState(tab.phase).terminal) return "DONE";
	if (tab.needsHuman || tab.gate === "awaiting" || attention > 0) return "BLOCKED_USER";
	// stop="error" ⇒ BLOCKED_USER（需人介入重派）。**不限定 phase**：真实形状是 `tab.stop=error` 的 tab
	// phase 落在 "unconfirmed"（tab-runs.ts:358-368），只判 `phase==="waiting"` 会漏掉今晚三次卡死的实况。
	// **不得**归 STALLED：它已经报错了，推它没用。`aborted` 明确不并入（用户主动中断，不属静默卡死）。
	if (tab.stop === "error") return "BLOCKED_USER";
	if (tab.stop === "toolUse") return "ACTIVE"; // toolUse 豁免（跑长工具 ≠ 停滞）
	const pushMs =
		typeof ledger.pushMs === "number" && Number.isFinite(ledger.pushMs) && ledger.pushMs > 0
			? ledger.pushMs
			: SUPERVISION_THRESHOLDS.pushMs;
	// idle 无载体（null）→ 不得当作停滞（不猜）
	if (tab.phase === "waiting" && tab.idleMs !== null && Number.isFinite(tab.idleMs) && tab.idleMs > pushMs) return "STALLED";
	return "ACTIVE";
}

type ProjectCore = Omit<ProjectFrontier, "meaningfulStateVersion" | "blockedOverdueLastAt">;

/**
 * 单 repo 聚合（纯）：只消费 FrontierSourceTab 结构化字段，不解析任何展示文本（约束 9）。
 *
 * ⑨ stagnation（2026-10-17 监管 P0 重定义）：= `supervision.state === "STALLED"`。
 * **`resultMissing` 与 `staleOver` 两条旧直达线已全部拆除**（前者与时间无关，后者无分级时基）。
 */
function aggregateProject(
	project: string,
	tabs: FrontierSourceTab[],
	attention: number,
	ledgerByRun: ReadonlyMap<string, FrontierSupervision>,
): ProjectCore {
	const nonTerm = tabs.filter((t) => !mapPhaseToProjectState(t.phase).terminal);
	let state: ProjectState;
	let variant: string | null;
	if (nonTerm.length > 0) {
		state = "Working";
		const variants = nonTerm
			.map((t) => mapPhaseToProjectState(t.phase).variant)
			.filter((v): v is string => v !== null);
		variant = variants.length > 0 ? [...variants].sort((a, b) => (VARIANT_RANK[a] ?? 3) - (VARIANT_RANK[b] ?? 3))[0] : null;
	} else if (tabs.length > 0) {
		// 可见 tab 全 terminal（终态无 result 可见待审）：确定性优先级 Failed > Cancelled > Completed
		state = tabs.some((t) => t.phase === "failed") ? "Failed" : tabs.some((t) => t.phase === "cancelled") ? "Cancelled" : "Completed";
		variant = null;
	} else {
		state = "Working";
		variant = null;
	}
	const gate: GateStatus = tabs.some((t) => t.gate === "awaiting") ? "awaiting" : tabs.some((t) => t.gate === "ok") ? "ok" : "unknown";
	// ⑤ 三载体：TabDetail.needsHuman（含 gate=awaiting 与 classifyForReclaim awaitingInput）∨ 仓 attention>0
	const needsUser = tabs.some((t) => t.needsHuman || t.gate === "awaiting") || attention > 0;
	const resultMissing = tabs.some((t) => t.phase === "unconfirmed");

	// ── 监管派生（六态）──
	let supervision: ProjectSupervision = { state: "NOT_MONITORED", idleMs: null, epochPushes: 0 };
	const states: SupervisionState[] = [];
	let idleMs: number | null = null;
	let epochPushes = 0;
	// ⑨b blocked_overdue：与六态派生**同一处、同一循环**累计（必须复用派生结果，不重写判据）。
	// 2026-10-18 返工 R1：收集**全部**命中 runId（不再只记最重一个），否则节流账无法按 runId 记。
	const odHits: Array<{ runId: string; idleMs: number }> = [];
	for (const t of tabs) {
		const ledger = ledgerByRun.get(t.runId);
		const st = deriveTabSupervisionState({ tab: t, ledger, attention });
		states.push(st);
		if (ledger) epochPushes += Number.isFinite(ledger.epochPushes) ? ledger.epochPushes : 0;
		if (typeof t.idleMs === "number" && Number.isFinite(t.idleMs)) idleMs = idleMs === null ? t.idleMs : Math.max(idleMs, t.idleMs);
		// ⑨b：BLOCKED_USER（在等人）且已超龄 > userMs ⇒ 周期提醒载体（stagnation 管 STALLED，两者互斥）。
		const userMs =
			typeof ledger?.userMs === "number" && Number.isFinite(ledger.userMs) && ledger.userMs > 0
				? ledger.userMs
				: SUPERVISION_THRESHOLDS.userMs;
		if (st === "BLOCKED_USER" && typeof t.idleMs === "number" && Number.isFinite(t.idleMs) && t.idleMs > userMs) {
			odHits.push({ runId: t.runId, idleMs: t.idleMs });
		}
	}
	if (states.length > 0) {
		const worst = [...states].sort((a, b) => SUPERVISION_RANK[a] - SUPERVISION_RANK[b])[0];
		supervision = { state: worst, idleMs, epochPushes };
	}

	// idle 降序 + runId 升序（确定性）：odHits[0] = 最重，作本帧默认候选。
	odHits.sort((a, b) => b.idleMs - a.idleMs || a.runId.localeCompare(b.runId));
	const blockedOverdue = odHits.length > 0;
	const blockedOverdueRunId = odHits[0]?.runId;
	const blockedOverdueRunIds = odHits.length > 0 ? odHits.map((h) => h.runId) : undefined;

	const stagnation = supervision.state === "STALLED";
	const overdue = tabs.reduce((m, t) => Math.max(m, t.overdue), 0);
	const runs: Record<string, string> = {};
	for (const t of tabs) runs[t.runId] = t.phase;
	return {
		project,
		state,
		variant,
		gate,
		runs,
		needsUser,
		resultMissing,
		stagnation,
		blockedOverdue,
		...(blockedOverdueRunId ? { blockedOverdueRunId } : {}),
		...(blockedOverdueRunIds ? { blockedOverdueRunIds } : {}),
		supervision,
		overdue,
		overdueRequests: [],
	};
}

/**
 * 构建下一份 frontier 快照 + 与 prev 的差分（纯）。
 *
 * ②③ 用 run 级边沿（"同一 runId"，计划载体首选）：prev 快照 runs 里的 runId 若本帧仍可见，
 * 直接对照 phase（非终态→completed/failed）；若本帧已不可见（带 result 的终态被 hidden 分流——
 * global-view 只把可见 tab 放进 details），用 history（HiddenTabEntry，结构化 id/reason 字段，
 * 非展示文本）同 id 的 terminal:completed / terminal:failed 回填。cancelled/orphaned/无条目 → 不触发
 *（cancelled 不在九规则；orphaned 喂 watchdog 检查 6）。
 *
 * ①⑤⑦⑨ 用项目级边沿（surviving 项目：消失项目的载体不复存在，不触发）。
 * ④⑥⑧ 永不触发，只在 diff.recordOnly 记 no-carrier 标记。
 * 首帧（prev=null）：baseline=true、零触发；新出现项目 version 起 1。
 */
export function buildFrontier(inputs: FrontierInputs): { next: FrontierSnapshot; diff: FrontierDiff } {
	const { snapshot, prev, now } = inputs;
	const baseline = prev === null;
	const expectations = inputs.expectations;

	// ⑤ 载体：消费快照的「分页前全量投影」（不得读 rows/home——⑤ 触发集合不得是显示排序的函数）
	// 该投影只含 attention>0 仓的条目：**缺项 = 该仓 attention 为 0**；不得把「键存在」当作「仓存在」
	// （仓是否存在由 details/tabsByRepo 决定，与此 map 无关）。
	const attentionByRepo = snapshot.attentionByRepo;

	// 可见 tab 按归一化 repo 分组
	const tabsByRepo = new Map<string, FrontierSourceTab[]>();
	for (const d of snapshot.details) {
		const k = normalizeExactPath(d.repoPath);
		const arr = tabsByRepo.get(k);
		if (arr) arr.push(d);
		else tabsByRepo.set(k, [d]);
	}

	// ⑨ 监管账本索引（P0）：runId → 条目。无账本（undefined）⇒ 空 map ⇒ 全部 NOT_MONITORED。
	const ledgerByRun = new Map<string, FrontierSupervision>();
	for (const s of inputs.supervision ?? []) ledgerByRun.set(s.runId, s);

	const prevByRepo = new Map<string, ProjectFrontier>();
	if (prev) for (const p of prev.projects) prevByRepo.set(p.project, p);

	// ⑧（0928 P2）：超期派生只由显式 now + 未关闭期望决定（overdue ⟺ now > deadlineAt）。
	// 按 projectKey 聚合（一 id 一文件；新声明不写任何既有记录 → 同项目并行请求互不覆盖）。
	const overdueByProject = new Map<string, string[]>();
	if (expectations) {
		for (const e of expectations) {
			if (!Number.isFinite(e.deadlineAt) || !(now > e.deadlineAt)) continue;
			const arr = overdueByProject.get(e.projectKey);
			if (arr) arr.push(e.requestId);
			else overdueByProject.set(e.projectKey, [e.requestId]);
		}
		for (const ids of overdueByProject.values()) ids.sort();
	}

	const nextCores = new Map<string, ProjectCore>();
	for (const [k, tabs] of tabsByRepo) nextCores.set(k, aggregateProject(k, tabs, attentionByRepo[k] ?? 0, ledgerByRun));

	const triggers: FrontierTrigger[] = [];
	// ⑨b blocked_overdue 本帧已发射（project → 本帧发射的 runId；用于把节流账落到 next.projects）。
	const blockedOverdueEmitted = new Map<string, string>();
	// R4：未消费到信（pending>0）是可唤醒的真实输入，不消费/ack 邮件。
	// 以当前 backlog 状态产生 trigger；无到信时不改变任何既有输出。
	for (const mail of inputs.backlog) {
		if (mail.pending > 0) {
			triggers.push({ rule: "ws_mail_backlog", project: `mailbox:${mail.recipient}`, evidence: `pending:${mail.pending}`, approximate: false });
		}
	}
	if (!baseline) {
		// ⑧ level 触发（0928 P2）：未 ack 就每帧重出（cooldown 窗内 gate 判 no-wake 但 audit 仍落行，
		// 窗口结束后下一帧触发仍在 → 照常放行 → ack → 停止 → 边沿不丢）；baseline 帧压制全部触发
		//（重启回放 r10：frontier.json 丢失 → 首帧 baseline → 下一帧补发，延迟 ≤1 tick）。
		if (expectations) {
			for (const e of [...expectations].sort((a, b) => a.requestId.localeCompare(b.requestId))) {
				if (!Number.isFinite(e.deadlineAt) || !(now > e.deadlineAt)) continue;
				if (e.noticeAcked) continue; // wake 级只报一次（r9）；attention 条目仍在（level 出口）
				triggers.push({
					rule: "expected_event_timeout",
					project: e.projectKey,
					evidence: `request:${e.requestId}:deadline=${new Date(e.deadlineAt).toISOString()} now=${new Date(now).toISOString()}`,
					approximate: false,
					requestId: e.requestId,
					requestRev: e.rev,
				});
			}
		}
		const prevKeys = [...prevByRepo.keys()].sort();
		for (const key of prevKeys) {
			const pv = prevByRepo.get(key)!;
			const cur = nextCores.get(key);
			// ②③：run 级 phase 边沿（非终态 → completed / failed）
			for (const [runId, prevPhase] of Object.entries(pv.runs)) {
				if (mapPhaseToProjectState(prevPhase).terminal) continue;
				const nextPhase = cur ? cur.runs[runId] : undefined;
				if (nextPhase !== undefined) {
					if (nextPhase === "completed") {
						triggers.push({ rule: "working_to_completed", project: key, evidence: `run:${runId}:${prevPhase}→completed`, approximate: false });
					} else if (nextPhase === "failed") {
						triggers.push({ rule: "working_to_failed", project: key, evidence: `run:${runId}:${prevPhase}→failed`, approximate: false });
					}
				} else {
					// run 已 hidden：history 同 id 回填（结构化字段；terminal:cancelled/orphaned/无 → 不触发）
					const h = snapshot.history.find((e) => e.id === runId);
					if (h?.reason === "terminal:completed") {
						triggers.push({ rule: "working_to_completed", project: key, evidence: `run:${runId}:hidden:terminal:completed`, approximate: false });
					} else if (h?.reason === "terminal:failed") {
						triggers.push({ rule: "working_to_failed", project: key, evidence: `run:${runId}:hidden:terminal:failed`, approximate: false });
					}
				}
			}
			if (!cur) continue;
			// ① approx：gate awaiting→ok（"等人"解除视作解除阻塞；审计行带 approx 标注）
			if (pv.gate === "awaiting" && cur.gate === "ok") {
				triggers.push({ rule: "blocked_to_ready", project: key, evidence: "gate:awaiting→ok approx=gate-transition", approximate: true });
			}
			// ⑤：needs_user false→true 边沿
			if (!pv.needsUser && cur.needsUser) {
				triggers.push({ rule: "needs_user", project: key, evidence: "needsUser:false→true", approximate: false });
			}
			// ⑦ approx：timer overdue 0→正（auto-push timer ≠ 真 deadline，明示近似）
			if (pv.overdue === 0 && cur.overdue > 0) {
				triggers.push({ rule: "deadline_urgency", project: key, evidence: `overdue:0→${cur.overdue} approx=timer-overdue`, approximate: true });
			}
			// ⑨：stagnation false→true 边沿
			if (!pv.stagnation && cur.stagnation) {
				triggers.push({ rule: "stagnation", project: key, evidence: "stagnation:false→true", approximate: false });
			}
			// ⑨b blocked_overdue（level + 1h/runId 节流；基线帧同样压制）。
			// 与 ⑨ 正交：⑨ 管 STALLED，本规则管「BLOCKED_USER 且超龄 > userMs」——原来的永久静默区。
			// 证据里的 idle 取**该 runId 自身**的 idle（不是项目 max），否则会把“别的 tab 停得久”当成本 tab 的逾期度。
			// 2026-10-18 返工 R1：**per-runId** 节流 —— 遍历本帧全部超龄 runId，跳过各自窗内的，
			// 每项目每帧最多发 1 条（沿用既有形状，防一次刷屏）。按 runId 而非按「当前最重」判窗，
			// 否则项目内两个 tab 交替成为最重时，同一 runId 会在 1h 窗内被重复提醒。
			if (cur.blockedOverdue && cur.blockedOverdueRunIds && cur.blockedOverdueRunIds.length > 0) {
				const prevLedger =
					pv.blockedOverdueLastAt && typeof pv.blockedOverdueLastAt === "object" ? pv.blockedOverdueLastAt : {};
				for (const rid of cur.blockedOverdueRunIds) {
					const last = prevLedger[rid];
					if (typeof last === "number" && Number.isFinite(last) && now - last < BLOCKED_OVERDUE_THROTTLE_MS) continue; // 该 runId 窗内
					const odTab = (tabsByRepo.get(key) ?? []).find((t) => t.runId === rid);
					const odIdleMs =
						odTab && typeof odTab.idleMs === "number" && Number.isFinite(odTab.idleMs) ? odTab.idleMs : (cur.supervision.idleMs ?? 0);
					const idleMin = Math.max(0, Math.round(odIdleMs / 60_000));
					triggers.push({
						rule: "blocked_overdue",
						project: key,
						evidence: `blocked_overdue:run=${rid}:idleMin=${idleMin}`,
						approximate: false,
						runId: rid,
					});
					blockedOverdueEmitted.set(key, rid);
					break; // 每项目每帧最多 1 条
				}
			}
		}
	}

	// meaningful_state_version（§10）：只对本帧有语义变化的项目 +1，同帧去重。
	// ⑧ level 重复触发**不逐帧 bump**（只对「该项目 overdue id 集合相对 prev 有新增」+1）。
	const triggerCountByRepo = new Map<string, number>();
	for (const t of triggers) {
		if (t.rule === "expected_event_timeout") continue;
		triggerCountByRepo.set(t.project, (triggerCountByRepo.get(t.project) ?? 0) + 1);
	}
	const prevOverdueByRepo = new Map<string, Set<string>>();
	if (prev) {
		for (const p of prev.projects) {
			if (p.overdueRequests && p.overdueRequests.length > 0) prevOverdueByRepo.set(p.project, new Set(p.overdueRequests));
		}
	}

	const projects: ProjectFrontier[] = [];
	for (const key of [...nextCores.keys()].sort()) {
		const core = nextCores.get(key)!;
		const pv = prevByRepo.get(key);
		const overdueIds = overdueByProject.get(key) ?? [];
		const prevIds = prevOverdueByRepo.get(key);
		const newOverdue = prevIds ? overdueIds.some((id) => !prevIds.has(id)) : overdueIds.length > 0;
		const version =
			baseline || !pv
				? 1
				: pv.meaningfulStateVersion + ((triggerCountByRepo.get(key) ?? 0) > 0 || newOverdue ? 1 : 0);
		// ⑨b 节流账（per-runId，只落在这份派生缓存上；frontier.json 被删 ⇒ 最多多提醒一次）。
		// 本帧发射的那个 runId 记 now；其余**沿用 prev**；只保留「仍在本帧超龄集合里」的键
		// （tab 恢复/终态/被静默后自动出账，账本不无界增长）。
		// 与 spec §3.1.6 的字面差异（未发射且 prev 无记录 ⇒ 不预置 now）见 plans/20261018_group1_impl.md §7 D1：
		//   预置 now 会把「首次发现」自己静默 1h（漏发）；这里不预置 ⇒ 下帧必发，不可能风暴也不可能漏发。
		const emittedRid = blockedOverdueEmitted.get(key);
		const prevLedger =
			pv && pv.blockedOverdueLastAt && typeof pv.blockedOverdueLastAt === "object" ? pv.blockedOverdueLastAt : undefined;
		let nextLedger: Record<string, number> | undefined;
		const keep = new Set(Array.isArray(core.blockedOverdueRunIds) ? core.blockedOverdueRunIds : []);
		for (const [rid, ts] of Object.entries(prevLedger ?? {})) {
			if (!keep.has(rid)) continue;
			if (typeof ts !== "number" || !Number.isFinite(ts)) continue;
			(nextLedger ??= {})[rid] = ts;
		}
		if (emittedRid) (nextLedger ??= {})[emittedRid] = now;
		projects.push({
			...core,
			overdueRequests: overdueIds,
			...(nextLedger && Object.keys(nextLedger).length > 0 ? { blockedOverdueLastAt: nextLedger } : {}),
			meaningfulStateVersion: version,
		});
	}

	return {
		next: { asof: now, projects, triggers: [...triggers], baseline },
		diff: {
			triggers,
			// ⑧ 条件化（语义诚实而非测试规避）：「no-carrier」的定义就是「本进程可见的账本不存在」。
			// RECORD_ONLY_NOCARRIER 常量本身不改（既有逐字断言继续成立）；纯函数直调不传字段 = 3 条。
			recordOnly:
				expectations === undefined
					? [...RECORD_ONLY_NOCARRIER]
					: RECORD_ONLY_NOCARRIER.filter((r) => !r.startsWith("expected_event_timeout:")),
			meaningfulChanges: triggers.filter((t) => !t.approximate).length,
		},
	};
}
