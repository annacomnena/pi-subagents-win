/**
 * _test_tiers — costTier 派发门纯函数测试（计划 20261014 矩阵 1–14 + 10/11 校验 + glob）
 * 运行: node --experimental-strip-types --import ./extensions/runtime-host/pi-deps-loader.mjs ./extensions/_test_tiers.ts
 *
 * 全部用内存表 / mkdtemp 显式路径，不触碰真实 ~/.pi/agent 与 config.json。
 * 身份环境隔离：清 PI_SUBAGENT / PI_TAB_RUN_ID / PI_SESSION_PROFILE（防身份 guard 假红）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadCostTiers, resolveCostTier, normalizeRoleTier, checkDispatchTier,
	validateRoleTierAgainstModels, DEFAULT_ROLE_TIER, type ModelCostTiersTable,
} from "./tiers.ts";

delete (process.env as Record<string, string | undefined>).PI_SUBAGENT;
delete (process.env as Record<string, string | undefined>).PI_TAB_RUN_ID;
delete (process.env as Record<string, string | undefined>).PI_SESSION_PROFILE;

let failed = 0;
function check(label: string, cond: boolean): void {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}`);
	if (!cond) failed++;
}

/** 内存表（无 present 标记 ⇒ tablePresent=true）；loadCostTiers 缺省才带 present:false。 */
function table(partial?: Partial<ModelCostTiersTable>): ModelCostTiersTable {
	return { version: 1, tiers: {}, byProvider: {}, patterns: [], ...partial };
}

/** checkDispatchTier 便捷默认：非主会话、无覆盖、不升层、角色 implementer。 */
function gate(args: Partial<Parameters<typeof checkDispatchTier>[0]>) {
	return checkDispatchTier({
		role: "implementer", model: "p/m", table: table(),
		roleTier: normalizeRoleTier(undefined),
		explicitOverride: false, allowTierEscalation: false, mainCall: false, ...args,
	});
}

console.log("── loadCostTiers（mkdtemp 显式路径）── ");
const dir = mkdtempSync(join(tmpdir(), "tiers-test-"));
try {
	const goodPath = join(dir, "good.json");
	writeFileSync(goodPath, JSON.stringify({
		version: 1,
		tiers: { "p/m": "premium", "bad/x": "nope" },
		byProvider: { p: "free" },
		patterns: [{ match: "q/*", tier: "cheap" }, { match: "", tier: "free" }, { match: "z/*", tier: "bogus" }],
	}));
	const loaded = loadCostTiers(goodPath);
	check("loadCostTiers 好表 present=true", loaded.present === true);
	check("loadCostTiers 非法 tier 被过滤", loaded.table.tiers["bad/x"] === undefined && loaded.table.tiers["p/m"] === "premium");
	check("loadCostTiers 非法/空 pattern 被过滤", loaded.table.patterns.length === 1 && loaded.table.patterns[0].match === "q/*");

	check("loadCostTiers 缺文件 present=false", loadCostTiers(join(dir, "nope.json")).present === false);
	const badPath = join(dir, "bad.json");
	writeFileSync(badPath, "{ not json");
	check("loadCostTiers 坏 JSON present=false", loadCostTiers(badPath).present === false);
	const wrongVer = join(dir, "v2.json");
	writeFileSync(wrongVer, JSON.stringify({ version: 2, tiers: {} }));
	check("loadCostTiers 版本不符 present=false", loadCostTiers(wrongVer).present === false);

	console.log("── resolveCostTier 优先级（矩阵 8/9）+ glob 边界 ── ");
	check("8 tiers[全名] 覆盖 byProvider", resolveCostTier("p/m", table({ tiers: { "p/m": "premium" }, byProvider: { p: "free" } })) === "premium");
	check("9 patterns 优先于 byProvider", resolveCostTier("p/m", table({ patterns: [{ match: "p/*", tier: "cheap" }], byProvider: { p: "free" } })) === "cheap");
	check("byProvider 兜底", resolveCostTier("p/m", table({ byProvider: { p: "free" } })) === "free");
	check("未命中 → unknown", resolveCostTier("p/m", table()) === "unknown");
	check("glob * 跨 /", resolveCostTier("p/x/y", table({ patterns: [{ match: "p*", tier: "cheap" }] })) === "cheap");
	check("glob ? 单字符命中", resolveCostTier("ab", table({ patterns: [{ match: "a?", tier: "free" }] })) === "free");
	check("glob ? 不跨多字符", resolveCostTier("abc", table({ patterns: [{ match: "a?", tier: "free" }] })) === "unknown");
	check("glob 正则元字符按字面转义", resolveCostTier("a.b", table({ patterns: [{ match: "a.b", tier: "cheap" }] })) === "cheap");
	check("glob 元字符不匹配任意字符", resolveCostTier("axb", table({ patterns: [{ match: "a.b", tier: "cheap" }] })) === "unknown");
	check("pattern 匹配 provider/id 的尾部 id", resolveCostTier("prov/flash-x", table({ patterns: [{ match: "flash-*", tier: "cheap" }] })) === "cheap");
} finally {
	rmSync(dir, { recursive: true, force: true });
}

console.log("── checkDispatchTier 门判定矩阵 ── ");
// 表缺失的 table：loadCostTiers 对不存在的显式路径返回 {present:false, emptyTable}
const MISSING = loadCostTiers(join(tmpdir(), `tiers-missing-${process.pid}.json`)).table;

// 1 表缺失 → 放行（table_missing），指引「同层替身 / 停下问人」
{
	const d = gate({ table: MISSING, model: "p/m" });
	check("1 表缺失放行 table_missing", d.allowed && d.code === "table_missing");
	check("1 表缺失指引 same-costTier + 停下问人", d.message.includes("same-costTier") && d.message.includes("停下问人"));
}

// 2 超 max（implementer max=cheap，模型 premium）→ 硬拦，side=above-max
{
	const t = table({ tiers: { "p/m": "premium" } });
	const d = gate({ table: t, role: "implementer", model: "p/m" });
	check("2 超 max 拒派 out_of_range_blocked/above-max", !d.allowed && d.code === "out_of_range_blocked" && d.side === "above-max");
}

// 3 低于 min（planner min=standard，模型 cheap）→ 硬拦，side=below-min
{
	const t = table({ tiers: { "p/m": "cheap" } });
	const d = gate({ table: t, role: "planner", model: "p/m" });
	check("3 低于 min 拒派 out_of_range_blocked/below-min", !d.allowed && d.code === "out_of_range_blocked" && d.side === "below-min");
}

// 4 区间内 → 放行 in_range
{
	const t = table({ tiers: { "p/m": "cheap" } });
	const d = gate({ table: t, role: "searcher", model: "p/m" });
	check("4 区间内放行 in_range", d.allowed && d.code === "in_range");
}

// 5 unknown × 任意角色（非主会话/非覆盖）→ 一律拦
{
	const d = gate({ table: table(), role: "implementer", model: "p/m" });
	check("5 unknown 子会话拒 unknown_blocked", !d.allowed && d.code === "unknown_blocked");
	const d2 = gate({ table: table(), role: "consultant", model: "p/m" });
	check("5 unknown 任意角色均拒", !d2.allowed && d2.code === "unknown_blocked");
}

// 6 主会话点名 unknown → 放行 + 告警
{
	const d = gate({ table: table(), role: "implementer", model: "p/m", mainCall: true, explicitOverride: true });
	check("6 主会话 override unknown 放行 unknown_override+warn", d.allowed && d.code === "unknown_override" && d.warn === true);
}

// 7 子会话传 allowTierEscalation 被拒（该旗标只对 mainCall 生效）
{
	const t = table({ tiers: { "p/m": "premium" } });
	const d = gate({ table: t, role: "implementer", model: "p/m", mainCall: false, allowTierEscalation: true });
	check("7 子会话 allowTierEscalation 仍 out_of_range_blocked", !d.allowed && d.code === "out_of_range_blocked" && d.side === "above-max");
	const d2 = gate({ table: table(), role: "implementer", model: "p/m", mainCall: false, allowTierEscalation: true });
	check("7 子会话 unknown+escalation 仍 unknown_blocked", !d2.allowed && d2.code === "unknown_blocked");
	const d3 = gate({ table: t, role: "implementer", model: "p/m", mainCall: true, allowTierEscalation: true });
	check("7 对照：主会话 escalation 放行 escalated", d3.allowed && d3.code === "escalated" && d3.warn === true);
}

// 13 selfpaid：默认拦；主会话点名放行
{
	const t = table({ tiers: { "p/m": "selfpaid" } });
	const d = gate({ table: t, role: "implementer", model: "p/m" });
	check("13 selfpaid 默认拒 selfpaid_blocked", !d.allowed && d.code === "selfpaid_blocked");
	const d2 = gate({ table: t, role: "implementer", model: "p/m", mainCall: true, explicitOverride: true });
	check("13 主会话点名 selfpaid 放行 selfpaid_override+warn", d2.allowed && d2.code === "selfpaid_override" && d2.warn === true);
}

// 未知角色 key（不在默认 7 键）→ 拒绝，不静默放行
{
	const d = gate({ table: table(), role: "not-a-role", model: "p/m" });
	check("+ 未知角色 key 拒绝 unknown_blocked", !d.allowed && d.code === "unknown_blocked");
}

console.log("── validateRoleTierAgainstModels（矩阵 10/11）── ");
{
	const t = table({ tiers: { "p/cheap": "cheap", "p/prem": "premium" } });
	// 10 fallback 链含超 max 项（searcher max=cheap，fallback premium）
	const over = validateRoleTierAgainstModels({ models: { searcher: "p/cheap" }, fallbackModels: { searcher: ["p/prem"] } }, t);
	check("10 fallback 超 max → errors[field=fallbackModels]", over.errors.length === 1 && over.errors[0].field === "fallbackModels" && over.errors[0].tier === "premium" && !over.skipped);
	// 11 fallback 链含低于 min 项（planner min=standard，fallback cheap）
	const under = validateRoleTierAgainstModels({ models: {}, fallbackModels: { planner: ["p/cheap"] } }, t);
	check("11 fallback 低于 min → errors", under.errors.length === 1 && under.errors[0].field === "fallbackModels" && under.errors[0].tier === "cheap");
	// primary 越界 → field=models
	const primary = validateRoleTierAgainstModels({ models: { implementer: "p/prem" }, fallbackModels: {} }, t);
	check("10b primary 越界 → field=models", primary.errors.length === 1 && primary.errors[0].field === "models" && primary.errors[0].role === "implementer");
	// unknown 进 unknown[] 不进 errors
	const unk = validateRoleTierAgainstModels({ models: { searcher: "p/none" }, fallbackModels: {} }, t);
	check("未标注进 unknown[] 不进 errors", unk.errors.length === 0 && unk.unknown.length === 1 && unk.unknown[0].model === "p/none" && unk.unknown[0].field === "models");
	// 表缺失 → skipped:true，不报错
	const skip = validateRoleTierAgainstModels({ models: { searcher: "p/cheap" }, fallbackModels: {} }, MISSING);
	check("表缺失 → skipped:true 且 errors 空", skip.skipped === true && skip.errors.length === 0 && skip.unknown.length === 0);
}

console.log("── 12 USAGE_CAP 字符串断言（读 index.ts 文本）── ");
{
	const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
	check("12 含 same-costTier", src.includes("same-costTier"));
	check("12 含 STOP and ask the user", src.includes("STOP and ask the user"));
	check("12 不含 higher-tier", !src.includes("higher-tier"));
}

console.log("── 14 normalizeRoleTier ── ");
{
	const merged = normalizeRoleTier({ searcher: { min: "cheap", max: "cheap" } });
	check("14 searcher 被覆盖", merged.searcher.min === "cheap" && merged.searcher.max === "cheap");
	const keys = Object.keys(DEFAULT_ROLE_TIER);
	check("14 默认 7 键且其余 6 键保留默认", keys.length === 7 && keys.filter((k) => k !== "searcher").every((k) => merged[k].min === DEFAULT_ROLE_TIER[k].min && merged[k].max === DEFAULT_ROLE_TIER[k].max));
	// 非法输入全部忽略，never-throw
	const bogus = normalizeRoleTier({
		searcher: { min: "bogus", max: "cheap" },
		planner: { min: "premium", max: "cheap" },
		general: "not-object",
		unknownRole: { min: "free", max: "free" },
	});
	check("14 未知 tier 忽略保留默认", bogus.searcher.min === DEFAULT_ROLE_TIER.searcher.min && bogus.searcher.max === DEFAULT_ROLE_TIER.searcher.max);
	check("14 max<min 忽略保留默认", bogus.planner.min === DEFAULT_ROLE_TIER.planner.min && bogus.planner.max === DEFAULT_ROLE_TIER.planner.max);
	check("14 非对象忽略保留默认", bogus.general.min === DEFAULT_ROLE_TIER.general.min);
	check("14 未知角色键不进入结果", !("unknownRole" in bogus));
	check("14 null/undefined never-throw", normalizeRoleTier(null).planner.max === "premium" && normalizeRoleTier(undefined).searcher.min === "free");
}

console.log(failed === 0 ? "\nAll tiers tests passed." : `\n${failed} test(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
