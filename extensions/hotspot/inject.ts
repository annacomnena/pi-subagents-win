/**
 * hotspot/inject — 首条用户消息保守注入（v4 §9.2；计划 §D）
 *
 * 走 `input` 通道（有现成幂等双保险，沿用 v2 inject 模式）；不用 before_agent_start
 * （无内建幂等）。门控两级：task 门（taskId/wsId 精确命中 + 任务未终态 + fresh ≥2）
 * → 路径门（用户文本路径 token 精确 ∈ workspace 工作集 + top-up）。两级皆无 → 不注入
 * （新任务/身份不明/全局热 ≠ 证据）。预算内整条省略、剩 <2 放弃；单块一次/会话；
 * 先 appendCustomEntry 落档再 transform；决策全量进效果日志。
 * 不保留 v2 的 session_before_compact 压缩保留提示（返回字段与声明不符；压缩丢块可
 * 接受——lookup 工具可重取）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { isSubagent } from "../identity.ts";
import { defaultRuntimeDir } from "../runtime/journal.ts";
import { listTasks } from "../runtime/workstreams.ts";
import { sessionHotIdentity, type HotIdentity } from "./collect.ts";
import { logHotspotEvent } from "./log.ts";
import { defaultAgentDir, findRepoRoot, toRepoRelative, workspaceIdOf, wsPaths } from "./store.ts";
import { buildWorkset } from "./workset.ts";
import {
	INJECT_CHAR_BUDGET,
	INJECT_CUSTOM_TYPE,
	INJECT_MAX_FILES,
	INJECT_MIN_FILES,
	esc,
	hotspotEnabled,
	type HotEntry,
} from "./types.ts";

/** 注入拒绝原因（效果日志 reason 字段）。 */
export type InjectRejectReason =
	| "disabled"
	| "task_terminal"
	| "no_evidence"
	| "already_in_context"
	| "budget_exhausted";

export interface InjectGate {
	kind: "task" | "path";
	entries: HotEntry[];
	taskId?: string;
	wsId?: string;
}

export interface InjectDeps {
	root: string;
	agentDir: string;
	now: number;
	identity: HotIdentity;
	/** 任务终态查询（测试可注入 stub）；缺省读 runtime state */
	taskTerminal?: (taskId: string, wsId?: string) => boolean;
}

interface SessionEntryLike {
	type?: string;
	message?: { role?: string };
	customType?: string;
	data?: { gate?: string; paths?: string[] };
}

export interface InjectCtxLike {
	cwd?: string;
	sessionManager?: {
		getEntries?: () => unknown[];
		appendCustomEntry?: (customType: string, data: unknown) => void;
	};
}

export type InputVerdict = { action: "continue" } | { action: "transform"; text: string } | { action: "handled" };

function hasUserMessage(entries: SessionEntryLike[]): boolean {
	return entries.some((e) => e.type === "message" && e.message?.role === "user");
}

function hasInjectMark(entries: SessionEntryLike[]): boolean {
	return entries.some((e) => e.type === "custom" && e.customType === INJECT_CUSTOM_TYPE);
}

/** 任务终态判定（§C.3(b)）：externalTaskId 或内部 id 命中且 status ∈ {completed,cancelled,failed}。 */
export function isTaskTerminal(taskId: string, stateDir?: string): boolean {
	try {
		const dir = stateDir ?? join(defaultRuntimeDir(), "state");
		const t = listTasks(undefined, dir).find((x) => x.externalTaskId === taskId || x.id === taskId);
		return Boolean(t && (t.status === "completed" || t.status === "cancelled" || t.status === "failed"));
	} catch {
		return false;
	}
}

/** 段内再切：全角括号/标点与 ASCII 括号（中文文本常无空格紧贴路径，如 "src/a.ts（不用读）"）；不含 `.`/`,`，避免拆坏扩展名。 */
const SEGMENT_SPLIT_RE = /[\s"'`（「【《()\[\]{}<>）」】》，。；：？！·]+/;
const LEADING_TRIM_RE = /^[\s"'`,;:!?]+/;
const TRAILING_TRIM_RE = /[\s"'`.,;:!?]+$/;

/** 用户文本中的路径 token：空白切分 → 全角/括号再切 → ASCII 标点去边 → toRepoRelative 归一。 */
export function extractPathTokens(text: string, root: string): string[] {
	const out: string[] = [];
	for (const piece of text.split(/\s+/)) {
		for (const seg of piece.split(SEGMENT_SPLIT_RE)) {
			const t = seg.replace(LEADING_TRIM_RE, "").replace(TRAILING_TRIM_RE, "");
			if (!t) continue;
			const rel = toRepoRelative(t, root);
			if (rel) out.push(rel);
		}
	}
	return out;
}

/** 两级门控（纯函数；文本 + 工作集 → gate 或拒绝原因）。 */
export function planGate(deps: InjectDeps, text: string): { gate: InjectGate | null; reason: InjectRejectReason } {
	const wsid = workspaceIdOf(deps.root);
	const tid = deps.identity.taskId;
	const wid = deps.identity.wsId;
	if (tid || wid) {
		const terminal = deps.taskTerminal ?? isTaskTerminal;
		if (tid && terminal(tid, wid)) return { gate: null, reason: "task_terminal" };
		const ws = buildWorkset(deps.agentDir, wsid, { now: deps.now, taskId: tid, wsId: wid });
		const fresh = ws.entries.filter((e) => e.ttl === "fresh");
		if (fresh.length >= INJECT_MIN_FILES) {
			return {
				gate: { kind: "task", entries: fresh.slice(0, INJECT_MAX_FILES), ...(tid ? { taskId: tid } : {}), ...(wid ? { wsId: wid } : {}) },
				reason: "no_evidence",
			};
		}
	}
	// 路径门（主会话兜底，两种身份都可用）
	const full = buildWorkset(deps.agentDir, wsid, { now: deps.now });
	const tokens = new Set(extractPathTokens(text, deps.root));
	const hits = full.entries.filter((e) => e.ttl === "fresh" && tokens.has(e.path));
	if (hits.length >= 1) {
		const chosen = [...hits];
		for (const e of full.entries) {
			if (chosen.length >= INJECT_MAX_FILES) break;
			if (e.ttl === "fresh" && !chosen.includes(e)) chosen.push(e); // 同 task/近邻 top-up
		}
		return { gate: { kind: "path", entries: chosen }, reason: "no_evidence" };
	}
	return { gate: null, reason: "no_evidence" };
}

/** 相对时间（18m / 2h / 3d）。 */
export function relTime(ms: number, now: number): string {
	const s = Math.max(0, Math.round((now - ms) / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.round(m / 60);
	if (h < 48) return `${h}h`;
	return `${Math.round(h / 24)}d`;
}

function kindsLabel(e: HotEntry): string {
	return (["write", "read", "test"] as const)
		.filter((k) => e.counts[k] > 0)
		.map((k) => `${k}×${e.counts[k]}`)
		.join(" ");
}

/** 单块 <recent-working-set>：任务标识（若有）+ ≤5 行 path+lastSeen+kinds + 最近验证入口 + 免责声明。所有存储来源字段（taskId/wsId/path）经共享 esc（types.ts）转义，块内不可能出现真实闭合标签。 */
export function renderWorkingSetBlock(gate: InjectGate, now: number): string {
	const lines: string[] = ["<recent-working-set>"];
	if (gate.taskId || gate.wsId) {
		lines.push(`当前任务 ${esc(gate.taskId ?? "")}${gate.wsId ? `（workstream ${esc(gate.wsId)}）` : ""} 最近集中在：`);
	} else {
		lines.push("按你提到的路径定位的近期工作位置：");
	}
	for (const e of gate.entries) {
		lines.push(`- ${esc(e.path)} · ${kindsLabel(e)} · ${relTime(e.lastSeenMs, now)}`);
	}
	const tested = gate.entries
		.filter((e) => e.lastTestAt)
		.sort((a, b) => (Date.parse(a.lastTestAt!) < Date.parse(b.lastTestAt!) ? 1 : -1))[0];
	if (tested) lines.push(`最近验证入口: ${esc(tested.path)}（${relTime(Date.parse(tested.lastTestAt!), now)}）`);
	lines.push("以上仅表示近期工作位置，不代表当前代码仍已验证。", "</recent-working-set>");
	return lines.join("\n");
}

/** 预算选择：按 score 序逐条尝试，超预算整条省略（不截断）；剩 < INJECT_MIN_FILES → null。 */
export function selectWithinBudget(gate: InjectGate, now: number): { kept: HotEntry[]; block: string } | null {
	let kept: HotEntry[] = [];
	for (const e of gate.entries.slice(0, INJECT_MAX_FILES)) {
		const cand = [...kept, e];
		if (renderWorkingSetBlock({ ...gate, entries: cand }, now).length > INJECT_CHAR_BUDGET) continue; // 整条省略
		kept = cand;
	}
	if (kept.length < INJECT_MIN_FILES) return null;
	return { kept, block: renderWorkingSetBlock({ ...gate, entries: kept }, now) };
}

/**
 * input 事件核心（测试可直接调）。门控 + 幂等双保险 + 预算 + 落档 + 日志。
 */
export async function handleInput(
	event: { text?: string; source?: string },
	ctx: InjectCtxLike,
	deps: InjectDeps,
): Promise<InputVerdict> {
	if (event.source === "extension") return { action: "continue" };
	const text = event.text ?? "";
	if (!text.trim() || text.trimStart().startsWith("/")) return { action: "continue" };
	const p = wsPaths(deps.agentDir, workspaceIdOf(deps.root));
	const reject = (reason: InjectRejectReason): InputVerdict => {
		logHotspotEvent(p.logPath, { kind: "inject", ok: false, reason });
		return { action: "continue" };
	};
	if (!hotspotEnabled()) return reject("disabled");
	// 幂等双保险（v2 模式）：已有 user 消息（恢复会话）或已注入标记 → 不注入
	try {
		const entries = (ctx.sessionManager?.getEntries?.() ?? []) as SessionEntryLike[];
		if (hasUserMessage(entries) || hasInjectMark(entries)) return { action: "continue" };
	} catch {
		return { action: "continue" }; // 会话状态不可读时不注入（安全侧）
	}
	const { gate, reason } = planGate(deps, text);
	if (!gate) return reject(reason);
	// 工作集已在上下文（廉价启发）：用户文本已提及候选路径 ≥2 → 不注入
	const tokens = new Set(extractPathTokens(text, deps.root));
	if (gate.entries.filter((e) => tokens.has(e.path)).length >= 2) return reject("already_in_context");
	const sel = selectWithinBudget(gate, deps.now);
	if (!sel) return reject("budget_exhausted");
	try {
		ctx.sessionManager?.appendCustomEntry?.(INJECT_CUSTOM_TYPE, {
			gate: gate.kind,
			paths: sel.kept.map((e) => e.path),
			at: deps.now,
		});
	} catch {
		/* 持久标识失败时 entries 检查仍兜底（用户消息即将入档） */
	}
	logHotspotEvent(p.logPath, { kind: "inject", ok: true, gate: gate.kind, files: sel.kept.length });
	return { action: "transform", text: `${text}\n\n${sel.block}` };
}

/** 注册注入钩子（主/Tab 会话；子 agent 不注入）。 */
export function registerInject(pi: ExtensionAPI): void {
	if (isSubagent()) return;
	pi.on("input", async (event, ctx) => {
		try {
			const root = findRepoRoot((ctx as InjectCtxLike)?.cwd ?? process.cwd());
			return await handleInput(event, ctx as InjectCtxLike, {
				root,
				agentDir: defaultAgentDir(),
				now: Date.now(),
				identity: sessionHotIdentity(),
			});
		} catch {
			return { action: "continue" } as const;
		}
	});
}
