/**
 * trace-fusion/collect-cli.ts — 后台收集 worker 入口
 *
 * 由 supervisor.ts detached 派生：node --experimental-strip-types collect-cli.ts <runId>
 * 执行 权威收集 → deterministic cross-test → meta 终态化，全程零模型调用。
 * 进度写 runDir/collect-worker.log；异常写 failed 并保留已生成产物。
 *
 * 设计稿 §24.1：磁盘是唯一真相源——本 worker 只与磁盘交互，不依赖主会话存活。
 */

import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { readTraceRunMeta } from "./launch-workers.ts";
import { collectRunArtifacts } from "./artifacts.ts";
import { runCrossTest, finishDiagnoseRun } from "./cross-test.ts";
import { readTraceFusionConfig } from "./config.ts";
import { defaultRunsDir } from "./types.ts";

function main(): void {
	const runId = process.argv[2] ?? "";
	const here = dirname(fileURLToPath(import.meta.url));
	const runDir = join(defaultRunsDir(), runId);
	const logPath = join(runDir, "collect-worker.log");
	// supervisor 在 spawn 前已用 'wx' 认领；worker 退出时释放（成功后 cross-test.json
	// 先于 claim 检查所以无所谓，失败后释放允许 catch-up 重试）
	const releaseClaim = (): void => {
		try {
			rmSync(join(runDir, "collect-worker.claim"));
		} catch { /* 尽力而为 */ }
	};
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
		// diagnose 模式（2026-09-17）：不在用户主仓库执行命令，落盘跳过型报告 + 违规写入检查
		const matrix = meta.mode === "diagnose"
			? finishDiagnoseRun(meta, collect)
			: runCrossTest(meta, collect, {
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
		releaseClaim();
	} catch (err) {
		releaseClaim();
		try {
			appendFileSync(logPath, `${new Date().toISOString()} FATAL: ${(err as Error).stack ?? (err as Error).message}\n`, "utf8");
		} catch { /* 尽力而为 */ }
	}
}

// 仅作为主模块运行时执行（被 import 时不执行）。两侧都归一化到正斜杠：
// Windows 上 fileURLToPath 返回反斜杠，只归一化 argv[1] 会永不相等（真实首跑踩坑）
const norm = (p: string): string => p.replace(/\\/g, "/");
const asMain = Boolean(process.argv[1]) && norm(fileURLToPath(import.meta.url)) === norm(process.argv[1]);
if (asMain) main();
