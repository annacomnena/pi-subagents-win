/**
 * _test_model_retry — 同模型有界重试（2026-10-18）
 *
 * 背景：`runWithFallback` 旧逻辑「retryable ⇒ 试试**下一个候选**」，**从不重试同一个模型**。
 * `general` 不在 config.json 的 fallbackModels 里 ⇒ 候选数 = 1 ⇒ 第一次失败即终态。
 * R-7b 实测的 Cloudflare 封禁是 45–60s **自愈**的 ⇒ 不重试 = 把可自愈故障当终态上报。
 *
 * 原理（**真实接线级，不 mock runSingle**）：`PI_CLI_PATH` 指向一个临时 stub `.mjs`，
 * 真跑 `runWithFallback → runSingle → spawn → 解析管线`。stub 用 `STUB_COUNTER` 文件计数，
 * 计数 ≤ `STUB_FAIL_TIMES` 时 `console.error(STUB_ERROR)` + `exit(1)`，否则打印与
 * `_test_parallel_async.ts` 同形的 `message_end`（stopReason:"stop"）。
 *
 * 运行：node --experimental-strip-types --import ./extensions/runtime-host/pi-deps-loader.mjs ./extensions/_test_model_retry.ts
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── 环境隔离：主会话身份 / 成本表（表缺失 ⇒ fail-open，避免 costTier 干扰）──
delete process.env.PI_SUBAGENT;
delete process.env.PI_TAB_RUN_ID;
delete process.env.PI_TAB_RUNS_DIR;
delete process.env.PI_SESSION_PROFILE;
delete process.env.PI_COST_TIER_ENFORCE;
delete process.env.PI_SUBAGENT_RETRY_MAX;

const TMP = mkdtempSync(join(tmpdir(), "pi-model-retry-"));
process.env.PI_MODEL_COST_TIERS_PATH = join(TMP, "nonexistent-cost-tiers.json");

// ── stub pi CLI：可配置失败次数 ─────────────────
const STUB_PATH = join(TMP, `pi-stub-cli-model-retry-${process.pid}.mjs`);
writeFileSync(
	STUB_PATH,
	`import { readFileSync, writeFileSync } from "node:fs";
const f = process.env.STUB_COUNTER;
let n = 0;
try { n = Number(String(readFileSync(f, "utf8")).trim() || "0"); } catch { n = 0; }
if (!Number.isFinite(n)) n = 0;
n += 1;
writeFileSync(f, String(n));
const failTimes = Number(process.env.STUB_FAIL_TIMES || "0");
if (n <= failTimes) {
	console.error(process.env.STUB_ERROR || "stub-fail");
	process.exit(1);
}
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "stub-output-ok" }], usage: { input: 11, output: 22 }, model: "stub-1" } }));
`,
	"utf8",
);
process.env.PI_CLI_PATH = STUB_PATH;

const { runWithFallback, SAME_MODEL_RETRY, SAME_MODEL_NEVER_RETRY, resolveSameModelRetryMax, describeSameModelRetries } =
	await import("./index.ts");

let passed = 0;
const ok = (name: string): void => { passed += 1; console.log(`ok ${passed} - ${name}`); };

const MODEL = "TestSuite/stub-1";
/** 「general」不在 config.json 的 fallbackModels 里 ⇒ 单候选（与真机 general 派发同形）。 */
const AGENT = { name: "general", body: "test agent" };

let caseSeq = 0;
interface CaseEnv {
	counterFile: string;
}
/** 每个用例独立的 counter 文件（避免串味）。 */
function newCounter(): CaseEnv {
	caseSeq += 1;
	const counterFile = join(TMP, `counter-${process.pid}-${caseSeq}.txt`);
	writeFileSync(counterFile, "0", "utf8");
	process.env.STUB_COUNTER = counterFile;
	return { counterFile };
}
/** 实测 spawn 次数（stub 自己写的计数 ⇒ 真实子进程数，不是 mock 调用数）。 */
function spawns(env: CaseEnv): number {
	return Number(readFileSync(env.counterFile, "utf8").trim() || "0");
}

/** 统一跑一次单候选派发，收集 onUpdate 状态行。 */
async function run(opts: { signal?: AbortSignal; timeoutMs?: number } = {}) {
	const updates: string[] = [];
	const res = await runWithFallback(
		AGENT,
		"retry test task",
		undefined,
		MODEL,
		opts.timeoutMs ?? 20000,
		opts.signal,
		(s) => { updates.push(s); },
	);
	return { res, updates };
}

// 默认缩短退避（用例 7 会临时删掉此 env，用真实 30s 基准验证「不睡满」）
process.env.PI_SUBAGENT_RETRY_BACKOFF_MS = "5";

// ── 1. maxSameModel=2 + 全失败 ⇒ spawn 3 次 + 2 条 ⟳ 提示 ────────────
{
	const env = newCounter();
	process.env.STUB_FAIL_TIMES = "99";
	process.env.STUB_ERROR = "Connection error.";
	assert.equal(resolveSameModelRetryMax(), 2, "default maxSameModel 应为 2");
	const { res, updates } = await run();
	assert.equal(spawns(env), 3, `全失败应 spawn 3 次（1 首次 + 2 重试），实测 ${spawns(env)}`);
	const retryLines = updates.filter((s) => s.includes("⟳ 同模型重试"));
	assert.equal(retryLines.length, 2, `应出现 2 条 ⟳ 提示，实测 ${JSON.stringify(retryLines)}`);
	assert.ok(retryLines[0].includes("PROVIDER_NETWORK"), `重试提示应带类别标签：${retryLines[0]}`);
	assert.equal(res.status, "failed", "全失败终态应为 failed");
	ok("[1] maxSameModel=2 + 全失败 ⇒ spawn 3 次 + 2 条 ⟳ 同模型重试（PROVIDER_NETWORK）");
}

// ── 2. 第 2 次成功 ⇒ spawn 2 次、completed ─────────────────────────
{
	const env = newCounter();
	process.env.STUB_FAIL_TIMES = "1";
	process.env.STUB_ERROR = "Connection error.";
	const { res, updates } = await run();
	assert.equal(spawns(env), 2, `第 2 次成功应 spawn 2 次，实测 ${spawns(env)}`);
	assert.equal(res.status, "completed", `第 2 次成功后应为 completed，实测 ${res.status} (${res.error ?? ""})`);
	assert.ok(String(res.text).includes("stub-output-ok"), `成功正文应含 stub-output-ok，实测 ${res.text}`);
	assert.equal(updates.filter((s) => s.includes("⟳ 同模型重试")).length, 1, "只应重试 1 次");
	ok("[2] 第 2 次成功 ⇒ spawn 2 次 + completed + 正文 stub-output-ok");
}

// ── 3. PI_SUBAGENT_RETRY_MAX=0 ⇒ 零行为变化（形状逐字节同旧）───────
{
	const env = newCounter();
	process.env.STUB_FAIL_TIMES = "99";
	process.env.STUB_ERROR = "Connection error.";
	process.env.PI_SUBAGENT_RETRY_MAX = "0";
	assert.equal(resolveSameModelRetryMax(), 0, "env seam 应把 max 钳到 0");
	const { res, updates } = await run();
	assert.equal(spawns(env), 1, `max=0 应只 spawn 1 次，实测 ${spawns(env)}`);
	assert.deepEqual(res.triedModels, [MODEL], `max=0 时 triedModels 必须与旧单候选行为一致，实测 ${JSON.stringify(res.triedModels)}`);
	assert.equal(updates.filter((s) => s.includes("⟳ 同模型重试")).length, 0, "max=0 不应出现 ⟳ 提示");
	const fails = res.priorFailures ?? [];
	assert.equal(fails.length, 1, `max=0 时 priorFailures 应只有 1 条，实测 ${fails.length}`);
	assert.deepEqual(Object.keys(fails[0]).sort(), ["error", "kind", "model"], `max=0 时条目形状必须与旧行为一致，实测 ${JSON.stringify(Object.keys(fails[0]))}`);
	assert.ok(!String(res.error ?? "").includes("retries="), `max=0 时 error 不得被包装：${res.error}`);
	assert.ok(String(res.error ?? "").includes("Connection error."), `原始 error 应保留：${res.error}`);
	delete process.env.PI_SUBAGENT_RETRY_MAX;
	ok("[3] max=0 ⇒ spawn 1 次 + priorFailures 形状=旧（3 键）+ error 不含 retries=（零行为变化）");
}

// ── 4. wall_budget / stall / auth ⇒ 不重试（auth 靠黑名单挡住）─────
{
	const neverCases = [
		{ err: "wall-budget-exceeded", name: "wall_budget" },
		{ err: "stall-timeout", name: "stall" },
		{ err: "401 unauthorized", name: "auth（classify retryable=true，黑名单必须挡）" },
	];
	for (const c of neverCases) {
		const env = newCounter();
		process.env.STUB_FAIL_TIMES = "99";
		process.env.STUB_ERROR = c.err;
		const { res, updates } = await run();
		assert.equal(spawns(env), 1, `${c.name} 不得重试（应 spawn 1 次），实测 ${spawns(env)} err=${res.error}`);
		assert.equal(updates.filter((s) => s.includes("⟳ 同模型重试")).length, 0, `${c.name} 不应出现 ⟳ 提示`);
		assert.equal(res.status, "failed", `${c.name} 终态 failed`);
	}
	ok("[4] wall_budget / stall / auth ⇒ 各 spawn 1 次、零重试（auth 黑名单生效）");
}

// ── 5. usage_cap ⇒ 会重试（spawn 3 次）─────────────────────────────
{
	const env = newCounter();
	process.env.STUB_FAIL_TIMES = "99";
	process.env.STUB_ERROR = "429 too many requests";
	// 100ms 基准下 usage_cap 的两段退避应为 200ms + 400ms；普通类别仅为 100ms + 200ms。
	process.env.PI_SUBAGENT_RETRY_BACKOFF_MS = "100";
	const t0 = Date.now();
	const { res, updates } = await run();
	const elapsed = Date.now() - t0;
	assert.ok(elapsed >= 500, `usage_cap 应实等约 600ms（普通同次数约 300ms），实测 ${elapsed}ms`);
	process.env.PI_SUBAGENT_RETRY_BACKOFF_MS = "5";
	assert.equal(spawns(env), 3, `usage_cap 应重试到上限（spawn 3 次），实测 ${spawns(env)}`);
	assert.equal(updates.filter((s) => s.includes("⟳ 同模型重试")).length, 2, "usage_cap 应重试 2 次");
	assert.ok(String(res.error ?? "").includes("USAGE_CAP"), `终态应标 USAGE_CAP：${String(res.error).slice(0, 200)}`);
	ok(`[5] usage_cap ⇒ 重试（spawn 3 次、退避 ${elapsed}ms ≥500ms，长于普通 300ms 曲线、终态带 USAGE_CAP）`);
}

// ── 6. 单候选 + 重试耗尽 ⇒ failed + priorFailures=3 + error 含记录 ──
{
	const env = newCounter();
	process.env.STUB_FAIL_TIMES = "99";
	process.env.STUB_ERROR = "Connection error.";
	const { res } = await run();
	assert.equal(spawns(env), 3, `耗尽应 spawn 3 次，实测 ${spawns(env)}`);
	assert.equal(res.status, "failed", "耗尽终态 failed");
	const fails = res.priorFailures ?? [];
	assert.equal(fails.length, 3, `耗尽时 priorFailures 应为 3 条，实测 ${fails.length}`);
	assert.deepEqual(Object.keys(fails[0]).sort(), ["error", "kind", "model"], "首条仍是旧形状（3 键）");
	assert.deepEqual(Object.keys(fails[1]).sort(), ["attempt", "error", "kind", "model"], "重试条目追加 attempt");
	assert.equal(fails[1].attempt, 2, "第 2 条 attempt=2");
	assert.equal(fails[2].attempt, 3, "第 3 条 attempt=3");
	const err = String(res.error ?? "");
	assert.ok(err.includes("retries=2/2"), `error 必须含 retries=2/2：${err.slice(-300)}`);
	assert.ok(err.includes("[1]") && err.includes("[2]") && err.includes("[3]"), `error 必须含三行尝试记录：${err.slice(-300)}`);
	assert.ok(err.includes("Connection error."), "error 保留原始错误串");
	assert.ok(err.startsWith("Connection error."), "记录块接在原始 error 之后（原始串在最前）");
	assert.ok(err.includes("fallback 候选 0 个"), `fallbackCount 应为 0（单候选）：${err.slice(-300)}`);
	ok("[6] 单候选 + 重试耗尽 ⇒ failed + priorFailures=3 + error 含 retries=2/2 与 [1]/[2]/[3]");
}

// ── 7. abort 打断退避（用真实 30s 基准，证明「不睡满」）─────────────
{
	const env = newCounter();
	process.env.STUB_FAIL_TIMES = "99";
	process.env.STUB_ERROR = "Connection error.";
	delete process.env.PI_SUBAGENT_RETRY_BACKOFF_MS; // 真实 30s 基准
	const controller = new AbortController();
	const t0 = Date.now();
	const timer = setTimeout(() => controller.abort(), 1500);
	const { res, updates } = await run({ signal: controller.signal });
	clearTimeout(timer);
	const elapsed = Date.now() - t0;
	assert.ok(elapsed < 6000, `退避应被 abort 打断（<6000ms），实测 ${elapsed}ms`);
	assert.equal(res.status, "cancelled", `abort 打断后终态应为 cancelled，实测 ${res.status}`);
	assert.equal(spawns(env), 1, `被打断后不得再 spawn，实测 ${spawns(env)}`);
	assert.ok(updates.some((s) => s.includes("退避等待被中断")), `应留下中断提示：${JSON.stringify(updates.slice(-4))}`);
	process.env.PI_SUBAGENT_RETRY_BACKOFF_MS = "5"; // 还原：后续用例不依赖
	ok(`[7] abort 打退避 ⇒ ${elapsed}ms（<6000）、cancelled、spawn 1 次（未睡满 30s）`);
}

// ── 8. 纯函数：退避曲线 + 黑名单内容 ──────────────────────────────
{
	assert.equal(SAME_MODEL_RETRY.backoffMs(1), 30_000, "backoffMs(1) 应为 30000（R-7b ≥30s）");
	assert.equal(SAME_MODEL_RETRY.backoffMs(2), 60_000, "backoffMs(2) 应为 60000");
	assert.equal(SAME_MODEL_RETRY.backoffMs(3), 60_000, "backoffMs(3) 应被上限钳到 60000");
	assert.equal(SAME_MODEL_RETRY.backoffMs(9), 60_000, "backoffMs(9) 不得超上限 60000");
	assert.deepEqual([...SAME_MODEL_NEVER_RETRY].sort(), ["auth", "stall", "wall_budget"], `黑名单应恰为 wall_budget/stall/auth，实测 ${JSON.stringify([...SAME_MODEL_NEVER_RETRY])}`);
	// 终态文案形状（纯函数直测）
	const text = describeSameModelRetries({
		attempts: [{ attempt: 1, label: "PROVIDER_NETWORK", error: "Connection error." }],
		retries: 1, max: 2, label: "PROVIDER_NETWORK", fallbackCount: 0,
	});
	assert.ok(text.includes("retries=1/2"), `文案应含 retries=1/2：${text}`);
	assert.ok(text.includes("[1] Connection error."), `文案应含尝试行：${text}`);
	ok("[8] backoffMs(1)=30000 / (2)=60000 / (9)=60000 + 黑名单恰含 wall_budget/stall/auth + 文案形状");
}

// ── 清理 ───────────────────────────────────────
try { if (existsSync(STUB_PATH)) unlinkSync(STUB_PATH); } catch { /* ignore */ }

console.log(`\nAll model-retry tests passed. (${passed} groups)`);
