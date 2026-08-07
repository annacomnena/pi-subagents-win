/**
 * timers-runtime — 计时器进程内调度器 + set/cancel/list 工具 + /timers 命令
 *
 * 阶段 1：target="self" 端到端跑通（主会话设 timer → 到期自动注入用户消息推进）。
 *
 * 所有权规则：
 *   - 主会话（无 PI_TAB_RUN_ID、无 PI_SUBAGENT）→ 拥有根目录 timers/*.json，
 *     可给任意 tab 写邮箱 timers/mail/<tabRunId>/*.json
 *   - 标签页（有 PI_TAB_RUN_ID）→ 只拥有并消费自己的邮箱（阶段 2 由 launch 注入 env）
 *   - 子 agent（PI_SUBAGENT=1）→ 不调度、不设 timer（一次性进程，无意义）
 *
 * 到期动作：CAS claim（防双发）→ repeat 重置 → pi.sendUserMessage(内容, followUp)。
 * 忙碌会话 followUp 排队，不打断当前工具循环；空闲会话立即触发新回合。
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	MAX_PENDING_TIMERS,
	cancelTimerFile,
	casFireTimer,
	collectDueTimers,
	countPending,
	defaultTimersDir,
	dueAtFromDelay,
	mailboxDirForTab,
	readAllTimers,
	validateTimerRecord,
	writeTimerAtomic,
	type TimerRecord,
} from "./timers.ts";

const TICK_MS = 5000; // 调度器 tick；MIN_REPEAT_MS(10000) 必须 > 本值（P2-4）
const STARTUP_FIRE_DELAY_MS = 1500;

interface FireOutcome {
	fired: boolean;
	record?: TimerRecord;
	reason?: string;
}

/** 调度器单次 pump：到期即 CAS claim → repeat 重置 → sendUserMessage 注入。 */
export function pumpDueTimers(
	pi: Pick<ExtensionAPI, "sendUserMessage">,
	timersDir: string,
	ownTabRunId?: string,
): FireOutcome[] {
	const scanScope = ownTabRunId ? { tabRunId: ownTabRunId } : undefined;
	const outcomes: FireOutcome[] = [];
	for (const due of collectDueTimers(timersDir, scanScope)) {
		outcomes.push(fireOneTimer(pi, timersDir, due, ownTabRunId));
	}
	return outcomes;
}

function fireOneTimer(
	pi: Pick<ExtensionAPI, "sendUserMessage">,
	timersDir: string,
	record: TimerRecord,
	ownTabRunId?: string,
): FireOutcome {
	// 1) CAS claim：已 fired/cancelled 则跳过（防双发）
	const claimed = casFireTimer(timersDir, record.id, { tabRunId: ownTabRunId });
	if (!claimed) return { fired: false, reason: "already terminal" };

	// 2) repeat：重置 dueAt 写回 pending（P2-3：保留 fireCount/lastFiredAt 历史）
	if (record.repeatMs) {
		const next: TimerRecord = {
			...record,
			status: "pending",
			dueAt: dueAtFromDelay(record.repeatMs),
			firedAt: undefined,
			firedLate: undefined,
			fireCount: (record.fireCount ?? 0) + 1,
			lastFiredAt: claimed.firedAt ?? claimed.lastFiredAt,
		};
		writeTimerAtomic(timersDir, next, { tabRunId: ownTabRunId });
	}

	// 3) 注入用户消息推进工作（followUp：忙碌时排队，不打断工具循环）
	const label = record.label ? ` (${record.label})` : "";
	const late = claimed.firedLate ? " [晚发]" : "";
	const content = `⏰ Timer fired${label}${late}: ${record.message}`;
	try {
		pi.sendUserMessage(content, { deliverAs: "followUp" });
	} catch (err) {
		console.error(`[timers] fire failed for ${record.id}:`, err);
		return { fired: false, reason: err instanceof Error ? err.message : String(err) };
	}
	return { fired: true, record: claimed };
}

/**
 * 注册计时器调度器与工具。
 * 调用点：主扩展入口（index.ts default 内）。
 */
export function registerTimers(pi: ExtensionAPI): void {
	const timersDir = defaultTimersDir();

	// 本进程身份
	const isSubagent = process.env.PI_SUBAGENT === "1";
	const ownTabRunId = process.env.PI_TAB_RUN_ID; // 阶段 2 前通常 undefined

	// ── 进程内调度器（子 agent 不调度）──
	if (!isSubagent) {
		const tick = (): void => {
			try {
				pumpDueTimers(pi, timersDir, ownTabRunId);
			} catch (err) {
				console.error("[timers] tick failed:", err);
			}
		};

		// 启动稍后先补发一次（处理 pi 未运行期间到期的 timer → firedLate）
		const bootTimer = setTimeout(tick, STARTUP_FIRE_DELAY_MS);
		bootTimer.unref?.();
		const interval = setInterval(tick, TICK_MS);
		interval.unref?.();
	}

	// ── 写目标解析：主会话 → 根目录（self）或邮箱（tab）；标签页 → 仅自己邮箱 ──
	const resolveWriteScope = (
		target: string | { tabRunId?: string; taskId?: string } | undefined,
	): { tabRunId?: string } | { error: string } => {
		if (ownTabRunId) {
			// 标签页：只允许 self 或自己
			if (target === undefined || target === "self") return {};
			const t = target as { tabRunId?: string };
			if (t.tabRunId === ownTabRunId) return { tabRunId: ownTabRunId };
			return { error: "标签页只能给自己设 timer；给其他 tab 设 timer 请用主会话" };
		}
		if (typeof target === "object" && target && (target as { tabRunId?: string }).tabRunId) {
			return { tabRunId: (target as { tabRunId: string }).tabRunId };
		}
		return {};
	};

	// ── 工具：set-timer ──
	pi.registerTool({
		name: "set-timer",
		label: "Set Timer",
		description: [
			"设置一个计时器：到期后系统自动向目标会话发送一条用户消息，推进工作（超长程任务基础设施）。",
			"参数：message（到期自动发送的推进指令，≤2048 字符）；delayMs 或 dueAt（ISO，二选一）；target 缺省 self（当前会话）；也可传 { tabRunId, taskId? } 指向某标签页邮箱（仅主会话可写其他 tab）；label 可读说明；repeatMs ≥10000 可周期重发。",
			"到期后消息以用户消息形态注入，TUI 可见、可人工接管；会话忙碌时自动排队不打断工具循环。",
			"单进程最多 50 个 pending timer。",
		].join(" "),
		parameters: Type.Object({
			message: Type.String({ description: "到期自动发送的用户消息（推进指令），≤2048 字符" }),
			delayMs: Type.Optional(Type.Number({ description: "延时毫秒（与 dueAt 二选一）" })),
			dueAt: Type.Optional(Type.String({ description: "到期 ISO 时间（与 delayMs 二选一）" })),
			target: Type.Optional(Type.Union([
				Type.Literal("self"),
				Type.Object({
					tabRunId: Type.String({ description: "目标标签页 runId" }),
					taskId: Type.Optional(Type.String()),
				}),
			], { description: "缺省 self（当前会话）；{tabRunId} 指向标签页邮箱" })),
			label: Type.Optional(Type.String({ description: "可读说明" })),
			repeatMs: Type.Optional(Type.Number({ description: "周期重发间隔（≥10000ms）" })),
		}),
		renderCall(args, theme) {
			const label = args.label ? ` ${theme.fg("muted", args.label)}` : "";
			const target = typeof args.target === "object" && args.target?.tabRunId
				? theme.fg("accent", `→tab:${args.target.tabRunId}`)
				: theme.fg("accent", "→self");
			const when = args.delayMs
				? `${Math.round(args.delayMs / 1000)}s`
				: typeof args.dueAt === "string" ? args.dueAt.slice(11, 19) : "?";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("set-timer"))} ${target} ${theme.fg("dim", `⏱${when}`)}${label} ${theme.fg("dim", String(args.message).slice(0, 40))}`,
				0, 0,
			);
		},
		renderResult(result, _options, theme) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			if (result.isError) return new Text(theme.fg("error", text), 0, 0);
			return new Text(theme.fg("success", text), 0, 0);
		},
		async execute(_toolCallId, rawParams) {
			const p = rawParams as Record<string, unknown>;
			const message = typeof p.message === "string" ? p.message.trim() : "";
			const source = "set-timer";

			if (isSubagent) {
				return { content: [{ type: "text", text: "子 agent 中不可设置计时器" }], isError: true };
			}
			if (!message) {
				return { content: [{ type: "text", text: "message 必填" }], isError: true };
			}

			// 二选一：delayMs / dueAt
			let dueAt: string;
			const hasDelay = typeof p.delayMs === "number" && Number.isFinite(p.delayMs);
			const hasDue = typeof p.dueAt === "string";
			if (hasDelay === hasDue) {
				return { content: [{ type: "text", text: "delayMs 与 dueAt 必须且只能提供一个" }], isError: true };
			}
			if (hasDelay) {
				if (p.delayMs as number <= 0) return { content: [{ type: "text", text: "delayMs 必须 > 0" }], isError: true };
				dueAt = dueAtFromDelay(p.delayMs as number);
			} else {
				dueAt = p.dueAt as string;
				if (!Number.isFinite(Date.parse(dueAt))) {
					return { content: [{ type: "text", text: `dueAt 不是合法 ISO 时间: ${dueAt}` }], isError: true };
				}
			}

			// pending 上限
			const scope = resolveWriteScope(p.target as never);
			if ("error" in scope) return { content: [{ type: "text", text: scope.error }], isError: true };
			if (countPending(timersDir, scope.tabRunId) >= MAX_PENDING_TIMERS) {
				return { content: [{ type: "text", text: `pending timer 已达上限 ${MAX_PENDING_TIMERS}` }], isError: true };
			}

			const raw: Record<string, unknown> = {
				id: `timer_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
				version: 1,
				dueAt,
				message,
				target: p.target ?? "self",
				source,
				label: typeof p.label === "string" && p.label.trim() ? p.label.trim() : undefined,
				repeatMs: p.repeatMs,
				status: "pending",
				createdAt: new Date().toISOString(),
			};
			const check = validateTimerRecord(raw);
			if (!check.ok || !check.value) {
				return { content: [{ type: "text", text: `timer 校验失败: ${check.errors.join("; ")}` }], isError: true };
			}
			writeTimerAtomic(timersDir, check.value, { tabRunId: scope.tabRunId });
			const where = scope.tabRunId ? `tab:${scope.tabRunId}` : "self";
			return {
				content: [{
					type: "text",
					text: `⏰ Timer set: ${check.value.id}\n  target=${where} dueAt=${dueAt}${check.value.repeatMs ? ` repeat=${check.value.repeatMs}ms` : ""}\n  message=${message.slice(0, 100)}`,
				}],
			};
		},
	});

	// ── 工具：cancel-timer ──
	pi.registerTool({
		name: "cancel-timer",
		label: "Cancel Timer",
		description: "取消一个 pending 计时器：cancel-timer({ timerId })；主会话可加 tabRunId 取消某标签页邮箱里的 timer。已触发/已取消返回 not-found。",
		parameters: Type.Object({
			timerId: Type.String({ description: "timer id（set-timer 返回值）" }),
			tabRunId: Type.Optional(Type.String({ description: "目标标签页邮箱（仅主会话）" })),
		}),
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("cancel-timer"))} ${theme.fg("dim", args.timerId)}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			return new Text(result.isError ? theme.fg("error", text) : theme.fg("success", text), 0, 0);
		},
		async execute(_toolCallId, rawParams) {
			const p = rawParams as { timerId?: string; tabRunId?: string };
			if (isSubagent) return { content: [{ type: "text", text: "子 agent 中不可操作计时器" }], isError: true };
			const timerId = (p.timerId ?? "").trim();
			if (!timerId) return { content: [{ type: "text", text: "timerId 必填" }], isError: true };

			// 标签页只能取消自己的邮箱；主会话可显式指定 tabRunId
			const scope = resolveWriteScope(p.tabRunId ? { tabRunId: p.tabRunId } : undefined);
			if ("error" in scope) return { content: [{ type: "text", text: scope.error }], isError: true };

			const cancelled = cancelTimerFile(timersDir, timerId, scope.tabRunId);
			if (!cancelled) {
				return { content: [{ type: "text", text: `timer ${timerId} 不存在或已终态（fired/cancelled）` }], isError: true };
			}
			return { content: [{ type: "text", text: `✗ Timer cancelled: ${timerId}` }] };
		},
	});

	// ── 工具：list-timers ──
	pi.registerTool({
		name: "list-timers",
		label: "List Timers",
		description: "列出计时器：list-timers({ status?, tabRunId? })。返回每条的 id / dueAt / 剩余毫秒 / status / label / message 截断。缺省列出当前进程拥有的全部（self + 本 tab 邮箱）。",
		parameters: Type.Object({
			status: Type.Optional(Type.String({ description: "过滤：pending|fired|cancelled" })),
			tabRunId: Type.Optional(Type.String({ description: "查看某标签页邮箱（仅主会话）" })),
		}),
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("list-timers"))}${args.status ? theme.fg("dim", ` [${args.status}]`) : ""}`, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const d = result.details as { timers?: Array<Record<string, unknown>> } | undefined;
			const timers = d?.timers ?? [];
			if (!expanded) {
				const line = timers.length
					? timers.map((t) => `${t.status}:${t.id}${t.label ? `(${t.label})` : ""}`).join(", ")
					: "(no timers)";
				return new Text(theme.fg("dim", `list-timers ${timers.length}: ${line.slice(0, 120)}`), 0, 0);
			}
			const c = new Container();
			c.addChild(new Text(theme.fg("toolTitle", `list-timers (${timers.length})`), 0, 0));
			for (const t of timers) {
				c.addChild(new Spacer(1));
				c.addChild(new Text(`${t.status} ${t.id}${t.label ? ` (${t.label})` : ""}`, 0, 0));
				c.addChild(new Text(theme.fg("dim", `  due=${t.dueAt} remaining=${t.remainingMs}ms msg=${String(t.message ?? "").slice(0, 60)}`), 0, 0));
			}
			return c;
		},
		async execute(_toolCallId, rawParams, _signal, _onUpdate, _ctx) {
			const p = rawParams as { status?: string; tabRunId?: string };
			if (isSubagent) return { content: [{ type: "text", text: "子 agent 中不可操作计时器" }], isError: true };
			const filter = p.status as TimerRecord["status"] | undefined;
			const scope = resolveWriteScope(p.tabRunId ? { tabRunId: p.tabRunId } : undefined);
			if ("error" in scope) return { content: [{ type: "text", text: scope.error }], isError: true };

			const now = Date.now();
			const all = readAllTimers(timersDir, scope.tabRunId).filter((t) =>
				!filter || t.status === filter,
			);
			const timers = all.map((t) => ({
				id: t.id,
				status: t.status,
				dueAt: t.dueAt,
				remainingMs: Date.parse(t.dueAt) - now,
				label: t.label,
				message: t.message.slice(0, 120),
				repeatMs: t.repeatMs,
			}));
			if (timers.length === 0) {
				return { content: [{ type: "text", text: "No timers" }], details: { timers: [] } };
			}
			const lines = timers.map((t) =>
				`${t.status.padEnd(9)} ${t.id}${t.label ? ` (${t.label})` : ""}  due=${t.dueAt}  remaining=${t.remainingMs}ms  msg=${t.message}`,
			);
			return { content: [{ type: "text", text: lines.join("\n") }], details: { timers } };
		},
	});

	// ── 命令：/timers ──
	pi.registerCommand("timers", {
		description: "列出当前进程的计时器（人类视角）",
		handler: async (args, ctx) => {
			if (isSubagent) {
				ctx.ui.notify("子 agent 中不可操作计时器", "warning");
				return;
			}
			const filterRaw = (args ?? "").trim();
			// P2-6：校验 filter 集合，非法时提示用法
			const validFilters: TimerRecord["status"][] = ["pending", "fired", "cancelled", "missed"];
			if (filterRaw && !validFilters.includes(filterRaw as TimerRecord["status"])) {
				ctx.ui.notify(`用法: /timers [pending|fired|cancelled|missed]`,"warning");
				return;
			}
			const filter = filterRaw as TimerRecord["status"] | "";
			const all = readAllTimers(timersDir, ownTabRunId).filter((t) => !filter || t.status === filter);
			if (all.length === 0) {
				ctx.ui.notify(`No timers${filter ? ` (${filter})` : ""}`, "info");
				return;
			}
			const now = Date.now();
			const lines = all.map((t) => {
				const rem = Date.parse(t.dueAt) - now;
				return `${t.status.padEnd(9)} ${t.id}${t.label ? ` (${t.label})` : ""}  due=${t.dueAt}  ${rem >= 0 ? `${Math.ceil(rem / 1000)}s 后` : "已到期"}  ${t.message.slice(0, 60)}`;
			});
			ctx.ui.notify(`Timers (${all.length}):\n${lines.join("\n")}`, "info");
		},
	});
}

/** 供 /timers 或调试使用：当前进程拥有的 timer 目录。 */
export function ownedTimersDir(): string {
	return process.env.PI_TAB_RUN_ID
		? mailboxDirForTab(defaultTimersDir(), process.env.PI_TAB_RUN_ID)
		: defaultTimersDir();
}
