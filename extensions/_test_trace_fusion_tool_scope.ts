/**
 * trace-fusion 工具面收口测试（2026-11-04，用户提出「主 agent 的 harness 相关功能 lane 不太需要；
 * find 这类禁用命令能不能直接不接受」）。
 *
 * 三件事各自要证明的：
 *  A. lane/融合会话的 `--exclude-tools` 名单**只含真实存在的工具名**（旧版踩过 `wiki-semantic` 死项），
 *     并且**不吞掉它们干活要用的工具**（禁 write 那次 lane 连产物都写不出来）。
 *  B. 名单确实被传进 spawn（源码接线，与既有 argv 断言同口径）。
 *  C. 盘根递归扫描机械门（R-13）**也管主会话**，开关可由配置关掉；写盘锁/破坏性命令仍只管 lane/融合。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { FUSION_EXCLUDE_TOOLS } from "./trace-fusion/fusion-dispatch.ts";
import { TRACE_WORKER_EXCLUDE_TOOLS } from "./trace-fusion/launch-workers.ts";
import { registerLaneBashGuard } from "./trace-fusion/lane-bash-guard.ts";
import { readTraceFusionConfig } from "./trace-fusion/config.ts";

const ROOT = join(import.meta.dirname, "..");
const LANE_SRC = readFileSync(join(ROOT, "extensions/trace-fusion/launch-workers.ts"), "utf8");
const FUSION_SRC = readFileSync(join(ROOT, "extensions/trace-fusion/fusion-dispatch.ts"), "utf8");
const INDEX_SRC = readFileSync(join(ROOT, "extensions/index.ts"), "utf8");

/** pi 内置 + harness 层工具（不在本仓注册表里，但确实存在）。 */
const CORE_TOOLS = new Set(["read", "bash", "edit", "write", "powershell", "get_goal", "create_goal", "update_goal", "ds_websearch"]);

/** 本仓真实注册过的工具名：扫非测试源码里的 `name: "x"`。 */
function registeredTools(): Set<string> {
	const files = execFileSync("grep", ["-rl", "--include=*.ts", "registerTool", join(ROOT, "extensions")], { encoding: "utf8" })
		.split("\n")
		.map((s) => s.trim())
		.filter((s) => s && !s.includes("_test_"));
	const out = new Set<string>();
	for (const f of files) {
		const src = readFileSync(f, "utf8");
		for (const m of src.matchAll(/name:\s*"([a-z][a-z0-9-]{2,})"/g)) out.add(m[1]);
	}
	for (const c of CORE_TOOLS) out.add(c);
	return out;
}

const REGISTRY = registeredTools();

// ── A. 无死项 ────────────────────────────────────────────────────────
for (const [label, list] of [["lane", TRACE_WORKER_EXCLUDE_TOOLS], ["fusion", FUSION_EXCLUDE_TOOLS]] as const) {
	const dead = list.filter((t) => !REGISTRY.has(t));
	assert.deepEqual(dead, [], `${label} 排除名单里有不存在的工具名（死项）：${dead.join(",")}`);
	const dup = list.filter((t, i) => list.indexOf(t) !== i);
	assert.deepEqual(dup, [], `${label} 排除名单有重复项：${dup.join(",")}`);
}

// ── A2. 该排的都排了 ─────────────────────────────────────────────────
const HARNESS_SET = [
	// ⚠ 只收**真实工具名**：`master-attachment` / `notify-local-master` / `handoff-token` / `recentwork` /
	// `diagnostic-report` 是 runtime 内部动作类名（不在任何会话的工具表里）⇒ 属死项，不进名单。
	"launch-tabs",
	"set-timer",
	"cancel-timer",
	"list-timers",
	"trace-fusion",
	"master-status",
	"master-dispatch",
	"master-attach",
	"master-detach",
	"master-cutover",
	"master-transfer",
	"master-transfer-confirm",
	"master-handoff",
	"master-pressure",
	"local-master-ensure",
	"global-view",
	"supervise-push",
	"tab-steer",
	"steer-status",
	"reclaim-tabs",
	"get_goal",
	"create_goal",
	"update_goal",
	"ds_websearch",
];
const missingLane = HARNESS_SET.filter((t) => !TRACE_WORKER_EXCLUDE_TOOLS.includes(t));
assert.deepEqual(missingLane, [], `lane 未排除的 harness 工具：${missingLane.join(",")}`);
const missingFusion = HARNESS_SET.filter((t) => !FUSION_EXCLUDE_TOOLS.includes(t));
assert.deepEqual(missingFusion, [], `融合会话未排除的 harness 工具：${missingFusion.join(",")}`);

// ── A3. 干活要用的工具不得被吞（2026-11-02 禁 write 事故）──────────────
const LANE_MUST_KEEP = ["read", "bash", "write", "codegraph", "wiki-nav", "hotspot", "tab-finish", "tab-report", "subagent-win"];
const killedLane = LANE_MUST_KEEP.filter((t) => TRACE_WORKER_EXCLUDE_TOOLS.includes(t));
assert.deepEqual(killedLane, [], `lane 干活要用的工具被排除：${killedLane.join(",")}（禁 write 那次 lane 连产物都写不出来）`);
const FUSION_MUST_KEEP = ["read", "bash", "write", "codegraph", "wiki-nav", "hotspot"];
const killedFusion = FUSION_MUST_KEEP.filter((t) => FUSION_EXCLUDE_TOOLS.includes(t));
assert.deepEqual(killedFusion, [], `融合会话交付要用的工具被排除：${killedFusion.join(",")}`);
assert.ok(FUSION_EXCLUDE_TOOLS.includes("edit"), "融合会话必须继续禁 edit（能改仓内已有文件）");

// ── B. 接线：名单真的进 spawn ────────────────────────────────────────
assert.ok(/excludeTools:\s*\[\s*\.\.\.TRACE_WORKER_EXCLUDE_TOOLS/.test(LANE_SRC), "lane spawn 必须传 TRACE_WORKER_EXCLUDE_TOOLS");
assert.ok(/excludeTools:\s*FUSION_EXCLUDE_TOOLS/.test(FUSION_SRC), "融合 spawn 必须传 FUSION_EXCLUDE_TOOLS");

// ── C. 盘根扫描门管主会话（接线 + 行为 + 开关）─────────────────────────
assert.ok(/registerLaneBashGuard\(\s*pi\s*,\s*\{[\s\S]{0,400}scanGate:\s*\(\)\s*=>\s*isTraceWorker\(\)\s*\|\|\s*Boolean\(process\.env\.PI_TRACE_FUSION_FUSION_DIR\)\s*\|\|\s*mainRootScanGuarded\(\)/.test(INDEX_SRC), "index.ts 的 scanGate 必须包含主会话分支（mainRootScanGuarded）");
assert.ok(/guardMainRootScan/.test(INDEX_SRC), "index.ts 必须读 guardMainRootScan 开关");

type Handler = (e: unknown) => unknown;
const mk = () => {
	const hs: { event: string; fn: Handler }[] = [];
	return { hs, pi: { on: (event: string, fn: Handler) => hs.push({ event, fn }) } };
};

const audit = join(mkdtempSync(join(tmpdir(), "tf-audit-")), "rootscan-blocks.jsonl");

// C1. 主会话（isLane=false）+ 开关开 ⇒ `find /` 被拦，且留痕
{
	const { hs, pi } = mk();
	// artifactDir 故意传上：本 fixture 要证的是「rm/落点锁门只能由 isLane 驱动」这条纪律，
	// 不是生产形态（生产形态主会话根本没有该 env ⇒ 门天然不可达，变异也就无从观测 ⇒ 夹具必须非空洞）。
	registerLaneBashGuard(pi as never, { isLane: () => false, scanGate: () => true, artifactDir: "/repo/run/fusion", blockAuditPath: audit });
	const h = hs.find((x) => x.event === "tool_call")!.fn;
	const verdict = h({ toolName: "bash", input: { command: 'find / -name "x.md" 2>/dev/null | head -5' } }) as { block?: boolean; reason?: string };
	assert.equal(verdict?.block, true, "主会话的盘根 find 必须被机械拦（R-13 事故发起者就是主会话）");
	assert.ok(/R-13/.test(String(verdict.reason)), "拦截理由要写明纪律出处");
	assert.ok(existsSync(audit), "拦截必须留痕（R-2：不得静默）");
	const rec = JSON.parse(readFileSync(audit, "utf8").trim().split("\n").pop()!) as Record<string, unknown>;
	assert.equal(rec.tool, "bash");
	assert.equal(rec.gate, "scan", "主会话命中记为 scan 档（与 lane 档可分辨）");
	// 仓库内搜索零影响
	const ok = h({ toolName: "bash", input: { command: 'grep -rn "x" extensions/trace-fusion/ | head -3' } }) as { block?: boolean };
	assert.notEqual(ok?.block, true, "仓库内递归搜索不得被误杀");
	const ok2 = h({ toolName: "bash", input: { command: "ls -la plans/" } }) as { block?: boolean };
	assert.notEqual(ok2?.block, true, "普通 ls 不得被误杀");
	// 主会话**不受**产物落点锁/破坏性命令门约束（那是 lane/融合专属）
	const noLock = h({ toolName: "bash", input: { command: "rm -f plans/tmp.md" } }) as { block?: boolean };
	assert.notEqual(noLock?.block, true, "主会话的 rm 不得被本门拦（rm 门只能由 isLane 驱动，scan 档不得带它）");
	const noWriteLock = h({ toolName: "write", input: { path: "C:/Users/x/notes.md" } }) as { block?: boolean };
	assert.notEqual(noWriteLock?.block, true, "主会话的 write 落点不得被锁（落点锁是 lane/融合专属）");
}

// C2. 开关关（scanGate=false 且非 lane）⇒ 零拦截
{
	const { hs, pi } = mk();
	registerLaneBashGuard(pi as never, { isLane: () => false, scanGate: () => false, blockAuditPath: "" });
	const h = hs.find((x) => x.event === "tool_call")!.fn;
	const v = h({ toolName: "bash", input: { command: "find / -name x" } }) as { block?: boolean };
	assert.notEqual(v?.block, true, "开关关掉 ⇒ 主会话零拦截（可关性是承诺的一部分）");
}

// C3. lane 档仍然全拦（含盘根 + 落点锁 + rm），且 gate 标 lane
{
	const { hs, pi } = mk();
	const audit2 = join(mkdtempSync(join(tmpdir(), "tf-audit2-")), "blocks.jsonl");
	registerLaneBashGuard(pi as never, { isLane: () => true, artifactDir: "/repo/run/fusion", blockAuditPath: audit2 });
	const h = hs.find((x) => x.event === "tool_call")!.fn;
	assert.equal((h({ toolName: "bash", input: { command: "find / -name x" } }) as { block?: boolean }).block, true, "lane 盘根扫描照拦");
	assert.equal((h({ toolName: "bash", input: { command: "rm -f /repo/run/other/fusion.md" } }) as { block?: boolean }).block, true, "lane/融合的 rm 保护照拦");
	const lines = readFileSync(audit2, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
	assert.ok(lines.every((r) => r.gate === "lane"), "lane 档拦截必须标 lane（与主会话档可分辨）");
}

// C4. 配置开关默认与显式 false
{
	const dir = mkdtempSync(join(tmpdir(), "tf-cfg-"));
	const pDef = join(dir, "a.json");
	writeFileSync(pDef, JSON.stringify({ traceFusionLoop: { laneConcurrency: 1 } }), "utf8");
	assert.equal(readTraceFusionConfig(pDef).guardMainRootScan, true, "缺省必须开（R-13 事故发起者是主会话）");
	const pOff = join(dir, "b.json");
	writeFileSync(pOff, JSON.stringify({ traceFusionLoop: { guardMainRootScan: false } }), "utf8");
	assert.equal(readTraceFusionConfig(pOff).guardMainRootScan, false, "显式 false 必须能关");
	const pJunk = join(dir, "c.json");
	writeFileSync(pJunk, JSON.stringify({ traceFusionLoop: { guardMainRootScan: "no" } }), "utf8");
	assert.equal(readTraceFusionConfig(pJunk).guardMainRootScan, true, "非法值回默认（不得静默变关）");
}

console.log("trace-fusion tool-scope tests passed");
