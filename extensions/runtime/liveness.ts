/**
 * runtime/liveness.ts — G5.2 Master 心跳活跃度（owner 会话落盘的「活压力」，plans/0921_G5_gui_research.md §3.6 缺口补全）。
 *
 * 为什么存在：runtime host 是独立 detached 进程（scripts/gui-dev.mjs 直接 spawn
 * extensions/runtime-host/server.ts），读不到 pi 会话内存里的 ctx.getContextUsage()；
 * 活压力必须由 owner 会话主动写盘。唯一写手 = session-hooks.ts agent_end 钩子
 * （owner 分支算出 reading 后调用）；host 侧 readLiveness 经 snapshot.master.liveness
 * 投影给 GUI。Host 侧绝不伪造压力——无心跳 = GUI 回退 proposal 时点值并标注。
 *
 * 形状：state/master-liveness.json 单记录文件，version:1 + updatedAt（同
 * master-succession.json 单记录惯例）；pressure = readPressure().percent 原样
 * （0-100 刻度；null = 本轮无有效读数，§9 不猜）。
 *
 * 节流：同 sessionId+generation 且距上次写入 <30s → 跳写（agent_end 每轮触发，
 * 防 turn 密集写爆）；身份变化（新 owner / 新一代）立即写，不被节流吞掉。
 *
 * 纪律：never-throw（gauge 永不打断主流程，写失败返回 false 静默）；纯库、路径
 * 可注入、无 Pi API 依赖（同 master-succession/master-control 纪律）。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultRuntimeDir } from "./journal.ts";

/** 同身份最小写间隔：≥30s 节流（G5.2 拍板：防 turn 密集写爆）。 */
export const LIVENESS_THROTTLE_MS = 30_000;

export interface MasterLiveness {
	version: 1;
	sessionId: string;
	generation: number;
	/** 上下文压力百分数（0-100，readPressure().percent 原样）；null = 本轮无有效读数（no decision 不猜）。 */
	pressure: number | null;
	/** 上下文窗口 tokens（readPressure().contextWindow 原样）；缺席/非法不落。 */
	windowTokens?: number;
	updatedAt: string;
}

export interface WriteLivenessInput {
	sessionId: string;
	generation: number;
	pressure: number | null;
	windowTokens?: number | null;
}

function livenessPath(stateDir?: string): string {
	return join(stateDir ?? join(defaultRuntimeDir(), "state"), "master-liveness.json");
}

/** 容忍读：缺失/坏 JSON/坏版本/关键字段缺失 → null（同 readProposal 惯例）。 */
export function readLiveness(stateDir?: string): MasterLiveness | null {
	try {
		const raw = JSON.parse(readFileSync(livenessPath(stateDir), "utf8")) as MasterLiveness;
		if (
			raw?.version !== 1 ||
			typeof raw.sessionId !== "string" ||
			typeof raw.generation !== "number" ||
			typeof raw.updatedAt !== "string"
		) {
			return null;
		}
		return raw;
	} catch {
		return null;
	}
}

/** 数值归一：number 且有限且 ≥0 → 原样；否则 null（同 master-pressure readPressure 口径）。 */
function numOrNull(v: unknown): number | null {
	return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * 写心跳（agent_end 每轮调用；≥30s 节流 + never-throw）。
 * 返回 true = 本次实际写盘；false = 节流跳过或写失败（调用方无需关心）。
 */
export function writeLiveness(input: WriteLivenessInput, opts: { stateDir?: string; now?: Date } = {}): boolean {
	try {
		const path = livenessPath(opts.stateDir);
		const now = opts.now ?? new Date();
		const prev = readLiveness(opts.stateDir);
		// 节流：30s 内且身份未变 → 跳写；身份变化（新 owner/新代）立即写不被吞。
		if (prev && prev.sessionId === input.sessionId && prev.generation === input.generation) {
			const age = now.getTime() - Date.parse(prev.updatedAt);
			if (Number.isFinite(age) && age >= 0 && age < LIVENESS_THROTTLE_MS) return false;
		}
		const record: MasterLiveness = {
			version: 1,
			sessionId: input.sessionId,
			generation: input.generation,
			pressure: numOrNull(input.pressure),
			updatedAt: now.toISOString(),
		};
		const window = numOrNull(input.windowTokens);
		if (window !== null) record.windowTokens = window;
		const dir = path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));
		if (dir) mkdirSync(dir, { recursive: true });
		const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
		renameSync(tmp, path);
		return true;
	} catch {
		return false; // never-throw：写失败静默（gauge 永不打断主流程）
	}
}
