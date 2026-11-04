/**
 * trace-fusion/fusion-agent.ts — 融合者的「真 subagent」通道（2026-11-04，S2/S3）。
 *
 * 背景（用户原话）：「融合者也不会作为一个 subagent 去呈现，任何地方都找不到它」。
 * 实测根因两条：
 *   ① 账本落点写成 APPDATA 拼的孤岛目录 ⇒ watcher 永不监听（已修，见 fusion-dispatch.ts:400）；
 *   ② 融合者是裸 `spawn(node, argv)`：**无 pid 登记、无 notifyAsyncCompletion、不在 agents/ 里**，
 *      所以即便账本落点正确，它在 `subagent-win list` 里也只有账本行、拿不到 kill/通知。
 *
 * 本模块把「怎么跑融合者」抽成一个 seam（`runFusionAgent`），两种实现：
 *   - `runFusionAgentHeadless`（缺省，自动链用）：保持原行为，裸 spawn + 落账本 + 登记 pid；
 *   - `runFusionAgentViaSubagent`（由 index.ts 注入，手动命令 `/trace-fusion-fuse` 用）：
 *       **同步**走 runWithFallback，融合者在主会话里表现为一次普通 subagent 调用，
 *       用人可读的结果直接回显（不再只是盘上一个 json）。
 *
 * 为什么要 seam 而不是直接 import：`runWithFallback` 在 `index.ts`，
 * `trace-fusion/*` 反向 import 它会形成循环依赖（index → supervisor → collect-cli → fusion-dispatch）。
 * seam 由 index.ts 在注册处单向注入，保持 DAG。
 */

/** 融合者的跑法（与 dispatchFusion 的内部 spawn 段一一对应）。 */
export interface FusionAgentRequest {
	/** 本次融合 run 的账本 id（缺省实现会写 `<runsDir>/<fusionRunId>.json`）。 */
	fusionRunId: string;
	/** 被融合的 trace-fusion run（写进提示词与账本）。 */
	traceRunId: string;
	/** 完整提示词（buildFusionPrompt 的产物）。 */
	prompt: string;
	model: string;
	repoRoot: string;
	/** stdout/stderr 落点（headless 实现必用；subagent 实现当取证路径写入账本）。 */
	logPath: string;
	/** 融合产物路径（融合者要 write 到这里）。 */
	outputPath: string;
	/** 墙钟预算（ms）。 */
	wallBudgetMs: number;
	/** 账本目录（缺省 DEFAULT_RUNS_DIR）。 */
	runsDir: string;
	/** 登记用 marker（命令行稳定子串），供 kill 校验身份。 */
	cmdMarker: string;
	/** spawn seam（测试注入）；仅 headless 实现使用。 */
	spawnFn?: (cmd: string, argv: string[], opts: object) => import("node:child_process").ChildProcess;
}

export interface FusionAgentResult {
	/** 子进程/子 agent 是否正常结束（exit=0 / status=completed）。 */
	ok: boolean;
	exitCode: number | null;
	exitSignal: string | null;
	timedOut: boolean;
	/** 子进程 error 事件的消息（未触发为 null）。 */
	spawnError: string | null;
	/** 实现自报的用量；解析不出 = null（不得写 0）。 */
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number } | null;
	/** 实现的形态标签，写进日志/账本便于区分（"headless-spawn" | "subagent-runWithFallback"）。 */
	via: string;
}

/**
 * 从 headless 实现的 stdout 日志解析用量。
 * （沿用 fusion-dispatch 里 parseFusionUsage 的语义，此处只做 thin 包装以免重复实现。）
 */
export type FusionAgentRunner = (req: FusionAgentRequest) => Promise<FusionAgentResult>;

/**
 * 真 subagent 实现（手动命令 `/trace-fusion-fuse` 用，S2/S3）。
 *
 * 由 `index.ts` 注入（那里才有 `runWithFallback`）。行为差异：
 *   - 融合者在主会话里是**一次普通 subagent 调用**（可见、可等、结果直接进 tool result）
 *   - `agent="fusion"` ⇒ agents/fusion.md 的 body 作为系统提示；本函数的 prompt 仍是任务本体
 *   - 不 spawn 裸子进程 ⇒ 无 pid 可登记（runWithFallback 内部自己管子进程）
 */
export function makeSubagentFusionRunner(deps: {
	runWithFallback: (
		agent: unknown,
		task: string,
		systemPrompt: string | undefined,
		model: string | undefined,
		timeoutMs: number | undefined,
		signal: undefined,
		onUpdate: undefined,
		opts: Record<string, unknown>,
	) => Promise<{ status?: string; text?: string; error?: string; usage?: unknown }>;
	/** 按名字取 AgentDef（index.ts 的 agents 数组）；缺失时用 null 走「无 agent body」路径。 */
	findAgent: (name: string) => unknown;
}): FusionAgentRunner {
	return async (req) => {
		const startedAtMs = Date.now();
		const agent = deps.findAgent("fusion");
		const res = await deps.runWithFallback(
			agent,
			req.prompt,
			undefined,
			req.model,
			req.wallBudgetMs,
			undefined,
			undefined,
			{ cwd: req.repoRoot },
		);
		const timedOut = res.status === "timeout";
		const ok = res.status === "completed";
		const u = res.usage as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: number; turns?: number } | undefined;
		return {
			ok,
			exitCode: ok ? 0 : null,
			exitSignal: null,
			timedOut,
			spawnError: ok ? null : (res.error ?? `subagent 通道未完成（status=${res.status ?? "?"}）`),
			usage: u
				? {
						input: u.input ?? 0,
						output: u.output ?? 0,
						cacheRead: u.cacheRead ?? 0,
						cacheWrite: u.cacheWrite ?? 0,
						cost: u.cost ?? 0,
						turns: u.turns ?? 0,
					}
				: null,
			via: "subagent-runWithFallback",
			startedAtMs,
			text: res.text,
		} as FusionAgentResult & { startedAtMs: number; text?: string };
	};
}
