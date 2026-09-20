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

const DIAGNOSE_SECTIONS = [
	"Root cause / hypotheses（根因，带 file:line 证据）",
	"Evidence（观察到的硬证据：代码位置、调用链、数据流）",
	"Failed hypotheses（排查过并排除的方向，防重复劳动）",
	"Contradictory evidence（与假设矛盾的证据）",
	"Approach options（2-3 个可行方案，各自的改动面/风险/代价）",
	"Recommended direction（推荐方案 + 理由 + 具体到文件的改动清单）",
	"Verification plan（实现后应如何验证：可运行的命令/测试/手工步骤）",
	"Remaining uncertainty（不确定点，实现时需注意）",
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

export interface DiagnoseWorkerPromptInput {
	/** 原始任务（三路逐字相同）。 */
	task: string;
	runId: string;
	lane: LaneId;
	/** 主仓库 HEAD（诊断基点）。 */
	baseCommit: string;
	/** 主仓库根（只读工作区）。 */
	repoRoot: string;
	/** run artifact 根（~/.pi/agent/trace-fusion-runs/<runId>）。 */
	runDir: string;
	/** 单 lane 墙钟时限（分钟；§24.2）。 */
	wallClockMin: number;
}

/**
 * diagnose 模式 prompt（2026-09-17，真实运行驱动）：只读诊断主仓库，
 * 产出诊断+推进方案交主会话融合。零写入（edit/write 已被工具隔离移除；
 * bash 纪律约束：禁止 build/test/写文件，违规由 dirty-baseline 对比确定性检出）。
 */
export function buildDiagnoseWorkerPrompt(input: DiagnoseWorkerPromptInput): string {
	const laneDir = `${input.runDir.replace(/\\/g, "/")}/lanes/${input.lane}`;
	return [
		`## TRACE ${input.lane} — run ${input.runId}（diagnose 模式）`,
		"",
		"你是三路完全独立诊断 rollout 中的一路。三路收到同一个任务，各自独立诊断；",
		"你看不到其它两路，它们也看不到你。不要猜测别的 lane 在做什么，也不要优化「与多数一致」。",
		"",
		"## 任务（三路逐字相同）",
		"",
		input.task.trim(),
		"",
		"## 工作环境",
		"",
		`- 主仓库：${input.repoRoot}（只读！你不修改任何文件）`,
		`- 诊断基点：${input.baseCommit}（HEAD）`,
		`- 时限：约 ${input.wallClockMin} 分钟墙钟；临近时限优先把已有证据写全，不要开新战线`,
		"",
		"## 只读纪律（硬约束）",
		"",
		"- 你的唯一写入目标是 artifact 目录（下述 laneDir）；edit/write 工具已对你禁用",
		"- bash 仅限只读探查：git log/show/diff、grep、find、读文件；",
		"  【禁止】build/test/restore/写文件/管道重定向到仓库内路径（会污染用户工作树，supervisor 会检出）",
		"- 你的产出是「诊断 + 推进方案」，不是实现——不要试图改代码",
		"",
		"## 纪律（evidence-first）",
		"",
		"- 每个结论必须带 file:line 级证据；推测要标注推测",
		"- 排除掉的方向也要记录（防其它路重复劳动）",
		"",
		"## 委派（运行时强制，不是建议）",
		"",
		'- 唯一允许的委派是 subagent-win 且 agent: "searcher"（无头、只读证据收集）',
		"- searcher 不得实现；planner/implementer/reviewer 等一律被拒",
		"",
		"## artifact 契约（写入 " + laneDir + "/）",
		"",
		"1. `trajectory.md` —— 你的完整诊断叙事，按以下八节组织：",
		"",
		"```markdown",
		...DIAGNOSE_SECTIONS.split("\n").map((s) => `## ${s}`),
		"```",
		"",
		"2. `validation.json` —— 证据主张清单（只读命令，供复核；禁止 build/test）：",
		"",
		"```json",
		'[ { "command": "git log --oneline -5 -- path/to/file", "expectation": "展示引入该行为的提交", "result": "pass", "output_excerpt": "…" } ]',
		"```",
		"",
		"## 完成",
		"",
		"- 写完上述两个文件后调用 tab-finish：status=completed|failed、summary（一段话结论）、",
		"  reportPath 指向 trajectory.md",
		"- 即使诊断失败/未完成也必须 tab-finish（status=failed + 已知证据）；静默挂起会让整个 run 降级",
	].join("\n");
}
