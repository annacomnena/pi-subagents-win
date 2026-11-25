/**
 * gui/src/rightRail/NotePanel.tsx — 右栏「会话便签」面板（设计稿 §4.1；P2）。
 *
 * 它回答一个问题：「**我这个会话**有哪些提醒需要长期挂在对话旁路？」——
 * agent 写的待人办、人写的会话规则都落同一份 <agentDir>/session-notes/<sid>.json。
 *
 * 四条不能违反的纪律（切会话串台是本面板最容易出的静默失效）：
 *  1. 请求时刻**快照 sid**，回来比对当前 `chatActiveId`，不一致丢弃迟到响应；
 *  2. 切会话立即重取（usePoll 的 interval 不含会话依赖），且旧会话数据不渲染；
 *  3. 编辑中（editing）**暂停轮询**，否则后台 GET 会把用户正在打的字冲掉；
 *  4. 409 冲突**保留本地草稿**，给"重新载入"按钮让人决定，不静默覆盖。
 *
 * 阅读/编辑双态（2026-11-18）：默认把正文交给 <Markdown> 只读渲染（标题/列表/代码
 * 可读），鼠标点进正文（或按 Enter）才切到原始 textarea。改动只在点「保存」时写盘 ——
 * 这样 agent 每次 run 看到的都是一个完整想法，而不是打字途中的半成品。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, StickyNote } from "lucide-react";
import { api, newCommandKey } from "../api/client";
import type { SessionNote } from "../api/types";
import { useGui } from "../store";
import { usePoll } from "../usePoll";
import { EmptyState, RelTime } from "../ui";
import { Button } from "../ui/button";
import { Markdown } from "../ui/Markdown";
import { Textarea } from "../ui/textarea";
import { PANEL_NOTE, railPollingEnabled } from "./railState";

/** 轮询档位（与设计稿 §2 的 2–6s 一致）。 */
const RAIL_POLL_MS = 5000;
/** 同一 sid 的请求合并窗（enabled 翻转与切会话补拍在同一帧时只发一次）。 */
const SAME_SID_COALESCE_MS = 300;

/** 空便签的模板占位（placeholder，不写进文件；用户想用照着写即可）。 */
const NOTE_TEMPLATE = "## 给 agent 的规则\n- 本会话遵循：…\n\n## 待人办\n- [ ] 手动测试 …";

type SaveState = "idle" | "saving" | "saved" | "conflict" | "error" | "sending" | "sent";

interface PanelBox {
	/** 这批数据属于哪个会话；切会话后旧数据不得冒充新会话的便签。 */
	sid: string | null;
	note: SessionNote | null;
	error: string;
	lastOkAt: number | null;
}

const EMPTY_BOX: PanelBox = { sid: null, note: null, error: "", lastOkAt: null };

export function NotePanel() {
	const railOpen = useGui((s) => s.railOpen);
	const railPanel = useGui((s) => s.railPanel);
	const chatActiveId = useGui((s) => s.chatActiveId);
	const activeTab = useGui((s) => s.activeTab);
	const runtimeOverlay = useGui((s) => s.runtimeOverlay);

	const [box, setBox] = useState<PanelBox>(EMPTY_BOX);
	/** false = markdown 只读渲染；true = 已点进正文，显示原始 textarea。 */
	const [editing, setEditing] = useState(false);
	/** null = 尚未本地编辑，展示服务端文本；非 null = 用户草稿（任何轮询都不得覆盖）。 */
	const [draft, setDraft] = useState<string | null>(null);
	const [dirty, setDirty] = useState(false);
	const [saveState, setSaveState] = useState<SaveState>("idle");
	const lastReqRef = useRef<{ sid: string; at: number } | null>(null);

	const railEnabled = railPollingEnabled({ railOpen, railPanel, chatActiveId, activeTab, runtimeOverlay });
	// 编辑中 / 冲突态暂停轮询：后台 GET 会与本地草稿打架（冲突态还要给用户看的出口）。
	// 用 editing 而非 dirty：刚点进去还没打字时也不能让轮询把光标下的文本换掉。
	const enabled = railEnabled && !editing && saveState !== "conflict";

	const refresh = useCallback(async () => {
		const sid = useGui.getState().chatActiveId;
		if (typeof sid !== "string" || sid.length === 0) return;
		const at = Date.now();
		const last = lastReqRef.current;
		if (last !== null && last.sid === sid && at - last.at < SAME_SID_COALESCE_MS) return;
		lastReqRef.current = { sid, at };

		const r = await api.sessionNote.get(sid);
		// 迟到响应：A→B 之后回来的 A 便签不得写进 B 的面板（G1 会话隔离的消费面）。
		if (useGui.getState().chatActiveId !== sid) return;
		if (r.ok) {
			setBox({ sid, note: r.data.note, error: "", lastOkAt: Date.now() });
			setDraft((prev) => (prev === null ? r.data.note.text : prev));
			return;
		}
		setBox((prev) => prev.sid === sid
			? { ...prev, error: `读取失败 HTTP ${r.status}` }
			: { sid, note: null, error: `读取失败 HTTP ${r.status}`, lastOkAt: null });
	}, []);

	/** 返回值表示是否真的写盘成功（「发送」流程要先拿到这个结果才决定要不要发消息）。 */
	const save = useCallback(async (sid: string, text: string, expectedVersion: number, keepEditing = false): Promise<boolean> => {
		setSaveState("saving");
		const r = await api.sessionNote.save({ sid, text, expectedVersion });
		// 保存期间切了会话：回执不落到新会话的面板（草稿也随切会话清掉了）。
		if (useGui.getState().chatActiveId !== sid) return false;
		if (r.ok) {
			setBox({ sid, note: r.data.note, error: "", lastOkAt: Date.now() });
			// 「发送」流程里先留住草稿/编辑态：后面 session.message 可能失败，用户得能重试。
			if (!keepEditing) { setDraft(null); setDirty(false); setEditing(false); }
			setSaveState("saved");
			return true;
		}
		if (r.status === 409) { setSaveState("conflict"); return false; } // 保留草稿，等用户决定
		setSaveState("error");
		return false;
	}, []);

	usePoll(refresh, RAIL_POLL_MS, enabled);

	// 切会话立即补拍一次（usePoll 依赖里没有会话 id），并清掉上一个会话的草稿/状态。
	useEffect(() => {
		setBox(EMPTY_BOX);
		setEditing(false);
		setDraft(null);
		setDirty(false);
		setSaveState("idle");
		lastReqRef.current = null;
		if (railEnabled) void refresh();
		// 故意只依赖 chatActiveId：railEnabled 翻转由 usePoll 自己处理，重复补拍交给合并窗。
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [chatActiveId]);

	// 草稿变化 → 手动点「保存」或 Ctrl+Enter 才写盘（带 expectedVersion）。
	// 不自动保存是有意的：注入按版本脏判定，一次完整编辑 = 一个版本，避免把打字途中的
	// 半成品写进便签、并在下次 run 被注入给 agent（见设计稿 §4.3 脏时注入）。
	const commitSave = useCallback(() => {
		if (!dirty || draft === null || box.sid === null || box.note === null || saveState === "saving" || saveState === "sending") return;
		void save(box.sid, draft, box.note.version);
	}, [dirty, draft, box.sid, box.note, saveState, save]);

	/**
	 * 「发送」= 先保存便签（旁路持久化），再把同一份正文作为一条真消息注入会话。
	 * 保存失败（尤其 409 冲突）就不发：避免对话里的内容和便签里的不一致（G2）。
	 * forceResume=true 与 GUI 常规发送同源：用户显式点了发送 ⇒ 会话若已停就尝试拉起（R-5）。
	 */
	const sendToSession = useCallback(async () => {
		if (!dirty || draft === null || box.sid === null || box.note === null || saveState === "saving" || saveState === "sending") return;
		const sid = box.sid;
		const text = draft;
		const saved = await save(sid, text, box.note.version, true); // keepEditing：发失败要留住草稿
		if (!saved || useGui.getState().chatActiveId !== sid) return;
		setSaveState("sending");
		const r = await api.sessionMessage(sid, text, undefined, newCommandKey("note"), true);
		if (useGui.getState().chatActiveId !== sid) return;
		const accepted = r.ok && r.data.status === "accepted";
		setSaveState(accepted ? "sent" : "error");
		if (accepted) { setDraft(null); setDirty(false); setEditing(false); }
	}, [dirty, draft, box.sid, box.note, saveState, save]);

	const reload = useCallback(() => {
		setEditing(false);
		setDraft(null);
		setDirty(false);
		setSaveState("idle");
		lastReqRef.current = null;
		void refresh();
	}, [refresh]);

	// 派生过滤：即使 effect 还没跑完，也不渲染上一个会话的便签（避免闪一帧旧会话内容）。
	const sameSession = box.sid !== null && box.sid === chatActiveId;
	const note = sameSession ? box.note : null;
	const error = sameSession ? box.error : "";
	const value = draft ?? note?.text ?? "";

	const busy = saveState === "saving" || saveState === "sending";
	const statusText = saveState === "saving" ? "保存中…"
		: saveState === "sending" ? "发送中…"
			: saveState === "sent" ? "已发送到会话"
				: saveState === "conflict" ? "冲突"
					: saveState === "error" ? "保存/发送失败"
						: dirty ? "未保存"
							: note !== null && box.lastOkAt !== null
								? `已保存 ${new Date(box.lastOkAt).toLocaleTimeString("zh-CN", { hour12: false })}`
								: "已同步";

	return (
		<div data-rail-panel={PANEL_NOTE} className="flex min-h-0 flex-col gap-1.5 p-2">
			<div className="flex shrink-0 items-center gap-1.5 text-ui-xs text-foreground-subtle">
				<span title="本会话专属；agent 与人共用同一份便签。便签本身不进对话流，可点「发送到会话」显式发出">会话便签</span>
				{note !== null && <span className="font-mono text-foreground-subtlest">v{note.version}</span>}
				<span className={`ml-auto ${saveState === "conflict" || saveState === "error" ? "text-destructive" : ""}`}>{statusText}</span>
			</div>

			{chatActiveId === null ? (
				<EmptyState icon={<StickyNote className="size-5" />}>
					<span className="block">先选中一个会话</span>
					<span className="mt-1 block text-ui-xs text-foreground-subtlest">便签按会话隔离，选中后才可读写</span>
				</EmptyState>
			) : error !== "" ? (
				<div className="flex flex-col items-start gap-2 rounded-lg border border-destructive/50 p-2 text-ui-xs text-destructive">
					<span className="flex items-center gap-1"><AlertTriangle className="size-3.5" />{error}</span>
					<span className="text-foreground-subtle">读失败不等于空便签；原文件没有被改动。</span>
					<Button variant="secondary" size="xs" onClick={() => void refresh()}>重试</Button>
				</div>
			) : (
				<>
				{editing ? (
					<Textarea
						aria-label="会话便签正文"
						value={value}
						placeholder={NOTE_TEMPLATE}
						onChange={(e) => { setDraft(e.target.value); setDirty(true); }}
						onKeyDown={(e) => {
							if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); commitSave(); }
						}}
						autoFocus
						className="min-h-40 max-h-[55vh] resize-y font-mono text-ui-xs"
					/>
				) : (
					<div
						role="button"
						tabIndex={0}
						title="点击编辑（编辑时显示原始 markdown）"
						onClick={(e) => {
							if ((e.target as HTMLElement).closest("a")) return; // 外链交给 Markdown，不抢编辑态
							setEditing(true);
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setEditing(true); }
						}}
						data-note-preview
						className="min-h-40 max-h-[55vh] cursor-pointer overflow-auto rounded-lg border border-transparent p-2 text-ui-xs hover:border-border focus-visible:border-input-border-focused"
					>
						{note !== null && note.text.trim() !== ""
							? <Markdown text={note.text} />
							: <span className="text-foreground-subtle">便签还是空的，点击开始写…</span>}
					</div>
				)}
				{saveState === "conflict" && (
					<Button variant="warning" size="xs" onClick={reload}>
						便签在别处被修改，点此重新载入（本地草稿会丢弃）
					</Button>
				)}
				<div className="flex items-center gap-1 text-ui-xs text-foreground-subtlest">
					{editing ? (
						<>
							<Button size="xs" variant="secondary" disabled={busy || !dirty} onClick={commitSave}>保存</Button>
							<Button size="xs" variant="default" disabled={busy || !dirty} onClick={() => void sendToSession()}>发送到会话</Button>
							<Button size="xs" variant="ghost" disabled={busy} onClick={reload}>取消</Button>
						</>
					) : (
						<>
							<span>点击正文编辑 · Markdown 只读渲染</span>
							<span className="ml-auto">
								{box.lastOkAt !== null ? <RelTime at={new Date(box.lastOkAt).toISOString()} /> : "尚未读取"}
							</span>
						</>
					)}
				</div>
				</>
			)}
		</div>
	);
}
