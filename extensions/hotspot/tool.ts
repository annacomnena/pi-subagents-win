/**
 * hotspot/tool — hotspot 工具（read / upsert / remove）
 *
 * v2 §6：工具是热点的唯一写入通道；upsert 完整替换一个主题、相同内容不写入不增版；
 * remove 显式操作、保留恢复副本；写入经结构校验+引用验证+存储预算+乐观锁六步。
 * 首版由主会话统一提交（子代理进程不注册本工具，候选在回复文本中返回）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isSubagent } from "../identity.ts";
import { findRepoRoot, hotspotPath, readHotspot, commitHotspot, appendTrash } from "./store.ts";
import {
	checkStoreBudget,
	sameRoutingContent,
	validateEntryShape,
	verifyReferences,
	type EntryValidation,
} from "./validate.ts";
import { ENTRY_LIMITS, nowIso, SCHEMA_VERSION, type HotspotEntry, type HotspotFile } from "./types.ts";
import { logEvent } from "./log.ts";

const RefSchema = Type.Object({
	path: Type.String({ description: "仓库相对路径（正斜杠）" }),
	section: Type.Optional(Type.String({ description: "章节标题（可空）" })),
});

const EntrySchema = Type.Object({
	title: Type.String({ description: "主题短标题" }),
	scope: Type.Optional(Type.String({ description: "适用范围一句话" })),
	wiki: Type.Array(RefSchema, { description: "Wiki 章节切片", maxItems: ENTRY_LIMITS.refs }),
	symbols: Type.Array(
		Type.Object({ path: Type.String(), name: Type.String({ description: "符号名（CodeGraph 可解析）" }) }),
		{ description: "符号入口", maxItems: ENTRY_LIMITS.refs },
	),
	evidence: Type.Array(RefSchema, { description: "临时发现/验收证据指针", maxItems: ENTRY_LIMITS.refs }),
});

function text(s: string): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
	return { content: [{ type: "text", text: s }], details: {} };
}

function ok(s: string): ReturnType<typeof text> {
	return text(s);
}

function err(s: string): ReturnType<typeof text> {
	return text(`✗ ${s}`);
}

function fmtValidation(v: EntryValidation): string {
	const parts: string[] = [];
	if (v.problems.length) parts.push(`问题:\n${v.problems.map((p) => `- [${p.field}] ${p.message}`).join("\n")}`);
	if (!v.symbolVerified) parts.push("符号未验证");
	if (v.notes.length) parts.push(v.notes.join("；"));
	return parts.join("\n") || "引用全部通过";
}

function entryFromInput(topicId: string, e: {
	title: string;
	scope?: string;
	wiki: Array<{ path: string; section?: string }>;
	symbols: Array<{ path: string; name: string }>;
	evidence: Array<{ path: string; section?: string }>;
}): HotspotEntry {
	return {
		topicId,
		title: e.title.trim(),
		scope: e.scope?.trim() || undefined,
		wiki: e.wiki ?? [],
		symbols: e.symbols ?? [],
		evidence: e.evidence ?? [],
		updatedAt: nowIso(),
		verifiedAt: nowIso(),
	};
}

function describeEntry(e: HotspotEntry, v?: EntryValidation): string {
	const lines = [`## ${e.topicId} — ${e.title}${e.scope ? `（${e.scope}）` : ""}`];
	for (const w of e.wiki) lines.push(`- Wiki: ${w.path}${w.section ? ` → ${w.section}` : ""}`);
	for (const s of e.symbols) lines.push(`- 入口: ${s.path}::${s.name}`);
	for (const ev of e.evidence) lines.push(`- 证据: ${ev.path}${ev.section ? ` → ${ev.section}` : ""}`);
	lines.push(`- 内容更新: ${e.updatedAt}；引用验证: ${e.verifiedAt}`);
	if (v) {
		lines.push(`- 符号验证: ${v.symbolVerified ? "是" : v.codegraphAttempted ? "否" : "未尝试（无符号）"}${v.notes.length ? `（${v.notes.join("；")}）` : ""}`);
	}
	return lines.join("\n");
}

export function registerHotspotTool(pi: ExtensionAPI): void {
	if (isSubagent()) return; // 首版：子代理不注册（候选经回复返回，主会话统一提交）

	pi.registerTool({
		name: "hotspot",
		label: "Hotspot",
		description:
			"读写本仓库的热点路由缓存（Wiki/_hotspot.md）。read 查看主题/版本/验证状态；" +
			"upsert 保存或更新一个主题的路由指针（完整替换该主题，需先 read 取当前 revision）；" +
			"remove 显式删除一个主题（保留恢复副本）。热点只存路由指针（Wiki 章节切片、符号入口、证据指针），不存解释性知识。",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("read"), Type.Literal("upsert"), Type.Literal("remove")], {
				description: "read | upsert | remove",
			}),
			topic_id: Type.Optional(Type.String({ description: "主题 ID（read/remove 必填；upsert 必填）" })),
			expected_revision: Type.Optional(Type.Number({ description: "upsert/remove 必填：read 时看到的 revision（乐观锁）；新建文件传 0" })),
			entry: Type.Optional(EntrySchema),
			reason: Type.Optional(Type.String({ description: "remove 原因（记入恢复副本）" })),
		}),
		promptSnippet: "Read or update the repo hotspot routing cache (Wiki/_hotspot.md)",
		promptGuidelines: [
			"Use hotspot when you verified a routing change for an active topic (new entry point, moved symbol, stale pointer) or need to locate recently-active modules; upsert only routing pointers, never explanatory knowledge.",
		],
		async execute(_toolCallId, params) {
			const cwd = process.cwd();
			const root = findRepoRoot(cwd);
			const path = hotspotPath(root);
			const read = readHotspot(path);
			if (read.exists && read.parseError) {
				return err(`热点文件无法解析，自动写入已停止（保留内容待人工修复）:\n${read.parseError}`);
			}

			if (params.action === "read") {
				if (!read.exists || !read.file) {
					return ok(`热点文件不存在：${path}\n首次 upsert 时会创建（expected_revision=0）。`);
				}
				const file = read.file;
				const wanted = params.topic_id;
				const list = wanted ? file.entries.filter((e) => e.topicId === wanted) : file.entries;
				if (wanted && list.length === 0) {
					return err(`主题不存在: ${wanted}（现有: ${file.entries.map((e) => e.topicId).join(", ") || "无"}）`);
				}
				// read 做轻量验证（文件/章节；CodeGraph 符号验证较慢，仅在单主题 read 时执行）
				const withValidation = wanted ? await Promise.resolve(list.map((e) => verifyReferences(e, root))) : [];
				const body = list
					.map((e, i) => describeEntry(e, withValidation[i]))
					.join("\n\n");
				logEvent(root, { kind: "tool", action: "read", topic: wanted ?? null, revision: file.revision, ok: true });
				return ok(
					`仓库：${root}\n热点文件：${path}\nrevision：${file.revision}\n主题数：${file.entries.length}\n\n${body}\n\n` +
						(wanted ? "" : "提示：单主题 read 会附带引用验证（含 CodeGraph 符号检查）。"),
				);
			}

			if (params.action === "upsert") {
				if (!params.topic_id || !params.entry || params.expected_revision === undefined) {
					return err("upsert 需要 topic_id、expected_revision、entry 三者齐备");
				}
				const entry = entryFromInput(params.topic_id, params.entry);
				const shapeProblems = validateEntryShape(entry, root);
				if (shapeProblems.length) {
					return err(`结构校验失败:\n${shapeProblems.map((p) => `- [${p.field}] ${p.message}`).join("\n")}`);
				}
				if (read.exists && read.file && read.file.entries.length >= ENTRY_LIMITS.topics && !read.file.entries.some((e) => e.topicId === entry.topicId)) {
					return err(`主题数已达上限 ${ENTRY_LIMITS.topics}；请先 remove 冷却主题`);
				}
				const validation = verifyReferences(entry, root);
				if (validation.problems.length) {
					logEvent(root, { kind: "tool", action: "upsert", topic: entry.topicId, ok: false, reason: "validation" });
					return err(`引用验证失败（不猜测补全，请修正后重试）:\n${fmtValidation(validation)}`);
				}
				const result = await commitHotspot(path, {
					expectedRevision: read.exists && read.file ? read.file.revision : 0,
					expectedFingerprint: read.fingerprint,
					mutate: (latest) => {
						const base: HotspotFile = latest ?? { schemaVersion: SCHEMA_VERSION, revision: 0, entries: [] };
						const existing = base.entries.find((e) => e.topicId === entry.topicId);
						if (existing && sameRoutingContent(existing, entry)) {
							return null; // 相同路由内容：不写入、不增版
						}
						const entries = existing
							? base.entries.map((e) => (e.topicId === entry.topicId ? entry : e))
							: [...base.entries, entry];
						const nextFile: HotspotFile = { ...base, entries };
						const budgetProblems = checkStoreBudget(nextFile);
						if (budgetProblems.length) {
							throw new Error(budgetProblems.map((p) => p.message).join("；"));
						}
						return { next: nextFile };
					},
				});
				if (!result.ok) {
					logEvent(root, { kind: "tool", action: "upsert", topic: entry.topicId, ok: false, reason: result.kind });
					return err(`${result.message}${result.currentRevision !== undefined ? `（当前 revision=${result.currentRevision}）` : ""}`);
				}
				logEvent(root, { kind: "tool", action: "upsert", topic: entry.topicId, ok: true, revision: result.revision });
				return ok(
					(result.skipped ? "相同路由内容，未写入（revision 不变）" : `已保存 ${entry.topicId}，revision ${result.revision}`) +
						`\n符号验证: ${validation.symbolVerified ? "是" : "否"}${validation.notes.length ? `（${validation.notes.join("；")}）` : ""}`,
				);
			}

			// remove
			if (!params.topic_id || params.expected_revision === undefined) {
				return err("remove 需要 topic_id 与 expected_revision");
			}
			if (!read.exists || !read.file) return err("热点文件不存在");
			const target = read.file.entries.find((e) => e.topicId === params.topic_id);
			if (!target) return err(`主题不存在: ${params.topic_id}`);
			const result = await commitHotspot(path, {
				expectedRevision: read.exists && read.file ? read.file.revision : 0,
				expectedFingerprint: read.fingerprint,
				mutate: (latest) => {
					if (!latest) return null;
					const removed = latest.entries.find((e) => e.topicId === params.topic_id);
					if (!removed) return null;
					return { next: { ...latest, entries: latest.entries.filter((e) => e.topicId !== params.topic_id) } };
				},
			});
			if (!result.ok) {
				logEvent(root, { kind: "tool", action: "remove", topic: params.topic_id, ok: false, reason: result.kind });
				return err(result.message);
			}
			const trashLoc = appendTrash(root, {
				topicId: target.topicId,
				entry: target,
				reason: params.reason ?? "",
				revision: result.revision,
				removedAt: nowIso(),
			});
			logEvent(root, { kind: "tool", action: "remove", topic: target.topicId, ok: true, revision: result.revision });
			return ok(
				`已删除 ${target.topicId}（revision ${result.revision}）` +
					(trashLoc ? `\n恢复副本: ${trashLoc}` : "\n（恢复副本写入失败，但条目内容已在本次工具结果之外不可恢复——如需恢复请立即提供该条目内容）"),
			);
		},
	});
}
