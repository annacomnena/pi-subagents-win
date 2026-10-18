/**
 * _test_tiers_gate — costTierGate（index.ts 派发门 + enforce 灰度开关）纯函数测试
 * 覆盖 L4 修复令 3 条门语义：
 *   ① 无模型名派发（model:"" → unknown）：表 present → 拦；表缺失 → 放行（fail-open）
 *   ② fallback 候选（explicitOverride 强制 false）：unknown 即使 mainCall 也拦（点名不覆盖 fallback 链）
 *   ③ enforce=false（默认）→ 门不通过只降级告警放行；enforce=true → 硬拦
 * 运行: node --experimental-strip-types --import ./extensions/runtime-host/pi-deps-loader.mjs ./extensions/_test_tiers_gate.ts
 *
 * 全内存表 / 无文件 IO，不触碰真实 ~/.pi/agent 与 config.json。
 */
import { costTierGate, runWithFallback } from "./index.ts";
import { normalizeRoleTier, type ModelCostTiersTable } from "./tiers.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

delete (process.env as Record<string, string | undefined>).PI_SUBAGENT;
delete (process.env as Record<string, string | undefined>).PI_TAB_RUN_ID;
delete (process.env as Record<string, string | undefined>).PI_SESSION_PROFILE;
// 本文件只测门（④⑤ 段走真实 runWithFallback 到 spawn 路径），**不测同模型重试**。
// 不关重试会踩两个坑：① 默认退避 30s/60s；② 更致命的是每个候选 3 次尝试 × 5s stall 超时
// ⇒ 3 候选 × 3 次 = 9 次 spawn（旧行为 3 次），整套从秒级涨到分钟级（实测 2m11s）。
// 重试语义由 `_test_model_retry.ts` 专门验证，这里用测试缝隙 `maxSameModel=0` 锁回旧行为。
process.env.PI_SUBAGENT_RETRY_MAX = "0";
process.env.PI_SUBAGENT_RETRY_BACKOFF_MS = "5";

let failed = 0;
function check(label: string, cond: boolean): void {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}`);
	if (!cond) failed++;
}

/** 内存表（无 present 标记 ⇒ present）。 */
function table(partial?: Partial<ModelCostTiersTable>): ModelCostTiersTable {
	return { version: 1, tiers: {}, byProvider: {}, patterns: [], ...partial };
}
/** 缺表：present 非枚举标记 = false。 */
function missingTable(): ModelCostTiersTable {
	const t = table();
	Object.defineProperty(t, "present", { value: false });
	return t;
}

const ROLE_TIER = normalizeRoleTier(undefined);
const T = table({ tiers: { "p/cheap": "cheap", "p/std": "standard" } });
const base = { role: "implementer", table: T, roleTier: ROLE_TIER, allowTierEscalation: false, mainCall: false };

console.log("── ① 无模型名派发（model:\"\" ⇒ unknown）── ");
{
	// 表 present：unknown 一律拦（非主会话）
	const g1 = costTierGate({ ...base, model: "", explicitOverride: false, enforce: true });
	check("无模型名 + 表 present → 拦", g1.allowed === false && g1.gate.code === "unknown_blocked" && g1.gate.tier === "unknown");
	// 表 present + 主会话 allowTierEscalation → 放行 + 告警（unknown_override）
	const g2 = costTierGate({ ...base, model: "", explicitOverride: false, mainCall: true, allowTierEscalation: true, enforce: true });
	check("无模型名 + 主会话升层 → 放行且 warn", g2.allowed === true && g2.gate.code === "unknown_override" && g2.gate.warn === true);
	// 表缺失 → table_missing 放行（维持 fail-open）
	const g3 = costTierGate({ ...base, model: "", explicitOverride: false, table: missingTable(), enforce: true });
	check("无模型名 + 表缺失 → 放行（table_missing）", g3.allowed === true && g3.gate.code === "table_missing");
}

console.log("── ② fallback 候选：explicitOverride 强制 false ── ");
{
	const unknownModel = "p/unlabeled"; // 未在 T 中标注
	// mainCall=true 但点名语义不覆盖 fallback（explicitOverride:false）→ unknown 仍拦
	const f1 = costTierGate({ ...base, model: unknownModel, explicitOverride: false, mainCall: true, enforce: true });
	check("fallback unknown + mainCall + 未点名 → 拦", f1.allowed === false && f1.gate.code === "unknown_blocked");
	// 对照：candidate 0 的点名语义（explicitOverride:true）→ 放行 + 告警
	const f2 = costTierGate({ ...base, model: unknownModel, explicitOverride: true, mainCall: true, enforce: true });
	check("candidate 0 点名 unknown → 放行 + warn", f2.allowed === true && f2.gate.code === "unknown_override" && f2.gate.warn === true);
	// 标注过的 fallback 候选不受影响（in_range）
	const f3 = costTierGate({ ...base, model: "p/cheap", explicitOverride: false, mainCall: true, enforce: true });
	check("fallback 已标注 cheap（区间内）→ 放行", f3.allowed === true && f3.gate.code === "in_range");
}

console.log("── ③ enforce 灰度开关（默认 false = warn-only）── ");
{
	// 硬拦场景（below-min）：enforce=true → 拦
	const hard = { ...base, role: "planner", model: "p/cheap", explicitOverride: false };
	const e1 = costTierGate({ ...hard, enforce: true });
	check("planner+cheap below-min，enforce=true → 拦", e1.allowed === false && e1.gate.code === "out_of_range_blocked" && e1.gate.side === "below-min");
	// 同场景 enforce=false → 放行（原始判定保留在 .gate）
	const e2 = costTierGate({ ...hard, enforce: false });
	check("同场景 enforce=false → 放行（warn-only）", e2.allowed === true && e2.gate.allowed === false && e2.gate.code === "out_of_range_blocked");
	// unknown 场景 enforce=false → 放行（原始判定 unknown_blocked）
	const e3 = costTierGate({ ...base, model: "p/unlabeled", explicitOverride: false, mainCall: true, enforce: false });
	check("unknown 场景 enforce=false → 放行（原始判定拦）", e3.allowed === true && e3.gate.allowed === false);
	// 区间内放行不受 enforce 影响
	const e4 = costTierGate({ ...base, model: "p/cheap", explicitOverride: false, enforce: false });
	check("in_range + enforce=false → 放行且无告警", e4.allowed === true && e4.gate.allowed === true && !e4.gate.warn);
	// 表缺失 + enforce=false → 仍放行（table_missing）
	const e5 = costTierGate({ ...base, model: "x/y", table: missingTable(), enforce: false });
	check("表缺失 + enforce=false → 放行（table_missing）", e5.allowed === true && e5.gate.code === "table_missing");
}

console.log("── ④ 接线级：runWithFallback 零候选分支真跑门（非纯函数）── ");
{
	// “general” 在 DEFAULT_ROLE_TIER 内（区间可解析）且不在 config.json 的 models/fallbackModels 中
	// → 零候选分支；用 PI_MODEL_COST_TIERS_PATH 指向临时表（不碰真实 ~/.pi/agent）。
	const tmp = mkdtempSync(join(tmpdir(), "tiers-gate-wiring-"));
	const agent = { name: "general", body: "test agent" };
	// 表 present → 无模型名门应真拦（subagent-tier-blocked + model=(none)），不 spawn。
	const tableFile = join(tmp, "model-cost-tiers.json");
	writeFileSync(tableFile, JSON.stringify({ version: 1, tiers: {} }) + "\n");
	process.env.PI_MODEL_COST_TIERS_PATH = tableFile;
	process.env.PI_COST_TIER_ENFORCE = "1"; // 测试 seam：镜像 PI_MODEL_COST_TIERS_PATH 的 env 覆盖模式，不写 config.json
	const blocked = await runWithFallback(agent, "wiring test task", undefined, undefined, 5000);
	check("零候选 + 表 present + enforce=true → 真拦（subagent-tier-blocked）",
		blocked.status === "failed"
		&& (blocked.error ?? "").includes("[subagent-tier-blocked")
		&& (blocked.error ?? "").includes("model=(none)")
		&& (blocked.error ?? "").includes("role=general"));
	// 表缺失（指向不存在路径）→ fail-open 放行：调用进入 runSingle（用已 aborted 信号快速终止子进程），
	// 结果不再是 tier-blocked 结构化失败。
	delete process.env.PI_COST_TIER_ENFORCE;
	process.env.PI_MODEL_COST_TIERS_PATH = join(tmp, "nonexistent-cost-tiers.json");
	const passed = await runWithFallback(agent, "wiring test task", undefined, undefined, 5000, new AbortController().signal);
	check("零候选 + 表缺失 → 放行（非 tier-blocked，进入 spawn 路径）",
		!((passed.error ?? "").includes("subagent-tier-blocked")));
}

console.log("── ⑤ 接线级：主门（候选 0）走 costTierGate（enforce 灰度，2026-10-16 二轮必修）── ");
{
	// planner 默认区间 [standard, premium]；p/cheap → below-min（probe C1 场景）。
	// runWithFallback(model="p/cheap") → candidates[0] 主门（explicitOverride=true）。
	const tmp2 = mkdtempSync(join(tmpdir(), "tiers-gate-main-"));
	const tableFile2 = join(tmp2, "model-cost-tiers.json");
	writeFileSync(tableFile2, JSON.stringify({ version: 1, tiers: { "p/cheap": "cheap", "p/std": "standard" } }) + "\n");
	process.env.PI_MODEL_COST_TIERS_PATH = tableFile2;
	const plannerAgent = { name: "planner", body: "test agent" };
	const updates: string[] = [];
	const onUp = (s: string): void => { updates.push(s); };
	// enforce=false（默认 warn-only）：主门越界 → warn 放行，不得 hard-block。
	delete process.env.PI_COST_TIER_ENFORCE;
	updates.length = 0;
	const warnOnly = await runWithFallback(plannerAgent, "main gate test", undefined, "p/cheap", 5000, new AbortController().signal, onUp);
	console.log("  [实测] enforce=false 主门 updates:", JSON.stringify(updates));
	check("主门 + enforce=false → 不 hard-block（非 tier-blocked）",
		!((warnOnly.error ?? "").includes("subagent-tier-blocked")));
	check("主门 + enforce=false → 有 warn-only 告警",
		updates.some((u) => u.includes("warn-only，未拦")));
	// enforce=true → 主门硬拦（结构化失败，side=below-min）。
	process.env.PI_COST_TIER_ENFORCE = "1";
	const hardBlocked = await runWithFallback(plannerAgent, "main gate test", undefined, "p/cheap", 5000);
	check("主门 + enforce=true → 硬拦（subagent-tier-blocked + model=p/cheap + below-min）",
		hardBlocked.status === "failed"
		&& (hardBlocked.error ?? "").includes("[subagent-tier-blocked")
		&& (hardBlocked.error ?? "").includes("model=p/cheap")
		&& (hardBlocked.error ?? "").includes("below-min"));
	delete process.env.PI_COST_TIER_ENFORCE;
}

console.log(failed === 0 ? "\nAll tiers-gate tests passed." : `\n${failed} test(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
