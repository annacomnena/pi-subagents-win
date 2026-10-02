/**
 * runtime/autonomy/action/ledger.ts — 动作账本 actions.jsonl（P1；设计 §3）。
 *
 * **动作事件只进 actions.jsonl**（自有 namespace 新文件），**绝不碰 audit.jsonl**——
 * W5 冻结正则（_test_autonomy_wiring.ts:330）与 W6「单次评估恰 3 行」体积基线一字不动
 * （§3.1：additive、新文件、零触碰）。
 *
 * 轮转从第一天就有（0600 + ~1MB 两代 rename，master-injection.ts M3 先例）——不重蹈
 * audit.jsonl 无轮转（R5）的覆辙。原子 append（mode 0600）；never-throw（collect.ts 同款纪律）。
 *
 * 回放三问（§3.2 验收口径）由 readActionsTail / readActionEvents 支撑：
 *   做了什么 → kind ∈ {attempted, executed}；为什么 → trigger + intent + policyVersion；
 *   能不能撤 → 该 id 最新 kind ∈ {rolled_back, rollback_failed, postverified} + rollbackHandle。
 */
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultRuntimeDir } from "../../journal.ts";

export const ACTIONS_LEDGER_FILE = "actions.jsonl";
/** ~1MB 两代轮转上限（master-injection M3 同款数值）。 */
export const ACTIONS_LEDGER_MAX_BYTES = 1_048_576;

/** 策略版本标记（回放「为什么」维度；P1 = actions-v1）。 */
export const POLICY_VERSION = "actions-v1";

/** 动作事件类型（§3.2：每动作多事件、每事件一行）。 */
export type ActionKind =
	| "attempted"
	| "precheck"
	| "executed"
	| "postverified"
	| "rolled_back"
	| "rollback_failed"
	| "frozen"
	| "rejected"
	| "skipped";

export interface ActionEvent {
	v: 1;
	id: string;
	kind: ActionKind;
	ts: string;
	policyVersion: string;
	/** 哪条 trigger、依据（回放「为什么」）。 */
	trigger: { rule: string; project: string; evidence: string; approximate: boolean };
	actionClass: string;
	/** 意图（回放「为什么」）。 */
	intent?: string;
	/** L0–L3 逐项实际判定（precheck 事件）。 */
	precheck?: Record<string, unknown>;
	/** 效应（executed 事件）。 */
	effect?: { paths: string[]; bytes: number };
	/** 后置验证（postverified / rolled_back 事件）。 */
	postverify?: { result: string; detail?: string };
	/** 回退句柄（rollback 数据源；deletedFiles 应恒空——只增不删，§A ②）。 */
	rollbackHandle?: { type: string; snapshots: string[]; validUntil: string | null; deletedFiles: string[] };
	/** rejected / skipped / frozen 的原因。 */
	reason?: string;
	/** 疑似回声标记（方案 C：同 project 1h 内已有 executed notify；只标记不改判定）。 */
	suspectedEcho?: true;
}

function ledgerPath(stateDir?: string): string {
	return join(stateDir ?? join(defaultRuntimeDir(), "state"), "autonomy", "actions", "actions.jsonl");
}

/**
 * 追加一条动作事件（never-throw；0600 + ~1MB 两代 rename 轮转）。
 * 动作事件只进 actions.jsonl（不碰 audit.jsonl）。返回是否实际写盘。
 */
export function appendActionEvent(ev: ActionEvent, stateDir?: string): boolean {
	try {
		const file = ledgerPath(stateDir);
		mkdirSync(dirname(file), { recursive: true });
		try {
			if (statSync(file).size > ACTIONS_LEDGER_MAX_BYTES) {
				try {
					renameSync(file, `${file}.1`); // 两代：现文件 → .1（覆盖旧 .1）
				} catch {
					/* 轮转失败则继续追加（账本不断），下次再转 */
				}
			}
		} catch {
			/* 文件不存在/不可 stat = 首次写，走追加创建 */
		}
		appendFileSync(file, `${JSON.stringify(ev)}\n`, { encoding: "utf8", mode: 0o600 });
		try {
			chmodSync(file, 0o600); // 已存在文件权限收敛（mode 仅创建时生效）
		} catch {
			/* Windows 等 chmod 语义不足的平台尽力而为 */
		}
		return true;
	} catch {
		return false; // never-throw
	}
}

/** 容忍读 actions.jsonl 尾部 ≤limit 条（never-throw；坏行跳过不猜）。 */
export function readActionsTail(opts?: { stateDir?: string; limit?: number }): ActionEvent[] {
	const limit = Math.max(1, opts?.limit ?? 50);
	try {
		const lines = readFileSync(ledgerPath(opts?.stateDir), "utf8").split("\n");
		while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
		const out: ActionEvent[] = [];
		for (const l of lines.slice(-limit)) {
			try {
				const o = JSON.parse(l) as ActionEvent;
				if (o && o.v === 1 && typeof o.id === "string" && typeof o.kind === "string") out.push(o);
			} catch {
				/* 坏行跳过 */
			}
		}
		return out;
	} catch {
		return [];
	}
}

/** 读取某 id 的全部事件（按账本顺序；never-throw）。 */
export function readActionEvents(id: string, opts?: { stateDir?: string }): ActionEvent[] {
	return readActionsTail({ stateDir: opts?.stateDir, limit: 100000 }).filter((e) => e.id === id);
}

/** 该 id 的最新事件（回放「能不能撤」维度取终态；never-throw）。 */
export function readLatestAction(id: string, opts?: { stateDir?: string }): ActionEvent | null {
	const evs = readActionEvents(id, opts);
	return evs.length > 0 ? evs[evs.length - 1]! : null;
}

/**
 * 只读 helper：扫 actions.jsonl 尾部，查同 project 是否存在 executed notify-local-master 事件
 * 且 ts 在 windowMs 内（方案 C 回声判据）。never-throw。
 */
export function hasRecentNotifyForProject(
	project: string,
	opts: { stateDir?: string; now: number; windowMs: number },
): boolean {
	try {
		const events = readActionsTail({ stateDir: opts.stateDir, limit: 200 });
		for (let i = events.length - 1; i >= 0; i--) {
			const e = events[i]!;
			if (e.actionClass !== "notify-local-master") continue;
			if (e.kind !== "executed") continue;
			if (e.trigger.project !== project) continue;
			const ts = Date.parse(e.ts);
			const age = opts.now - ts;
			if (Number.isFinite(ts) && age >= 0 && age < opts.windowMs) return true;
		}
		return false;
	} catch {
		return false; // never-throw
	}
}
