/**
 * hotspot/command — /hotspot 只读诊断视图（v4 §13；计划 §E）
 *
 * 展示仓库/wsid/身份/参数、task 或 workspace 视图条目（score/kinds/lastSeen/ttl）、
 * 自动注入开关与本会话注入状态、存储概况。只读；不显示 REM/学习权重/知识分。
 * MF-2：渲染抽为可导出 buildHotspotReport（回归直测）；所有存储/外部身份来源的
 * 字符串字段（path/taskId/wsId/runId/snapshot generatedAt/会话注入标记 gate）经
 * 共享 esc（types.ts）转义——手工/旧分片的恶意 path 不可能伪造行或标签。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readdirSync } from "node:fs";
import { isSubagent } from "../identity.ts";
import { sessionHotIdentity, type HotIdentity } from "./collect.ts";
import { relTime } from "./inject.ts";
import { defaultAgentDir, findRepoRoot, readSnapshot, workspaceIdOf, wsPaths } from "./store.ts";
import { esc, hotspotEnabled, INJECT_CUSTOM_TYPE, type HotEntry } from "./types.ts";
import { buildWorkset } from "./workset.ts";

interface SessionEntryLike {
	type?: string;
	customType?: string;
	data?: { gate?: string; paths?: string[] };
}

function describeIdentity(id: HotIdentity): string {
	if (id.scope === "subagent") return "子 agent（workspace 级采集，无任务身份）";
	if (id.scope === "main") return "主会话（workspace 级，无任务身份）";
	const parts = [`tab runId=${esc(id.runId ?? "?")}`];
	if (id.taskId) parts.push(`task ${esc(id.taskId)}`);
	if (id.wsId) parts.push(`workstream ${esc(id.wsId)}`);
	return parts.join(" · ");
}

function kindsLabel(e: HotEntry): string {
	return (["write", "read", "test"] as const)
		.filter((k) => e.counts[k] > 0)
		.map((k) => `${k}×${e.counts[k]}`)
		.join(" ");
}

export interface HotspotReportDeps {
	/** 命令 cwd（内部 findRepoRoot 定根） */
	cwd: string;
	agentDir: string;
	now: number;
	identity: HotIdentity;
	/** 会话条目读取（注入标记检测；缺省空）；抛错按"会话状态不可读"处理 */
	getSessionEntries?: () => unknown[];
}

/** /hotspot 报告行（导出供回归测试）：行数只由结构决定，存储/身份字段一律 esc。 */
export function buildHotspotReport(deps: HotspotReportDeps): string[] {
	const lines: string[] = [];
	try {
		const root = findRepoRoot(deps.cwd);
		const wsid = workspaceIdOf(root);
		const p = wsPaths(deps.agentDir, wsid);
		const id = deps.identity;
		const now = deps.now;
		lines.push(`仓库: ${root}（wsid=${wsid}）`);
		lines.push(`身份: ${describeIdentity(id)}`);
		lines.push("参数: half-life 12h · soft 48h · hard 72h · 权重 write 3 / read 1 / test 2");
		lines.push("");
		const ws = buildWorkset(deps.agentDir, wsid, { now, taskId: id.taskId, wsId: id.wsId });
		const header =
			id.taskId ?? id.wsId
				? `${id.taskId ? esc(id.taskId) : `(workstream ${esc(id.wsId ?? "")})`}${ws.view === "task" ? "" : "（task 视图无命中，回退 workspace）"}`
				: "(workspace 级)";
		lines.push(header);
		if (ws.entries.length === 0) {
			lines.push("  （暂无条目——近期读/写/测试文件后自动积累）");
		}
		for (const e of ws.entries.slice(0, 20)) {
			const tested = e.lastTestAt ? ` · test ${relTime(Date.parse(e.lastTestAt), now)}` : "";
			lines.push(`  ${esc(e.path)}  ${e.score.toFixed(1)}  ${kindsLabel(e)}  ${relTime(e.lastSeenMs, now)}  ${e.ttl}${tested}`);
		}
		if (ws.entries.length > 20) lines.push(`  …其余 ${ws.entries.length - 20} 条略（hotspot lookup 可查）`);
		lines.push("");
		const enabled = hotspotEnabled();
		lines.push(`自动注入: ${enabled ? "开" : "关"}（PI_HOTSPOT_ENABLED${enabled ? " 未设，缺省开" : "=0"}）`);
		lines.push(`本会话: ${describeSessionInject(deps.getSessionEntries ?? (() => []))}`);
		let shards = 0;
		try {
			shards = readdirSync(p.eventsDir).filter((f) => f.endsWith(".jsonl")).length;
		} catch {
			/* 目录未建 */
		}
		const snap = readSnapshot(p.snapshotPath);
		lines.push(
			`存储: events/ ${shards} 分片 · snapshot ${snap ? esc(snap.generatedAt) : "缺失(可重建)"} · log ${p.logPath}`,
		);
	} catch (e) {
		lines.push(`诊断失败: ${esc(String(e))}`);
	}
	return lines;
}

function describeSessionInject(getEntries: () => unknown[]): string {
	try {
		const entries = [...getEntries()] as SessionEntryLike[];
		const mark = entries.reverse().find((e) => e.type === "custom" && e.customType === INJECT_CUSTOM_TYPE);
		if (!mark) return "未注入";
		const n = mark.data?.paths?.length;
		return `已注入(gate=${esc(mark.data?.gate ?? "?")}${n !== undefined ? `, ${n} files` : ""})`;
	} catch {
		return "未知（会话状态不可读）";
	}
}

export function registerHotspotCommand(pi: ExtensionAPI): void {
	if (isSubagent()) return;

	pi.registerCommand("hotspot", {
		description: "热点工作集诊断（只读）：近期读写文件、衰减/TTL、注入与存储状态",
		handler: async (_args, ctx) => {
			const lines = buildHotspotReport({
				cwd: ctx.cwd,
				agentDir: defaultAgentDir(),
				now: Date.now(),
				identity: sessionHotIdentity(),
				getSessionEntries: () =>
					(ctx as unknown as { sessionManager?: { getEntries?: () => unknown[] } }).sessionManager?.getEntries?.() ?? [],
			});
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
