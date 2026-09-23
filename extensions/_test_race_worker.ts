/**
 * _test_race_worker.ts — 真双进程竞争测试 worker（测试专用，非扩展非生产代码）。
 *
 * 供 _test_mailbox_command_consume.ts（M2 双消费者抢同一 fileId）与
 * _test_scope_stale_takeover.ts（缺口④ takeover 真竞争）spawn：
 *   node --experimental-strip-types _test_race_worker.ts <jobJsonFile>
 *
 * job 形状：
 *   { mode: "consume" | "takeover", id, barrierDir, resultFile, ...mode 专属字段 }
 *   - consume:  { sessionId, mailboxDir, runsDir, configPath, journalPath }
 *   - takeover: { sessionId, cwd }
 *
 * 屏障协议：写 <barrierDir>/ready-<id> → 轮询等 <barrierDir>/go（父进程见全部 ready
 * 后放行）→ 执行 → 写 resultFile（JSON）。PI_RUNTIME_DIR 由父进程 env 注入
 *（先于本文件任何 runtime import 生效）。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

interface JobBase {
	mode: "consume" | "takeover";
	id: string;
	barrierDir: string;
	resultFile: string;
}

delete process.env.PI_SUBAGENT;

const job = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as JobBase;
const done = (v: unknown): void => {
	writeFileSync(job.resultFile, JSON.stringify(v), "utf8");
	process.exit(0);
};

try {
	writeFileSync(`${job.barrierDir}/ready-${job.id}`, "1", "utf8");
	const deadline = Date.now() + 30_000;
	while (!existsSync(`${job.barrierDir}/go`)) {
		if (Date.now() > deadline) done({ error: "barrier-timeout" });
		await new Promise((r) => setTimeout(r, 5));
	}

	if (job.mode === "consume") {
		const j = job as JobBase & { sessionId: string; mailboxDir: string; runsDir: string; configPath: string; journalPath: string };
		const { consumeMailboxOnce } = await import("./mailbox-consumer.ts");
		const receipts: string[] = [];
		const r = consumeMailboxOnce({
			sessionId: j.sessionId,
			mailboxDir: j.mailboxDir,
			runsDir: j.runsDir,
			sendUserMessage: (b) => {
				receipts.push(b);
			},
			executeCommandOptions: { configPath: j.configPath, journalPath: j.journalPath },
		});
		// L3：命令回执 send 走 .then 微任务 → flush 后 receipts 才落定
		await new Promise((r) => setImmediate(r));
		done({ consumed: r.consumed, receipts });
	} else {
		const j = job as JobBase & { sessionId: string; cwd: string };
		const { takeoverStaleScopeOwner } = await import("./runtime/scope.ts");
		done(takeoverStaleScopeOwner(j.sessionId, j.cwd));
	}
} catch (e) {
	done({ error: e instanceof Error ? e.message : String(e) });
}
