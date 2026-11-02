/**
 * _test_codegraph.ts — codegraph 工具包装的判据测试
 *
 * 背景（2026-10-31）：owner 观察到「coding 用途仓库的 agent 都不太爱用 codegraph」。
 * 实测 40 个会话 8492 次工具调用里 **codegraph 用了 0 次** ——
 * 不是模型偏好，而是它从未被注册成 pi 工具（只有提示文字提到它）。
 *
 * 本测试锁四条不变量：
 *   ① **仓库级隔离**：绝不串用父目录的「大杂烩」索引（实测 G:/code/.codegraph
 *      4.0GB 把 78 个子目录装在一起，在 battlesandbox 查 player 返回 ezdxf 的
 *      Python 库文件 —— 比没有 codegraph 更有害，因为它看起来像有结果）。
 *   ② 结构化投影：`query --json` 的十余字段压成 `kind name file:line`。
 *   ③ 索引陈旧必告警：悄悄返回过期结果比报错更危险。
 *   ④ never-throw：CLI 缺失/坏 JSON/未初始化都给出可执行的原因。
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	dispatchCodegraph,
	formatSymbolHits,
	findCodegraphRoot,
	judgeIndexFreshness,
	normalizeCodegraphAction,
	parseJsonOutput,
	projectSymbolHits,
	queryShapeHint,
	type DispatchDeps,
} from "./codegraph.ts";

let n = 0;
const ok = (msg: string): void => {
	n += 1;
	console.log(`ok ${n} - ${msg}`);
};

// ── ① 仓库级索引隔离（本次最核心的判据）────────────────────────────
{
	const base = join(tmpdir(), `cg_root_test_${Date.now()}`);
	const umbrella = base; // 模拟 G:/code（无 .git，有大杂烩索引）
	const repo = join(base, "myrepo"); // 模拟 G:/code/battlesandbox（有 .git，无自己的索引）
	const own = join(base, "own"); // 有 .git + 自己的索引
	mkdirSync(join(umbrella, ".codegraph"), { recursive: true });
	writeFileSync(join(umbrella, ".codegraph", "codegraph.db"), ""); // 真索引（大杂饼也是真索引）
	mkdirSync(join(repo, ".git"), { recursive: true });
	mkdirSync(join(own, ".git"), { recursive: true });
	mkdirSync(join(own, ".codegraph"), { recursive: true });
	writeFileSync(join(own, ".codegraph", "codegraph.db"), ""); // 真索引必须有 codegraph.db
	mkdirSync(join(own, "sub"), { recursive: true });
	try {
		// 就地命中 ⇒ 信任
		assert.equal(findCodegraphRoot(own), own, "就地有 .codegraph ⇒ 信任");
		// 子目录向上命中 own（own 是 git 根）⇒ 信任
		assert.equal(findCodegraphRoot(join(own, "sub")), own, "向上命中 git 根 ⇒ 信任");
		// repo 向上只找到「大杂烩」（umbrella 不是 git 根）⇒ 必须拒绝
		assert.equal(
			findCodegraphRoot(repo),
			null,
			"父目录的大杂烩索引不是 git 根 ⇒ 拒绝使用（否则查到的是别的仓库的代码）",
		);
		ok("① 仓库级隔离：就地命中信任 / 向上命中需 git 根 / 大杂烩索引拒绝");
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
}

// ── ①b 全局遥测目录误判为索引（2026-11-02 实测缺陷）───────────────
// 实测：`C:\Users\<user>\.codegraph` 是 codegraph CLI 的**全局遥测目录**
// （只有 daemons/ + telemetry*.json + update-check.json，**无 codegraph.db**）。
// 老实现只看“目录存在” ⇒ 把它当索引根 ⇒ 在无自己的 .codegraph 的仓库里
// status 返回全 `?` 而不是“本仓未初始化”，**静默误导**。
{
	const base = join(tmpdir(), `cg_telemetry_test_${Date.now()}`);
	const fakeHome = base; // 模拟 C:\Users\<user>（非 git）
	const nonGitRepo = join(base, "notgit", "repo");
	mkdirSync(join(fakeHome, ".codegraph", "daemons"), { recursive: true });
	writeFileSync(join(fakeHome, ".codegraph", "telemetry.json"), "{}");
	writeFileSync(join(fakeHome, ".codegraph", "update-check.json"), "{}");
	mkdirSync(join(fakeHome, "notgit"), { recursive: true }); // notgit 不是 git 根
	mkdirSync(join(nonGitRepo, ".git"), { recursive: true }); // repo 是 git 根但无自己的 .codegraph
	try {
		assert.equal(
			findCodegraphRoot(fakeHome),
			null,
			"只有 telemetry（无 codegraph.db）的 .codegraph ⇒ 不得当索引根",
		);
		assert.equal(
			findCodegraphRoot(nonGitRepo),
			null,
			"向上只能找到全局遥测目录 ⇒ 必须报未初始化，不能返回它",
		);
		// 反向控制：真索引（有 codegraph.db）仍须被信任
		const realRoot = join(base, "real");
		mkdirSync(join(realRoot, ".codegraph"), { recursive: true });
		writeFileSync(join(realRoot, ".codegraph", "codegraph.db"), "");
		assert.equal(findCodegraphRoot(realRoot), realRoot, "含 codegraph.db ⇒ 是真索引，必须信任");
		ok("①b 全局遥测目录不得当索引根；真索引（codegraph.db）仍被信任");
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
}

// ── ② 结构化投影 ────────────────────────────────────────────────────────────────────────────────────────────────
{
	// 真实 `codegraph query --json` 的形状（取自实测输出）
	const payload = [
		{
			node: {
				kind: "method",
				name: "ApprovalPolicyProvider",
				qualifiedName: "GreenCAD.AI.Agent.Approval::ApprovalPolicyProvider::ApprovalPolicyProvider",
				filePath: "GreenCAD.AI/Agent/Approval/ApprovalPolicyProvider.cs",
				startLine: 145,
				endLine: 153,
				language: "csharp",
				visibility: "public",
			},
			score: 119.66,
		},
		{ node: { kind: "class", name: "Broken" } }, // 缺 filePath ⇒ 丢弃
		{ notANode: true }, // 形状不对 ⇒ 丢弃
		null,
	];
	const hits = projectSymbolHits(payload);
	assert.equal(hits.length, 1, "只保留合法 node");
	assert.equal(hits[0].kind, "method");
	assert.equal(hits[0].name, "ApprovalPolicyProvider");
	assert.equal(hits[0].file, "GreenCAD.AI/Agent/Approval/ApprovalPolicyProvider.cs");
	assert.equal(hits[0].line, 145);

	const text = formatSymbolHits(hits);
	assert.ok(text.includes("ApprovalPolicyProvider"), "文本含符号名");
	assert.ok(text.includes(":145"), "文本含 file:line（可跳转）");
	assert.equal(formatSymbolHits([]), "(no results)", "空结果有明确文案");

	// 坏输入不得抛
	assert.deepEqual(projectSymbolHits(null), []);
	assert.deepEqual(projectSymbolHits({}), []);
	ok("② 结构化投影：合法 node 保留 file:line；坏形状丢弃；空结果有文案");
}

// ── ③ JSON 解析容错（CLI 会打日志行）────────────────────────────────
{
	assert.deepEqual(parseJsonOutput('[{"a":1}]'), [{ a: 1 }]);
	// 实测 codegraph 在 JSON 前打 "Active code page: 65001"
	const withNoise = "Active code page: 65001\n[\n  {\"a\":1}\n]";
	assert.deepEqual(parseJsonOutput(withNoise), [{ a: 1 }], "跳过前置日志行");
	assert.equal(parseJsonOutput(""), null, "空串 ⇒ null");
	assert.equal(parseJsonOutput("not json at all"), null, "非 JSON ⇒ null");
	ok("③ JSON 解析：容忍 CLI 前置日志行；空/坏输入返回 null 不抛");
}

// ── ④ 陈旧判定 ────────────────────────────────────────────────────
{
	const now = Date.parse("2026-10-31T12:00:00Z");

	// 实测 GreenCAD：索引停在 10-28，pending +36/~51/-5
	const stale = judgeIndexFreshness(
		{
			lastIndexed: "2026-10-28T06:07:21.493Z",
			pendingChanges: { added: 36, modified: 51, removed: 5 },
		},
		now,
	);
	assert.equal(stale.stale, true, "有 pendingChanges ⇒ 陈旧");
	assert.equal(stale.pendingTotal, 92);
	assert.ok(stale.warning.includes("待同步"), "告警说明待同步量");
	assert.ok(stale.warning.includes("70h") || stale.warning.includes("未更新"), "告警说明时间");
	assert.ok(stale.warning.includes("sync"), "告警给出可执行动作");

	// 刚同步完 ⇒ 不陈旧
	const fresh = judgeIndexFreshness(
		{ lastIndexed: "2026-10-31T11:59:00Z", pendingChanges: { added: 0, modified: 0, removed: 0 } },
		now,
	);
	assert.equal(fresh.stale, false, "无 pending 且刚更新 ⇒ 新鲜");
	assert.equal(fresh.warning, "", "新鲜时不打扰");

	// pending 为 0 但 30h 未更新 ⇒ 仍判陈旧（守护进程可能死了）
	const deadDaemon = judgeIndexFreshness(
		{ lastIndexed: "2026-10-30T06:00:00Z", pendingChanges: { added: 0, modified: 0, removed: 0 } },
		now,
	);
	assert.equal(deadDaemon.stale, true, "pending=0 但 >24h 未更新 ⇒ 仍告警（守护可能已死）");

	// 缺字段不得抛
	const empty = judgeIndexFreshness({}, now);
	assert.equal(empty.pendingTotal, null);
	assert.equal(typeof empty.warning, "string");
	ok("④ 陈旧判定：pendingChanges>0 告警 / >24h 未更新也告警 / 新鲜时不打扰");
}

// ── ⑤ dispatch：未初始化明确拒绝，不静默回退 ────────────────────────
{
	const noRootDeps: DispatchDeps = {
		run: async () => ({ stdout: "", stderr: "", code: 0, timedOut: false }),
		findRoot: () => null,
		now: () => Date.now(),
	};
	const r = await dispatchCodegraph({ action: "query", query: "player", cwd: "X:/nope" }, noRootDeps);
	assert.equal(r.isError, true, "未初始化 ⇒ isError");
	assert.ok(r.text.includes("仓库级"), "说明这是仓库级索引");
	assert.ok(r.text.includes("codegraph init"), "给出初始化命令");
	assert.ok(r.text.includes("read / grep / wiki-nav"), "给出回退方案");
	// 关键：绝不能静默成功（那会让 agent 以为查到了）
	assert.ok(!r.text.includes("命中"), "不得假装有结果");
	ok("⑤ 未初始化：明确报错 + 给初始化命令 + 给回退方案，不静默成功");
}

// ── ⑥ dispatch：query 结果必须带 file:line 且陈旧时附告警 ──────────
{
	const queryJson = JSON.stringify([
		{ node: { kind: "function", name: "build_parser", filePath: "battledocs/cli.py", startLine: 265 } },
	]);
	let call = 0;
	const deps: DispatchDeps = {
		run: async (args) => {
			call += 1;
			if (args[0] === "query") return { stdout: queryJson, stderr: "", code: 0, timedOut: false };
			// status（query 后自动查新鲜度）
			return {
				stdout: JSON.stringify({ lastIndexed: "2026-10-28T06:07:21.493Z", pendingChanges: { added: 3, modified: 0, removed: 0 } }),
				stderr: "",
				code: 0,
				timedOut: false,
			};
		},
		findRoot: () => "X:/repo",
		now: () => Date.parse("2026-10-31T12:00:00Z"),
	};
	const r = await dispatchCodegraph({ action: "query", query: "parse", cwd: "X:/repo" }, deps);
	assert.equal(r.isError, undefined, "正常查询不算错误");
	assert.ok(r.text.includes("build_parser"), "含符号名");
	assert.ok(r.text.includes("battledocs/cli.py:265"), "含可跳转的 file:line");
	assert.ok(r.text.includes("⚠"), "陈旧索引必须附告警（否则行号可能是错的）");
	assert.equal(call, 2, "query 之后要额外查一次 status 判新鲜度");
	ok("⑥ query：返回 file:line + 陈旧时自动附告警（行号可能失真的防护）");
}

// ── ⑦ dispatch：CLI 失败/坏 JSON 不得抛 ─────────────────────────────
{
	const brokenDeps: DispatchDeps = {
		run: async () => ({ stdout: "garbage", stderr: "boom", code: 1, timedOut: false }),
		findRoot: () => "X:/repo",
		now: () => Date.now(),
	};
	const r = await dispatchCodegraph({ action: "query", query: "x", cwd: "X:/repo" }, brokenDeps);
	assert.equal(r.isError, true, "坏 JSON ⇒ isError 而不是抛");
	assert.ok(r.text.includes("解析失败"), "说明是解析失败");
	assert.ok(r.text.length < 2000, "错误信息不得倾倒海量原始输出");
	ok("⑦ CLI 失败/坏 JSON：返回 isError + 简洁原因，绝不抛");
}

// ── ⑨ 小模型参数容错（2026-11-02 实测驱动：6 个 lane 会话 / 8 次调用）──
// 实测：1/8 传空参数 {} ⇒ zod 只回「action: Required」；3/8 把整句中文当 query 的符号名 ⇒ 全 0 命中。
{
	const act = (v: unknown): string => {
		const r = normalizeCodegraphAction(v);
		return r.ok ? r.action : "!";
	};
	assert.equal(act("search"), "query", "search→query");
	assert.equal(act("callers"), "impact", "callers→impact");
	assert.equal(act("overview"), "explore", "overview→explore");
	assert.equal(act("list"), "files", "list→files");
	assert.equal(act("CONTEXT"), "context", "大小写不敏感");
	ok("⑨a action 别名/大小写归一");

	const noAct = normalizeCodegraphAction(undefined);
	assert.equal(noAct.ok, false, "没传 action 必拒");
	const t1 = noAct.ok ? "" : noAct.text;
	assert.ok(t1.includes("没传 action"), "说明是没传 action");
	assert.ok(t1.includes('"action": "query"'), "给出可拄的完整例子");
	assert.ok(t1.includes("query | explore | context | impact | status | files | sync"), "列出全部合法动作");
	assert.ok(!t1.includes("Required"), "不得把 zod 原文丢给模型");
	assert.equal(normalizeCodegraphAction("seach").ok, false, "拼错的 action 必拒（不静默猜测）");
	ok("⑨b 空/非法 action 返回带示例的指引，不丢 zod 原文");

	const hint = queryShapeHint("query", "trace-fusion diagnose 模式三路 lane 各自必须产出哪些 artifact 文件");
	assert.ok(hint !== null, "整句中文当符号名必须被拦住");
	assert.ok(hint!.includes("必定 0 命中"), "直说这类输入注定空转");
	assert.ok(hint!.includes("trace-fusion"), "给出从该句抽到的标识符候选");
	assert.ok(hint!.includes('"action": "context"'), "把整句引到 context");
	assert.equal(queryShapeHint("query", "laneDir"), null, "短符号名放行");
	assert.equal(queryShapeHint("context", "trace-fusion 三路 lane 必须产出哪些 artifact 文件"), null, "整句在 context 下放行");

	// 【接线断言，不是函数本体】必须证明守卫真的接在 dispatchCodegraph 里，
	// 并且拦住时**一次 CLI 都不调用**（避开注定空转的那一次）。
	let cliCalls = 0;
	const guardDeps: DispatchDeps = {
		run: async (a) => {
			cliCalls += 1;
			return { stdout: JSON.stringify({ results: [] }), stderr: "", code: 0, timedOut: false };
		},
		findRoot: () => "X:/repo",
		now: () => Date.now(),
	};
	const guarded = await dispatchCodegraph(
		{ action: "query", query: "trace-fusion diagnose 模式三路 lane 各自必须产出哪些 artifact 文件", cwd: "X:/repo" },
		guardDeps,
	);
	assert.ok(guarded.text.includes("必定 0 命中"), "dispatchCodegraph 必须真的走句子守卫");
	assert.equal(cliCalls, 0, "拦住时不得调用 CLI（不白跑一次注定空的搜索）");
	ok("⑨c 整句当符号名被拦住并给候选；符号名与 context 整句放行；守卫已接在 dispatch 上且零 CLI 调用");

	const emptyDeps: DispatchDeps = {
		run: async (a) => ({
			stdout: a[0] === "status" ? JSON.stringify({ upToDate: true, files: 10 }) : JSON.stringify({ results: [] }),
			stderr: "",
			code: 0,
			timedOut: false,
		}),
		findRoot: () => "X:/repo",
		now: () => Date.now(),
	};
	const zero = await dispatchCodegraph({ action: "query", query: "lane_dir", cwd: "X:/repo" }, emptyDeps);
	assert.ok(zero.text.includes("0 命中"), "报 0 命中");
	assert.ok(zero.text.includes("换写法"), "给换写法建议");
	assert.ok(zero.text.includes('"action": "files"'), "给查文件列表的下一步");
	assert.ok(zero.text.includes("grep -rn"), "字面串引到 grep");
	assert.ok(zero.text.includes("GDScript"), "提醒 *.gd 本工具查不到");
	ok("⑨d 0 命中返回可执行的下一步，不是只说没结果");

	const bigDeps: DispatchDeps = {
		run: async () => ({ stdout: "x".repeat(30_000), stderr: "", code: 0, timedOut: false }),
		findRoot: () => "X:/repo",
		now: () => Date.now(),
	};
	const ex = await dispatchCodegraph({ action: "explore", query: "artifact 链路", cwd: "X:/repo" }, bigDeps);
	assert.ok(ex.text.length < 20_000, `explore 输出必须被截到上限（实得 ${ex.text.length}）`);
	assert.ok(ex.text.includes("输出截断"), "必须显式告知截断");
	assert.ok(ex.text.includes("read"), "告知看完整内容用 read 精读 file:line");
	const small = await dispatchCodegraph(
		{ action: "explore", query: "laneDir", cwd: "X:/repo" },
		{ ...bigDeps, run: async () => ({ stdout: "y".repeat(3_000), stderr: "", code: 0, timedOut: false }) },
	);
	assert.ok(!small.text.includes("输出截断"), "未超上限不得假装截断");
	ok("⑨e explore 超上限截断并显式告知；未超不截");
}

console.log(`\ncodegraph tests passed (${n} checks)`);
