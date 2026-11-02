/**
 * trace-fusion/tf-settings.ts — trace-fusion 的用户设置面（2026-11-02）
 *
 * 设计口径（用户 2026-11-02 裁定）：从**用户交互**角度，trace-fusion 只需要三件事：
 *   ① 模型：三路 lane 各用什么模型（+ 融合/裁决模型）
 *   ② 参数：并发度、lane 时限、最大轮数等
 *   ③ 开始：跑一次
 *
 * 因此 `/trace-fusion-status` / `-collect` / `-clean` 这类**运维命令全部退场**
 * （它们只服务开发者自查，对使用者是噪声）。状态与清理改为：
 *   - 运行中状态：由 `/trace-fusion` 启动后的一次性通知 + 完成事件承担；
 *   - 报告：融合产物写到 runDir，主会话/用户按需 read；
 *   - 清理：`-clean` 保留为**唯一运维逃生口**（worktree 占磁盘，必须有手动入口）。
 *
 * 本模块只做**纯配置读写**（无 pi 依赖、无 UI），命令层负责交互。
 *
 * 写入纪律（AGENTS.md R-1，硬约束）：
 *   - 只改 `traceFusionLoop` 单键；其余顶层键原样保留；
 *   - 写前备份 `config.json.bak-tfsettings-<ts>`；
 *   - 原子写 tmp+rename（含 Windows EPERM 重试）；
 *   - 写完**回读校验**：顶层键数与关键键存在性必须与写前一致。
 */

import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, copyFileSync } from "node:fs";
import { join } from "node:path";

/** 三命令中「参数」一项的可调集合（只列用户真正会改的）。 */
export interface TraceFusionUserSettings {
	laneConcurrency: 1 | 2 | 3;
	maxWallClockPerLaneMin: number;
	maxRounds: number;
	mode: "diagnose" | "implement";
}

export const DEFAULT_USER_SETTINGS: TraceFusionUserSettings = {
	laneConcurrency: 3,
	maxWallClockPerLaneMin: 45,
	maxRounds: 2,
	mode: "diagnose",
};

/** 从原始 config 对象里取 traceFusionLoop 块（不存在 ⇒ 空对象）。 */
export function readTfBlock(raw: Record<string, unknown>): Record<string, unknown> {
	const v = raw["traceFusionLoop"];
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** 把块归一化成可展示的设置（非法值回落默认，不报错、不猜）。 */
export function normalizeUserSettings(block: Record<string, unknown>): TraceFusionUserSettings {
	const conc = block["laneConcurrency"];
	const num = (v: unknown, d: number): number =>
		typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d;
	return {
		laneConcurrency: conc === 1 || conc === 2 || conc === 3 ? conc : DEFAULT_USER_SETTINGS.laneConcurrency,
		maxWallClockPerLaneMin: num(block["maxWallClockPerLaneMin"], DEFAULT_USER_SETTINGS.maxWallClockPerLaneMin),
		maxRounds: num(block["maxRounds"], DEFAULT_USER_SETTINGS.maxRounds),
		mode: block["mode"] === "implement" ? "implement" : "diagnose",
	};
}

/** per-lane 模型展示（A/B/C 各自的值；缺 ⇒ undefined）。 */
export function readLaneModels(block: Record<string, unknown>): Partial<Record<"A" | "B" | "C", string>> {
	const raw = block["workerModelByLane"];
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const out: Partial<Record<"A" | "B" | "C", string>> = {};
	for (const lane of ["A", "B", "C"] as const) {
		const v = (raw as Record<string, unknown>)[lane];
		if (typeof v === "string" && v.trim()) out[lane] = v.trim();
	}
	return out;
}

/** 融合/裁决模型展示（当前零消费，但设置面要能看到——否则用户设了不知道生不生效）。 */
export function readFusionModels(block: Record<string, unknown>): {
	fusionModel?: string;
	consultModel?: string;
	finalizerModel?: string;
} {
	const s = (k: string): string | undefined => {
		const v = block[k];
		return typeof v === "string" && v.trim() ? v.trim() : undefined;
	};
	return { fusionModel: s("fusionModel"), consultModel: s("consultModel"), finalizerModel: s("finalizerModel") };
}

export interface WriteTfBlockResult {
	ok: boolean;
	/** 写入前的顶层键数（用于回读校验对比）。 */
	keysBefore: number;
	keysAfter: number;
	/** 备份文件路径（成功才给）。 */
	backupPath?: string;
	error?: string;
}

/**
 * read-modify-write 单键 `traceFusionLoop`。
 *
 * @param configPath 目标 config.json
 * @param patch      要合并进 traceFusionLoop 的键（undefined 值 = 删除该键）
 *
 * 安全保证（任一失败即**不写**并返回 error，不做半套写入）：
 *   1. 读不到 / 解析失败 ⇒ 中止（不在坏文件上做 read-modify-write）；
 *   2. 备份失败 ⇒ 中止；
 *   3. 原子写后回读：**丢顶层键** ⇒ 报错（新增键是正常的，不报）。
 */
export function writeTfBlock(
	configPath: string,
	patch: Record<string, unknown>,
	opts: { now?: Date } = {},
): WriteTfBlockResult {
	const now = opts.now ?? new Date();
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
	} catch (e) {
		return { ok: false, keysBefore: 0, keysAfter: 0, error: `config.json 读取/解析失败，中止写入：${(e as Error).message}` };
	}
	const keysBefore = Object.keys(parsed).length;

	// 合并：只动 traceFusionLoop 一个键
	const block = { ...readTfBlock(parsed) };
	for (const [k, v] of Object.entries(patch)) {
		if (v === undefined) delete block[k];
		else block[k] = v;
	}
	const next: Record<string, unknown> = { ...parsed, traceFusionLoop: block };

	// 备份（R-1 第 2 条）
	const stamp = now.toISOString().replace(/[:.]/g, "-");
	const backupPath = `${configPath}.bak-tfsettings-${stamp}`;
	try {
		copyFileSync(configPath, backupPath);
	} catch (e) {
		return { ok: false, keysBefore, keysAfter: keysBefore, error: `备份失败，中止写入：${(e as Error).message}` };
	}

	// 原子写（tmp + rename，Windows EPERM 重试）
	const tmp = `${configPath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
	writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
	for (let attempt = 0; ; attempt++) {
		try {
			renameSync(tmp, configPath);
			break;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "EPERM" && attempt < 3) {
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
				continue;
			}
			try { unlinkSync(tmp); } catch { /* ignore */ }
			return { ok: false, keysBefore, keysAfter: keysBefore, error: `写入失败：${(e as Error).message}`, backupPath };
		}
	}

	// 回读校验（R-1 第 4 条）
	// 关键区分：**丢键才是事故**（R-1 描述的就是 autonomy 键被抹掉）；
	// 新增键（如首次写入 traceFusionLoop）是正常行为，不得报错。
	let keysAfter = -1;
	try {
		const reread = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
		keysAfter = Object.keys(reread).length;
		const beforeKeys = new Set(Object.keys(parsed));
		const lost = [...beforeKeys].filter((k) => !(k in reread));
		if (lost.length > 0) {
			return {
				ok: false,
				keysBefore,
				keysAfter,
				backupPath,
				error: `写入后丢了顶层键（${lost.join(", ")}）——已保留备份 ${backupPath}`,
			};
		}
	} catch (e) {
		return { ok: false, keysBefore, keysAfter, backupPath, error: `回读失败：${(e as Error).message}` };
	}

	return { ok: true, keysBefore, keysAfter, backupPath };
}

/** 设置面的可读摘要（`/trace-fusion --show` 与启动前确认共用）。 */
export function renderSettingsSummary(configPath: string): string[] {
	if (!existsSync(configPath)) return ["（config.json 不存在，使用默认设置）"];
	let block: Record<string, unknown>;
	try {
		block = readTfBlock(JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>);
	} catch {
		return ["（config.json 解析失败，使用默认设置）"];
	}
	const s = normalizeUserSettings(block);
	const lanes = readLaneModels(block);
	const fusion = readFusionModels(block);
	const globalWorker = typeof block["workerModel"] === "string" ? (block["workerModel"] as string) : undefined;

	const lines: string[] = [];
	lines.push(`模式：${s.mode}　并发度：${s.laneConcurrency}${s.laneConcurrency === 1 ? "（严格串行）" : ""}`);
	lines.push(`lane 时限：${s.maxWallClockPerLaneMin}min　最大轮数：${s.maxRounds}`);
	lines.push(`lane 模型：A=${lanes.A ?? globalWorker ?? "(lane 默认)"} | B=${lanes.B ?? globalWorker ?? "(lane 默认)"} | C=${lanes.C ?? globalWorker ?? "(lane 默认)"}`);
	lines.push(`融合模型：${fusion.fusionModel ?? "(未设)"} —— 未设则 collect 完成后**零动作**（跳过理由会写进 meta.fusion）`);
	return lines;
}
