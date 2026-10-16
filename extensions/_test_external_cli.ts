import assert from "node:assert/strict";
import {
	EXTERNAL_BACKENDS,
	buildAtomcodeArgs,
	buildMimoArgs,
	buildZcodeArgs,
	detectAvailableBackends,
	isExternalCliModel,
	listExternalCliModelOptions,
	normalizeExternalCliModel,
	parseExternalCliModel,
} from "./external-cli.ts";

assert.equal(isExternalCliModel("cli:atomcode"), true);
assert.equal(isExternalCliModel(" CLI:AtomCode "), true);
assert.deepEqual(parseExternalCliModel("CLI:AtomCode"), {
	backend: "atomcode",
	canonical: "cli:atomcode",
});
assert.equal(parseExternalCliModel("cli:atomcode/other-model"), null);
assert.equal(parseExternalCliModel("cli:unknown"), null);
assert.equal(normalizeExternalCliModel("  CLI:AtomCode "), "cli:atomcode");
assert.throws(() => normalizeExternalCliModel("cli:unknown"), /atomcode/);
assert.deepEqual(buildAtomcodeArgs("say hello"), ["-y", "-p", "say hello"]);
assert.deepEqual(buildZcodeArgs("say hello"), ["-p", "say hello"]);
assert.deepEqual(buildMimoArgs("say hello", "C:/repo"), [
	"run", "say hello", "--format", "json", "--dangerously-skip-permissions", "--dir", "C:/repo",
]);

assert.deepEqual(parseExternalCliModel("cli:zcode"), {
	backend: "zcode",
	canonical: "cli:zcode",
});
assert.equal(parseExternalCliModel("cli:zcode/other-model"), null);
assert.equal(normalizeExternalCliModel("  CLI:ZCode "), "cli:zcode");
assert.deepEqual(parseExternalCliModel("cli:mimo"), {
	backend: "mimo",
	canonical: "cli:mimo",
});
assert.equal(parseExternalCliModel("cli:mimo/other-model"), null);
assert.equal(normalizeExternalCliModel("  CLI:Mimo "), "cli:mimo");
assert.equal(normalizeExternalCliModel("cli:mimocode"), "cli:mimo", "产品名别名应归一到可执行文件名");

for (const backend of ["claude", "codex", "agy", "atomcode", "zcode", "mimo"] as const) {
	assert.deepEqual(parseExternalCliModel(`cli:${backend}`), {
		backend,
		canonical: `cli:${backend}`,
	});
}

const options = listExternalCliModelOptions();
assert.equal(options.length, EXTERNAL_BACKENDS.length);
assert.equal(options.some((option) => option.ref === "cli:atomcode" && option.label.includes("AtomCode")), true);
assert.equal(options.some((option) => option.ref === "cli:zcode" && option.label.includes("ZCode")), true);
assert.equal(options.some((option) => option.ref === "cli:mimo" && option.label.includes("MimoCode")), true);

const available = detectAvailableBackends();
assert.equal(typeof available.atomcode, "boolean");
assert.equal(typeof available.zcode, "boolean");
assert.equal(typeof available.mimo, "boolean");

console.log("external CLI backend assertions passed");

// ── C3：墙钟总预算对 external CLI 生效（真实 spawn，对照实验）──────────
// 决定性实验：假后端**每 60ms 输出一行**。
//   · `timeoutMs`（stall）**永不触发**（有输出即重置）⇒ 只设 timeoutMs 的等待**无界**。
//   · 加 `maxWallMs` 后必须被终止 ⇒ failed + error==="wall-budget-exceeded"。
// 结论不可反驳：唯一变量就是 maxWallMs。
{
	const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { spawnStreaming } = await import("./external-cli.ts");

	const dir = mkdtempSync(join(tmpdir(), "cli-wallbudget-"));
	const fake = join(dir, "chatty.cjs");
	const Q = String.fromCharCode(34);
	// 子进程脚本需要真换行**转义**（写成裸换行会让 .cjs 语法错误 —— 已踩过）。
	writeFileSync(fake, [
		"setInterval(() => { process.stdout.write(" + Q + "tick" + Q + " + String.fromCharCode(10)); }, 60);",
		"setTimeout(() => process.exit(0), 600000);",
	].join(String.fromCharCode(10)));

	const run = (maxWallMs?: number, signal?: AbortSignal) =>
		spawnStreaming({
			backend: "atomcode",
			command: process.execPath,
			args: [fake],
			cwd: dir,
			timeoutMs: 2_000, // stall 2s
			maxWallMs,
			signal,
			captureStdout: true,
		});

	try {
		// ① 实验组：maxWallMs=800 ⇒ 必须在 stall(2000ms) 之前、以 wall 原因终止
		const t0 = Date.now();
		const withWall = await run(800);
		const dt = Date.now() - t0;
		assert.equal(withWall.wallBudgetExceeded, true, "到点 ⇒ wallBudgetExceeded 置位");
		assert.equal(withWall.timedOut, false, "**不得**误报为 stall/timeout（两者语义不同）");
		assert.ok(dt < 2_000, `应在 stall(2000ms) 前终止（实测 ${dt}ms）⇒ 证明是 wall 而非 stall`);

		// ② 对照组：不设 maxWallMs ⇒ race 3s 断言「仍未终止」（stall 被持续输出无限重置）
		//    —— 这同时是对「未启用 ⇒ 等待无界」这一已知缺口的**可执行证据**。
		const ac = new AbortController();
		const p = run(undefined, ac.signal);
		const raced: { settled: boolean } = await Promise.race([
			p.then(() => ({ settled: true })),
			new Promise<{ settled: boolean }>((res) => setTimeout(() => res({ settled: false }), 3_000)),
		]);
		assert.equal(raced.settled, false, "无 wall ⇒ 3s 内不终止（stall 被持续输出不断重置 ⇒ 等待无界）");
		ac.abort(); // 收尾：用 abort 结束这个本来会跑到 600s 的子进程
		const noWall = await p;
		assert.equal(noWall.wallBudgetExceeded, false, "未设 maxWallMs ⇒ 不置 wall 标志（缺省不启用）");
		assert.equal(noWall.aborted, true, "最终靠 abort 结束（而非 stall/wall）");

		console.log(`ok - C3 对照实验：有 wall 时 ${dt}ms 终止(wall=true,timeout=false)；无 wall 时 3s 仍在跑(stall 被输出重置) ⇒ 仅 maxWallMs 能封顶`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
