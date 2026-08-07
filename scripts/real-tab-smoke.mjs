/**
 * real-tab-smoke.mjs — 真实进程验证：PI_TAB_RUN_ID 传递 → state 落盘 → tab-finish → result 落盘
 *
 * spawn 一个真实 pi json 模式进程（非子 agent：不设 PI_SUBAGENT），
 * 注入 PI_TAB_RUN_ID / PI_TAB_RUNS_DIR，验证：
 *   1. session_start 遥测写入 <runId>.state.json（attached）
 *   2. agent 调用 tab-finish → <runId>.result.json（completed）
 *
 * 运行：node ./scripts/real-tab-smoke.mjs
 * 退出码 0 = PASS。需要网络与可用模型（默认 provider）。
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PI_CLI = "C:/Users/Annacomnena/AppData/Local/nvm/v22.19.0/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";
const RUN_ID = "tab_real_process_1";

async function main() {
	const runsDir = mkdtempSync(join(tmpdir(), "real-tab-smoke-"));
	console.log(`runsDir: ${runsDir}`);
	console.log(`runId:   ${RUN_ID}`);

	// 真实流程中 launch-tabs 会先写派发账本再 spawn；smoke 模拟这一步
	const { writeFileSync } = await import("node:fs");
	writeFileSync(join(runsDir, `${RUN_ID}.json`), JSON.stringify({
		id: RUN_ID,
		version: 1,
		taskId: "smoke-real",
		mode: "execute",
		title: "RealTabSmoke",
		cwd: process.cwd(),
		dispatchedAt: new Date().toISOString(),
		dispatchStatus: "dispatched",
	}, null, 2) + "\n", "utf8");

	const prompt = [
		"调用 tab-finish 工具（status='completed'，summary='real-process verification'，artifacts=['scripts/real-tab-smoke.mjs']），",
		"然后只回复一行：REAL_TAB_FINISHED。不要做其他事情。",
	].join("");

	const child = spawn(process.execPath, [PI_CLI, "--mode", "json", "--print", "--no-session", prompt], {
		env: {
			...process.env,
			PI_TAB_RUN_ID: RUN_ID,
			PI_TAB_RUNS_DIR: runsDir,
		},
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
	});

	let out = "";
	let err = "";
	child.stdout.on("data", (c) => { out += String(c); });
	child.stderr.on("data", (c) => { err += String(c); });

	const exitCode = await new Promise((resolve) => {
		const timer = setTimeout(() => {
			console.error("TIMEOUT after 120s");
			child.kill("SIGKILL");
			resolve("timeout");
		}, 120_000);
		child.on("close", (code) => { clearTimeout(timer); resolve(code); });
	});

	console.log(`--- child exit: ${exitCode} ---`);
	if (typeof exitCode === "number" && exitCode !== 0) {
		console.error("stderr:", err.slice(0, 2000));
	}

	// 1) state 文件应存在（session_start → attached）
	const files = readdirSync(runsDir).filter((f) => !f.endsWith(".tmp"));
	console.log(`runs dir files: ${files.join(", ")}`);
	const stateFile = join(runsDir, `${RUN_ID}.state.json`);
	if (!existsSync(stateFile)) {
		console.error("FAIL: state.json 未生成");
		rmSync(runsDir, { recursive: true, force: true });
		process.exit(1);
	}
	const state = JSON.parse(readFileSync(stateFile, "utf8"));
	console.log(`state: phase=${state.phase} terminal=${state.terminal}`);
	// tab-finish 成功后 state 应为终态（completed）。intermediate attached/working 由单测覆盖。
	if (state.phase !== "completed" || state.terminal !== true) {
		console.error(`FAIL: state 应为 completed/terminal，得到 ${state.phase}/${state.terminal}`);
		rmSync(runsDir, { recursive: true, force: true });
		process.exit(1);
	}

	// 2) result 文件应存在（tab-finish → completed）
	const resultFile = join(runsDir, `${RUN_ID}.result.json`);
	if (!existsSync(resultFile)) {
		console.error("FAIL: result.json 未生成（agent 未调用 tab-finish）");
		console.error("out:", out.slice(0, 1000));
		rmSync(runsDir, { recursive: true, force: true });
		process.exit(1);
	}
	const result = JSON.parse(readFileSync(resultFile, "utf8"));
	console.log(`result: status=${result.status} summary=${result.summary}`);
	if (result.status !== "completed" || result.id !== RUN_ID) {
		console.error("FAIL: result 状态/runId 不符");
		rmSync(runsDir, { recursive: true, force: true });
		process.exit(1);
	}

	rmSync(runsDir, { recursive: true, force: true });
	console.log("REAL-TAB SMOKE PASS ✅（真实 pi 进程：PI_TAB_RUN_ID 传递 + state 落盘 + tab-finish result 落盘）");
}

main().catch((e) => {
	console.error("SMOKE FAIL:", e);
	process.exit(1);
});
