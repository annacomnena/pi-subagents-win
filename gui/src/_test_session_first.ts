/**
 * _test_session_first.ts — 会话为主重构 S6 store 级冒烟（plans/0922_gui_session_first_plan.md 切片 6）。
 *
 * 覆盖（gui 无 node 可直连 DOM 框架——module customization hooks 直载 zustand store，
 * 同 test:gui-store 模式；DOM 交互由 gui:build 的 tsc 类型检查兜底）：
 *   F1 默认主视图：activeTab === "chat"（TabId 收窄 chat|timeline 后的默认值），
 *      runtimeOverlay 初始 null（覆盖层关闭）
 *   F2 合法值切换：setActiveTab("timeline"/"chat") 双向生效
 *   F3 runtimeOverlay：attention/master/workstream/runtime/runs（+ 既有 wechat/autonomy/appearance）
 *      section 值打开并保持定位；setRuntimeOverlay(null) 关闭复位。
 *      **SBS-RUNS-M1**：section 循环扩到 store 联合类型的**全部**成员并加 `"runs"`——
 *      原来的四值循环是弱覆盖（新增 section 忘了接线也能全绿）。
 *   F4 会话列表过滤谓词（按仓库分组切片拍板 5 收窄）：空查询全匹配；title/shortId（sessionId
 *      前 12 位）/basename(cwd) 子串匹配；大小写不敏感；全量 ID 尾部/文件全路径不再命中；无命中 false
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
// 与 `RuntimeOverlaySection` 联合类型逐值对齐（新增 section 必须同时加到这里——否则本断言
// 不覆盖它，而 RuntimeOverlay.tsx 的 SECTIONS 与渲染分支漏接线时构建仍会通过）。
const OVERLAY_SECTIONS = ["attention", "master", "workstream", "runtime", "runs", "wechat", "autonomy", "appearance"] as const;
for (const section of OVERLAY_SECTIONS) {
	useGui.getState().setRuntimeOverlay(section);
	assert.equal(useGui.getState().runtimeOverlay, section);
}
ok(`F3a runtimeOverlay 全 ${OVERLAY_SECTIONS.length} section 值均可打开并保持定位（含 runs）`);

// SBS-RUNS-M1：显式再断言一次 runs（防止有人把循环里的 runs 删掉却让循环本身仍然全绿）
useGui.getState().setRuntimeOverlay("runs");
assert.equal(useGui.getState().runtimeOverlay, "runs");
ok('F3a2 setRuntimeOverlay("runs") 生效（运行 section 已接线）');

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
assert.equal(matchesSessionFilter(fixture, "a1b2c3d4"), true); // shortId（sessionId 前 12 位内）
ok("F4b shortId 子串命中（sessionId 前 12 位内）");
assert.equal(matchesSessionFilter(fixture, "789012345678"), false); // 前 12 位之外的全量 ID 尾部不再命中
ok("F4b2 全量 ID 超出前 12 位部分 → 不命中（谓词收窄）");
assert.equal(matchesSessionFilter({ ...fixture, title: "会话可读标题样例", titleSource: "first-user" }, "可读标题"), true);
ok("F4c title 子串命中（first-user 来源）");
assert.equal(matchesSessionFilter({ ...fixture, title: "repo-G6-T-台账标题", titleSource: "ledger" }, "台账标题"), true);
ok("F4d title 子串命中（ledger 来源）");
assert.equal(matchesSessionFilter(fixture, "greencad"), true); // basename(cwd) 大小写不敏感
ok("F4e basename(cwd) 子串命中（大小写不敏感）");
assert.equal(matchesSessionFilter(fixture, "pi/sessions"), false); // 文件全路径不再命中（谓词收窄）
ok("F4e2 file 全路径查询 → 不命中（谓词收窄）");
assert.equal(matchesSessionFilter(fixture, "不存在的查询xyz"), false);
ok("F4f 无命中 → false");

console.log(`_test_session_first: all assertions passed (${n})`);
