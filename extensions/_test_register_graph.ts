/**
 * 注册完整性快照测试（register graph snapshot）
 *
 * 用途：index.ts 的 default factory 即将进行多步拆分重构。本测试用 fake pi
 * 调用 factory，冻结当前注册的工具/命令/事件/flag 快照；此后任何重构步骤若
 * 丢失或改动了注册点（工具/命令名、事件名、flag 名），测试即红。
 *
 * 运行：npm run test:register-graph
 * （等价于 node ./scripts/ensure-pi-test-deps.mjs && node --experimental-strip-types ./extensions/_test_register_graph.ts）
 *
 * 环境隔离：开头删除 PI_SUBAGENT / PI_TAB_RUN_ID / PI_TAB_RUNS_DIR，
 * 使 factory 以「主会话」身份执行（launch-tabs 工具与 /launch 命令才会注册）。
 *
 * fake pi 补的方法：getFlag（惰性身份读取；返回空串 → 判定为主会话）、
 * sendUserMessage / sendMessage / exec（事件/命令 handler 里才用到，注册期不触发，
 * 为防意外补上 no-op）。
 *
 * 注意：factory 内部会调用各兄弟模块的 registerXxx（registerTimers /
 * registerAsyncPanel / registerEventBus / registerReportListener /
 * registerTabTelemetry / registerTabStatusTools / registerWikiNav /
 * registerCodexHeaders / registerIdentityFlag 等），它们也会在 fake pi 上注册
 * 工具/命令/事件——快照包含全部这些（这正是完整性校验的意图）。
 * factory 还会读 agents/*.md 与 ~/.pi 下配置（只读，安全）。
 */

import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── 环境隔离：以「主会话」身份执行 factory ─────────────────────────
delete process.env.PI_SUBAGENT;
delete process.env.PI_TAB_RUN_ID;
delete process.env.PI_TAB_RUNS_DIR;
delete process.env.PI_SESSION_PROFILE;

// ── fake pi：记录注册图，执行类方法 no-op ──────────────────────────
const tools = new Map<string, unknown>();
const commands = new Map<string, unknown>();
const flags = new Map<string, unknown>();
const events = new Map<string, number>(); // event 名 → 注册次数

const fakePi = {
	registerTool(def: { name: string }): void {
		tools.set(def.name, def);
	},
	registerCommand(name: string, opts: unknown): void {
		commands.set(name, opts);
	},
	registerFlag(name: string, opts: unknown): void {
		flags.set(name, opts);
	},
	on(event: string, _handler: unknown): void {
		events.set(event, (events.get(event) ?? 0) + 1);
	},
	getFlag(_name: string): string {
		return ""; // 无标签页身份（空 flag 值 + 无 env → 主会话）
	},
	// 以下为防御性 no-op（注册期不触发；事件/命令 handler 若被调用也安全）
	sendUserMessage: () => {},
	sendMessage: () => {},
	exec: () => {},
} as unknown as ExtensionAPI;

// ── 调用 factory ──
const mod = await import("./index.ts");
assert.equal(typeof mod.default, "function", "index.ts 必须导出 default factory");
await mod.default(fakePi);

const toolNames = [...tools.keys()].sort();
const commandNames = [...commands.keys()].sort();
const eventNames = [...events.keys()].sort();
const flagNames = [...flags.keys()].sort();

console.log(`[register-graph] tools (${toolNames.length}):`);
for (const n of toolNames) console.log(`  ${n}`);
console.log(`[register-graph] commands (${commandNames.length}):`);
for (const n of commandNames) console.log(`  ${n}`);
console.log(`[register-graph] events (${eventNames.length}):`);
for (const n of eventNames) console.log(`  ${n} x${events.get(n)}`);
console.log(`[register-graph] flags (${flagNames.length}):`);
for (const n of flagNames) console.log(`  ${n}`);

// ── 快照断言（把上面打印的实际集合写死进来）─────────────────────────
// 工具快照（按名排序；2026-08-19 冻结）：timers 3 个（set/cancel/list-timers）、
// tab 侧 2 个（tab-finish/tab-report）、主会话回收 2 个（tab-status/reclaim-tabs）、
// wiki-nav 1 个、index.ts 2 个（launch-tabs 主会话、subagent-win）、
// 2026-09-19 master 工具组 8 个（attach/cutover/detach/dispatch/handoff/
// pressure/status/transfer/transfer-confirm——Phase 5.5 S1）。
assert.deepEqual(toolNames, [
	"cancel-timer",
	"hotspot",
	"launch-tabs",
	"list-timers",
	"master-attach",
	"master-cutover",
	"master-detach",
	"master-dispatch",
	"master-handoff",
	"master-pressure",
	"master-status",
	"master-transfer",
	"master-transfer-confirm",
	"reclaim-tabs",
	"set-timer",
	"subagent-win",
	"tab-finish",
	"tab-report",
	"tab-status",
	"trace-fusion",
	"wiki-nav",
]);

// 命令快照（按名排序；2026-08-19 冻结，2026-08-25 补 lite / sub-presets，
// 2026-09-15 trace-fusion C6 补主会话专属 /trace-fusion-loop，
// 2026-09-20 补 master slash（attach/cutover/detach/handoff/status/succession/auto-handoff——
// Phase 5.5 S1/A1/总开关）+ /runtime-host（G2）+ /workstream* /task-*（Phase 5a A7 F18，旧漏项——此前被 tools 断言失败遮挡）：
// 2026-09-22 补 /gui（G6 L3 GUI 自动拉起，gui-autostart.ts）：
// codex-headers / timers / tabs 来自兄弟模块，其余是 index.ts 直接注册
// （含主会话专属 /launch、/lite、/sub-presets、/trace-fusion-loop）。
assert.deepEqual(commandNames, [
	"agents",
	"codex-headers",
	"gc",
	"gui",
	"hotspot",
	"launch",
	"links",
	"lite",
	"master-attach",
	"master-auto-handoff",
	"master-cutover",
	"master-detach",
	"master-handoff",
	"master-status",
	"master-succession",
	"notify",
	"runs",
	"runtime-host",
	"searcher-mode",
	"sub-models",
	"sub-presets",
	"subagent-gc",
	"tabs",
	"task-close",
	"task-create",
	"timers",
	"today-usage",
	"trace-fusion-clean",
	"trace-fusion-collect",
	"trace-fusion-loop",
	"trace-fusion-status",
	"workstream",
	"workstream-create",
	"workstream-link",
	"workstream-pause",
]);

// 事件快照（按名排序；2026-08-19 冻结）。同一事件可被多处注册：
// agent_end x1（session-hooks 自动 master 交接）、
// session_start x5（timers/async-panel/event-bus/report/tab 遥测）、
// session_shutdown x2（tab 遥测 + index.ts 清理钩子）、
// tool_execution_end x2 与 tool_execution_start x2（index.ts 通知钩子 +
// tab 遥测 tracking）。
assert.deepEqual(eventNames, [
	"agent_end",
	"agent_settled",
	"agent_start",
	"before_agent_start",
	"before_provider_headers",
	"input",
	"message_end",
	"resources_discover",
	"session_before_compact",
	"session_shutdown",
	"session_start",
	"tool_execution_end",
	"tool_execution_start",
]);

// flag 快照：tab-run-id（launch-tabs 身份）+ session-profile / trace-run-id / trace-lane
// （trace-fusion C4/C6：trace worker 三旗标，派发时注入，不注册会死于 CLI 解析）。
assert.deepEqual(
	flagNames,
	["session-profile", "tab-run-id", "trace-lane", "trace-run-id"],
	"身份 flag 必须注册（tab-run-id + trace 三件套）",
);

// 已知关键项兜底（防止快照整体被意外清空却因写死集合一致而误绿）
for (const t of ["subagent-win", "launch-tabs"]) {
	assert.ok(toolNames.includes(t), `工具 ${t} 必须注册`);
}
for (const c of ["agents", "runs", "links", "today-usage", "sub-models", "notify", "searcher-mode", "launch", "trace-fusion-loop", "trace-fusion-status", "trace-fusion-collect", "trace-fusion-clean", "hotspot"]) {
	assert.ok(commandNames.includes(c), `命令 ${c} 必须注册`);
}
for (const e of ["session_start", "session_shutdown", "before_agent_start"]) {
	assert.ok(eventNames.includes(e), `事件 ${e} 必须注册`);
}

console.log("register-graph tests passed");