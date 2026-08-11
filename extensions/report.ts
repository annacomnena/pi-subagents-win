/**
 * report — tab → 主会话 的主动回报通道
 *
 * 与「主会话 → tab 邮箱注入」（timers/mail/）反向对称：
 * tab 在工作完成（或任何需要主会话关注时）调用 tab-report 写一份回报文件，
 * 主会话 fs.watch（+ tick 兜底）感知后注入一条用户消息，模型被唤醒处理。
 *
 * 文件：~/.pi/agent/reports/<ts>_<rand>.json（原子写，追加式目录，崩溃安全）
 * 回报内容：{ from(会话身份), message, taskId?, summary?, at, pid }
 *
 * 只主会话注册监听（标签页/子 agent 不注册，避免重复注入）；
 * 去重：启动时快照已有报告视为已处理，只对启动后新出现的注入。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, renameSync, watch, writeFileSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sendWindowsToast } from "./notify-windows.ts";
import { getCurrentSessionId, isMainSession, setCurrentSessionId } from "./identity.ts";
import { defaultLinksPath, listLinks } from "./links.ts";

export interface ReportRecord {
	/** 回报方身份：tab_<runId> 或 sessionId。 */
	from: string;
	/** 回报消息（注入主会话的用户消息内容）。 */
	message: string;
	taskId?: string;
	summary?: string;
	at: string;
	pid: number;
}

export function defaultReportsDir(agentDir: string = join(homedir(), ".pi", "agent")): string {
	return join(agentDir, "reports");
}

/** 写一份回报（原子：tmp + rename）。由 tab 侧调用。 */
export function sendReportToMain(
	opts: { from: string; message: string; taskId?: string; summary?: string },
	reportsDir: string = defaultReportsDir(),
): string {
	const id = `report_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
	const record: ReportRecord = {
		from: opts.from,
		message: opts.message,
		taskId: opts.taskId,
		summary: opts.summary,
		at: new Date().toISOString(),
		pid: process.pid,
	};
	if (!existsSync(reportsDir)) mkdirSync(reportsDir, { recursive: true });
	const file = join(reportsDir, `${id}.json`);
	writeFileSync(`${file}.tmp`, JSON.stringify(record, null, 2) + "\n", "utf8");
	renameSync(`${file}.tmp`, file);
	return id;
}

/**
 * 回报的预期接收会话 UUID：
 *   - from 为 tab runId → 查 links.jsonl（kind=tab，targetId=from）拿派发方会话；
 *   - from 本身是 sessionId → 直接视为接收方；
 *   - 解析不到 → undefined（不消费：宁可留在 reports/ 等人工 / 编排会话处理）。
 *
 * 修复 2026-08-11：此前任何 identityless 进程都能抢回报（.notified 只去重不定位），
 * 导致 task 238 的回报落到无关目录的会话。
 */
export function recipientSessionIdFor(record: Pick<ReportRecord, "from">, linksPath: string = defaultLinksPath()): string | undefined {
	const from = record.from;
	if (!from) return undefined;
	if (!from.startsWith("tab_")) {
		// sessionId 形态：直接作为接收方
		return /^[0-9a-f-]{8,}$/i.test(from) ? from : undefined;
	}
	// tab runId：找最近一次派发记录
	for (const link of listLinks(linksPath)) {
		if (link.kind === "tab" && link.targetId === from && link.sessionId && link.sessionId !== "unknown") {
			return link.sessionId;
		}
	}
	return undefined;
}

/** 读取一份回报；缺失/损坏返回 null。 */
export function readReportFile(reportsDir: string, id: string): ReportRecord | null {
	const file = join(reportsDir, `${id}.json`);
	if (!existsSync(file)) return null;
	try {
		const raw = JSON.parse(readFileSync(file, "utf8"));
		return raw && typeof raw === "object" && typeof raw.message === "string" && typeof raw.from === "string"
			? (raw as ReportRecord)
			: null;
	} catch {
		return null;
	}
}

/** 列出目录下全部回报 id（按文件名）。 */
export function listReportIds(reportsDir: string): string[] {
	if (!existsSync(reportsDir)) return [];
	return readdirSync(reportsDir)
		.filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"))
		.map((f) => f.slice(0, -".json".length));
}

// ── 主会话监听 ───────────────────────────────────────────────────

let seenReports = new Set<string>();
let watcher: FSWatcher | null = null;
let selfDisabled = false; // 旧实例 stale 后停止注入

/** 启动时快照：已有报告视为已处理（重启不重复注入）。 */
function snapshotExisting(reportsDir: string): void {
	seenReports = new Set<string>();
	for (const id of listReportIds(reportsDir)) seenReports.add(id);
}

export interface ReportListenerOptions {
	reportsDir?: string;
	/** 会话定位用的 links 路径（测试注入；缺省 ~/.pi/agent/links.jsonl）。 */
	linksPath?: string;
	/** 注入用户消息的实现（由 registerReportListener 绑定 pi.sendUserMessage）。 */
	sendUserMessage?: (content: string, opts?: { deliverAs?: string }) => void;
	/** 供测试注入的钩子：新回报出现时回调（替代 sendUserMessage/toast）。 */
	onReport?: (record: ReportRecord, id: string) => void;
	/** 完成时 toast（默认 true）。 */
	toast?: boolean;
}

/** 原子领取「已消费」标记（跨进程/跨实例幂等，根治双 watcher 双注入）。 */
export function claimReportNotified(reportsDir: string, id: string): boolean {
	try {
		const fd = openSync(join(reportsDir, `${id}.notified`), "wx");
		try { closeSync(fd); } catch { /* ignore */ }
		return true;
	} catch {
		return false;
	}
}

/** 处理一份新回报（幂等 + 跨实例去重 + 会话定位）。返回是否已注入。 */
export function onNewReport(reportsDir: string, id: string, opts: ReportListenerOptions): boolean {
	if (selfDisabled) return false; // 旧实例已失效
	if (seenReports.has(id)) return false;
	seenReports.add(id);
	const record = readReportFile(reportsDir, id);
	if (!record) return false;

	if (opts.onReport) {
		opts.onReport(record, id);
		return true;
	}

	// 会话定位：只消费派发给「当前会话」的回报（不同目录的 identityless 进程不得抢）
	const recipient = recipientSessionIdFor(record, opts.linksPath);
	const mySession = getCurrentSessionId();
	if (!recipient || !mySession || recipient !== mySession) {
		return false; // 不是本会话的回报 → 不 claim、不注入（留给真正的编排会话）
	}

	// 跨实例幂等：原子领取消费权（双 watcher/双实例只有第一个注入）
	if (!claimReportNotified(reportsDir, id)) {
		return false; // 已被其他实例消费 → 静默跳过
	}

	if (opts.toast !== false) {
		sendWindowsToast({
			title: `📨 ${record.from} 回报`,
			body: `${record.message.slice(0, 100)}${record.summary ? ` — ${record.summary.slice(0, 60)}` : ""}`,
			duration: "long",
		});
	}

	try {
		opts.sendUserMessage?.(
			`📨 ${record.from} 主动回报：${record.message}${record.taskId ? `\ntask=${record.taskId}` : ""}${record.summary ? `\n摘要: ${record.summary}` : ""}\n请处理这份回报并决定下一步。`,
			{ deliverAs: "followUp" },
		);
	} catch {
		selfDisabled = true; // 旧实例 stale → 停止注入
	}
	return true;
}

/** 扫描目录里所有新回报（tick 兜底）。返回处理的 id 列表。 */
export function pollNewReports(reportsDir: string, opts: ReportListenerOptions): string[] {
	const fired: string[] = [];
	for (const id of listReportIds(reportsDir)) {
		if (!seenReports.has(id) && onNewReport(reportsDir, id, opts)) fired.push(id);
	}
	return fired;
}

/** 注册主会话监听：fs.watch + tick 兜底。返回清理函数。 */
export function registerReportListener(pi: ExtensionAPI, opts: ReportListenerOptions = {}): () => void {
	// 工厂入口重置模块状态（P1：reload 重跑工厂时不继承旧实例的 selfDisabled/seen*）
	_resetReportListener();
	const reportsDir = opts.reportsDir ?? defaultReportsDir();

	// 延迟到 session_start 再判定身份并启动监听：
	// CLI flag 在扩展加载完成后才就绪；只主会话消费（标签页/子 agent 只发送）。
	let interval: ReturnType<typeof setInterval> | null = null;
	let sessionGen = 0; // gen token：过期周期的排队回调 no-op，绝不用旧 pi
	pi.on("session_start", (_event, ctx) => {
		if (!isMainSession()) return;
		// 捕获当前会话 UUID（回报会话定位的依据）
		try {
			setCurrentSessionId((ctx as { sessionManager?: { sessionId?: string } } | undefined)?.sessionManager?.sessionId);
		} catch { /* ctx 不可用则保持 undefined（不消费任何回报，宁可静默） */ }

		const myGen = ++sessionGen;
		const closed = (): boolean => myGen !== sessionGen;
		if (interval) clearInterval(interval); // 上次周期的 interval 引用不可再依赖

		snapshotExisting(reportsDir);
		const fullOpts: ReportListenerOptions = {
			...opts,
			reportsDir,
			sendUserMessage: pi.sendUserMessage?.bind(pi),
		};

		if (existsSync(reportsDir)) {
			try {
				watcher = watch(reportsDir, (_event, fileName) => {
					if (closed()) return;
					if (typeof fileName === "string") {
						const id = fileName.endsWith(".json") ? fileName.slice(0, -".json".length) : fileName;
						onNewReport(reportsDir, id, fullOpts);
					}
				});
			} catch {
				watcher = null;
			}
		}

		// tick 兜底（Windows fs.watch 偶发丢事件）
		interval = setInterval(() => {
			if (closed()) return;
			pollNewReports(reportsDir, fullOpts);
		}, 5000);
		interval.unref?.();
	});

	return () => {
		sessionGen++; // 使当前周期 closed → 排队回调 no-op
		try {
			watcher?.close();
		} catch { /* ignore */ }
		watcher = null;
		if (interval) clearInterval(interval);
	};
}

/** 供测试重置内部状态。 */
export function _resetReportListener(): void {
	seenReports = new Set<string>();
	selfDisabled = false;
	try {
		watcher?.close();
	} catch { /* ignore */ }
	watcher = null;
}
