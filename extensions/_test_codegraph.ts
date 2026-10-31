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
	parseJsonOutput,
	projectSymbolHits,
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
	mkdirSync(join(repo, ".git"), { recursive: true });
	mkdirSync(join(own, ".git"), { recursive: true });
	mkdirSync(join(own, ".codegraph"), { recursive: true });
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

// ── ② 结构化投影 ───────────────────────────────────────────────────
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

console.log(`\ncodegraph tests passed (${n} checks)`);
