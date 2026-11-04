/**
 * trace-fusion/collect-cli.ts — 后台收集 worker 入口
 *
 * 由 supervisor.ts detached 派生：node --experimental-strip-types collect-cli.ts <runId>
 * 执行 权威收集 → deterministic cross-test → meta 终态化，全程零模型调用。
 * 进度写 runDir/collect-worker.log；异常写 failed 并保留已生成产物。
 *
 * 设计稿 §24.1：磁盘是唯一真相源——本 worker 只与磁盘交互，不依赖主会话存活。
 */

import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { readTraceRunMeta } from "./launch-workers.ts";
import { collectRunArtifacts } from "./artifacts.ts";
import { runCrossTest, finishDiagnoseRun } from "./cross-test.ts";
import { readTraceFusionConfig } from "./config.ts";
import { runFusionStep } from "./fusion-dispatch.ts";
import { registerRunProcess, clearRunProcess } from "../subagent-kill.ts";
import { notifyAsyncCompletion } from "../async-panel.ts";
import { defaultRunsDir } from "./types.ts";

/**
 * 读 `agents/fusion.md` 的 body（frontmatter 之后的部分）作为融合者系统提示。
 *
 * 为什么在这里读、而不是让 fusion-dispatch 自己读：`discoverAgents()` 在 index.ts，
 * trace-fusion 反向 import 它会成环。collect-cli 是进程入口（非库），自己读一次最干净。
 * never-throw：读不到返回 undefined ⇒ 退回旧行为（不挂 systemPrompt），不阻断融合。
 */
function readFusionAgentBody(): string | undefined {
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		const mdPath = join(here, "..", "..", "agents", "fusion.md");
		if (!existsSync(mdPath)) return undefined;
		const md = readFileSync(mdPath, "utf8");
		if (!md.startsWith("---")) return md.trim() || undefined;
		const lines = md.split(/\r?\n/);
		const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
		if (end === -1) return md.trim() || undefined;
		const body = lines.slice(end + 1).join("\n").trim();
		return body.length > 0 ? body : undefined;
	} catch {
		return undefined;
	}
}

async function main(): Promise<void> {
	const runId = process.argv[2] ?? "";
	// 第三参 = supervisor 传入的 pi CLI 路径（fusion 消费链用）；其次退 PI_CLI_PATH
	const piCli = process.argv[3] ?? process.env.PI_CLI_PATH;
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

		// ── fusionModel 消费链（2026-11-02）─────────────────────────────
		// 模型只来自用户设置（config.json 的 traceFusion.fusionModel）；未设 ⇒ 零动作零模型调用，
		// 但跳过理由必须写进 meta.fusion 与 worker 日志（AGENTS.md R-2：降级不得静默）。
		await runFusionStep({
			meta,
			reportPath: matrix.reportPath,
			fusionModel: config.fusionModel,
			piCli,
			log,
			// 2026-11-05 第 3 项：headless 通道此前**不挂** agents/fusion.md 的 body
			// ⇒ 与 makeSubagentFusionRunner（runWithFallback 自动取 agent.body）系统提示不一致。
			// 在这里读并注入（不让 trace-fusion 反向依赖 agents/ 加载逻辑，保持 DAG）。
			systemPrompt: readFusionAgentBody(),
			// S1（2026-11-04）：让 headless 融合者成为一等 async run —— 有 pid（可 kill）、
			// 有正规完成通知（不再只靠对账补投这条降级路径）。
			registerRunProcess,
			clearRunProcess,
			notifyCompletion: notifyAsyncCompletion,
		});
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
if (asMain) void main();
