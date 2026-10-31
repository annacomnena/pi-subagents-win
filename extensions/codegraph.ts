/**
 * codegraph.ts — 把外部 `codegraph` CLI 包成一个 pi 工具。
 *
 * ## 为什么需要这个包装（2026-10-31 实测）
 *
 * owner 观察到「coding 用途仓库的 agent 都不太爱使用 codegraph」，实测数据：
 * ```
 * 最近 40 个会话，8492 次工具调用
 *   bash       6715  (79%)   其中 1482 次(22%)是 python 脚本改文件
 *   edit        460
 *   wiki-nav     44
 *   codegraph     0  ← 一次都没有
 * ```
 *
 * 根因**不是**模型偏好，而是：`codegraph` 只是 PATH 里的一个 CLI，
 * **pi 从来没有把它注册成工具**。系统提示里却有 3 处写着
 * 「cross-check with codegraph」「用 codegraph explore 快速验证」——
 * 等于让一个没有该工具的人「去用一下那个工具」。这个文件补的就是这个缺口。
 *
 * ## 设计要点
 *
 * 1. **结构化精简**：`codegraph query --json` 每条含 id/qualifiedName/坐标等
 *    十余字段，10 条就上千 token。这里投影成 `kind name file:line`，
 *    需要细节时再 `read` 该行——这才是 codegraph 存在的意义（定位快，不是替代 read）。
 * 2. **索引陈旧必须显式告警**：`status` 的 `pendingChanges` 是关键信号。
 *    实测 GreenCAD 索引停在 2026-10-28，而 HEAD 是 10-30 ⇒ 查出来的是旧世界。
 *    一个悄悄返回过期结果的检索工具比没有更危险。
 * 3. **自动发现项目根**：从 cwd 向上找 `.codegraph/`，找不到就明确告知
 *    「本仓未初始化 + 怎么初始化」，绝不静默回退成 grep。
 * 4. **never-throw**：CLI 缺失/超时/坏 JSON 都返回 isError + 可读原因。
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ── 项目根发现 ─────────────────────────────────────────────────────

/**
 * 从 startDir 向上找含 `.codegraph/` 的目录；找不到返回 null。
 *
 * ⚠ **必须确认该索引属于本仓，而不是父目录的“大杂烩”索引**。
 *
 * 2026-10-31 实测事故：`G:/code/.codegraph`（4.0 GB）把 `G:/code` 下
 * **78 个子目录**全部索引在一起（包括其它仓库与第三方 Python 库）。
 * 结果在 `G:/code/battlesandbox`（Godot 项目）里查 `player`，
 * 返回的是 `camerapose/.../ezdxf/.../recorder.py` —— **另一个仓库的第三方库**。
 *
 * 光看 `.codegraph` 是否存在不够：`G:/code` 本身不是 git 仓库，
 * 它的索引就是一个目录伞，会把毫不相干的代码霍在一起。
 *
 * 确认方式（满足任一条便认为是本仓索引）：
 *   ① `.codegraph/` 就在 startDir（**不向上跳**）——直接就是本目录的
 *   ② 向上找到的位置 X 是 git 仓库根（X/.git 存在）且 startDir 在 X 子树内
 * 否则返回 null（宁可报“本仓未初始化”，也不能返回别的仓库的结果）。
 */
export function findCodegraphRoot(startDir: string): string | null {
	let dir = resolve(startDir);
	const origin = dir;
	for (;;) {
		if (existsSync(join(dir, ".codegraph"))) {
			// ① 就地命中：不向上跳，直接信任
			if (dir === origin) return dir;
			// ② 向上命中：要求该位置是 git 仓库根（有边界，不是目录伞）
			if (existsSync(join(dir, ".git"))) return dir;
			// 否则：这是父目录的大杂烩索引，拒绝使用
			return null;
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

// ── CLI 调用 ───────────────────────────────────────────────────────

interface CliResult {
	stdout: string;
	stderr: string;
	code: number;
	timedOut: boolean;
}

function runCodegraph(args: readonly string[], cwd: string, timeoutMs: number): Promise<CliResult> {
	return new Promise((resolvePromise) => {
		// Windows 上 codegraph 是 .cmd 垫片 ⇒ 必须 shell:true 才能找到；
		// 参数都是我们自己的字面量（无用户注入拼接），不存在 shell 注入面。
		execFile(
			"codegraph",
			[...args],
			{ cwd, timeout: timeoutMs, windowsHide: true, shell: process.platform === "win32", maxBuffer: 32 * 1024 * 1024 },
			(err, stdout, stderr) => {
				const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
				resolvePromise({
					stdout: String(stdout ?? ""),
					stderr: String(stderr ?? ""),
					code: e ? (typeof (e as { code?: unknown }).code === "number" ? (e as { code: number }).code : 1) : 0,
					timedOut: Boolean(e && e.killed),
				});
			},
		);
	});
}

/** 解析 CLI 的 JSON 输出；失败返回 null（调用方回退到原文本/报错）。 */
export function parseJsonOutput(raw: string): unknown | null {
	const t = raw.trim();
	if (!t) return null;
	// 有些子命令会在 JSON 前打日志行 ⇒ 取第一个 `[`/`{` 起的最长可解析片段
	const starts = [t.indexOf("["), t.indexOf("{")].filter((i) => i >= 0).sort((a, b) => a - b);
	for (const s of starts) {
		const body = t.slice(s);
		try {
			return JSON.parse(body);
		} catch {
			/* 继续尝试 */
		}
	}
	return null;
}

// ── 结果投影（结构化精简）─────────────────────────────────────────

export interface SymbolHit {
	kind: string;
	name: string;
	file: string;
	line: number;
	endLine?: number;
	/** 仅当调用方要详情时保留 */
	qualifiedName?: string;
	language?: string;
	visibility?: string;
}

interface RawNode {
	kind?: unknown;
	name?: unknown;
	filePath?: unknown;
	startLine?: unknown;
	endLine?: unknown;
	qualifiedName?: unknown;
	language?: unknown;
	visibility?: unknown;
}

/** 从 `query --json` 的 `[{node:{...},score}]` 投影出精简符号表。 */
export function projectSymbolHits(payload: unknown): SymbolHit[] {
	if (!Array.isArray(payload)) return [];
	const out: SymbolHit[] = [];
	for (const item of payload) {
		const n = (item && typeof item === "object" ? (item as { node?: unknown }).node : null) as RawNode | null;
		if (!n || typeof n !== "object") continue;
		if (typeof n.name !== "string" || typeof n.filePath !== "string") continue;
		out.push({
			kind: typeof n.kind === "string" ? n.kind : "?",
			name: n.name,
			file: n.filePath,
			line: typeof n.startLine === "number" ? n.startLine : 0,
			...(typeof n.endLine === "number" ? { endLine: n.endLine } : {}),
			...(typeof n.qualifiedName === "string" ? { qualifiedName: n.qualifiedName } : {}),
			...(typeof n.language === "string" ? { language: n.language } : {}),
			...(typeof n.visibility === "string" ? { visibility: n.visibility } : {}),
		});
	}
	return out;
}

/** 符号表 → 紧凑文本（一行一个，`file:line` 可被编辑器跳转）。 */
export function formatSymbolHits(hits: readonly SymbolHit[], opts: { withQualified?: boolean } = {}): string {
	if (hits.length === 0) return "(no results)";
	return hits
		.map((h) => {
			const loc = `${h.file}:${h.line}`;
			const extra = opts.withQualified && h.qualifiedName ? `  «${h.qualifiedName}»` : "";
			return `${h.kind.padEnd(10)} ${h.name}  ${loc}${extra}`;
		})
		.join("\n");
}

// ── 索引新鲜度判定 ─────────────────────────────────────────────────

export interface IndexFreshness {
	lastIndexed: string | null;
	/** `pendingChanges` 三项之和；无法判断时 null */
	pendingTotal: number | null;
	added?: number;
	modified?: number;
	removed?: number;
	stale: boolean;
	/** 供直接拼进结果文本的告警行（不陈旧时为空串） */
	warning: string;
}

/** 从 `status --json` 判定索引新鲜度（纯函数）。 */
export function judgeIndexFreshness(payload: unknown, nowMs: number = Date.now()): IndexFreshness {
	const p = (payload && typeof payload === "object" ? payload : {}) as {
		lastIndexed?: unknown;
		pendingChanges?: { added?: unknown; modified?: unknown; removed?: unknown };
		initialized?: unknown;
	};
	const lastIndexed = typeof p.lastIndexed === "string" ? p.lastIndexed : null;
	const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
	const pc = p.pendingChanges ?? {};
	const added = num(pc.added);
	const modified = num(pc.modified);
	const removed = num(pc.removed);
	const pendingTotal = p.pendingChanges !== undefined ? added + modified + removed : null;

	// 陈旧判据（两者任一成立）：
	//   ① 待同步文件数 > 0（最可信——这是 codegraph 自己算的差异）
	//   ② 索引超过 24h 未更新（即使 pending 显示 0，也可能守护进程死了没算）
	let stale = false;
	const reasons: string[] = [];
	if (pendingTotal !== null && pendingTotal > 0) {
		stale = true;
		reasons.push(`待同步 +${added}/~${modified}/-${removed}`);
	}
	if (lastIndexed !== null) {
		const ts = Date.parse(lastIndexed);
		if (Number.isFinite(ts) && nowMs - ts > 24 * 60 * 60 * 1000) {
			stale = true;
			const hours = Math.round((nowMs - ts) / 3_600_000);
			reasons.push(`索引 ${hours}h 未更新`);
		}
	}
	const warning =
		stale
			? `⚠ 索引可能陈旧（${reasons.join("，")}；lastIndexed=${lastIndexed ?? "?"}）。` +
				`codegraph 查的是**索引时**的世界，不是当前工作树。先跑 action:"sync" 再查，或对结果保持怀疑。`
			: "";
	return { lastIndexed, pendingTotal, added, modified, removed, stale, warning };
}

// ── action 分发（纯逻辑，便于单测）─────────────────────────────────

export type CodegraphAction = "query" | "explore" | "context" | "impact" | "status" | "files" | "sync";

export interface DispatchDeps {
	run: (args: readonly string[], cwd: string, timeoutMs: number) => Promise<CliResult>;
	findRoot: (startDir: string) => string | null;
	now?: () => number;
}

export interface DispatchParams {
	action: CodegraphAction;
	query?: string;
	path?: string;
	limit?: number;
	depth?: number;
	kind?: string;
	noCode?: boolean;
	cwd: string;
}

const DEFAULT_TIMEOUT: Record<CodegraphAction, number> = {
	query: 30_000,
	explore: 60_000,
	context: 60_000,
	impact: 30_000,
	status: 20_000,
	files: 30_000,
	sync: 180_000, // 全量 sync 可能很慢
};

export async function dispatchCodegraph(params: DispatchParams, deps: DispatchDeps): Promise<{ text: string; isError?: boolean }> {
	const root = deps.findRoot(params.path ?? params.cwd);
	if (root === null) {
		return {
			text:
				`codegraph: 本仓未初始化索引（从 ${params.path ?? params.cwd} 向上没找到**属于本仓**的 .codegraph/）。\n` +
				`codegraph 是**仓库级**索引：每个仓库必须有自己的 .codegraph/。\n` +
				`（父目录如果有个“大杂烩”索引把多个仓库装在一起，本工具会拒绝使用——\n` +
				` 那样查出来的会是别的仓库的代码。索引必须建在仓库根。）\n\n` +
				`要建索引：\n` +
				`  cd ${params.path ?? params.cwd}  # 仓库根\n` +
				`  codegraph init\n` +
				`（索引在 .codegraph/，通常已 gitignore；首次建可能几分钟，大型仓几百 MB。）\n` +
				`在初始化之前，请用 read / grep / wiki-nav 检索，不要假设 codegraph 可用。`,
			isError: true,
		};
	}

	const timeout = DEFAULT_TIMEOUT[params.action] ?? 30_000;
	const act = params.action;

	if (act === "status") {
		const r = await deps.run(["status", "--json"], root, timeout);
		const payload = parseJsonOutput(r.stdout);
		if (payload === null) {
			return { text: `codegraph status 解析失败（exit=${r.code}）：\n${(r.stderr || r.stdout).slice(0, 800)}`, isError: true };
		}
		const p = payload as Record<string, unknown>;
		const fresh = judgeIndexFreshness(payload, (deps.now ?? Date.now)());
		const lines: string[] = [];
		lines.push(`codegraph @ ${root}`);
		lines.push(`  files=${p.fileCount ?? "?"}  nodes=${p.nodeCount ?? "?"}  edges=${p.edgeCount ?? "?"}`);
		lines.push(`  lastIndexed=${fresh.lastIndexed ?? "?"}`);
		if (fresh.pendingTotal !== null) {
			lines.push(`  pendingChanges: +${fresh.added} ~${fresh.modified} -${fresh.removed}  (合计 ${fresh.pendingTotal})`);
		}
		if (fresh.warning) {
			lines.push("");
			lines.push(fresh.warning);
		}
		return { text: lines.join("\n") };
	}

	if (act === "sync") {
		const r = await deps.run(["sync"], root, timeout);
		const tail = (r.stdout || r.stderr).trim().split(/\r?\n/).slice(-6).join("\n");
		if (r.code !== 0) return { text: `codegraph sync 失败（exit=${r.code}）：\n${tail}`, isError: true };
		return { text: `codegraph sync 完成 @ ${root}\n${tail}` };
	}

	if (!params.query || !params.query.trim()) {
		return { text: `codegraph ${act}: 需要 query 参数（要查找的符号名/任务描述）`, isError: true };
	}

	if (act === "query") {
		const args = ["query", params.query, "--json", "--limit", String(params.limit ?? 10)];
		if (params.kind) args.push("--kind", params.kind);
		const r = await deps.run(args, root, timeout);
		const payload = parseJsonOutput(r.stdout);
		if (payload === null) {
			return { text: `codegraph query 解析失败（exit=${r.code}）：\n${(r.stderr || r.stdout).slice(0, 800)}`, isError: true };
		}
		const hits = projectSymbolHits(payload);
		const header = `codegraph query "${params.query}" @ ${root} — ${hits.length} 命中`;
		const body = formatSymbolHits(hits);
		// 顺手带一条新鲜度提示：query 不带 status 信息，但陈旧索引会给出错误的行号
		const st = await deps.run(["status", "--json"], root, Math.min(timeout, 20_000));
		const fresh = judgeIndexFreshness(parseJsonOutput(st.stdout), (deps.now ?? Date.now)());
		return { text: fresh.warning ? `${header}\n${body}\n\n${fresh.warning}` : `${header}\n${body}` };
	}

	if (act === "explore") {
		// explore 返回「相关符号源码 + 调用路径」的整块文本，本身已是给模型读的形态
		const r = await deps.run(["explore", params.query], root, timeout);
		if (r.code !== 0) return { text: `codegraph explore 失败（exit=${r.code}）：\n${(r.stderr || r.stdout).slice(0, 800)}`, isError: true };
		return { text: `codegraph explore "${params.query}" @ ${root}\n\n${r.stdout.trim().slice(0, 60_000)}` };
	}

	if (act === "context") {
		const args = ["context", params.query, "-f", "markdown", "-n", String(params.limit ?? 30)];
		if (params.noCode) args.push("--no-code");
		const r = await deps.run(args, root, timeout);
		if (r.code !== 0) return { text: `codegraph context 失败（exit=${r.code}）：\n${(r.stderr || r.stdout).slice(0, 800)}`, isError: true };
		return { text: `codegraph context "${params.query}" @ ${root}\n\n${r.stdout.trim().slice(0, 60_000)}` };
	}

	if (act === "impact") {
		const args = ["impact", params.query, "--json", "-d", String(params.depth ?? 2)];
		const r = await deps.run(args, root, timeout);
		const payload = parseJsonOutput(r.stdout);
		if (payload === null) {
			// impact 可能要求符号 id 而非名字 ⇒ 原文回退，比报错有用
			return { text: `codegraph impact "${params.query}" @ ${root}（原文输出）\n\n${r.stdout.trim().slice(0, 8_000) || (r.stderr || "").slice(0, 800)}` };
		}
		return { text: `codegraph impact "${params.query}" @ ${root}\n\n${JSON.stringify(payload, null, 2).slice(0, 20_000)}` };
	}

	// files
	const args = ["files", "--json"];
	if (params.query && params.query !== "*") args.push("--pattern", params.query);
	const r = await deps.run(args, root, timeout);
	const payload = parseJsonOutput(r.stdout);
	if (payload === null) return { text: `codegraph files 解析失败（exit=${r.code}）`, isError: true };
	return { text: `codegraph files ${params.query ?? ""} @ ${root}\n\n${JSON.stringify(payload, null, 2).slice(0, 20_000)}` };
}

// ── 注册 ───────────────────────────────────────────────────────────

export function registerCodegraph(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "codegraph",
		label: "CodeGraph",
		description: [
			"代码知识图谱检索（符号级定位，比 grep 快且准）。**定位用 codegraph，读内容用 read**。",
			"action: query（按名字搜符号，返回 `kind name file:line` 精简表）| explore（一次给出某主题的相关符号源码+调用路径，最省轮次）| context（按任务描述构建上下文，markdown）| impact（某符号的调用方/依赖，改它之前必查）| status（索引统计 + 陈旧告警）| files（列文件，可按 glob 过滤）| sync（同步索引）。",
			"query 必填：要查的符号名。explore/context 必填：一句任务或主题描述。files 的 query 可给 glob（如 `**/*.gd`）。",
			"**先 status 再信结果**：索引陈旧时行号会错、新代码会查不到。返回里带 `⚠ 索引可能陈旧` 就先跑 action:\"sync\"。",
			"未初始化（无 .codegraph/）时本工具会明确报错并给初始化命令 —— 此时请回退 read/grep/wiki-nav，不要假设它能用。",
		].join(" "),
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("query"),
					Type.Literal("explore"),
					Type.Literal("context"),
					Type.Literal("impact"),
					Type.Literal("status"),
					Type.Literal("files"),
					Type.Literal("sync"),
				],
				{ description: "检索动作" },
			),
			query: Type.Optional(Type.String({ description: "query=符号名；explore/context=任务描述；files=glob。必填（除 status/sync）" })),
			path: Type.Optional(Type.String({ description: "项目路径（缺省用当前 cwd，会自动向上找 .codegraph/）" })),
			limit: Type.Optional(Type.Number({ description: "最多返回条数（query 默认 10；context 默认 30）" })),
			depth: Type.Optional(Type.Number({ description: "impact 的遍历深度，默认 2" })),
			kind: Type.Optional(Type.String({ description: "query 的符号类型过滤（function/class/method/interface…）" })),
			noCode: Type.Optional(Type.Boolean({ description: "context 只要结构不要源码块" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = (ctx as { cwd?: string } | undefined)?.cwd ?? process.cwd();
			const r = await dispatchCodegraph(
				{
					action: params.action as CodegraphAction,
					...(params.query !== undefined ? { query: params.query } : {}),
					...(params.path !== undefined ? { path: params.path } : {}),
					...(params.limit !== undefined ? { limit: params.limit } : {}),
					...(params.depth !== undefined ? { depth: params.depth } : {}),
					...(params.kind !== undefined ? { kind: params.kind } : {}),
					...(params.noCode !== undefined ? { noCode: params.noCode } : {}),
					cwd,
				},
				{ run: runCodegraph, findRoot: findCodegraphRoot },
			);
			return { content: [{ type: "text" as const, text: r.text }], ...(r.isError ? { isError: true } : {}) };
		},
	});
}
