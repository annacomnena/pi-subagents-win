/**
 * trace-fusion/fusion-packet.ts — 三路 trajectory 的结构化对照（2026-11-02）
 *
 * 问题：`finishDiagnoseRun` 生成的 cross-test-report.md 只写了「请主会话去读三份
 * trajectory.md」，**它自己不做任何归纳**。三份文件各 5-7K token，主会话要么全读
 * （吃满上下文），要么跳过（融合退化成凭印象）。
 *
 * 设计稿 §24 明确要求 Fusion Supervisor 是 **deterministic orchestration code，
 * 不应全交给模型**，且 §31 要求「不要把三个几十万 token raw session 全部塞进去」。
 * 所以这里做的是**确定性抽取**：把三份 8 节 trajectory 压成一张可比对的表，
 * 交给主会话（或未来的 fusionModel）做「拼装而非投票」（§25 明令禁止多数投票）。
 *
 * 边界（如实登记）：
 *   - 这里**不判断谁对谁错**，只做「抽取 + 对齐 + 标记分歧」；
 *   - 抽取是**基于节标题的文本切分**，不做语义理解 ⇒ 节缺失/标题漂移会显示为 `(missing)`，
 *     而不是猜内容；
 *   - 失败时的行为是**降级而非抛出**：某 lane 没有 trajectory.md ⇒ 该列全 `(missing)`。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LaneId } from "./types.ts";
import { TRACE_LANES } from "./types.ts";
import { DIAGNOSE_SECTIONS } from "./worker-prompt.ts";
import { replayLaneValidation, renderReplaySection, type LaneReplayFacts } from "./validation-replay.ts";
import { checkLaneCitations, renderCitationSection, type CitationFacts } from "./citation-check.ts";

/** 8 节的简名（去掉中文括注，供表头显示）。 */
export function sectionShortName(full: string): string {
	return full.replace(/（.*?）/g, "").replace(/\s+/g, " ").trim();
}

/** 每节在对照表里最多保留多少字符（太长的叙述对「对齐」无益）。 */
export const SECTION_EXCERPT_CHARS = 600;

export interface LaneSectionMap {
	lane: LaneId;
	/** 是否找到并解析了 trajectory.md。 */
	found: boolean;
	/** 节简名 → 该节正文。 */
	sections: Record<string, string>;
	/** 解析时发现的问题（缺节 / 读失败）。 */
	issues: string[];
}

/**
 * 解析单个 lane 的 trajectory.md（按 DIAGNOSE_SECTIONS 的 `## <full title>` 切分）。
 *
 * 容错：标题允许带前导空白；`## ` 后的文本必须**以该节标题开头**（避免把
 * `## Root cause...` 与 `## Root cause analysis...` 混为一谈——用 startsWith 而非 includes）。
 */
export function parseTrajectoryLane(runDir: string, lane: LaneId): LaneSectionMap {
	const file = join(runDir, "lanes", lane, "trajectory.md");
	const out: LaneSectionMap = { lane, found: false, sections: {}, issues: [] };
	if (!existsSync(file)) {
		out.issues.push(`trajectory.md 缺失`);
		return out;
	}
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (e) {
		out.issues.push(`读取失败：${(e as Error).message}`);
		return out;
	}
	out.found = true;

	// 按 `## ` 切块；每个块记住它的标题行与正文。
	const blocks: { title: string; body: string }[] = [];
	let cur: { title: string; lines: string[] } | null = null;
	for (const line of text.split(/\r?\n/)) {
		const m = /^##\s+(.+?)\s*$/.exec(line);
		if (m) {
			if (cur) blocks.push({ title: cur.title, body: cur.lines.join("\n").trim() });
			cur = { title: m[1], lines: [] };
		} else if (cur) {
			cur.lines.push(line);
		}
	}
	if (cur) blocks.push({ title: cur.title, body: cur.lines.join("\n").trim() });

	for (const full of DIAGNOSE_SECTIONS.split("\n")) {
		const short = sectionShortName(full);
		// 用短名做 startsWith 匹配（模型常把标题改写为不带括注的版本，或加后缀）
		const hit = blocks.find((b) => b.title.startsWith(short) || b.title.startsWith(full));
		if (hit) {
			out.sections[short] = hit.body;
		} else {
			out.sections[short] = "";
			out.issues.push(`缺节：${short}`);
		}
	}
	return out;
}

/** 句段归一化（与 sectionsDiverge 共用同一函数，防止两处判据漂移）。 */
function normalizeForCompare(t: string): string {
	return t.replace(/[*_`#>|-]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

/** 两段是否「实质相同」：逐字相同，或一方包含另一方（粗细差异）。 */
function sameText(a: string, b: string): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	return a.includes(b) || b.includes(a);
}

/** 分歧结构：把参与比较的路按「内容相同」分组（保持原下标顺序）。 */
export interface DivergenceShape {
	/** 是否有实质分歧。 */
	diverge: boolean;
	/** 分组（每组是路下标）；组数>=2 即实质分歧。 */
	groups: number[][];
	/**
	 * 是否为「少数派孤立」形态（一组 >=2 路、另一组只有 1 路）。
	 * 这是最需要区分的情况：它意味着「剔除那 1 路」而非「三方仲裁」。
	 */
	minorityIsolated: boolean;
	/** 少数派的路下标（minorityIsolated 时有效）。 */
	minority: number[];
}

/**
 * 计算分歧结构（2026-11-02）。
 *
 * 背景：旧版只返回 boolean，报告只能写「分歧」，读的人无法区分：
 *   - 三方各执一词 → 需仲裁
 *   - 2:1 孤立 → 应剔除少数派
 * 实测 21f9：A≡B 7/8 节、C 与两者在 0/8 节相同（jaccard 0.00~0.09）；
 * 而 a726 是 0/8 三方全不同。两者被判据渲染成同一种「8 节全分歧」。
 *
 * 判据与 sectionsDiverge **完全同源**（同一个 normalizeForCompare + sameText），
 * 保证「diverge=false ⇔ groups.length<=1」。
 */
export function divergenceShape(texts: string[]): DivergenceShape {
	const norm = texts.map(normalizeForCompare);
	// 空文本不参与分组（覆盖不足由缺节 issue 负责，不是分歧）
	const present = norm.map((t, i) => ({ i, t })).filter((x) => x.t.length > 0);
	if (present.length < 2) {
		return { diverge: false, groups: [present.map((x) => x.i)], minorityIsolated: false, minority: [] };
	}

	// 并查集式分组：只要与组内任一成员 sameText 即归入该组
	const groups: number[][] = [];
	for (const p of present) {
		let placed = false;
		for (const g of groups) {
			if (g.some((k) => sameText(norm[k], p.t))) {
				g.push(p.i);
				placed = true;
				break;
			}
		}
		if (!placed) groups.push([p.i]);
	}

	const diverge = groups.length > 1;
	// 少数派孤立：最大的组 >=2 人，且剩下的组总共只有 1 路
	const sorted = [...groups].sort((x, y) => y.length - x.length);
	const minorityIsolated =
		diverge && sorted[0].length >= 2 && sorted.slice(1).reduce((n, g) => n + g.length, 0) === 1;
	const minority = minorityIsolated ? sorted.slice(1).flat() : [];
	return { diverge, groups, minorityIsolated, minority };
}

/** 判断同一节在三条 lane 之间是否存在实质差异（用于「分歧」标记）。
 *
 * 归一化：去 markdown 记号、压缩空白、转小写。**完全相同或一方包含另一方**视为一致
 * （包含关系常见于「B 写得更细」，那是对齐不是分歧）。
 * 这不是语义判等，只是噪声过滤——真正的仲裁仍由人或融合模型做。
 *
 * 若需要知道「谁和谁分歧」，用 divergenceShape（本函数的 boolean 与之同源）。
 */
export function sectionsDiverge(texts: string[]): boolean {
	return divergenceShape(texts).diverge;
}

function excerpt(s: string, max: number): string {
	const flat = s.replace(/\s+/g, " ").trim();
	if (!flat) return "_(空)_";
	return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

export interface FusionPacketInput {
	runDir: string;
	task: string;
	baseCommit: string;
	/** 选填：run 模式（diagnose/implement）。有则写进 Hard Facts。 */
	mode?: string;
	/** 选填：verification.jsonl 收集到的命令条数（硬事实：真跑了几条）。 */
	validationCommandCount?: number;
	/** 选填：collect 阶段发现的违规写入（硬事实）。 */
	dirtyViolations?: string[];
	/** 选填：tab-runs 目录（读 result.json 用）。未给则跳过 result 事实。 */
	tabRunsDir?: string;
	/** 返填：lane → tabRunId（读 result.json 用）。 */
	laneTabRunIds?: Partial<Record<string, string>>;
	/**
	 * 选填：给了就**复跑**各 lane 自己声明的验证命令（2026-11-02）。
	 *
	 * 为什么需要：c2f5 的 lane B 四条 validation **全部自报 pass，实测全部失败**，
	 * 而 Hard Facts 只数「带 command 条数」从不执行 ⇒  packet 的 Instruction
	 * 「可执行证据压过自报置信度」在 harness 里根本没兑现。本字段就是去兑现它。
	 * 值为命令工作目录（= meta.repoRoot）。只跑只读命令，详见 validation-replay.ts 安全面。
	 */
	replayRepoRoot?: string;
	/** 复跑执行 seam（测试注入；缺省 = spawnSync）。 */
	replayExec?: (cmd: string, cwd: string, timeoutMs: number) => { exitCode: number | null; timedOut: boolean; stdout: string; stderr: string };
	replayTimeoutMs?: number;
	replayBudgetMs?: number;
	/**
	 * 选填：给了就按**诊断基点 commit** 机械核验各 lane trajectory 里的 `file:line` 引用
	 * （越界 / 基点无此文件）。值为仓根。
	 * 实测依据：c2f5 三路各有一处越界（A 引 :315 > 基点 300 行；C 引 :495-506 > 基点 483 行），
	 * 此前只能靠融合模型/主会话逐条核。
	 */
	citationRepoRoot?: string;
	citationGitShow?: (repoRoot: string, baseCommit: string, relPath: string, timeoutMs: number) => { ok: boolean; lines: number };
	/** 基点文件清单 seam（测试注入；缺省 = `git ls-tree -r --name-only`）。 */
	citationGitList?: (repoRoot: string, baseCommit: string, timeoutMs: number) => string[] | null;
	citationMaxFiles?: number;
}

/**
 * 从 result.json 抽硬事实（2026-11-02，b31e 实跑驱动）。
 *
 * 为何需要：实测 b31e 中 lane B **根本没产出 trajectory.md**，而 meta 仍是 `completed`。
 * 旧 packet 只说「缺 trajectory.md」，不说**为什么**——而原因就在 result.json：
 * `status: "unconfirmed"` + `sumamey: "tab 回合结束但未调用 tab-finish"`。
 * 不读它 ⇒ 读者得自己去猜是崩溃、超时还是忘回报。
 */
export interface ResultFacts {
	exists: boolean;
	/** tab 自报状态（completed/unconfirmed/failed/cancelled...）。 */
	status?: string;
	/** 摘要前 160 字（最能说明原因的字段）。 */
	summary?: string;
}

export function extractResultFacts(tabRunsDir: string, tabRunId: string): ResultFacts {
	if (!tabRunId) return { exists: false };
	try {
		const p = join(tabRunsDir, `${tabRunId}.result.json`);
		if (!existsSync(p)) return { exists: false };
		const d = JSON.parse(readFileSync(p, "utf8")) as { status?: unknown; summary?: unknown };
		return {
			exists: true,
			status: typeof d.status === "string" ? d.status : undefined,
			summary: typeof d.summary === "string" ? d.summary.slice(0, 160) : undefined,
		};
	} catch {
		return { exists: false };
	}
}

/** 从 validation.json 里确定性抽取的硬事实（不解释、只计数）。 */
export interface ValidationFacts {
	/** 解析成功。 */
	ok: boolean;
	/** 条目数（数组长度）。 */
	total: number;
	/** 带 command 字段的条数（真正“跑过”的证据）。 */
	withCommand: number;
	/** 带 file:line 形式的条数。 */
	withFileLine: number;
}

/**
 * 从 validation.json 抽硬事实。**只计数，不评判**。
 * 解析失败返回 ok=false + 全 0（不抛）。
 */
export function extractValidationFacts(runDir: string, lane: LaneId): ValidationFacts {
	const empty: ValidationFacts = { ok: false, total: 0, withCommand: 0, withFileLine: 0 };
	try {
		const p = join(runDir, "lanes", lane, "validation.json");
		if (!existsSync(p)) return empty;
		const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
		const arr = Array.isArray(raw) ? raw : null;
		if (!arr) return empty;
		let withCommand = 0;
		let withFileLine = 0;
		for (const item of arr) {
			const s = typeof item === "string" ? item : JSON.stringify(item ?? "");
			if (/"command"\s*:/.test(s)) withCommand++;
			if (/[\w./-]+\.(ts|tsx|js|mjs|json|md):\d+/.test(s)) withFileLine++;
		}
		return { ok: true, total: arr.length, withCommand, withFileLine };
	} catch {
		return empty;
	}
}

export interface FusionPacket {
	/** markdown 对照报告（写 cross-test-report.md 的融合段）。 */
	markdown: string;
	lanes: LaneSectionMap[];
	/** 有实质分歧的节简名（供主会话优先看）。 */
	divergentSections: string[];
	/** 三路都没填的节（说明三路都漏了，比分歧更值得警惕）。 */
	allMissingSections: string[];
	/** 每路的 validation.json 硬事实（计数）。 */
	validationFacts: Record<string, ValidationFacts>;
	/** 每路 validation 命令的**复跑**硬事实（仅当 input.replayRepoRoot 给出）。 */
	replay: LaneReplayFacts[];
	/** 每路行号引用的越界硬事实（仅当 input.citationRepoRoot 给出）。 */
	citations: CitationFacts[];
}

/**
 * 构造 Fusion Packet（确定性，零模型调用）。
 *
 * 这是设计稿 §61「Fusion Packet」的**最小可行版**：只做对齐表 + 分歧标记，
 * 不做 decision/confidence 判定（那需要 fusionModel，属 §31，当前未实现）。
 */
export function buildFusionPacket(input: FusionPacketInput): FusionPacket {
	const lanes = TRACE_LANES.map((l) => parseTrajectoryLane(input.runDir, l));
	const shortNames = DIAGNOSE_SECTIONS.split("\n").map(sectionShortName);

	const divergentSections: string[] = [];
	const allMissingSections: string[] = [];
	// 分歧结构（2026-11-02）：记录每节是「三方各执一词」还是「2:1 少数派孤立」。
	// 后者只需剔除那一路，前者才需仲裁——报告必须能区分，否则读者无从下手。
	const isolatedPerSection = new Map<string, number[]>();
	for (const s of shortNames) {
		const texts = lanes.map((l) => l.sections[s] ?? "");
		if (texts.every((t) => !t.trim())) {
			allMissingSections.push(s);
			continue;
		}
		const shape = divergenceShape(texts);
		if (shape.diverge) {
			divergentSections.push(s);
			if (shape.minorityIsolated) isolatedPerSection.set(s, shape.minority);
		}
	}
	const laneName = (i: number) => lanes[i]?.lane ?? `#${i}`;

	const lines: string[] = [];
	lines.push("## 三路结构化对照（确定性抽取，零模型调用）");
	lines.push("");
	lines.push(`- 任务：${input.task.trim().split("\n")[0].slice(0, 160)}`);
	lines.push(`- 诊断基点：\`${input.baseCommit.slice(0, 12)}\``);
	lines.push(`- 三路 artifact：${lanes.map((l) => `${l.lane}${l.found ? "✓" : "✗"}`).join(" / ")}`);
	lines.push("");
	lines.push("> 本表只做**抽取与对齐**，不判谁对谁错。设计稿 §25 明令**禁止多数投票**：");
	lines.push("> 同模型 rollout 的错误高度相关，正确做法是「拼装」——A 的诊断 + B 的结构 + C 的证据。");
	lines.push("");

	if (divergentSections.length > 0) {
		lines.push(`### ⚠ 有实质分歧的节（${divergentSections.length}）——优先看`);
		lines.push("");
		for (const s of divergentSections) {
			const min = isolatedPerSection.get(s);
			if (min && min.length > 0) {
				const others = lanes.map((_, i) => i).filter((i) => !min.includes(i)).map(laneName);
				lines.push(`- ${s} —— **${min.map(laneName).join("/")} 单独一路**（${others.join("/")} 一致）`);
			} else {
				lines.push(`- ${s} —— 三路各不同`);
			}
		}
		lines.push("");
		// 形态统计：这是本报告从「只报有分歧」升级到「报分歧形状」的关键一行。
		const isoCount = isolatedPerSection.size;
		const splitCount = divergentSections.length - isoCount;
		if (isoCount > 0 || splitCount > 0) {
			const parts: string[] = [];
			if (isoCount > 0) parts.push(`**${isoCount} 节少数派孤立**（剔除少数派即可收敛，不需仲裁）`);
			if (splitCount > 0) parts.push(`${splitCount} 节三路各不同（需仲裁）`);
			lines.push(`> 分歧形状：${parts.join("；")}。`);
			lines.push("> 少数派孤立 ≠ 少数派错：同模型 rollout 错误高度相关，少数派也可能是唯一正确的。");
			lines.push("");
		}
	}
	if (allMissingSections.length > 0) {
		lines.push(`### ⚠ 三路都未填的节（${allMissingSections.length}）——比分歧更值得警惕`);
		lines.push("");
		for (const s of allMissingSections) lines.push(`- ${s}`);
		lines.push("");
	}

	lines.push("### 逐节对照");
	lines.push("");
	for (const s of shortNames) {
		// 标记带形状：「分歧」单写无信息，追写「C 孤立」/「三路各不同」才对读者有用。
		let flag = "";
		if (divergentSections.includes(s)) {
			const min = isolatedPerSection.get(s);
			flag = min && min.length > 0
				? ` · **分歧**（${min.map(laneName).join("/")} 孤立）`
				: " · **分歧**（三路各不同）";
		}
		lines.push(`#### ${s}${flag}`);
		lines.push("");
		for (const l of lanes) {
			const body = l.sections[s] ?? "";
			lines.push(`- **${l.lane}**：${l.found ? excerpt(body, SECTION_EXCERPT_CHARS) : "_(无 trajectory.md)_"}`);
		}
		lines.push("");
	}

	const issues = lanes.filter((l) => l.issues.length > 0);
	if (issues.length > 0) {
		lines.push("### 抽取问题（供复核）");
		lines.push("");
		for (const l of issues) lines.push(`- **${l.lane}**：${l.issues.join("；")}`);
		lines.push("");
	}

	lines.push("### 下一步（人工/主会话）");
	lines.push("");
	lines.push("1. 先看上面的**分歧节**——一致根因 ⇒ 高置信；分歧 ⇒ 需仲裁（不是取多数）。");
	lines.push("2. 三路都没填的节说明证据不足，实现前应补最小探针。");
	lines.push("3. 全文仍在 `lanes/{A,B,C}/trajectory.md`；本节只做压缩，不替代原文。");
	lines.push("");

	// ── Hard Facts（设计稿 §61）：只写可机械核验的东西，不写推断 ──
	const validationFacts: Record<string, ValidationFacts> = {};
	for (const l of lanes) validationFacts[l.lane] = extractValidationFacts(input.runDir, l.lane);
	// 复跑（2026-11-02）：给了 replayRepoRoot 才跑；不给则零行为（零回归）。
	const replayAll: LaneReplayFacts[] = input.replayRepoRoot
		? TRACE_LANES.map((l) =>
				replayLaneValidation({
					runDir: input.runDir,
					lane: l,
					repoRoot: input.replayRepoRoot as string,
					exec: input.replayExec,
					timeoutMs: input.replayTimeoutMs,
					totalBudgetMs: input.replayBudgetMs,
				}),
			)
		: [];
	// 行号引用越界校验（2026-11-02）：给了 citationRepoRoot 才做；按基点 commit 判。
	const citationAll: CitationFacts[] = input.citationRepoRoot
		? TRACE_LANES.map((l) =>
				checkLaneCitations({
					runDir: input.runDir,
					lane: l,
					repoRoot: input.citationRepoRoot as string,
					baseCommit: input.baseCommit,
					gitShow: input.citationGitShow,
					gitList: input.citationGitList,
					maxFiles: input.citationMaxFiles,
				}),
			)
		: [];
	// result.json 事实（b31e 实跑驱动）：解释「为什么缺产物」——B 自报 unconfirmed。
	const resultFacts: Record<string, ResultFacts> = {};
	for (const l of lanes) {
		const tid = input.laneTabRunIds?.[l.lane];
		resultFacts[l.lane] = input.tabRunsDir && tid ? extractResultFacts(input.tabRunsDir, tid) : { exists: false };
	}

	lines.push("### Hard Facts（硬事实：可机械核验，不包含推断）");
	lines.push("");
	lines.push(`- 任务：${input.task.trim().split("\n")[0].slice(0, 200)}`);
	lines.push(`- 诊断基点 commit：\`${input.baseCommit}\``);
	if (input.mode) lines.push(`- run 模式：${input.mode}${input.mode === "diagnose" ? "（只读；不产真实 patch）" : ""}`);
	lines.push("");
	lines.push("| lane | trajectory.md | 八节齐全 | validation.json | 条目 | 带 command | 带 file:line | tab 自报 |");
	lines.push("|---|---|---|---|---|---|---|---|");
	for (const l of lanes) {
		const f = validationFacts[l.lane];
		const r = resultFacts[l.lane];
		const secCount = shortNames.filter((s) => (l.sections[s] ?? "").trim().length > 0).length;
		const selfReport = !r.exists ? "-" : r.status === "completed" ? "✓ completed" : `⚠ ${r.status}`;
		lines.push(
			`| ${l.lane} | ${l.found ? "✓" : "✗ 缺失"} | ${secCount}/${shortNames.length} | ${f.ok ? "✓ 合法 JSON" : "✗ 缺失/非法"} | ${f.ok ? f.total : "-"} | ${f.ok ? f.withCommand : "-"} | ${f.ok ? f.withFileLine : "-"} | ${selfReport} |`,
		);
	}
	lines.push("");
	// 自报非 completed 的路：把原因写出来（旧版只说「缺失」，不说为什么）
	const suspicious = lanes.filter((l) => {
		const r = resultFacts[l.lane];
		return r.exists && r.status && r.status !== "completed";
	});
	if (suspicious.length > 0) {
		lines.push("- ⚠ **自报未完成的路（产物缺失的原因）**：");
		for (const l of suspicious) {
			const r = resultFacts[l.lane];
			lines.push(`  - ${l.lane}：\`${r.status}\` —— ${r.summary ?? "(无 summary)"}`);
		}
		lines.push("");
	}
	if (input.dirtyViolations && input.dirtyViolations.length > 0) {
		lines.push(`- ⚠ **主仓库基线外改动（${input.dirtyViolations.length}）**：${input.dirtyViolations.slice(0, 5).join("; ")}`);
	} else {
		lines.push("- 主仓库违规写入：无（基线对比通过）");
	}
	lines.push("");
	lines.push("> 以上均为计数/存在性，**不含对错判定**。八节齐全 ≠ 结论正确；JSON 合法 ≠ 内容有据。");
	lines.push("");

	// ── Conflicts（设计稿 §61）：把分歧压成一张可执行的分组表 ──
	if (citationAll.length > 0) {
		lines.push(...renderCitationSection(citationAll));
	}
	if (replayAll.length > 0) {
		lines.push("### Validation 复跑（确定性执行 lane 自己声明的验证命令，零模型调用）");
		lines.push("");
		lines.push(...renderReplaySection(replayAll).slice(2));
	}
	lines.push("### Conflicts（分歧分组：谁与谁不同）");
	lines.push("");
	if (divergentSections.length === 0) {
		lines.push("- 无实质分歧（全部节在各路间内容一致或仅为粗细关系）。");
	} else {
		lines.push("| 节 | 形态 | 分组 |");
		lines.push("|---|---|---|");
		for (const s of divergentSections) {
			const min = isolatedPerSection.get(s);
			const texts = lanes.map((l) => l.sections[s] ?? "");
			const shape = divergenceShape(texts);
			const groups = shape.groups.map((g) => g.map((i) => lanes[i]?.lane ?? `#${i}`).join("=")).join(" / ");
			// 2026-11-02 修：旧版硬编码「三方各不同」，但只有 2 路有内容时会说谎。
			// 实测 b31e：B 无 trajectory.md，只 A/C 有内容，却被标成「三方各不同」。
			const partCount = shape.groups.reduce((n, g) => n + g.length, 0);
			const form = min && min.length > 0
				? `少数派孤立（${min.map(laneName).join("/")}）`
				: `${partCount} 路各不同`;
			lines.push(`| ${s} | ${form} | ${groups} |`);
		}
	}
	lines.push("");
	if (allMissingSections.length > 0) {
		lines.push(`- 三路都未填：${allMissingSections.join("、")}`);
		lines.push("");
	}

	// ── Instruction（设计稿 §61，逐字沿用）：给融合模型（或主会话）的执行约束 ──
	lines.push("### Instruction（执行约束，不是建议）");
	lines.push("");
	lines.push("```");
	lines.push("Do not vote by majority.");
	lines.push("Executable evidence dominates self-reported confidence.");
	lines.push("Determine the best currently available solution.");
	lines.push("If evidence is insufficient, identify the smallest high-information");
	lines.push("experiment or consultant question required to resolve the uncertainty.");
	lines.push("```");
	lines.push("");
	lines.push("本仓补充（同模型 rollout 的特殊风险）：");
	lines.push("");
	lines.push("- 三路可能是**同一个模型**（如 bonsai-9b）⇒ 「多数一致」不代表正确，它们可能犯同一个错。");
	lines.push("- 少数派孤立时，**先检验少数派的证据**，不要因它是少数就丢弃。");
	lines.push("- 引用结论时必须能回指到具体 `file:line` 或 `validation.json` 条目，不能只给说法。");
	lines.push("");

	return { markdown: lines.join("\n"), lanes, divergentSections, allMissingSections, validationFacts, replay: replayAll, citations: citationAll };
}
