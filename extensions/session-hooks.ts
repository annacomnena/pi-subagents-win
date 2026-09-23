/**
 * session-hooks.ts — 会话生命周期小 hook 集中地（Phase 5.5 R1）。
 *
 * 从 index.ts 逐字搬移（零行为变化）：session_start 追赶收集、
 * session_shutdown 清理、tool_execution toast 通知、resources_discover skill 暴露。
 * before_agent_start 的巨型 prompt builder 留在 index（每轮关键路径，另案处理）；
 * M5 的 turn 检查与 proposal 提醒将落在此文件。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { clearAsyncPanelUi } from "./async-panel.ts";
import { durableSessionIdentity, isMainSession, isSubagent } from "./identity.ts";
import { isTraceWorker } from "./capabilities.ts";
import { sendWindowsToast } from "./notify-windows.ts";
import { catchUpAutoCollect } from "./trace-fusion/supervisor.ts";
import { masterAddress } from "./runtime/address.ts";
import { clearSessionStartCwd, recordSessionStartCwd } from "./runtime/master-session-cwd.ts";
import { writeLiveness, writeScopeLiveness } from "./runtime/liveness.ts";
import { readPressure } from "./runtime/master-pressure.ts";
import { maybePropose } from "./runtime/master-succession.ts";
import { readAttachment } from "./runtime/registry.ts";
import { localMasterAddress, localMasterScope, noteScopeWakeInbox } from "./runtime/scope.ts";
import {
	DEFAULT_MASTER_SUCCESSION,
	maybeAutoSucceed,
	type MasterSuccessionConfig,
} from "./runtime/master-auto.ts";
import type { SpawnSuccessor } from "./runtime/master-transfer.ts";

export interface SessionHooksDeps {
	cleanups: Array<() => void>;
	isNotifyEnabled: () => boolean;
	pkgDir: string;
	/** S3 自动交接：spawn 通道 + 配置读取闭包（缺省 = 不启用 S3 块） */
	spawnSuccessor?: SpawnSuccessor;
	masterSuccession?: () => MasterSuccessionConfig;
}

/**
 * Scope owner liveness 双写（0920 backlog B6）：本会话是本 cwd 的 scope owner →
 * 写 state/scope-liveness/<scope>.json（含 pid + startedAt；30s 节流 + never-throw，
 * 复用 liveness.ts 原子写）。agent_start + agent_end 两处调用；全局 master-liveness
 * 写手（下方 agent_end 全局分支）零改动，两分支严格分离不共享 marker 文件。
 * stale 接管判据消费此文件（scope.ts judgeScopeOwnerStale：attachment pid 死 → 接管）。
 */
function writeScopeOwnerLiveness(sid: string): void {
	try {
		const cwd = process.cwd();
		const scope = localMasterScope(cwd);
		const att = readAttachment(localMasterAddress(scope));
		if (!att || att.sessionId !== sid) return; // 身份门：非本 scope owner 零写（旧 owner 复活也挡在这）
		writeScopeLiveness({ scopeKey: scope, sessionId: sid, generation: att.generation });
	} catch {
		/* gauge 永不打断主流程 */
	}
}

export function registerSessionHooks(pi: ExtensionAPI, deps: SessionHooksDeps): void {
	// trace-fusion 追赶收集：主会话启动时，扫「三路已终态但未出报告」的 running run
	// 补后台收集（覆盖「三路全部在无主会话时完成」——重启后 watcher 把既有 result 标 seen，
	// onTabFinished 不再触发，只能靠这里）。§24.1：磁盘是真相源，watch 只是加速器。
	// home 守卫启动快照（0923）：最早按持久 session UUID 记录 initialCwd（首写优先，
	// 永不从后来变化的 cwd 回填；缺快照的会话 attach 时 fail closed）。无条件记录（含 tab）。
	pi.on("session_start", (_event, ctx) => {
		try {
			const sid = durableSessionIdentity(ctx as never);
			if (!sid || sid === "unknown") return;
			const cwd = (ctx as unknown as { cwd?: unknown }).cwd;
			recordSessionStartCwd(sid, typeof cwd === "string" && cwd ? cwd : process.cwd());
		} catch { /* gauge 永不打断主流程 */ }
	});

	pi.on("session_start", (_event, ctx) => {
		if (!isMainSession()) return;
		const catches = catchUpAutoCollect();
		if (!catches.length) return;
		try {
			pi.sendUserMessage?.(
				`🧬 trace-fusion 追赶：${catches.map((c) => c.runId).join(", ")} 三路已终态但报告缺失，已后台补跑 cross-test。进度：/trace-fusion-status`,
				{ deliverAs: "followUp" },
			);
		} catch { /* 通知尽力而为，收集已在后台 */ }
		void ctx;
	});

	pi.on("session_shutdown", (_event, ctx) => {
		try {
			const sid = durableSessionIdentity(ctx as never);
			if (sid && sid !== "unknown") clearSessionStartCwd(sid);
		} catch { /* ignore */ }
		for (const cleanup of deps.cleanups) {
			try { cleanup(); } catch { /* ignore */ }
		}
		deps.cleanups.length = 0;
		clearAsyncPanelUi(); // 丢弃缓存的 UI 引用（旧 ctx 已 stale）
	});

	// subagent-win 工具开始执行时通知
	pi.on("tool_execution_start", (event) => {
		if (event.toolName !== "subagent-win") return;
		if (!deps.isNotifyEnabled()) return;
		const args = event.args as Record<string, unknown> | undefined;
		const agent = args?.agent ?? args?.tasks?.[0]?.agent ?? "subagent";
		const task = (args?.task ?? args?.tasks?.[0]?.task ?? "") as string;
		const preview = String(task).slice(0, 60);
		sendWindowsToast({
			title: `🤖 ${agent} 开始工作`,
			body: preview || "(无任务描述)",
			duration: "short",
		});
	});

	// subagent-win 工具执行结束时通知
	pi.on("tool_execution_end", (event) => {
		if (event.toolName !== "subagent-win") return;
		if (!deps.isNotifyEnabled()) return;
		const result = event.result as Record<string, unknown> | undefined;
		const details = result?.details as Record<string, unknown> | undefined;
		const results = details?.results as Array<Record<string, unknown>> | undefined;

		if (results) {
			// 并行模式
			const ok = results.filter((r) => r.status === "completed").length;
			const total = results.length;
			const icon = ok === total ? "✅" : "⚠️";
			sendWindowsToast({
				title: `${icon} Parallel: ${ok}/${total}`,
				body: ok === total ? "全部 task 完成" : `${total - ok} 个 task 失败`,
				duration: ok === total ? "short" : "long",
			});
		} else {
			// 单 agent 模式
			const r = details?.result as Record<string, unknown> | undefined;
			const agent = (r?.agent ?? "subagent") as string;
			const status = (r?.status ?? "completed") as string;
			const isOk = status === "completed";
			const error = r?.error as string | undefined;
			const usage = r?.usage as Record<string, unknown> | undefined;
			const cost = usage?.cost as number | undefined;

			sendWindowsToast({
				title: isOk ? `✅ ${agent} 完成` : `❌ ${agent} 失败`,
				body: isOk
					? cost !== undefined
						? `✓ 成功  ($${cost.toFixed(4)})`
						: "✓ 成功"
					: `✗ ${(error ?? "未知错误").slice(0, 100)}`,
				duration: isOk ? "short" : "long",
			});
		}
	});

	// update_goal(complete) 时通知 goal 完成
	pi.on("tool_execution_end", (event) => {
		if (event.toolName !== "update_goal") return;
		if (event.isError) return;
		if (!deps.isNotifyEnabled()) return;
		const result = event.result as Record<string, unknown> | undefined;
		const content = result?.content as Array<Record<string, unknown>> | undefined;
		if (!content) return;
		const text = content.map((c) => String(c.text ?? "")).join("");
		// 检查输出是否包含 complete 状态的确认
		if (/complete|完成|✅|✓/i.test(text)) {
			sendWindowsToast({
				title: "🎯 Goal 已完成",
				body: text.slice(0, 120) || "所有目标达成",
				duration: "long",
			});
		}
	});

	// 注册包内 skill 路径
	pi.on("resources_discover", async () => {
		// trace worker 不得看到 workflow-orchestrator skill（设计稿 §56）；
		// 未来若有非 workflow skill 再按 allowlist 暴露。
		if (isTraceWorker()) {
			return { skillPaths: [] };
		}
		return { skillPaths: [join(deps.pkgDir, "skills")] };
	});

	// S2 提议制交接的 turn 检查（M5）：agent turn 结束 → 读本会话压力 →
	// owner + 达线 + 同代未提过 → 落 pending + 尽力 notify（§10/§12）。
	// gauge 永不打断主流程：任何异常静默吞掉；subagent 进程跳过。
	pi.on("agent_end", (_event, ctx) => {
		try {
			if (isSubagent()) return;
			// 所有权必须与 attach 写入侧同在持久 UUID 域：tab runId 只用于 links 路由。
			const sid = durableSessionIdentity(ctx as never);
			if (!sid || sid === "unknown") return;

			// ── 全局分支（S2/S3，行为零变化）：仅当本会话是全局 owner 才做事 ──
			const att = readAttachment(masterAddress());
			if (att && att.sessionId === sid) {
				const getUsage = (ctx as unknown as { getContextUsage?: () => unknown }).getContextUsage;
				if (typeof getUsage === "function") {
					const reading = readPressure(getUsage.call(ctx) as never);
					// G5.2 心跳写手：host 是独立 detached 进程读不到会话内存，活压力必须由 owner 在此落盘
					//（≥30s 节流 + never-throw，写失败静默）。除本调用外零改动。
					writeLiveness({ sessionId: sid, generation: att.generation, pressure: reading.percent, windowTokens: reading.contextWindow });
					const ui = (ctx as unknown as { ui?: { notify?: (msg: string, level: string) => void } }).ui;
					const cfg = deps.masterSuccession?.() ?? DEFAULT_MASTER_SUCCESSION;
					// S2：owner + 达线 + 同代未提过 → 落 pending + 尽力 notify（§10/§12）；
					// proposalPercent 缺省 0.75，与现状零差；enabled=false（总开关 off）→ 静默 null。
					const r = maybePropose({ sessionId: sid, generation: att.generation, reading, proposalPercent: cfg.proposalPercent / 100, enabled: cfg.enabled });
					if (r && r.proposed) {
						try {
							ui?.notify?.(
								`当前 Master context 已使用 ${r.proposal.pressure}%（proposal ${r.proposal.proposalId}）。建议无损 session handoff：回复“好”即交接；也可先继续。`,
								"warning",
							);
						} catch { /* 通知尽力而为，proposal 已落盘 */ }
					}
					// S3 自动交接（A1）：gate 短路 + 失败回退全在 master-auto.ts；这里只做调用与尽力 notify。
					// OFF 时 gate 第一关 auto-off 即返回，零写零事件零 spawn。
					if (deps.masterSuccession) {
						const auto = maybeAutoSucceed({
							sessionId: sid,
							generation: att.generation,
							reading,
							cfg,
							spawn: deps.spawnSuccessor ?? null,
						});
						if (auto.action === "transferred") {
							ui?.notify?.(
								`Master 已自动交接：transfer=${auto.transferId} 后继=${auto.successorRunId}（gen ${auto.generation}→${auto.generation + 1}）`,
								"info",
							);
						} else if (auto.action === "failed") {
							ui?.notify?.(
								`Master 自动交接失败（transfer=${auto.transferId}，${auto.error ?? "unknown"}）：你仍是 owner，已回退提议/人工：/master-transfer`,
								"warning",
							);
						}
					}
				}
			}

			// ── scope 分支（local master v1）：与全局分支严格分离，不共享 marker 文件 ──
			// 本会话是本 cwd 的 scope owner → 先写 scope liveness（0920 backlog B6：stale 接管
			// 的活性数据源），再读本仓 wake 类信 → 追加 per-scope 本地 attention
			//（wake-pending，按 letterId 去重）；不碰 S2/S3/succession，不写全局 master-attention.json。
			writeScopeOwnerLiveness(sid);
			let cwd: string | null = null;
			try {
				cwd = process.cwd();
			} catch {
				cwd = null;
			}
			if (cwd) noteScopeWakeInbox(sid, cwd);
		} catch { /* gauge 永不打断主流程 */ }
	});

	// Scope owner liveness：agent_start 即写（0920 backlog B6 双写之二）——接管/genesis 后
	// 新 owner 首个 agent 前就有活性记录；身份门在 writeScopeOwnerLiveness 内，非 owner 零写。
	pi.on("agent_start", (_event, ctx) => {
		try {
			if (isSubagent()) return;
			const sid = durableSessionIdentity(ctx as never);
			if (!sid || sid === "unknown") return;
			writeScopeOwnerLiveness(sid);
		} catch { /* gauge 永不打断主流程 */ }
	});
}
