/**
 * _test_session_first.ts — 会话为主重构 S6 store 级冒烟（plans/0922_gui_session_first_plan.md 切片 6）。
 *
 * 覆盖（gui 无 node 可直连 DOM 框架——module customization hooks 直载 zustand store，
 * 同 test:gui-store 模式；DOM 交互由 gui:build 的 tsc 类型检查兜底）：
 *   F1 默认主视图：activeTab === "chat"（TabId 收窄 chat|timeline 后的默认值），
 *      runtimeOverlay 初始 null（覆盖层关闭）
 *   F2 合法值切换：setActiveTab("timeline"/"chat") 双向生效
 *   F3 runtimeOverlay：attention/master/workstream/runtime 四 section 值打开并保持定位；
 *      setRuntimeOverlay(null) 关闭复位
 *   F4 会话列表过滤谓词（session-title L3）：空查询全匹配；shortId/全量 ID/文件/cwd/title
 *      子串匹配；大小写不敏感；无命中 false（matchesSessionFilter，JSX-free 纯函数）
 *
 * pollChatSessions 行为回归（never-throw / 失败保留旧数据 / masterProtected flag）由
 * test:gui-chat-guard 覆盖，此处不重复。
 *
 * 运行：npm run test:gui-session-first
 */

import assert from "node:assert/strict";
import { register } from "node:module";

// gui/src 按 vite/bundler 惯例 extensionless 相对导入 → 复用 store 测试 resolve hook 补 .ts
register("../../extensions/_gui_store_ts_loader.mjs", import.meta.url);

const { useGui } = await import("./store.ts");
const { matchesSessionFilter } = await import("./sessionFilter.ts");
import type { SessionSummary } from "./api/types.ts";

let n = 0;
const ok = (name: string): void => {
	n += 1;
	console.log(`ok ${n} - ${name}`);
};

// ── F1 默认主视图 ─────────────────────────────────────────────────
assert.equal(useGui.getState().activeTab, "chat");
assert.equal(useGui.getState().runtimeOverlay, null);
ok('F1 默认 activeTab === "chat" 且 runtimeOverlay 初始关闭（null）');

// ── F2 合法值切换（TabId 已收窄：chat | timeline）─────────────────
useGui.getState().setActiveTab("timeline");
assert.equal(useGui.getState().activeTab, "timeline");
ok('F2a setActiveTab("timeline") 生效');

useGui.getState().setActiveTab("chat");
assert.equal(useGui.getState().activeTab, "chat");
ok('F2b setActiveTab("chat") 生效（回到默认主视图）');

// ── F3 runtimeOverlay 开/关/带 section 打开 ───────────────────────
for (const section of ["attention", "master", "workstream", "runtime"] as const) {
	useGui.getState().setRuntimeOverlay(section);
	assert.equal(useGui.getState().runtimeOverlay, section);
}
ok("F3a runtimeOverlay 四 section 值均可打开并保持定位（attention/master/workstream/runtime）");

useGui.getState().setRuntimeOverlay(null);
assert.equal(useGui.getState().runtimeOverlay, null);
ok("F3b setRuntimeOverlay(null) 关闭覆盖层");

// ── F4 会话列表过滤谓词（会话可读标题 L3：title + shortId 匹配）──────
const fixture: SessionSummary = {
	sessionId: "a1b2c3d4e5f6789012345678",
	cwd: "C:/work/GreenCAD",
	startedAt: null,
	parentSession: null,
	file: "C:/pi/sessions/0922_a1b2c3d4e5f6789012345678.jsonl",
	sizeBytes: 1024,
	mtimeMs: 1,
};
assert.equal(matchesSessionFilter(fixture, ""), true);
ok("F4a 空查询 → 全匹配");
assert.equal(matchesSessionFilter(fixture, "a1b2c3d4"), true); // shortId（sessionId 前缀）
ok("F4b shortId 子串命中（sessionId 前缀）");
assert.equal(matchesSessionFilter({ ...fixture, title: "会话可读标题样例", titleSource: "first-user" }, "可读标题"), true);
ok("F4c title 子串命中（first-user 来源）");
assert.equal(matchesSessionFilter({ ...fixture, title: "repo-G6-T-台账标题", titleSource: "ledger" }, "台账标题"), true);
ok("F4d title 子串命中（ledger 来源）");
assert.equal(matchesSessionFilter(fixture, "greencad"), true); // cwd 大小写不敏感
ok("F4e cwd 子串命中（大小写不敏感）");
assert.equal(matchesSessionFilter(fixture, "不存在的查询xyz"), false);
ok("F4f 无命中 → false");

console.log(`_test_session_first: all assertions passed (${n})`);
