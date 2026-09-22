/**
 * _test_workspace_group.ts — 左栏「按仓库分组会话」L3 冒烟（plans/0922_workspace_group_plan.md 切片 S4）。
 *
 * 纯函数直载（workspaceGroup/workspaceExpansion/sessionFilter/workspaceSort 均 JSX-free；sessionFilter 对
 * workspaceGroup 为 extensionless 值导入 → 复用 _gui_store_ts_loader 补 .ts，同 _test_session_first 模式；
 * G6/G8 用 Map 支撑的 localStorage 桩，在 import 前注入 globalThis）：
 *   G1 归一化 cwd 键：`\`→`/`、Windows 盘符小写、去尾 `/`、null → 未分组键
 *   G2 分组：同 cwd 合并、null→未分组、count/maxMtimeMs、basename 显示名、全路径 tooltip、hasError
 *   G3 排序：组序 maxMtimeMs 降序（未分组垫底）、组内 updated（mtimeMs 降）/created（startedAt 降）
 *   G4 过滤谓词收窄：title/shortId(12)/basename(cwd) 命中、大小写不敏感、无命中
 *   G5 过滤后组内空 → 整组隐藏（含未分组）
 *   G6 折叠持久化：save→load 回读、prune 删失效组键、坏 JSON/非对象容错
 *   G8 组内排序持久化：save→load 回读（saw-ws-sort）、坏 JSON/非合法值/非字符串容错、写异常吞
 *
 * 运行：npm run test:gui-workspace-group
 */

import assert from "node:assert/strict";
import { register } from "node:module";

// gui/src 按 vite/bundler 惯例 extensionless 相对导入 → 复用 store 测试 resolve hook 补 .ts
register("../../extensions/_gui_store_ts_loader.mjs", import.meta.url);

// ── G6 前置：localStorage 桩（Map 支撑；必须在 import workspaceExpansion 前注入）────
const lsBacking = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
	getItem: (k: string) => (lsBacking.has(k) ? lsBacking.get(k) : null),
	setItem: (k: string, v: string) => {
		lsBacking.set(k, String(v));
	},
	removeItem: (k: string) => {
		lsBacking.delete(k);
	},
	clear: () => lsBacking.clear(),
};

const {
	UNGROUPED_KEY,
	normalizeCwdKey,
	basename,
	cwdLabel,
	groupSessions,
	sortGroups,
} = await import("./workspaceGroup.ts");
const { matchesSessionFilter } = await import("./sessionFilter.ts");
const { loadExpansionState, saveExpansionState, pruneExpansionState } = await import(
	"./workspaceExpansion.ts"
);
const { loadSortBy, saveSortBy } = await import("./workspaceSort.ts");
import type { SessionSummary } from "./api/types.ts";
import type { WorkspaceGroup } from "./workspaceGroup.ts";

let n = 0;
const ok = (name: string): void => {
	n += 1;
	console.log(`ok ${n} - ${name}`);
};

// 会话 fixture 工厂（最小可用字段）
let seq = 0;
const mk = (o: Partial<SessionSummary> & { cwd: string | null }): SessionSummary => {
	seq += 1;
	return {
		sessionId: `id${String(seq).padStart(12, "0")}xxxxxxxx`,
		cwd: o.cwd,
		startedAt: o.startedAt ?? null,
		parentSession: null,
		file: `C:/pi/sessions/session_${seq}.jsonl`,
		sizeBytes: 10,
		mtimeMs: o.mtimeMs ?? seq,
		...(o.title !== undefined ? { title: o.title, titleSource: o.titleSource ?? "first-user" } : {}),
	};
};

// ── G1 归一化 cwd 键 ─────────────────────────────────────────────
assert.equal(normalizeCwdKey("C:\\work\\GreenCAD"), "c:/work/greencad"); // 反斜杠 + Windows 路径小写
ok("G1a `\\`→`/` + Windows 路径小写");
assert.equal(normalizeCwdKey("D:/repo/x/"), "d:/repo/x"); // 去尾 `/`
ok("G1b 去尾 `/`");
assert.equal(normalizeCwdKey("C:/a/b/c//"), "c:/a/b/c"); // 连续尾斜杠全去（中间连续斜杠不归一化）
ok("G1c 连续尾斜杠全去");
assert.equal(normalizeCwdKey("C:/Work/GreenCAD"), "c:/work/greencad");
assert.equal(normalizeCwdKey("c:\\work\\greencad"), "c:/work/greencad");
ok("G1d Windows 路径大小写/斜杠混写归一为同一键");
assert.equal(normalizeCwdKey("//SERVER/Share/Repo"), "//server/share/repo");
ok("G1e Windows UNC 路径大小写归一");
assert.equal(normalizeCwdKey(null), UNGROUPED_KEY);
assert.equal(normalizeCwdKey(""), UNGROUPED_KEY);
assert.equal(normalizeCwdKey("   "), UNGROUPED_KEY);
ok("G1f null/空 cwd → 未分组键");

// ── G2 分组 ──────────────────────────────────────────────────────
const failed = new Set(["id000000000002xxxxxxxx"]);
const g2 = sortGroups(
	groupSessions(
		[
			mk({ cwd: "C:\\work\\GreenCAD", mtimeMs: 300 }),
			mk({ cwd: "c:/WORK/greencad", mtimeMs: 500 }), // Windows 大小写/斜杠混写后同组
			mk({ cwd: null, mtimeMs: 900 }),
		],
		"updated",
		failed,
	),
);
assert.equal(g2.length, 2);
ok("G2a 同 cwd（Windows 大小写/斜杠混写）合并为一组 + 未分组一组");
const repo = g2.find((g) => g.key === "c:/work/greencad");
assert.ok(repo);
assert.equal(repo.count, 2);
assert.equal(repo.maxMtimeMs, 500);
assert.equal(repo.label, "GreenCAD"); // basename 显示名
assert.equal(repo.tooltip, "c:/work/greencad"); // 组头 tooltip = 归一化全路径
assert.equal(repo.ungrouped, false);
assert.equal(repo.hasError, true); // 组内含 failed 会话
ok("G2b 组 count/maxMtimeMs/basename/全路径 tooltip/hasError");
const un = g2.find((g) => g.key === UNGROUPED_KEY);
assert.ok(un);
assert.equal(un.label, "未分组");
assert.equal(un.ungrouped, true);
assert.equal(un.tooltip, undefined);
ok("G2c 未分组：label=「未分组」、ungrouped=true、tooltip=undefined");
const emptyCwd = groupSessions([mk({ cwd: "", mtimeMs: 1 }), mk({ cwd: null, mtimeMs: 2 })], "updated", new Set());
assert.equal(emptyCwd.length, 1);
assert.equal(emptyCwd[0].key, UNGROUPED_KEY);
assert.equal(emptyCwd[0].label, "未分组");
ok("G2c2 空 cwd 与 null 共同落入未分组");
const collisions = groupSessions(
	[mk({ cwd: "c:/a/shared", mtimeMs: 1 }), mk({ cwd: "d:/b/shared", mtimeMs: 2 })],
	"updated",
	new Set(),
);
assert.deepEqual(collisions.map((g) => g.key).sort(), ["c:/a/shared", "d:/b/shared"]);
assert.deepEqual(collisions.map((g) => g.label), ["shared", "shared"]);
ok("G2d 同 basename、不同全路径不互吞（以完整 cwd key 分组）");

// ── G3 排序 ──────────────────────────────────────────────────────
// 组序：B(900) > A(500) > 未分组(999 仍垫底)
const g3 = sortGroups(
	groupSessions(
		[
			mk({ cwd: "c:/a", mtimeMs: 500 }),
			mk({ cwd: "c:/b", mtimeMs: 900 }),
			mk({ cwd: null, mtimeMs: 999 }),
		],
		"updated",
		new Set(),
	),
);
assert.deepEqual(g3.map((g) => g.key), ["c:/b", "c:/a", UNGROUPED_KEY]);
ok("G3a 组序 = 组内 maxMtimeMs 降序，未分组恒垫底（即使其 mtime 最大）");
// 组内 updated：mtimeMs 降序（G2 双元素组显式断言）
const inner = g2.find((g) => g.key === "c:/work/greencad")!.sessions;
assert.deepEqual(inner.map((s) => s.mtimeMs), [500, 300]);
ok("G3b 组内 updated = mtimeMs 降序");
const fallbackUpdated = groupSessions(
	[
		mk({ cwd: "c:/fallback", mtimeMs: Number.NaN, startedAt: "2026-01-01T00:00:00.000Z" }),
		mk({ cwd: "c:/fallback", mtimeMs: 100, startedAt: "2025-01-01T00:00:00.000Z" }),
	],
	"updated",
	new Set(),
).at(0)!;
assert.equal(fallbackUpdated.sessions[0].startedAt, "2026-01-01T00:00:00.000Z");
assert.equal(fallbackUpdated.maxMtimeMs, Date.parse("2026-01-01T00:00:00.000Z"));
ok("G3b2 updated(mtimeMs) 缺失/损坏时回退 created(startedAt)，组活动取 max");
// 组内 created：startedAt 降序（无 startedAt → 0 排最后）
const g3c = groupSessions(
	[
		mk({ cwd: "c:/a", mtimeMs: 1, startedAt: "2025-01-01T00:00:00.000Z" }),
		mk({ cwd: "c:/a", mtimeMs: 2, startedAt: "2026-01-01T00:00:00.000Z" }),
		mk({ cwd: "c:/a", mtimeMs: 3 }),
	],
	"created",
	new Set(),
).at(0)!;
assert.deepEqual(g3c.sessions.map((s) => s.startedAt), [
	"2026-01-01T00:00:00.000Z",
	"2025-01-01T00:00:00.000Z",
	null,
]);
ok("G3c 组内 created = startedAt 降序，无 startedAt 排最后");

// ── G4 过滤谓词收窄 ──────────────────────────────────────────────
const f = mk({ cwd: "C:/work/GreenCAD", mtimeMs: 5, title: "台账标题" });
assert.equal(matchesSessionFilter(f, "reenCA"), true); // basename 命中（大小写不敏感）
ok("G4a basename(cwd) 命中（大小写不敏感）");
assert.equal(matchesSessionFilter(f, f.sessionId.slice(4, 10)), true); // shortId(12) 内部子串
ok("G4b shortId（前 12 位内）子串命中");
assert.equal(matchesSessionFilter(f, f.sessionId.slice(15)), false); // 超出前 12 位不命中
ok("G4c 全量 ID 超出前 12 位 → 不命中");
assert.equal(matchesSessionFilter(f, "台账"), true);
ok("G4d title 子串命中");
assert.equal(matchesSessionFilter(f, "work/GreenCAD"), false); // cwd 全路径不再命中
ok("G4e cwd 全路径 → 不命中（收窄）");
assert.equal(matchesSessionFilter(f, "没有的查询"), false);
ok("G4f 无命中 → false");
assert.equal(matchesSessionFilter(f, "  "), true); // 空白查询 = 空
ok("G4g 空白查询视同空 → 全匹配");

// ── G5 过滤后组内空 → 整组隐藏（含未分组）────────────────────────
const g5 = sortGroups(
	groupSessions(
		[
			mk({ cwd: "c:/a", mtimeMs: 100, title: "保留我" }),
			mk({ cwd: "c:/b", mtimeMs: 200 }),
			mk({ cwd: null, mtimeMs: 300 }),
		].filter((s) => matchesSessionFilter(s, "保留")),
		"updated",
		new Set(),
	),
);
assert.deepEqual(g5.map((g) => g.key), ["c:/a"]);
ok("G5 过滤后组内空 → 整组隐藏（c:/b 与未分组均消失）");

// ── G6 折叠持久化 ────────────────────────────────────────────────
lsBacking.clear();
assert.deepEqual(loadExpansionState(), {}); // 无数据 → 空
saveExpansionState({ "c:/a": false, "c:/b": true });
assert.deepEqual(loadExpansionState(), { "c:/a": false, "c:/b": true });
ok("G6a save→load 回读一致（saw-ws-expansion）");
assert.equal(lsBacking.get("saw-ws-expansion")?.includes('"c:/a"') === true, true);
ok("G6b 落盘 key = saw-ws-expansion");
const pruned = pruneExpansionState({ "c:/a": false, "c:/gone": false, "c:/open": true }, ["c:/a", "c:/open"]);
assert.deepEqual(pruned, { "c:/a": false });
assert.deepEqual(loadExpansionState(), { "c:/a": false }); // prune 后已落盘
ok("G6c prune 删失效键与冗余 true 键并落盘");
const manyCollapsed = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`c:/repo-${i}`, false]));
const manyKeys = Object.keys(manyCollapsed);
assert.equal(Object.keys(pruneExpansionState(manyCollapsed, manyKeys)).length, 500);
ok("G6c2 prune 硬上限 500，避免 localStorage 配额增长");
lsBacking.set("saw-ws-expansion", "{这不是JSON");
assert.deepEqual(loadExpansionState(), {}); // 坏 JSON → 空态
ok("G6d 坏 JSON 容错 → 空 Record");
lsBacking.set("saw-ws-expansion", "[1,2]");
assert.deepEqual(loadExpansionState(), {}); // 非对象 → 空态
ok("G6e 非对象（数组）容错 → 空 Record");
lsBacking.set("saw-ws-expansion", JSON.stringify({ "c:/a": "x", "c:/b": false }));
assert.deepEqual(loadExpansionState(), { "c:/b": false }); // 非布尔值丢弃
ok("G6f 非布尔值丢弃、合法布尔保留");
const workingStorage = globalThis.localStorage;
(globalThis as Record<string, unknown>).localStorage = {
	getItem: () => null,
	setItem: () => { throw new Error("QuotaExceededError"); },
};
assert.doesNotThrow(() => saveExpansionState({ "c:/a": false }));
assert.doesNotThrow(() => pruneExpansionState({ "c:/a": false }, ["c:/a"]));
(globalThis as Record<string, unknown>).localStorage = workingStorage;
ok("G6g localStorage 配额异常被吞掉，不影响 UI 交互");

// ── G8 组内排序维度持久化（saw-ws-sort，机制同 saw-ws-expansion，P1-3）────────
lsBacking.clear();
assert.equal(loadSortBy(), "updated"); // 无数据 → 默认 updated
ok("G8a 无数据 loadSortBy → 默认 updated");
saveSortBy("created");
assert.equal(loadSortBy(), "created"); // save→load 回读
assert.equal(lsBacking.get("saw-ws-sort"), JSON.stringify("created")); // 落盘 = JSON 单值
ok("G8b save→load 回读 created + 落盘 key = saw-ws-sort");
lsBacking.set("saw-ws-sort", "{这不是JSON");
assert.equal(loadSortBy(), "updated"); // 坏 JSON → 默认
ok("G8c 坏 JSON 容错 → 默认 updated");
lsBacking.set("saw-ws-sort", JSON.stringify("bogus"));
assert.equal(loadSortBy(), "updated"); // 非合法值（非 updated/created）→ 默认
ok("G8d 非合法值 → 默认 updated");
lsBacking.set("saw-ws-sort", JSON.stringify(123));
assert.equal(loadSortBy(), "updated"); // 非字符串类型 → 默认
ok("G8e 非字符串（数字）→ 默认 updated");
const workingStorage2 = globalThis.localStorage;
(globalThis as Record<string, unknown>).localStorage = {
	getItem: () => null,
	setItem: () => { throw new Error("QuotaExceededError"); },
};
assert.doesNotThrow(() => saveSortBy("updated")); // 写异常被吞
(globalThis as Record<string, unknown>).localStorage = workingStorage2;
ok("G8f localStorage 配额异常被吞掉，不影响 UI 交互");

// 附：basename/cwdLabel 迁入后行为不变
assert.equal(basename("C:\\w\\x\\y"), "y");
assert.equal(basename("C:/w"), "w");
assert.equal(basename(null), "");
assert.equal(cwdLabel(null), "未分组");
ok("G7 basename/cwdLabel 自 SessionList 迁入后行为不变");

// ── P 段：会话 rail 三件套 L3（置顶 / 每组最多 6 个 / 全 tab 组默认折叠）──
const { GROUP_VISIBLE_LIMIT, buildGroupDisplay, resolveGroupOpen } = await import("./workspaceGroup.ts");
const { loadRailExpand, saveRailExpand, pruneRailExpand, OVERFLOW_KEY, TABGROUP_KEY, MAX_PERSISTED_GROUPS } = await import(
	"./workspaceRailExpand.ts"
);

// P 段 fixture：直接构造（不走 mk 的 title 联动；可显式标 isScopeMaster/isMaster）
const raw = (id: string, cwd: string, o: Partial<SessionSummary> = {}): SessionSummary => ({
	sessionId: id,
	cwd,
	startedAt: o.startedAt ?? null,
	parentSession: null,
	file: `C:/pi/sessions/${id}.jsonl`,
	sizeBytes: 10,
	mtimeMs: o.mtimeMs ?? 1,
	...(o.title !== undefined ? { title: o.title, titleSource: o.titleSource ?? "first-user" } : {}),
	...(o.isScopeMaster === true ? { isScopeMaster: true } : {}),
	...(o.isMaster === true ? { isMaster: true } : {}),
});

// ── P1 置顶排序：isScopeMaster 行置顶，其余按现有组内序（buildGroupDisplay 纯函数）──
{
	const g = {
		key: "c:/r",
		label: "r",
		tooltip: "c:/r",
		cwd: "c:/r",
		ungrouped: false,
		count: 4,
		maxMtimeMs: 400,
		hasError: false,
		sessions: [
			raw("a1", "c:/r", { mtimeMs: 100 }),
			raw("a2", "c:/r", { mtimeMs: 400, isScopeMaster: true }), // 置顶（组内序第 2）
			raw("a3", "c:/r", { mtimeMs: 300 }),
			raw("a4", "c:/r", { mtimeMs: 200 }),
		],
	} as WorkspaceGroup;
	const d = buildGroupDisplay(g, false);
	assert.deepEqual(d.pinned.map((s) => s.sessionId), ["a2"]);
	assert.deepEqual(d.visible.map((s) => s.sessionId), ["a1", "a3", "a4"]); // 其余按现有组内序（mtime 降）
	assert.equal(d.hiddenCount, 0); // 非置顶 3 个 ≤ 6 → 无「还有 N 个」行
	ok("P1a 组内 isScopeMaster 行置顶（pinned），其余按现有组内序（visible）");
}
// P2 每组最多 6 个：非置顶行默认前 6，超出收进「还有 N 个」；置顶行不受截断影响
{
	const n = 10;
	const sessions = Array.from({ length: n }, (_, i) => raw(`b${i}`, "c:/r2", { mtimeMs: n - i }));
	sessions[7].isScopeMaster = true; // 第 8 新（mtime 第 3）为置顶
	const g = {
		key: "c:/r2",
		label: "r2",
		tooltip: "c:/r2",
		cwd: "c:/r2",
		ungrouped: false,
		count: n,
		maxMtimeMs: n,
		hasError: false,
		sessions,
	} as WorkspaceGroup;
	assert.equal(GROUP_VISIBLE_LIMIT, 6, "上限常量 = 6");
	const dClosed = buildGroupDisplay(g, false);
	assert.equal(dClosed.pinned.length, 1, "置顶行 1 个");
	assert.equal(dClosed.visible.length, 6, "收起态非置顶行 = 前 6（组内现有序）");
	assert.deepEqual(dClosed.visible.map((s) => s.sessionId), ["b0", "b1", "b2", "b3", "b4", "b5"]);
	assert.equal(dClosed.hiddenCount, 3, "超出 3 个 → 「还有 3 个 · 展开查看全部」");
	const dOpen = buildGroupDisplay(g, true);
	assert.equal(dOpen.visible.length, 9, "展开态非置顶行全量");
	assert.equal(dOpen.hiddenCount, 3, "展开态 hiddenCount 不变（行文案切「收起」）");
	ok("P2a 每组最多 6 个（非置顶前 6 + 「还有 N 个」）；展开态全量");
	// 置顶行不受 6 个截断影响：置顶 2 个 + 非置顶 8 个 → 置顶全显，非置顶前 6
	const sessions2 = Array.from({ length: 10 }, (_, i) => raw(`c${i}`, "c:/r3", { mtimeMs: 10 - i }));
	sessions2[0].isScopeMaster = true;
	sessions2[5].isScopeMaster = true;
	const g2 = { ...g, key: "c:/r3", label: "r3", tooltip: "c:/r3", cwd: "c:/r3", count: 10, sessions: sessions2 } as WorkspaceGroup;
	const d2 = buildGroupDisplay(g2, false);
	assert.deepEqual(d2.pinned.map((s) => s.sessionId).sort(), ["c0", "c5"], "置顶 2 行永远可见");
	assert.equal(d2.visible.length, 6);
	assert.equal(d2.hiddenCount, 2);
	ok("P2b 置顶行不受 6 个截断影响（2 置顶 + 前 6 非置顶 + 还有 2 个）");
}
// P3 全 tab 组首次加载默认折叠（titleSource==='ledger'）；用户显式展开后以持久化为准
{
	const tabSessions = [raw("t1", "c:/t", { title: "tab-1", titleSource: "ledger" }), raw("t2", "c:/t", { title: "tab-2", titleSource: "ledger" })];
	const gt = { key: "c:/t", label: "t", tooltip: "c:/t", cwd: "c:/t", ungrouped: false, count: 2, maxMtimeMs: 2, hasError: false, sessions: tabSessions } as WorkspaceGroup;
	assert.equal(resolveGroupOpen(gt, {}, {}), false, "首次加载（无持久化）→ 默认收起");
	assert.equal(resolveGroupOpen(gt, {}, { ["c:/t"]: true }), true, "用户展开后持久化 true → 展开（以持久化为准）");
	assert.equal(resolveGroupOpen(gt, {}, { ["c:/t"]: false }), false, "显式收起 → 收起");
	assert.equal(buildGroupDisplay(gt, false).allTab, true);
	ok("P3 全 tab 组（titleSource==='ledger'）首次加载默认折叠，用户展开后以持久化为准");
}
// P4 混合组不动：维持 saw-ws-expansion 现状（缺省展开、false=收起），不读 tab 展开 key
{
	const mixed = [raw("m1", "c:/m", { title: "台账", titleSource: "ledger" }), raw("m2", "c:/m", { title: "首问", titleSource: "first-user" })];
	const gm = { key: "c:/m", label: "m", tooltip: "c:/m", cwd: "c:/m", ungrouped: false, count: 2, maxMtimeMs: 2, hasError: false, sessions: mixed } as WorkspaceGroup;
	assert.equal(resolveGroupOpen(gm, {}, {}), true, "混合组首次加载 → 展开（现状不变）");
	assert.equal(resolveGroupOpen(gm, { ["c:/m"]: false }, {}), false, "用户收起 → 收起（saw-ws-expansion）");
	assert.equal(resolveGroupOpen(gm, {}, { ["c:/m"]: true }), true, "tab 展开 key 对混合组无效（缺省展开）");
	assert.equal(resolveGroupOpen(gm, { ["c:/m"]: false }, { ["c:/m"]: true }), false, "tab 展开 key 不能推翻混合组的显式收起");
	assert.equal(buildGroupDisplay(gm, false).allTab, false);
	ok("P4 混合组不动（缺省展开 / false=收起；tab 展开 key 不作用）");
}
// P5 rail 展开态持久化（saw-ws-overflow / saw-ws-tabgroups，机制同 saw-ws-expansion）
{
	lsBacking.clear();
	assert.deepEqual(loadRailExpand(OVERFLOW_KEY), {});
	saveRailExpand(OVERFLOW_KEY, { "c:/a": true, "c:/b": false });
	assert.deepEqual(loadRailExpand(OVERFLOW_KEY), { "c:/a": true }, "回读仅保留非缺省 true（false 冗余丢弃）");
	assert.deepEqual(loadRailExpand(TABGROUP_KEY), {}, "两 key 互不干扰");
	saveRailExpand(TABGROUP_KEY, { "c:/t": true });
	assert.deepEqual(loadRailExpand(TABGROUP_KEY), { "c:/t": true });
	ok("P5a save→load 回读（两 key 独立；仅保留 true）");
	assert.equal(lsBacking.get(OVERFLOW_KEY)?.includes('"c:/a"') === true, true, "落盘 key = saw-ws-overflow（save 原样落盘，冗余值由 prune/load 清理）");
	assert.equal(lsBacking.get(TABGROUP_KEY)?.includes('"c:/t"') === true, true, "落盘 key = saw-ws-tabgroups");
	ok("P5b 落盘 key 名正确（saw-ws-overflow / saw-ws-tabgroups）");
	const pruned = pruneRailExpand(OVERFLOW_KEY, { "c:/a": true, "c:/gone": true, "c:/x": false }, ["c:/a"]);
	assert.deepEqual(pruned, { "c:/a": true }, "prune 删失效键与冗余 false 并落盘");
	const many = Object.fromEntries(Array.from({ length: MAX_PERSISTED_GROUPS + 1 }, (_, i) => [`c:/r${i}`, true]));
	assert.equal(Object.keys(pruneRailExpand(OVERFLOW_KEY, many, Object.keys(many))).length, MAX_PERSISTED_GROUPS, "prune 500 上限");
	lsBacking.set(OVERFLOW_KEY, "{坏JSON");
	assert.deepEqual(loadRailExpand(OVERFLOW_KEY), {}, "坏 JSON 容错 → 空态");
	lsBacking.set(OVERFLOW_KEY, "[1]");
	assert.deepEqual(loadRailExpand(OVERFLOW_KEY), {}, "非对象容错");
	lsBacking.set(TABGROUP_KEY, JSON.stringify({ "c:/a": "x", "c:/b": true, "c:/c": 1 }));
	assert.deepEqual(loadRailExpand(TABGROUP_KEY), { "c:/b": true }, "非布尔值丢弃、合法 true 保留");
	const working = globalThis.localStorage;
	(globalThis as Record<string, unknown>).localStorage = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
	assert.doesNotThrow(() => saveRailExpand(OVERFLOW_KEY, { "c:/a": true }));
	assert.doesNotThrow(() => pruneRailExpand(OVERFLOW_KEY, { "c:/a": true }, ["c:/a"]));
	(globalThis as Record<string, unknown>).localStorage = working;
	ok("P5c prune 失效键/冗余 false + 500 上限 + 坏数据容错 + 写异常吞");
}

console.log(`_test_workspace_group: all assertions passed (${n})`);
