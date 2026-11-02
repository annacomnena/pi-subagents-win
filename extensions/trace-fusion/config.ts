/**
 * trace-fusion/config.ts — traceFusionLoop 配置读取（trace-fusion C6，设计稿 §47）
 *
 * 与 index.ts 的 readConfig 同源：subagent-win 包目录下的 config.json。
 * 深合并用户块与默认值；非法 JSON / 缺块全部静默回默认（配置缺失永不致命）。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_TRACE_FUSION_CONFIG, type TraceFusionConfig, type TraceFusionProvisioning } from "./types.ts";

/** 包 config.json 路径（= PKG_DIR/config.json；模块相对定位避免环依赖 index.ts）。
 *
 * 测试/隔离旁路（计划 V4-2）：`PI_TRACE_FUSION_CONFIG` 指向替身配置，避免测试读写用户 config。
 * 未设 ⇒ 与今天逐字节一致（PKG_DIR/config.json）。
 */
export function traceFusionConfigPath(): string {
	const override = (process.env.PI_TRACE_FUSION_CONFIG ?? "").trim();
	if (override) return override;
	const here = dirname(fileURLToPath(import.meta.url)); // .../extensions/trace-fusion
	return join(here, "..", "..", "config.json");
}

function mergeProvisioning(user: Partial<TraceFusionProvisioning> | undefined): TraceFusionProvisioning {
	return {
		junction: Array.isArray(user?.junction) ? user!.junction.filter((x): x is string => typeof x === "string") : DEFAULT_TRACE_FUSION_CONFIG.provisioning.junction,
		copy: Array.isArray(user?.copy) ? user!.copy.filter((x): x is string => typeof x === "string") : DEFAULT_TRACE_FUSION_CONFIG.provisioning.copy,
		command: typeof user?.command === "string" ? user.command : DEFAULT_TRACE_FUSION_CONFIG.provisioning.command,
	};
}

/** 读 traceFusionLoop 配置块；path 参数供测试注入。 */
export function readTraceFusionConfig(path: string = traceFusionConfigPath()): TraceFusionConfig {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { traceFusionLoop?: Partial<TraceFusionConfig> };
		const u = parsed.traceFusionLoop ?? {};
		const num = (v: unknown, dflt: number): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : dflt);
		return {
			workerModel: typeof u.workerModel === "string" && u.workerModel ? u.workerModel : undefined,
			// per-lane 模型：只收 A/B/C 三个键的非空字符串值，其它键/空值丢弃（不报错、不静默改。）。
			workerModelByLane: ((): Partial<Record<"A" | "B" | "C", string>> | undefined => {
				const raw = u.workerModelByLane;
				if (!raw || typeof raw !== "object") return undefined;
				const out: Partial<Record<"A" | "B" | "C", string>> = {};
				for (const lane of ["A", "B", "C"] as const) {
					const v = (raw as Record<string, unknown>)[lane];
					if (typeof v === "string" && v.trim()) out[lane] = v.trim();
				}
				return Object.keys(out).length > 0 ? out : undefined;
			})(),
			fusionModel: typeof u.fusionModel === "string" && u.fusionModel ? u.fusionModel : undefined,
			consultMode: u.consultMode === "always" || u.consultMode === "never" ? u.consultMode : "auto",
			consultModel: typeof u.consultModel === "string" && u.consultModel ? u.consultModel : undefined,
			finalizerModel: typeof u.finalizerModel === "string" && u.finalizerModel ? u.finalizerModel : undefined,
			maxRounds: num(u.maxRounds, DEFAULT_TRACE_FUSION_CONFIG.maxRounds),
			maxConsultations: num(u.maxConsultations, DEFAULT_TRACE_FUSION_CONFIG.maxConsultations),
			maxTargetedProbes: num(u.maxTargetedProbes, DEFAULT_TRACE_FUSION_CONFIG.maxTargetedProbes),
			maxWallClockPerLaneMin: num(u.maxWallClockPerLaneMin, DEFAULT_TRACE_FUSION_CONFIG.maxWallClockPerLaneMin),
			finalizerStallTimeoutMin: num(u.finalizerStallTimeoutMin, DEFAULT_TRACE_FUSION_CONFIG.finalizerStallTimeoutMin),
			maxActiveRuns: num(u.maxActiveRuns, DEFAULT_TRACE_FUSION_CONFIG.maxActiveRuns),
			// laneConcurrency 只接受 1|2|3；其它值（含 0/小数/字符串）一律回默认，不静默釒2 或 4。
			laneConcurrency: u.laneConcurrency === 1 || u.laneConcurrency === 2 || u.laneConcurrency === 3
				? u.laneConcurrency
				: DEFAULT_TRACE_FUSION_CONFIG.laneConcurrency,
			provisioning: mergeProvisioning(u.provisioning),
		};
	} catch {
		return structuredClone(DEFAULT_TRACE_FUSION_CONFIG);
	}
}
