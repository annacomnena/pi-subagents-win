/**
 * tab-runs-runtime — 标签页回收运行时：生命周期遥测 + 显式终态 + 状态/回收工具
 *
 * 阶段 2-4（tab reclaim 编排闭环）：
 *   - 标签页进程（PI_TAB_RUN_ID 已设置且非子 agent）注册生命周期事件，
 *     原子写 <runId>.state.json（attached/working/waiting/orphaned）
 *   - tab-finish 工具（仅标签页内生效）写 <runId>.result.json（唯一显式终态）
 *   - tab-status / reclaim-tabs 工具 + /tabs 命令（主会话编排回收）
 *
 * 判态优先级（与 tab-runs.ts composeTabStatus 一致）：
 *   result（显式终态）> state（遥测）> JSONL 探活（保守降级）。
 * stop/length/toolUse 永不当作工作流完成；result 缺失一律 resultMissing/unconfirmed。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { sendWindowsToast } from "./notify-windows.ts";
import { sendReportToMain } from "./report.ts";
import {
	buildTabStatusView,
	defaultTabRunsDir,
	defaultSessionsRoot,
	emptyTabUsage,
	listTabDispatches,
	messageText,
	readTabDispatch,
	tabResultPath,
	validateTabResult,
	writeJsonAtomic,
	writeTabState,
	type TabDispatchRecord,
	type TabState,
	type TabStatusView,
} from "./tab-runs.ts";

const RECLAIM_DEFAULT_TIMEOUT_MS = 120_000;
const RECLAIM_DEFAULT_INTERVAL_MS = 3_000;
const RECLAIM_MAX_TIMEOUT_MS = 10 * 60_000;

// ── 标签页遥测 + tab-finish ───────────────────────────────────────

/**
 * 注册标签页侧遥测与 tab-finish。仅在当前进程是「已派发的标签页」时生效
 * （PI_TAB_RUN_ID 已设置且非子 agent）。opts 供测试注入。
 */
export function registerTabTelemetry(
	pi: ExtensionAPI,
	opts?: { tabRunId?: string; runsDir?: string },
): void {
	const tabRunId = opts?.tabRunId ?? process.env.PI_TAB_RUN_ID;
	if (!tabRunId) return;
	if (process.env.PI_SUBAGENT === "1") return; // 子 agent 不拥有 tab 身份
	const runsDir = opts?.runsDir ?? process.env.PI_TAB_RUNS_DIR ?? defaultTabRunsDir();

	let finished = false; // tab-finish 已给出显式终态
	let lastAssistantText = "";
	let lastStopReason: string | undefined;
	const usageAccum = emptyTabUsage();
	const usageSeen = new Set<string>();

	const writeState = (phase: TabState["phase"], turn: TabState["turn"], extra: Partial<TabState> = {}): void => {
		if (finished) return; // 已终态不再覆盖
		writeTabState(runsDir, tabRunId, {
			id: tabRunId,
			phase,
			turn,
			terminal: false,
			lastActivityAt: new Date().toISOString(),
			lastAssistantText: lastAssistantText || undefined,
			lastStopReason,
			usage: { ...usageAccum },
			...extra,
		});
	};

	pi.on("session_start", (_event, ctx) => {
		const sessionPath = ctx.sessionManager?.getSessionFile?.() ?? undefined;
		writeState("attached", "idle", { sessionPath, pid: process.pid });
	});

	pi.on("agent_start", () => {
		writeState("working", "working");
	});

	pi.on("tool_execution_start", () => {
		writeState("working", "working");
	});

	pi.on("message_end", (event) => {
		const message = event.message;
		if (!message || message.role !== "assistant") return;
		lastStopReason = message.stopReason;
		const text = messageText(message);
		if (text) lastAssistantText = text.slice(0, 2000);
		const usage = message.usage;
		if (usage) {
			// P1-5：复合去重 key，避免缺 id+timestamp 时塌缩成 "undefined" 导致 usage 漏加
			const mid = typeof message.id === "string" ? message.id : "";
			const mts = typeof message.timestamp === "string" ? message.timestamp : "";
			const mrid = typeof message.responseId === "string" ? message.responseId : "";
			const key = `${mid}|${mts}|${mrid}`;
			if (key === "||" || usageSeen.has(key)) {
				// 无法去重的消息（无任何标识）或重复消息：不累加
			} else {
				usageSeen.add(key);
				const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
				usageAccum.input += n(usage.input);
				usageAccum.output += n(usage.output);
				usageAccum.cacheRead += n(usage.cacheRead);
				usageAccum.cacheWrite += n(usage.cacheWrite);
				const cost = asUsageCost(usage);
				if (cost !== undefined) usageAccum.cost += cost;
				usageAccum.turns += 1;
			}
		}
	});

	// agent_settled = 权威「等待输入」信号（无重试/压缩/排队后续）
	pi.on("agent_settled", () => {
		writeState("waiting", "idle");
	});

	pi.on("session_shutdown", () => {
		if (!finished) {
			writeTabState(runsDir, tabRunId, {
				id: tabRunId,
				phase: "orphaned",
				turn: "unknown",
				terminal: false,
				lastActivityAt: new Date().toISOString(),
				lastAssistantText: lastAssistantText || undefined,
				lastStopReason,
				usage: { ...usageAccum },
				error: "session shutdown without explicit tab-finish",
			});
		}
	});

	// ── tab-finish：唯一显式终态工具（仅标签页内生效）──
	pi.registerTool({
		name: "tab-finish",
		label: "Tab Finish",
		description: [
			"（标签页内部工具）声明本标签页工作流终态：把结构化结果原子写入 tab-runs/<runId>.result.json。",
			"参数：status（completed|failed|cancelled）、summary、可选 finalText/artifacts[]/reportPath/openIssues[]/usage。",
			"runId 取自进程环境（PI_TAB_RUN_ID），不接受外部传入——防止伪造其他 runId。",
			"只有调用了本工具（或明确失败事件）才代表工作流完成；普通回合 stop 不算完成。",
			"重复调用拒绝（结果只写一次）。",
		].join(" "),
		parameters: Type.Object({
			status: Type.String({ description: "completed | failed | cancelled" }),
			summary: Type.String({ description: "结果摘要（给主会话的交接材料）" }),
			finalText: Type.Optional(Type.String({ description: "最终文本（截断 4000 字符）" })),
			artifacts: Type.Optional(Type.Array(Type.String(), { description: "交付物路径列表" })),
			reportPath: Type.Optional(Type.String({ description: "报告文件路径（如 plans/…）" })),
			openIssues: Type.Optional(Type.Array(Type.String(), { description: "未决问题列表" })),
		}),
		renderCall(args, theme) {
			const color = args.status === "completed"
				? theme.fg("success", args.status)
				: args.status === "failed"
					? theme.fg("error", args.status)
					: theme.fg("warning", args.status);
			return new Text(`${theme.fg("toolTitle", theme.bold("tab-finish"))} ${color} ${theme.fg("dim", String(args.summary ?? "").slice(0, 40))}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			return new Text(result.isError ? theme.fg("error", text) : theme.fg("success", text), 0, 0);
		},
		async execute(_toolCallId, rawParams) {
			if (finished) {
				return { content: [{ type: "text", text: "tab-finish 已调用过，结果只写一次" }], isError: true };
			}
			const p = rawParams as Record<string, unknown>;
			const status = String(p.status ?? "");
			const summary = typeof p.summary === "string" ? p.summary.trim() : "";
			if (!["completed", "failed", "cancelled"].includes(status)) {
				return { content: [{ type: "text", text: `status 必须为 completed|failed|cancelled，得到 ${status}` }], isError: true };
			}
			if (!summary) {
				return { content: [{ type: "text", text: "summary 必填" }], isError: true };
			}
			const dispatch = readTabDispatch(runsDir, tabRunId);
			const raw: Record<string, unknown> = {
				id: tabRunId,
				taskId: dispatch?.taskId ?? "",
				status,
				finishedAt: new Date().toISOString(),
				summary,
				finalText: typeof p.finalText === "string" ? p.finalText.slice(0, 4000) : undefined,
				artifacts: Array.isArray(p.artifacts) ? p.artifacts.filter((a): a is string => typeof a === "string").slice(0, 50) : undefined,
				reportPath: typeof p.reportPath === "string" ? p.reportPath : undefined,
				openIssues: Array.isArray(p.openIssues) ? p.openIssues.filter((a): a is string => typeof a === "string").slice(0, 50) : undefined,
				usage: usageAccum.turns > 0 ? { ...usageAccum } : undefined,
			};
			const check = validateTabResult(raw);
			if (!check.ok || !check.value) {
				return { content: [{ type: "text", text: `结果校验失败: ${check.errors.join("; ")}` }], isError: true };
			}
			writeJsonAtomic(tabResultPath(runsDir, tabRunId), check.value);
			finished = true;
			// tab 侧也回报：本窗口用户可见（主会话侧由 event-bus 的 fs.watch 感知后再回报）
			try {
				sendWindowsToast({
					title: `${status === "completed" ? "✅" : "❌"} tab ${tabRunId} ${status}`,
					body: `${check.value.summary.slice(0, 100)}${check.value.artifacts?.length ? ` (${check.value.artifacts.length} artifacts)` : ""}`,
					duration: "long",
				});
			} catch { /* toast 失败不阻塞 */ }
			// 同步写终态 state（result 优先，state 仅作冗余）
			writeTabState(runsDir, tabRunId, {
				id: tabRunId,
				phase: status === "completed" ? "completed" : status === "failed" ? "failed" : "cancelled",
				turn: "idle",
				terminal: true,
				lastActivityAt: new Date().toISOString(),
				lastAssistantText: check.value.finalText ?? check.value.summary,
				usage: check.value.usage ? { ...check.value.usage } : undefined,
			});
			return { content: [{ type: "text", text: `✓ tab-finish ${status}: result written for ${tabRunId}` }] };
		},
	});

	// ── tab-report：tab 主动向主会话回报消息（反向注入通道）──
	pi.registerTool({
		name: "tab-report",
		label: "Tab Report",
		description: [
			"（标签页内部工具）主动向主会话回报消息：写入 ~/.pi/agent/reports/，主会话感知后注入用户消息被模型处理。",
			"用于工作完成、需要主会话决策/关注、或重要进展时主动联系主会话（不必等主会话轮询）。",
			"参数：message（回报内容）、可选 taskId / summary。from 取自本标签页 runId。",
		].join(" "),
		parameters: Type.Object({
			message: Type.String({ description: "回报消息（注入主会话的内容，≤1000 字符）" }),
			taskId: Type.Optional(Type.String({ description: "关联任务号" })),
			summary: Type.Optional(Type.String({ description: "简短摘要（≤200 字符）" })),
		}),
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("tab-report"))} ${theme.fg("accent", `→main`)} ${theme.fg("dim", String(args.message ?? "").slice(0, 40))}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			return new Text(result.isError ? theme.fg("error", text) : theme.fg("success", text), 0, 0);
		},
		async execute(_toolCallId, rawParams) {
			const p = rawParams as { message?: string; taskId?: string; summary?: string };
			const message = (p.message ?? "").trim();
			if (!message) {
				return { content: [{ type: "text", text: "message 必填" }], isError: true };
			}
			try {
				sendReportToMain({
					from: tabRunId,
					message: message.slice(0, 1000),
					taskId: p.taskId,
					summary: p.summary?.slice(0, 200),
				});
				return { content: [{ type: "text", text: `✓ 已向主会话回报（runId=${tabRunId}）` }] };
			} catch (err) {
				return { content: [{ type: "text", text: `回报失败: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
			}
		},
	});
}

function asUsageCost(usage: Record<string, unknown>): number | undefined {
	const cost = usage.cost;
	if (typeof cost === "number" && Number.isFinite(cost)) return cost;
	if (cost && typeof cost === "object" && typeof (cost as { total?: unknown }).total === "number") {
		return (cost as { total: number }).total;
	}
	return undefined;
}

// ── 主会话侧：tab-status / reclaim-tabs / /tabs ──────────────────

const TERMINAL_PHASES = new Set(["completed", "failed", "cancelled"]);

function viewToBrief(view: TabStatusView): Record<string, unknown> {
	return {
		runId: view.runId,
		taskId: view.dispatch?.taskId,
		title: view.dispatch?.title,
		phase: view.phase,
		turn: view.turn,
		terminal: view.terminal,
		resultMissing: view.resultMissing,
		dispatchStatus: view.dispatch?.dispatchStatus,
		source: view.source,
		lastStopReason: view.state?.lastStopReason,
		lastAssistantText: view.lastAssistantText?.slice(0, 300),
		usage: view.usage,
		sessionPath: view.state?.sessionPath,
		lastActivityAt: view.state?.lastActivityAt ?? view.dispatch?.dispatchedAt,
		result: view.result ? {
			status: view.result.status,
			summary: view.result.summary?.slice(0, 500),
			reportPath: view.result.reportPath,
			artifacts: view.result.artifacts,
			openIssues: view.result.openIssues,
		} : undefined,
	};
}

export { viewToBrief };

function classifyForReclaim(view: TabStatusView): "ready" | "pending" | "awaitingInput" | "failed" | "orphaned" {
	if (view.dispatch?.dispatchStatus === "launch_failed") return "failed";
	if (TERMINAL_PHASES.has(view.phase)) return view.resultMissing ? "pending" : "ready";
	if (view.phase === "awaitingInput" || view.phase === "waiting") return "awaitingInput";
	if (view.phase === "orphaned") return "orphaned";
	if (view.phase === "unconfirmed") return "failed";
	return "pending";
}

export { classifyForReclaim };

/**
 * 注册主会话侧回收工具：tab-status、reclaim-tabs、/tabs 命令。
 * 在所有进程注册（标签页内查自己、主会话查全部），子 agent 禁用。
 */
export function registerTabStatusTools(
	pi: ExtensionAPI,
	opts?: { runsDir?: string; sessionsRoot?: string },
): void {
	const runsDir = opts?.runsDir ?? defaultTabRunsDir();
	const sessionsRoot = opts?.sessionsRoot ?? defaultSessionsRoot();
	const isSubagent = process.env.PI_SUBAGENT === "1";
	const ownTabRunId = process.env.PI_TAB_RUN_ID;

	const scopedRunIds = (): string[] => {
		if (ownTabRunId) return [ownTabRunId];
		return listTabDispatches(runsDir).map((d) => d.id);
	};

	// ── tab-status ──
	pi.registerTool({
		name: "tab-status",
		label: "Tab Status",
		description: [
			"查询标签页回收状态：tab-status({ runId?, taskId?, includeText? })。",
			"返回结构化 records[]：runId/taskId/phase/turn/terminal/resultMissing/source/lastStopReason/usage/result 摘要。",
			"phase：dispatched|attached|working|waiting|completed|failed|cancelled|orphaned|unconfirmed。",
			"判态优先级：显式结果文件 > 标签页遥测 state > 会话 JSONL 保守探活；只有 completed/failed/cancelled 且 result 存在才是终态。",
		].join(" "),
		parameters: Type.Object({
			runId: Type.Optional(Type.String({ description: "指定 runId；缺省列出全部" })),
			taskId: Type.Optional(Type.String({ description: "按 taskId 过滤" })),
			includeText: Type.Optional(Type.Boolean({ description: "返回 lastAssistantText" })),
		}),
		renderCall(args, theme) {
			const target = args.runId ?? args.taskId ?? "(all)";
			return new Text(`${theme.fg("toolTitle", theme.bold("tab-status"))} ${theme.fg("accent", target)}`, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const d = result.details as { records?: Array<Record<string, unknown>> } | undefined;
			const records = d?.records ?? [];
			if (!expanded) {
				const line = records.length
					? records.map((r) => `${r.phase}:${r.runId}${r.resultMissing ? "(noResult)" : ""}`).join(", ")
					: "(none)";
				return new Text(theme.fg("dim", `tab-status ${records.length}: ${line.slice(0, 150)}`), 0, 0);
			}
			const c = new Container();
			c.addChild(new Text(theme.fg("toolTitle", `tab-status (${records.length})`), 0, 0));
			for (const r of records) {
				c.addChild(new Spacer(1));
				c.addChild(new Text(`${r.phase} ${r.runId}${r.taskId ? ` task=${r.taskId}` : ""}${r.terminal ? " ✓terminal" : ""}${r.resultMissing ? " ⚠noResult" : ""}`, 0, 0));
				c.addChild(new Text(theme.fg("dim", `  src=${r.source} stop=${r.lastStopReason ?? "-"} ${String(r.lastAssistantText ?? "").slice(0, 80)}`), 0, 0));
				if (r.result && typeof r.result === "object") {
					c.addChild(new Text(theme.fg("dim", `  result=${(r.result as { status?: string }).status}: ${String((r.result as { summary?: string }).summary ?? "").slice(0, 80)}`), 0, 0));
				}
			}
			return c;
		},
		async execute(_toolCallId, rawParams) {
			if (isSubagent) return { content: [{ type: "text", text: "子 agent 中不可查询标签页回收" }], isError: true };
			const p = rawParams as { runId?: string; taskId?: string; includeText?: boolean };
			let ids = scopedRunIds();
			if (p.runId) ids = ids.filter((id) => id === p.runId);
			if (ids.length === 0 && p.runId) {
				// 指定 runId 但账本里没有 → 仍尝试直接组装（可能账本被清）
				ids = [p.runId];
			}
			if (p.taskId) {
				const dispatches = new Map(listTabDispatches(runsDir).map((d) => [d.id, d]));
				ids = ids.filter((id) => dispatches.get(id)?.taskId === p.taskId);
			}
			const records = ids.map((id) => viewToBrief(buildTabStatusView(runsDir, id, sessionsRoot)));
			if (records.length === 0) {
				return { content: [{ type: "text", text: "No tabs" }], details: { records: [] } };
			}
			const lines = records.map((r) => {
				const resultMissing = r.resultMissing ? " (resultMissing)" : "";
				const resultTag = r.result ? ` → ${(r.result as { status?: string }).status}` : "";
				return `${String(r.phase).padEnd(12)} ${r.runId}${r.taskId ? ` task=${r.taskId}` : ""}${resultMissing}${resultTag}`;
			});
			return { content: [{ type: "text", text: lines.join("\n") }], details: { records } };
		},
	});

	// ── reclaim-tabs ──
	pi.registerTool({
		name: "reclaim-tabs",
		label: "Reclaim Tabs",
		description: [
			"回收标签页结果并编排下一批：reclaim-tabs({ runIds, wait?, timeoutMs?, intervalMs?, includeText? })。",
			"wait=false：立即返回当前快照。wait=true：轮询直到全部终态（terminal 且结果存在）或超时；超时不杀进程、不伪造完成。",
			"返回 ready[]（终态可取结果）/ pending[]（进行中）/ awaitingInput[]（等待输入，非完成）/ failed[]（unconfirmed 或派发失败）/ orphaned[]。",
			"result 缺失的终态标 resultMissing=true + completion=unconfirmed，绝不静默当成功。",
		].join(" "),
		parameters: Type.Object({
			runIds: Type.Array(Type.String(), { description: "要回收的 runId 列表（launch-tabs 返回）" }),
			wait: Type.Optional(Type.Boolean({ description: "是否轮询等待终态（默认 true）" })),
			timeoutMs: Type.Optional(Type.Number({ description: `等待超时（默认 ${RECLAIM_DEFAULT_TIMEOUT_MS}，最大 ${RECLAIM_MAX_TIMEOUT_MS}）` })),
			intervalMs: Type.Optional(Type.Number({ description: `轮询间隔（默认 ${RECLAIM_DEFAULT_INTERVAL_MS}）` })),
			includeText: Type.Optional(Type.Boolean({ description: "返回 lastAssistantText" })),
		}),
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("reclaim-tabs"))} ${theme.fg("accent", `${args.runIds.length} tabs`)}${args.wait === false ? theme.fg("dim", " (snapshot)") : ""}`, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const d = result.details as { ready?: unknown[]; pending?: unknown[]; awaitingInput?: unknown[]; failed?: unknown[]; orphaned?: unknown[]; timedOut?: boolean } | undefined;
			if (!d) return new Text("", 0, 0);
			const summary = `ready=${d.ready?.length ?? 0} pending=${d.pending?.length ?? 0} awaitingInput=${d.awaitingInput?.length ?? 0} failed=${d.failed?.length ?? 0} orphaned=${d.orphaned?.length ?? 0}${d.timedOut ? " ⏱timedOut" : ""}`;
			if (!expanded) return new Text(theme.fg(d.timedOut ? "warning" : "success", `reclaim-tabs: ${summary}`), 0, 0);
			const c = new Container();
			c.addChild(new Text(theme.fg("toolTitle", `reclaim-tabs: ${summary}`), 0, 0));
			for (const [label, group] of [["ready", d.ready], ["pending", d.pending], ["awaitingInput", d.awaitingInput], ["failed", d.failed], ["orphaned", d.orphaned]] as const) {
				if (!group || group.length === 0) continue;
				c.addChild(new Spacer(1));
				c.addChild(new Text(theme.fg("accent", label), 0, 0));
				for (const item of group as Array<Record<string, unknown>>) {
					c.addChild(new Text(theme.fg("dim", `  ${item.runId}${item.result ? ` → ${(item.result as { status?: string }).status}` : ""} ${String(item.lastAssistantText ?? "").slice(0, 60)}`), 0, 0));
				}
			}
			return c;
		},
		async execute(_toolCallId, rawParams) {
			if (isSubagent) return { content: [{ type: "text", text: "子 agent 中不可回收标签页" }], isError: true };
			const p = rawParams as { runIds?: string[]; wait?: boolean; timeoutMs?: number; intervalMs?: number; includeText?: boolean };
			const runIds = (p.runIds ?? []).filter((id) => typeof id === "string" && id);
			if (runIds.length === 0) return { content: [{ type: "text", text: "runIds 必填" }], isError: true };

			const wait = p.wait !== false;
			const timeoutMs = Math.min(p.timeoutMs ?? RECLAIM_DEFAULT_TIMEOUT_MS, RECLAIM_MAX_TIMEOUT_MS);
			const intervalMs = Math.max(500, p.intervalMs ?? RECLAIM_DEFAULT_INTERVAL_MS);

			const snapshot = (): Map<string, TabStatusView> => {
				const map = new Map<string, TabStatusView>();
				for (const id of runIds) map.set(id, buildTabStatusView(runsDir, id, sessionsRoot));
				return map;
			};

			const deadline = Date.now() + timeoutMs;
			let views = snapshot();
			if (wait) {
				while (Date.now() < deadline) {
					const allTerminal = [...views.values()].every((v) => TERMINAL_PHASES.has(v.phase) && !v.resultMissing);
					if (allTerminal) break;
					await sleep(intervalMs);
					views = snapshot();
				}
			}

			const groups = { ready: [] as Record<string, unknown>[], pending: [] as Record<string, unknown>[], awaitingInput: [] as Record<string, unknown>[], failed: [] as Record<string, unknown>[], orphaned: [] as Record<string, unknown>[] };
			let timedOut = false;
			for (const view of views.values()) {
				const kind = classifyForReclaim(view);
				const brief = viewToBrief(view);
				if (TERMINAL_PHASES.has(view.phase) && !view.resultMissing) brief.completion = "confirmed";
				else if (TERMINAL_PHASES.has(view.phase)) brief.completion = "unconfirmed";
				groups[kind].push(brief);
				if (kind === "pending" || kind === "awaitingInput" || kind === "orphaned") {
					if (Date.now() >= deadline && wait) timedOut = true;
				}
			}
			const summary = `ready=${groups.ready.length} pending=${groups.pending.length} awaitingInput=${groups.awaitingInput.length} failed=${groups.failed.length} orphaned=${groups.orphaned.length}${timedOut ? " timedOut" : ""}`;
			return {
				content: [{
					type: "text",
					text: `reclaim-tabs: ${summary}\n\n` + [
						groups.ready.length ? `ready:\n${groups.ready.map((r) => `  ✓ ${r.runId}${r.result ? ` → ${(r.result as { status?: string }).status}: ${String((r.result as { summary?: string }).summary ?? "").slice(0, 120)}` : ""}`).join("\n")}` : "",
						groups.awaitingInput.length ? `awaitingInput:\n${groups.awaitingInput.map((r) => `  ⏳ ${r.runId} (等待输入，不是完成)`).join("\n")}` : "",
						groups.failed.length ? `failed:\n${groups.failed.map((r) => `  ✗ ${r.runId}${r.result ? ` → ${(r.result as { status?: string }).status}` : " (unconfirmed/launch_failed)"}`).join("\n")}` : "",
						groups.pending.length ? `pending:\n${groups.pending.map((r) => `  … ${r.runId}`).join("\n")}` : "",
						groups.orphaned.length ? `orphaned:\n${groups.orphaned.map((r) => `  ☠ ${r.runId}`).join("\n")}` : "",
					].filter(Boolean).join("\n"),
				}],
				details: { ...groups, timedOut },
				isError: timedOut && groups.ready.length === 0,
			};
		},
	});

	// ── /tabs 命令 ──
	pi.registerCommand("tabs", {
		description: "列出标签页回收状态（人类视角）",
		handler: async (_args, ctx) => {
			if (isSubagent) {
				ctx.ui.notify("子 agent 中不可查看标签页", "warning");
				return;
			}
			const ids = scopedRunIds();
			if (ids.length === 0) {
				ctx.ui.notify("No tabs dispatched", "info");
				return;
			}
			const lines = ids.map((id) => {
				const view = buildTabStatusView(runsDir, id, sessionsRoot);
				const resultMissing = view.resultMissing ? " ⚠noResult" : "";
				const resultTag = view.result ? ` → ${view.result.status}` : "";
				return `${view.phase.padEnd(12)} ${id}${view.dispatch?.taskId ? ` task=${view.dispatch.taskId}` : ""}${resultMissing}${resultTag}  ${String(view.lastAssistantText ?? "").slice(0, 40)}`;
			});
			ctx.ui.notify(`Tabs (${ids.length}):\n${lines.join("\n")}`, "info");
		},
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 派发列表助手（供 /tabs 与 smoke 使用）。 */
export function listDispatchesForDebug(): TabDispatchRecord[] {
	return listTabDispatches(defaultTabRunsDir());
}
