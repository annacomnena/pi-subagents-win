/**
 * Trace-Fusion 专属 Tool 与斜杠命令注册
 * 拆分自 extensions/index.ts (Phase 1.1)
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { capabilities } from "../capabilities.ts";
import { launchTraceRun, readTraceRunMeta } from "./launch-workers.ts";
import { readTraceFusionConfig } from "./config.ts";
import { collectRunArtifacts } from "./artifacts.ts";
import { cleanTraceRun } from "./clean.ts";
import { runCrossTest, finishDiagnoseRun } from "./cross-test.ts";
import { defaultRunsDir as defaultTraceFusionRunsDir, TRACE_LANES, type TraceRunMeta } from "./types.ts";
import { resolveWorkerModel as resolveTraceWorkerModel, type AvailableModelRef } from "./models.ts";
import { dispatchFusion, buildFusionPrompt } from "./fusion-dispatch.ts";
import { makeSubagentFusionRunner } from "./fusion-agent.ts";
import {
	readTfBlock,
	writeTfBlock,
	normalizeUserSettings,
	readLaneModels,
	readFusionModels,
} from "./tf-settings.ts";

export interface TraceFusionToolsOptions {
	findWindowsTerminal: () => string | null;
	findPiCli: () => string;
	searchableSelect: (ctx: ExtensionCommandContext, title: string, options: string[]) => Promise<string | undefined>;
	pkgDir?: string;
}

export function registerTraceFusion(pi: ExtensionAPI, options: TraceFusionToolsOptions): void {
	const { findWindowsTerminal, findPiCli, searchableSelect } = options;
	const PKG_DIR = options.pkgDir ?? resolve(homedir(), ".pi/agent");
	const canOrchestrateTabs = capabilities().launchTabs;

	// ── trace-fusion 工具（2026-09-17）：主会话 agent 自主触发只读诊断 rollout ──
	// 与 /trace-fusion-loop 命令同一套 launchTraceRun，但强制 diagnose 模式（零磁盘代价、
	// 零主仓库写入）；implement（worktree 读写）仅保留给人丁命令。lane tab 看不到本工具
	// （TRACE_WORKER_EXCLUDE_TOOLS）+ execute 内 capabilities 运行时二次校验。
	pi.registerTool({
		name: "trace-fusion",
		label: "Trace Fusion (diagnose)",
		description: [
			"主会话专属：对当前仓库启动三路完全独立的只读诊断 rollout（diagnose 模式 trace-fusion）——三个可见 pi 标签页各自独立诊断同一个任务，产出三份诊断+推进方案（trajectory），完成后自动收集，交本会话融合。",
			"适用：任务明显困难/根因不明/单一轨迹置信度低/值得 test-time scaling 时主动使用；简单任务勿用。",
			"成本：三路并行墙钟约 laneWallClockMin（默认 45min），零磁盘零主仓库写入（只读，edit/write 对 lane 禁用）。",
			"发起后立即可继续其它工作；三路全部完成后系统自动后台收集并通知你，届时读 runDir/lanes/{A,B,C}/trajectory.md 做融合（一致根因→高置信；分歧→仲裁）后单次实现。",
			"只允许主会话调用；同一时刻仅允许一个 active run（并发启动会被 preflight 拒绝）。",
		].join(" "),
		parameters: Type.Object({
			task: Type.String({ description: "任务描述（各 lane 逐字相同）：要诊断/推进的具体问题，应包含足够上下文让独立诊断可执行" }),
			model: Type.Optional(Type.String({ description: "per-call 模型（provider/id 或唯一短名）。优先级：本参数 > config.workerModel > lane 默认；非法模型直接报错（不静默回落）" })),
			workerModelByLane: Type.Optional(Type.Object({
				A: Type.Optional(Type.String({ description: "TRACE A 的模型" })),
				B: Type.Optional(Type.String({ description: "TRACE B 的模型" })),
				C: Type.Optional(Type.String({ description: "TRACE C 的模型" })),
			}, { description: "per-lane 模型覆盖（2026-11-02）：三路可各用不同模型（异构才有融合价值）。优先级：本参数[lane] > config.workerModelByLane[lane] > model > config.workerModel。未设的 lane 自动回落" })),
			laneConcurrency: Type.Optional(Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)], {
				description: "并发度（缺省沿用 config，通常为 1）：1=严格串行（省共享 KV 池）、2=双路、3=三路全并发。本机 KV 池是共享的，三路并发可能在中等任务上撞池",
			})),
			cwd: Type.Optional(Type.String({ description: "per-call 目标仓库（必须是绝对路径；缺省 = 当前目录）。校验沿用 preflight（git 仓库/HEAD/merge 状态），路径先规范化成绝对路径" })),
		}),
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			if (!capabilities().launchTabs) {
				return { content: [{ type: "text", text: "trace-fusion 只允许主会话调用。" }], isError: true };
			}
			const params = rawParams as {
				task?: string;
				model?: unknown;
				workerModelByLane?: { A?: string; B?: string; C?: string };
				laneConcurrency?: 1 | 2 | 3;
				cwd?: unknown;
			};
			const task = (params.task ?? "").trim();
			if (!task) {
				return { content: [{ type: "text", text: "task 不能为空：给出要诊断的具体问题。" }], isError: true };
			}
			// 参数化 ①（2026-10-21）：per-call model 校验**先于任何 spawn/IO**。
			// 权威来源 = 本次会话的 modelRegistry（审查 B3：本地 models.json 不是 CLI 可用集），
			// 省略参数时不触碰 registry（保持旧路径零新增依赖）。
			let workerModel: string | undefined;
			if (params.model !== undefined) {
				const available: AvailableModelRef[] = (() => {
					try {
						const reg = (ctx as unknown as { modelRegistry?: { getAvailable?: () => unknown } }).modelRegistry;
						const list = reg?.getAvailable?.();
						return Array.isArray(list) ? (list as AvailableModelRef[]) : [];
					} catch {
						return [];
					}
				})();
				const resolved = resolveTraceWorkerModel(params.model, available);
				if (!resolved.ok) {
					return { content: [{ type: "text", text: `trace-fusion: ${resolved.error}` }], isError: true };
				}
				workerModel = resolved.model;
			}
			// per-lane 模型（2026-11-02）：逐 lane 校验；非法 lane **被放弃**（不回落默认），并在返回里显式告知。
			let workerModelByLane: Partial<Record<"A" | "B" | "C", string>> | undefined;
			let droppedLanes: Array<"A" | "B" | "C"> = [];
			let droppedLaneReasons: string[] = [];
			if (params.workerModelByLane !== undefined) {
				const raw = params.workerModelByLane;
				if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
					return { content: [{ type: "text", text: "trace-fusion: workerModelByLane 必须是 {A?:string,B?:string,C?:string} 对象。" }], isError: true };
				}
				const available: AvailableModelRef[] = (() => {
					try {
						const reg = (ctx as unknown as { modelRegistry?: { getAvailable?: () => unknown } }).modelRegistry;
						const list = reg?.getAvailable?.();
						return Array.isArray(list) ? (list as AvailableModelRef[]) : [];
					} catch {
						return [];
					}
				})();
				const acc: Partial<Record<"A" | "B" | "C", string>> = {};
				const laneModelErrors: string[] = [];
				for (const lane of ["A", "B", "C"] as const) {
					const v = (raw as Record<string, unknown>)[lane];
					if (v === undefined) continue;
					const r = resolveTraceWorkerModel(v, available);
					if (!r.ok) {
						// 2026-11-02 用户裁定：**放弃这一路**，不让一个错模型崩掉整趟 run。
						// 关键区别（R-2 的真正含义）：不是「静默跳过」而是「移除该 lane 并显式告知」。
						// 该 lane 会被剔除出 TRACE_LANES 派发集（见下方 requestedLanes），而不是回落成默认模型跑。
						laneModelErrors.push(`lane ${lane}＝${String(v)}：${r.error}`);
						continue;
					}
					if (r.model) acc[lane] = r.model;
				}
				// 三路都非法 ⇒ 等于没给任何有效 lane，必错（否则会白白开一趟 run）
				if (laneModelErrors.length > 0 && Object.keys(acc).length === 0) {
					return {
						content: [{ type: "text", text: ["trace-fusion：所有指定的 lane 模型都不可用。", ...laneModelErrors].join("\n") }],
						isError: true,
					};
				}
				if (laneModelErrors.length > 0) {
					droppedLaneReasons = laneModelErrors;
					droppedLanes = (["A", "B", "C"] as const).filter((l) => (raw as Record<string, unknown>)[l] !== undefined && !(l in acc));
				}
				if (Object.keys(acc).length > 0) workerModelByLane = acc;
			}
			let wtExe: string | null;
			let piCli: string;
			try {
				wtExe = findWindowsTerminal();
				piCli = findPiCli();
			} catch (err) {
				return { content: [{ type: "text", text: `启动环境不可用：${err instanceof Error ? err.message : String(err)}` }], isError: true };
			}
			if (!wtExe) {
				return { content: [{ type: "text", text: "未找到 Windows Terminal (wt.exe)，无法启动标签页。" }], isError: true };
			}
			// 参数化 ②（2026-10-21）：per-call cwd —— 缺省 process.cwd()（向后兼容）；
			// 显式传入必须规范化成绝对路径且是已存在目录；git 仓库/HEAD/merge 校验交给 preflight（不重写）。
			let repoRoot = process.cwd();
			if (params.cwd !== undefined) {
				if (typeof params.cwd !== "string" || !params.cwd.trim()) {
					return { content: [{ type: "text", text: "trace-fusion: cwd 必须是非空字符串（绝对路径）。" }], isError: true };
				}
				if (!isAbsolute(params.cwd)) {
					return { content: [{ type: "text", text: `trace-fusion: cwd 必须是绝对路径：${params.cwd}` }], isError: true };
				}
				repoRoot = resolve(params.cwd);
				let cwdIsDir = false;
				try {
					cwdIsDir = statSync(repoRoot).isDirectory();
				} catch {
					cwdIsDir = false;
				}
				if (!cwdIsDir) {
					return { content: [{ type: "text", text: `trace-fusion: cwd 不存在或不是目录：${repoRoot}` }], isError: true };
				}
			}
			const tfConfig = readTraceFusionConfig();
			// agent 主动触发永远只读：强制 diagnose，忽略 config 里的 implement 档。
			// per-call laneConcurrency（2026-11-02）：显式传入 > config；非法值已在 schema 层被 Type.Union 拦掉。
			const effectiveConfig = {
				...tfConfig,
				mode: "diagnose" as const,
				...(params.laneConcurrency !== undefined ? { laneConcurrency: params.laneConcurrency } : {}),
			};
			const result = launchTraceRun({
				task,
				repoRoot,
				wtExe,
				piCli,
				config: effectiveConfig,
				// 参数化 ①：已校验的 per-call 模型（undefined ⇒ 回落 config）
				workerModel,
				// per-lane 覆盖：优先级见 workerModelFor（本参数[lane] > config[lane] > workerModel > config.workerModel）
				workerModelByLane,
				// 非法 lane 模型已在上层转为「放弃该路」（不回落默认），原因透传给编排与报告
				skipLanes: droppedLanes.length > 0 ? Object.fromEntries(droppedLanes.map((l) => [l, "模型非法/不可用"])) : undefined,
				runsDir: defaultTraceFusionRunsDir(),
			});
			const lines = result.lines ?? [];
			if (!result.ok) {
				return { content: [{ type: "text", text: ["trace-fusion 启动失败：", result.error, ...lines].join("\n") }], isError: true };
			}
			try {
				// 2026-11-02 修正：只为**已实际派发**的 lane 写溯源链接。串行模式下 B/C 此时还在队列里
				// 没有 tabRunId，写出去就是一行空 targetId 的死账（实测）——lane 完成时
				// recipientSessionIdFor 查不到归属 ⇒ 落回「先到先得」+ master 影子信件 ⇒ 乱回。
				// 续发时的真链接由 lane-queue 在拿到 tabRunId 后负全责写。
				for (const lane of TRACE_LANES) {
					const tid = result.meta.lanes[lane].tabRunId;
					if (!tid) continue;
					recordLink({ sessionId: sessionIdentity(ctx as never), kind: "tab", targetId: tid, detail: `trace-fusion ${result.meta.runId} lane=${lane}` });
				}
			} catch { /* 溯源尽力而为 */ }
			const laneIds = TRACE_LANES.map((l) => `${l}=${result.meta.lanes[l].tabRunId}`).join(", ");
			const queued = TRACE_LANES.filter((l) => !result.meta.lanes[l].tabRunId && !droppedLanes.includes(l));
			return { content: [{ type: "text", text: [
				`✅ trace-fusion diagnose run 已启动：${result.meta.runId}`,
				...(droppedLanes.length > 0 ? [`⚠ 已放弃 ${droppedLanes.length} 路（不会用默认模型代跑）：`, ...droppedLaneReasons.map((e) => `  - ${e}`)] : []),
				...lines,
				`lane tabs: ${laneIds}`,
				...(queued.length > 0 ? [`待发队列（前行终态后自动派发）：${queued.join(", ")}`] : []),
				"三路完成后自动后台收集（无需干预）。",
				`融合对照表（读这个，不要直接读三份全文）：${result.meta.runDir}/cross-test-report.md`,
				"该报告是确定性抽取（零模型调用）：分歧节优先看；三路都未填的节说明证据不足。",
			].join("\n") }] };
		},
	});

	// ── /trace-fusion（2026-11-02 重构：三命令取代四个运维命令）──
	// 用户裁定（交互角度只需要三件事）：
	//   ① 模型 —— `/trace-fusion models`（三路 lane 各用哪个模型）
	//   ② 参数 —— `/trace-fusion config`（并发度/时限/轮数）
	//   ③ 开始 —— `/trace-fusion <任务>`
	// 退场：/trace-fusion-status、-collect（运维面，对使用者是噪声；状态靠启动通知+完成事件）。
	// 保留：/trace-fusion-clean（worktree 占磁盘，必须有手动释放入口）。
	if (canOrchestrateTabs) {
		const tfConfigPath = () => join(PKG_DIR, "config.json");

		/** 启动前共用：环境解析 + 失败即告知。 */
		const resolveLaunchEnv = (ctx: ExtensionCommandContext): { wtExe: string; piCli: string } | null => {
			let wtExe: string | null;
			let piCli: string;
			try {
				wtExe = findWindowsTerminal();
				piCli = findPiCli();
			} catch (err) {
				ctx.ui.notify(`❌ 启动环境不可用：${err instanceof Error ? err.message : String(err)}`, "error");
				return null;
			}
			if (!wtExe) {
				ctx.ui.notify("❌ 未找到 Windows Terminal (wt.exe)。", "error");
				return null;
			}
			return { wtExe, piCli };
		};

		/** ② 参数设置：交互式修改并发度/时限/轮数（read-modify-write 单键 + 备份）。 */
		const configureParams = async (ctx: ExtensionCommandContext): Promise<void> => {
			const block = readTfBlock(JSON.parse(readFileSync(tfConfigPath(), "utf8")) as Record<string, unknown>);
			const cur = normalizeUserSettings(block);

			const concLabels = [
				`1（严格串行：省 KV 池，墙钟 3×）${cur.laneConcurrency === 1 ? " ✓" : ""}`,
				`2（双路并发）${cur.laneConcurrency === 2 ? " ✓" : ""}`,
				`3（三路全并发：快，但共享 KV 池可能不够）${cur.laneConcurrency === 3 ? " ✓" : ""}`,
			];
			const picked = await ctx.ui.select("lane 并发度（本机 KV 池是共享的，三路并发可能撞池）:", concLabels);
			if (!picked) return;
			const laneConcurrency = (concLabels.indexOf(picked) + 1) as 1 | 2 | 3;

			const timeLabels = ["15 分钟", "30 分钟", "45 分钟（默认）", "60 分钟", "90 分钟"];
			const timeVals = [15, 30, 45, 60, 90];
			const pickedT = await ctx.ui.select(`单 lane 墙钟时限（当前 ${cur.maxWallClockPerLaneMin}min）:`, timeLabels);
			if (!pickedT) return;
			const maxWallClockPerLaneMin = timeVals[timeLabels.indexOf(pickedT)];

			const r = writeTfBlock(tfConfigPath(), { laneConcurrency, maxWallClockPerLaneMin });
			if (!r.ok) {
				ctx.ui.notify(`❌ 保存失败：${r.error}`, "error");
				return;
			}
			ctx.ui.notify(
				`✅ 已保存：并发度 ${laneConcurrency}，lane 时限 ${maxWallClockPerLaneMin}min\n备份：${r.backupPath}`,
				"info",
			);
		};

		/** ③ 融合模型：设置面能设，消费链才够得着（2026-11-02）。 */
		const configureFusionModel = async (ctx: ExtensionCommandContext): Promise<void> => {
			const block = readTfBlock(JSON.parse(readFileSync(tfConfigPath(), "utf8")) as Record<string, unknown>);
			const cur = readFusionModels(block).fusionModel;
			const allModels = ctx.modelRegistry.getAvailable()
				.slice()
				.sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
			const labels = ["不使用融合（collect 完成后零动作，报告等人读）", ...allModels.map((m) => `${m.provider}/${m.id}`)];
			const picked = await ctx.ui.select(`融合模型（当前 ${cur ?? "(未设)"}）：`, labels);
			if (!picked) return;
			const patch = picked.startsWith("不使用") ? { fusionModel: undefined } : { fusionModel: picked };
			const r = writeTfBlock(tfConfigPath(), patch);
			if (!r.ok) {
				ctx.ui.notify(`❌ 保存失败：${r.error}`, "error");
				return;
			}
			ctx.ui.notify(
				`✅ 融合模型：${picked.startsWith("不使用") ? "已关闭（跳过，零模型调用）" : picked}
` +
					`生效范围：下一次 trace-fusion run 的 collect 完成后自动派融合（只读，产物 <runDir>/fusion/fusion.md）。
` +
					`备份：${r.backupPath}`,
				"info",
			);
		};

		/** ① 模型设置：三路 lane 分别选（也可以三路同一个）。 */
		const configureModels = async (ctx: ExtensionCommandContext): Promise<void> => {
			const block = readTfBlock(JSON.parse(readFileSync(tfConfigPath(), "utf8")) as Record<string, unknown>);
			const curLanes = readLaneModels(block);
			const allModels = ctx.modelRegistry.getAvailable()
				.slice()
				.sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
			if (allModels.length === 0) {
				ctx.ui.notify("❌ 无可用模型（检查 /model 或 models.json）。", "error");
				return;
			}

			const clearLabel = "(用 lane 默认模型)";
			const modelLabels = [
				clearLabel,
				...allModels.map((m) => {
					const ref = `${m.provider}/${m.id}`;
					const detail = m.name && m.name !== m.id ? ` — ${m.name}` : "";
					const ctxW = (m as { contextWindow?: number }).contextWindow;
					return `${ref}${detail}${ctxW ? ` (ctx ${Math.round(ctxW / 1024)}K)` : ""}`;
				}),
			];

			const next: Partial<Record<"A" | "B" | "C", string | undefined>> = {};
			for (const lane of ["A", "B", "C"] as const) {
				const current = curLanes[lane];
				const labeled = modelLabels.map((l) =>
					l === clearLabel && current ? `${l} [当前: ${current}]` : l === `${current}` ? `${l} ✓` : l,
				);
				const picked = await searchableSelect(ctx, `TRACE ${lane} 用哪个模型?`, labeled);
				if (!picked) break; // 取消 ⇒ 不写入任何已选的（避免半套设置）
				if (picked.startsWith(clearLabel)) next[lane] = undefined;
				else next[lane] = picked.replace(/ ✓$/, "").replace(/ \(ctx \d+K\)$/, "").split(" — ")[0].trim();
			}
			if (Object.keys(next).length === 0) return;

			const r = writeTfBlock(tfConfigPath(), { workerModelByLane: next });
			if (!r.ok) {
				ctx.ui.notify(`❌ 保存失败：${r.error}`, "error");
				return;
			}
			const applied = Object.entries(next)
				.map(([k, v]) => `${k}=${v ?? "(默认)"}`)
				.join(" | ");
			ctx.ui.notify(`✅ lane 模型已保存：${applied}\n备份：${r.backupPath}`, "info");
		};

		pi.registerCommand("trace-fusion", {
			description: "三路独立诊断 + 融合：/trace-fusion <任务> 启动 | models 设模型 | config 设参数",
			handler: async (args, ctx) => {
				if (!capabilities().launchTabs) {
					ctx.ui.notify("⛔ 当前会话无 trace-fusion 启动权限（仅主会话）", "error");
					return;
				}
				const text = (args ?? "").trim();
				const sub = text.split(/\s+/)[0]?.toLowerCase() ?? "";

				if (sub === "models") return configureModels(ctx);
				if (sub === "config" || sub === "settings") return configureParams(ctx);
				if (sub === "fusion") return configureFusionModel(ctx);

				// 无参数 或 show：展示当前设置（这是用户「忘了自己设了什么」时的唯一查面）
				if (!text || sub === "show" || sub === "status") {
					const lines = renderSettingsSummary(tfConfigPath());
					ctx.ui.notify(
						[
							"🧬 trace-fusion 当前设置",
							...lines,
							"",
							"用法：",
							"  /trace-fusion <任务>    启动三路诊断",
							"  /trace-fusion models    设置三路模型",
							"  /trace-fusion config    设置并发度/时限",
							"  /trace-fusion fusion  设置融合模型（未设 ⇒ 不融合）",
						].join("\n"),
						"info",
					);
					return;
				}

				const env = resolveLaunchEnv(ctx);
				if (!env) return;
				const tfConfig = readTraceFusionConfig();
				const result = launchTraceRun({
					task: text,
					repoRoot: process.cwd(),
					wtExe: env.wtExe,
					piCli: env.piCli,
					config: tfConfig,
					runsDir: defaultTraceFusionRunsDir(),
				});
				for (const line of result.lines ?? []) ctx.ui.notify(line, "info");
				if (!result.ok) {
					ctx.ui.notify(`❌ trace-fusion 启动失败：${result.error}`, "error");
					return;
				}
				try {
					for (const lane of TRACE_LANES) {
						recordLink({
							sessionId: sessionIdentity(ctx as never),
							kind: "tab",
							targetId: result.meta.lanes[lane].tabRunId,
							detail: `trace-fusion ${result.meta.runId} lane=${lane}`,
						});
					}
				} catch {
					/* 溯源失败不阻塞 */
				}
				ctx.ui.notify(
					`🧬 run ${result.meta.runId} 已启动：TRACE A/B/C 三路独立求解中。\n` +
					`lane 时限 ${result.meta.laneWallClockMin}min，超时 lane 判 failed 走 2/3 降级。\n` +
					`完成时会自动通知；报告在 ${result.meta.runDir}/cross-test-report.md`,
					"info",
				);
			},
		});

		// ── /trace-fusion-fuse <runId>（2026-11-04，S2/S3）────────────────────
		// 把「融合」显式拉成一次**同步 subagent 调用**：融合者以 agent="fusion" 出现在本次
		// tool/命令调用里，结果直接回显（不再是「盘上一个没人读的 json」）。
		// 自动链（lane 全部终态后由 collect worker 触发）仍是 headless 异步——那是结构约束：
		// 它发生在事件回调里，同步阻塞会冻住 TUI。本命令是给人手动跑/重跑融合用的。
		pi.registerCommand("trace-fusion-fuse", {
			description: "同步跑一次融合（把 trace-fusion run 的三路诊断拼装成推进方案）：/trace-fusion-fuse <runId>",
			handler: async (args, ctx) => {
				const runId = (args ?? "").trim();
				if (!runId) {
					ctx.ui.notify("用法：/trace-fusion-fuse <runId>；runId 见 ~/.pi/agent/trace-fusion-runs/ 目录名", "error");
					return;
				}
				const meta = readTraceRunMeta(join(defaultTraceFusionRunsDir(), runId));
				if (!meta) {
					ctx.ui.notify(`run meta 不可读：${runId}`, "error");
					return;
				}
				const reportPath = join(meta.runDir, "cross-test-report.md");
				const cfg = readTraceFusionConfig(join(PKG_DIR, "config.json"));
				if (!cfg.fusionModel) {
					ctx.ui.notify("未配置 traceFusionLoop.fusionModel ⇒ 融合不启动（不自动挑模型）", "error");
					return;
				}
				ctx.ui.notify(`🧬 融合开始（同步，模型 ${cfg.fusionModel}）…`, "info");
				const runner = makeSubagentFusionRunner({
					runWithFallback: (agent, task, systemPrompt, model, timeoutMs, signal, onUpdate, opts2) =>
						runWithFallback(agent as AgentDef | null, task, systemPrompt, model, timeoutMs, signal, onUpdate as never, opts2 as never) as never,
					findAgent: (name) => agents.find((a) => a.name === name) ?? null,
				});
				const res = await dispatchFusion({
					runId: meta.runId,
					runDir: meta.runDir,
					repoRoot: meta.repoRoot,
					reportPath,
					fusionModel: cfg.fusionModel,
					laneModel: meta.lanes?.A ? undefined : undefined,
					dispatcherSessionId: meta.dispatcherSessionId,
					piCli: findPiCli() ?? undefined,
					runFusionAgent: runner,
					via: "subagent-runWithFallback(manual)",
				});
				ctx.ui.notify(
					res.status === "completed"
						? `✅ 融合完成：${res.reportPath}`
						: `❌ 融合未完成（${res.status}）：${res.reason}`,
					res.status === "completed" ? "info" : "error",
				);
			},
		});

		pi.registerCommand("trace-fusion-clean", {
			description: "清理 trace-fusion run 的 worktree 占用（保留 artifact）：/trace-fusion-clean <runId> [--force]",
			handler: async (args, ctx) => {
				const raw = (args ?? "").trim();
				const force = /(^|\s)--force(\s|$)/.test(raw);
				const runId = raw.replace(/--force/g, "").trim();
				if (!runId) {
					ctx.ui.notify("用法：/trace-fusion-clean <runId> [--force]；runId 见 ~/.pi/agent/trace-fusion-runs/ 目录名（/trace-fusion-status 已退场）", "error");
					return;
				}
				const result = cleanTraceRun(runId, { force, runsDir: defaultTraceFusionRunsDir() });
				for (const line of result.lines) ctx.ui.notify(line, "info");
				if (!result.ok) {
					ctx.ui.notify(`清理失败：${result.error}`, "error");
					return;
				}
				ctx.ui.notify(`✅ 清理完成：${result.removedWorktrees.length} 个 worktree 已移除`, "info");
			},
		});
	}
}

