/**
 * gui/src/rightRail/ShortcutsPanel.tsx — 右栏「仓库快捷按钮」面板（设计稿 v4 §5）。
 *
 * 回答：「当前仓库有哪些一键动作？agent 提议了哪些按钮改动待我决定？」
 * 数据按仓库 cwd 隔离（仓库主页 activeWorkspaceCwd 优先，聊天页回落当前会话 cwd），1s poll 准实时；四条纪律照抄 NotePanel：
 *  1. 请求时刻快照 cwd，回来比对，不一致丢弃（切仓库不串台）；
 *  2. 切仓库 effect 清空 box/draft/editing 并强制 refresh；
 *  3. 编辑中暂停 poll（后台 GET 不冲掉草稿）；
 *  4. 409 冲突保留草稿 + 「配置已更新，点此载入」（agent 直写与此共用同一降级）。
 *
 * 运行回执：idle → running → success/failed（script/process 在 P3 接执行器前显示明确占位）；
 * 危险动作两步确认；url 走 window.open；file 走现有 /v1/files/open|reveal（不执行脚本）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
	AlertTriangle, ExternalLink, FileText, Plus, RotateCw, Sparkles, TerminalSquare, Trash2,
} from "lucide-react";
import { api, newCommandKey } from "../api/client";
import type { ProposalOp, ProposalView, ShortcutAction, ShortcutsResponse, ShortcutKind } from "../api/types";
import { useGui } from "../store";
import { usePoll } from "../usePoll";
import { EmptyState } from "../ui";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { PANEL_SHORTCUTS, shortcutsPollingEnabled } from "./railState";
import { proposalsDirOf, sessionCwdOf, validateShortcutDraft } from "./shortcutsForm";

const RAIL_POLL_MS = 1000;
const CWD_COALESCE_MS = 300;
const KINDS: ShortcutKind[] = ["url", "file", "script", "process"];

type SaveState = "idle" | "saving" | "conflict" | "error";
type RunState = {
	id: string;
	runId?: string;
	status: "running" | "success" | "failed" | "cancelled";
	detail?: string;
	outputTail?: string;
};

interface PanelBox {
	cwd: string | null;
	data: ShortcutsResponse | null;
	error: string;
	lastOkAt: number | null;
}

const EMPTY_BOX: PanelBox = { cwd: null, data: null, error: "", lastOkAt: null };

/** 新建 action 的空白模板。 */
function blankAction(): ShortcutAction {
	return { id: "", label: "", kind: "url", url: "", confirm: false };
}


function actionSummary(a: ShortcutAction): string {
	switch (a.kind) {
		case "url": return a.url ?? "";
		case "file": return a.path ?? "";
		case "script": return `${a.command ?? ""}${(a.args?.length ?? 0) > 0 ? " " + (a.args ?? []).join(" ") : ""}`;
		case "process": return a.matchCommandLine ?? "";
	}
}

function opLine(op: ProposalOp): string {
	if (op.op === "add") return `+ ${op.action.label} · ${op.action.kind} ${actionSummary(op.action)}`;
	if (op.op === "update") return `~ ${op.targetId} → ${op.action.label} · ${op.action.kind} ${actionSummary(op.action)}`;
	return `- ${op.targetId}`;
}

export function ShortcutsPanel() {
	const railOpen = useGui((s) => s.railOpen);
	const railPanel = useGui((s) => s.railPanel);
	const workspaceCwd = useGui((s) => s.activeWorkspaceCwd);
	// 仓库主页优先；普通聊天页 activeWorkspaceCwd 恒 null ⇒ 用当前会话 cwd 兜底。
	// 少了这一句，聊天会话里整块面板（含「让 agent 推荐」按钮）永远停在空态。
	const sessionCwd = useGui((s) => sessionCwdOf(s.chatSessions, s.chatActiveId));
	const cwd = workspaceCwd ?? sessionCwd;
	const runtimeOverlay = useGui((s) => s.runtimeOverlay);

	const [box, setBox] = useState<PanelBox>(EMPTY_BOX);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState<ShortcutAction | null>(null);
	const [saveState, setSaveState] = useState<SaveState>("idle");
	/** 表单字段级校验错误（L4 复审：此前零前端校验）。 */
	const [formError, setFormError] = useState<string>("");
	const [runState, setRunState] = useState<RunState | null>(null);
	const [confirmId, setConfirmId] = useState<string | null>(null);
	const [busyProposal, setBusyProposal] = useState<string | null>(null);
	/** 「让 agent 推荐」的发送中态，防双击重复注入。 */
	const [askBusy, setAskBusy] = useState(false);
	/** 写/决策/运行失败的明确反馈（不静默；R-2）。 */
	const [notice, setNotice] = useState<string>("");
	const lastReqRef = useRef<{ cwd: string; at: number } | null>(null);

	/** 面板上下文的唯一 cwd 口径：仓库主页优先，聊天页回落到当前会话 cwd。 */
	const currentCwd = useCallback((): string | null => {
		const s = useGui.getState();
		return s.activeWorkspaceCwd ?? sessionCwdOf(s.chatSessions, s.chatActiveId);
	}, []);

	// 危险动作两步确认 5 秒自动复位（设计稿 §5.2），避免确认态长期悬挂误点。
	useEffect(() => {
		if (confirmId === null) return;
		const id = setTimeout(() => setConfirmId(null), 5000);
		return () => clearTimeout(id);
	}, [confirmId]);

	const railEnabled = shortcutsPollingEnabled({ railOpen, railPanel, cwd, runtimeOverlay });
	const enabled = railEnabled && !editing && saveState !== "conflict";

	const refresh = useCallback(async () => {
		const current = currentCwd();
		if (typeof current !== "string" || current.length === 0) return;
		const at = Date.now();
		const last = lastReqRef.current;
		if (last !== null && last.cwd === current && at - last.at < CWD_COALESCE_MS) return;
		lastReqRef.current = { cwd: current, at };
		const r = await api.shortcuts.get(current);
		// 迟到响应：A→B 后回来的 A 仓库数据不得写进 B 面板。
		if (currentCwd() !== current) return;
		if (r.ok) {
			setBox({ cwd: current, data: r.data, error: "", lastOkAt: Date.now() });
			return;
		}
		setBox((prev) => prev.cwd === current
			? { ...prev, error: `读取失败 HTTP ${r.status}` }
			: { cwd: current, data: null, error: `读取失败 HTTP ${r.status}`, lastOkAt: null });
	}, []);

	usePoll(refresh, RAIL_POLL_MS, enabled);

	// 切仓库立即补拍 + 清空旧状态（纪律 2）。
	useEffect(() => {
		setBox(EMPTY_BOX);
		setEditing(false);
		setDraft(null);
		setSaveState("idle");
		setRunState(null);
		setConfirmId(null);
		setBusyProposal(null);
		setAskBusy(false);
		setNotice("");
		setFormError("");
		lastReqRef.current = null;
		if (railEnabled) void refresh();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [cwd]);

	const startEdit = useCallback((a?: ShortcutAction) => {
		setDraft(a ? { ...a, args: a.args ? [...a.args] : [] } : blankAction());
		setEditing(true);
		setSaveState("idle");
		setFormError("");
	}, []);

	const commitSave = useCallback(async () => {
		if (draft === null || box.cwd === null || box.data === null || saveState === "saving") return;
		// 字段级校验先行：错误就地显示，不再只靠服务端 400 + 横幅（L4 复审重要项）。
		const invalid = validateShortcutDraft(draft);
		if (invalid !== null) { setFormError(invalid); return; }
		setFormError("");
		const c = box.cwd;
		const hash = box.data.contentHash;
		setSaveState("saving");
		const r = await api.shortcuts.save({ cwd: c, expectedHash: hash, action: draft });
		if (currentCwd() !== c) return;
		if (r.ok) {
			setBox({ cwd: c, data: { ...box.data, config: r.data.config, contentHash: r.data.contentHash }, error: "", lastOkAt: Date.now() });
			setEditing(false);
			setDraft(null);
			setSaveState("idle");
			setNotice("");
			return;
		}
		// 409 冲突：保留草稿，等用户决定（纪律 4）。其余失败给明确提示，不静默。
		setSaveState(r.status === 409 ? "conflict" : "error");
		if (r.status !== 409) setNotice(`保存失败：${errText(r.body, r.status)}`);
	}, [draft, box, saveState]);

	const doDelete = useCallback(async (id: string) => {
		if (box.cwd === null || box.data === null) return;
		const c = box.cwd;
		const r = await api.shortcuts.remove({ cwd: c, id, expectedHash: box.data.contentHash });
		if (currentCwd() !== c) return;
		if (r.ok) {
			setBox({ cwd: c, data: { ...box.data, config: r.data.config, contentHash: r.data.contentHash }, error: "", lastOkAt: Date.now() });
			setConfirmId(null);
			setNotice("");
		} else {
			setSaveState(r.status === 409 ? "conflict" : "error");
			setNotice(`删除失败：${errText(r.body, r.status)}`);
		}
	}, [box]);

	const doDecide = useCallback(async (pv: ProposalView, decision: "approved" | "declined") => {
		if (box.cwd === null) return;
		const c = box.cwd;
		setBusyProposal(pv.proposal.proposalId);
		const r = await api.shortcuts.decide({ cwd: c, proposalId: pv.proposal.proposalId, decision });
		if (currentCwd() !== c) { setBusyProposal(null); return; }
		setBusyProposal(null);
		if (r.ok) {
			setNotice("");
			void refresh();
			if (decision === "approved" && !r.data.injected) {
				setNotice("已批准，但会话回注不可用；请用「复制指令」发给 agent，或点「由 host 应用」");
			}
		} else {
			setNotice(`决策失败：${errText(r.body, r.status)}`);
		}
	}, [box.cwd, refresh]);

	const doHostApply = useCallback(async (pv: ProposalView) => {
		if (box.cwd === null) return;
		const c = box.cwd;
		setBusyProposal(pv.proposal.proposalId);
		const r = await api.shortcuts.hostApply({ cwd: c, proposalId: pv.proposal.proposalId });
		if (currentCwd() !== c) { setBusyProposal(null); return; }
		setBusyProposal(null);
		if (r.ok) { setNotice(""); void refresh(); }
		else setNotice(`host 应用失败：${errText(r.body, r.status)}`);
	}, [box.cwd, refresh]);

	const copyInstruction = useCallback((pv: ProposalView) => {
		const configPath = box.data?.configPath;
		const text = [
			`提案 ${pv.proposal.proposalId} 已批准。请用你的文件编辑工具修改仓库快捷按钮配置：`,
			configPath ? `配置文件绝对路径：${configPath}` : `（配置位于 agent 目录 gui-shortcuts/ 下，对应仓库 cwd=${box.cwd}）`,
			"按以下改动修改配置文件的 actions 数组，改前先重读文件、用精确编辑、不要整文件覆盖：",
			...pv.proposal.ops.map(opLine),
			"改完回复一句确认。",
		].join("\n");
		// clipboard 不可用时不能静默：把指令直接放进 notice，用户仍可手动复制。
		if (navigator.clipboard?.writeText === undefined) {
			setNotice("剪贴板不可用；请从下方提示手动复制指令");
			return;
		}
		void navigator.clipboard.writeText(text).then(
			() => setNotice("指令已复制，粘贴给 agent 即可"),
			() => setNotice(`复制失败；请手动复制（节选）：${text.slice(0, 400)}…`),
		);
	}, [box.cwd, box.data]);

	/**
	 * 「让 agent 推荐」：设计稿 §4.1 的注入入口，之前只写在文档里、面板没实现 ⇒
	 * agent 在提案阶段不知道 proposal 目录/schema/baseHash/sourceSession，只能靠用户口述。
	 * 这里把四样全部塞进一条自包含 session.message；agent 只需 Write 提案文件，不改主配置。
	 */
	const askAgentRecommend = useCallback(async () => {
		const snap = useGui.getState();
		const c = snap.activeWorkspaceCwd ?? sessionCwdOf(snap.chatSessions, snap.chatActiveId);
		const sid = snap.chatActiveId;
		const configPath = box.data?.configPath;
		if (c === null || typeof configPath !== "string" || configPath.length === 0 || askBusy) return;
		if (typeof sid !== "string" || sid.length === 0) {
			setNotice("先打开一个会话，再让 agent 推荐快捷按钮（回注需要目标会话）");
			return;
		}
		setAskBusy(true);
		const hash = box.data?.contentHash ?? "";
		const text = [
			"### 仓库快捷按钮：请为当前仓库提一个按钮建议",
			`当前仓库 cwd：${c}`,
			`提案目录（绝对路径）：${proposalsDirOf(configPath)}`,
			`主配置（绝对路径，现在只读、不要改）：${configPath}`,
			`当前配置 contentHash：${hash}（提案 baseHash 必须填这个值）`,
			`本会话 id（sourceSession 必须填）：${sid}`,
			"请用文件编辑工具（Write）在提案目录下新建 <32位小写hex>.json，内容为：",
			'{"version":1,"proposalId":"<与文件名相同>","cwd":"<上面的cwd>","baseHash":"<上面的hash>","reason":"<一句话说明>","sourceSession":"<上面的会话id>","createdAt":"<ISO时间>","ops":[{"op":"add","action":{"id":"build","label":"编译","kind":"script","command":"build.ps1","args":[],"confirm":true}}]}',
			'ops 另支持 {"op":"update","targetId":"<已有id>","action":{...}} 与 {"op":"remove","targetId":"<已有id>"}。',
			"action.kind 只用 url/file/script/process：url 填 http(s) 地址；file 填仓库内相对 path；script 填仓库内 .ps1 相对 command + args；process 填 matchCommandLine。危险动作 confirm=true。",
			"现在只写提案文件，不要改主配置；用户批准后我会再给你改配置的指令。写完回复提案文件名。",
		].join("\n");
		const r = await api.sessionMessage(sid, text, undefined, newCommandKey("shortcuts-recommend"), true);
		// 迟到响应：切仓库或切会话后都不把结果挂到新上下文（纪律 1 的会话侧同源）。
		const now = useGui.getState();
		const nowCwd = now.activeWorkspaceCwd ?? sessionCwdOf(now.chatSessions, now.chatActiveId);
		const stale = nowCwd !== c || now.chatActiveId !== sid;
		setAskBusy(false);
		if (stale) return;
		if (r.ok && r.data.status === "accepted") setNotice("已请当前会话的 agent 提建议；它写盘后提案卡片会出现在这里");
		else setNotice(`让 agent 推荐失败：${errText("body" in r ? r.body : undefined, r.status)}`);
	}, [box.data, askBusy]);

	/** 文件动作：open=默认应用，reveal=资源管理器定位。两者都走 cwd 快照 + 迟到丢弃。 */
	const fileAction = useCallback(async (a: ShortcutAction, mode: "open" | "reveal") => {
		const c = currentCwd();
		if (c === null || !a.path) return;
		setRunState({ id: a.id, status: "running", detail: mode === "open" ? "正在打开…" : "正在定位…" });
		const r = mode === "open" ? await api.fileOpen(a.path, c) : await api.fileReveal(a.path, c);
		if (currentCwd() !== c) return;
		setRunState({
			id: a.id,
			status: r.ok ? "success" : "failed",
			detail: r.ok
				? (mode === "open" ? "已交由默认应用打开" : "已在资源管理器定位")
				: (mode === "open" ? `打开失败（可点「定位」查看）：${errText(r.body, r.status)}` : `定位失败：${errText(r.body, r.status)}`),
		});
	}, []);

	const runAction = useCallback(async (a: ShortcutAction) => {
		const c = currentCwd();
		if (c === null) return;
		if (a.kind === "url") {
			if (a.url) window.open(a.url, "_blank", "noopener,noreferrer");
			return;
		}
		if (a.kind === "file") { await fileAction(a, "open"); return; }
		// script / process：服务端从配置取命令执行（客户端只传 cwd+id），二次确认已由按钮完成。
		// 同步执行：明确告知用户会等待，不存在中途取消的 UI（取消端点是给未来异步化用的，L4 复审）。
		setRunState({
			id: a.id, status: "running",
			detail: a.kind === "process" ? "正在精确匹配进程…" : "同步执行中，最多等待约 10 分钟，请勿关闭面板…",
		});
		const r = await api.shortcuts.run({ cwd: c, id: a.id, timeoutMs: a.timeoutMs ?? 120_000 });
		if (currentCwd() !== c) return; // 迟到响应丢弃
		if (!r.ok) {
			const body = r.body as { hint?: string } | undefined;
			const detail = r.status === 0
				? "请求中断或超时（服务端脚本可能仍在运行，请稍后查日志）"
				: errText(r.body, r.status);
			setRunState({ id: a.id, status: "failed", detail, outputTail: body?.hint });
			return;
		}
		setRunState({
			id: a.id, runId: r.data.runId,
			status: r.data.status === "success" ? "success" : r.data.status === "cancelled" ? "cancelled" : "failed",
			detail: r.data.hint ?? (a.kind === "process" ? "已终止目标进程" : `退出码 ${r.data.exitCode}`),
			outputTail: r.data.outputTail || undefined,
		});
	}, [fileAction]);

	const sameCwd = box.cwd !== null && box.cwd === cwd;
	const data = sameCwd ? box.data : null;
	const error = sameCwd ? box.error : "";
	const proposals = data?.proposals ?? [];
	const actions = data?.config.actions ?? [];

	const reload = useCallback(() => {
		setEditing(false);
		setDraft(null);
		setSaveState("idle");
		setFormError("");
		lastReqRef.current = null;
		void refresh();
	}, [refresh]);

	const statusText = saveState === "saving" ? "保存中…"
		: saveState === "conflict" ? "冲突"
			: saveState === "error" ? "保存失败"
				: editing ? "编辑中"
					: data !== null && box.lastOkAt !== null
						? `已同步 ${new Date(box.lastOkAt).toLocaleTimeString("zh-CN", { hour12: false })}`
						: "已同步";

	return (
		<div data-rail-panel={PANEL_SHORTCUTS} className="flex min-h-0 flex-col gap-1.5 p-2">
			<div className="flex shrink-0 items-center gap-1.5 text-ui-xs text-foreground-subtle">
				<span title="按当前仓库隔离的一键动作；agent 提案经你同意后落地">快捷按钮</span>
				{cwd !== null && <span className="truncate font-mono text-foreground-subtlest" title={cwd}>{basename(cwd)}</span>}
				<span className={`ml-auto ${saveState === "conflict" || saveState === "error" ? "text-destructive" : ""}`}>{statusText}</span>
				<Button size="icon-xs" variant="ghost" title="立即刷新" onClick={() => void refresh()}><RotateCw /></Button>
			</div>

			{cwd !== null && (
				<div className="flex shrink-0 items-center gap-1">
					<Button
						size="xs"
						variant="secondary"
						disabled={data === null || askBusy}
						title="把当前仓库、提案目录、schema 与会话 id 注入当前会话，让 agent 写提案"
						onClick={() => void askAgentRecommend()}
					>
						<Sparkles />让 agent 推荐
					</Button>
					<span className="min-w-0 truncate text-ui-xs text-foreground-subtlest">{askBusy ? "正在发给 agent…" : "按当前仓库与会话生成提案"}</span>
				</div>
			)}

			{notice !== "" && (
				<div className="flex shrink-0 items-start gap-1 rounded-lg border border-warning/50 bg-warning/5 p-1.5 text-ui-xs text-warning">
					<AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
					<span className="min-w-0 flex-1 break-words">{notice}</span>
					<Button size="icon-xs" variant="ghost" title="关闭提示" onClick={() => setNotice("")}>×</Button>
				</div>
			)}

			{cwd === null ? (
				<EmptyState icon={<TerminalSquare className="size-5" />}>
					<span className="block">先打开一个仓库或会话</span>
					<span className="mt-1 block text-ui-xs text-foreground-subtlest">快捷按钮按仓库隔离（仓库主页优先，聊天页取当前会话的 cwd）</span>
				</EmptyState>
			) : error !== "" ? (
				<div className="flex flex-col items-start gap-2 rounded-lg border border-destructive/50 p-2 text-ui-xs text-destructive">
					<span className="flex items-center gap-1"><AlertTriangle className="size-3.5" />{error}</span>
					<span className="text-foreground-subtle">读失败不等于配置为空；原文件没有被改动。</span>
					<Button variant="secondary" size="xs" onClick={() => void refresh()}>重试</Button>
				</div>
			) : data === null ? (
				<EmptyState icon={<TerminalSquare className="size-5" />}><span>加载中…</span></EmptyState>
			) : (
				<>
				{/* 提案卡置顶 */}
				{proposals.map((pv) => (
					<div key={pv.proposal.proposalId} className="rounded-lg border border-warning/50 bg-warning/5 p-2 text-ui-xs">
						<div className="flex items-center gap-1 text-warning">
							<Sparkles className="size-3.5" />
							<span>Agent 建议 · {pv.status}</span>
							<span className="ml-auto truncate font-mono text-foreground-subtlest">{pv.proposal.sourceSession.slice(0, 8)}</span>
						</div>
						<div className="mt-1 text-foreground-subtle">{pv.proposal.reason}</div>
						<div className="mt-1 space-y-0.5 font-mono text-foreground">
							{pv.proposal.ops.slice(0, 3).map((op, i) => <div key={i}>{opLine(op)}</div>)}
							{pv.proposal.ops.length > 3 && <div className="text-foreground-subtlest">…共 {pv.proposal.ops.length} 项</div>}
						</div>
						{pv.status === "pending" && (
							<div className="mt-1.5 flex flex-wrap gap-1">
								<Button size="xs" disabled={busyProposal === pv.proposal.proposalId || pv.proposal.baseHash !== data.contentHash} onClick={() => void doDecide(pv, "approved")}>同意并让 agent 修改</Button>
								<Button size="xs" variant="ghost" disabled={busyProposal === pv.proposal.proposalId} onClick={() => void doDecide(pv, "declined")}>拒绝</Button>
								{pv.proposal.baseHash !== data.contentHash && <span className="w-full text-foreground-subtle">配置已变化，提案基于的版本过期；请让 agent 重新提案后再同意</span>}
							</div>
						)}
						{pv.status === "approved" && (
							<div className="mt-1.5 flex flex-wrap gap-1">
								<Button size="xs" variant="secondary" onClick={() => copyInstruction(pv)}>复制指令</Button>
								<Button size="xs" variant="secondary" disabled={busyProposal === pv.proposal.proposalId} onClick={() => void doHostApply(pv)}>由 host 应用</Button>
							</div>
						)}
						{(pv.status === "applied" || pv.status === "declined" || pv.status === "expired") && (
							<div className="mt-1 text-foreground-subtlest">已{ pv.status === "applied" ? "应用" : pv.status === "declined" ? "拒绝" : "过期" }</div>
						)}
					</div>
				))}

				{/* 动作列表 */}
				{actions.length === 0 && !editing ? (
					<EmptyState icon={<TerminalSquare className="size-5" />}>
						<span className="block">还没有快捷按钮</span>
						<span className="mt-1 block text-ui-xs text-foreground-subtlest">点上方「让 agent 推荐」，或手动新增</span>
					</EmptyState>
				) : (
					<div className="flex flex-col gap-1">
						{actions.map((a) => (
							<div key={a.id} className="rounded-lg border border-border px-2 py-1.5">
								<div className="flex items-center gap-1.5">
									<span className="truncate">{a.label}</span>
									<span className="ml-auto font-mono text-ui-xs text-foreground-subtlest">{a.kind}</span>
								</div>
								<div className="truncate font-mono text-ui-xs text-foreground-subtle" title={actionSummary(a)}>{actionSummary(a)}</div>
								{runState?.id === a.id && (
									<div className={`mt-0.5 text-ui-xs ${runState.status === "failed" || runState.status === "cancelled" ? "text-destructive" : runState.status === "success" ? "text-foreground-subtle" : ""}`}>
										<div className="flex items-center gap-1">
											<span>{runState.status === "running" ? (runState.detail ?? "执行中…") : runState.detail ?? (runState.status === "success" ? "完成" : "失败")}</span>
										</div>
										{runState.outputTail !== undefined && runState.outputTail !== "" && (
											<details className="mt-0.5">
												<summary className="cursor-pointer text-foreground-subtle">查看输出</summary>
												<pre className="mt-0.5 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-secondary p-1 font-mono text-foreground-subtle">{runState.outputTail}</pre>
											</details>
										)}
									</div>
								)}
								<div className="mt-1 flex items-center gap-1">
									{(a.kind === "script" || a.kind === "process") ? (
										<>
											<Button
												size="xs" variant={confirmId === a.id ? "warning" : "secondary"}
												disabled={runState?.status === "running"}
												title={runState?.status === "running" ? "请等待当前动作执行完成" : undefined}
												onClick={() => {
													if (confirmId === a.id) { setConfirmId(null); void runAction(a); }
													else setConfirmId(a.id);
												}}
											>
											{confirmId === a.id ? "确认执行？" : "运行"}
										</Button>
										{confirmId === a.id && a.kind === "process" && (
											<span className="break-all font-mono text-foreground-subtle">将终止匹配：{a.matchCommandLine}</span>
										)}
										</>
									) : (
										<>
											<Button size="xs" variant="secondary" disabled={runState?.status === "running"} onClick={() => void runAction(a)}>
												{a.kind === "url" ? <><ExternalLink />打开</> : <><FileText />打开</>}
											</Button>
											{a.kind === "file" && <Button size="xs" variant="ghost" disabled={runState?.status === "running"} title="在资源管理器中定位" onClick={() => void fileAction(a, "reveal")}>定位</Button>}
										</>
									)}
									<Button size="xs" variant="ghost" onClick={() => startEdit(a)}>编辑</Button>
									{confirmId === `del-${a.id}` ? (
										<Button size="xs" variant="destructive" onClick={() => void doDelete(a.id)}>确认删除</Button>
									) : (
										<Button size="xs" variant="ghost" onClick={() => setConfirmId(`del-${a.id}`)}><Trash2 /></Button>
									)}
								</div>
							</div>
						))}
					</div>
				)}

				{/* 内联新增/编辑表单 */}
				{editing && draft !== null ? (
					<div className="rounded-lg border border-border p-2 text-ui-xs">
						<div className="mb-1 text-foreground-subtle">{draft.id ? "编辑按钮" : "新增按钮"}</div>
						<div className="flex flex-col gap-1">
							<Input aria-label="id" placeholder="id（英文小写/数字/连字符）" value={draft.id} disabled={draft.id.length > 0}
								onChange={(e) => setDraft({ ...draft, id: e.target.value })} className="font-mono" />
							<Input aria-label="名称" placeholder="显示名称" value={draft.label}
								onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
							<div className="flex gap-1">
								{KINDS.map((k) => (
									<Button key={k} size="xs" variant={draft.kind === k ? "default" : "ghost"} onClick={() => setDraft({ ...draft, kind: k, confirm: k === "script" || k === "process" })}>{k}</Button>
								))}
							</div>
							{draft.kind === "url" && <Input aria-label="url" placeholder="http://… 或 https://…" value={draft.url ?? ""} onChange={(e) => setDraft({ ...draft, url: e.target.value })} />}
							{draft.kind === "file" && <Input aria-label="path" placeholder="仓库内相对路径，如 logs/build.log" value={draft.path ?? ""} onChange={(e) => setDraft({ ...draft, path: e.target.value })} />}
							{draft.kind === "script" && <>
								<Input aria-label="command" placeholder="脚本文件名，如 build.ps1" value={draft.command ?? ""} onChange={(e) => setDraft({ ...draft, command: e.target.value })} />
								<Input aria-label="args" placeholder="参数（空格分隔；暂不支持含空格的参数）" value={(draft.args ?? []).join(" ")} onChange={(e) => setDraft({ ...draft, args: e.target.value.trim() ? e.target.value.split(/\s+/) : [] })} />
							</>}
							{draft.kind === "process" && <Input aria-label="match" placeholder="命令行特征串（4–200 字符）" value={draft.matchCommandLine ?? ""} onChange={(e) => setDraft({ ...draft, matchCommandLine: e.target.value })} />}
						</div>
						{formError !== "" && <div className="mt-1 break-words text-destructive">{formError}</div>}
						<div className="mt-1.5 flex items-center gap-1">
							<Button size="xs" disabled={saveState === "saving"} onClick={() => void commitSave()}>保存</Button>
							<Button size="xs" variant="ghost" onClick={() => { setEditing(false); setDraft(null); setFormError(""); }}>取消</Button>
						</div>
					</div>
				) : (
					<Button size="xs" variant="outline" onClick={() => startEdit()}><Plus />新增按钮</Button>
				)}

				{saveState === "conflict" && (
					<Button size="xs" variant="warning" onClick={reload}>配置已在别处更新，点此载入（本地草稿会丢弃）</Button>
				)}
				</>
			)}
		</div>
	);
}

function basename(cwd: string): string {
	const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
	return parts.length > 0 ? parts[parts.length - 1]! : cwd;
}

/** 从 FetchErr.body 提取可读错误（服务端 { error, message, hint, reason }）。 */
function errText(body: unknown, status: number): string {
	if (body !== null && typeof body === "object") {
		const b = body as Record<string, unknown>;
		const msg = b.hint ?? b.message ?? b.error ?? b.reason;
		if (typeof msg === "string" && msg.length > 0) return `HTTP ${status} · ${msg}`;
	}
	return `HTTP ${status}`;
}
