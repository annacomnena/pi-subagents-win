/**
 * gui/src/_test_connection_banner.ts — 断连横幅去抖测试（2026-11-17）
 *
 * 覆盖：
 * 1. 连接 up / 单次失败 / 双次失败 ⇒ 横幅不显示（消除「经常闪一下」）
 * 2. 连续 3 次 ⇒ retrying；连续 6 次 ⇒ reconnect（可操作指引）
 * 3. store 真实 markUp/markDown 计数：失败累加、成功清零
 *
 * 运行：node --experimental-strip-types ./gui/src/_test_connection_banner.ts
 */

import assert from "node:assert/strict";
import { register } from "node:module";

import { decideDisconnectBanner, DISCONNECT_BANNER_THRESHOLD, RECONNECT_HINT_THRESHOLD } from "./connectionBanner.ts";

// ── 1/2. 纯函数判据 ─────────────────────────────────────────────
assert.deepEqual(decideDisconnectBanner("up", 0), { visible: false, level: "none" }, "正常连接不显示");
assert.deepEqual(decideDisconnectBanner("down", 0), { visible: false, level: "none" }, "0 次失败不显示");
assert.deepEqual(decideDisconnectBanner("down", 1), { visible: false, level: "none" }, "单次失败不显示（关键去抖）");
assert.deepEqual(decideDisconnectBanner("down", 2), { visible: false, level: "none" }, "双次失败仍不显示");
assert.deepEqual(
	decideDisconnectBanner("down", DISCONNECT_BANNER_THRESHOLD),
	{ visible: true, level: "retrying" },
	"连续 3 次显示重试提示",
);
assert.deepEqual(
	decideDisconnectBanner("down", RECONNECT_HINT_THRESHOLD - 1),
	{ visible: true, level: "retrying" },
	"5 次仍是重试档",
);
assert.deepEqual(
	decideDisconnectBanner("down", RECONNECT_HINT_THRESHOLD),
	{ visible: true, level: "reconnect" },
	"连续 6 次升级为重新连接指引",
);
assert.deepEqual(decideDisconnectBanner("down", Number.NaN), { visible: false, level: "none" }, "非法计数不显示");
console.log("✓ 横幅判据：单次不闪 / 3 次重试 / 6 次重连指引");

// ── 3. store 真实计数 ───────────────────────────────────────────
register("../../extensions/_gui_store_ts_loader.mjs", import.meta.url);
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

useGui.setState({ connection: "up", downStreak: 0, lastAsOf: null });
useGui.getState().markDown("2026-11-17T02:00:00.000Z");
assert.equal(useGui.getState().downStreak, 1, "首次失败计数=1");
assert.equal(decideDisconnectBanner(useGui.getState().connection, useGui.getState().downStreak).visible, false);
useGui.getState().markDown("2026-11-17T02:00:02.000Z");
useGui.getState().markDown("2026-11-17T02:00:04.000Z");
assert.equal(useGui.getState().downStreak, 3);
assert.equal(decideDisconnectBanner(useGui.getState().connection, useGui.getState().downStreak).visible, true);
useGui.getState().markUp("2026-11-17T02:00:06.000Z");
assert.equal(useGui.getState().downStreak, 0, "成功后清零");
assert.equal(useGui.getState().connection, "up");
assert.equal(useGui.getState().lastAsOf, "2026-11-17T02:00:06.000Z", "成功更新数据新鲜度");
console.log("✓ store 计数：失败累加 / 成功清零");
