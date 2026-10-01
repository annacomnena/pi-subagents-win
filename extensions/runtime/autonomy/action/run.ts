/**
 * runtime/autonomy/action/run.ts — 可回滚动作编排（P1 harness 总入口；never-throw 总包裹）。
 *
 * 装配设计 §1.2 决策树（policy.decide，纯）+ 事务包裹（attempted → 快照 → precheck →
 * TOCTOU 复验 → effect → executed → postverify →（失配则 rollback + reverify）→ settle），
 * 全程落 actions.jsonl（ledger），熔断/预算经 breaker.json（fail-closed）。
 *
 * 语义纪律：
 *  - **默认关闭零行为**：`actions.enabled !== true` ⇒ 除一次 config 读外**零 IO、零新文件**。
 *    独立于 `autonomy.enabled`（双层合取：本模块只认 `autonomy.actions` 切片）。
 *  - **fail-closed**：动作面任何 unknown / 读失败 / 异常 ⇒ 拒绝（区别于 wake 面 fail-open）。
 *  - **不触碰 audit.jsonl**：动作事件只进 actions.jsonl（W5/W6 冻结面一字不动）。
 *  - **TOCTOU 最后入口复核**（§1.2 执行段 / approval-gate 承接）：effect 前重验 L0–L3，
 *    含 frontier 快照 mtime 时效（越过 2 tick ⇒ SKIP(stale)）。
 *
 * 只写自有 namespace `<stateDir>/autonomy/actions/**`（reports/ + snaps/ + breaker.json + actions.jsonl）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultRuntimeDir } from "../../journal.ts";
import { masterAddress } from "../../address.ts";
import { readAttachment } from "../../registry.ts";
import { readAutonomyConfig } from "../config.ts";
import { readKillSwitch } from "../kill-switch.ts";
import { readFrontierSnapshot } from "../collect.ts";
import type { FrontierSnapshot, FrontierTrigger } from "../frontier.ts";
import { BUDGET, TRIGGER_ALLOWLIST, decide, type PolicyContext } from "./policy.ts";
import {
	checkBudget,
	clearBreaker,
	dedupHit,
	readBreaker,
	recordFailure,
	recordStart,
	recordSuccess,
	tripBreaker,
	writeBreaker,
} from "./breaker.ts";
import {
	POLICY_VERSION,
	appendActionEvent,
	readActionsTail,
	readActionEvents,
	type ActionEvent,
	type ActionKind,
} from "./ledger.ts";
import { discoverRepoRoot, gitPostcheck, gitPrecheck } from "./gitguard.ts";
import { diagnosticReportClass } from "./classes/report.ts";

export interface RunActionsOpts {
	stateDir?: string;
	configPath?: string;
	sessionId: string | undefined;
	/** fake clock（毫秒，测试用；缺省 Date.now()）。 */
	now?: number;
	/** git 纪律检查的目标仓根（§A ③ / §6.3）；缺省 = 自动发现（`git rev-parse --show-toplevel`，
	 *  cwd = 进程 cwd）；发现失败 / `git status` 读失败 ⇒ fail-closed DENY（「读不到 = 拒绝」）。
	 *  调用方（wake.ts）无需显式传。 */
	repoRoot?: string;
}

function sd(stateDir?: string): string {
	return stateDir ?? join(defaultRuntimeDir(), "state");
}

function actionsDir(stateDir?: string): string {
	return join(sd(stateDir), "autonomy", "actions");
}

/** tick 标识（30s 一格；newPerTick 跨 tick 重置）。 */
function tickIdOf(now: number): string {
	return String(Math.floor(now / BUDGET.tickMs));
}

function newActionId(now: number): string {
	// 冒号（ISO 时间）在 Windows 路径非法——用 - 替代，保证 id 可作快照目录名（§A 路径安全）。
	const ts = new Date(now).toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "Z");
	return `act_${ts}_${Math.random().toString(36).slice(2, 6)}`;
}

export type RunOneOutcome = "started" | "denied" | "skipped";

/**
 * 动作面总入口（never-throw 总包裹）。
 * `actions.enabled !== true` ⇒ 除一次 config 读外零 IO、零新文件（默认关闭零行为）。
 */
export function runAutonomyActions(opts: RunActionsOpts): void {
	try {
		const cfg = readAutonomyConfig({ configPath: opts.configPath });
		if (cfg.enabled !== true || cfg.actions?.enabled !== true) return; // 双层合取；任一未严格开启即零行为

		const now = opts.now ?? Date.now();
		const stateDir = opts.stateDir;

		// 读 frontier 快照（不重算、不改 gate 签名；只消费已落盘快照）
		const snap = readFrontierSnapshot({ stateDir });
		if (!snap) return; // 无快照 → 无触发 → 无动作

		// 候选触发（allowlist 内；§4）
		const candidates = snap.triggers.filter((t) => TRIGGER_ALLOWLIST.has(t.rule));
		if (candidates.length === 0) return;

		const ctx: RunActionsOpts & { now: number; frontier: FrontierSnapshot } = { ...opts, now, frontier: snap };
		for (const t of candidates) {
			const outcome = runOneAction(t, ctx);
			if (outcome === "started") break; // 每 tick 最多 1 个新动作（budget）达成
			// denied / skipped → 继续下一候选（其自身判据独立）
		}
	} catch {
		/* never-throw 总包裹：动作面任何异常不得影响唤醒循环 */
	}
}

interface RunOneCtx {
	stateDir?: string;
	configPath?: string;
	sessionId: string | undefined;
	now: number;
	repoRoot?: string;
	frontier: FrontierSnapshot;
}

/**
 * 执行单个动作（事务包裹；never-throw）。返回 started（占 1/tick 额度）/ denied / skipped。
 */
function runOneAction(t: FrontierTrigger, ctx: RunOneCtx): RunOneOutcome {
	const { now, sessionId, frontier } = ctx;
	const stateDir = ctx.stateDir;
	const id = newActionId(now);
	const tickId = tickIdOf(now);
	const actionClass = diagnosticReportClass.name;
	const failKey = `${t.rule}:${actionClass}:${t.project}`; // 连败三元组
	const dedupKey = `${t.rule}:${t.project}`; // 去重键
	const triggerRef = { rule: t.rule, project: t.project, evidence: t.evidence, approximate: t.approximate };

	const emit = (kind: ActionKind, extra?: Partial<ActionEvent>): boolean => {
		return appendActionEvent(
			{
				v: 1, id, kind, ts: new Date(now).toISOString(), policyVersion: POLICY_VERSION,
				trigger: triggerRef, actionClass, ...extra,
			},
			stateDir,
		);
	};

	// ── L0 fail-closed 读 ──
	const kill = readKillSwitch({ stateDir });
	const breaker = readBreaker(stateDir); // null = 读不到 → DENY(breaker-unreadable)
	const attachment = readAttachment(masterAddress());
	const isOwner = sessionId !== undefined && attachment !== null && sessionId === attachment.sessionId;

	if (breaker === null) {
		emit("rejected", { reason: "breaker-unreadable" });
		return "denied";
	}

	// ── L3 预算/去重预检（供 policy）──
	const budget = checkBudget(breaker, tickId, now);
	const consec = breaker.consecFail[failKey] ?? 0;
	const dedup = dedupHit(breaker, dedupKey, now);

	// ── 效应面注册 + 目录前缀（§A ① 文件夹分好）──
	const root = sd(stateDir);
	const targetPath = diagnosticReportClass.targetPath(root, t.project, now);
	const closure = diagnosticReportClass.withinSurface(root, targetPath);

	// ── L0–L3 决策树（第一遍）──
	// P1 报告类的 snapshot/rollback/postverify/lease 为结构保证（注册即成立）；
	// 实际快照在 effect 前生成，若失败则在下方转 rejected(no-snapshot)。
	const pctx: PolicyContext = {
		actionsEnabled: true, // 已在 runAutonomyActions 门确认
		killPresent: kill !== null,
		breakerReadable: true, // 已确认非 null
		breakerTripped: breaker.tripped || breaker.frozen,
		isOwner,
		trigger: triggerRef,
		actionClass,
		closure,
		snapshot: true,
		rollback: true,
		postverify: true,
		lease: true,
		inFlight: breaker.inFlight,
		newThisTick: budget.newThisTick,
		startedInLast1h: budget.startedInLast1h,
		consecutiveFailures: consec,
		dedupHit: dedup,
	};
	const verdict = decide(pctx);
	if (verdict.kind === "SKIP") {
		emit("skipped", { reason: verdict.reason });
		return "skipped";
	}
	if (verdict.kind === "DENY") {
		emit("rejected", { reason: verdict.reason });
		return "denied";
	}
	if (verdict.kind === "HUMAN") {
		return "skipped"; // HUMAN 仅上层呈现，非许可（P1 无 HUMAN 出口）
	}

	// ── git 纪律前置（§A ③ / §6.3）：默认路径自动发现仓根；读不到 = fail-closed DENY ──
	// repoRoot 缺省时 `git rev-parse --show-toplevel`（cwd = 进程 cwd）自动发现；
	// 发现失败 / `git status` 读失败 ⇒ DENY（§6.3「读不到 = 拒绝」；调用方无需显式传）。
	const repoRoot = ctx.repoRoot ?? discoverRepoRoot();
	let gitBaseline: string[] | null = null;
	if (repoRoot) {
		const pre = gitPrecheck(repoRoot, { tracked: false }); // P1 报告 = untracked/仓外
		if (!pre.ok) {
			emit("rejected", { reason: `git-pre:${pre.reason}` });
			return "denied";
		}
		gitBaseline = pre.baseline ?? null;
	} else {
		// 发现失败 = 读不到 git 仓 = fail-closed DENY（§6.3）
		emit("rejected", { reason: "git-repo-not-found(fail-closed)" });
		return "denied";
	}

	// ── 事务开始（fail-closed：账本写不进 = 审计无法保证 ⇒ 拒绝，不留无审计的动作）──
	if (!emit("attempted", { intent: `collect ${t.rule} evidence for ${t.project}` })) {
		return "denied";
	}

	// 快照（原字节/权限/存在性）→ 落盘为回退句柄数据源
	const snapFile = diagnosticReportClass.snapshot(targetPath);
	if (snapFile === null) {
		emit("rejected", { reason: "no-snapshot" });
		return "denied";
	}
	const snapRef = storeSnapshot(id, snapFile, stateDir);
	if (!snapRef) {
		emit("rejected", { reason: "snapshot-store-failed" });
		return "denied";
	}

	// precheck（记录 L0–L3 实际逐项判定；任一项 unknown/读失败已在上面转 rejected）
	emit("precheck", {
		precheck: {
			L0: { actionsEnabled: true, kill: kill === null, breakerReadable: true, breakerTripped: breaker.tripped || breaker.frozen, owner: isOwner },
			L1: { triggerAllowed: TRIGGER_ALLOWLIST.has(t.rule), classAllowed: true, notApproximate: !t.approximate },
			L2: { closure, snapshot: true, rollback: true, postverify: true, lease: true, snapshotRef: snapRef, effectPath: targetPath },
			L3: { inFlight: breaker.inFlight, newThisTick: budget.newThisTick, startedInLast1h: budget.startedInLast1h, consecFail: consec, dedupHit: dedup },
		},
	});

	// ── TOCTOU 最后入口复核（effect 前重验 L0–L3；§1.2 执行段）──
	const recheck = toctouRecheck(ctx, tickId, now, stateDir, targetPath);
	if (!recheck.ok) {
		emit(recheck.kind === "stale" ? "skipped" : "rejected", { reason: recheck.reason });
		return recheck.kind === "stale" ? "skipped" : "denied";
	}

	// ── 占额度（recordStart；失败尝试也占）──
	writeBreaker(recordStart(readBreaker(stateDir) ?? breaker, tickId, now, dedupKey), stateDir);

	// ── effect（原子写）──
	const content = buildReportContent(t, ctx);
	const eff = diagnosticReportClass.effect(targetPath, content);
	if (eff === null) {
		const b = readBreaker(stateDir) ?? breaker;
		writeBreaker(recordFailure(b, failKey, now), stateDir);
		emit("rejected", { reason: "effect-failed" });
		return "started";
	}

	// §A ② 只增不删：effect 删除清单非空 = 违规 → 立即熔断 + 冻结
	if (eff.deletedFiles.length > 0) {
		const b = readBreaker(stateDir) ?? breaker;
		writeBreaker(tripBreaker({ ...b, inFlight: Math.max(0, b.inFlight - 1) }, now), stateDir);
		emit("frozen", { reason: `delete-violation:${eff.deletedFiles.join(",")}` });
		return "started";
	}

	emit("executed", {
		effect: { paths: [targetPath], bytes: eff.bytes },
		// 回退句柄入账（§3.2）：快照引用 + 本次删除清单（P1 恒空；非空已在上面熔断）
		rollbackHandle: { type: "restore-files", snapshots: [snapRef], validUntil: null, deletedFiles: eff.deletedFiles },
	});

	// ── postverify（回读比对）──
	const pv = diagnosticReportClass.postverify(targetPath, content);
	if (pv !== "match") {
		// 失配 → 回退 + 复验
		const rb = diagnosticReportClass.rollback(snapFile);
		if (!rb.ok) {
			const b = readBreaker(stateDir) ?? breaker;
			writeBreaker(tripBreaker({ ...b, inFlight: Math.max(0, b.inFlight - 1) }, now), stateDir);
			emit("rollback_failed", { reason: rb.reason ?? "rollback-failed" });
			emit("frozen", { reason: "rollback-failed" });
			return "started";
		}
		// 回退后复验：应与快照一致（存在 → 字节相等；不存在 → 确实不存在）
		const reverifyOk = snapFile.existed
			? snapFile.bytes !== null && diagnosticReportClass.postverify(targetPath, snapFile.bytes.toString("utf8")) === "match"
			: !existsSync(targetPath);
		if (!reverifyOk) {
			const b = readBreaker(stateDir) ?? breaker;
			writeBreaker(tripBreaker({ ...b, inFlight: Math.max(0, b.inFlight - 1) }, now), stateDir);
			emit("frozen", { reason: "reverify-after-rollback-failed" });
			return "started";
		}
		const b = readBreaker(stateDir) ?? breaker;
		writeBreaker(recordFailure(b, failKey, now), stateDir);
		emit("rolled_back", { postverify: { result: pv, detail: "mismatch→rollback+reverify" } });
		return "started";
	}

	// ── git 纪律后置（§A ③）：untracked ⇒ porcelain 逐项一致 ──
	if (repoRoot && gitBaseline !== null) {
		const post = gitPostcheck(repoRoot, gitBaseline, { tracked: false });
		if (!post.ok) {
			// 越界/新增 git 条目 = 违规 → 回退 + 熔断 + 冻结（越界清单落账本）
			diagnosticReportClass.rollback(snapFile);
			const b = readBreaker(stateDir) ?? breaker;
			writeBreaker(tripBreaker({ ...b, inFlight: Math.max(0, b.inFlight - 1) }, now), stateDir);
			emit("rollback_failed", { reason: `git-post:${post.reason}:${(post.newEntries ?? []).join("|")}` });
			emit("frozen", { reason: `git-post-violation` });
			return "started";
		}
	}

	// ── 成功：postverified + 释放 in-flight + 重置连败 ──
	const b = readBreaker(stateDir) ?? breaker;
	writeBreaker(recordSuccess(b, failKey, now), stateDir);
	emit("postverified", { postverify: { result: "match" } });
	return "started";
}

/**
 * TOCTOU 最后入口复核（effect 前；§1.2 执行段 / approval-gate 承接）。
 * ① frontier 快照 mtime 时效（越过 2 tick ⇒ stale）；② 复读 breaker（熔断态变化 ⇒ race）；
 * ③ 预算复验（并发启动 ⇒ 超在途）。任一失配 → 不执行。
 */
function toctouRecheck(
	ctx: RunOneCtx,
	tickId: string,
	now: number,
	stateDir: string | undefined,
	targetPath: string,
): { ok: boolean; kind?: "stale" | "deny"; reason: string } {
	// ① frontier 快照时效：重读快照，now - asof 越过 2 tick ⇒ stale（asof = 快照逻辑时间，可测）
	const snap = readFrontierSnapshot({ stateDir });
	if (!snap || now - snap.asof > BUDGET.staleTicks * BUDGET.tickMs) {
		return { ok: false, kind: "stale", reason: "stale(frontier>2tick)" };
	}
	// ② 目录前缀复验（§A ① 文件夹分好；effect 路径越界 = namespace-escape，TOCTOU 也查）
	const root = sd(stateDir);
	if (!diagnosticReportClass.withinSurface(root, targetPath)) {
		return { ok: false, kind: "deny", reason: "race-detected(namespace-escape)" };
	}
	const b = readBreaker(stateDir);
	if (b === null) return { ok: false, kind: "deny", reason: "race-detected(breaker-unreadable)" };
	if (b.tripped || b.frozen) return { ok: false, kind: "deny", reason: "race-detected(breaker-tripped)" };
	const budget = checkBudget(b, tickId, now);
	if (!budget.ok) return { ok: false, kind: "deny", reason: `race-detected(${budget.reason})` };
	return { ok: true, reason: "" };
}

/** 快照落盘为回退句柄数据源（`actions/snaps/<id>/`）；返回快照目录 ref（失败 = null）。 */
function storeSnapshot(id: string, snap: { path: string; existed: boolean; mode: number | null; bytes: Buffer | null }, stateDir?: string): string | null {
	try {
		const dir = join(actionsDir(stateDir), "snaps", id);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "meta.json"), JSON.stringify({ path: snap.path, existed: snap.existed, mode: snap.mode }));
		if (snap.existed && snap.bytes) writeFileSync(join(dir, "bytes.bin"), snap.bytes);
		return dir;
	} catch {
		return null;
	}
}

/** 报告内容（汇总失败/停滞证据：trigger + frontier 项目态 + 只读定性）。 */
function buildReportContent(t: FrontierTrigger, ctx: RunOneCtx): string {
	const project = ctx.frontier.projects.find((p) => p.project === t.project);
	const lines: string[] = [
		"# Autonomy Diagnostic Report",
		"",
		`> 自动生成的**只读**诊断报告（autonomy 动作面，policyVersion=${POLICY_VERSION}）。`,
		"> 学术诚实：本报告只记录观察，**不触发**任何修复 / 重试 / 派活。",
		"",
		`- **trigger**: \`${t.rule}\``,
		`- **project**: \`${t.project}\``,
		`- **evidence**: ${t.evidence}`,
		`- **approximate**: ${t.approximate}`,
		`- **generated_at**: ${new Date(ctx.now).toISOString()}`,
		"",
	];
	if (project) {
		lines.push("## 项目状态（frontier 快照）");
		lines.push(`- state: ${project.state}${project.variant ? ` (${project.variant})` : ""}`);
		lines.push(`- needs_user: ${project.needsUser}`);
		lines.push(`- stagnation: ${project.stagnation}`);
		lines.push(`- result_missing: ${project.resultMissing}`);
		lines.push(`- visible_runs: ${Object.keys(project.runs).length}`);
		lines.push("");
	}
	lines.push("_（无更多可安全自动化的处置；后续动作需人裁决。）_");
	return lines.join("\n");
}

// ── 对外测试/运维入口 ────────────────────────────────────────────────────

/**
 * 动作级回退（演练 A / 回放「能不能撤」）：按 id 找回退句柄（快照）→ 恢复原字节/权限/存在性
 * → 账本落 rolled_back；失败 → rollback_failed + 熔断 + 冻结。never-throw。
 */
export function undoAction(id: string, opts: { stateDir?: string; now?: number }): { ok: boolean; reason?: string } {
	const now = opts.now ?? Date.now();
	const stateDir = opts.stateDir;
	const events = readActionEvents(id, { stateDir });
	const triggerRef = events[0]?.trigger ?? { rule: "?", project: "?", evidence: "?", approximate: false };
	const actionClass = events[0]?.actionClass ?? "diagnostic-report";

	const emit = (kind: ActionKind, reason?: string): void => {
		appendActionEvent(
			{ v: 1, id, kind, ts: new Date(now).toISOString(), policyVersion: POLICY_VERSION, trigger: triggerRef, actionClass, reason },
			stateDir,
		);
	};

	// 找回退句柄（precheck.L2.snapshotRef）
	const withSnap = events.find((e) => e.precheck && typeof (e.precheck as Record<string, any>).L2?.snapshotRef === "string");
	const snapRef = withSnap ? ((withSnap.precheck as Record<string, any>).L2.snapshotRef as string) : null;
	if (!snapRef) {
		// 无快照 = 无法保证可撤 → 如实报 + 熔断（不猜）
		const b = readBreaker(stateDir);
		if (b) writeBreaker(tripBreaker(b, now), stateDir);
		emit("rollback_failed", "no-snapshot-handle");
		emit("frozen", "no-snapshot-handle");
		return { ok: false, reason: "no-snapshot-handle" };
	}

	// 读快照
	let meta: { path: string; existed: boolean; mode: number | null } | null = null;
	try {
		meta = JSON.parse(readFileSync(join(snapRef, "meta.json"), "utf8"));
	} catch {
		meta = null;
	}
	if (!meta || typeof meta.path !== "string") {
		const b = readBreaker(stateDir);
		if (b) writeBreaker(tripBreaker(b, now), stateDir);
		emit("rollback_failed", "snapshot-meta-unreadable");
		emit("frozen", "snapshot-meta-unreadable");
		return { ok: false, reason: "snapshot-meta-unreadable" };
	}
	let bytes: Buffer | null = null;
	if (meta.existed) {
		try {
			bytes = readFileSync(join(snapRef, "bytes.bin"));
		} catch {
			bytes = null;
		}
	}
	const rb = diagnosticReportClass.rollback({ path: meta.path, existed: meta.existed, mode: meta.mode, bytes });
	if (!rb.ok) {
		const b = readBreaker(stateDir);
		if (b) writeBreaker(tripBreaker(b, now), stateDir);
		emit("rollback_failed", rb.reason ?? "rollback-failed");
		emit("frozen", "undo-rollback-failed");
		return { ok: false, reason: rb.reason ?? "rollback-failed" };
	}
	emit("rolled_back", "undo");
	return { ok: true };
}

/** 人工解冻（clear 熔断；非 autonomy 自主，由人执行）。 */
export function clearActionsBreaker(opts: { stateDir?: string; now?: number }): boolean {
	const now = opts.now ?? Date.now();
	const b = readBreaker(opts.stateDir);
	if (!b) return false;
	return writeBreaker(clearBreaker(b, now), opts.stateDir);
}

/**
 * `/autonomy status` 的 actions 尾行（never-throw；≤5 行）。
 * 无动作且未启用 → 单行「actions: disabled/无记录」；否则最近动作 + breaker 状态。
 */
export function summarizeActionsStatus(opts?: { stateDir?: string; configPath?: string }): string[] {
	try {
		const cfg = readAutonomyConfig({ configPath: opts?.configPath });
		const stateDir = opts?.stateDir;
		const enabled = cfg.actions?.enabled === true;
		const breaker = readBreaker(stateDir);
		const tripped = breaker ? breaker.tripped || breaker.frozen : null;
		const recent = readActionsTail({ stateDir, limit: 1 });
		if (!enabled && recent.length === 0 && !tripped) {
			return ["actions: disabled/无记录"];
		}
		const lines: string[] = [];
		lines.push(`actions: enabled=${enabled ? "on" : "off"} breaker=${tripped === null ? "unreadable" : tripped ? "TRIPPED/FRZ" : "ok"}`);
		if (recent.length > 0) {
			const r = recent[0]!;
			lines.push(`  recent: ${r.actionClass} ${r.id} ${r.kind} @${r.ts.slice(0, 19)}${r.reason ? ` (${r.reason})` : ""}`);
		}
		return lines.slice(0, 5);
	} catch {
		return ["actions: (unreadable)"];
	}
}
