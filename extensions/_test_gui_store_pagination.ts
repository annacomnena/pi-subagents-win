/**
 * _test_gui_store_pagination.ts — G5.2 R3（plans/0921_G52_patch_review.md 必修 3）：
 * GUI timeline 历史翻页在 >2,000 条（>10 页）后仍严格向旧端推进、无重复请求，翻过的
 * 旧页不被 TIMELINE_CAP 尾切逐出，「已到最早」只在真实旧端出现（上限不误报）。
 *
 * 覆盖：
 *   P1 纯函数：mergeTimelineItems 去重/排序/精修覆盖；capTimelineItems live 段尾窗 +
 *      历史段（anchor 及更早）全保留；无 anchor 时整体尾窗裁剪。
 *   P2 store 集成：4,500 条（2000 live + 2500 历史 = 13 页）连按「加载更早」——
 *      before 游标严格向旧端推进、无重复请求、终态 timelineEnd 且历史页全保留（>cap）；
 *      end 后再按零请求；随后 pollTimeline（live 尾窗轮询）不逐出历史页。
 *
 * gui/src 无 node 可直连的测试框架（bundler 风格 extensionless imports）；用 module
 * customization hooks（_gui_store_ts_loader.mjs）补 `.ts` 解析后直接加载 zustand store，
 * api.timeline 打桩模拟 server 分页（timeline.ts 同款排他上界 + 前缀尾端 limit）。
 *
 * 运行：npm run test:gui-store
 */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./_gui_store_ts_loader.mjs", import.meta.url);

const { useGui, mergeTimelineItems, capTimelineItems } = await import("../gui/src/store.ts");
const { api } = await import("../gui/src/api/client.ts");

type TimelineItem = import("../gui/src/api/types.ts").TimelineItem;

let n = 0;
const ok = (name: string) => { n++; console.log(`ok ${n} - ${name}`); };
const AT0 = Date.UTC(2026, 8, 21, 0, 0, 0);

function makeItems(from: number, to: number): TimelineItem[] {
	const out: TimelineItem[] = [];
	for (let i = from; i < to; i++) {
		out.push({
			id: `ev_${String(i).padStart(5, "0")}`,
			at: new Date(AT0 + i * 1000).toISOString(),
			type: "run.completed",
			kind: "event",
			subject: `run://tab/x${i}`,
			summary: `v${i}`,
			source: "agent://runtime-host",
		});
	}
	return out;
}

// ── P1 纯函数 ──────────────────────────────────────────────────────
{
	const a = makeItems(0, 3);
	const refined = [{ ...a[1]!, summary: "refined" }];
	const merged = mergeTimelineItems(a, refined);
	assert.equal(merged.length, 3, "同 id 去重不增量");
	assert.equal(merged[1]!.summary, "refined", "incoming 精修版覆盖");
	assert.deepEqual(merged.map((t) => t.id), ["ev_00000", "ev_00001", "ev_00002"], "保持全序");

	const big = makeItems(0, 4500);
	const anchor = big[2500]!.id; // 历史段 = idx ≤ 2500（用户翻到的页），live 段 = 其后
	assert.equal(capTimelineItems(big, null).length, 2000, "无 anchor：整体尾窗裁剪（旧行为）");
	assert.equal(capTimelineItems(big, anchor), big, "live 段未超 cap → 原数组原样返回");
	assert.equal(capTimelineItems(makeItems(0, 4500), big[0]!.id).length, 2001, "anchor 在最旧：anchor + live 尾窗 2000");
	ok("merge/cap 纯函数：去重精修 + live 段容量 + 历史段保护");
}

// ── P2 store 集成：>2000 条（>10 页）翻页 ──────────────────────────
{
	const all = makeItems(0, 4500); // 2000 live 尾窗 + 2500 历史（ceil(2500/200)=13 页）
	const live = all.slice(-2000);
	const requests: (string | undefined)[] = [];
	let pollTimelineHits = 0;
	(api as { timeline: unknown }).timeline = async (limit: number, before?: string) => {
		requests.push(before);
		if (before === undefined) pollTimelineHits++;
		const idx = before ? all.findIndex((t) => t.id === before) : all.length;
		if (idx < 0) return { ok: false, status: 404, resync: false, at: new Date(AT0).toISOString() };
		// server timeline.ts 同款：排他上界 slice(0, idx) + 前缀尾端 limit
		const page = all.slice(Math.max(0, idx - limit), idx);
		return { ok: true, status: 200, data: { version: 1 as const, count: page.length, timeline: page }, at: new Date(AT0).toISOString() };
	};

	useGui.setState({ timeline: live, timelineEnd: false, beforeCursor: null, historyAnchorId: null, nextCursor: "0" });

	// 连按到 end（幂等可重按）
	let presses = 0;
	while (!useGui.getState().timelineEnd && presses < 40) {
		await useGui.getState().loadEarlierTimeline();
		presses++;
	}
	assert.equal(presses, 13, `恰 13 页到旧端（实按 ${presses}）`);
	assert.equal(requests.length, 13, "无重复请求：每次按键恰一次 fetch");
	assert.equal(new Set(requests).size, requests.length, "游标零重复（旧实现会原地打转）");
	// 严格向旧端推进：id 零填充字典序 = 全序，逐次严格递减
	assert.equal(requests[0], live[0]!.id, "首按从 live 最旧推导（推导后即独立游标）");
	for (let i = 1; i < requests.length; i++) {
		assert.ok(requests[i]! < requests[i - 1]!, `cursor 严格向旧端推进 #${i}`);
	}
	// 翻过的旧页保留：总量超 cap 且含最旧条目
	const s = useGui.getState();
	assert.equal(s.timeline.length, 4500, "历史页全保留（4500 > TIMELINE_CAP 2000）");
	assert.equal(s.timeline[0]!.id, "ev_00000", "最旧条目在位");
	assert.equal(s.beforeCursor, "ev_00000", "终态游标 = 旧端");
	assert.equal(s.timelineEnd, true, "真实旧端才置 timelineEnd");

	// end 后再按 → no-op 零请求
	const reqsAtEnd = requests.length;
	await useGui.getState().loadEarlierTimeline();
	assert.equal(requests.length, reqsAtEnd, "timelineEnd 后 loadEarlier 零请求");

	// live 尾窗轮询不逐出历史页（anchor 保护；此处 fetch 的是已载入的最新 200 条）
	await useGui.getState().pollTimeline();
	assert.equal(pollTimelineHits, 1, "pollTimeline 走同一打桩端点");
	assert.equal(useGui.getState().timeline.length, 4500, "自动轮询后历史页仍在（不被尾切逐出）");
	assert.equal(useGui.getState().timeline[0]!.id, "ev_00000");
	ok(">2000 条（13 页）：cursor 严格推进 + 无重复请求 + 旧页保留 + end 语义诚实");
}

// ── P3 resync 复位：游标/边界/终态归零，可重新翻页且不误报最早 ──────
{
	// 模拟 409 resync：pollEvents 收到 resync 错误 → 拉 snapshot 重建
	const all = makeItems(0, 3000);
	const requests: (string | undefined)[] = [];
	(api as { timeline: unknown }).timeline = async (limit: number, before?: string) => {
		requests.push(before);
		const idx = before ? all.findIndex((t) => t.id === before) : all.length;
		if (idx < 0) return { ok: false, status: 404, resync: false, at: new Date(AT0).toISOString() };
		const page = all.slice(Math.max(0, idx - limit), idx);
		return { ok: true, status: 200, data: { version: 1 as const, count: page.length, timeline: page }, at: new Date(AT0).toISOString() };
	};
	(api as { events: unknown }).events = async () => ({
		ok: false,
		status: 409,
		resync: true,
		at: new Date(AT0).toISOString(),
	});
	(api as { snapshot: unknown }).snapshot = async () => ({
		ok: true,
		status: 200,
		data: { timeline: all.slice(-200), events: [], attention: [], health: {} } as never,
		at: new Date(AT0).toISOString(),
	});

	useGui.setState({ timeline: all.slice(-2000), timelineEnd: true, beforeCursor: "ev_00000", historyAnchorId: "ev_01000" });
	await useGui.getState().pollEvents();
	const s = useGui.getState();
	assert.equal(s.beforeCursor, null, "resync 复位游标");
	assert.equal(s.historyAnchorId, null, "resync 复位边界");
	assert.equal(s.timelineEnd, false, "resync 复位终态（重建后旧端未知，不误报已到最早）");
	assert.equal(s.timeline.length, 200);
	await useGui.getState().loadEarlierTimeline();
	assert.equal(requests[0], all[2800]!.id, "复位后首按从新最旧（重建尾窗 ev_02800）重新推导");
	ok("resync 复位：不误报已到最早，翻页从头重推");
}

useGui.setState({ timeline: [], timelineEnd: false, beforeCursor: null, historyAnchorId: null });
console.log(`\n# pass ${n}`);
