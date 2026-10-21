/**
 * _test_session_usage.ts — 会话上下文用量投影回归门（2026-10-21）
 *
 * ## 三个指标的口径必须钉死，否则读数会系统性错
 *
 * 1. **tokens** = 最后一条 assistant 的 `totalTokens`（provider 权威值）
 * 2. **percent** = tokens / contextWindow；窗口未知 ⇒ null（**不猜**）
 * 3. **cachePercent** = `cacheRead / (cacheRead + input)`
 *    ⚠️ **不是** `cacheRead / totalTokens` —— totalTokens 含 output，output 永不可能命中缓存，
 *    放进分母会系统性压低读数。这是本模块最容易被后人"顺手改错"的一处，所以单列一组钉住。
 *
 * 另：`pickLastUsage` 从**末尾往前**找，避免读全 152MB 会话（本机实测有 152.4MB 的 .jsonl）。
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeUsage, pickLastUsage, readSessionUsage } from "./runtime/session-usage.ts";

let n = 0;
const ok = (m: string): void => {
	n++;
	console.log(`ok ${n} - ${m}`);
};

// ── U1 tokens：优先 totalTokens，缺失才合成 ────────────────────
{
	const a = computeUsage({ input: 100, cacheRead: 900, output: 50, totalTokens: 1050 }, 10_000);
	assert.equal(a.tokens, 1050, "有 totalTokens ⇒ 用它（权威）");

	const b = computeUsage({ input: 100, cacheRead: 900, output: 50 }, 10_000);
	assert.equal(b.tokens, 1050, "无 totalTokens ⇒ 合成 input+cacheRead+output");

	const c = computeUsage({ input: 0, cacheRead: 0, output: 0 }, 10_000);
	assert.equal(c.tokens, null, "全 0 ⇒ null（不编造 0 长度）");

	const d = computeUsage(null, 10_000);
	assert.equal(d.tokens, null, "无 usage ⇒ null");
	assert.deepEqual(d.detail, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
	ok("U1 tokens：totalTokens 优先 / 缺失才合成 / 全 0 与无 usage ⇒ null");
}

// ── U2 percent：窗口未知 ⇒ null（不猜）──────────────────────────
{
	const known = computeUsage({ totalTokens: 2500 }, 10_000);
	assert.equal(known.percent, 25, "2500/10000 = 25%");

	const noWin = computeUsage({ totalTokens: 2500 }, null);
	assert.equal(noWin.percent, null, "窗口未知 ⇒ percent=null（**不得**用别的数凑）");
	assert.equal(noWin.tokens, 2500, "但 tokens 仍如实给");

	const zeroWin = computeUsage({ totalTokens: 2500 }, 0);
	assert.equal(zeroWin.percent, null, "窗口 0 ⇒ null（防除零）");

	// 两位小数
	const frac = computeUsage({ totalTokens: 1234 }, 37_000);
	assert.equal(frac.percent, 3.34, "1234/37000 = 3.3351… ⇒ 3.34（两位四舍五入）");
	ok("U2 percent：对 / 窗口未知或 0 ⇒ null / 两位小数");
}

// ── U3 cachePercent 口径：**只看输入侧**（核心，防后人改错）──────
{
	// 真实样本（本机 2026-10-21 实测的一条 usage）
	const real = computeUsage({ input: 191, output: 245, cacheRead: 319232, cacheWrite: 0, totalTokens: 319668 }, 1_000_000);
	assert.equal(real.cachePercent, 99.94, "319232/(319232+191) = 99.94%");
	// 反证：若按 cacheRead/totalTokens 算会是多少？
	const wrong = Math.round((319232 / 319668) * 10000) / 100;
	assert.notEqual(real.cachePercent, wrong, `**不得**用 totalTokens 作分母（那会得 ${wrong}%）`);

	// output 大、cacheRead 高时差异最明显：证明口径选择有实际影响
	const bigOut = computeUsage({ input: 1000, cacheRead: 9000, output: 90_000, totalTokens: 100_000 }, 200_000);
	assert.equal(bigOut.cachePercent, 90, "9000/(9000+1000)=90%（output 不参与）");
	const wrongBig = Math.round((9000 / 100_000) * 10000) / 100;
	assert.equal(wrongBig, 9, `若错用 totalTokens 会报 ${wrongBig}% —— 差 10 倍，这就是防它的理由`);
	assert.ok(bigOut.cachePercent! > wrongBig * 9, "两种口径差一个量级");

	// 无输入 ⇒ null（不报 0% 误导）
	const noInput = computeUsage({ input: 0, cacheRead: 0, output: 500, totalTokens: 500 }, 1000);
	assert.equal(noInput.cachePercent, null, "无输入 ⇒ null（报 0% 会让人以为缓存完全失效）");

	// cacheWrite 不进分母（它是首次写入成本，不是本次输入）
	const withWrite = computeUsage({ input: 100, cacheRead: 900, cacheWrite: 5000, totalTokens: 6000 }, 10_000);
	assert.equal(withWrite.cachePercent, 90, "cacheWrite 不计入分母");
	assert.equal(withWrite.detail.cacheWrite, 5000, "但明细里如实给 cacheWrite");
	ok("U3 cachePercent：只看输入侧 / 反证 totalTokens 分母会差一个量级 / cacheWrite 不进分母");
}

// ── U4 pickLastUsage：从末尾往前找，取最后一条 ─────────────────
{
	const mk = (role: string, usage: unknown, at?: string): unknown => ({
		message: { role, ...(usage !== null ? { usage } : {}), ...(at !== undefined ? { timestamp: at } : {}) },
	});
	const lines = [
		mk("user", null),
		mk("assistant", { totalTokens: 100 }, "2026-01-01T00:00:00Z"),
		mk("user", null),
		mk("assistant", { totalTokens: 200 }, "2026-01-01T00:01:00Z"), // ← 最新
		mk("user", null),
	];
	const hit = pickLastUsage(lines);
	assert.equal((hit!.usage as { totalTokens: number }).totalTokens, 200, "取**最后一条**带 usage 的 assistant");
	assert.equal(hit!.at, "2026-01-01T00:01:00Z", "带出 timestamp");

	// 末尾有 assistant 但**没有** usage ⇒ 跳过，继续往前
	const lines2 = [...lines.slice(0, 4), mk("assistant", null)];
	const hit2 = pickLastUsage(lines2);
	assert.equal((hit2!.usage as { totalTokens: number }).totalTokens, 200, "末尾无 usage ⇒ 跳到上一条有 usage 的");

	assert.equal(pickLastUsage([mk("user", null)]), null, "无 assistant ⇒ null");
	assert.equal(pickLastUsage([]), null, "空 ⇒ null");

	// maxLines 限制：只扫描末尾 N 行
	const many = [mk("assistant", { totalTokens: 111 }, "t0"), ...Array.from({ length: 50 }, () => mk("user", null))];
	assert.equal(pickLastUsage(many, 10), null, "maxLines=10 且末尾 10 行无 usage ⇒ null（不扫全文件）");
	assert.notEqual(pickLastUsage(many, 100), null, "放大窗口就能找到");
	ok("U4 pickLastUsage：取最后一条 / 跳过无 usage / maxLines 生效");
}

// ── U5 readSessionUsage：真实文件端到端（含坏行）────────────────
{
	const dir = mkdtempSync(join(tmpdir(), "usage-"));
	const f = join(dir, "s.jsonl");
	const lines = [
		JSON.stringify({ type: "session", id: "sid" }),
		"这不是 JSON（坏行应被跳过）",
		JSON.stringify({ message: { role: "assistant", usage: { input: 10, cacheRead: 990, output: 0, totalTokens: 1000 }, timestamp: "2026-01-01T00:00:00Z" } }),
		"",
		JSON.stringify({ message: { role: "user" } }),
	];
	writeFileSync(f, lines.join("\n") + "\n", "utf8");
	const u = readSessionUsage(f, 4000);
	assert.equal(u.tokens, 1000, "真实文件读到 tokens");
	assert.equal(u.percent, 25, "1000/4000 = 25%");
	assert.equal(u.cachePercent, 99, "990/(990+10) = 99%");
	assert.equal(u.at, "2026-01-01T00:00:00Z");
	assert.equal(readSessionUsage(join(dir, "nope.jsonl"), 4000).tokens, null, "文件不存在 ⇒ null（不抛）");
	assert.equal(readSessionUsage(f, null).percent, null, "窗口未知 ⇒ percent null 但 tokens 有值");
	ok("U5 readSessionUsage：真实文件 / 坏行跳过 / 文件不存在不抛");
}

// ── U6 尾部块读：大文件只读尾块（不是全量）──────────────────────
{
	const dir = mkdtempSync(join(tmpdir(), "usage-big-"));
	const f = join(dir, "big.jsonl");
	// 造 ~2MB：前面大量无关行，末尾一条带 usage
	const filler = JSON.stringify({ message: { role: "user", content: "x".repeat(200) } });
	const head = Array.from({ length: 9000 }, () => filler).join("\n");
	const tail = JSON.stringify({ message: { role: "assistant", usage: { totalTokens: 777, input: 7, cacheRead: 770 } } });
	writeFileSync(f, `${head}\n${tail}\n`, "utf8");
	const t0 = Date.now();
	const u = readSessionUsage(f, 10_000);
	const ms = Date.now() - t0;
	assert.equal(u.tokens, 777, "从大文件尾部正确读到");
	assert.ok(ms < 500, `尾部块读应快（实测 ${ms}ms；若全量读 2MB+ 会明显更慢）`);
	ok(`U6 尾部块读：2MB 文件 ${ms}ms 读到末条 usage（不全量读）`);
}

console.log(`\n_test_session_usage: all assertions passed (${n} groups)`);
