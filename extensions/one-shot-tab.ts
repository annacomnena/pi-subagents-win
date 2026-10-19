/**
 * one-shot-tab.ts — 一次性 Sub-Master tab 的派发序列（workstream wake / local master v1 共用）
 *
 * 从 `index.ts` 抽出的原因（2026-10-19 断点 #4）：这条路径原先**不登记监管账本**，
 * 而 `supervise-push` 的第 1 条七门 `no-mandate`（`supervision-runtime.ts`）会先拒 ——
 * 即使本仓 owner 真的放行了也推不动 `l2-*` / `wake-*`。抽取后这段接线有**可执行测试**
 * （`_test_supervise_gate.ts` 的 W5/W6 组：真写 dispatch + 真写账本 + 假 spawn），
 * 而不是只能靠「读源码找字符串」。
 *
 * 语义与既有两处自动登记（`index.ts` 的 `dispatchTab` = master-dispatch 路、
 * `launch-tabs` 路）一致：**只在 spawn 成功之后**登记（失败先回写 `launch_failed`，不建账本）——
 * 账本语义是「我派出去的 tab」，没起来的不算派出去。
 *
 * 零 Pi API 依赖（`spawn` / 审计 / 时钟全注入），纯库层，可被测试以假 spawn 驱动。
 */

import { buildWorkflowTabPrompt } from "./launch.ts";
import { recordLink } from "./links.ts";
import { emitRuntimeEventOnce } from "./runtime/journal.ts";
import { tabDispatchToRuntimeEvent } from "./runtime/adapters/tab-run.ts";
import { autoRegisterDispatchedTabs } from "./runtime/supervision.ts";
import { spawnPiTab, type TabLaunchOptions, type TabSpawnResult } from "./tab-launch-core.ts";
import { defaultTabRunsDir, newTabRunId, writeTabDispatch, type TabDispatchRecord } from "./tab-runs.ts";

export interface OneShotTabArgs {
	sessionId: string;
	taskId: string;
	title: string;
	prompt: string;
	cwd: string;
	linkDetail: string;
}

export interface OneShotTabDeps {
	/** `findWindowsTerminal()` 结果；null ⇒ 在生成 runId 之前返回 error（零账本）。 */
	wtPath: string | null;
	/** `findPiCli()` 结果（调用方已解析；抛错由调用方处理）。 */
	piCli: string;
	/** 标签页账本目录（缺省 `defaultTabRunsDir()`）。 */
	runsDir?: string;
	/** 监管账本 stateDir（生产缺省 `<runtimeDir>/state`；测试注入 temp）。 */
	stateDir?: string;
	/** spawn 原语（生产 `spawnPiTab`；测试注入假 spawn 以断言账本副作用）。 */
	spawn?: (opts: TabLaunchOptions) => TabSpawnResult;
	/** workflow 技能文件的引用（存在才传；由调用方探活）。 */
	skillFile?: string;
	/** 审计行接收器（生产 `appendAuditLine`）；不传则静默丢弃。 */
	audit?: (line: string) => void;
	/** links.jsonl 路径（生产缺省 `defaultLinksPath()`；测试注入 temp）。 */
	linksPath?: string;
	/** fake clock（测试注入）。 */
	now?: () => Date;
	/** fake runId 生成器（测试注入；生产 `newTabRunId`）。 */
	newRunId?: (now?: Date) => string;
}

/**
 * 派发一个一次性 Sub-Master tab：dispatch → journal → link → spawn →（成功则）监管登记。
 * never-throw 边界同原实现：wt 缺席 / spawn 返回 error ⇒ `{runId, error}`（已回写 launch_failed）。
 */
export function spawnOneShotTab(
	args: OneShotTabArgs,
	deps: OneShotTabDeps,
): { runId: string; error?: string } {
	if (!deps.wtPath) return { runId: "", error: "no wt.exe" };
	const piCli = deps.piCli;
	const runId = (deps.newRunId ?? newTabRunId)(deps.now?.() ?? new Date());
	const prompt = buildWorkflowTabPrompt(
		{ taskId: args.taskId, title: args.title, prompt: args.prompt, model: undefined },
		deps.skillFile,
		"execute",
	);
	const runsDir = deps.runsDir ?? process.env.PI_TAB_RUNS_DIR ?? defaultTabRunsDir();
	const dispatch: TabDispatchRecord = {
		id: runId,
		version: 1,
		taskId: args.taskId,
		mode: "execute",
		title: args.title,
		cwd: args.cwd,
		dispatchedAt: (deps.now?.() ?? new Date()).toISOString(),
		dispatchStatus: "dispatched",
	};
	const markFailed = (err: Error): void => {
		const failed = { ...dispatch, dispatchStatus: "launch_failed" as const, error: err.message };
		writeTabDispatch(runsDir, failed);
		emitRuntimeEventOnce(tabDispatchToRuntimeEvent(failed));
	};
	writeTabDispatch(runsDir, dispatch);
	emitRuntimeEventOnce(tabDispatchToRuntimeEvent(dispatch));
	recordLink(
		{ sessionId: args.sessionId, kind: "tab", targetId: runId, detail: args.linkDetail },
		{ ...(deps.linksPath ? { linksPath: deps.linksPath } : {}), ...(deps.now ? { at: (deps.now()).toISOString() } : {}) },
	);
	// 角色区间门适用域：Sub-Master 一次性 tab（master 无角色归属），costTier 角色区间门不适用。
	const result = (deps.spawn ?? spawnPiTab)({
		wtPath: deps.wtPath,
		piCli,
		cwd: args.cwd,
		title: args.title,
		prompt,
		tabRunId: runId,
		runsDir,
		onSpawnError: (err) => markFailed(err),
	});
	if (result.error) {
		markFailed(new Error(result.error));
		return { runId, error: result.error };
	}
	// 监管默认开启（2026-10-18 用户指令）延伸到一次性 wake tab（2026-10-19 断点 #4 补登）：
	// 「只要是我派出去的 tab 默认就进监管账本」—— `l2-*` / `wake-*` 也是派出去的，之前漏网。
	// 不补这一步，本仓 owner 即使过了 ownership 门也会被七门之 `no-mandate` 先拒。
	// never-throw（写失败只落审计行，绝不影响派发结果）。
	autoRegisterDispatchedTabs([{ runId, title: args.title }], {
		setBy: `master:${args.sessionId}`,
		tabRunsDir: runsDir,
		...(deps.stateDir ? { stateDir: deps.stateDir } : {}),
		...(deps.now ? { now: deps.now() } : {}),
		audit: (line) => deps.audit?.(line),
	});
	return { runId };
}
