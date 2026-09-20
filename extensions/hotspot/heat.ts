/**
 * hotspot/heat — 热度信号（仅排序用，不落盘、用完即弃）+ 最近活动摘要
 *
 * v2 §8.1：三类状态分开——当前热度决定注入优先级；最近引用验证时间决定指针重验；
 * 验收状态由源证据文件维护。热度从 recentwork 活跃条目、近期 git churn、
 * 未提交工作树 diff 计算（工作树是"正在进行、恰恰最热"的信号——git log 看不到它），
 * 解析失败降级并在诊断中说明，不强行归类。
 * v2 §8.2 修订（2026-09-17）：注入头附带"最近任务/最近改动"两行——纯现算派生数据，
 * 零存储零腐烂；不复制任务状态（权威源仍是 recentwork）。
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HotspotEntry } from "./types.ts";

export interface HeatScore {
	entry: HotspotEntry;
	score: number;
	reasons: string[];
}

export interface HeatResult {
	scored: HeatScore[]; // score 降序，同分按 updatedAt 降序
	degraded: string[]; // 降级原因（诊断展示）
}

function runGit(root: string, args: string[], timeoutMs = 8_000, maxBuffer = 8 * 1024 * 1024): string | null {
	try {
		return execFileSync("git", ["-C", root, ...args], {
			timeout: timeoutMs,
			encoding: "utf8",
			windowsHide: true,
			maxBuffer,
			stdio: ["ignore", "pipe", "ignore"],
		}) as string;
	} catch {
		return null;
	}
}

function pathSetFrom(out: string): Set<string> {
	const set = new Set<string>();
	for (const line of out.split(/\r?\n/)) {
		const t = line.trim();
		if (t) set.add(t.replace(/\\/g, "/"));
	}
	return set;
}

/** 近 14 天 git churn 文件集（posix 相对路径）；git 不可用 → null。 */
export function gitChurnFiles(root: string): Set<string> | null {
	const out = runGit(root, ["log", "--since=14 days ago", "--name-only", "--pretty=format:"], 8_000, 4 * 1024 * 1024);
	return out === null ? null : pathSetFrom(out);
}

/** 未提交工作树/暂存区改动文件集（git diff HEAD）；非 git 或失败 → null。 */
export function workingTreeFiles(root: string): Set<string> | null {
	const out = runGit(root, ["diff", "HEAD", "--name-only"]);
	return out === null ? null : pathSetFrom(out);
}

/** recentwork 活跃行（表格行且状态列非完成）；文件缺失/无活跃行 → 空数组。 */
export function recentworkActiveLines(root: string): { id: string; text: string }[] {
	try {
		const raw = readFileSync(join(root, "recentwork.md"), "utf8");
		const out: { id: string; text: string }[] = [];
		for (const line of raw.split(/\r?\n/)) {
			const t = line.trim();
			if (!t.startsWith("|")) continue;
			// 活跃 = 状态 emoji 尚未 ✅（🔧 进行/待复测、📋 待办、⚠️ 有问题）
			if (!/(🔧|📋|⚠️)/.test(t)) continue;
			const cells = t.split("|").map((c) => c.trim());
			const id = cells[1] ?? "";
			if (/^\d+$/.test(id)) out.push({ id, text: t });
		}
		return out;
	} catch {
		return [];
	}
}

function dirPrefixes(p: string): string[] {
	const parts = p.split("/");
	const out: string[] = [];
	for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/") + "/");
	return out;
}

function titleTerms(title: string, scope?: string): string[] {
	return (title + " " + (scope ?? ""))
		.split(/[\s，。、·（）()/|:：;；,]+/u)
		.map((t) => t.trim())
		.filter((t) => [...t].length >= 2);
}

/** 热度打分与排序。工作树命中 ×5 / 目录 ×2（正在改最热）；churn 命中 ×3 / 目录 ×1；标题词命中活跃 Item 行 ×2。 */
export function computeHeat(root: string, entries: HotspotEntry[]): HeatResult {
	const degraded: string[] = [];
	const churn = gitChurnFiles(root);
	if (!churn) degraded.push("git churn 不可用（非 git 仓库或 git 失败）");
	const wt = workingTreeFiles(root);
	if (!wt) degraded.push("工作树 diff 不可用（非 git 仓库或 git 失败）");
	const active = recentworkActiveLines(root);
	if (active.length === 0) degraded.push("recentwork 无活跃行（文件缺失或无 🔧/📋/⚠️ 条目）");

	const scored = entries.map((entry) => {
		let score = 0;
		const reasons: string[] = [];
		const paths = [...entry.wiki, ...entry.evidence].map((r) => r.path).concat(entry.symbols.map((s) => s.path));
		let wtHit = 0;
		let churnHit = 0;
		let wtDir = 0;
		let churnDir = 0;
		for (const p of paths) {
			if (wt?.has(p)) wtHit++;
			else if (churn?.has(p)) churnHit++;
			else {
				const pres = dirPrefixes(p);
				if (wt && pres.some((pre) => [...wt].some((c) => c.startsWith(pre)))) wtDir++;
				else if (churn && pres.some((pre) => [...churn].some((c) => c.startsWith(pre)))) churnDir++;
			}
		}
		if (wtHit > 0) {
			score += wtHit * 5;
			reasons.push(`工作树命中×${wtHit}`);
		}
		if (churnHit > 0) {
			score += churnHit * 3;
			reasons.push(`churn 命中×${churnHit}`);
		}
		if (wtDir > 0) {
			score += wtDir * 2;
			reasons.push(`工作树目录命中×${wtDir}`);
		}
		if (churnDir > 0) {
			score += churnDir;
			reasons.push(`churn 目录命中×${churnDir}`);
		}
		const terms = titleTerms(entry.title, entry.scope);
		if (terms.length > 0 && active.length > 0) {
			const hits = active.filter((a) => terms.some((t) => a.text.includes(t))).length;
			if (hits > 0) {
				score += Math.min(hits, 2) * 2;
				reasons.push(`recentwork 活跃行命中×${hits}`);
			}
		}
		if (score === 0) reasons.push("仅按内容更新时间排序");
		return { entry, score, reasons };
	});

	scored.sort((a, b) => b.score - a.score || (b.entry.updatedAt < a.entry.updatedAt ? -1 : 1));
	if (scored.every((s) => s.score === 0)) degraded.push("全部主题热度为 0，按 updatedAt 排序");
	return { scored, degraded };
}

// ── 最近活动摘要（注入头"最近任务/最近改动"，纯现算零存储）──────────────

export interface RecentActivity {
	tasks: string[]; // 每项 "<id> <摘要截断40字>"
	funcs: string[]; // 每项 "<函数上下文> ×<次数>"，或降级的文件路径
	degraded: string[];
}

/** 从 diff 文本提取 hunk 函数上下文并计数；过滤 namespace/using 噪声（git 默认 xfunc 对 C# 的缺陷，
 *  配置 funcname 后该方法签名自然取代 namespace）。 */
export function extractFuncContexts(diffText: string): Map<string, number> {
	const counts = new Map<string, number>();
	for (const line of diffText.split(/\r?\n/)) {
		if (!line.startsWith("@@ ")) continue;
		const idx = line.indexOf("@@", 3);
		if (idx < 0) continue;
		let ctx = line.slice(idx + 2).trim();
		if (!ctx) continue;
		if (/^(namespace|using)\b/.test(ctx)) continue;
		ctx = ctx.replace(/\s*\{?\s*$/, "").trim();
		if (ctx.length === 0) continue;
		if (ctx.length > 60) ctx = ctx.slice(0, 60) + "…";
		counts.set(ctx, (counts.get(ctx) ?? 0) + 1);
	}
	return counts;
}

/** 最近活动摘要：活跃任务 top3（recentwork 摘要列）+ 最近修改函数 top5
 *  （未提交 diff HEAD + 近 30 条 commit 的 hunk 上下文聚合）。函数级为空时降级文件级。 */
export function recentActivitySummary(root: string): RecentActivity {
	const degraded: string[] = [];
	const active = recentworkActiveLines(root);
	// Item 编号单调递增（greencad 约定）→ 按编号降序取最新活跃行，而非文件顺序的前 3 行
	const latest = [...active].sort((a, b) => Number(b.id) - Number(a.id));
	const tasks = latest.slice(0, 3).map((a) => {
		const cells = a.text.split("|").map((c) => c.trim());
		const desc = (cells[3] ?? "").replace(/\s+/g, " ");
		return `${a.id} ${desc.length > 40 ? desc.slice(0, 40) + "…" : desc}`;
	});

	const counts = new Map<string, number>();
	for (const args of [
		["diff", "HEAD", "--unified=0"],
		["log", "--since=14 days ago", "-n", "30", "-p", "--unified=0"],
	] as const) {
		const out = runGit(root, [...args, "--", "*.cs"], 15_000, 32 * 1024 * 1024);
		if (out) for (const [k, v] of extractFuncContexts(out)) counts.set(k, (counts.get(k) ?? 0) + v);
	}
	let funcs = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} ×${v}`);
	if (funcs.length === 0) {
		const wt = workingTreeFiles(root);
		const files = wt ? [...wt].filter((p) => p.endsWith(".cs")) : [];
		if (files.length > 0) {
			funcs = files.slice(0, 5);
			degraded.push("函数上下文为空，降级文件级（C# funcname 未配置时 git 默认抓 namespace）");
		} else {
			degraded.push("无未提交 .cs 改动且无函数上下文");
		}
	}
	return { tasks, funcs, degraded };
}
