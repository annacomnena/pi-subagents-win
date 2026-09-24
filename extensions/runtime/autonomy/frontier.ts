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
 *   unconfirmed → resultMissing → 喂 stagnation；orphaned 喂 watchdog 检查 6（collect 装配层取 pidAlive===false）。
 *
 * §25 九条触发规则的 v1 评测范围：
 *   ②③⑤⑨ 实做（对照 prev 的边沿触发）；①（gate awaiting→ok）⑦（timer overdue 0→正）approx 并带 approx 标注；
 *   ④ needs_global / ⑥ risk / ⑧ expected-event 无载体 → record-only，永不进 triggers（红线条款 9：不猜）。
 *
 * meaningful_state_version（§10）：per-project 单调计数，只对九类语义变化 +1（同帧多条去重为 +1）；
 *   age/stale 墙钟文本波动是噪声——本层根本不消费这些展示文本（约束 9：只消费结构化字段），天然不 bump。
 *
 * 快照是派生缓存（C4）：可删；删除/损坏后仅丢失一次 diff 基线，重建回到 baseline 模式自愈，不风暴。
 *   本层绝不反向写 recentwork Status，不是第二进度真相源。
 */
import type { GateStatus, GlobalViewSnapshot, TabDetail } from "../global-view.ts";

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
	| "expected_event_timeout" // ⑧ record-only（无 per-project 期望事件账本，L1A 未决 #2）
	| "stagnation" // ⑨ 实做
	| "ws_mail_backlog"; // 未消费 ws-mail 到信

export interface FrontierTrigger {
	rule: FrontierRule;
	project: string;
	evidence: string;
	approximate: boolean;
}

export type ProjectState = "Working" | "Blocked" | "Completed" | "Failed" | "Cancelled";

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
	/** C5 裁定：unconfirmed → resultMissing → 走 stagnation。 */
	resultMissing: boolean;
	/** ⑨ 载体：非终态 tab staleOver（45min，复用 STALE_NO_PROGRESS_MS 语义）∨ resultMissing。 */
	stagnation: boolean;
	/** ⑦ approx 载体：TabDetail.overdue（repo 级 timer overdue 回填值）。 */
	overdue: number;
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

export interface FrontierInputs {
	snapshot: GlobalViewSnapshot;
	backlog: { recipient: string; pending: number; claimed: number }[];
	prev: FrontierSnapshot | null;
	now: number;
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

type ProjectCore = Omit<ProjectFrontier, "meaningfulStateVersion">;

/** 单 repo 聚合（纯）：只消费 TabDetail/RepoRow 结构化字段，不解析任何展示文本（约束 9）。 */
function aggregateProject(project: string, tabs: TabDetail[], attention: number): ProjectCore {
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
	// ⑨：非终态 staleOver（45min）∨ resultMissing（C5 裁定 unconfirmed 直接喂 stagnation；
	// "resultMissing 超阈值"无独立时基载体 → 实现为 unconfirmed 即 stagnation，见实现报告已知缺口）
	const stagnation = nonTerm.some((t) => t.staleOver) || resultMissing;
	const overdue = tabs.reduce((m, t) => Math.max(m, t.overdue), 0);
	const runs: Record<string, string> = {};
	for (const t of tabs) runs[t.runId] = t.phase;
	return { project, state, variant, gate, runs, needsUser, resultMissing, stagnation, overdue };
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

	// 仓行 attention 索引（home 是 __HOME__ 伪仓，非真实 repo，跳过；rows 为当前页——attention 仓按置顶序在前页，见实现报告）
	const attentionByRepo = new Map<string, number>();
	for (const r of [snapshot.home, ...snapshot.rows]) {
		if (r.repoPath === "__HOME__") continue;
		attentionByRepo.set(normalizeExactPath(r.repoPath), r.attention);
	}

	// 可见 tab 按归一化 repo 分组
	const tabsByRepo = new Map<string, TabDetail[]>();
	for (const d of snapshot.details) {
		const k = normalizeExactPath(d.repoPath);
		const arr = tabsByRepo.get(k);
		if (arr) arr.push(d);
		else tabsByRepo.set(k, [d]);
	}

	const prevByRepo = new Map<string, ProjectFrontier>();
	if (prev) for (const p of prev.projects) prevByRepo.set(p.project, p);

	const nextCores = new Map<string, ProjectCore>();
	for (const [k, tabs] of tabsByRepo) nextCores.set(k, aggregateProject(k, tabs, attentionByRepo.get(k) ?? 0));

	const triggers: FrontierTrigger[] = [];
	// R4：未消费到信（pending>0）是可唤醒的真实输入，不消费/ack 邮件。
	// 以当前 backlog 状态产生 trigger；无到信时不改变任何既有输出。
	for (const mail of inputs.backlog) {
		if (mail.pending > 0) {
			triggers.push({ rule: "ws_mail_backlog", project: `mailbox:${mail.recipient}`, evidence: `pending:${mail.pending}`, approximate: false });
		}
	}
	if (!baseline) {
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
		}
	}

	// meaningful_state_version（§10）：只对本帧有语义变化（任一非 record-only 触发）的项目 +1，同帧去重
	const triggerCountByRepo = new Map<string, number>();
	for (const t of triggers) triggerCountByRepo.set(t.project, (triggerCountByRepo.get(t.project) ?? 0) + 1);

	const projects: ProjectFrontier[] = [];
	for (const key of [...nextCores.keys()].sort()) {
		const core = nextCores.get(key)!;
		const pv = prevByRepo.get(key);
		const version = baseline || !pv ? 1 : pv.meaningfulStateVersion + ((triggerCountByRepo.get(key) ?? 0) > 0 ? 1 : 0);
		projects.push({ ...core, meaningfulStateVersion: version });
	}

	return {
		next: { asof: now, projects, triggers: [...triggers], baseline },
		diff: {
			triggers,
			recordOnly: [...RECORD_ONLY_NOCARRIER],
			meaningfulChanges: triggers.filter((t) => !t.approximate).length,
		},
	};
}
