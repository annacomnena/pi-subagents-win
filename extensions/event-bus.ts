/**
 * event-bus — 文件即总线的 fs.watch 事件层（主会话）
 *
 * 让「tab 完成」从轮询（10s tick）变为事件驱动（亚秒级感知）：
 * watch ~/.pi/agent/tab-runs/ 目录，检测到新的 *.result.json →
 *   - toast 通知（人可见）
 *   - 注入一条用户消息唤醒模型去 reclaim（无人值守接力）
 *   - 刷新 async 面板/状态栏（如适用）
 *
 * 设计约束：
 *   - 注册条件 ownership-gated（Phase 5.6，修「tab 承载 owner 唤醒链断裂」）：
 *     cutover 启用 + 有 attachment 时「owner 是谁谁 watch」——仅当前 logical master 的
 *     承载会话注册（主会话若恰为 owner 同样走此路）；本会话 attach 成 owner 时由
 *     master-attach 触发 triggerOwnershipRecheck 补注册（succession 后继 tab 在
 *     session_start 之后才成 owner，一次性判定会漏注册）。cutover 未启用/无 registry 时
 *     legacy 回退 isMainSession()（零变化）；子 agent 恒不注册。
 *   - 注入前 fencing（Phase 5.6）：onTabResultFile 处理前重读 attachment，watch 期间易主
 *     （本会话不再是 owner）→ 静默放弃（不 journal、不 mailbox、不注入）。
 *   - transfer 窗口补偿（Phase 5.6b，修「fencing 放弃 + 新 owner snapshot 标 seen → 完成通知永久丢失」）：
 *     旧 owner 的 watcher fencing 放弃时**不创建 .notified**；新 owner 经 master-attach 补注册 watcher
 *     （triggerOwnershipRecheck）时先对「已存在且无 .notified」的 result 补投一次（journal+mailbox+注入，
 *     均幂等），再 snapshot 标 seen——「journal 跟随 owner」，易主窗口不丢终态。
 *   - 去重：启动时把已存在的 result 视为"已处理"；只对启动后新出现的触发。
 *   - Windows fs.watch 偶发丢事件 → 保留 10s tick 兜底（见 async-panel / registerTabStatusTools）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { watch, type FSWatcher } from "node:fs";
import { existsSync, openSync, closeSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sendWindowsToast } from "./notify-windows.ts";
import { readTabResultFile } from "./tab-runs.ts";
import { emitRuntimeEventOnce } from "./runtime/journal.ts";
import { deliverLetterSafe } from "./runtime/mailbox.ts";
import { readAttachment, readCutover } from "./runtime/registry.ts";
import { masterAddress } from "./runtime/address.ts";
import { tabResultToReportLetter } from "./runtime/adapters/tab-run.ts";
import { auditSuppression, postInject, preInject, type InjectionContext } from "./injection-gate.ts";
import { runReceiptKey } from "./runtime/receipts.ts";
import { tabResultToRuntimeEvent } from "./runtime/adapters/tab-run.ts";
import { refreshAsyncPanel } from "./async-panel.ts";
import { getCurrentSessionId, isMainSession, isSubagent, setCurrentSessionId } from "./identity.ts";
import { defaultLinksPath } from "./links.ts";
import { NO_POLL_HINT } from "./no-poll.ts";
import { recipientSessionIdFor } from "./report.ts";

export const EVENT_BUS_WATCH_KEY = "subagent-event-bus";

const DEFAULT_TAB_RUNS_DIR = join(homedir(), ".pi", "agent", "tab-runs");

export interface EventBusOptions {
	runsDir?: string;
	/** 派发溯源用的 links 路径（测试注入；缺省 ~/.pi/agent/links.jsonl）。 */
	linksPath?: string;
	/** 完成时注入用户消息唤醒模型（默认 true）。 */
	autoReclaim?: boolean;
	/** 完成时 toast（默认 true）。 */
	toast?: boolean;
	/** 供测试注入的钩子：新 result 出现时回调（替代 sendUserMessage/toast）。 */
	onTabFinished?: (runId: string) => void;
	/** 注入用户消息的实现（由 registerEventBus 绑定 pi.sendUserMessage）。 */
	sendUserMessage?: (content: string, opts?: { deliverAs?: string }) => void;
}

let watcher: FSWatcher | null = null;
let seenResults = new Set<string>();
let selfDisabled = false; // 旧实例 stale 后停止注入，避免反复报错
let watcherGen = 0; // 每次 (重)建 / close watcher 自增；回调据此判 stale（防双 watcher / reload 死 watcher）
let startWatch: (() => void) | null = null; // 当前周期的"按需(重)启动 watch"闭包；owner 易主（master-attach）后由 triggerOwnershipRecheck 触发

/** 关掉在途 watcher 并使其回调 stale（watcherGen 自增）。 */
function closeWatcher(): void {
	watcherGen++;
	try {
		watcher?.close();
	} catch {
		/* ignore */
	}
	watcher = null;
}

/**
 * 是否应由本会话注册 result watcher（Phase 5.6：ownership-gated）。
 *  - cutover 未启用 / 无 attachment（registry 未激活）→ legacy 回退 isMainSession()（零变化）。
 *  - cutover 启用 + 有 attachment → "owner 是谁谁 watch"：仅当本会话就是当前 owner 才 watch。
 * 主会话若恰为 owner 同样走此路（不再靠 isMainSession 特判）；子 agent 恒不 watch。
 *
 * 子 agent 硬门（review §1 Must fix）：docstring 承诺「子 agent 恒不 watch」，此前却从未
 * 调用 isSubagent()——一个恰好捕获了等于某 registry attachment 的 sessionId 的子 agent
 * 在 cutover 下会被放行注册。故在 legacy / owner 两分支之前硬挡 isSubagent()（两种 ownership
 * 状态都不 watch），与 isMainSession() 内部的 !isSubagent 语义一致但显式前置。
 */
export function shouldRegisterWatcher(): boolean {
	if (isSubagent()) return false; // 子 agent 恒不 watch（legacy 回退 + cutover ownership 两路都不走）
	const cutover = readCutover();
	const attachment = readAttachment(masterAddress());
	if (!cutover?.enabled || !attachment) return isMainSession();
	const me = getCurrentSessionId();
	return me !== undefined && attachment.sessionId === me;
}

/**
 * 会话刚成为 owner（master-attach / /master-attach 成功）后由 master 侧调用：
 * 重查 ownership，若现在轮到本会话 watch 且尚未 watch → 补注册 watcher。
 * 覆盖「succession 后继 tab 在 session_start 之后才 attach 成 owner」——一次性 session_start
 * 判定（那时它还不是 owner）会漏注册，导致 result 落盘无人发现。幂等：已在 watch / 非 owner → no-op。
 */
export function triggerOwnershipRecheck(): void {
	startWatch?.();
}

/** 测试/调试：当前是否有活跃 result watcher。 */
/** 测试 teardown 钩子：关最后一个 watcher，保障测试进程退出（仅测试用，生产由 cleanup 返回值负责）。 */
export function closeWatcherForTests(): void {
	closeWatcher();
}

export function isEventBusWatching(): boolean {
	return watcher !== null;
}

/** 启动时快照：已存在的 result 视为已处理，避免重启后重复触发。 */
function snapshotExisting(runsDir: string): void {
	seenResults = new Set<string>();
	if (!existsSync(runsDir)) return;
	for (const f of readdirSync(runsDir)) {
		if (f.endsWith(".result.json")) seenResults.add(f);
	}
}

/**
 * Phase 5.6b transfer 窗口 / crash 补偿投递（review §3 Must fix）：
 *
 * 漏洞序列：旧 owner 持有 watcher → 易主期间某 `*.result.json` 落盘 → 旧 watcher 观察到
 * 后 fencing 发现已非 owner → 静默放弃（不 journal/不 mailbox/不 claimNotified，故**无 .notified**）
 * → 新 owner 经 triggerOwnershipRecheck 补注册 watcher，其 begin() 的 snapshotExisting 把该
 * 文件当作「启动历史」标记 seen → 无人再处理 → 完成通知永久丢失（原「留给新 owner 的 watcher」
 * 注释在此窗口下不成立）。
 *
 * 修复：新 owner 补注册 watcher 时（triggerOwnershipRecheck 路径），先对「已存在且从未投递
 * （无 .notified 持久标记）」的 result 补投一次（journal + mailbox + 注入），再 snapshot 标记 seen。
 *
 * 幂等（跨进程/跨实例，review §3 要求保留 restart dedupe）：
 *   - `.notified` 文件是跨进程「已投递」持久屏障——正常完成/已投递/重启去重的文件都有它 → 跳过；
 *     只有 fencing 放弃（未达 claimNotified）的丢失结果缺它 → 才补投。
 *   - journal 走 emitRuntimeEventOnce 的 dedupeKey、mailbox 走 dedupeId，重放不双写。
 *   - onTabResultFile 内部 fencing/recipient/claimNotified 均幂等，重放不会重复注入。
 * 仅 current owner（begin 已过 shouldRegisterWatcher 门）可产出 journal/mailbox/注入。
 */
function recoverUnnotifiedResults(runsDir: string, opts: EventBusOptions): void {
	if (!existsSync(runsDir)) return;
	for (const f of readdirSync(runsDir)) {
		if (!f.endsWith(".result.json")) continue;
		const runId = f.slice(0, -".result.json".length);
		if (existsSync(join(runsDir, `${runId}.notified`))) continue; // 已投递 → 重启/重放去重，不动
		seenResults.delete(f); // 撤销 begin() 的「启动历史」标记（无 .notified 说明从未投递，非历史）
		onTabResultFile(runsDir, f, opts); // 补投（内部 fencing/claim/journal 均幂等）
	}
}

/**
 * 原子领取「已通知」标记：跨进程/跨实例幂等——无论多少个 watcher/实例
 * （reload 后旧 watcher 未 close 导致的双 watcher），第一个 open('wx') 成功者
 * 获得注入权，其余看到标记直接跳过。根治「双 Follow-up 注入」。
 */
export function claimNotified(runsDir: string, runId: string): boolean {
	try {
		const fd = openSync(join(runsDir, `${runId}.notified`), "wx");
		// 原子创建成功 → 本实例获得注入权
		try { closeSync(fd); } catch { /* ignore */ }
		return true;
	} catch {
		// EEXIST（已被别的实例通知过）或其他错误 → 放弃
		return false;
	}
}

/** 检查并处理一个新完成的 runId（幂等 + 跨实例去重）。 */
export function onTabResultFile(runsDir: string, fileName: string, opts: EventBusOptions): boolean {
	if (selfDisabled) return false; // 旧实例已失效，不再注入
	if (!fileName.endsWith(".result.json")) return false;
	if (seenResults.has(fileName)) return false;
	seenResults.add(fileName);
	const runId = fileName.slice(0, -".result.json".length);
	const result = readTabResultFile(runsDir, runId);

	// Phase 5.6 注入前 fencing（ownership 重读，"journal 跟随 owner"）：watch 期间易主
	//（本会话不再是当前 owner）→ 静默放弃：不 journal、不 mailbox、不注入，也不创建 .notified——终态
	// 由新 owner 经 triggerOwnershipRecheck 的 transfer 窗口补偿（recoverUnnotifiedResults）补投
	//（无 .notified 才补投，幂等）。「journal 跟随 owner」。仅 cutover 启用 + 有 attachment 时判定；
	// legacy（未启用/无 registry）恒放行，行为零变化。记抑制审计（与 preInject gate 同语义，保持可审计）；
	// 已 seen 去重保持（上方已 add，本进程不重放；跨进程由新 owner 独立 seen + .notified 屏障处理）。
	{
		const cut = readCutover();
		const att = readAttachment(masterAddress());
		const me = getCurrentSessionId();
		if (cut?.enabled && att && me !== att.sessionId) {
			auditSuppression(
				{ key: runReceiptKey(runId, result?.status ?? "unknown"), sessionId: me, path: "legacy-eventbus" },
				"suppressed-not-owner",
				att,
			);
			return false;
		}
	}

	// Phase 1 shadow emit（terra 裁决缺陷 1 修订）：**owner 进程最先执行，与消费/唤醒解耦**——
	// 新 master session（含 tab 承载）的 watcher 必须能补写终态，否则 journal 违背「logical
	// master 账目不丢」目标；trace-fusion 消费分支提前 return true 同样需入账。
	// 幂等用独立 dedupeKey claim（跨实例/跨重放），不动 .notified 的唤醒语义。
	if (result) {
		emitRuntimeEventOnce(tabResultToRuntimeEvent(result));
		// Phase 3c 影子投递（§27-28）：mailbox REPORT 给 logical recipient（agent://master），
		// 与 links.jsonl 的 sessionId 路由完全解耦；safe-wrapped，失败不影响唤醒链路。
		const { frame, dedupeId } = tabResultToReportLetter(result);
		deliverLetterSafe(frame, { dedupeId });
	}

	// trace-fusion 自动收集等自定义消费者：返回 true 表示已消费（跳过默认 toast/reclaim 注入）；
	// 返回 false/undefined → 落回默认流程（向后兼容：旧调用方不返回值时行为不变）。
	// （journal 终态 emit 已在此之前完成，与消费/唤醒解耦——terra 裁决缺陷 1。）
	if (opts.onTabFinished) {
		if (opts.onTabFinished(runId) === true) return true;
	}

	// 会话定位（2026-08-13：与 report.ts 溯源对齐，防止 identityless 会话抢注入权）：
	// 由 links.jsonl 找到派发该 tab 的会话，只有它才注入完成消息；
	// 其他会话静默跳过（不 claim、不 toast、不注入），把唤醒权留给真正的编排会话。
	// 溯源解析不到（旧账本无 sessionId / 非本插件派发）→ 回退 claim 先到先得。
	const recipient = recipientSessionIdFor({ from: runId }, opts.linksPath ?? defaultLinksPath());
	const mySession = getCurrentSessionId();
	if (recipient && mySession && recipient !== mySession) {
		return false;
	}

	const status = result?.status ?? "unknown";
	// Phase 4d 统一注入门（A5 F2/F15/F16）：cutover 未启用时恒 inject:true，零行为变化；
	// 启用后非 owner 被抑制（记审计），owner 走 claimInjection 互斥。
	let gateCtx: InjectionContext | null = null;
	{
		const gate = preInject({ key: runReceiptKey(runId, status), sessionId: mySession, path: "legacy-eventbus" });
		if (!gate.inject) return false;
		gateCtx = { key: runReceiptKey(runId, status), sessionId: mySession, path: "legacy-eventbus" };
	}
	// 跨实例幂等：原子领取通知权（双 watcher/双实例只有第一个注入）
	if (!claimNotified(runsDir, runId)) {
		if (gateCtx) postInject(gateCtx, true); // legacy 已注证明，回填收据（4d 三路去重）
		return false; // 已被其他实例通知过 → 静默跳过，不注入
	}

	const summary = result?.summary?.slice(0, 200) ?? "(no summary)";
	const artifacts = result?.artifacts?.length ? result.artifacts.slice(0, 5).map((a) => `  • ${a}`).join("\n") : "";
	const reportPath = result?.reportPath ? `
  报告: ${result.reportPath}` : "";
	const openIssues = result?.openIssues?.length ? `
  未决: ${result.openIssues.slice(0, 3).join("; ")}` : "";
	const cost = result?.usage?.cost ? ` ($${result.usage.cost.toFixed(4)})` : "";
	const taskId = result?.taskId ? ` task=${result.taskId}` : "";

	if (opts.toast !== false) {
		const icon = status === "completed" ? "✅" : "❌";
		sendWindowsToast({ title: `${icon} tab ${runId} ${status}${taskId}${cost}`, body: summary.slice(0, 100), duration: "long" });
	}

	refreshAsyncPanel();

	if (opts.autoReclaim !== false) {
		try {
			// 注入用户消息唤醒模型去回收（followUp：主会话忙碌时排队，不打断工具循环）
			const body = [
				`⏱ Tab ${runId} 已完成（${status}${taskId}${cost}）`,
				`摘要: ${summary}`,
				artifacts ? `交付物:\n${artifacts}` : null,
				reportPath || null,
				openIssues || null,
				`下一步: 用 reclaim-tabs({ runIds: ["${runId}"] }) 确认并编排后续。`,
				// 完成/回报类事件唤醒 → 附禁轮询 compact hint（条件追加判据见 no-poll.ts 头注释）
				NO_POLL_HINT,
			].filter((l): l is string => Boolean(l)).join("\n");
			opts.sendUserMessage?.(body, { deliverAs: "followUp" });
			if (gateCtx) postInject(gateCtx, true); // 注入成功 → 确认收据（4d 三路去重）
		} catch {
			selfDisabled = true; // 旧实例 stale → 停止注入
		}
	}
	return true;
}

/**
 * 注册事件总线（主会话 / 当前 owner 会话）。返回清理函数（测试用）。
 */
export function registerEventBus(pi: ExtensionAPI, opts: EventBusOptions = {}): () => void {
	// 工厂入口重置模块状态（P1：reload 重跑工厂时不继承旧实例的 selfDisabled/seen*，避免新会话静默失效）
	_resetEventBus();
	const runsDir = opts.runsDir ?? DEFAULT_TAB_RUNS_DIR;

	// sendUserMessage 从 pi 注入（EventBusOptions 里没有，闭包拿 pi）
	const fullOpts: EventBusOptions = {
		...opts,
		runsDir,
		linksPath: opts.linksPath ?? defaultLinksPath(),
		sendUserMessage: pi.sendUserMessage?.bind(pi),
	};

	// 延迟到 session_start 再判定身份并启动 watcher：CLI flag（--tab-run-id）在扩展加载完成后
	// 才就绪，工厂里 isMainSession() 不可靠。
	// Phase 5.6：注册条件 ownership-gated——cutover 启用 + 有 attachment 时「owner 是谁谁
	// watch」（仅当前 owner 注册）；未启用/无 registry 时 legacy 回退 isMainSession()（零变化）。
	// 本会话后续 attach 成 owner 时，由 master-attach 触发 triggerOwnershipRecheck() 补注册。
	// begin() 幂等 + stale-safe：reload 重跑时先 closeWatcher 关上一个再建新，回调凭 watcherGen 判
	// stale，根治「双 watcher / reload 后旧 watcher 死活不分」。
	const begin = (recover: boolean = false): void => {
		if (!shouldRegisterWatcher()) return; // 非 owner（cutover）/ 非主会话（legacy）→ 不 watch
		closeWatcher(); // 关上一个（防双 watcher / stale 死 watcher）
		const gen = ++watcherGen;
		// transfer 窗口 / crash 补偿：仅 attach 补注册路径（recover=true）先对「未投递」result 补投，
		// 再 snapshot；普通 session_start 首次注册保持 legacy snapshot 行为（零变化）。
		if (recover) recoverUnnotifiedResults(runsDir, fullOpts);
		snapshotExisting(runsDir);
		if (existsSync(runsDir)) {
			try {
				watcher = watch(runsDir, (_event, fileName) => {
					if (gen !== watcherGen) return; // 被新的替代 / cleanup → stale no-op
					if (typeof fileName === "string") {
						onTabResultFile(runsDir, fileName, fullOpts);
					}
				});
			} catch {
				watcher = null;
			}
		}
	};

	pi.on("session_start", (_event, ctx) => {
		// 捕获当前会话 UUID（owner 判定 / 完成消息会话定位的依据；与 report/timers 同模式）
		try {
			setCurrentSessionId((ctx as { sessionManager?: { sessionId?: string } } | undefined)?.sessionManager?.sessionId);
		} catch { /* ctx 不可用则保持 undefined（非 owner 时不注入任何完成消息，宁可静默） */ }

		startWatch = () => begin(true); // master-attach 成功后经 triggerOwnershipRecheck 触发补注册 + transfer 窗口补偿
		begin();
	});

	const cleanup = () => {
		startWatch = null;
		closeWatcher(); // 使在途回调 stale + 关 watcher
	};
	return cleanup;
}

/** 测试/调试：手动检查目录里是否有新 result（tick 兜底可调用）。 */
export function pollNewResults(runsDir: string, opts: EventBusOptions): string[] {
	if (!existsSync(runsDir)) return [];
	const fired: string[] = [];
	for (const f of readdirSync(runsDir)) {
		if (f.endsWith(".result.json") && !seenResults.has(f)) {
			if (onTabResultFile(runsDir, f, opts)) fired.push(f);
		}
	}
	return fired;
}

/** 供测试重置内部状态。 */
export function _resetEventBus(): void {
	seenResults = new Set<string>();
	selfDisabled = false;
	startWatch = null;
	closeWatcher(); // 关在途 watcher + 使其回调 stale
}
