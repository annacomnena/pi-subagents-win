/**
 * launch-workflow.ts — 单个 workflow tab 的账本 + spawn 共享原语（0918 计划 §3.3/§4）。
 *
 * 从 index.ts 的 launch-tabs execute 逐行提取（行为零变化）；master-dispatch 的
 * dispatchTab 闭包复用本函数，使两路账本 parity 靠「同一段代码」保证（§4 diff 为零）：
 *
 *   newTabRunId → writeTabDispatch → emit（source 默认 agent://master_default）→ recordLink
 *   → 逐 timer writeTimerAtomic（source 为唯一允许差异：launch-tabs / master-dispatch）
 *   → spawn（同步 result.error 与异步 onSpawnError 双路 launch_failed 回账）。
 *
 * 独立叶子模块（不 import pi / TUI / wiki-semantic）：index.ts 与测试都可安全 import。
 * env.linksPath 缺省 defaultLinksPath()——launch-tabs 不传，行为与历史逐字节一致。
 * spawn 注入式（缺省 dispatchPiTab 等价物），测试以 fake spawn 走账本不真 spawn。
 */

import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorkflowTabPrompt, launchTaskTitle, type LaunchMode } from "./launch.ts";
import { newTabRunId, writeTabDispatch, type TabDispatchRecord } from "./tab-runs.ts";
import { emitRuntimeEventOnce } from "./runtime/journal.ts";
import { tabDispatchToRuntimeEvent } from "./runtime/adapters/tab-run.ts";
import { recordLink, defaultLinksPath } from "./links.ts";
import { dueAtFromDelay, newTimerId, validateTimerRecord, writeTimerAtomic } from "./timers.ts";
import { spawnPiTab } from "./tab-launch-core.ts";
import type { MasterAttachment } from "./runtime/registry.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = resolve(__dirname, "..");

// 工作流技能：根目录与扩展 resources_discover 注册的是同一路径（--skill 传根目录可被按路径去重）；
// 约束块里给的是精确 SKILL.md 路径，让新会话直接 read。
export const WORKFLOW_SKILL_ROOT = join(PKG_DIR, "skills");
export const WORKFLOW_SKILL_FILE = join(WORKFLOW_SKILL_ROOT, "workflow-orchestrator", "SKILL.md");

/** 派发入参（见 0918 计划 §3.1；taskId/prompt 缺值由函数内校验并回 error）。 */
export interface WorkflowTabInput {
	taskId: string;
	title?: string;
	prompt: string;
	model?: string;
	cwd?: string;
	mode: LaunchMode;
	timers?: Array<{ delayMs?: number; message?: string; label?: string; repeatMs?: number }>;
	/** 溯源：本会话身份（recordLink 用；随调用方身份变化，结构字段一致）。 */
	sessionId: string;
	/** timer 记录 source 溯源字段（自由文本）：launch-tabs / master-dispatch。 */
	timerSource: string;
}

/** 环境（index.ts 提供；linksPath 缺省 defaultLinksPath()，测试可注入隔离路径）。 */
export interface WorkflowTabEnv {
	wtPath: string;
	piCli: string;
	runsDir: string;
	timersDir: string;
	linksPath?: string;
}

/** 派发原语类型（与 index.ts dispatchPiTab 同签名；测试可注入 fake spawn）。 */
export type WorkflowSpawnFn = (
	wtPath: string,
	piCli: string,
	cwd: string,
	title: string,
	prompt: string,
	model?: string,
	skills?: string[],
	runId?: string,
	runsDir?: string,
	onSpawnError?: (err: Error) => void,
) => { title: string; prompt: string; model?: string; error?: string; runId?: string };

/** 缺省 spawn：等价 index.ts dispatchPiTab（spawnPiTab 薄封装，返回 {title,prompt,model,error,runId}）。 */
const defaultSpawn: WorkflowSpawnFn = (wtPath, piCli, cwd, title, prompt, model, skills, runId, runsDir, onSpawnError) => {
	const result = spawnPiTab({ wtPath, piCli, cwd, title, prompt, model, skills, tabRunId: runId, runsDir, onSpawnError });
	return { title, prompt, model, error: result.error, runId };
};

/**
 * 派发一个 workflow tab：写回收账本（dispatched）→ emit → 溯源 link → 写 timer 邮箱 → spawn，
 * 失败双路回账（同步 result.error / 异步 onSpawnError）覆写 launch_failed + 再 emit。
 */
export function launchWorkflowTab(
	input: WorkflowTabInput,
	env: WorkflowTabEnv,
	spawn: WorkflowSpawnFn = defaultSpawn,
): { title: string; prompt: string; model?: string; error?: string; runId?: string; taskId?: string; cwd?: string } {
	const taskId = input.taskId.trim();
	const prompt = input.prompt.trim();
	if (!taskId || !prompt) {
		return { title: input.title ?? (taskId || "?"), prompt, model: input.model, error: "taskId and prompt are required" };
	}
	// workflow 绑定：前缀 + 强制约束块 + 原始 handoff；--skill 保证技能在标签会话里可见
	const skillRef = existsSync(WORKFLOW_SKILL_FILE) ? WORKFLOW_SKILL_FILE : undefined;
	const skillArgs = existsSync(WORKFLOW_SKILL_ROOT) ? [WORKFLOW_SKILL_ROOT] : undefined;
	const normalizedPrompt = buildWorkflowTabPrompt({ taskId, title: input.title, prompt, model: input.model }, skillRef, input.mode);
	const cwdRaw = (input.cwd ?? "").trim() || process.cwd();
	const cwd = resolve(cwdRaw);
	const title = launchTaskTitle({ taskId, title: input.title, prompt: normalizedPrompt, model: input.model }, cwd);

	// 1) 派发前写账本：回收闭环的 runId 唯一令牌
	const runId = newTabRunId();
	const dispatch: TabDispatchRecord = {
		id: runId,
		version: 1,
		taskId,
		mode: input.mode,
		title: input.title ?? title,
		cwd,
		requestedModel: input.model,
		dispatchedAt: new Date().toISOString(),
		dispatchStatus: "dispatched",
	};
	writeTabDispatch(env.runsDir, dispatch);
	// Phase 1 shadow emit（设计稿 §11）：journal 写失败不影响 launch；source 默认 agent://master_default
	emitRuntimeEventOnce(tabDispatchToRuntimeEvent(dispatch));
	// 溯源：记录「本会话唤起了这个 tab」
	recordLink(
		{
			sessionId: input.sessionId,
			kind: "tab",
			targetId: runId,
			detail: `task=${taskId} mode=${input.mode} ${title}`,
		},
		{ linksPath: env.linksPath },
	);

	// 2) 写入该标签页邮箱的计时器（到期自动发送推进消息）
	for (const t of input.timers ?? []) {
		if (typeof t.delayMs !== "number" || !Number.isFinite(t.delayMs) || t.delayMs <= 0) continue;
		if (typeof t.message !== "string" || !t.message.trim()) continue;
		const timerRaw: Record<string, unknown> = {
			id: newTimerId(),
			version: 1,
			dueAt: dueAtFromDelay(t.delayMs),
			message: t.message.trim(),
			target: { tabRunId: runId, taskId },
			source: input.timerSource,
			label: typeof t.label === "string" && t.label.trim() ? t.label.trim() : undefined,
			repeatMs: t.repeatMs,
			status: "pending",
			createdAt: new Date().toISOString(),
		};
		const check = validateTimerRecord(timerRaw);
		if (check.ok && check.value) writeTimerAtomic(env.timersDir, check.value, { tabRunId: runId });
	}

	// 3) spawn（env 携带 PI_TAB_RUN_ID / PI_TAB_RUNS_DIR）
	const result = spawn(env.wtPath, env.piCli, cwd, title, normalizedPrompt, input.model, skillArgs, runId, env.runsDir, (err) => {
		// P1-2：异步 spawn 失败也回写 launch_failed（不静默卡 dispatched）
		console.error(`[subagent-win launch] async spawn failed ${runId}: ${err.message}`);
		const failed = { ...dispatch, dispatchStatus: "launch_failed" as const, error: err.message };
		writeTabDispatch(env.runsDir, failed);
		emitRuntimeEventOnce(tabDispatchToRuntimeEvent(failed));
	});
	if (result.error) {
		// 派发失败保留 launch_failed 记录（不静默消失）
		const failed = { ...dispatch, dispatchStatus: "launch_failed" as const, error: result.error };
		writeTabDispatch(env.runsDir, failed);
		emitRuntimeEventOnce(tabDispatchToRuntimeEvent(failed));
	}
	return { ...result, runId, taskId, cwd };
}

/**
 * master-dispatch 入口（0918 计划 §3.3/§5）：wt/CLI 前置检查（**在生成 runId 之前**）→
 * 复用 launchWorkflowTab 账本/spawn（timer source = "master-dispatch"）。wt 缺席/CLI 缺失
 * 直接返回 error，不落任何账本（launch_failed 只用于「已写 dispatched 后 spawn 失败」）。
 * 独立于 index.ts 可单测（B6 wt 缺席零账本）。index.ts 的 dispatchTab 闭包只做
 * findWindowsTerminal/findPiCli 解析 + 注入 readAttachment（owner 路径最终 fencing 用），其余委托本函数。
 */
export function masterDispatchLaunch(
	args: {
		taskId: string;
		title?: string;
		cwd?: string;
		mode: "workflow" | "research" | "execute" | "adaptive";
		prompt: string;
		model?: string;
		timers?: Array<{ delayMs?: number; message?: string; label?: string; repeatMs?: number }>;
		sessionId: string;
		/** gate 第二读的 owner 快照（owner 路径）；main 路径为 null（不依赖 attachment）。 */
		owner: MasterAttachment | null;
	},
	opts: { wtPath: string | null; piCli?: string; piErr?: string; env: WorkflowTabEnv; spawn?: WorkflowSpawnFn; readAttachment?: () => MasterAttachment | null },
): { runId?: string; title: string; error?: string; stale?: true } {
	const title = args.title ?? args.taskId;
	if (opts.wtPath === null) return { title, error: "未找到 Windows Terminal (wt.exe)，无法启动标签页" };
	if (!opts.piCli || opts.piErr) return { title, error: opts.piErr ?? "未找到 pi CLI" };
	// 最终 fencing（0918 审查 §1）：gate 返回后、生成 runId/写任何账本/spawn 之前紧贴重读 attachment，
	// 与 gate 第二读比对 {sessionId, generation}；已变（detach/attach/generation bump）→ stale，零账本零 spawn。
	// main 路径（owner=null）不读 attachment（主会话恒可派，不依赖归属）。
	if (args.owner) {
		const fresh = opts.readAttachment?.() ?? null;
		if (!fresh || fresh.sessionId !== args.owner.sessionId || fresh.generation !== args.owner.generation) {
			return { title, error: "Master 归属已变化（stale generation），拒绝派发", stale: true };
		}
	}
	return launchWorkflowTab(
		{
			taskId: args.taskId,
			title: args.title,
			prompt: args.prompt,
			model: args.model,
			cwd: args.cwd,
			mode: args.mode,
			timers: args.timers,
			sessionId: args.sessionId,
			timerSource: "master-dispatch",
		},
		{ ...opts.env, wtPath: opts.wtPath, piCli: opts.piCli },
		opts.spawn,
	);
}
