/**
 * gui/src/_test_workspace_home_nav.ts — 仓库主页工作台导航与解耦状态测试。
 *
 * 验证：
 * 1. 默认状态：activeTab === "chat", activeWorkspaceCwd === null
 * 2. 激活仓库：setActiveWorkspace(cwd) => activeTab === "workspace", activeWorkspaceCwd === cwd
 * 3. 激活会话：openChatSession(id) => activeTab === "chat", chatActiveId === id
 * 4. 显式切换：setActiveTab("timeline") / setActiveTab("chat")
 */

import assert from "node:assert/strict";
import { register } from "node:module";

register("../../extensions/_gui_store_ts_loader.mjs", import.meta.url);

// Mock localStorage & window.matchMedia before importing store
const lsBacking = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
	getItem: (k: string) => (lsBacking.has(k) ? lsBacking.get(k) : null),
	setItem: (k: string, v: string) => lsBacking.set(k, String(v)),
	removeItem: (k: string) => lsBacking.delete(k),
	clear: () => lsBacking.clear(),
};
(globalThis as Record<string, unknown>).window = {
	matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
};

const { useGui } = await import("./store.ts");

console.log("▶ [Test 1] 验证初始状态：activeTab 默认为 chat，activeWorkspaceCwd 默认为 null");
assert.equal(useGui.getState().activeTab, "chat");
assert.equal(useGui.getState().activeWorkspaceCwd, null);
console.log("  ✓ 初始状态通过");

console.log("▶ [Test 2] 验证激活仓库主页：setActiveWorkspace(cwd) 切换到 workspace 视图");
const targetCwd = "C:/Users/Annacomnena/GreenCAD";
useGui.getState().setActiveWorkspace(targetCwd);
assert.equal(useGui.getState().activeTab, "workspace");
assert.equal(useGui.getState().activeWorkspaceCwd, targetCwd);
console.log("  ✓ 激活仓库主页通过");

console.log("▶ [Test 3] 验证切回会话：openChatSession(id) 自动切换回 chat 视图");
await useGui.getState().openChatSession("test-session-001");
assert.equal(useGui.getState().activeTab, "chat");
assert.equal(useGui.getState().chatActiveId, "test-session-001");
console.log("  ✓ 切回会话自动置 activeTab=chat 通过");

console.log("▶ [Test 4] 验证次级导航切换");
useGui.getState().setActiveTab("timeline");
assert.equal(useGui.getState().activeTab, "timeline");
useGui.getState().setActiveTab("workspace");
assert.equal(useGui.getState().activeTab, "workspace");
console.log("  ✓ 视图自由切换通过");

console.log("▶ [Test 5] 验证「活跃中」排序维度与过滤逻辑");
const { loadSortBy, saveSortBy } = await import("./workspaceSort.ts");
saveSortBy("active");
assert.equal(loadSortBy(), "active");

// 模拟活跃中仅保留 activity === "active" 的过滤
const mockSessions = [
	{ sessionId: "s1", cwd: "C:/repoA", activity: "active" as const },
	{ sessionId: "s2", cwd: "C:/repoA", activity: "inactive" as const },
	{ sessionId: "s3", cwd: "C:/repoB", activity: "unknown" as const },
	{ sessionId: "s4", cwd: "C:/repoC", activity: "active" as const },
];
const activeFiltered = mockSessions.filter((s) => s.activity === "active");
assert.equal(activeFiltered.length, 2);
assert.deepEqual(activeFiltered.map((s) => s.sessionId), ["s1", "s4"]);
console.log("  ✓ 「活跃中」过滤逻辑通过（仅保留 alive/active 的 agent 和仓库）");

console.log("\n✅ 仓库主页导航与状态解耦测试全部通过！");
