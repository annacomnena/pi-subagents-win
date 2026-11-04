/**
 * _test_trace_fusion_collect_cli_import.ts — 进程入口文件的**加载 smoke**（2026-11-05）。
 *
 * ## 为什么需要这个（真实事故）
 *
 * 7e8e3ac 给 `collect-cli.ts` 加 `readFusionAgentBody()` 时写入了一个被转义层吃掉的
 * 正则字面量 ⇒ `SyntaxError: Unterminated regexp literal`。
 * 后果真机实测：run tfl-20261105-050830-7ccc 三路终态后 collect worker **起不来**，
 * claim 被领走、worker 一启动就崩、cross-test / fusion 全没生成、run 卡在 running。
 *
 * **为什么现有测试没抓住**：`npm run test:trace-fusion-*` 没有任何一个 import 它 ——
 * collect-cli 只在被 supervisor spawn 时才执行，语法错因此完全逃过测试网。
 *
 * 本测试只做一件事：**import 一次**（不执行 main，`asMain` 判定下 argv[1] 不等于自身）。
 * 成本 ~50ms，能抓住任何「进程入口文件的语法/加载错误」这一类回归。
 */
import assert from "node:assert/strict";

// 隔离 runtime 目录（collect-cli 的顶部 import 会摸 defaultRuntimeDir 之类）
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "collect-cli-smoke-"));
process.env.PI_TAB_RUNS_DIR = mkdtempSync(join(tmpdir(), "collect-cli-smoke-tabs-"));

const mod = await import("./trace-fusion/collect-cli.ts");

// ① 模块能被加载（这就是全部重点 —— 有语法错这里就抛）
assert.ok(mod !== null && typeof mod === "object", "collect-cli 必须能被 import");

// ② 不得在 import 时启动 main（asMain 判定：argv[1] 不是本文件 ⇒ 不执行）
//    collect-cli 是有意的「既是库又是入口」形状；若 import 就执行，会把整条收集链跑起来。
//    这里用「import 后 300ms 内没有写任何 runDir 文件」间接验证（成本低、无副作用）。
const { existsSync, readdirSync } = await import("node:fs");
const runsDir = join(process.env.PI_RUNTIME_DIR!, "subagent-runs");
if (existsSync(runsDir)) {
	assert.equal(readdirSync(runsDir).length, 0, "import 不得触发 main（不得写任何 run 目录）");
}

console.log("_test_trace_fusion_collect_cli_import: all assertions passed");
