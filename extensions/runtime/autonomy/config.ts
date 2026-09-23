/**
 * runtime/autonomy/config.ts — Autonomy Suite v1 配置归一化 + §27 边界常量。
 *
 * Task 2002 · plans/0923_autonomy_suite_v1_plan.md（设计要点 a）。
 * - DEFAULT_AUTONOMY = 规格 §27 精确值：watchdog 10m/2m/60m/6h；strategic 2h/30m/6h；
 *   wakeGate 2s/15s；enabled/awayMode 均 false。
 * - 严格归一化（normalizeMasterSuccession 同款纪律）：缺失/非法输入 = 全默认 =
 *   enabled:false = 零行为（D7/C6 opt-in 零侵入：config.json 无 autonomy 键时行为与现状一致）。
 * - awayMode 与 config.masterSuccession 物理分离（C6 / L1C 未决 #3）：本模块不读
 *   masterSuccession 切片，normalizeMasterSuccession 不读 autonomy 切片（测试 A1 tripwire 钉死）。
 * - watchdog_policy（§16 default/min/max/max_override_duration）即 AutonomyConfig.watchdog
 *   四字段，不另立对象（计划 a）。
 * - IO 边界：本模块唯一 IO = readAutonomyConfig 对 config.json autonomy 切片的容忍读
 *   （command-executor.readConfigRaw 同款模式）；推导层（frontier/wake-gate/watchdog）不 import node:fs。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface AutonomyConfig {
	/** 总开关；严格 === true 才开（缺省/垃圾 = false = 零行为）。 */
	enabled: boolean;
	/** 与 config.masterSuccession.auto 物理分离（C6）：只认 autonomy.awayMode 切片。 */
	awayMode: { enabled: boolean };
	/** §16 watchdog_policy：default/min/max/max_override_duration。独立常量（C8），不与 local-master 10min 心跳判据互引。 */
	watchdog: {
		defaultIntervalMs: number;
		minIntervalMs: number;
		maxIntervalMs: number;
		maxOverrideDurationMs: number;
	};
	/** §27 strategic_review 边界（v1 只落常量，无执行端——延后原因见计划"明确不做"）。 */
	strategicReview: {
		defaultIntervalMs: number;
		minIntervalMs: number;
		maxIntervalMs: number;
	};
	/** §24 防抖（2s）/ 普通冷却（15s）。 */
	wakeGate: {
		debounceMs: number;
		ordinaryCooldownMs: number;
	};
}

/** 每次调用返回全新对象（DEFAULT_AUTONOMY 常量与归一化结果都不共享引用，防调用方误改）。 */
export function defaultAutonomyConfig(): AutonomyConfig {
	return {
		enabled: false,
		awayMode: { enabled: false },
		watchdog: {
			defaultIntervalMs: 10 * 60_000, // §27 default_interval: 10m
			minIntervalMs: 2 * 60_000, // §27 min_interval: 2m
			maxIntervalMs: 60 * 60_000, // §27 max_interval: 60m
			maxOverrideDurationMs: 6 * 3_600_000, // §27 max_override_duration: 6h
		},
		strategicReview: {
			defaultIntervalMs: 2 * 3_600_000, // §27 default_interval: 2h
			minIntervalMs: 30 * 60_000, // §27 min_interval: 30m
			maxIntervalMs: 6 * 3_600_000, // §27 max_interval: 6h
		},
		wakeGate: {
			debounceMs: 2_000, // §27 debounce: 2s
			ordinaryCooldownMs: 15_000, // §27 ordinary_cooldown: 15s
		},
	};
}

export const DEFAULT_AUTONOMY: AutonomyConfig = defaultAutonomyConfig();

/** 正值有限数归一：number 且有限且 >0 → 原样；否则逐字段回落默认（"垃圾字段回落"）。 */
function posNum(v: unknown, dflt: number): number {
	return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : dflt;
}

/**
 * 严格归一化（纯）：raw 非对象 → 全默认；enabled/awayMode.enabled 严格 === true；
 * 各数值字段独立回落（不做跨字段校验——与 normalizeMasterSuccession 同纪律）。
 */
export function normalizeAutonomy(raw: unknown): AutonomyConfig {
	const d = defaultAutonomyConfig();
	if (typeof raw !== "object" || raw === null) return d;
	const o = raw as Record<string, unknown>;
	const slice = (k: string): Record<string, unknown> =>
		typeof o[k] === "object" && o[k] !== null ? (o[k] as Record<string, unknown>) : {};
	const away = slice("awayMode");
	const wd = slice("watchdog");
	const sr = slice("strategicReview");
	const wg = slice("wakeGate");
	return {
		enabled: o.enabled === true,
		awayMode: { enabled: away.enabled === true },
		watchdog: {
			defaultIntervalMs: posNum(wd.defaultIntervalMs, d.watchdog.defaultIntervalMs),
			minIntervalMs: posNum(wd.minIntervalMs, d.watchdog.minIntervalMs),
			maxIntervalMs: posNum(wd.maxIntervalMs, d.watchdog.maxIntervalMs),
			maxOverrideDurationMs: posNum(wd.maxOverrideDurationMs, d.watchdog.maxOverrideDurationMs),
		},
		strategicReview: {
			defaultIntervalMs: posNum(sr.defaultIntervalMs, d.strategicReview.defaultIntervalMs),
			minIntervalMs: posNum(sr.minIntervalMs, d.strategicReview.minIntervalMs),
			maxIntervalMs: posNum(sr.maxIntervalMs, d.strategicReview.maxIntervalMs),
		},
		wakeGate: {
			debounceMs: posNum(wg.debounceMs, d.wakeGate.debounceMs),
			ordinaryCooldownMs: posNum(wg.ordinaryCooldownMs, d.wakeGate.ordinaryCooldownMs),
		},
	};
}

/** 缺省 config：包根 config.json（本文件位于 <pkg>/extensions/runtime/autonomy/，上跳三级；command-executor 同款）。 */
function defaultPkgConfigPath(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "config.json");
}

/**
 * 容忍读取 config.json 的 autonomy 切片（readConfigRaw 同款模式）：
 * 缺文件/坏 JSON/根非对象/无 autonomy 键 = 全默认（零行为，不抛）。
 */
export function readAutonomyConfig(opts?: { configPath?: string }): AutonomyConfig {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(opts?.configPath ?? defaultPkgConfigPath(), "utf8"));
	} catch {
		return defaultAutonomyConfig();
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return defaultAutonomyConfig();
	return normalizeAutonomy((parsed as Record<string, unknown>)["autonomy"]);
}
