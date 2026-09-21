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

console.log(`_test_session_first: all assertions passed (${n})`);
