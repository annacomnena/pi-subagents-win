/**
 * _test_tiers_usage — role × costTier 用量聚合 + `/tiers usage` handler（计划矩阵 17）
 * 运行: node --experimental-strip-types --import ./extensions/runtime-host/pi-deps-loader.mjs ./extensions/_test_tiers_usage.ts
 *
 * 纯函数直接单测 aggregateUsageByRoleAndTier；handler 用 fake pi + 内存 deps（照抄 _test_lite_mode.ts）。
 * 成本表走 mkdtemp + env PI_MODEL_COST_TIERS_PATH（handler 内部 loadCostTiers() 无参 → 环境改道）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregateUsageByRoleAndTier, registerTiersCommand, type ModelCostTiersTable } from "./tiers.ts";

delete (process.env as Record<string, string | undefined>).PI_SUBAGENT;
delete (process.env as Record<string, string | undefined>).PI_TAB_RUN_ID;
delete (process.env as Record<string, string | undefined>).PI_SESSION_PROFILE;

let failed = 0;
function check(label: string, cond: boolean): void {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}`);
	if (!cond) failed++;
}

function table(partial?: Partial<ModelCostTiersTable>): ModelCostTiersTable {
	return { version: 1, tiers: {}, byProvider: {}, patterns: [], ...partial };
}

// ── 夹具：4 行（含 agent=null → (unattributed)、unknown 模型）────────
const RECORDS = [
	{ agent: "implementer", model: "p/cheap", usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: 0.01, turns: 2 } },
	{ agent: "implementer", model: "p/cheap", usage: { input: 20, output: 10, cost: 0.005 } },
	{ agent: "planner", model: "p/prem", usage: { input: 30, output: 30, cost: 0.02 } },
	{ agent: null, model: "p/cheap", usage: { input: 1, output: 1 } },
	{ agent: "searcher", model: "p/unknown-model", usage: { input: 5, output: 5 } },
];
const T = table({ tiers: { "p/cheap": "cheap", "p/prem": "premium" } });

console.log("── aggregateUsageByRoleAndTier 直接单测 ── ");
{
	const agg = aggregateUsageByRoleAndTier(RECORDS, T);
	const impl = agg.byRole.get("implementer");
	check("byRole 合并同 role 两行", impl?.count === 2 && impl?.input === 120 && impl?.output === 60);
	check("byRole 累加 cache/cost/turns", impl?.cacheRead === 10 && impl?.cacheWrite === 5 && Math.abs((impl?.cost ?? 0) - 0.015) < 1e-9 && impl?.turns === 2);
	check("byRoleTier 分桶 role|costTier", agg.byRoleTier.get("implementer|cheap")?.count === 2 && agg.byRoleTier.get("planner|premium")?.count === 1);
	check("agent=null → (unattributed)", agg.byRole.has("(unattributed)") && agg.byRoleTier.has("(unattributed)|cheap"));
	check("unknown 模型 → role|unknown", agg.byRoleTier.get("searcher|unknown")?.count === 1);
	check("byTier 分桶 cheap=3 / premium=1 / unknown=1", agg.byTier.get("cheap")?.count === 3 && agg.byTier.get("premium")?.count === 1 && agg.byTier.get("unknown")?.count === 1);

	// 表缺失 → 全 unknown
	const missing = aggregateUsageByRoleAndTier(RECORDS, table({ tiers: {} }));
	check("表缺失（无标注）→ 全 unknown", [...missing.byRoleTier.keys()].every((k) => k.endsWith("|unknown")) && missing.byTier.get("unknown")?.count === RECORDS.length);
	check("空 records → 空 Map（不 throw）", aggregateUsageByRoleAndTier([], T).byRole.size === 0);
}

console.log("── /tiers usage handler（fake pi + 内存 deps）── ");
const dir = mkdtempSync(join(tmpdir(), "tiers-usage-"));
const savedEnv = process.env.PI_MODEL_COST_TIERS_PATH;
try {
	const tablePath = join(dir, "cost-tiers.json");
	writeFileSync(tablePath, JSON.stringify({ version: 1, tiers: { "p/cheap": "cheap", "p/prem": "premium" }, byProvider: {}, patterns: [] }));
	process.env.PI_MODEL_COST_TIERS_PATH = tablePath;

	let registered: { name: string; def: { handler: (args: string, ctx: unknown) => Promise<void> } } | null = null;
	const pi = { registerCommand: (name: string, def: unknown) => { registered = { name, def } as any; } };
	const notices: string[] = [];
	const ctx = { hasUI: false, ui: { notify: (m: string) => notices.push(m) } };
	const deps = {
		reloadConfig: () => ({}),
		writeConfig: () => {},
		readUsageRecords: () => RECORDS,
	};
	registerTiersCommand(pi as any, deps);
	check("注册命令名 = tiers", registered?.name === "tiers");
	await registered!.def.handler("usage", ctx);
	const out = notices.join("\n");
	check("usage 输出含 role 名", out.includes("implementer") && out.includes("planner") && out.includes("searcher") && out.includes("(unattributed)"));
	check("usage 输出含 tier 名", out.includes("cheap") && out.includes("premium") && out.includes("unknown"));
	check("usage 输出含 role|tier 桶", out.includes("implementer|cheap") && out.includes("planner|premium"));
	check("usage 输出含未标注占比 1/5", out.includes("未标注模型占比") && out.includes("1/5"));

	// 表缺失 → 全 unknown，header 提示缺失
	process.env.PI_MODEL_COST_TIERS_PATH = join(dir, "missing.json");
	notices.length = 0;
	await registered!.def.handler("usage", ctx);
	const out2 = notices.join("\n");
	check("表缺失 handler 提示缺失且全 unknown", out2.includes("缺失") && out2.includes("implementer|unknown") && out2.includes("未标注模型占比：5/5"));
} finally {
	if (savedEnv === undefined) delete process.env.PI_MODEL_COST_TIERS_PATH; else process.env.PI_MODEL_COST_TIERS_PATH = savedEnv;
	rmSync(dir, { recursive: true, force: true });
}

console.log("── /tiers set 写前 roleTier 互校验（fake pi + 内存 deps）── ");
{
	const dir2 = mkdtempSync(join(tmpdir(), "tiers-set-"));
	const savedEnv2 = process.env.PI_MODEL_COST_TIERS_PATH;
	try {
		const tablePath = join(dir2, "cost-tiers.json");
		writeFileSync(tablePath, JSON.stringify({ version: 1, tiers: { "p/impl": "cheap" }, byProvider: {}, patterns: [] }));
		process.env.PI_MODEL_COST_TIERS_PATH = tablePath;

		let registered2: { name: string; def: { handler: (args: string, ctx: unknown) => Promise<void> } } | null = null;
		const pi2 = { registerCommand: (name: string, def: unknown) => { registered2 = { name, def } as any; } };
		const notices2: string[] = [];
		const ctx2 = { hasUI: false, ui: { notify: (m: string) => notices2.push(m) } };
		const cfg2 = { models: { planner: "p/planner-primary" }, fallbackModels: { searcher: ["p/searcher-fb"] } };
		const deps2 = { reloadConfig: () => cfg2, writeConfig: () => {}, readUsageRecords: () => [] };
		registerTiersCommand(pi2 as any, deps2);

		// ⑤ 错标拒写：planner 区间 [standard,premium]，把其主模型标 cheap → 硬矛盾拒写，表文件不变
		notices2.length = 0;
		await registered2!.def.handler("set p/planner-primary cheap", ctx2);
		let tableNow = JSON.parse(readFileSync(tablePath, "utf8"));
		check("set 错标（planner 主模型→cheap）拒写", notices2.join("\n").includes("互校验失败，未写盘") && tableNow.tiers["p/planner-primary"] === undefined);

		// 未被配置引用的模型 → 无矛盾，正常写入
		notices2.length = 0;
		await registered2!.def.handler("set p/new-model standard", ctx2);
		tableNow = JSON.parse(readFileSync(tablePath, "utf8"));
		check("set 未引用模型 → 正常写入", notices2.join("").includes("✅") && tableNow.tiers["p/new-model"] === "standard");

		// fallback 链错标也拒写（searcher 区间 [free,cheap]，标 premium → above-max 硬矛盾）
		notices2.length = 0;
		await registered2!.def.handler("set p/searcher-fb premium", ctx2);
		tableNow = JSON.parse(readFileSync(tablePath, "utf8"));
		check("set 错标（searcher fallback→premium）拒写", notices2.join("\n").includes("互校验失败，未写盘") && tableNow.tiers["p/searcher-fb"] === undefined);
	} finally {
		if (savedEnv2 === undefined) delete process.env.PI_MODEL_COST_TIERS_PATH; else process.env.PI_MODEL_COST_TIERS_PATH = savedEnv2;
		rmSync(dir2, { recursive: true, force: true });
	}
}

console.log(failed === 0 ? "\nAll tiers-usage tests passed." : `\n${failed} test(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
