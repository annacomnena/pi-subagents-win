/**
 * hotspot/tool — hotspot 工具 = 仅 lookup 查询（v4 §9.1；计划 §A）
 *
 * 只读：查本仓库短期热点工作集（task/workstream 视图 + limit）。主/Tab/子 agent
 * 全注册（只读无害）。旧 v2 的 read/upsert/remove（写 Wiki/_hotspot.md）已随 v2 退役。
 * MF-2：结果渲染抽为可导出 renderLookupText（回归直测）；存储来源字段（path/taskId）
 * 经共享 esc（types.ts）转义——手工/旧分片的恶意值不可能伪造结果行或标签。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { sessionHotIdentity } from "./collect.ts";
import { relTime } from "./inject.ts";
import { logHotspotEvent } from "./log.ts";
import { defaultAgentDir, findRepoRoot, workspaceIdOf, wsPaths } from "./store.ts";
import { esc } from "./types.ts";
import { LOOKUP_DEFAULT_LIMIT, LOOKUP_MAX_LIMIT, lookupWorkset, type LookupResult } from "./workset.ts";

function text(s: string): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
	return { content: [{ type: "text", text: s }], details: {} };
}

/** lookup 结果文本（导出供回归测试）：行数只由结构决定，存储字段一律 esc。 */
export function renderLookupText(res: LookupResult, now: number): string {
	if (res.entries.length === 0) {
		return (
			`热点工作集为空（视图: ${res.view}${res.fellBack ? "，task 无命中已回退 workspace" : ""}）。\n` +
			"近期读/写/测试文件后会自动积累；条目 48h 转 soft、72h 过期。"
		);
	}
	const lines = [`视图: ${res.view}${res.fellBack ? "（task 无命中，回退 workspace）" : ""} · 条数: ${res.entries.length}/${res.limit}`];
	for (const e of res.entries) {
		const counts = (["write", "read", "test"] as const)
			.filter((k) => e.counts[k] > 0)
			.map((k) => `${k}×${e.counts[k]}`)
			.join(" ");
		const extra = [
			e.taskId ? `task ${esc(e.taskId)}` : "",
			e.lastTestAt ? `test ${relTime(Date.parse(e.lastTestAt), now)}` : "",
		]
			.filter(Boolean)
			.join("  ");
		lines.push(`${esc(e.path)}  score ${e.score.toFixed(1)}  ${counts}  ${relTime(e.lastSeenMs, now)}  ${e.ttl}${extra ? `  ${extra}` : ""}`);
	}
	lines.push("", "以上仅表示近期工作位置（half-life 12h / soft 48h / hard 72h），不代表当前代码仍已验证。");
	return lines.join("\n");
}

export function registerHotspotTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "hotspot",
		label: "Hotspot",
		description:
			"查询本仓库的短期热点工作集（最近读/写/测试过的文件，带 12h 半衰与 48h/72h TTL）。" +
			"只读 lookup，不写入任何数据；结果是近期工作位置的投影，不是长期知识。",
		parameters: Type.Object({
			task_id: Type.Optional(Type.String({ description: "按任务过滤（externalTaskId，如 0924_xxx；缺省用当前会话身份）" })),
			workstream_id: Type.Optional(Type.String({ description: "按 workstream 过滤（缺省用当前会话身份）" })),
			limit: Type.Optional(
				Type.Number({ description: `返回条数上限（默认 ${LOOKUP_DEFAULT_LIMIT}，最大 ${LOOKUP_MAX_LIMIT}）`, minimum: 1, maximum: LOOKUP_MAX_LIMIT }),
			),
		}),
		promptSnippet: "Look up the repo ephemeral working set (recently read/written/tested files)",
		promptGuidelines: [
			"Use hotspot to recall which files were recently read/written/tested for the current task or workspace; it is a short-lived projection (48-72h TTL), not long-term knowledge.",
		],
		async execute(_toolCallId, params) {
			try {
				const root = findRepoRoot(process.cwd());
				const agentDir = defaultAgentDir();
				const wsid = workspaceIdOf(root);
				const now = Date.now();
				// 显式参数优先；缺省用当前会话身份（主会话/子 agent → workspace 视图）
				let taskId: string | undefined;
				let wsId: string | undefined;
				if (params.task_id || params.workstream_id) {
					taskId = params.task_id;
					wsId = params.workstream_id;
				} else {
					const id = sessionHotIdentity();
					taskId = id.taskId;
					wsId = id.wsId;
				}
				const res = lookupWorkset(agentDir, wsid, { now, taskId, wsId, limit: params.limit });
				const p = wsPaths(agentDir, wsid);
				logHotspotEvent(p.logPath, {
					kind: "lookup",
					ok: true,
					view: res.view,
					limit: res.limit,
					...(res.fellBack ? { reason: "task_view_empty_fallback_workspace" } : {}),
				});
				return text(renderLookupText(res, now));
			} catch (e) {
				return text(`✗ hotspot lookup 失败: ${esc(String(e))}`);
			}
		},
	});
}
