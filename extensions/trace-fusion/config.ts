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

/** 包 config.json 路径（= PKG_DIR/config.json；模块相对定位避免环依赖 index.ts）。 */
export function traceFusionConfigPath(): string {
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
			provisioning: mergeProvisioning(u.provisioning),
		};
	} catch {
		return structuredClone(DEFAULT_TRACE_FUSION_CONFIG);
	}
}
