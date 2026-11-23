/**
 * _test_right_rail.ts — 右侧栏 P1B（「派发」面板 + 壳 + 门控 + 时长双口径）的测试。
 *
 * ## 为什么是纯函数 + 源码断言（本仓 gui 的既有范式）
 *
 * gui 没有 DOM 测试框架；`node --experimental-strip-types` 不转 JSX ⇒ `.tsx` 只能做**源码串断言**。
 * 所以本题把「必须被断言判死」的判据全部放进可直载文件：
 *   · `rightRail/railState.ts`（门控真值表 / 空态三态 / 注册表解析 / 默认展开）
 *   · `runsView.ts`（时长双口径 / formatUsage 含 turns —— 与「运行」页共享同一个格式化器）
 *   · `api/runsScope.ts` + `api/client.ts`（sessionId 规范化：query 与 ETag cache key 同一串）
 * `.tsx` 侧只断言**接线**（用了哪个函数、没用什么反例写法），因为接线错了纯函数全绿也没用。
 *
 * 覆盖（对应设计稿 §5 验收 6–14）：
 *   RR1 时长双口径：终态 `durationMs` **不随 now 增长**（反向断言：改成 now−startedAt 必红）；
 *       运行中 `now−startedAt` 标「至今」；无值「—」（不反推 endedAt）；**不读 lastActivity**
 *   RR2 三种空态文案分开（no-dispatch / attribution-partial / attribution-unavailable）
 *   RR3 sessionId 规范化：去重 + locale 无关排序；同一规范化串=同一 ETag 缓存槽（真调 `api.runs`）
 *   RR4 unknown ≠ 运行中：徽标走 `deriveRunDisplay`；面板不得裸判 `status === "running"`
 *   RR5 门控真值表：5 个条件逐条缺失都必须 false（变异 `return true` 必红）
 *   RR6 注册表可扩展：加假面板不用改壳（壳里没有任何面板 id/名）
 *   RR7 面板接线：`usePoll(..., 5000, gate)` / 无裸 setInterval / 带 sid / 丢弃迟到响应 / 新鲜度=本地时钟
 *   RR8 formatUsage 含 turns（与 RunsPage 同一格式器）
 *   RR9 反例修复：RunsPage 裸 setInterval → usePoll 门控
 *   RR10 默认展开（≥1280px）+ 内存态（不持久化）+ IA 不变（TabId/PAGES 未改）
 *   RR11 可拖拽宽度：默认/最小/上限、视口钳制、localStorage 容错、pointer/keyboard 接线
 *
 * 运行：npm run test:gui-right-rail
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

// gui/src 按 vite/bundler 惯例 extensionless 相对导入 → 复用 store 测试 resolve hook 补 .ts
register("../../extensions/_gui_store_ts_loader.mjs", import.meta.url);

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(join(here, rel), "utf8");

/**
 * 去掉注释后再做「代码里有没有用到 X」的断言。
 * 没有这一步时，一句「绝不能用 lastActivity」的注释会让断言假红（反之注释也可能让断言假绿）。
 */
function codeOnly(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const railState = await import("./rightRail/railState.ts");
const {
	MAIN_MIN_WIDTH,
	PANEL_DISPATCHED,
	PANEL_NOTE,
	RAIL_DEFAULT_WIDTH,
	RAIL_MAX_WIDTH,
	RAIL_MIN_WIDTH,
	RAIL_WIDTH_STORAGE_KEY,
	RAIL_WIDE_QUERY,
	SIDEBAR_WIDTH,
	attributionNotice,
	clampRailWidth,
	loadRailWidth,
	pickDispatchedEmpty,
	railMaxWidth,
	railOpenDefault,
	railPanelById,
	railPollingEnabled,
	saveRailWidth,
} = railState;
const { formatUsage, runDurationDisplay, fmtDuration, deriveRunDisplay } = await import("./runsView.ts");
const { normalizeSessionScope, sessionScopeParam } = await import("./api/runsScope.ts");
const { api } = await import("./api/client.ts");
import type { RunCard, RunUsage, RunsResponse } from "./api/types.ts";

let n = 0;
const ok = (name: string): void => {
	n += 1;
	console.log(`ok ${n} - ${name}`);
};

/** RunCard 夹具：字段形状与 `subagent-kill.ts::listAsyncRunCards` 的输出一致（AGENTS §5）。 */
const card = (over: Partial<RunCard>): RunCard => ({
	id: over.id ?? "run_x",
	agent: over.agent ?? "implementer",
	taskPreview: over.taskPreview ?? "鸿业读侧三处缺陷修复",
	status: over.status ?? "running",
	liveness: over.liveness ?? "unknown",
	pid: over.pid ?? null,
	startedAt: over.startedAt ?? "2026-10-26T06:00:00.000Z",
	lastActivity: over.lastActivity ?? "2026-10-26T06:01:00.000Z",
	usage: over.usage ?? null,
	durationMs: over.durationMs ?? null,
	...(over.dispatchedBy !== undefined ? { dispatchedBy: over.dispatchedBy } : {}),
	...(over.recentCalls !== undefined ? { recentCalls: over.recentCalls } : {}),
	...(over.loopVerdict !== undefined ? { loopVerdict: over.loopVerdict } : {}),
});

/** RunsResponse 夹具（attribution 三态按服务端实际字段）。 */
const runsResp = (over: Partial<RunsResponse>): RunsResponse => ({
	version: 1,
	asof: "2026-10-26T06:10:00.000Z",
	count: over.runs?.length ?? 0,
	total: over.total ?? over.runs?.length ?? 0,
	attribution: over.attribution ?? "complete",
	attributionDetail: over.attributionDetail ?? { resolved: 0, tabUnmapped: 0, missing: 0, conflict: 0 },
	runs: over.runs ?? [],
});

// ═══════════════════════════════════════════════════════════════════════
// RR1 时长双口径
// ═══════════════════════════════════════════════════════════════════════
{
	const T0 = Date.parse("2026-10-26T06:00:00.000Z");
	// 728000ms = 12 分 08 秒（设计稿 §3.5 的示例时长）
	const terminal = card({ status: "completed", startedAt: "2026-10-26T05:00:00.000Z", durationMs: 728_000 });
	const at0 = runDurationDisplay(terminal, T0);
	const at1 = runDurationDisplay(terminal, T0 + 10 * 3600_000);

	assert.equal(at0.kind, "lastAttempt", "终态用末次尝试口径");
	assert.equal(at0.ms, 728_000, "终态数值 = durationMs 原值");
	assert.equal(at0.text, "末次 12 分 08 秒", `终态文案（实际 ${at0.text}）`);
	assert.equal(at0.text, at1.text, "终态时长**不随 now 增长**（反向断言：实现若改成 now−startedAt 此处必红）");
	assert.equal(at0.ms, at1.ms, "终态数值不随 now 变化");
	assert.ok(at0.label.includes("末次尝试"), `标签必须写明「末次尝试」（实际 ${at0.label}）`);
	ok("RR1a 终态 = durationMs（12 分 08 秒），且 10 小时后重渲染仍同值同串");

	// 反向断言：若有人把终态改成 now−startedAt，1 小时后「已跑」会变；这里钉死它不变
	const startedAgo = Date.parse("2026-10-26T05:00:00.000Z");
	assert.notEqual(at1.text, fmtDuration(T0 + 10 * 3600_000 - startedAgo), "终态串不得等于 now−startedAt 的口径");
	ok("RR1b 反向：终态串 ≠「now − startedAt」串（防把末次尝试显示成已跑时长）");

	// 运行中：now − startedAt，标「至今」
	const running = card({ status: "running", startedAt: "2026-10-26T06:00:00.000Z", durationMs: null });
	const r1 = runDurationDisplay(running, Date.parse("2026-10-26T06:00:01.000Z"));
	const r2 = runDurationDisplay(running, Date.parse("2026-10-26T06:12:08.000Z"));
	assert.equal(r1.kind, "elapsed");
	assert.equal(r1.text, "已跑 1 秒（至今）", `运行中文案（实际 ${r1.text}）`);
	assert.equal(r2.text, "已跑 12 分 08 秒（至今）", `运行中随 now 增长（实际 ${r2.text}）`);
	assert.ok(r2.ms !== null && r1.ms !== null && r2.ms > r1.ms, "运行中数值随时间增长");
	ok("RR1c 运行中 = now − startedAt，文案带「至今」且随本地时钟增长");

	// 运行中即便带了 durationMs 也不采用（口径按 status 分流，不按字段有没有值猜）
	const runningWithDur = card({ status: "running", startedAt: "2026-10-26T06:00:00.000Z", durationMs: 5_000 });
	assert.equal(runDurationDisplay(runningWithDur, Date.parse("2026-10-26T06:01:00.000Z")).text, "已跑 1 分 00 秒（至今）");
	ok("RR1d 运行中忽略 durationMs（只按 status 分流，不猜）");

	// noDur 之后：`running` 但 pid 已死 ⇒ 文案不得写「至今」（否则与「进程已退出」徽标互相矛盾）
	const deadRunning = card({ status: "running", startedAt: "2026-10-26T06:00:00.000Z", durationMs: null, liveness: "dead" });
	const dr = runDurationDisplay(deadRunning, Date.parse("2026-10-26T06:12:08.000Z"));
	assert.equal(dr.text, "已跑 12 分 08 秒（进程已退出）", `dead 运行中文案（实际 ${dr.text}）`);
	assert.ok(!dr.text.includes("至今"), "dead 时不得声称「至今」");
	assert.ok(dr.label.includes("不代表它还在跑"), `dead 标签必须澄清（实际 ${dr.label}）`);
	ok("RR1e running+dead ⇒ 文案为「已跑 …（进程已退出）」，不写「至今」（徽标与时长不矛盾）");

	// 无 durationMs ⇒ 「—」，**不反推** startedAt/endedAt
	const noDur = card({ status: "failed", startedAt: "2026-10-26T05:00:00.000Z", durationMs: null });
	const nd = runDurationDisplay(noDur, T0);
	assert.equal(nd.kind, "none");
	assert.equal(nd.ms, null);
	assert.equal(nd.text, "—", "无 durationMs ⇒「—」（终态不反推）");
	assert.equal(
		runDurationDisplay(card({ status: "completed", durationMs: undefined as unknown as null }), T0).text,
		"—",
		"旧记录（服务端无 durationMs 字段）也是「—」",
	);
	assert.equal(
		runDurationDisplay({ status: "running", startedAt: null, durationMs: null }, T0).text,
		"—",
		"运行中无 startedAt ⇒「—」（不拿 now 当起点）",
	);
	ok("RR1e 无值 ⇒「—」（不反推 endedAt/startedAt）");

	// lastActivity 绝不参与时长：给一个极早/极晚的 lastActivity，输出必须一字不变
	const base = card({ status: "completed", durationMs: 60_000 });
	const weird = { ...base, lastActivity: "1999-01-01T00:00:00.000Z" };
	const weird2 = { ...base, lastActivity: "2099-01-01T00:00:00.000Z" };
	assert.equal(runDurationDisplay(weird, T0).text, runDurationDisplay(base, T0).text);
	assert.equal(runDurationDisplay(weird2, T0).text, runDurationDisplay(base, T0).text);
	assert.ok(!/\.lastActivity\b/.test(codeOnly(read("runsView.ts"))), "runsView.ts 代码里不得**读** lastActivity 属性（终态它是 startedAt 兜底伪值；标语里提到它不算读）");
	ok("RR1f lastActivity 不参与时长（夹具两个极端值输出不变 + 源码零引用）");

	// fmtDuration 边界
	assert.equal(fmtDuration(999), "999 毫秒");
	assert.equal(fmtDuration(1_500), "1 秒");
	assert.equal(fmtDuration(59_000), "59 秒");
	assert.equal(fmtDuration(60_000), "1 分 00 秒");
	assert.equal(fmtDuration(3_600_000), "1 时 00 分");
	assert.equal(fmtDuration(-5), "0 秒", "负值归 0，不抛");
	assert.equal(fmtDuration(Number.NaN), "0 秒", "NaN 归 0，不抛");
	ok("RR1g fmtDuration 边界（毫秒/秒/分秒补零/时分/负值/NaN）");
}

// ═══════════════════════════════════════════════════════════════════════
// RR2 三种空态文案必须分开
// ═══════════════════════════════════════════════════════════════════════
{
	const noSession = pickDispatchedEmpty({ hasSession: false, resp: null, failed: false });
	assert.equal(noSession?.kind, "no-dispatch");
	assert.equal(noSession?.text, "本会话暂无派发");

	const loading = pickDispatchedEmpty({ hasSession: true, resp: null, failed: false });
	assert.equal(loading, null, "加载中不是空态（面板另给「正在加载」）");

	const failedNoData = pickDispatchedEmpty({ hasSession: true, resp: null, failed: true });
	assert.equal(failedNoData?.kind, "attribution-unavailable");
	assert.equal(failedNoData?.text, "归属信息不可用（读取失败）");

	const unavailable = pickDispatchedEmpty({
		hasSession: true,
		resp: runsResp({ attribution: "unavailable", attributionDetail: { resolved: 0, tabUnmapped: 0, missing: 0, conflict: 0 } }),
		failed: false,
	});
	assert.equal(unavailable?.kind, "attribution-unavailable", "attribution=unavailable 也是「读失败」，不是「没派发」");

	const partial = pickDispatchedEmpty({
		hasSession: true,
		resp: runsResp({ attribution: "partial", attributionDetail: { resolved: 3, tabUnmapped: 7, missing: 0, conflict: 0 } }),
		failed: false,
	});
	assert.equal(partial?.kind, "attribution-partial");
	assert.equal(partial?.text, "归属不完整（另有 7 条 tab 来源未关联）", "N 取 attributionDetail.tabUnmapped");

	const reallyNone = pickDispatchedEmpty({ hasSession: true, resp: runsResp({}), failed: false });
	assert.equal(reallyNone?.kind, "no-dispatch");
	assert.equal(reallyNone?.text, "本会话暂无派发");

	// 有数据 ⇒ 不是空态
	const withRuns = pickDispatchedEmpty({ hasSession: true, resp: runsResp({ runs: [card({})] }), failed: false });
	assert.equal(withRuns, null, "有数据不渲染空态");

	// 三句文案互不相同（这是「必须分开」的字面判据）
	const texts = new Set([noSession!.text, failedNoData!.text, partial!.text]);
	assert.equal(texts.size, 3, `三种空态文案必须互不相同（实际 ${[...texts].join(" | ")}）`);
	assert.ok(!failedNoData!.hint.includes("没有派发") || failedNoData!.hint.includes("不是「没有派发」"), "读失败必须解释「不是没有派发」");
	ok("RR2 空态三态：本会话暂无派发 / 归属不完整（N）/ 归属信息不可用（读取失败），互不相同");

	// 非空列表时的归属提示（partial/unavailable 仍要说出来）
	assert.equal(attributionNotice(runsResp({ runs: [card({})], attribution: "complete" })), null);
	assert.equal(
		attributionNotice(runsResp({ runs: [card({})], attribution: "partial", attributionDetail: { resolved: 1, tabUnmapped: 4, missing: 0, conflict: 0 } })),
		"归属不完整（另有 4 条 tab 来源未关联）",
	);
	assert.ok(attributionNotice(runsResp({ runs: [card({})], attribution: "unavailable" }))?.includes("归属信息不可用"));
	assert.equal(attributionNotice(runsResp({})), null, "空列表归 pickDispatchedEmpty 管，不重复提示");
	ok("RR2b 非空列表的归属提示（partial/unavailable 不静默）");
}

// ═══════════════════════════════════════════════════════════════════════
// RR3 sessionId 规范化（query 与 ETag cache key 同一串）
// ═══════════════════════════════════════════════════════════════════════
{
	assert.deepEqual(normalizeSessionScope(["b", "a"]), ["a", "b"], "排序（locale 无关的 sort）");
	assert.deepEqual(normalizeSessionScope(["a", "a", "b"]), ["a", "b"], "去重");
	assert.deepEqual(normalizeSessionScope(["", "  ", null, undefined]), [], "空 token 全丢");
	assert.deepEqual(normalizeSessionScope(["a b"]), [], "含空格（非法字符）丢弃");
	assert.deepEqual(normalizeSessionScope(["tab_abc-1.2:x"]), ["tab_abc-1.2:x"], "允许字符集 [A-Za-z0-9_.:-]");
	assert.equal(normalizeSessionScope(["c", "b", "a", "e", "d", "f"]).length, 5, "上限 5 个 token（与服务端一致）");
	assert.equal(sessionScopeParam(["b", "a"]), "a,b", "规范化串");
	assert.equal(sessionScopeParam(["a", "b"]), "a,b", "顺序无关 ⇒ 同一串 ⇒ 同一 ETag 缓存槽");
	assert.equal(sessionScopeParam([]), null, "无有效 id ⇒ 不带参数（= 本机全量，不是空串 400）");
	assert.equal(sessionScopeParam([null]), null);
	ok("RR3a normalizeSessionScope：去重 + 升序 + 非法丢弃 + 上限 5；无 id ⇒ null");

	// 真调 `api.runs`（真实入口，不是复制一份 URL 逻辑）：用 stub fetch 观察 URL 与 INM 头
	const calls: { url: string; inm: string | null }[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		const headers = (init?.headers ?? {}) as Record<string, string>;
		const inm = headers["if-none-match"] ?? null;
		calls.push({ url, inm });
		const mk = (status: number, body: unknown, etag?: string) => ({
			status,
			ok: status >= 200 && status < 300,
			headers: { get: (k: string) => (k.toLowerCase() === "etag" ? (etag ?? null) : null) },
			json: async () => body,
		});
		if (inm !== null) return mk(304, null, inm);
		return mk(200, runsResp({ runs: [card({ id: "run_scope" })] }), '"etag-scope"');
	}) as unknown as typeof fetch;

	try {
		const first = await api.runs({ sessionId: "b,a", limit: 50, includeRecentCalls: true });
		const second = await api.runs({ sessionId: "a,b", limit: 50, includeRecentCalls: true });
		assert.equal(calls.length, 2);
		assert.ok(calls[0]!.url.includes("sessionId=a%2Cb"), `query 用规范化串（实际 ${calls[0]!.url}）`);
		assert.equal(calls[0]!.url, calls[1]!.url, "两种书写顺序得到同一 URL");
		assert.equal(calls[0]!.inm, null, "首拍不带 If-None-Match");
		assert.equal(calls[1]!.inm, '"etag-scope"', "第二拍带上了第一拍的 ETag ⇒ 两者共用同一缓存槽（cache key 也是规范化串）");
		assert.equal(first.ok && second.ok, true);
		assert.equal(second.ok && first.ok && second.data === first.data, true, "304 ⇒ 复用上次 200 的同一对象引用");

		// 非法/空 id ⇒ 不带 sessionId 参数（服务端「本机全量」语义，不是 400 空串）
		calls.length = 0;
		await api.runs({ sessionId: "" });
		assert.ok(!calls[0]!.url.includes("sessionId"), `空 id 不拼参数（实际 ${calls[0]!.url}）`);
	} finally {
		globalThis.fetch = realFetch;
	}
	ok("RR3b api.runs 真实接线：query/ETag key 同为规范化串，`b,a` 与 `a,b` 共用缓存并 304 复用引用");

	// 服务端同规则的静态核对（不许在这里另写一套规则）
	const serverSrc = read("../../extensions/runtime-host/server.ts");
	assert.ok(serverSrc.includes('return [...new Set(tokens)].sort();'), "服务端规范化 = 去重 + sort()（客户端必须同式）");
	assert.ok(read("api/runsScope.ts").includes("[...new Set(tokens)].sort()"), "客户端规范化与之一致");
	ok("RR3c 客户端与服务端规范化实现同式（去重 + locale 无关 sort）");
}

// ═══════════════════════════════════════════════════════════════════════
// RR4 unknown ≠ 运行中（判据不漂移）
// ═══════════════════════════════════════════════════════════════════════
{
	const unknown = deriveRunDisplay(card({ status: "running", liveness: "unknown" }));
	assert.equal(unknown.countsAsRunning, false);
	assert.equal(unknown.label, "状态未知", "running + 无 pid ⇒「状态未知」，不是「运行中」");
	assert.notEqual(unknown.label, "运行中");

	const alive = deriveRunDisplay(card({ status: "running", liveness: "alive" }));
	assert.equal(alive.label, "运行中");
	assert.equal(alive.countsAsRunning, true);
	ok("RR4a 徽标真身：running+unknown ⇒「状态未知」（不计运行中）；running+alive ⇒「运行中」");

	const panelCode = codeOnly(read("rightRail/DispatchedPanel.tsx"));
	assert.ok(panelCode.includes("deriveRunDisplay(run)"), "面板徽标必须走 deriveRunDisplay");
	assert.ok(panelCode.includes("TONE_TO_BADGE[display.tone]"), "色调也走共享映射（不在面板里自建）");
	assert.ok(!/run\.status\s*===?\s*"running"/.test(panelCode), "面板不得裸判 run.status === \"running\"（变异点）");
	assert.ok(!/\.status\s*===\s*"running"/.test(panelCode), "面板不得以任何形式裸判 status");
	ok("RR4b 源码：面板只用 deriveRunDisplay，零裸 status 判定（反向断言：换成裸 status ⇒ 本组红）");

	// 「运行中」计数若在右栏出现也必须走 countsAsRunning（本 P1 未做徽标，锁住口径不被绕过）
	assert.ok(!/runningCount|countsAsRunning/.test(panelCode) || panelCode.includes("deriveRunDisplay"), "若引入计数必须仍经 deriveRunDisplay");
	ok("RR4c 右栏未自造运行中计数（徽标留 P2，口径入口已锁定）");

	// 旧 host 静默失效保护（AGENTS R-2）：响应缺 attribution 字段 ⇒ 端口未重启、`?sessionId=` 被忽略，
	// 此时列表是全机记录，必须显式告警（否则别人的 run 会被当成本会话派发）。
	const panelSrc = read("rightRail/DispatchedPanel.tsx");
	assert.ok(/staleServer/.test(panelSrc), "面板必须有 staleServer 判定");
	assert.ok(/attribution\??:\s*unknown/.test(panelSrc) && /\.attribution\s*!==\s*"string"/.test(panelSrc), "判定信号 = 响应缺 attribution 字段");
	assert.ok(panelSrc.includes("runtime-host restart"), "告警文案必须给出修复动作（/runtime-host restart）");
	assert.ok(!/attribution: "complete"/.test(panelSrc), "不得把缺失 attribution 当 complete");
	ok("RR4d 旧 host（响应无 attribution）⇒ 显式告警「当前是全机记录」，不静默冒充本会话");
}

// ═══════════════════════════════════════════════════════════════════════
// RR5 门控真值表
// ═══════════════════════════════════════════════════════════════════════
{
	const base = {
		railOpen: true,
		railPanel: PANEL_DISPATCHED,
		chatActiveId: "sid-a",
		activeTab: "chat",
		runtimeOverlay: null,
	};
	assert.equal(railPollingEnabled(base), true, "五条件全满足 ⇒ 轮询");
	assert.equal(railPollingEnabled({ ...base, railPanel: PANEL_NOTE }), true, "note 面板同样要轮询（放宽门控的正例；反例 other 仍必须 false）");
	const negatives: [string, Record<string, unknown>][] = [
		["右栏收起", { railOpen: false }],
		["当前面板非派发", { railPanel: "other" }],
		["无活动会话(null)", { chatActiveId: null }],
		["无活动会话(空串)", { chatActiveId: "" }],
		["非对话视图(timeline)", { activeTab: "timeline" }],
		["覆盖层已开(runs)", { runtimeOverlay: "runs" }],
		["覆盖层已开(attention)", { runtimeOverlay: "attention" }],
	];
	for (const [why, patch] of negatives) {
		assert.equal(
			railPollingEnabled({ ...base, ...(patch as Partial<typeof base>) }),
			false,
			`门控必须为 false：${why}（变异把 enabled 恒置 true ⇒ 本行红）`,
		);
	}
	ok(`RR5 门控真值表：正例 1 + 反例 ${negatives.length}（展开∧面板∧会话∧chat∧无覆盖层）`);

	// 面板侧必须把这条判据接到 usePoll 的第三参上（纯函数绿了但没接线等于没做）
	const panelCode = codeOnly(read("rightRail/DispatchedPanel.tsx"));
	assert.ok(panelCode.includes("railPollingEnabled({"), "面板把门控输入交给 railPollingEnabled");
	assert.ok(panelCode.includes("usePoll(refresh, RAIL_POLL_MS, enabled)"), "usePoll 第三参 = enabled（boolean）");
	assert.ok(!/usePoll\([^)]*,\s*true\s*\)/.test(panelCode), "不得常量开轮询");
	assert.ok(panelCode.includes("const RAIL_POLL_MS = 5000;"), "档位 5s");
	ok("RR5b 接线：门控结果进 usePoll 第三参（接口要求 boolean，5s 档）");
}

// ═══════════════════════════════════════════════════════════════════════
// RR5c 会话便签面板（2026-11-17 P2）：接线 + 串台防护 + 冲突不覆盖
// ═══════════════════════════════════════════════════════════════════════
{
	const code = codeOnly(read("rightRail/NotePanel.tsx"));
	assert.ok(code.includes("railPollingEnabled({"), "NotePanel 门控走共享 railPollingEnabled");
	assert.ok(code.includes("usePoll(refresh, RAIL_POLL_MS, enabled)"), "usePoll 第三参 = enabled（不是常量 true）");
	assert.ok(!/usePoll\([^)]*,\s*true\s*\)/.test(code), "不得常量开轮询");
	// 2026-11-18：实现已从 `!dirty` 收紧到 `!editing && saveState !== "conflict"`（刚聚焦未输入
	// 也不能被轮询换掉光标下文本；冲突态更不能被远端覆盖）。断言跟着真实接线走，仍钉死意图。
	assert.ok(
		code.includes('const enabled = railEnabled && !editing && saveState !== "conflict";'),
		"编辑中/冲突时暂停轮询，避免把草稿冲掉",
	);
	assert.ok(code.includes("useGui.getState().chatActiveId !== sid"), "迟到响应必须按 sid 丢弃（切会话不串台）");
	assert.ok(code.includes("<Markdown text={note.text} />"), "只读态走零依赖 Markdown 渲染（不是纯文本）");
	assert.ok(code.includes("setEditing(true)"), "点正文/按 Enter 进入编辑态");
	assert.ok(!code.includes("setTimeout"), "不得自动保存（无 debounce 写盘）");
	assert.ok(code.includes("onClick={commitSave}"), "写盘必须由显式点击触发");
	assert.ok(code.includes("e.key === \"Enter\""), "Ctrl+Enter 键盘保存路径存在");
	assert.ok(code.includes("onClick={() => void sendToSession()}"), "发送按钮接到 sendToSession");
	assert.ok(code.includes("await save(sid, text, box.note.version, true)"), "发送前必须先落盘（keepEditing）");
	assert.ok(code.includes("api.sessionMessage(sid, text, undefined, newCommandKey(\"note\"), true)"), "发送走 session.message + 独立 commandKey");
	assert.ok(code.includes("r.data.status === \"accepted\""), "只认服务端 accepted 回执，不把 HTTP 200 当成功");
	assert.ok(code.includes("onClick={reload}"), "取消 / 重新载入出口存在");
	assert.ok(code.includes("r.status === 409"), "冲突分支必须存在");
	assert.ok(code.includes("setSaveState(\"conflict\")"), "409 显式置冲突态");
	assert.ok(!/catch\s*\{\s*setDraft\(/.test(code), "冲突不得自动覆盖本地草稿");
	assert.ok(code.includes("api.sessionNote.save("), "保存走 api.sessionNote（不是自己 fetch）");
	assert.ok(code.includes("api.sessionNote.get("), "读取走 api.sessionNote");
	assert.ok(code.includes("data-rail-panel={PANEL_NOTE}"), "面板根节点带可观测的 panel 标记");
	ok("RR5c NotePanel 接线：只读 Markdown / 手动保存 + 发送到会话 / sid 丢弃 / 409 保留草稿");

	const client = codeOnly(read("api/client.ts"));
	assert.ok(client.includes("sessionNote:"), "api.client 暴露 sessionNote 命名空间");
	// ETag cache key 必须带 sid：否则切会话会命中上一个会话的数据（同 runs 的坑）
	assert.ok(client.includes("const key = `/v1/session-note?sessionId=${encodeURIComponent(sid)}`"), "GET 路径与 ETag key 同一串");
	assert.ok(client.includes("fetchJson<SessionNoteResponse>(key, undefined, 5000, key)"), "ETag key 传给 fetchJson");
	assert.ok(client.includes("postJson<SessionNoteResponse>(\"/v1/session-note\""), "保存走 POST 同端点");
	ok("RR5c2 api.client：sessionNote.get/save 接线 + ETag key 带 sid");

	const panels = codeOnly(read("rightRail/panels.ts"));
	assert.ok(panels.includes("PANEL_NOTE"), "注册表包含 note 面板 id");
	assert.ok(panels.includes("render: NotePanel"), "注册表挂的是 NotePanel 组件");
	ok("RR5c3 注册表：会话便签面板已挂（壳零改动）");
}

// ═══════════════════════════════════════════════════════════════════════
// RR6 注册表可扩展（加面板不改壳）
// ═══════════════════════════════════════════════════════════════════════
{
	type Meta = { id: string; zh: string };
	const real: Meta[] = [{ id: PANEL_DISPATCHED, zh: "派发" }];
	const withFake: Meta[] = [...real, { id: "fake-panel", zh: "假面板" }];
	assert.equal(railPanelById(real, PANEL_DISPATCHED)?.zh, "派发");
	assert.equal(railPanelById(withFake, "fake-panel")?.zh, "假面板", "新增面板只需注册表加一条 ⇒ 壳能切换它");
	assert.equal(railPanelById(real, "no-such-id")?.id, PANEL_DISPATCHED, "未知 id 回落第一个（不是空白）");
	assert.equal(railPanelById([], "x"), null, "空注册表 ⇒ null（壳不崩）");
	ok("RR6a railPanelById：真实 id / 假面板 id / 未知回落 / 空表");

	const shell = codeOnly(read("rightRail/RightRail.tsx"));
	assert.ok(shell.includes("RAIL_PANELS"), "壳从注册表读面板");
	assert.ok(shell.includes("railPanelById(RAIL_PANELS, panelId)"), "壳用注册表解析当前面板");
	assert.ok(!shell.includes(`"${PANEL_DISPATCHED}"`), "壳里不得硬编码面板 id（加面板要改壳的反例）");
	assert.ok(!shell.includes("派发"), "壳里不得硬编码面板名");
	assert.ok(!/switch\s*\(\s*panel/.test(shell), "壳不得按面板 switch 分支渲染");
	assert.ok(shell.includes("panel.render"), "渲染入口 = 注册表里的 render");
	ok("RR6b 源码：壳零面板 id/名、零 switch，只经 RAIL_PANELS + railPanelById");

	// 条件挂载（未展开 ⇒ 不渲染面板组件 ⇒ 不轮询）
	assert.ok(/const PanelBody = open && panel !== null \? panel\.render : null;/.test(shell), "条件挂载：收起时取不到面板组件");
	assert.ok(shell.includes("{PanelBody !== null && panel !== null && ("), "收起时不渲染面板子树");
	assert.ok(!/hidden xl:flex|hidden md:flex/.test(shell), "不用 hidden 当唯一手段（必须真卸载，否则仍在轮询）");
	ok("RR6c 条件挂载：未展开/未选中 ⇒ 面板组件不挂载（不是只 CSS 隐藏）");

	// 折叠范式照左栏 + 宽度受控（2026-11-18：固定 w-[320px] → 可拖拽 width）
	assert.ok(shell.includes("w-0 flex-none pointer-events-none opacity-0"), "折叠 = 宽度归零 + pointer-events-none + opacity-0");
	assert.ok(shell.includes("transition-[width,opacity]"), "与左栏同一过渡范式");
	assert.ok(!shell.includes("w-[320px]"), "宽度不再硬编码 320px 类");
	assert.ok(shell.includes("style={open ? { width:"), "展开宽度走受控 inline style");
	assert.ok(shell.includes("clampRailWidth(width, viewportWidth)"), "显示宽度经 railState 钳制");
	assert.ok(shell.includes("data-right-rail-resizer"), "桌面第三列渲染左缘拖拽分隔条");
	assert.ok(
		shell.includes('resizing ? "transition-none" : "duration-200 ease-out transition-[width,opacity]"'),
		"仅在拖拽期间关闭 width 过渡（反例：无条件 transition-none / 三元写反 ⇒ 本行红）",
	);
	assert.ok(!/w-\[40px\]|rotate-90/.test(shell), "不做 40px 竖条");
	ok("RR6d 折叠范式与 Sidebar 一致（320px → 0，非竖条）；窄屏抽屉保留入口");
}

// ═══════════════════════════════════════════════════════════════════════
// RR7 面板接线（取数/迟到丢弃/新鲜度）
// ═══════════════════════════════════════════════════════════════════════
{
	const panel = codeOnly(read("rightRail/DispatchedPanel.tsx"));
	assert.ok(panel.includes("sessionId: sid"), "请求带会话 scope");
	assert.ok(panel.includes("limit: RAIL_RUNS_LIMIT"), "带 limit（50）");
	assert.ok(panel.includes("includeRecentCalls: true"), "要最近工具调用");
	assert.ok(!/\bsetInterval\s*\(/.test(panel), "不得裸 setInterval（RunsPage 的反例）");
	assert.ok(panel.includes("useGui.getState().chatActiveId !== sid"), "迟到响应按 sid 比对后丢弃（验收 10）");
	assert.ok(panel.includes("lastOkAt: Date.now()"), "新鲜度 = 最后成功请求的**本地**时刻");
	assert.ok(!panel.includes(".asof"), "不用响应 asof 当新鲜度（304 会复用旧 asof）");
	assert.ok(!panel.includes("lastActivity"), "面板不读 lastActivity 当已跑时长/脉搏");
	assert.ok(panel.includes("prev.sid === sid"), "失败只在同一会话内保留旧数据");
	ok("RR7a 面板接线：带 sid/limit/recentCalls、按 sid 丢弃迟到响应、失败仅同会话保留旧数据");

	// 切会话立即补拍（usePoll 的依赖只有 interval/enabled，不含会话 ⇒ 必须自己补一拍）
	assert.ok(/useEffect\(\(\) => \{\s*if \(!enabled\) return;\s*void refresh\(\);/.test(panel), "切会话补拍一次（enabled 时）");
	assert.ok(panel.includes("[chatActiveId, enabled, refresh]"), "补拍依赖 chatActiveId");
	assert.ok(panel.includes("SAME_SID_COALESCE_MS"), "同 sid 300ms 合并窗（避免开面板与会话切换同帧双打）");
	assert.ok(panel.includes("EMPTY_BOX"), "初始态用 EMPTY_BOX（未加载 ≠ 空列表）");
	assert.ok(panel.includes("const sameSession = box.sid !== null && box.sid === chatActiveId"), "切会话后旧会话数据不渲染（派生过滤，不靠 effect 清屏）");
	ok("RR7b 切会话立即补拍 + 同 sid 合并窗 + 切会话清屏");

	// 三种空态在面板里都被真的渲染（不是只算出来）
	assert.ok(panel.includes("pickDispatchedEmpty({"), "空态由 pickDispatchedEmpty 决定");
	assert.ok(panel.includes("attributionNotice(resp)"), "非空列表的归属提示也渲染");
	ok("RR7c 面板真的渲染三种空态与归属提示（不是只算出结果）");
}

// ═══════════════════════════════════════════════════════════════════════
// RR8 formatUsage 含 turns（与「运行」页同一个格式器）
// ═══════════════════════════════════════════════════════════════════════
{
	const u: RunUsage = { input: 105_600, output: 22_053, cacheRead: 774_656, cacheWrite: 0, cost: 0.3, turns: 98 };
	const s = formatUsage(u);
	assert.equal(s, "106k in / 22.1k out · $0.300 · 98 回合", `费用/回合一行（实际 ${s}）`);
	assert.equal(formatUsage(null), "—", "运行中无 usage ⇒「—」");
	assert.ok(!formatUsage({ ...u, turns: Number.NaN }).includes("回合"), "turns 非有限 ⇒ 不出回合段");
	assert.ok(!formatUsage({ ...u, turns: -1 }).includes("回合"), "turns 负数 ⇒ 不出回合段");
	const panel = codeOnly(read("rightRail/DispatchedPanel.tsx"));
	assert.ok(panel.includes("formatUsage(run.usage)"), "面板用共享 formatUsage（不写第二套格式）");
	assert.ok(!panel.includes("toFixed(3)"), "面板不得自拼费用格式");
	ok("RR8 formatUsage 含 turns；面板复用同一格式器（零第二套格式）");
}

// ═══════════════════════════════════════════════════════════════════════
// RR9 反例修复：RunsPage 裸 setInterval → usePoll 门控
// ═══════════════════════════════════════════════════════════════════════
{
	const src = codeOnly(read("pages/RunsPage.tsx"));
	assert.ok(!/\bsetInterval\s*\(/.test(src), "RunsPage 不再裸 setInterval");
	assert.ok(src.includes('usePoll(refresh, POLL_MS, runtimeOverlay === "runs")'), "RunsPage 用 usePoll + section 门控");
	assert.ok(src.includes("const runtimeOverlay = useGui((s) => s.runtimeOverlay)"), "门控输入来自 store");
	assert.ok(src.includes("const POLL_MS = 5000;"), "档位 5s 不变");
	assert.ok(!src.includes("TONE_TO_BADGE: Record"), "色调映射已上提到 runsView（不在页面自建第二份）");
	assert.ok(src.includes("TONE_TO_BADGE"), "页面仍用共享映射");
	ok("RR9 RunsPage：裸 setInterval → usePoll(5000, 覆盖层已开∧section=runs)；色调/格式共享");
}

// ═══════════════════════════════════════════════════════════════════════
// RR10 默认展开 / 内存态 / IA 不变
// ═══════════════════════════════════════════════════════════════════════
{
	assert.equal(RAIL_WIDE_QUERY, "(min-width: 1280px)", "断点 1280px");
	assert.equal(railOpenDefault(() => true), true, "宽屏默认展开");
	assert.equal(railOpenDefault(() => false), false, "窄屏默认收起");
	assert.equal(railOpenDefault((q) => q === RAIL_WIDE_QUERY), true, "按 1280px 判定");
	assert.equal(
		railOpenDefault(() => {
			throw new Error("no matchMedia");
		}),
		false,
		"无 matchMedia（node/非浏览器）⇒ 收起，不抛",
	);
	ok("RR10a railOpenDefault：≥1280px 展开；窄屏/异常/无 matchMedia 收起");

	const store = read("store.ts");
	assert.ok(store.includes("railOpen: initialRailOpen()"), "store 有 railOpen（挂载时求值）");
	assert.ok(store.includes("railPanel: PANEL_DISPATCHED"), "store 有 railPanel（默认第一个面板）");
	assert.ok(store.includes('window.matchMedia(q).matches'), "初值来自 matchMedia");
	assert.ok(!/localStorage|sessionStorage/.test(store), "右栏状态不持久化（内存态）");
	assert.ok(store.includes("setRailOpen: (v) => set({ railOpen: v })") && store.includes("setRailPanel: (id) => set({ railPanel: id })"), "两个 setter 都是纯内存 set");
	assert.ok(!/config\.json|\.writeFile/.test(codeOnly(store)), "不写 config.json（注释里的“不写 config.json”不算写）");
	ok("RR10b store：railOpen/railPanel 内存态（无 WebStorage / 无 config.json 写入）");

	// 真载 store 验证默认值（node 无 window ⇒ 收起；面板 id 恒定）
	const { useGui } = await import("./store.ts");
	const st = useGui.getState();
	assert.equal(st.railOpen, false, "node（无 window）下默认收起");
	assert.equal(st.railPanel, PANEL_DISPATCHED, "默认面板 = 派发");
	st.setRailOpen(true);
	st.setRailPanel("fake-panel");
	const st2 = useGui.getState();
	assert.equal(st2.railOpen, true, "setRailOpen 生效");
	assert.equal(st2.railPanel, "fake-panel", "setRailPanel 生效（任意 id 都能存，壳负责回落）");
	st.setRailOpen(false);
	st.setRailPanel(PANEL_DISPATCHED);
	ok("RR10c 真载 store：默认收起 + 默认面板=dispatched + 两个 setter 生效");

	const app = codeOnly(read("App.tsx"));
	assert.ok(app.includes("<RightRail />"), "App 内容行挂右栏");
	assert.ok(app.indexOf("<Sidebar />") < app.indexOf("<main") && app.indexOf("<main") < app.indexOf("<RightRail />"), "三栏顺序：Sidebar → main → RightRail");
	assert.ok(app.includes("const PAGES: Record<TabId, () => ReactElement> = {"), "PAGES 未改类型");
	// 2026-11-17：工作区 S4「会话为主」已把主路由扩到 workspace/tokens（App.tsx / store.ts），
	// 与本右栏功能无关。基线随 S4 更新为**恰好四项**（不是放宽成"包含 chat|timeline"）——
	// 原意图仍是「右栏扩展不通过新增主路由实现」，多出第五项必须红。
	assert.ok(/chat: ChatPage,\s*\n\ttimeline: TimelinePage,\s*\n\tworkspace: WorkspaceHomePage,\s*\n\ttokens: TokensPage,\s*\n\};/.test(app),
		"PAGES 恰为 S4 四项（右栏未新增主路由）");
	assert.ok(store.includes('export type TabId = "chat" | "timeline" | "workspace" | "tokens";'), "TabId 恰为四项");
	const topbar = codeOnly(read("pages/TopBar.tsx"));
	assert.ok(topbar.includes('aria-label="右侧面板"'), "顶栏入口 aria-label");
	assert.ok(topbar.includes("setRailOpen(!railOpen)"), "顶栏入口切换展开态");
	assert.ok(topbar.includes("railPanelName(railPanel)"), "tooltip 显示当前面板名");
	assert.equal((topbar.match(/aria-label="右侧面板"/g) ?? []).length, 1, "顶栏只加**一个**图标钮");
	ok("RR10d IA 不变（无新 TabId / PAGES 不变）+ 顶栏单一入口 + tooltip 显示面板名");
}

// ═══════════════════════════════════════════════════════════════════════
// RR11 可拖拽宽度（2026-11-18）：默认/上下限 / 视口钳制 / 存储容错 / 接线
// ═══════════════════════════════════════════════════════════════════════
{
	assert.equal(RAIL_DEFAULT_WIDTH, 320, "默认 320px");
	assert.equal(RAIL_MIN_WIDTH, 260, "最小 260px");
	assert.equal(RAIL_MAX_WIDTH, 720, "绝对上限 720px");
	assert.equal(SIDEBAR_WIDTH, 264, "左栏 264px（与 Sidebar 类一致）");
	assert.equal(MAIN_MIN_WIDTH, 320, "中央列最小 320px");

	assert.equal(railMaxWidth(1280), 696, "1280 视口上限 = 1280-264-320");
	assert.equal(railMaxWidth(1440), 720, "1440 视口到绝对上限 720");
	assert.equal(railMaxWidth(1920), 720, "1920 仍封顶 720");
	assert.equal(railMaxWidth(800), RAIL_MIN_WIDTH, "窄视口不得算出 <260（下界守卫）");
	assert.equal(clampRailWidth(320, 700), RAIL_MIN_WIDTH, "极窄视口也守住最小 260");
	assert.equal(railMaxWidth(Number.NaN), RAIL_MAX_WIDTH, "非法视口 ⇒ 绝对上限（调用方再钳到值域）");
	for (const vw of [320, 600, 800, 1280, 1920]) {
		assert.ok(railMaxWidth(vw) >= RAIL_MIN_WIDTH, `任何视口上限都不得低于最小值（${vw}）`);
	}
	assert.equal(clampRailWidth(100, 1440), RAIL_MIN_WIDTH, "过窄 → 260");
	assert.equal(clampRailWidth(9999, 1440), RAIL_MAX_WIDTH, "过宽 → 720");
	assert.equal(clampRailWidth(700, 1280), 696, "1280 下 700 被视口上限压到 696");
	assert.equal(clampRailWidth(Number.NaN, 1440), RAIL_DEFAULT_WIDTH, "非数值 → 默认 320");
	assert.equal(clampRailWidth(320.4, 1440), 320, "取整");
	ok("RR11a 宽度值域：默认 320 / 最小 260 / 绝对上限 720 / 1280 视口上限 696");

	const mem = new Map<string, string>();
	const storage = {
		getItem: (key: string): string | null => mem.get(key) ?? null,
		setItem: (key: string, value: string): void => {
			mem.set(key, value);
		},
	};
	assert.equal(loadRailWidth(1440, storage), RAIL_DEFAULT_WIDTH, "无存储值 → 默认");
	assert.equal(saveRailWidth(500, 1440, storage), 500, "写入返回实际生效宽度");
	assert.equal(mem.get(RAIL_WIDTH_STORAGE_KEY), "500", "落盘值 = 十进制像素");
	assert.equal(loadRailWidth(1440, storage), 500, "读回同值");
	mem.set(RAIL_WIDTH_STORAGE_KEY, "9999");
	assert.equal(loadRailWidth(1440, storage), RAIL_MAX_WIDTH, "坏大值按视口钳制");
	mem.set(RAIL_WIDTH_STORAGE_KEY, "not-a-number");
	assert.equal(loadRailWidth(1440, storage), RAIL_DEFAULT_WIDTH, "坏字符串 → 默认");
	mem.set(RAIL_WIDTH_STORAGE_KEY, "700");
	assert.equal(loadRailWidth(1280, storage), 696, "旧视口存 700，换 1280 视口后读回即钳制");
	ok("RR11b localStorage：无值/回读/坏值/跨视口钳制");

	const throwing = {
		getItem: (): string | null => {
			throw new Error("storage denied");
		},
		setItem: (): void => {
			throw new Error("quota");
		},
	};
	assert.equal(loadRailWidth(1440, throwing), RAIL_DEFAULT_WIDTH, "读取异常 → 默认（不抛）");
	assert.equal(saveRailWidth(500, 1440, throwing), 500, "写入异常静默吞掉，返回生效宽度（不阻断拖拽）");
	assert.equal(loadRailWidth(1440, null), RAIL_DEFAULT_WIDTH, "无 localStorage（SSR/隐私）→ 默认");
	ok("RR11c 存储异常/缺失均不抛，回退默认");

	const shell = codeOnly(read("rightRail/RightRail.tsx"));
	assert.ok(shell.includes("loadRailWidth(currentViewportWidth())"), "初值读持久化宽度");
	assert.ok(shell.includes("setPointerCapture(e.pointerId)"), "pointerdown 捕获指针（拖出元素也不断线）");
	assert.ok(shell.includes("releasePointerCapture(drag.pointerId)"), "收尾释放捕获");
	// 四条 pointer 接线必须逐条钉死：只断言 setPointerCapture 字符串时，删掉 onPointerDown 仍会全绿。
	assert.ok(shell.includes("onPointerDown={onResizeStart}"), "pointerdown 真的接上");
	assert.ok(shell.includes("onPointerMove={onResizeMove}"), "pointermove 真的接上");
	assert.ok(shell.includes("onPointerUp={onResizeEnd}"), "pointerup 真的接上");
	assert.ok(shell.includes("onPointerCancel={onResizeEnd}"), "pointercancel 真的接上");
	assert.ok(shell.includes("onLostPointerCapture={onResizeEnd}"), "lostpointercapture 收尾（防拖拽态卡死）");
	assert.ok(shell.includes('role="separator"') && shell.includes("aria-valuenow={effectiveWidth}"), "分隔条有 separator 语义与当前值");
	assert.ok(shell.includes("aria-valuemin={RAIL_MIN_WIDTH}") && shell.includes("aria-valuemax={maxWidth}"), "ARIA 上下限接真实值（反例：常量 ⇒ 红）");
	assert.ok(shell.includes("onDoubleClick={() => applyWidth(RAIL_DEFAULT_WIDTH, true)}"), "双击复位 320 并落盘");
	assert.ok(shell.includes("onKeyDown={onResizeKeyDown}"), "键盘可调");
	assert.ok(shell.includes('if (e.key === "ArrowLeft") next = widthRef.current + step;'), "← 变宽");
	assert.ok(shell.includes('if (e.key === "ArrowRight") next = widthRef.current - step;'), "→ 变窄");
	assert.ok(shell.includes('if (e.key === "Home") next = RAIL_MIN_WIDTH;'), "Home = 最小（splitter 标准语义）");
	assert.ok(shell.includes("applyWidth(drag.startWidth + (drag.startX - e.clientX), false)"), "pointermove 只更新内存，不逐帧写盘");
	assert.ok(shell.includes("saveRailWidth(widthRef.current, currentViewportWidth())"), "pointerup 才落盘");
	assert.ok(shell.includes('window.addEventListener("resize", onResize)'), "窗口缩放监听真的接上");
	assert.ok(shell.includes("documentElement.clientWidth"), "视口用 clientWidth（不含滚动条）");
	assert.ok(shell.includes("clampRailWidth(widthRef.current, vw)"), "resize 后按新视口重新钳制");
	assert.ok(
		shell.includes("if (open && !drawer) return;") && shell.includes("[open, drawer]"),
		"resizer 卸载（收起/跨 1280）时有清理兜底（防 body 光标/禁选卡死）",
	);
	assert.ok(shell.includes("drawer ? RAIL_DEFAULT_WIDTH : clampRailWidth(width, viewportWidth)"), "窄屏抽屉固定 320，不参与拖拽");
	assert.ok(shell.includes("!drawer && open && ("), "分隔条仅桌面第三列渲染");
	assert.ok(
		shell.includes('drawer ? "absolute bottom-0 right-0 top-12 z-20 shadow-overlay" : "relative"'),
		"抽屉 absolute 与非抽屉 relative 互斥（防 CSS 顺序导致抽屉仍在流内）",
	);
	// 不能只堵 `"relative min-h-0"` 一种写法：relative 只能来自非抽屉分支，出现第二次即阻断复发。
	assert.equal((shell.match(/\brelative\b/g) ?? []).length, 1, "relative 恰好一次（仅非抽屉分支）");
	assert.ok(!shell.includes("w-[320px]"), "壳里不再有硬编码 320px 类");
	ok("RR11d 接线：pointer 五事件 / 键盘 / 双击 / 仅 pointerup 落盘 / resize 钳制 / 抽屉与 relative 互斥");
}

console.log(`\n_test_right_rail: all assertions passed (${n} groups)`);
