/**
 * 行号引用越界校验（2026-11-02，c2f5 实测驱动）
 *
 * 起因：c2f5 三路 trajectory 的行号引用里，融合阶段人工核出多处越界（我逐条
 * `git show 基点:文件 | wc -l` 比出来的）：
 *   - lane A 引 `line 315`（worker-prompt.ts），基点该文件 **300 行**
 *   - lane C 引 `fusion-packet.ts:495-506`，基点该文件 **483 行**
 * 小模型的行号大量不可信，而 packet 此前没有任何机械读数能说明「这些行号里有多少根本不存在」。
 *
 * ## 真实数据教会我的两件事（第一版就是错在这里，单元测试没覆盖到）
 *
 * 1. lane 写的是**裸文件名**（`artifacts.ts:179`），不是仓内路径。拿它直接
 *    `git show 基点:artifacts.ts` 必然失败 ⇒ 会被误判成「文件不存在」。
 *    所以必须先取**基点的文件清单**（一次 `git ls-tree -r`）按 basename 解析：
 *    唯一命中才判行号；多个命中记 `ambiguous`；查不到才记 `missingFile`。
 * 2. lane 大量写**裸行号**（`line 315`，A 路 14 条引用里 11 条是裸的）。
 *    裸行号不能凭空核验 ⇒ 与**同一行文本里出现的路径/文件名**关联后再判，
 *    关联到的条目标 `heuristic`（启发式，如实标注）；关联不到才记 `unqualified`。
 *
 * ## 判据边界（必须如实读）
 *
 * - 只判「越界 / 基点无此文件 / 名字有歧义」三类**硬形状错**。
 *   「行号存在但内容不支持结论」判不了 ⇒ 语义判定属 fusion。
 *   **越界为 0 不等于引用都对**，这是下界。
 * - 基点 = `meta.baseCommit`。行号随提交漂移：本次 lane A 的 `:315` 在 HEAD 上存在、
 *   在基点上不存在 ⇒ **必须按基点判**，用 HEAD 判会把越界放成合法。
 * - `git` 只读（`ls-tree` / `show`）；文件清单一次、行数按文件缓存；上限可配且**跳过要记账**。
 */

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { LaneId } from "./types.ts";

export interface CitationFacts {
	lane: LaneId;
	/** 抽到的引用总数（含裸行号）。 */
	total: number;
	/** 已解析到基点真实文件、可比行号的条数。 */
	checkable: number;
	/**
	 * 引用的是**本 lane 自己的产物**（`patch.diff line 194`、`trajectory.md line 179`…）。
	 * c2f5 实测：lane A 14 条里 6 条、lane B 13 条里 6 条是这种——它们不是仓内文件，
	 * 归到「基点无此文件」是误报；行号应对**该产物自身行数**判。
	 */
	laneArtifact: number;
	/** 基点上核验通过（行号在范围内）。 */
	ok: number;
	/** 行号超出基点文件行数。 */
	outOfRange: string[];
	/** 基点上找不到该文件（已按 basename 解析过仍找不到）。 */
	missingFile: string[];
	/** 裸文件名在仓里有多个同名文件 ⇒ 无法确定指哪个，不判对错。 */
	ambiguous: number;
	/** 裸行号且同行无任何文件名可关联 ⇒ 无法核验。 */
	unqualified: number;
	/** 裸行号经同行文件名关联后核验的条数（启发式，如实标注）。 */
	heuristic: number;
	/** 因文件数上限被跳过的引用数（不静默丢弃）。 */
	skipped: number;
}

export interface CitationCheckOptions {
	runDir: string;
	lane: LaneId;
	repoRoot: string;
	baseCommit: string;
	/** 最多核验多少个不同文件（防全仓扫）。缺省 60。 */
	maxFiles?: number;
	/** 单条 git 命令超时。缺省 8s。 */
	gitTimeoutMs?: number;
	/** git seam（测试注入）。缺省 spawnSync。 */
	gitShow?: (repoRoot: string, baseCommit: string, relPath: string, timeoutMs: number) => { ok: boolean; lines: number };
	/** 基点文件清单 seam（测试注入）。缺省 `git ls-tree -r --name-only`。 */
	gitList?: (repoRoot: string, baseCommit: string, timeoutMs: number) => string[] | null;
}

/** 从 markdown 抽 `file:line` / `file#L12` 引用（含区间与逗号清单的起始）。 */
export function extractCitations(text: string): Array<{ file: string; from: number; to: number; raw: string }> {
	const out: Array<{ file: string; from: number; to: number; raw: string }> = [];
	const re = /([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)\s*(?::|＃|#L?)\s*(\d+)(?:\s*[-–,]\s*(\d+))?/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const from = Number(m[2]);
		const to = m[3] ? Number(m[3]) : from;
		if (!Number.isFinite(from) || from <= 0) continue;
		out.push({ file: m[1], from, to, raw: m[0] });
	}
	return out;
}

/** 从一行文本里找可用于关联裸行号的文件名：取**裸行号之前最近**出现的那个。
 * （c2f5 实测：“…patch.diff (line 315” 这种行里，“最后一个文件名”会抢到错的文件；
 * 裸行号在语义上紧跟它所修饰的文件名。） */
export function findFileForRef(line: string, refIndex: number): string | null {
	const re = /([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)/g;
	let best: string | null = null;
	let m: RegExpExecArray | null;
	while ((m = re.exec(line)) !== null) {
		if (m.index <= refIndex) best = m[1];
		else break;
	}
	return best;
}

/** 旧入口（同行最后一个文件名，仅供测试对照）。 */
export function findFileOnLine(line: string): string | null {
	const re = /([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)/g;
	let last: string | null = null;
	let m: RegExpExecArray | null;
	while ((m = re.exec(line)) !== null) last = m[1];
	return last;
}

/** 裸行号引用（`line 315` / `第 315 行`），连同所在行与**匹配位置**返回（供就近关联文件名）。 */
export function collectBareLineRefs(text: string): Array<{ line: number; to: number; raw: string; hostLine: string; index: number }> {
	const out: Array<{ line: number; to: number; raw: string; hostLine: string; index: number }> = [];
	const en = /(?:^|[^\w./-])\b(?:lines?|行号?)\s*[:＃]?\s*(\d+)(?:\s*[-–,]\s*(\d+))*/gi;
	const zh = /第\s*(\d+)\s*行/g;
	const lines = text.split("\n");
	lines.forEach((host, idx) => {
		for (const re of [en, zh]) {
			re.lastIndex = 0;
			let m: RegExpExecArray | null;
			while ((m = re.exec(host)) !== null) {
				const n = Number(m[1]);
				if (Number.isFinite(n) && n > 0) {
					const to = m[2] ? Number(m[2]) : n;
					out.push({ line: n, to: Number.isFinite(to) && to >= n ? to : n, raw: m[0].trim(), hostLine: host.trim(), index: m.index + (host.length - host.trimStart().length) });
				}
			}
		}
	});
	return out;
}

const defaultGit = (repoRoot: string, args: string[], timeoutMs: number) =>
	spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });

const defaultGitShow = (repoRoot: string, baseCommit: string, relPath: string, timeoutMs: number) => {
	const r = defaultGit(repoRoot, ["show", `${baseCommit}:${relPath}`], timeoutMs);
	if (r.status !== 0) return { ok: false, lines: 0 };
	const body = r.stdout ?? "";
	const n = body.length === 0 ? 0 : body.split("\n").length - (body.endsWith("\n") ? 1 : 0);
	return { ok: true, lines: n };
};

const defaultGitList = (repoRoot: string, baseCommit: string, timeoutMs: number) => {
	const r = defaultGit(repoRoot, ["ls-tree", "-r", "--name-only", baseCommit], timeoutMs);
	if (r.status !== 0) return null;
	return (r.stdout ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
};

/** 校验一路 lane 的行号引用（确定性，零模型调用）。never-throw。 */
export function checkLaneCitations(opts: CitationCheckOptions): CitationFacts {
	const facts: CitationFacts = {
		lane: opts.lane,
		total: 0,
		checkable: 0,
		ok: 0,
		outOfRange: [],
		missingFile: [],
		ambiguous: 0,
		unqualified: 0,
		heuristic: 0,
		laneArtifact: 0,
		skipped: 0,
	};
	try {
		const p = join(opts.runDir, "lanes", opts.lane, "trajectory.md");
		if (!existsSync(p)) return facts;
		const text = readFileSync(p, "utf8");

		const timeoutMs = opts.gitTimeoutMs ?? 8_000;
		const gitShow = opts.gitShow ?? defaultGitShow;
		const gitList = opts.gitList ?? defaultGitList;
		const maxFiles = opts.maxFiles ?? 60;

		// 基点文件清单：basename → 仓内路径[]。裸文件名必须先经这一步解析。
		const listing = gitList(opts.repoRoot, opts.baseCommit, timeoutMs) ?? [];
		const byBase = new Map<string, string[]>();
		const pathSet = new Set(listing);
		for (const rel of listing) {
			const base = rel.split(/[\\/]/).pop() ?? rel;
			(byBase.get(base) ?? byBase.set(base, []).get(base)!).push(rel);
		}

		const resolve = (file: string): { kind: "path" | "basename"; rel: string } | { kind: "missing" } | { kind: "ambiguous" } => {
			if (pathSet.has(file)) return { kind: "path", rel: file };
			const cands = byBase.get(file.split(/[\\/]/).pop() ?? file) ?? [];
			if (cands.length === 1) return { kind: "basename", rel: cands[0] };
			if (cands.length > 1) return { kind: "ambiguous" };
			return { kind: "missing" };
		};

		const lineCache = new Map<string, { ok: boolean; lines: number }>();
		// lane 自产文件（自己写的 patch / trajectory / validation 等）的行号，对**产物自身行数**判。
		const ARTIFACT_NAMES = new Set(["trajectory.md", "validation.json", "patch.diff", "status.txt", "result.json", "untracked.md"]);
		const localLines = new Map<string, number | null>();
		const localCount = (base: string): number | null => {
			if (localLines.has(base)) return localLines.get(base)!;
			const lp = join(opts.runDir, "lanes", opts.lane, base);
			let v: number | null = null;
			if (existsSync(lp)) {
				const body = readFileSync(lp, "utf8");
				v = body.length === 0 ? 0 : body.split("\n").length - (body.endsWith("\n") ? 1 : 0);
			}
			localLines.set(base, v);
			return v;
		};
		const judged = (file: string, from: number, to: number, raw: string, viaBase: boolean) => {
			const baseName = file.split(/[\\/]/).pop() ?? file;
			if (ARTIFACT_NAMES.has(baseName) && !pathSet.has(file)) {
				facts.laneArtifact++;
				const n = localCount(baseName);
				if (n === null) {
					facts.missingFile.push(`${raw}（lane 产物目录里无 ${baseName}）`);
					return;
				}
				facts.checkable++;
				if (from > n) facts.outOfRange.push(`${raw}（lane 产物 ${baseName} 共 ${n} 行）`);
				else if (to > n) facts.outOfRange.push(`${raw}（终点越界；lane 产物 ${baseName} 共 ${n} 行）`);
				else facts.ok++;
				return;
			}
			const r = resolve(file);
			if (r.kind === "missing") {
				facts.missingFile.push(`${raw}（基点上无此文件）`);
				return;
			}
			if (r.kind === "ambiguous") {
				facts.ambiguous++;
				return;
			}
			if (!lineCache.has(r.rel)) {
				if (lineCache.size >= maxFiles) {
					facts.skipped++;
					return;
				}
				lineCache.set(r.rel, gitShow(opts.repoRoot, opts.baseCommit, r.rel, timeoutMs));
			}
			const v = lineCache.get(r.rel)!;
			if (!v.ok) {
				facts.missingFile.push(`${raw}（基点上取不到该文件内容）`);
				return;
			}
			facts.checkable++;
			if (viaBase) facts.heuristic++;
			const note = viaBase ? "（裸行号经同行文件名关联）" : "";
			if (from > v.lines) facts.outOfRange.push(`${raw}（基点 ${r.rel} 共 ${v.lines} 行）${note}`);
			else if (to > v.lines) facts.outOfRange.push(`${raw}（终点越界；基点 ${r.rel} 共 ${v.lines} 行）${note}`);
			else facts.ok++;
		};

		for (const c of extractCitations(text)) {
			facts.total++;
			judged(c.file, c.from, c.to, c.raw, false);
		}
		for (const b of collectBareLineRefs(text)) {
			facts.total++;
			const file = findFileForRef(b.hostLine, b.index);
			if (!file) {
				facts.unqualified++;
				continue;
			}
			judged(file, b.line, b.to, `${file} ${b.raw}`, true);
		}
		return facts;
	} catch {
		return facts; // 校验失败绝不阻断收集
	}
}

/** markdown 段（写进 cross-test-report.md）。只给计数与清单，不做判定。 */
export function renderCitationSection(all: CitationFacts[]): string[] {
	const lines: string[] = [];
	lines.push("### 行号引用越界校验（按诊断基点 commit 机械核验，零模型调用）");
	lines.push("");
	lines.push("| lane | 引用总数 | 可核验 | 通过 | **越界** | 无此文件 | 名字歧义 | lane 自产引用 | 裸行号(关联) | 裸行号(无法核验) | 跳过 |");
	lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
	for (const f of all) {
		lines.push(
			`| ${f.lane} | ${f.total} | ${f.checkable} | ${f.ok} | **${f.outOfRange.length}** | ${f.missingFile.length} | ${f.ambiguous} | ${f.laneArtifact} | ${f.heuristic} | ${f.unqualified} | ${f.skipped} |`,
		);
	}
	const bad: string[] = [];
	for (const f of all) {
		for (const x of f.outOfRange) bad.push(`- ${f.lane} **越界**：\`${x}\``);
		for (const x of f.missingFile) bad.push(`- ${f.lane} 文件不存在：\`${x}\``);
	}
	if (bad.length) {
		lines.push("");
		lines.push(...bad);
		lines.push("");
	}
	lines.push(
		"> 「通过」= 行号在行数范围内（仓内文件按**诊断基点 commit** 的行数；lane 自产文件按产物自身行数），" +
			"**不说明那一行支持该结论**；**越界为 0 也不等于引用都对**（下界判据）。" +
			"裸文件名已按基点清单解析（唯一命中才判行号；多个同名记「名字歧义」）。" +
			"裸 `line N` 靠**同一行里它前面最近的文件名**关联后核验，条目已标注「关联」——启发式，不是确证。",
	);
	lines.push("");
	return lines;
}
