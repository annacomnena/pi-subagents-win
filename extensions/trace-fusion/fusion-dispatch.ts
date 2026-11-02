/**
 * trace-fusion/fusion-dispatch.ts — fusionModel 的消费链（2026-11-02，④）
 *
 * ## 为什么要有这一段
 *
 * Packet 三段（Hard Facts / Conflicts / Instruction）+ validation 复跑 + 行号越界校验，
 * 此前**全部只写进 cross-test-report.md 等人读**。`fusionModel` 字段在设置面里存在
 * （`tf-settings.ts`），摘要文案明写「当前未实现消费」——即：材料做出来了，没有消费者。
 *
 * 本次把消费者接上：collect worker 在 deterministic 终态后，若用户设置了 `fusionModel`，
 * 派一个**无头 pi 子进程**读 packet 做融合，产物落 `<runDir>/fusion/fusion.md`，
 * 并按 async-subagent 的既有账本形状落 `subagent-runs/run_*.json` + links 记录 ⇒
 * 派发者会话的 async-result-watcher 会**自动注入完成通知**（零轮询，与 subagent 完成同一条路）。
 *
 * ## 三条硬边界
 *
 * 1. **未设置 fusionModel ⇒ 零动作**，且必须**显式记录**「未配置，跳过」到 meta 与 worker 日志
 *    （AGENTS.md R-2：降级不得静默）。绝不自动挑模型。
 * 2. **融合只读**：提示词明令禁止改代码、禁止派 subagent/tab（argv 也带 excludeTools 兜底）、
 *    禁止 push。它的唯一产物是 fusion.md。
 * 3. **拼装而非投票**（设计稿 §25 明令禁止多数投票）：三路不是三个候选票，
 *    复跑计数与越界计数是**证据权重**，不是选票。提示词把这一点写成硬指令。
 *
 * 完成通知依赖 subagent 账本形状：run json 必须写**终态**（`status !== "running"`）；
 * 停在 running 的账本 watcher 永远不通知 = 静默失效，测试里对此有专门断言。
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { buildPiArgv } from "../runner-argv.ts";
import { recordLink } from "../links.ts";
import type { LaneId } from "./types.ts";

/** 融合者不得拥有的能力（防递归派发/开标签页/自设计时器）。 */
export const FUSION_EXCLUDE_TOOLS = [
	"subagent-win",
	"launch-tabs",
	"set-timer",
	"cancel-timer",
	"list-timers",
	"trace-fusion",
	"tab-finish",
	"tab-report",
	// 2026-11-02 #1 安全边界：**运行时**只读强制。旧版只有提示词里写「只读」，
	// write/edit 仍然可用 ⇒ 提示词被无视时无兼平。工具直接不存，才是硬约束。
	"write",
	"edit",
];

export const FUSION_DEFAULT_WALL_MS = 30 * 60_000;

export interface FusionDispatchInput {
	runId: string;
	runDir: string;
	repoRoot: string;
	/** cross-test-report.md（内含 Fusion Packet 三段 + 复跑段 + 越界段）。 */
	reportPath: string;
	/** 用户设置的融合模型；未设 ⇒ 零动作。 */
	fusionModel?: string;
	/** lane 所用模型（写进提示词，让融合者知道证据出自谁）。 */
	laneModel?: string;
	/** 派发者会话指纹（meta.dispatcherSessionId），用于完成通知归属。 */
	dispatcherSessionId?: string;
	piCli?: string;
	wallBudgetMs?: number;
	outputPath?: string;
	/** seams（测试注入）。 */
	spawnFn?: (cmd: string, argv: string[], opts: object) => ChildProcess;
	runsDir?: string;
	linksPath?: string;
	now?: () => number;
	/** 子进程启动时刻的参考值（测试可注入；缺省 = 真实 Date.now()）。 */
	spawnNow?: () => number;
}

export type FusionStatus = "skipped" | "launched" | "completed" | "failed" | "timeout" | "spawn-error";

/** 融合者的真实成本读数（旧版写死 0 ⇒ 「融合花多少钱」不可知）。 */
export interface FusionUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export interface FusionDispatchResult {
	status: FusionStatus;
	reason: string;
	runId?: string;
	fusionRunId?: string;
	reportPath?: string;
	/** 零模型调用（未配置）时 true。 */
	zeroModelCall: boolean;
	/** 子进程退出码（null = 未取到/信号终止）；#3 判定依据。 */
	exitCode?: number | null;
	/** 从 json 流解析出的真实用量；解析不出 = null（不得写 0 冒充「花了 0 元」）。 */
	usage?: FusionUsage | null;
}

/**
 * 从融合子进程的 `--mode json` 日志里解析用量（与主仓 subagent 解析同一形状：
 * `type==="message_end" && message.role==="assistant"` 的 `usage`）。
 *
 * 解析不出 ⇒ 返回 null（**不是 0**）：0 会被读成「本次融合没花钱」，属于静默失效。
 * 只取尾部 maxBytes（日志可能很大）。
 */
export function parseFusionUsage(logPath: string, maxBytes = 8_000_000): FusionUsage | null {
	try {
		const size = statSync(logPath).size;
		let text = readFileSync(logPath, "utf8");
		if (size > maxBytes) text = text.slice(-maxBytes);
		const out: FusionUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
		let seen = 0;
		for (const line of text.split("\n")) {
			const t = line.trim();
			if (!t.startsWith("{")) continue;
			let ev: unknown;
			try {
				ev = JSON.parse(t);
			} catch {
				continue; // 尾部可能被截断
			}
			const e = ev as { type?: string; message?: { role?: string; usage?: Record<string, number & { total?: number }> } };
			if (e?.type !== "message_end" || e?.message?.role !== "assistant") continue;
			const u = e.message.usage as (Record<string, number> & { cost?: number | { total?: number } }) | undefined;
			if (!u) continue;
			seen++;
			out.input += Number(u.input ?? 0) || 0;
			out.output += Number(u.output ?? 0) || 0;
			out.cacheRead += Number(u.cacheRead ?? 0) || 0;
			out.cacheWrite += Number(u.cacheWrite ?? 0) || 0;
			out.cost += Number(typeof u.cost === "object" ? (u.cost?.total ?? 0) : (u.cost ?? 0)) || 0;
			out.turns += 1;
		}
		return seen > 0 ? out : null;
	} catch {
		return null;
	}
}

/** 融合提示词（纯函数）。 */
export function buildFusionPrompt(i: {
	runId: string;
	reportPath: string;
	laneModel?: string;
	outputPath: string;
	repoRoot: string;
}): string {
	const lanes = (["A", "B", "C"] as LaneId[]).map((l) => `- TRACE ${l}：\`lanes/${l}/trajectory.md\``).join("\n");
	return [
		`你是 trace-fusion 的**融合者**（run ${i.runId}）。任务：把三路独立诊断**拼装**成一份可执行的推进方案。`,
		``,
		`## 材料（先读，不要自己重新诊断）`,
		``,
		`1. 主材料：\`${i.reportPath}\` —— 内含 Hard Facts、Validation 复跑、行号引用越界校验、Fusion Packet（Hard Facts / Conflicts / Instruction 三段）与三路 trajectory 摘录。`,
		`2. 需要细节时按下列路径 read 原文（不要全仓巡查）：`,
		lanes,
		`3. 三路诊断的基点 commit 已写在报告里；核验历史版本用 \`git show <base>:<path>\`，不要用当前工作树代替。`,
		``,
		`## 硬纪律`,
		``,
		`- **拼装，不是投票**（设计稿 §25 明令禁止多数投票）：三路不是三张票。共识只说明「值得优先核验」，不说明成立。`,
		`- **可执行证据压过自报置信度**：报告「Validation 复跑」段里 \`声称pass实测失败\` 计数高的 lane，其自报结论必须显式降级并写明降级理由；复跑通过项可作为事实引用。`,
		`- **引用越界即不可引用原文**：报告「行号引用越界校验」段列出的越界引用，**不得原样引用其结论**；需要该证据就自己重新定位并给出你在基点上核过的行。`,
		`- 结论必须给出：采纳什么 / 拒绝什么 / 为什么（按证据强度，不按票数）；分歧的裁决方式（可复核的判据，不是「两票对一票」）。`,
		`- **只读**：禁止修改任何代码文件、禁止 git 写操作、禁止装包、禁止 push、禁止派发 subagent 或开标签页。`,
		`  唯一允许产物是下面这一个输出文件。命令只用于只读核验（read / git show / grep / 只读脚本）。`,
		``,
		`## 输出（必须落盘）`,
		``,
		`写 \`${i.outputPath}\`，六节固定标题：`,
		`1. \`## 1. 采纳结论\`（含每条的证据出处与复跑/越界读数）`,
		`2. \`## 2. 分歧与裁决\``,
		`3. \`## 3. 证据核验\`（你实际跑过的核验命令与结果）`,
		`4. \`## 4. 不可采信项\`（哪些 lane 的哪些结论因何不可采信）`,
		`5. \`## 5. 后续行动\`（有序、可验收，标明涉及的文件）`,
		`6. \`## 6. 可复跑附录\`（逐条命令 + 期望读数，任何人都能重跑）`,
		``,
		`回复只要文件路径 + ≤10 行摘要，不要贴正文。工作目录 \`${i.repoRoot}\`。`,
	].join("\n");
}

const writeRunRecord = (runsDir: string, runId: string, rec: Record<string, unknown>): void => {
	try {
		if (!existsSync(runsDir)) mkdirSync(runsDir, { recursive: true });
		writeFileSync(join(runsDir, `${runId}.json`), JSON.stringify(rec, null, 2) + "\n", "utf8");
	} catch { /* 账本尽力而为（失败时 meta.fusion 仍是权威记录） */ }
};

/**
 * 派发融合（在 collect worker 里 await）。never-throw；任何失败都写进 meta/日志可见处。
 * 未设置 fusionModel ⇒ 零 spawn、零模型调用。
 */
export async function dispatchFusion(input: FusionDispatchInput): Promise<FusionDispatchResult> {
	const outputPath = input.outputPath ?? join(input.runDir, "fusion", "fusion.md");
	if (!input.fusionModel) {
		return { status: "skipped", reason: "未设置 fusionModel（不自动挑模型）", zeroModelCall: true };
	}
	if (!existsSync(input.reportPath)) {
		return { status: "skipped", reason: `主材料缺失：${input.reportPath}`, zeroModelCall: true };
	}
	// 幂等认领：同一 run 只融合一次
	try {
		mkdirSync(join(input.runDir, "fusion"), { recursive: true });
		writeFileSync(join(input.runDir, "fusion", "fusion.claim"), `${new Date().toISOString()}\n`, { encoding: "utf8", flag: "wx" });
	} catch {
		return { status: "skipped", reason: "本 run 已有融合认领（fusion.claim 存在）", zeroModelCall: true };
	}
	if (!input.piCli || !existsSync(input.piCli)) {
		return { status: "spawn-error", reason: "pi CLI 未找到（fusion 未启动）", zeroModelCall: false, reportPath: outputPath };
	}

	const fusionRunId = `run_fuse${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
	const runsDir = input.runsDir ?? join(process.env.APPDATA ?? "", "pi", "agent", "subagent-runs");
	const prompt = buildFusionPrompt({
		runId: input.runId,
		reportPath: input.reportPath,
		laneModel: input.laneModel,
		outputPath,
		repoRoot: input.repoRoot,
	});
	const argv = buildPiArgv({
		cliPath: input.piCli,
		model: input.fusionModel,
		task: prompt,
		excludeTools: FUSION_EXCLUDE_TOOLS,
	});
	const startedMs = input.spawnNow?.() ?? Date.now();
	const startedAt = new Date(startedMs).toISOString();
	writeRunRecord(runsDir, fusionRunId, {
		id: fusionRunId,
		status: "running",
		agent: "fusion",
		task: prompt.slice(0, 200),
		model: input.fusionModel,
		startedAt,
	});
	if (input.dispatcherSessionId) {
		try {
			recordLink({ sessionId: input.dispatcherSessionId, kind: "async", targetId: fusionRunId, detail: `trace-fusion ${input.runId} fusion` }, input.linksPath ? { linksPath: input.linksPath } : {});
		} catch { /* 尽力 */ }
	}

	const spawnFn = input.spawnFn ?? ((c, a, o) => spawn(c, a, o));
	const outPath = join(input.runDir, "fusion", "fusion.stdout.log");
	let child: ChildProcess;
	let outFd: number | undefined;
	try {
		outFd = openSync(outPath, "a");
		child = spawnFn(process.execPath, ["--experimental-strip-types", ...argv.slice(1)], {
			cwd: input.repoRoot,
			windowsHide: true,
			stdio: ["ignore", outFd, outFd],
		});
	} catch (err) {
		if (outFd !== undefined) closeSync(outFd);
		writeRunRecord(runsDir, fusionRunId, { id: fusionRunId, status: "failed", agent: "fusion", startedAt, finishedAt: new Date().toISOString(), error: String((err as Error).message) });
		return { status: "spawn-error", reason: `spawn 失败：${(err as Error).message}`, fusionRunId, zeroModelCall: false };
	}

	const budget = Math.max(60_000, Math.trunc(input.wallBudgetMs ?? FUSION_DEFAULT_WALL_MS));
	let timedOut = false;
	// #3（2026-11-02）：必须拿退出码。「只要文件存在就算成功」会把非零退出（崩了/预算耗尽/模型报错）
	// 读成 completed，而旧产物存在时更是把**上一次融合的文件**当成本次结果。
	let exitCode: number | null = null;
	let exitSignal: string | null = null;
	const done = new Promise<"exit" | "timeout" | "error">((resolve) => {
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill("SIGKILL");
			} catch { /* 尽力 */ }
			resolve("timeout");
		}, budget);
		child.once("error", (e) => {
			clearTimeout(timer);
			(e as Error & { __fuse?: string }).__fuse = String(e?.message ?? e);
			resolve("error");
		});
		child.once("exit", (code: number | null, signal: string | null) => {
			clearTimeout(timer);
			exitCode = code;
			exitSignal = signal;
			if (!timedOut) resolve("exit");
		});
	});
	const outcome = await done;
	if (outFd !== undefined) closeSync(outFd);
	const finishedAt = new Date().toISOString();
	const usage = parseFusionUsage(outPath);
	const produced = existsSync(outputPath);
	// 「本次新写的」：产物 mtime 不得早于启动时刻（留 2s 容差防文件系统时间粒度/钟差）
	const fresh = produced && statSync(outputPath).mtimeMs >= startedMs - 2_000;
	let status: FusionStatus;
	let reason: string;
	if (outcome === "timeout") {
		status = "timeout";
		reason = produced && fresh
			? `墙钟预算 ${budget}ms 耗尽，已终止子进程（退出时已有本次产物，但 turn 未完，不得当完整结果）`
			: `墙钟预算 ${budget}ms 耗尽，已终止子进程`;
	} else if (outcome === "error") {
		status = "failed";
		reason = "子进程 error 事件（未能正常启动/执行）";
	} else if (exitCode !== 0) {
		status = "failed";
		reason = `子进程非零退出（exit=${exitCode ?? `signal ${exitSignal ?? "?"}`}），不得计为融合成功`;
	} else if (!produced) {
		status = "failed";
		reason = "子进程 exit=0 但未产出融合文件（详见 fusion.stdout.log）";
	} else if (!fresh) {
		status = "failed";
		reason = `融合产物早于本次启动（mtime=${new Date(statSync(outputPath).mtimeMs).toISOString()} < startedAt），属陈旧产物，不得计为本次结果`;
	} else {
		status = "completed";
		reason = `融合产物已生成：${outputPath}`;
	}
	writeRunRecord(runsDir, fusionRunId, {
		id: fusionRunId,
		status, // 必须终态：停在 running 的账本 watcher 永不通知 ⇒ 静默失效
		agent: "fusion",
		model: input.fusionModel,
		startedAt,
		finishedAt,
		exitCode,
		exitSignal,
		produced,
		productFresh: fresh,
		text: produced ? `融合产物：${outputPath}` : timedOut ? "墙钟预算耗尽，未见融合产物" : "子进程退出但未产出融合文件",
		// 成本读数：从 json 流解析；解析不出记 null（不得写 0 冒充「本次未花钱」）
		cost: usage ? { total: usage.cost, input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite } : null,
		turns: usage?.turns ?? null,
	});
	return { status, reason, fusionRunId, reportPath: outputPath, zeroModelCall: false, exitCode, usage };
}

/**
 * collect worker 的融合步骤（抽出成可测函数，2026-11-02）。
 * 职责：调 dispatchFusion → 把结果写进 meta.json 的 `fusion` 字段 → 日志。
 * **不抛**：融合失败不得弄崩收集链（收集已终态）。
 */
export async function runFusionStep(opts: {
	meta: { runId: string; runDir: string; repoRoot: string; dispatcherSessionId?: string; laneModels?: Record<string, string>; workerModel?: string };
	reportPath: string;
	fusionModel?: string;
	piCli?: string;
	log: (msg: string) => void;
	dispatch?: (i: FusionDispatchInput) => Promise<FusionDispatchResult>;
	runsDir?: string;
	linksPath?: string;
	spawnFn?: FusionDispatchInput["spawnFn"];
}): Promise<FusionDispatchResult> {
	const dispatch = opts.dispatch ?? dispatchFusion;
	let res: FusionDispatchResult;
	try {
		res = await dispatch({
			runId: opts.meta.runId,
			runDir: opts.meta.runDir,
			repoRoot: opts.meta.repoRoot,
			reportPath: opts.reportPath,
			// 接线关键：模型只能来自用户设置（此处传什么就用什么，不得写死）
			fusionModel: opts.fusionModel,
			laneModel: opts.meta.laneModels?.A ?? opts.meta.workerModel,
			dispatcherSessionId: opts.meta.dispatcherSessionId,
			piCli: opts.piCli,
			runsDir: opts.runsDir,
			linksPath: opts.linksPath,
			spawnFn: opts.spawnFn,
		});
	} catch (err) {
		res = { status: "spawn-error", reason: `融合步骤异常：${(err as Error).message}`, zeroModelCall: false };
	}
	opts.log(`fusion: ${res.status} — ${res.reason}${res.usage ? ` [成本 $${res.usage.cost.toFixed(4)} / ${res.usage.turns} turns / cacheRead ${res.usage.cacheRead}]` : " [成本读数缺失：json 流未解析出 usage]"}`);
	try {
		const metaPath = join(opts.meta.runDir, "meta.json");
		const raw = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown> : {};
		// phase / result 正交（2026-11-02 #3）：completed 不再同时表示「收集完成」与「融合成功」两件事。
		// phase = 流水线走到哪；result = 本次融合的真实结局。
		const phase = res.status === "skipped" ? "collected" : res.status === "completed" ? "fused" : "fusing-failed";
		const result: Record<FusionStatus, string> = {
			skipped: "skipped",
			launched: "running",
			completed: "succeeded",
			failed: "failed",
			timeout: "timeout",
			"spawn-error": "failed",
		};
		writeFileSync(
			metaPath,
			JSON.stringify({
				...raw,
				phase,
				fusion: {
					status: res.status,
					result: result[res.status],
					reason: res.reason,
					model: opts.fusionModel ?? null,
					fusionRunId: res.fusionRunId ?? null,
					reportPath: res.reportPath ?? null,
					exitCode: res.exitCode ?? null,
					usage: res.usage ?? null,
					at: new Date().toISOString(),
				},
			}, null, 2) + "\n",
			"utf8",
		);
	} catch (err) {
		opts.log(`fusion: meta 写入失败 ${(err as Error).message}`); // 不弄崩收集链
	}
	return res;
}

