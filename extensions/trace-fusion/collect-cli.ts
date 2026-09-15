/**
 * trace-fusion/collect-cli.ts — 后台收集 worker 入口
 *
 * 由 supervisor.ts detached 派生：node --experimental-strip-types collect-cli.ts <runId>
 * 执行 权威收集 → deterministic cross-test → meta 终态化，全程零模型调用。
 * 进度写 runDir/collect-worker.log；异常写 failed 并保留已生成产物。
 *
 * 设计稿 §24.1：磁盘是唯一真相源——本 worker 只与磁盘交互，不依赖主会话存活。
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { readTraceRunMeta } from "./launch-workers.ts";
import { collectRunArtifacts } from "./artifacts.ts";
import { runCrossTest } from "./cross-test.ts";
import { readTraceFusionConfig } from "./config.ts";
import { defaultRunsDir } from "./types.ts";

function main(): void {
	const runId = process.argv[2] ?? "";
	const here = dirname(fileURLToPath(import.meta.url));
	const logPath = join(defaultRunsDir(), runId, "collect-worker.log");
	const log = (msg: string): void => {
		try {
			appendFileSync(logPath, `${new Date().toISOString()} ${msg}\n`, "utf8");
		} catch { /* 日志尽力而为 */ }
	};

	try {
		const meta = readTraceRunMeta(join(defaultRunsDir(), runId));
		if (!meta) {
			log(`ERROR: meta 不可读：${runId}`);
			return;
		}
		log(`start: ${meta.runId} (base ${meta.baseCommit.slice(0, 12)})`);
		const config = readTraceFusionConfig(join(here, "..", "..", "config.json"));
		const collect = collectRunArtifacts(meta);
		log(`collected: commands=${collect.commandPool.length}`);
		const matrix = runCrossTest(meta, collect, {
			provisioning: config.provisioning,
			mainRoot: meta.repoRoot,
		});
		const pass = matrix.cells.filter((c) => c.result === "pass").length;
		const fail = matrix.cells.filter((c) => c.result === "fail").length;
		log(`cross-test done: ${pass} pass / ${fail} fail / ${matrix.cells.length - pass - fail} other -> ${matrix.reportPath}`);
		// deterministic 层终态：报告就绪，等待人工裁决（fusion/consult 为 v0.4）
		writeFileSync(
			join(meta.runDir, "meta.json"),
			JSON.stringify({ ...meta, status: "completed" }, null, 2) + "\n",
			"utf8",
		);
		log("meta -> completed");
	} catch (err) {
		try {
			appendFileSync(logPath, `${new Date().toISOString()} FATAL: ${(err as Error).stack ?? (err as Error).message}\n`, "utf8");
		} catch { /* 尽力而为 */ }
	}
}

// 仅作为主模块运行时执行（被 import 时不执行）
const asMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1].replace(/\\/g, "/");
if (asMain) main();
