/**
 * trace-fusion/worker-prompt.ts — trace worker 任务 prompt 构造（trace-fusion C6，设计稿 §20/§21）
 *
 * §20 纪律：三个 tab 收到【同一个原始 task】，只允许 lane metadata 不同——
 * 严禁给 A/B/C 人为分配不同假设/方向，trajectories 必须自由分化。
 *
 * 硬编排边界不在这里重复注入（before_agent_start 已 early-return 专属段，C4）；
 * 本 prompt 承担：任务本体 + 工作环境 + evidence-first 纪律 + artifact 契约 + 完成方式。
 */

import type { LaneId } from "./types.ts";

export interface TraceWorkerPromptInput {
	/** 原始任务（三路逐字相同）。 */
	task: string;
	runId: string;
	lane: LaneId;
	/** synthetic base commit（supervisor 以它为基收集 patch.diff）。 */
	baseCommit: string;
	/** 该 lane 的 worktree 绝对路径。 */
	worktree: string;
	/** run artifact 根（~/.pi/agent/trace-fusion-runs/<runId>）。 */
	runDir: string;
	/** 单 lane 墙钟时限（分钟；§24.2）。 */
	wallClockMin: number;
	/** 供给降级提示（§16.1 规则 4：降权可执行证据，不是失败）。 */
	degraded?: boolean;
}

const TRAJECTORY_SECTIONS = [
	"Root cause / hypotheses",
	"What I tried",
	"Failed approaches",
	"Successful evidence",
	"Code changes",
	"Tests / reproductions",
	"Contradictory evidence",
	"Remaining uncertainty",
	"Recommended final direction",
].join("\n");

export function buildTraceWorkerPrompt(input: TraceWorkerPromptInput): string {
	const laneDir = `${input.runDir.replace(/\\/g, "/")}/lanes/${input.lane}`;
	return [
		`## TRACE ${input.lane} — run ${input.runId}`,
		"",
		"你是三路完全独立 rollout 中的一路。三路收到同一个任务，各自独立求解；",
		"你看不到其它两路，它们也看不到你。不要猜测别的 lane 在做什么，也不要优化「与多数一致」。",
		"",
		"## 任务（三路逐字相同）",
		"",
		input.task.trim(),
		"",
		"## 工作环境",
		"",
		`- worktree：${input.worktree}（可写；你的全部修改都在这里）`,
		`- base commit：${input.baseCommit}（最终证据收集相对它；不要 commit，保持工作树脏状态即可）`,
		"- 主仓库与其它 lane 的 worktree 一律禁止触碰",
		`- 时限：约 ${input.wallClockMin} 分钟墙钟；临近时限优先把已有证据写全，不要开新战线`,
		...(input.degraded ? ["- ⚠ 本 lane 依赖供给不完整（degraded: no-build-env）：无法完整构建/测试时，如实记录，静态证据照常收集"] : []),
		"",
		"## 纪律（evidence-first）",
		"",
		"- 先观察与重现，再动手修改；每一步都留下可复查的痕迹",
		"- 失败是有价值的证据：失败实验、报错、反例都要记录，不要掩盖或回滚掉",
		"- 可以加临时探针/日志辅助定位；但最终报告里注明它们不属于修复本身",
		"- 允许构建与跑测试；禁止大规模重构式改写",
		"",
		"## 委派（运行时强制，不是建议）",
		"",
		'- 唯一允许的委派是 subagent-win 且 agent: "searcher"（无头、只读证据收集）',
		"- searcher 不得实现；planner/implementer/reviewer 等一律被拒",
		"",
		"## artifact 契约（写入 " + laneDir + "/）",
		"",
		"1. `trajectory.md` —— 你的完整叙事，按以下九节组织：",
		"",
		"```markdown",
		...TRAJECTORY_SECTIONS.split("\n").map((s) => `## ${s}`),
		"```",
		"",
		"2. `validation.json` —— 可执行验证清单：",
		"",
		"```json",
		'[ { "command": "…", "expectation": "…", "result": "pass|fail|blocked", "output_excerpt": "…" } ]',
		"```",
		"",
		"3. `patch.diff` 由 supervisor 用 `git diff --binary <base> HEAD` + 未跟踪文件归档自动收集，",
		"   【你不需要也不应该自己生成 patch.diff】；trajectory.md 的 Code changes 只需叙事说明。",
		"",
		"## 完成",
		"",
		"- 写完上述两个文件后调用 tab-finish：status=completed|failed、summary（一段话结论）、",
		"  reportPath 指向 trajectory.md",
		"- 即使任务失败/未完成也必须 tab-finish（status=failed + 已知证据）；静默挂起会让整个 run 降级",
	].join("\n");
}
