/**
 * _test_builtin_cmd_bridge.ts — `/reload` + `/model` 内建命令桥回归门（2026-10-21）
 *
 * ## 为什么需要
 * pi 的内建命令（`BUILTIN_SLASH_COMMANDS`，24 条）**不在** `pi.getCommands()` 的返回里
 * （`agent-session.js:2613-2634` 只返 extension/prompt/skill）⇒ 远端/GUI 看不到也调不到。
 * 而 `prompt()` 的命令识别只走 `_tryExecuteExtensionCommand`（`:1458-1465`），
 * 找不到就**把字符串当正文发给 LLM** ⇒ `/model x` 会污染上下文。
 *
 * 这道门钉住的**关键风险**：静默切错模型。
 * `matchModel` 找不到时必须返回 null 让调用方列候选，**不得模糊纠正**。
 */

import assert from "node:assert/strict";
import {
	formatModelList,
	formatModelNotFound,
	matchModel,
	parseModelArg,
	registerBuiltinCommandBridge,
	type CommandBridgeContext,
	type CommandBridgeApi,
	type ModelLike,
} from "./runtime/builtin-cmd-bridge.ts";
import { normalizeCommands } from "./runtime/commands-snapshot.ts";

let n = 0;
const ok = (m: string): void => {
	n++;
	console.log(`ok ${n} - ${m}`);
};

const MODELS: ModelLike[] = [
	{ provider: "Zhipu", id: "glm-5.3" },
	{ provider: "opendesigngo", id: "deepseek-v4.1-flash" },
	{ provider: "openai-codex", id: "gpt-6-luna" },
];

/** 最小 fake pi：记录注册结果，暴露 setModel。 */
function fakePi(opts: { setModelResult?: boolean; setModelThrows?: boolean } = {}): {
	api: CommandBridgeApi;
	registered: Map<string, { description?: string; handler: (a: string, c: CommandBridgeContext) => Promise<void> }>;
	setModelCalls: unknown[];
} {
	const registered = new Map<string, { description?: string; handler: (a: string, c: CommandBridgeContext) => Promise<void> }>();
	const setModelCalls: unknown[] = [];
	const api: CommandBridgeApi = {
		registerCommand: (name, o) => {
			registered.set(name, o);
		},
		setModel: async (m) => {
			setModelCalls.push(m);
			if (opts.setModelThrows) throw new Error("boom");
			return opts.setModelResult ?? true;
		},
	};
	return { api, registered, setModelCalls };
}

/** 收集 notify 的 fake ctx。 */
function fakeCtx(over: Partial<CommandBridgeContext> = {}): { ctx: CommandBridgeContext; notes: { msg: string; level?: string }[] } {
	const notes: { msg: string; level?: string }[] = [];
	const ctx: CommandBridgeContext = {
		ui: { notify: (msg, level) => notes.push({ msg, level }) },
		modelRuntime: { getAvailableSnapshot: () => MODELS },
		model: MODELS[0],
		reload: async () => {},
		...over,
	};
	return { ctx, notes };
}

// ── B1 纯函数：参数解析 ─────────────────────────────────────────
{
	assert.deepEqual(parseModelArg(""), { kind: "list" }, "空参 ⇒ 列出");
	assert.deepEqual(parseModelArg("   "), { kind: "list" }, "全空白 ⇒ 列出");
	assert.deepEqual(parseModelArg("Zhipu/glm-5.3"), { kind: "set", ref: "Zhipu/glm-5.3" });
	assert.deepEqual(parseModelArg("  glm-5.3  "), { kind: "set", ref: "glm-5.3" }, "trim");
	ok("B1 parseModelArg：空=列出 / 非空=设值（trim）");
}

// ── B2 纯函数：匹配（**不得模糊纠正**，这是核心安全断言）────────
{
	assert.equal(matchModel("Zhipu/glm-5.3", MODELS)?.id, "glm-5.3", "精确 provider/id");
	assert.equal(matchModel("zhipu/GLM-5.3", MODELS)?.id, "glm-5.3", "大小写不敏感");
	assert.equal(matchModel("glm-5.3", MODELS)?.id, "glm-5.3", "精确 id（唯一）");
	// 关键：近似但不精确 ⇒ 必须 null，不得挑一个最近的
	assert.equal(matchModel("glm-5", MODELS), null, "近似前缀不得自动纠正（否则切到用户没要的模型）");
	assert.equal(matchModel("gpt", MODELS), null, "前缀不匹配 ⇒ null");
	assert.equal(matchModel("", MODELS), null, "空 ref ⇒ null");
	assert.equal(matchModel("不存在", MODELS), null);
	// 歧义：两个同名 id 不同 provider ⇒ 不得猜
	const dup: ModelLike[] = [
		{ provider: "A", id: "same" },
		{ provider: "B", id: "same" },
	];
	assert.equal(matchModel("same", dup), null, "歧义（多 provider 同 id）⇒ null，不猜");
	assert.equal(matchModel("A/same", dup)?.provider, "A", "但显式 provider/id 仍可精确命中");
	ok("B2 matchModel：精确可命中、近似/歧义一律 null（禁止静默切错模型）");
}

// ── B3 回执文案：列出含当前标记 / 未找到含候选 ──────────────────
{
	const list = formatModelList(MODELS[0], MODELS);
	assert.ok(list.includes("Zhipu/glm-5.3"), "列出含模型");
	assert.ok(list.includes("（当前）"), "当前模型有标记");
	assert.ok(list.includes("可用模型 3 个"), "给出数量");
	assert.ok(list.includes("/model <provider/id>"), "给出用法");

	const empty = formatModelList(undefined, []);
	assert.ok(empty.includes("暂无") || empty.includes("无（"), "空目录如实说，不编造");

	const nf = formatModelNotFound("glm-5", MODELS);
	assert.ok(nf.includes("未找到模型：glm-5"), "明示未找到");
	assert.ok(nf.includes("不做模糊自动纠正"), "明示不做模糊纠正（用户能预期）");
	assert.ok(nf.includes("Zhipu/glm-5.3"), "给候选");
	ok("B3 文案：列出含当前标记；未找到含候选且声明不自动纠正");
}

// ── B4 真实注册：三条命令都注册上（含别名）─────────────────────
{
	const { api, registered } = fakePi();
	const names = registerBuiltinCommandBridge(api);
	assert.deepEqual(names.sort(), ["model", "models", "reload"].sort(), "注册 reload + model + models 别名");
	assert.ok(registered.has("reload"));
	assert.ok(registered.has("model"));
	assert.ok(registered.has("models"), "别名 /models（用户按复数记，兼容）");
	// models 与 model 必须同一 handler（行为一致）
	assert.equal(registered.get("models")!.handler, registered.get("model")!.handler, "别名与主命令同 handler");
	ok("B4 真实注册：reload / model / models(别名同 handler)");
}

// ── B5 /reload 走真实 handler：调 ctx.reload 一次 ────────────────
{
	const { api, registered } = fakePi();
	registerBuiltinCommandBridge(api);
	let reloadCalls = 0;
	const { ctx, notes } = fakeCtx({ reload: async () => { reloadCalls += 1; } });
	await registered.get("reload")!.handler("", ctx);
	assert.equal(reloadCalls, 1, "handler 真的调了 ctx.reload()");
	assert.ok(notes.some((x) => x.msg.includes("未丢弃")), "回执明确「会话上下文未丢」（防误解）");
	ok("B5 /reload：真调 ctx.reload()，回执澄清不丢历史");
}

// ── B6 /reload 在无 reload() 的 ctx 下如实报不可用，不炸 ────────
{
	const { api, registered } = fakePi();
	registerBuiltinCommandBridge(api);
	const { ctx, notes } = fakeCtx({ reload: undefined });
	await registered.get("reload")!.handler("", ctx);
	assert.ok(notes.some((x) => x.msg.includes("不可用")), "无能力 ⇒ 明说不可用");
	assert.ok(notes.some((x) => x.level === "warning"), "用 warning 级");
	ok("B6 /reload 降级：无 reload() ⇒ 如实报不可用，不抛");
}

// ── B7 /model 切换成功 / 失败（认证未配）───────────────────────
{
	const { api, registered, setModelCalls } = fakePi({ setModelResult: true });
	registerBuiltinCommandBridge(api);
	const { ctx, notes } = fakeCtx();
	await registered.get("model")!.handler("Zhipu/glm-5.3", ctx);
	assert.equal(setModelCalls.length, 1, "调了 pi.setModel");
	assert.deepEqual(setModelCalls[0], MODELS[0], "传的是匹配到的 Model 对象");
	assert.ok(notes.some((x) => x.msg.includes("模型已切换")), "成功回执");

	// setModel 返 false = provider 未配认证（官方语义 types.d.ts:1244-1247）
	const f2 = fakePi({ setModelResult: false });
	registerBuiltinCommandBridge(f2.api);
	const { ctx: c2, notes: n2 } = fakeCtx();
	await f2.registered.get("model")!.handler("Zhipu/glm-5.3", c2);
	assert.ok(n2.some((x) => x.msg.includes("未配置认证")), "false ⇒ 明确说未配认证（不自称成功）");
	assert.ok(n2.some((x) => x.level === "warning"), "失败用 warning 级");
	ok("B7 /model：成功真调 setModel；false ⇒ 明说未配认证");
}

// ── B8 /model 未找到：**不得**调 setModel，只列候选 ─────────────
{
	const { api, registered, setModelCalls } = fakePi();
	registerBuiltinCommandBridge(api);
	const { ctx, notes } = fakeCtx();
	await registered.get("model")!.handler("glm-5", ctx);
	assert.equal(setModelCalls.length, 0, "未精确命中 ⇒ **绝不调 setModel**（核心安全断言）");
	assert.ok(notes.some((x) => x.msg.includes("未找到模型")), "回执明示未找到");
	assert.ok(notes.some((x) => x.msg.includes("Zhipu/glm-5.3")), "列出候选供用户挑");
	ok("B8 /model 未命中：零 setModel 调用 + 列候选（不静默纠正）");
}

// ── B9 /model 无参列出 / 目录为空如实说 ─────────────────────────
{
	const { api, registered, setModelCalls } = fakePi();
	registerBuiltinCommandBridge(api);
	const { ctx, notes } = fakeCtx();
	await registered.get("model")!.handler("", ctx);
	assert.equal(setModelCalls.length, 0, "列出不切模型");
	assert.ok(notes[0]!.msg.includes("当前模型：Zhipu/glm-5.3"), "含当前模型");
	assert.ok(notes[0]!.msg.includes("可用模型 3 个"), "含数量");

	const { ctx: c2, notes: n2 } = fakeCtx({ modelRuntime: { getAvailableSnapshot: () => [] } });
	await registered.get("model")!.handler("Zhipu/glm-5.3", c2);
	assert.ok(n2.some((x) => x.msg.includes("不可用")), "目录空 ⇒ 明说不可用，不假装切换");
	assert.equal(setModelCalls.length, 0, "目录空也不调 setModel");
	ok("B9 /model：无参列出；目录空如实报不可用");
}

// ── B10 setModel 抛异常不炸 handler ─────────────────────────────
{
	const { api, registered } = fakePi({ setModelThrows: true });
	registerBuiltinCommandBridge(api);
	const { ctx, notes } = fakeCtx();
	await registered.get("model")!.handler("Zhipu/glm-5.3", ctx);
	assert.ok(notes.some((x) => x.msg.includes("切换异常")), "异常被捕获并如实回报");
	ok("B10 setModel 抛异常：捕获回报，不炸会话");
}

// ── B11 快照契约：argumentHint 透传（显示适配）─────────────────
{
	const entries = normalizeCommands([
		{ name: "model", description: "切换模型", source: "extension", argumentHint: "<provider/model>" },
		{ name: "reload", description: "重载", source: "extension" },
		{ name: "x", source: "extension", argumentHint: "" }, // 空串 ⇒ 不落字段
	]);
	assert.equal(entries[0]!.argumentHint, "<provider/model>", "argumentHint 透传");
	assert.equal(entries[1]!.argumentHint, undefined, "无 hint ⇒ 不落字段");
	assert.equal(entries[2]!.argumentHint, undefined, "空串 hint ⇒ 不落字段（不产生空提示）");

	// 映射表兜底：pi 的 registerCommand 根本没有 argumentHint 字段（types.d.ts:1123-1129），
	// 所以 /model 的提示只能靠本仓映射表补。这条钉住那个兜底真的生效。
	const viaMap = normalizeCommands([
		{ name: "model", source: "extension" },
		{ name: "reload", source: "extension" },
	]);
	assert.equal(viaMap[0]!.argumentHint, "<provider/id>", "/model 从映射表拿到提示");
	assert.equal(viaMap[1]!.argumentHint, undefined, "/reload 无提示（映射表未登记）");
	// 源头优先于映射表
	const srcWins = normalizeCommands([{ name: "model", source: "extension", argumentHint: "<other>" }]);
	assert.equal(srcWins[0]!.argumentHint, "<other>", "源头 hint 优先于映射表");
	ok("B11 快照：argumentHint additive 透传（空串不落 + 映射表兜底 + 源头优先）");
}

console.log(`\n_test_builtin_cmd_bridge: all assertions passed (${n} groups)`);
