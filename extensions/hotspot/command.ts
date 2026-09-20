/**
 * hotspot/command — /hotspot 诊断命令（只读，不静默修改数据）
 *
 * v2 §9：展示仓库/热点文件、磁盘版本与本会话已注入版本、工作集与预算估算、
 * 被省略主题、引用验证状态与降级原因。含评分依据（OpenClaw 先例启示：
 * 透明度包含评分标准而非仅输出）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isSubagent } from "../identity.ts";
import { computeHeat } from "./heat.ts";
import { logPath } from "./log.ts";
import { findRepoRoot, hotspotPath, readHotspot } from "./store.ts";
import { INJECT_CUSTOM_TYPE } from "./types.ts";
import { planInjection } from "./inject.ts";

interface SessionEntryLike {
	type?: string;
	customType?: string;
	data?: { revision?: number };
}

export function registerHotspotCommand(pi: ExtensionAPI): void {
	if (isSubagent()) return;

	pi.registerCommand("hotspot", {
		description: "热点路由缓存诊断（只读）：版本、注入状态、热度排序与预算",
		handler: async (_args, ctx) => {
			const root = findRepoRoot(ctx.cwd);
			const path = hotspotPath(root);
			const lines: string[] = [];

			lines.push(`仓库: ${root}`);
			lines.push(`热点文件: ${path}`);

			const read = readHotspot(path);
			if (!read.exists) {
				lines.push("状态: 文件不存在（不注入；首次 upsert 时创建）");
				lines.push(`效果日志: ${logPath(root)}`);
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}
			if (read.parseError || !read.file) {
				lines.push(`状态: 无法解析（自动写入已停止，保留内容待人工修复）`);
				lines.push(`错误: ${read.parseError}`);
				ctx.ui.notify(lines.join("\n"), "error");
				return;
			}
			const file = read.file;

			let injectedRev: number | null = null;
			try {
				const entries = ctx.sessionManager.getEntries() as SessionEntryLike[];
				const mark = [...entries].reverse().find((e) => e.type === "custom" && e.customType === INJECT_CUSTOM_TYPE);
				injectedRev = mark?.data?.revision ?? null;
			} catch {
				/* ignore */
			}
			lines.push(`磁盘 revision: ${file.revision}`);
			lines.push(`本会话已注入版本: ${injectedRev === null ? "未注入" : String(injectedRev)}${injectedRev !== null && injectedRev !== file.revision ? "（落后于磁盘，可用 hotspot read 重读）" : ""}`);

			const plan = planInjection(root, file.entries);
			lines.push("");
			lines.push(`注入预算: ${plan.usedChars}/${plan.budgetChars} 字符（token 估算 = 字符÷3.5 ≈ ${Math.round(plan.usedChars / 3.5)}）`);
			lines.push("工作集（热度排序）:");
			const scoreById = new Map(computeHeat(root, file.entries).scored.map((s) => [s.entry.topicId, s]));
			for (const e of file.entries) {
				const s = scoreById.get(e.topicId);
				const omitted = plan.omitted.some((o) => o.topicId === e.topicId) ? " [预算内省略]" : "";
				lines.push(`- ${e.topicId}（${s?.score ?? 0} 分: ${(s?.reasons ?? []).join("、") || "无信号"}）${omitted}`);
				lines.push(`    验证: ${e.verifiedAt}`);
			}
			if (plan.degraded.length) {
				lines.push("");
				lines.push("降级原因:");
				for (const d of plan.degraded) lines.push(`- ${d}`);
			}
			lines.push("");
			lines.push(`效果日志: ${logPath(root)}`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
