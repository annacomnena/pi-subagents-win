/**
 * runtime/frontier-carriers.ts — 共享 carrier 归约（E2.0，MF4）。
 *
 * 从 `global-view.ts` 抽出的三个纯/准纯归约，供 GlobalView 与 Graph 两侧共用，
 * 消除「Graph 自写一份 TabDetail 计算」的双真相源（plans/0924_graph_E2_impl_plan.md §2/§3/§4）：
 *   1) `classifyDispatch`   — 可见性 / hidden 分流 + attention（原 global-view.ts 私有）
 *   2) `collectTimerByRepo` — timers pending-only 聚合成 per-repo {n,overdue}（原闭包内联）
 *   3) `reduceTabCarrier`   — 单条可见 tab 明细（原 buildTabDetail）；carrier 字段为
 *      `FrontierSourceTab` 子集，返回值保留 `TabDetail` 全字段供 global-view 渲染。
 *
 * 顺序依赖（行为保持，勿改）：v2 `collectGlobalView` 先以 `repoOverdue=0` 调
 * `reduceTabCarrier`（原 `#L586`），timers 聚合完成后再回填 `d.overdue`（原 `#L784`）；
 * Graph 侧预先算终值传入，终值等价。`readGateStatus` 留在调用点（本模块导出定义，
 * 但 `reduceTabCarrier` 只接收已算好的 `gate`，不再接收 `warnings`）。
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname as dirnameOf, join, resolve as resolveCwd } from "node:path";
import { normalizeExactPath } from "./recent-scopes.ts";
import {
	classifyTabStatus,
	composeTabStatus,
	isPersistentTabTaskId,
	probeSessionFile,
	readTabResultFile,
	readTabState,
	sessionBucketForCwd,
	type SessionProbe,
	type TabDispatchRecord,
	type TabResult,
	type TabState,
} from "../tab-runs.ts";
import { classifyForReclaim } from "../tab-runs-runtime.ts";

// ── 共享常量 / 基础工具 ────────────────────────────────────────────

/** 无进展阈值 45min（0923 phase2 裁定）：对齐 localText 既有 stale(30min) 口径上浮。 */
export const STALE_NO_PROGRESS_MS = 45 * 60 * 1000;
/** 最后 assistant 摘要截断 120 字。 */
export const SUMMARY_TRUNCATE_CHARS = 120;
/** 探活抽尾行数上限：lastStopReason/摘要只在 visible/active tab 上探。 */
export const MAX_PROBE_TAIL_LINES = 40;
/** 跨仓 `recentwork.md` 的 **`Active Tasks` 区段**读取上限（超 → 该仓 gate=unknown）。
 *  2026-10-12：语义由「整文件」改为「区段」，上限 64KB → 256KB（旧值使常见仓永久 unknown，见 readGateStatus 注）。 */
export const MAX_GATE_BYTES = 256 * 1024;

export function warn(out: string[], msg: string): void { if (out.length < 20) out.push(msg); }

export function readJson(path: string): Record<string, unknown> | null {
	try {
		const v: unknown = JSON.parse(readFileSync(path, "utf8"));
		return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
	} catch { return null; }
}

export function toMs(v: unknown): number | null {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string" && v) { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
	return null;
}

export function relText(ms: number | null, now: number): string {
	if (ms === null || ms <= 0) return "?";
	const d = now - ms;
	if (d < 0) return "0m";
	const m = Math.floor(d / 60000);
	if (m < 1) return "0m";
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 48) return `${h}h`;
	return `${Math.floor(h / 24)}d`;
}

function truncateSummary(s: string): string {
	const t = s.replace(/[\x00-\x1f\x7f]/g, "").replace(/\n/g, " ").trim();
	return t ? t.slice(0, SUMMARY_TRUNCATE_CHARS) : "-";
}

/** cwd 沿父目录向上找 .git（≤8 层，不过 profile/盘根）；无则回退 cwd 本身。 */
export function findRepoRoot(cwd: string, cache: Map<string, string>): string {
	const norm = normalizeExactPath(cwd);
	const hit = cache.get(norm);
	if (hit) return hit;
	try {
		let cur = resolveCwd(cwd);
		for (let i = 0; i < 8; i++) {
			try {
				const g = join(cur, ".git");
				if (existsSync(g)) { cache.set(norm, cur); return cur; }
			} catch { break; }
			const parent = dirnameOf(cur);
			if (parent === cur) break;
			cur = parent;
		}
	} catch { /* fall through */ }
	cache.set(norm, cwd);
	return cwd;
}

// ── 闸口状态 / 可见性分流 ──────────────────────────────────────────

/** 跨仓闸口状态：awaiting=等人工动作 | ok=表中有行但无等人工 | unknown=缺文件/区段超限/表头漂移/解析异常 */
export type GateStatus = "awaiting" | "ok" | "unknown";

/**
 * `## Active Tasks` 区段标题别名（方言并集）：英文（本仓）`## Active Tasks`；
 * 中文（GreenCAD 等）`## 待办事项 (Todo)`。
 */
const GATE_ACTIVE_HEADING = /^##\s+(?:Active Tasks|待办事项)/;
/** 索引表标题别名：`### Task Index` / `### 任务简报索引`。 */
const GATE_INDEX_HEADING = /^###\s+(?:Task Index|任务简报索引)/;
/** 索引表头列名别名（每一组**任一**命中即算该列在位）。 */
const GATE_HEADER_COLS: ReadonlyArray<readonly string[]> = [
	["item", "编号"],
	["priority", "优先级", "评级"],
	["summary", "简报", "一句话说明", "摘要"],
];
/** 状态行标记：`**Status**`（英）/ `**状态**`（中）。 */
const GATE_STATUS_LINE = /\*\*\s*(?:Status|状态)\s*\*\*/;
/** 「等人工」词（英中并集，只在区段内匹配）。 */
const GATE_AWAITING =
	/(?:waiting|awaiting|needs?-?human|等人工|需人工|待人工|待用户|待验收|待实机|待宿主|待复测|挂账)/i;

/**
 * 从 `recentwork.md` 全文切出 `## Active Tasks` 区段（纯函数，零 IO，可单测）。
 *
 * 为什么单独抽出（2026-10-31）：交接包 `hydrate.ts::buildHandoff` 原先直接取文件
 * **前 2048 字节**当 RecentWork 摘要。实测三个仓的本文件开头全是「Maintenance Rules」
 * 之类的写入端规范，真正的任务状态在 1 KB 之后：
 *   subagent-win 172,622 B → 截断后 2,048 B（1.2%），2048 内只有 **1 条**任务索引行且被劈断；
 *   battlesandbox 119,793 B → 2,047 B（1.7%），**0 条**任务索引行；
 *   GreenCAD 119,068 B → 2,047 B（1.7%），**0 条**任务索引行。
 * 即：交接包拿到的永远是「怎么维护这份文件」，而拿不到「现在做到哪」。
 * 本函数与 `readGateStatus` 共用同一套区段判据与方言别名，**消除「同一份文件两个读法」**。
 *
 * ````text
 * 返回：
 *   string  —— 区段正文（含 `## Active Tasks` 标题行，到下一个 `## ` 之前）
 *   null    —— 文件里没有该区段（调用方自行决定回退策略）
 * ```
 */
export function extractActiveTasksSection(text: string): string | null {
	const lines = text.split("\n");
	const start = lines.findIndex((l) => GATE_ACTIVE_HEADING.test(l));
	if (start < 0) return null;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (/^##\s+/.test(lines[i] ?? "")) { end = i; break; }
	}
	return lines.slice(start, end).join("\n");
}

/**
 * 把 `Active Tasks` 区段压成「**交接可用**」的前缀（纯函数，零 IO）。
 *
 * 为什么不能直接按字节截断（2026-10-31 实测）：区段**自身头部也可能很长**。
 * 首个 `### Item N` 在区段内的偏移：
 *   subagent-win 9,979 / battlesandbox 17 / GreenCAD 16,990（上限 2,048）。
 * 即 3 个仓里 2 个即使切了区段，机械截断后仍然**一条任务条目都进不去**。
 * 直接抬上限也不行：区段 52K~81K 字符，全塞进交接包会挤掉别的输入。
 *
 * 按**结构价值**取块，而非按字节顺序：
 *   ① 区段标题行（让接手者知道这是哪一节）
 *   ② `### Task Index` 表（若能放下）——一屏总览，信息密度最高
 *   ③ 逐个 `### Item N` 条目（按文件中出现顺序）直到预算用尽
 *   ④ 上面一条都放不下 ⇒ 退回普通截面（至少不是空白）
 *
 * 不完整的地方用一行 `…（还有 K 条未列入）` 如实声明，**不静默截断**。
 */
export function buildRecentWorkExcerpt(section: string, capBytes: number): string {
	const lines = section.split("\n");
	const byteLen = (s: string): number => new TextEncoder().encode(s).length;
	/** 单个条目在本预算下的取用上限（字符，非字节；留余量）。 */
	const PER_ITEM_BUDGET = 260;
	/** 从整条目里取「标题 + 至多 2 行正文」，不超 PER_ITEM_BUDGET。
	 *  设计取舍（实测）：
	 *    - 整条（不裁） → 只进 1 条（单条 1.4K~11.6K 字符）
	 *    - 标题 + 5 行 → 进 3~6 条，但每条吃 ~400 字符
	 *    - 标题 + 2 行 → 进 3~4 条，内容仍能看出「这条在干什么」
	 *  选「标题 + 至少 1 行、至多 2 行」：让每条都能看出主题，而不是只有编号。
	 *  PER_ITEM_BUDGET 是**软上限**：首行（标题）本身超长也允许（不能把标题也切了）。
	 */
	const itemHead = (block: string): string => {
		const bl = block.split("\n");
		const out: string[] = [];
		let n = 0;
		let bodyLines = 0;
		for (const ln of bl) {
			const isTitle = out.length === 0;
			if (!isTitle) {
				if (ln.trim() === "") {
					// 空行不占行数预算，但也不无限追问
					if (out.length > 0 && bodyLines === 0) { out.push(ln); continue; }
					break;
				}
				if (bodyLines >= 2) break;
				if (n + ln.length > PER_ITEM_BUDGET && bodyLines >= 1) break;
			}
			// 单行超长（无换行的巨块，如一整段长文）⇒ 硬截断该行，
			// 否则 itemHead 自身就超预算→ tryPush 永久失败→ 该条目**静默消失**。
			// 实测真实仓有 11,625 字符的单条；测试仓有 14KB 无换行单行。
			const budgetLeft = Math.max(0, PER_ITEM_BUDGET - n);
			const line = ln.length > budgetLeft && budgetLeft > 40 ? `${ln.slice(0, budgetLeft)}\u2026` : ln;
			out.push(line);
			n += line.length + 1;
			if (!isTitle) bodyLines++;
		}
		const head = out.join("\n").trimEnd();
		return out.length < bl.length ? `${head}\n  \u2026` : head;
	};
	const parts: string[] = [];
	let used = 0;
	let omitted = 0;
	/** 给末尾「未列入」声明预留的空间（**必须先扣**，否则会把预算吃满导致声明被丢，
	 *  那就是静默截断 —— 实测 subagent-win/battlesandbox 已经踩中过：2046/2048 用满 →
	 *  note 放不下 → return body（无任何声明）。 */
	const NOTE_RESERVE = 110;
	const contentCap = Math.max(0, capBytes - NOTE_RESERVE);

	const tryPush = (block: string, cap: number = contentCap): boolean => {
		const cost = byteLen(block) + 1; // +1 = 换行
		if (used + cost > cap) return false;
		parts.push(block);
		used += cost;
		return true;
	};
	/** Task Index 块的预算上限：占总预算 40%。
	 *  为什么要分账：索引行信息密度高（一屏总览），但 Summary 列很长（单行 400+ 字符）。
	 *  不分账时实测：索引会吃掉 5 行 × 200 字符 ≈ 1KB，把 Item 条目饿到只剩 1 条；
	 *  而 Item 条目才是「现在在干什么」的直接证据。40/60 分账后两者都有。 */
	const INDEX_CAP = capBytes * 0.4;

	// ① 标题行
	const heading = lines.find((l) => GATE_ACTIVE_HEADING.test(l));
	if (!heading) return truncateUtf8Fallback(section, capBytes);
	tryPush(heading);

	// 按 `### ` 切块（标题行之后的每个块 = 一个二级小节，如 Task Index / Item NN）
	const blocks: string[] = [];
	let cur: string[] = [];
	for (const line of lines) {
		if (/^###\s+/.test(line) && cur.length > 0) {
			blocks.push(cur.join("\n"));
			cur = [];
		}
		if (GATE_ACTIVE_HEADING.test(line)) continue; // 标题已单独处理
		cur.push(line);
	}
	if (cur.length > 0) blocks.push(cur.join("\n"));

	// 分类（三类块，互斥不重叠）
	const indexBlocks = blocks.filter((b) => GATE_INDEX_HEADING.test(b.split("\n")[0] ?? ""));
	const isIndex = (b: string): boolean => GATE_INDEX_HEADING.test(b.split("\n")[0] ?? "");
	const itemBlocks = blocks.filter((b) => !isIndex(b) && /^###\s+Item\s+\d+/m.test(b));
	const otherBlocks = blocks.filter((b) => !isIndex(b) && !/^###\s+Item\s+\d+/m.test(b));

	// ② Task Index 优先（信息密度最高）—— **按行裁，不整块拒**
	//    实测本仓 Task Index 块 = 9,962 字符 / 15,532 字节，整块塞不进 2KB 预算，
	//    于是整块被 `tryPush` 拒掉 ⇒ 最有用的一屏总览反而一条都进不去。
	//    改为：表头 + 分隔行务必保留，后续数据行逐行加入直到预算用尽。
	for (const b of indexBlocks) {
		const bl = b.split("\n");
		const kept: string[] = [];
		for (const ln of bl) {
			// 表格行的 Summary 列极长（实测单行 400+ 字符）⇒ 逐行裁到 ~200 字符，
			// 牺牲细节换行数：交接者需要知道「有哪几条、大致是什么」，细节可重读文件。
			const line = ln.length > 150 && /^\|/.test(ln) ? `${ln.slice(0, 150)}… |` : ln;
			if (!tryPush(line, INDEX_CAP)) { omitted += 1; break; }
			kept.push(line);
		}
		// 若数据行被截，补一行如实告知（不静默）
		if (kept.length < bl.length && kept.length > 2) {
			const total = bl.filter((l) => /^\|/.test(l)).length;
			const shown = kept.filter((l) => /^\|/.test(l)).length;
			const noteRow = `| … 共 ${total} 行，此处 ${shown} 行 |`;
			if (used + byteLen(noteRow) + 1 <= contentCap) {
				parts.push(noteRow);
				used += byteLen(noteRow) + 1;
			}
		}
	}
	// ③ Item 条目：**每条只取标题 + 前几行**（不是整条）
	//    实测单条 1.4K~11.6K 字符 —— 整条只能塞进 1 条，而交接者要的是「有哪些活」。
	//    只取首段能在同一预算下覆盖 3~8 倍多的条目数。
	for (const b of itemBlocks) {
		if (!tryPush(itemHead(b))) omitted++;
	}
	// ④ 如果一条 Item 都没进去，用其它块（如无编号的完成条目）填充，至少别返回空白
	if (itemBlocks.length > 0 && omitted === itemBlocks.length) {
		for (const b of otherBlocks) {
			if (!tryPush(b.trimEnd())) { omitted++; break; }
		}
	}

	const body = parts.join("\n");
	if (byteLen(body) === 0) return truncateUtf8Fallback(section, capBytes);
	// 如实声明被省略的块（不静默截断）。任何一条没进去都要说。
	const totalBlocks = indexBlocks.length + itemBlocks.length + otherBlocks.length;
	if (omitted > 0) {
		const note = `\n…（本区段共 ${totalBlocks} 个块，${omitted} 个因体积未列入；完整内容见文件）`;
		return byteLen(body) + byteLen(note) <= capBytes ? body + note : body;
	}
	return body;
}

/** `buildRecentWorkExcerpt` 的兑底：把区段按字节截断。
 *  与 `recent-calls.ts::truncateUtf8` **同语义**（按 UTF-8 字符边界回退，不破字）。
 *  本地实现避免 runtime 层反向依赖 tool 层（同 `wake.ts` 与 `supervision-runtime.ts` 的双写先例）。 */
function truncateUtf8Fallback(s: string, maxBytes: number): string {
	const bytes = new TextEncoder().encode(s);
	if (bytes.length <= maxBytes) return s;
	const marker = "…";
	const markerBytes = new TextEncoder().encode(marker).length;
	let end = Math.max(0, maxBytes - markerBytes);
	while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
	const body = new TextDecoder().decode(bytes.slice(0, end));
	return maxBytes - new TextEncoder().encode(body).length >= markerBytes ? body + marker : body;
}

/**
 * 只读各仓 `<repo>/recentwork.md` 的 **`## Active Tasks` 区段**（含 `### Task Index` 表与 `**Status**` 行），
 * 判定「等人工动作」证据。方言并集见上方常量——英文表头与 GreenCAD 的中文表头都能解析。
 *
 * `unknown` 情形（单仓异常由调用方记 warnings）：
 *   文件缺失 / **`Active Tasks` 区段**超 `MAX_GATE_BYTES` / 缺索引表标题 / 表头漂移 / 解析异常。
 *
 * 2026-10-12 修复（“套件瞎了一只眼”）：
 *   - 上限**只作用于 `Active Tasks` 区段**，不再作用于整文件。旧实现按整文件卡 64KB，
 *     使 recentwork 自然膨胀的仓（GreenCAD 214KB、本仓 100KB+）**永久降级 `unknown`**，
 *     于是 gate 类触发（`blocked_to_ready`、“gate=awaiting → needs_user”）**永不触发**、
 *     actions 自 10-08 起零产出。上限抬到 256KB（区段级），仅当区段病态膨胀时才降级。
 *   - 旧实现只认英文表头（`## Active Tasks` / `### Task Index` / `Item|Priority|Summary`），
 *     中文方言仓因此永久 `unknown`；现并集两种方言。
 *   - `readFileSync` 本来就是整文件读（上限不是省内存手段），故区段化**不增加**读取成本。
 */
export function readGateStatus(repoPath: string, warnings: string[]): GateStatus {
	try {
		const f = join(repoPath, "recentwork.md");
		if (!existsSync(f)) return "unknown";
		let text: string;
		try { text = readFileSync(f, "utf8"); } catch { return "unknown"; }
		// 切出 Active Tasks 区段（到下一个 `## ` 为止）；区段缺失 → unknown
		const section = extractActiveTasksSection(text);
		if (section === null) return "unknown";
		if (section.length > MAX_GATE_BYTES) {
			warn(warnings, `gate 区段超 ${Math.round(MAX_GATE_BYTES / 1024)}KB 降级 unknown: ${basename(repoPath)}`);
			return "unknown";
		}
		let sawIndex = false; let colsOk = false; let awaiting = false;
		for (const line of section.split("\n")) {
			if (GATE_INDEX_HEADING.test(line)) { sawIndex = true; continue; }
			if (GATE_STATUS_LINE.test(line) && GATE_AWAITING.test(line)) awaiting = true;
			if (sawIndex && !colsOk && line.includes("|")) {
				const h = line.toLowerCase();
				colsOk = GATE_HEADER_COLS.every((alias) => alias.some((a) => h.includes(a.toLowerCase())));
				if (!colsOk) { warn(warnings, `gate 表头漂移降级 unknown: ${basename(repoPath)}`); return "unknown"; }
			}
		}
		if (!sawIndex || !colsOk) return "unknown";
		return awaiting ? "awaiting" : "ok";
	} catch { return "unknown"; }
}

export interface TabNote { phase: string; active: boolean; attention: boolean; hiddenKind: "orphaned" | "terminal" | null; noResult: boolean; at: string }

/** 单条 dispatch 的可见性/attention 分流（visible = hiddenKind===null）。 */
export function classifyDispatch(rec: TabDispatchRecord, runsDir: string, now?: number): TabNote {
	const at = rec.dispatchedAt;
	try {
		const result = readTabResultFile(runsDir, rec.id);
		if (result) {
			const terminal = result.status === "completed" || result.status === "failed" || result.status === "cancelled";
			if (terminal) return { phase: result.status, active: false, attention: false, hiddenKind: "terminal", noResult: false, at };
			// RF-1（2026-10-18）：兜底结果（unconfirmed/autoGenerated）**不是终态，也不得隐藏**。
			// 修前此分支把任何非三态 result 硬写成 `phase:"completed" + hiddenKind:"terminal"`，
			// 等于把「tab 没回报」伪装成「完成」并从摘要里摘掉（违反 RF-1 硬约束 1）；
			// 且 `refs.runPhases` 取到的 completed 会让监管判 DONE，需人核实的信号彻底消失。
			// 唯一合法的非终态 result 形状就是兜底 unconfirmed ⇒ 可见 + 待审（attention=true），
			// 且 active=true（未确认完成 ⇒ 不得计入「可关账」，与下面 state.terminal 无 result 分支同口径）。
			return { phase: result.status, active: true, attention: true, hiddenKind: null, noResult: true, at };
		}
		const state = readTabState(runsDir, rec.id);
		if (state) {
			if (state.phase === "orphaned") return { phase: "orphaned", active: false, attention: false, hiddenKind: "orphaned", noResult: true, at: state.lastActivityAt ?? at };
			if (state.terminal) {
				// 终态但无 result → 待审（可见），绝不静默归 hidden
				return { phase: state.phase, active: true, attention: true, hiddenKind: null, noResult: true, at: state.lastActivityAt ?? at };
			}
			const att = state.phase === "attached" || state.phase === "working" || state.phase === "waiting";
			return { phase: state.phase, active: att, attention: state.phase === "working" || state.phase === "waiting" ? false : att, hiddenKind: null, noResult: true, at: state.lastActivityAt ?? at };
		}
		const st = classifyTabStatus(null, { dispatchedAt: rec.dispatchedAt, now });
		if (st.phase === "orphaned") return { phase: "orphaned", active: false, attention: false, hiddenKind: "orphaned", noResult: true, at };
		return { phase: st.phase, active: true, attention: st.phase === "unconfirmed", hiddenKind: null, noResult: true, at };
	} catch {
		return { phase: "unknown", active: false, attention: false, hiddenKind: null, noResult: true, at };
	}
}

// ── tab 明细（carrier 归约核心）────────────────────────────────────

/** carrier 子集（frontier 输入载体，plans/0924_graph_E2_impl_plan.md §3 `FrontierSourceTab`）。 */
export interface FrontierSourceTab {
	runId: string;
	repoPath: string;
	phase: string;
	/** 最后一条 assistant 消息 stopReason（`state.lastStopReason ?? probe.lastStopReason ?? "unknown"`）。
	 *  2026-10-17 监管 P0：进 carrier 才能区分「正在跑工具(toolUse) vs 真空闲(stop)」。 */
	stop: string;
	/** 距 state.lastActivityAt 的毫秒数；无 state / 无该字段 → null（**不拿 mtime 冒充**）。
	 *  监管 P0：SOFT/PUSH/USER 分档需要结构化时间基（旧 staleOver 只是 45min 布尔）。 */
	idleMs: number | null;
	needsHuman: boolean;
	gate: GateStatus;
	staleOver: boolean;
	overdue: number;
	resultMissing: boolean;
	/** state.pid + process.kill 探活（同 global-view 原 #L404-L408）；无 state.pid → null，不猜。 */
	pidAlive: boolean | null;
}

/** phase2 每 tab 明细行（纯增量列；读不到一律 unknown，绝不猜、绝不拿 mtime 冒充 lastActivityAt）。 */
export interface TabDetail extends FrontierSourceTab {
	taskId: string;
	age: string;
	stale: string;
	artifact: string;
	artifactMtime: string;
	terminal: boolean;
	openIssues: number | null;
	summary: string;
}

export interface TabCarrierInput {
	rec: TabDispatchRecord;
	/** probe 决策依赖 sessionsRoot（`!state?.lastStopReason || !state?.lastAssistantText` → probeVisibleTab）。 */
	sessionsRoot: string;
	repoPath: string;
	/** 顺序依赖：v2 先传 0（原 #L586），timers 聚合后由调用方回填（原 #L784）。 */
	repoOverdue: number;
	now: number;
	/** readGateStatus 结论由调用点算好传入（warnings 留在调用点）。 */
	gate: GateStatus;
	/** state/result 由调用点读取后传入（composeTabStatus 抛错时 phase 回退链依赖二者）。 */
	state: TabState | null;
	result: TabResult | null;
}

// ── 常驻 local master 识别（autonomy 越界修法，2026-10-19）────────

/**
 * 是否「常驻 local master / master 派发」tab（`lms-*` / `master-*`）。
 *
 * 判据本身是共享的（`tab-runs.ts::isPersistentTabTaskId`，**唯一真相源**）：
 * `lms-` 前缀的唯一产生点 = `runtime/local-master-launch.ts` `ensureTaskId(scope)`。
 * 本模块只负责把它翻成 autonomy 语义（见 `computeNeedsHuman`）。禁止在此重写前缀字面量。
 */
export function isResidentLocalMasterTab(rec: Pick<TabDispatchRecord, "taskId">): boolean {
	return isPersistentTabTaskId(rec.taskId);
}

/**
 * carrier `needsHuman` 计算（**唯一计算点**，v1 与 graph 两源共用 reduceTabCarrier）。
 *
 * ## 为什么普通 tab 用 `reclaim === "awaitingInput"`
 * `classifyForReclaim` 把 `phase==="waiting"` 归 `awaitingInput`（tab-runs-runtime.ts:547）——
 * 对**任务 tab** 这是对的：这回合跑完了、在等主会话下一步。**该函数是共享的，不得为本修复改动**
 * （`reclaim-tabs` / `tab-status` 依赖同一语义，见计划 §3.1）。
 *
 * ## 为什么常驻 tab 必须收紧（2026-10-19 越界事故）
 * local master 的**正常态就是 `waiting`（等信）**，它有自己的 per-repo scope wake（30s tick）负责唤醒，
 * **不由 autonomy 代管**（用户裁决：autonomy 只为主会话服务）。旧判据把它的「空闲」读成
 * 「用户在等人决策」⇒ `needs_user` 边沿 ⇒ 拉起 `l2-*` ⇒ 无活可干 ⇒ 又回 waiting ⇒ **无限回声**。
 *
 * 常驻 tab 的 needsHuman 收紧为：
 *   `gate === "awaiting"`  —— 仓级载体，与本收紧**正交**（仓在等人工与 tab 相位无关，不受影响）
 *   `∨ stop === "error"`  —— 本回合真报错（唯一真实可命中的分支；lms 长期 `stop=stop`/`toolUse`）
 *   `∨ pidAlive === false` —— 结构性保险。**不得声称它是主要发现手段**：`state.pid` 只在
 *      `session_start` 写一次、下一回合即被整文件替换丢掉 ⇒ 实测 3/3 lms `pidAlive=null`（计划 §5.2）。
 *
 * **不得**加入的判据（审查已核实，勿再犯）：
 *   - `phase === "waiting"`：常驻等待是常态，这正是回声源。
 *   - `resultMissing`：carriers 层语义是「无 result 文件」（tab-runs.ts `composeTabStatus` 无条件 true），
 *     而 local master 明令不调 tab-finish、兜底写入器对常驻身份豁免（`tab-runs-runtime.ts`）
 *     ⇒ 真实 lms 恒 true ⇒ 等于没改。
 *   - `idleMs` 超阈值：常驻等待数小时是常态，任何阈值都会成为新的边沿源（审查明确不建议）。
 *
 * 真「死了」的发现通道不在本判据（正交且已存在）：`local-master-ensure` 的 `owner-pid-dead`（读
 * scope-liveness 真 pid）、mailbox 积压 → `ws_mail_backlog`。**已知边界**：无周期性 lms liveness 巡检。
 */
export function computeNeedsHuman(input: {
	rec: Pick<TabDispatchRecord, "taskId">;
	/** classifyForReclaim 结论（仅普通 tab 消费）。 */
	reclaim: string;
	gate: GateStatus;
	stop: string;
	pidAlive: boolean | null;
}): boolean {
	const { rec, reclaim, gate, stop, pidAlive } = input;
	if (isResidentLocalMasterTab(rec)) {
		return gate === "awaiting" || stop === "error" || pidAlive === false;
	}
	return reclaim === "awaitingInput" || gate === "awaiting";
}

/**
 * 可见 tab 的 tail-capped 会话探活（复用 probeSessionFile；只读 bucket 内 .jsonl）。
 * 失败→null（调用方降级 unknown）。
 */
function probeVisibleTab(rec: TabDispatchRecord, sessionsRoot: string): SessionProbe | null {
	try {
		const bucket = join(sessionsRoot, sessionBucketForCwd(rec.cwd));
		if (!existsSync(bucket)) return null;
		const dispatchedMs = Date.parse(rec.dispatchedAt);
		for (const f of readdirSync(bucket)) {
			if (!f.endsWith(".jsonl")) continue;
			const full = join(bucket, f);
			let probe: SessionProbe;
			try { probe = probeSessionFile(full, rec.taskId, rec.mode, { maxTailLines: MAX_PROBE_TAIL_LINES }); }
			catch { continue; }
			if (!probe.matched) continue;
			if (!Number.isNaN(dispatchedMs)) {
				let sessionMs = probe.sessionTimestamp ? Date.parse(probe.sessionTimestamp) : NaN;
				if (Number.isNaN(sessionMs)) {
					try { sessionMs = statSync(full).mtimeMs; } catch { /* 保留候选 */ }
				}
				if (!Number.isNaN(sessionMs) && sessionMs < dispatchedMs - 60_000) continue;
			}
			return probe;
		}
		return null;
	} catch { return null; }
}

/**
 * 构建单条可见 tab 明细（原 buildTabDetail）。判态复用 composeTabStatus（result>state>probe 回退链）
 * + classifyForReclaim（awaitingInput 判定）；每列读不到→unknown，绝不猜。
 */
export function reduceTabCarrier(input: TabCarrierInput): TabDetail | null {
	const { rec, sessionsRoot, repoPath, repoOverdue, now, gate, state, result } = input;
	try {
		// 探活成本控制：只在 state 缺 stop/摘要时探（terminal 已由 hidden 分流跳过）
		let probe: SessionProbe | null = null;
		if (!state?.lastStopReason || !state?.lastAssistantText) {
			probe = probeVisibleTab(rec, sessionsRoot);
		}
		let phase: string = state?.phase ?? (result ? result.status : "unknown");
		let terminal = state?.terminal ?? !!result;
		let resultMissing = !result;
		let reclaim: string = "pending";
		try {
			const view = composeTabStatus({ runId: rec.id, dispatch: rec, state, result, probe, dispatchedAt: rec.dispatchedAt, now });
			phase = view.phase; terminal = view.terminal; resultMissing = view.resultMissing;
			reclaim = classifyForReclaim(view);
		} catch { /* 保持 state/result 直读值 */ }
		const dispMs = toMs(rec.dispatchedAt);
		const ageMs = dispMs && dispMs > 0 ? now - dispMs : null;
		// stale 只认 TabState.lastActivityAt；无 state/无该字段→unknown，绝不拿 mtime 冒充
		const actMs = toMs(state?.lastActivityAt);
		const staleMs = actMs && actMs > 0 ? now - actMs : null;
		const staleOver = staleMs !== null && staleMs > STALE_NO_PROGRESS_MS && (phase === "working" || phase === "waiting");
		const stop = state?.lastStopReason ?? probe?.lastStopReason ?? "unknown";
		let pidAlive: boolean | null = null;
		if (typeof state?.pid === "number" && Number.isFinite(state.pid)) {
			try { process.kill(state.pid, 0); pidAlive = true; } catch { pidAlive = false; }
		}
		const computedNeedsHuman = computeNeedsHuman({ rec, reclaim, gate, stop, pidAlive });
		let artifact = "-"; let artifactMtime = "?";
		const cands = result?.reportPath ? [result.reportPath] : [...(result?.artifacts ?? [])];
		const last = cands[cands.length - 1];
		if (result && last) {
			artifact = last;
			try {
				const p = existsSync(last) ? last : join(repoPath, last);
				const m = statSync(p).mtimeMs;
				artifactMtime = relText(m, now);
			} catch { artifactMtime = "missing"; }
		}
		return {
			runId: rec.id, repoPath, phase, taskId: rec.taskId || "unknown",
			age: ageMs !== null ? relText(now - ageMs, now) : "?",
			stale: staleMs !== null ? relText(now - staleMs, now) : "unknown",
			staleOver, stop, idleMs: staleMs,
			artifact, artifactMtime, resultMissing, terminal,
			openIssues: Array.isArray(result?.openIssues) ? result.openIssues.length : null,
			summary: truncateSummary(probe?.lastAssistantText ?? state?.lastAssistantText ?? result?.finalText ?? result?.summary ?? ""),
			needsHuman: computedNeedsHuman,
			gate, overdue: repoOverdue, pidAlive,
		};
	} catch { return null; }
}

// ── timers 聚合（pending-only）─────────────────────────────────────

export interface TimerByRepo {
	/** 归一化 repoPath → {n: pending 总数, overdue: due<now 数}。 */
	byRepo: Map<string, { n: number; overdue: number }>;
	/** pending 总数（含 unmapped）。 */
	pending: number;
	/** 无 repo 归属（ownerCwd 缺失/不可映射、mail run 未映射）的 pending 数。 */
	unmapped: number;
	/** 扫描异常信息（调用方记 warnings）；成功时 undefined。 */
	error?: string;
}

/**
 * timers → per-repo pending/overdue 聚合（原 collectGlobalView 闭包内联代码）。
 * pending-only；root timer 按 ownerCwd 归属、mail timer 按 runToRepo 映射；
 * `due < now` 计 overdue；无归属计 unmapped。never-throw。
 */
export function collectTimerByRepo(timersDir: string, now: number, runToRepo: ReadonlyMap<string, string>): TimerByRepo {
	const byRepo = new Map<string, { n: number; overdue: number }>();
	let pending = 0; let unmapped = 0;
	const repoCache = new Map<string, string>();
	const bump = (repoPath: string | null, dueAt: unknown): void => {
		const due = toMs(dueAt) ?? 0;
		const od = due > 0 && due < now ? 1 : 0;
		if (!repoPath) { unmapped++; return; }
		const k = normalizeExactPath(repoPath);
		const e = byRepo.get(k) ?? { n: 0, overdue: 0 };
		e.n++; e.overdue += od; byRepo.set(k, e);
	};
	try {
		if (existsSync(timersDir)) {
			for (const f of readdirSync(timersDir)) {
				if (!f.endsWith(".json") || f.endsWith(".tmp")) continue;
				const full = join(timersDir, f);
				try { if (statSync(full).isDirectory()) continue; } catch { continue; }
				const r = readJson(full);
				if (!r || r.status !== "pending") continue;
				pending++;
				const ownerCwd = typeof r.ownerCwd === "string" && r.ownerCwd ? r.ownerCwd : null;
				bump(ownerCwd ? findRepoRoot(ownerCwd, repoCache) : null, r.dueAt);
			}
			const mailRoot = join(timersDir, "mail");
			if (existsSync(mailRoot)) {
				for (const run of readdirSync(mailRoot)) {
					const dir = join(mailRoot, run);
					let files: string[] = [];
					try { files = readdirSync(dir); } catch { continue; }
					for (const f of files) {
						if (!f.endsWith(".json") || f.endsWith(".tmp")) continue;
						const r = readJson(join(dir, f));
						if (!r || r.status !== "pending") continue;
						pending++;
						const repo = runToRepo.get(run) ?? null;
						bump(repo, r.dueAt);
					}
				}
			}
		}
	} catch (e) {
		return { byRepo, pending, unmapped, error: e instanceof Error ? e.message : String(e) };
	}
	return { byRepo, pending, unmapped };
}
