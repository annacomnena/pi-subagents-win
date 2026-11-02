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

export const DIAGNOSE_SECTIONS = [
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
		"# ★ 你要回答的问题（唯一目标，读完再往下）",
		"",
		"```",
		input.task.trim(),
		"```",
		"",
		"**下面的全部内容是工具与约束说明；你的最终产出必须直接回答上面这个问题。**",
		"不要改写它、不要扩大它、不要把它变成「全面审计」。",
		"",
		"---",
		"",
		"## 工作环境",
		"",
		`- 主仓库：${input.repoRoot}（只读！你不修改任何文件）`,
		`- 诊断基点：${input.baseCommit}（HEAD）`,
		`- 时限：约 ${input.wallClockMin} 分钟墙钟；临近时限优先把已有证据写全，不要开新战线`,
		"",
		"## 检索纪律（决定了你 45 分钟内能挖多深）",
		"",
		"**优先用 codegraph，再考虑 grep**——它是本仓的符号级索引工具，比文本搜索准得多：",
		"",
		"- `codegraph { action: \"query\", query: \"<符号名>\" }` —— 按名字定位符号，返回 `kind name file:line` 精确行号",
		"- `codegraph { action: \"explore\", query: \"<一句主题描述>\" }` —— 一次给出相关符号源码 + 调用路径（**最省轮次**）",
		"- `codegraph { action: \"impact\", query: \"<符号名>\" }` —— **改它之前必查**：谁在调用、依赖哪些",
		"- `codegraph { action: \"status\" }` —— 看索引是否陈旧",
		"",
		"**陈旧闸门**：若返回带 `⚠ 索引可能陈旧`，行号可能已错位。先 `action: \"sync\"` 再查；",
		"若索引不可用（报「本仓未初始化」），**回退 grep/read**，不要假装有索引。",
		"",
		"**仍然必须核**：codegraph 给的是定位，不是验证。凡写进结论的关键事实，",
		"必须用 read 打开那个 file:line 看一眼（报告行号失真会直接污染融合阶段的判断）。",
		"",
		"## 先查 Wiki，再挖代码（省时间的关键）",
		"",
		"本仓的 `Wiki/` 已记录**已验证的耐久事实**（已完成功能的主题页 + 每页 `source_paths` 直指代码）：",
		"",
		"- `wiki-nav { action: \"tree\" }` —— 看主题页全貌（便宜：只给 id/title/status）",
		"- `wiki-nav { action: \"find\", query: \"<关键词>\" }` —— 全文检索 Wiki",
		"- `wiki-nav { action: \"keywords\", queries: [\"<短语>\"] }` —— 先确认术语存在（exact miss 才需 semantic-terms）",
		"",
		"命中后**直接按页内 `source_paths` 跳代码**，不要重新探索。若页内事实与代码矛盾，",
		"以代码为准并在 `Contradictory evidence` 一节记下（这对融合阶段很有用）。",
		"",
		"### Wiki 写入禁令（硬约束）",
		"",
		"`wiki-nav` 只有以下动作允许：**tree / around / find / keywords / path / semantic-status / semantic-terms**。",
		"**禁止 `rebuild` 与 `semantic-rebuild`** —— 它们会改写 `Wiki/_navigation.json` 等索引文件，",
		"被 `diagnoseDirtyViolations` 判为违规写主仓库（三路并发还会互相覆盖）；",
		"`semantic-rebuild` 还会调远程 embedding。",
		"",
		"## 写 artifact（必读：用 write 工具，不是 bash）",
		"",
		"你要创建两个文件，**必须用 `write` 工具**（它是你自己的工具，不是 shell 命令）：",
		"",
		"```",
		`write({ path: "${laneDir}/trajectory.md", content: "..." })`,
		`write({ path: "${laneDir}/validation.json", content: "..." })`,
		"```",
		"",
		"**【禁止】用 bash 写文件**：`mkdir` / `touch` / `cp` / `echo >` / `cat <<EOF` / 管道重定向",
		"一律不得用来创建 artifact。2026-11-02 实测：模型用 `mkdir + cp` 硬凑，产物落到错误目录、",
		"supervisor 收集不到，整趟 run 白跑。",
		"",
		`**〔禁止〕写 ${laneDir} 以外的任何路径**（包括主仓库、plans/、临时目录）；supervisor 会对比 git 基线确定性检出违规写入。`,
		"",
		"## 只读纪律（硬约束）",
		"",
		"- `edit` 工具对你禁用（不改代码）；`write` **只能**写上述两个 artifact 文件",
		"- bash 仅限只读探查：`git log/show/diff`、`grep`、`ls`、`head`、`cat` 读文件；",
		"  【禁止】build / test / restore / 写文件 / 重定向到仓库内路径",
		"- 你的产出是「诊断 + 推进方案」，不是实现——不要试图改代码",
		"",
		"## 任务边界（先读这一节，再开始）",
		"",
		"你收到的任务是**一个具体问题**，不是「找出这个系统里所有可能的缺陷」。",
		"",
		"- **先看「任务」那一节的字面要求**，按字面回答；不要自行扩大为「全面代码审计」",
		"- 若任务问的是「X 是什么 / 在哪里」，就直接给事实 + `file:line`，**不要转去分析设计缺陷**",
		"- 若你在排查中发现了**与任务无关**的其它问题，写进 `Remaining uncertainty`，**不要**把它当成主结论",
		"- 三路都收到**逐字相同**的任务，所以你不需要猜测别的 lane 在干什么",
		"",
		"常见跑题（2026-11-02 实测）：任务是「lane 必须产出哪些 artifact 文件」，",
		"三路却都答成了「trace-fusion 有哪些设计缺陷」——**这是不回原题**，属失败。",
		"",
		"## bash 安全红线（R-13，不得越线）",
		"",
		"**【绝对禁止】对盘符根 / 家目录的递归搜索，不区分斜杠方向**：",
		"`find /`、`find C:`、`find C:/`、`find C:\\`、`find /c`、`find ~`，以及任何不加目录限定的 `-name` / `-type d` 递归。",
		"2026-11-02 实测 **两次**事故：① `find / -name tab-finish` → 句柄涨到 **397,207**；",
		"② `find C:/ -type d -name trace-fusion-runs` —— 首版禁令只写了 `C:\\`，被 `C:/` 绕过。",
		"两者都逼近内存耗尽（历史同类事故导致 pi 包损坏 4 次）。",
		"",
		"找文件请用：① `codegraph`（符号级，最快）；② `ls`/`grep` **限定到具体目录**（如 `grep -rn x extensions/trace-fusion/`）。",
		"",
		"## 用工具，不是敲命令（关键区别）",
		"",
		"以下都是**工具**，不是 bash 命令，**不要** `which` 或 `find` 它们：",
		"",
		"| 工具 | 用途 |",
		"|---|---|",
		"| `codegraph` | 符号定位（query / explore / impact / status） |",
		"| `read` | 读文件（比 `cat` 好：有行号、失败会明确报错） |",
		"| `write` | 写 artifact（见上） |",
		"| `wiki-nav` | 查 Wiki 主题页 |",
		"| `tab-finish` | **声明完成**（见「完成」节） |",
		"",
		"`tab-finish` 尤其重要：它不是命令，是**结束本 lane 的唯一方式**。",
		"用 bash 敲 `tab-finish ...` 会得到 `command not found`，然后本 lane 会卡死到超时。",
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
		"## 完成（用 tab-finish 工具）",
		"",
		"写完两个文件后，**调用 `tab-finish` 工具**（不是命令）：",
		"",
		"```",
		`tab-finish({ status: "completed", summary: "<一段话结论>", reportPath: "${laneDir}/trajectory.md" })`,
		"```",
		"",
		"- 即使诊断失败/未完成也必须 tab-finish（status=failed + 已知证据）",
		"- **不调 tab-finish = 未完成**：静默挂起会让整个 run 降级到超时",
		"",
		"# ★★ 结束前自检（必做，否则这趟白跑）",
		"",
		"在调 tab-finish 之前，逐条对：",
		"",
		"1. **回到最上面那个「你要回答的问题」再读一遍。**你的 `trajectory.md` 是不是**直接回答了它**？",
		"   若不是（比如它问「X 是什么」你却写了「系统有哪些缺陷」）—— **重写，不要交跑题答案**。",
		"2. `trajectory.md` 是否八节齐全？（缺的节写「本次未涉及」也可以，但不能没有标题）",
		"3. `validation.json` 是否是**合法 JSON**？（字符串里的引号必须转义为 `\\\"`；不确定就用短句）",
		"4. 两个文件是否都写在 `" + laneDir + "` 下？（不是就重写，不要用 cp 搬）",
		"",
		"# ★ 再重申一次你要回答的问题",
		"",
		"```",
		input.task.trim(),
		"```",
		"",
		"（与本 prompt 开头的问题**完全同一个**。如果你的产出没有直接回答它，就还没完成。）",
	].join("\n");
}
