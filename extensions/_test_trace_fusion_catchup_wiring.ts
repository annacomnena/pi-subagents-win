/**
 * trace-fusion 追赶续发的**接线**测试（2026-11-02）
 *
 * 为什么单独测接线：`catchUpAutoCollect()` 在 session-hooks 里是**无参调用**，
 * 于是 opts.wtExe/piCli 全为 undefined ⇒ `tryResumeQueuedLane` 直接 return null
 * ⇒ 待发 lane 永远饿死。实测现场：run tfl-20261102-162039-c2f5 的 lane C
 * （A/B 都已终态、lane-queue.json 里挂着 ["C"]）在 reload 之后仍然不动。
 *
 * 只直调 `catchUpAutoCollect` 的测试测不到这条接线（AGENTS.md §4 的同一课：
 * 变异必须变异接线，不能只变异函数本体）。本文件走真实 session_start 钩子。
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerSessionHooks } from "./session-hooks.ts";

const root = mkdtempSync(join(tmpdir(), "tf-catchwire-"));

try {
	const runsDir = join(root, "runs");
	const tabRunsDir = join(root, "tab-runs");
	const runDir = join(runsDir, "tfl-wire");
	mkdirSync(tabRunsDir, { recursive: true });
	mkdirSync(runDir, { recursive: true });

	const mkLane = (lane: "A" | "B" | "C", tabRunId: string) => ({
		lane,
		worktree: root,
		tabRunId,
		provision: { junction: [], copied: [], commandOk: true, degraded: false, issues: [] },
	});
	writeFileSync(
		join(runDir, "meta.json"),
		JSON.stringify({
			runId: "tfl-wire",
			shortId: "wire",
			status: "running",
			mode: "diagnose",
			task: "t",
			repoRoot: root,
			createdAt: new Date().toISOString(),
			baseCommit: "0".repeat(40),
			headBefore: "0".repeat(40),
			runDir,
			wtDir: "",
			laneWallClockMin: 45,
			laneDeadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
			lanes: { A: mkLane("A", "tabWA"), B: mkLane("B", ""), C: mkLane("C", "") },
		}),
		"utf8",
	);
	writeFileSync(join(runDir, "lane-queue.json"), JSON.stringify({ lanes: ["B", "C"], concurrency: 1 }), "utf8");
	// A 已终态 ⇒ 名额空出 ⇒ 追赶应续发 B
	writeFileSync(join(tabRunsDir, "tabWA.result.json"), JSON.stringify({ status: "completed", summary: "s" }), "utf8");

	const startCbs: Array<(e: unknown, c: unknown) => void> = [];
	const sent: string[] = [];
	const spawned: string[] = [];
	const pi = {
		on: (event: string, cb: (e: unknown, c: unknown) => void) => {
			if (event === "session_start") startCbs.push(cb);
		},
		sendUserMessage: (text: string) => {
			sent.push(String(text));
		},
	};

	registerSessionHooks(pi as never, {
		cleanups: [],
		isNotifyEnabled: () => false,
		pkgDir: root,
		traceResumePaths: () => ({ wtExe: "wt.exe", piCli: "pi.js", runsDir, tabRunsDir }),
		traceSpawnTab: (opts: { title?: string }) => {
			spawned.push(String(opts?.title ?? "?"));
			return { ok: true, pid: 1 } as never;
		},
	});

	assert.ok(startCbs.length > 0, "session_start 钩子已注册");
	for (const cb of startCbs) cb({}, { sessionManager: { sessionId: "sess-wire" } });

	// ① 接线必须把 wt/pi 传到续发（无注入时这里是 0，lane 饿死）
	assert.equal(spawned.length, 1, `追赶必须真的派一条 lane，实得 ${spawned.length}（wt/pi 注入未生效？）`);

	// ② 续发必须被上报，且文案不得说「三路已终态」（还剩 C 在跑/在排队）
	const note = sent.find((s) => s.includes("trace-fusion"));
	assert.ok(note, "追赶必须发通知");
	assert.ok(/追赶续发/.test(note!), `通知必须标明是续发，实得：${note}`);
	assert.ok(note!.includes("lane B"), `通知必须带续发的 lane，实得：${note}`);
	assert.ok(!/三路已终态/.test(note!), `还剩 C 未跑，不得声称「三路已终态」：${note}`);

	console.log("trace-fusion catch-up wiring tests passed");
} finally {
	try {
		rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
	} catch {
		/* 尽力 */
	}
}
