/**
 * tab-launch-core — 纯 tab 启动原语（从 launch.ts 抽出，trace-fusion C3）
 *
 * 设计稿 §18/§53 的依赖方向：
 *
 *   launch-tabs → workflow prompt builder（launch.ts）→ tab-launch-core
 *   trace-fusion-loop → trace worker prompt builder → tab-launch-core
 *
 * 即：workflow 与 trace 两类上层都只消费本模块的 spawn 原语，互不感知
 * 对方的 prompt 约束。本模块只负责「把一个 prompt 安全送进一个新
 * Windows Terminal pi 标签页」：wt 命令行风险字符防护、prompt 物化为
 * @file、argv 构造、spawn + 回收身份传递。
 *
 * 行为兼容：launch.ts 通过 re-export 保持既有导入（含 _test_launch）不变；
 * sessionProfile/traceRunId/traceLane 仅在显式传入时发射对应 CLI 旗标
 * （workflow 路径永不传入 → argv 与历史版本一致；旗标注册在 trace-worker
 * profile 提交落地）。
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { traceSpawn } from "./spawn-trace.ts";

export interface PiLaunchArgsOptions {
	cwd: string;
	piCli: string;
	execPath: string;
	model?: string;
	/**
	 * Skill roots/files guaranteed via --skill (canonical-path deduped against
	 * package-registered skills, so passing the same skills/ root is a no-op
	 * guarantee rather than a duplicate).
	 */
	skills?: string[];
	/** 标签页回收身份（--tab-run-id <runId>，可靠传递，不依赖 env 继承）。 */
	tabRunId?: string;
	/** 会话身份（trace-fusion 派发 trace worker 时注入；仅显式传入才发射旗标）。 */
	sessionProfile?: string;
	/** trace run 身份（trace-fusion coordinator 记录用）。 */
	traceRunId?: string;
	/** trace lane：A | B | C。 */
	traceLane?: string;
	/** 工具排除名单（trace worker §17）；仅非空时发射 --exclude-tools。 */
	excludeTools?: string[];
}

/** Build argv as an array so prompts are never split or reinterpreted by a shell. */
export function buildWindowsTerminalArgs(
	terminalTitle: string,
	prompt: string,
	options: PiLaunchArgsOptions,
): string[] {
	const piArgs = [options.piCli];
	if (options.model) piArgs.push("--model", options.model);
	for (const skill of options.skills ?? []) piArgs.push("--skill", skill);
	if (options.excludeTools && options.excludeTools.length > 0) {
		piArgs.push("--exclude-tools", options.excludeTools.join(","));
	}
	if (options.sessionProfile) piArgs.push("--session-profile", options.sessionProfile);
	if (options.traceRunId) piArgs.push("--trace-run-id", options.traceRunId);
	if (options.traceLane) piArgs.push("--trace-lane", options.traceLane);
	if (options.tabRunId) piArgs.push("--tab-run-id", options.tabRunId);
	piArgs.push(prompt);
	return [
		"-w", "0",
		"new-tab",
		"--title", terminalTitle,
		"--suppressApplicationTitle",
		"-d", options.cwd,
		options.execPath,
		...piArgs,
	];
}

// ── wt 命令行 prompt 物化（2026-08-13：修复多开无用 tab）───────────────

/** 派发 prompt 的临时目录（~/.pi/agent/launch-prompts）。 */
export function wtPromptDir(): string {
	return join(homedir(), ".pi", "agent", "launch-prompts");
}

/**
 * wt.exe 会用自己的 tokenizer 重解析命令行：含换行的参数会被拆成多条命令，
 * 剩余行变成标题/内容都是 prompt 残留的无用 tab（实证：派发 workflow tab 几乎必现）。
 * 引号/分号/百分号同理有风险（wt 会做引号与 %env% 展开）。
 */
const WT_RISKY_CHARS = /[\r\n;"%]/;

/**
 * 生成传给 wt 命令行的 prompt 参数：凡含风险字符的 prompt 一律物化为临时 @file
 * （pi 原生支持 `pi @file.md` 把文件内容作为首轮消息），命令行上只留一个不含换行的
 * `@路径`；安全单行 prompt 保持内联（零行为变化）。
 */
export function wtPromptArg(prompt: string, key?: string): string {
	if (!WT_RISKY_CHARS.test(prompt)) return prompt;
	const dir = wtPromptDir();
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `pi-launch-${key ?? `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`}.md`);
	writeFileSync(file, prompt, "utf8");
	// 尽力清理：5 分钟后删除（pi 启动早期即读完文件，删除不阻塞）；顺带清理 24h 前陈旧文件
	setTimeout(() => { try { rmSync(file, { force: true }); } catch { /* 清理尽力而为 */ } }, 5 * 60_000).unref?.();
	sweepStaleWtPrompts();
	return `@${file}`;
}

/** 清理超 24h 的陈旧派发 prompt 文件（防 launch-prompts 目录膨胀）。 */
export function sweepStaleWtPrompts(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
	const dir = wtPromptDir();
	let swept = 0;
	try {
		for (const f of readdirSync(dir)) {
			if (!f.startsWith("pi-launch-") || !f.endsWith(".md")) continue;
			try {
				if (Date.now() - statSync(join(dir, f)).mtimeMs > maxAgeMs) {
					rmSync(join(dir, f), { force: true });
					swept++;
				}
			} catch { /* 单个失败无碍 */ }
		}
	} catch { /* 目录不存在等 */ }
	return swept;
}

/** 删除指定 `@file` 参数对应的临时文件（测试/手动清理用）。 */
export function cleanupWtPromptArg(arg: string): void {
	if (!arg.startsWith("@")) return;
	try { rmSync(arg.slice(1), { force: true }); } catch { /* 尽力而为 */ }
}

/**
 * Strip WT-risky characters from a tab title before it hits the wt command line.
 *
 * wt.exe re-parses the command line with its own tokenizer (quote handling +
 * %env% expansion). `wtPromptArg` protects the prompt argument, but `--title`
 * carries a label derived from the prompt's first line (e.g. "修复 50% 回归")
 * or a user-provided title verbatim — same risk class, no protection.
 */
export function sanitizeWtTitle(title: string): string {
	return title.replace(/[\r\n;"%]/g, " ").replace(/\s{2,}/g, " ").trim() || "task";
}

// ── spawn 原语（自 index.ts dispatchPiTab 抽出）────────────────────────

export interface TabLaunchOptions {
	/** where wt.exe 的产物。 */
	wtPath: string;
	/** pi CLI 入口。 */
	piCli: string;
	cwd: string;
	title: string;
	prompt: string;
	model?: string;
	skills?: string[];
	/** 标签页回收身份（launch-tabs / trace-fusion 生成）。 */
	tabRunId?: string;
	/** 标签页账本目录（PI_TAB_RUNS_DIR 注入，回收闭环依赖）。 */
	runsDir?: string;
	/** 会话身份（trace worker 注入；workflow 路径不传）。 */
	sessionProfile?: string;
	traceRunId?: string;
	traceLane?: string;
	/** 工具排除名单（trace worker §17：隔离 launch/timer/wiki 写工具）；仅显式传入才发射。 */
	excludeTools?: string[];
	/** 异步 spawn 失败（child error 事件）回调，用于回写 launch_failed 账本。 */
	onSpawnError?: (err: Error) => void;
}

export interface TabSpawnResult {
	title: string;
	prompt: string;
	model?: string;
	error?: string;
}

/**
 * 派发一个可见 pi 标签页（wt new-tab → pi）。
 *
 * 身份三通道：--tab-run-id CLI flag（authoritative）+ PI_TAB_RUN_ID /
 * PI_TAB_RUNS_DIR env（wt.exe 继承链兜底）。trace 身份
 * （--session-profile/--trace-run-id/--trace-lane）仅在显式传入时发射。
 */
export function spawnPiTab(options: TabLaunchOptions): TabSpawnResult {
	const { wtPath, piCli, cwd, title, prompt, model, skills, tabRunId, runsDir, onSpawnError } = options;
	// Pre-flight（空 WT 窗口根因修复）：wt -w 0 匹配不到就开新窗，但 new-tab 参数非法时
	// 执行失败只剩空框。本层 spawn(wt) 只要 wt.exe 起来就算成功，new-tab 的死活无从得知，
	// 故非法参数必须在 spawn 前拦截，直接回 error 走上层 markFailed（launch_failed 账本），
	// 不弹空窗、不留永远 dispatched 的幽灵记录。
	if (!existsSync(wtPath)) return { title, prompt, model, error: `preflight: wt not found: ${wtPath}` };
	if (!existsSync(piCli)) return { title, prompt, model, error: `preflight: pi CLI not found: ${piCli}` };
	if (!existsSync(cwd)) return { title, prompt, model, error: `preflight: cwd not found: ${cwd}` };
	if (!existsSync(options.execPath)) {
		return { title, prompt, model, error: `preflight: node exec not found: ${options.execPath}` };
	}
	// 取证：wt.exe 派生是「空壳 WT 窗口」的第一嫌疑人（见 spawn-trace.ts 头注；PI_SPAWN_TRACE=0 关）
	traceSpawn("wt", `title=${title} cwd=${cwd} runId=${tabRunId ?? "-"} wt=${wtPath}`);
	try {
		const child = spawn(wtPath, buildWindowsTerminalArgs(title, wtPromptArg(prompt, tabRunId), {
			cwd,
			piCli,
			execPath: process.execPath,
			model,
			skills,
			tabRunId,
			sessionProfile: options.sessionProfile,
			traceRunId: options.traceRunId,
			traceLane: options.traceLane,
			excludeTools: options.excludeTools,
		}), {
			shell: false,
			// 把回收身份传入新标签页：wt.exe 继承环境 → shell → pi 进程。
			// review 修正（Luna critical）：session profile 同步注入 env——factory 阶段
			// CLI flag 尚未就绪，只有 env 能保证 profile 在扩展初始化时即生效。
			env: tabRunId
				? {
					...process.env,
					PI_TAB_RUN_ID: tabRunId,
					PI_TAB_RUNS_DIR: runsDir,
					...(options.sessionProfile ? { PI_SESSION_PROFILE: options.sessionProfile } : {}),
					...(options.traceRunId ? { PI_TRACE_RUN_ID: options.traceRunId } : {}),
					...(options.traceLane ? { PI_TRACE_LANE: options.traceLane } : {}),
				}
				: undefined,
		});
		child.on("error", (err: Error) => {
			// 同步 try/catch 只覆盖 spawn 本身的异常；异步 error（如 wt.exe 立即退出）也回写账本
			console.error(`[subagent-win launch] ${title}: ${err.message}`);
			onSpawnError?.(err);
		});
		child.unref();
		return { title, prompt, model };
	} catch (err) {
		return { title, prompt, model, error: err instanceof Error ? err.message : String(err) };
	}
}
