/**
 * runtime/hydrate.ts — Handoff 装配器（Phase 5b，附记 A7 F19/F23/F24）
 *
 * 把新会话启动所需上下文装配成一份 HandoffDocument（markdown），落盘到
 * runtime/handoffs/<gen>-<timestamp>.md（同 gen 多份不覆盖，F24）。
 *
 * 输入（§31 六项 + journal tail + registry 快照）：
 *   Canonical State（runs/workstreams/tasks）/ pending mailbox（backlog 聚合+
 *   主题列表，防体积爆炸）/ handoff token 信息 / journal 尾部（紧凑行，非 transcript）
 *   / 仓库 recentwork.md（显式 repoRoot，缺省 cwd；缺席记原因，F23）
 *   / charter 文件（~/.pi/agent/charter.md，用户自写；缺席为常态，只标注）
 *   / artifact 指针（只指针，不内联内容）
 * 每项进 manifest 表（present/absent + 来源路径）：缺席是可审计事实（F19）。
 *
 * 触发：显式命令 /master-handoff，不自动注入（零行为变化）。
 * 只读装配 + 落盘，不碰任何活路状态。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultRuntimeDir, listRuntimeEnvelopes } from "./journal.ts";
import { listProjectedRuns } from "./state-store.ts";
import { mailboxBacklog, listLetters } from "./mailbox.ts";
import { masterAddress, type ObjectAddress } from "./address.ts";
import { readAttachment, readCutover, readHandoffToken } from "./registry.ts";
import { enrichRunRefs, listTasks, listWorkstreams } from "./workstreams.ts";

export interface HydrateOptions {
	stateDir?: string;
	mailboxDir?: string;
	journalPath?: string;
	/** recentwork.md 解析根（缺省进程 cwd；F23：显式、可记录） */
	repoRoot?: string;
	now?: Date;
}

export interface HydrateInputStatus {
	name: string;
	present: boolean;
	source: string;
	note?: string;
}

export interface HandoffDocument {
	markdown: string;
	manifest: HydrateInputStatus[];
	/** 落盘路径 */
	path: string;
}

const RECENTWORK_CAP_BYTES = 2048;
const LIST_CAP = 20;

export function buildHandoff(opts: HydrateOptions = {}): HandoffDocument {
	const runtimeDir = defaultRuntimeDir();
	const stateDir = opts.stateDir ?? join(runtimeDir, "state");
	const mailboxDir = opts.mailboxDir ?? join(runtimeDir, "mailbox");
	const journalPath = opts.journalPath ?? join(runtimeDir, "events.jsonl");
	const repoRoot = opts.repoRoot ?? process.cwd();
	const now = opts.now ?? new Date();
	const manifest: HydrateInputStatus[] = [];
	const section: string[] = [];

	// ── Master 快照 ───────────────────────────────────────────────
	const attachment = readAttachment(masterAddress());
	manifest.push({
		name: "master-attachment",
		present: attachment !== null,
		source: "runtime/registry/attachments/",
		note: attachment ? `gen=${attachment.generation} owner=${attachment.sessionId.slice(0, 12)}` : "unattached",
	});
	const cutover = readCutover();
	const token = readHandoffToken(masterAddress());
	manifest.push({
		name: "handoff-token",
		present: token !== null,
		source: "runtime/registry/handoff/",
		note: token ? `fromGen=${token.fromGeneration} expires=${token.expiresAt.slice(0, 10)}` : "no live token",
	});
	section.push(`# Handoff — gen ${attachment?.generation ?? 0} @ ${now.toISOString()}`);
	section.push(`cutover=${cutover ? (cutover.enabled ? "ON" : "OFF") : "(never set)"}`);

	// ── Canonical State ───────────────────────────────────────────
	const runs = listProjectedRuns(stateDir);
	const workstreams = listWorkstreams(stateDir);
	const tasks = listTasks(undefined, stateDir);
	manifest.push({ name: "canonical-runs", present: runs.length > 0, source: "runtime/state/runs/", note: `${runs.length} runs` });
	manifest.push({ name: "workstreams", present: workstreams.length > 0, source: "runtime/state/workstreams/", note: `${workstreams.length} workstreams / ${tasks.length} tasks` });
	section.push(`## Runs（近 ${Math.min(runs.length, LIST_CAP)}）`);
	const recentRuns = [...runs].sort((a, b) => (b.dispatchedAt ?? "").localeCompare(a.dispatchedAt ?? "")).slice(0, LIST_CAP);
	const taskBrief = tasks.map((t) => ({ id: t.id, externalTaskId: t.externalTaskId, workstreamId: t.workstreamId }));
	const wsBrief = workstreams.map((w) => ({ id: w.id, taskSelector: w.taskSelector }));
	for (const r of recentRuns) {
		const refs = enrichRunRefs(r, taskBrief, wsBrief);
		const refStr = [refs.taskRef ? `task=${refs.taskRef.slice(0, 14)}` : null, refs.workstreamRef ? `ws=${refs.workstreamRef.slice(0, 14)}` : null]
			.filter(Boolean).join(" ");
		section.push(`- ${r.subject} [${r.status}]${r.externalTaskId ? ` ext=${r.externalTaskId}` : ""}${refStr ? ` ${refStr}(${refs.match})` : ""}`);
	}
	if (!recentRuns.length) section.push("- (none)");
	for (const w of workstreams) {
		section.push(`## Workstream ${w.id} [${w.status}]\nmission=${w.mission}${w.successCriteria ? `\ncriteria=${w.successCriteria}` : ""}`);
	}

	// ── Pending mailbox ───────────────────────────────────────────
	const backlog = mailboxBacklog(mailboxDir);
	const pendingSubjects: string[] = [];
	for (const row of backlog) {
		if (!row.pending) continue;
		try {
			for (const l of listLetters(row.recipient as ObjectAddress, "pending", mailboxDir).slice(0, LIST_CAP)) {
				const kind = l.frame.frame === "message" ? l.frame.kind : l.frame.type;
				const subj = l.frame.frame === "message" ? (l.frame.subject ?? "") : "";
				pendingSubjects.push(`${kind}:${subj}`);
			}
		} catch {
			continue;
		}
	}
	manifest.push({ name: "pending-mailbox", present: pendingSubjects.length > 0, source: "runtime/mailbox/", note: backlog.map((b) => `${b.recipient}=p${b.pending}`).join(" ") || "empty" });
	section.push(`## Pending mailbox\n${pendingSubjects.length ? pendingSubjects.map((s) => `- ${s}`).join("\n") : "- (empty)"}`);

	// ── Journal tail ──────────────────────────────────────────────
	let tail: string[] = [];
	try {
		const { envelopes } = listRuntimeEnvelopes({ path: journalPath });
		tail = envelopes.slice(-15).map((e) => `${e.at.slice(11, 19)} ${e.type} ${e.subject ?? ""}`);
	} catch {
		/* tolerant */
	}
	manifest.push({ name: "journal-tail", present: tail.length > 0, source: "runtime/events.jsonl", note: `last ${tail.length}` });
	section.push(`## Journal tail\n${tail.length ? tail.map((t) => `- ${t}`).join("\n") : "- (none)"}`);

	// ── RecentWork（仓库惯例，F23）─────────────────────────────────
	const rwPath = join(repoRoot, "recentwork.md");
	let rwExcerpt: string | null = null;
	if (existsSync(rwPath)) {
		try {
			const buf = readFileSync(rwPath, "utf8");
			rwExcerpt = truncateUtf8(buf, RECENTWORK_CAP_BYTES);
		} catch {
			rwExcerpt = null;
		}
	}
	manifest.push({
		name: "recentwork",
		present: rwExcerpt !== null,
		source: rwPath,
		note: rwExcerpt === null ? (/[/\\]/.test(repoRoot) ? "absent at repoRoot" : "unresolvable root") : `${rwExcerpt.length} chars excerpt`,
	});
	section.push(`## RecentWork\n${rwExcerpt ?? "(absent — no recentwork.md at repoRoot)"}`);

	// ── Charter（用户自写，常态缺席，只标注）────────────────────────
	const charterPath = join(runtimeDir, "charter.md");
	const charterPresent = existsSync(charterPath);
	manifest.push({ name: "charter", present: charterPresent, source: "runtime/charter.md", note: charterPresent ? "user-authored" : "absent (normal)" });
	section.push(`## Charter\n${charterPresent ? "(see runtime/charter.md)" : "(absent — no standing directives recorded)"}`);

	// ── Artifacts（只指针）──────────────────────────────────────────
	const artifactRefs: string[] = [];
	for (const r of recentRuns) {
		if (r.reportPath) artifactRefs.push(r.reportPath);
		for (const a of r.artifacts ?? []) artifactRefs.push(a);
	}
	manifest.push({ name: "artifact-refs", present: artifactRefs.length > 0, source: "projected runs", note: `${artifactRefs.length} pointers` });
	section.push(`## Artifact refs (pointers only)\n${artifactRefs.length ? [...new Set(artifactRefs)].slice(0, LIST_CAP).map((a) => `- ${a}`).join("\n") : "- (none)"}`);

	// ── Manifest 表 + 落盘 ──────────────────────────────────────────
	section.push(`## Manifest\n${manifest.map((m) => `- [${m.present ? "x" : " "}] ${m.name} — ${m.source}${m.note ? ` (${m.note})` : ""}`).join("\n")}`);
	const markdown = `${section.join("\n\n")}\n`;
	const gen = attachment?.generation ?? 0;
	const stamp = now.toISOString().replace(/[:.]/g, "-");
	const outDir = join(runtimeDir, "handoffs");
	mkdirSync(outDir, { recursive: true });
	const path = join(outDir, `${gen}-${stamp}.md`);
	writeFileSync(path, markdown, "utf8");
	return { markdown, manifest, path };
}

function truncateUtf8(s: string, maxBytes: number): string {
	const bytes = new TextEncoder().encode(s);
	if (bytes.length <= maxBytes) return s;
	let end = maxBytes;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
	return new TextDecoder().decode(bytes.slice(0, end)) + "…[truncated]";
}
