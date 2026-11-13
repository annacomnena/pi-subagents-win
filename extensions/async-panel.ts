/**
 * async-panel — 后台异步子 agent 的可视化面板（opencode 风格）
 *
 * 目标：async 派发不是「fire-and-forget」——TUI 上要能看到
 * 正在运行的后台任务列表、状态，完成时有反馈。
 *
 * UI 载体（pi 扩展 API）：
 *   - ctx.ui.setWidget("subagent-async", lines) —— 编辑器上方常驻组件（任务面板）
 *   - ctx.ui.setStatus("subagent-async", text)  —— 页脚状态栏摘要
 *   - sendWindowsToast —— 完成/失败通知
 *
 * 触发：async 派发时、任务完成回调里、以及 10s 兜底定时器（自愈刷新）。
 */

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { sendWindowsToast } from "./notify-windows.ts";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fusionProgressLine, readFusionProgress } from "./runtime/fusion-progress.ts";
import { homedir } from "node:os";
import { join } from "node:path";

export const ASYNC_WIDGET_KEY = "subagent-async";
export const ASYNC_STATUS_KEY = "subagent-async";

/** 与 index.ts 的 AsyncRunRecord 同构（避免循环依赖，这里独立声明）。 */
export interface AsyncPanelRecord {
	id: string;
	agent?: string;
	/**
	 * ⚠️ **运行时不保证存在**：`task` 在类型上是必填，但面板读的是**磁盘上的 run json**，
	 * `JSON.parse` 不校验字段 ⇒ 缺 `task` 的记录会直接进到这里。
	 * 实测：`run_fusemweer6ma_jryr.json`（`agent=fusion`，579 字节）**无 `task` 字段**，
	 * 面板 timer 调 `shortTaskLabel(undefined).replace()` ⇒ uncaughtException **直接杀掉主会话**
	 * （2026-11-13）。⇒ 类型声明为可选，显示层一律带兜底。
	 */
	task?: string;
	/**
	 * 派发时解析的模型（`provider/id` 全名）。由 `index.ts:4650` 写入。
	 *
	 * ⚠️ 语义边界（已实测）：`if (!record.model)` 守卫 ⇒ **只写一次**，在派发时。
	 * `runWithFallback` 换成第二个模型时**不回写** ⇒ 这里看到的是「**最初解析**的模型」，
	 * 不是 fallback 后的实际值。（`usageEvents` 也补救不了：落盘前被
	 * `slimRunRecordForDisk()` 清空，实测 53 个 run json 里带 model 的 usageEvent 为 0 个。）
	 * 要让这里变成「实际模型」必须先补记录，属于派发链改动，不在本次显示层范围。
	 */
	model?: string;
	status: "running" | "completed" | "failed" | "cancelled";
	result?: {
		text?: string;
		error?: string;
		usage?: { cost?: number; turns?: number };
	};
	startedAt: string;
	/** 文件 mtime（终态 TTL 用；run 文件无 finishedAt 字段，以最后写入时刻为准）。 */
	mtimeMs?: number;
	/**
	 * 实时进度来源（2026-11-05 第 3 项显示层）：融合者把自己 `--mode json` 的事件流写进
	 * `fusion.stdout.log`，这里只读解析成「第 N turn · Xs 前 · stopReason」。
	 * 仅 `agent="fusion"` 的记录会带它；其它 subagent 没有这个字段 ⇒ 行为不变。
	 */
	progressSource?: { logPath: string; runDir?: string };
}

const DEFAULT_RUNS_DIR = join(homedir(), ".pi", "agent", "subagent-runs");

let lastUi: ExtensionUIContext | null = null;

/** 派发/完成时把当前会话的 UI 引用注入（execute 的 _ctx.ui）。 */
export function bindAsyncPanelUi(ui: ExtensionUIContext | undefined | null): void {
	if (ui) lastUi = ui;
}

/** reload/会话切换时清空缓存的 UI 引用（旧 ctx 已 stale，必须丢弃）。 */
export function clearAsyncPanelUi(): void {
	lastUi = null;
}

function readAsyncRecords(runsDir: string): AsyncPanelRecord[] {
	if (!existsSync(runsDir)) return [];
	return readdirSync(runsDir)
		.filter((f) => f.endsWith(".json"))
		.map((f) => {
			try {
				const rec = JSON.parse(readFileSync(join(runsDir, f), "utf8")) as AsyncPanelRecord;
				try {
				rec.mtimeMs = statSync(join(runsDir, f)).mtimeMs;
				} catch {
				/* stat 失败则无 TTL（常驻旧行为），不炸面板 */
				}
				return rec;
			} catch {
				return null;
			}
		})
		.filter((r): r is AsyncPanelRecord => r !== null)
		.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
}

/** 终态卡片可见时长：过期即从面板消失（此前常驻不清除，见 plans/0922_async_tui_widget_diagnosis.md）。 */
export const ASYNC_DONE_TTL_MS = 30 * 60 * 1000;

/**
 * 任务短标签：取首行，遇到中英文句读即截断（L 链任务首句即主题，
 * 后面全是交接纪律废话）；超 36 字符再硬截。解决此前 slice(0,40)
 * 把“完成后不提交，回复…”纪律文本拦腰截断上墙的问题。
 */
export function shortTaskLabel(task: string | undefined | null): string {
	// 显示层不得假设磁盘记录完整：缺 task 时走兜底，绝不 throw。
	// （本函数曾在面板 timer 里因 task=undefined 抛 TypeError，uncaughtException 杀掉整个主会话。）
	if (typeof task !== "string") return "(无任务文本)";
	const first = task.replace(/\s+/g, " ");
	if (!first.trim()) return "(空任务文本)";
	const cut = first.search(/[。；！？!?;]/);
	const base = cut >= 0 ? first.slice(0, cut + 1) : first;
	return base.length > 36 ? `${base.slice(0, 35)}…` : base;
}

/**
 * 模型短名（面板行内展示用）：取 `provider/id` 的最后一段，超长截断。
 *
 * 为何取最后一段：完整名最长 32 字符（`opendesigngo/deepseek-v4.1-flash`），
 * 而 running 行已经有 agent + 36 字任务标签 + runId + age，直接追加全名会爆行。
 *
 * ⚠️ 已知代价（显式登记，不是不知道）：只取末段会丢失同源信息 ——
 * `lan-199/bonsai`、`local-bonsai/bonsai` 都变成 `bonsai`。
 * 需要区分源时看 `subagent-win({action:"status"})` 的 `Model:` 行（那里是全名）。
 * 取舍：面板是「扫一眼谁在跑」的概览，不是审计面。
 */
export const MODEL_LABEL_MAX_CHARS = 14;

export function shortModelLabel(model: string | undefined | null): string | undefined {
	if (typeof model !== "string") return undefined;
	const trimmed = model.trim();
	if (!trimmed) return undefined;
	const slash = trimmed.lastIndexOf("/");
	// 「provider/」 这种尾斜杠形态：末段为空 ⇒ 保留���串（不能返回空字符串）
	const seg = slash >= 0 && slash < trimmed.length - 1 ? trimmed.slice(slash + 1) : trimmed;
	if (!seg) return undefined;
	return seg.length > MODEL_LABEL_MAX_CHARS ? `${seg.slice(0, MODEL_LABEL_MAX_CHARS - 1)}…` : seg;
}

/** 刷新面板：running 任务列表（widget）+ 摘要（status）。无 UI 时静默。 */
export function refreshAsyncPanel(runsDir: string = DEFAULT_RUNS_DIR, ui: ExtensionUIContext | null = lastUi): void {
	if (!ui) return;
	let records: AsyncPanelRecord[];
	try {
		records = readAsyncRecords(runsDir);
	} catch {
		return;
	}
	const running = records.filter((r) => r.status === "running");
	// 终态只保留 TTL 内的可见性：过期即消失（此前常驻不清除）；completed 不再挂 error 尾巴
	// （终态文件的 result.error 常是中途 transient 失败的残留，✓+错误尾自相矛盾）。
	const now = Date.now();
	const recentlyDone = records
		.filter((r) => r.status !== "running")
		.filter((r) => r.mtimeMs === undefined || now - r.mtimeMs < ASYNC_DONE_TTL_MS)
		.slice(0, 3);

	// Widget：opencode 风格任务面板（编辑器上方）。全空时传 undefined 让 pi 移除卡片
	// （此前常驻 "No async subagents" 行，无自清除路径）。
	if (running.length === 0 && recentlyDone.length === 0) {
		try {
			ui.setWidget(ASYNC_WIDGET_KEY, undefined);
			ui.setStatus(ASYNC_STATUS_KEY, undefined);
		} catch {
			/* 非 TUI 模式下忽略 */
		}
		return;
	}
	const lines: string[] = [];
	{
		if (running.length > 0) {
			lines.push(`⏳ ${running.length} running`);
			for (const r of running) {
				const agent = r.agent ?? "subagent";
				const age = formatAge(r.startedAt);
				// 模型绑在 agent 上（`searcher[bonsai]: …`）—— 语义是「谁用什么模型」。
				// 无 model（如 provider 在 resolveCallModel 之前就挂）⇒ 不加方括号，
				// 不显示「(未知)」：既有行本来就不带模型，空 bracket 只会是噪声。
				const m = shortModelLabel(r.model);
				const agentLabel = m ? `${agent}[${m}]` : agent;
				// 融合者带实时进度（第 N turn + 年龄），其它 subagent 行为不变（无 progressSource）。
				let prog: string | null = null;
				if (r.progressSource?.logPath) {
					try {
						prog = fusionProgressLine(readFusionProgress(r.progressSource.logPath));
					} catch {
						prog = null; // 进度读不到不得让面板崩
					}
				}
				lines.push(`  ${agentLabel}: ${shortTaskLabel(r.task)} (${r.id} · ${age})${prog ? `\n     ↳ ${prog}` : ""}`);
			}
		}
		// 终态区压缩：失败/取消逐条（需要人看），成功只记条数。
		// 此前每条 done 占一行，3 条历史把面板撑成 6 行噪音。
		const failed = recentlyDone.filter((r) => r.status !== "completed");
		const doneCount = recentlyDone.length - failed.length;
		for (const r of failed) {
			const agent = r.agent ?? "subagent";
			const m = shortModelLabel(r.model);
			const agentLabel = m ? `${agent}[${m}]` : agent;
			const err = typeof r.result?.error === "string" && r.result.error ? ` — ${r.result.error.slice(0, 30)}` : "";
			lines.push(`  ✗ ${agentLabel}: ${shortTaskLabel(r.task)} (${r.id})${err}`);
		}
		if (doneCount > 0) {
			lines.push(`  ✓ ${doneCount} completed`);
		}
	}
	try {
		ui.setWidget(ASYNC_WIDGET_KEY, lines);
		ui.setStatus(ASYNC_STATUS_KEY, running.length > 0 ? `subagents: ${running.length} running` : undefined);
	} catch {
		/* 非 TUI 模式（print/json）下 setWidget 可能 no-op，忽略 */
	}
}

/** 任务完成通知（toast）。 */
export function notifyAsyncCompletion(record: AsyncPanelRecord): void {
	const agent = record.agent ?? "subagent";
	if (record.status === "completed") {
		sendWindowsToast({ title: `✅ ${agent} 异步完成`, body: record.id, duration: "short" });
	} else {
		sendWindowsToast({
			title: `❌ ${agent} 异步失败`,
			body: `${record.id}: ${record.result?.error?.slice(0, 80) ?? "failed"}`,
			duration: "long",
		});
	}
}

function formatAge(startedAt: string): string {
	const ms = Date.parse(startedAt);
	if (Number.isNaN(ms)) return "?";
	const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
	if (sec < 60) return `${sec}s`;
	return `${Math.floor(sec / 60)}m${sec % 60}s`;
}

/**
 * 注册 async 面板：10s 兜底定时器（会话空闲时面板也自愈刷新）。
 * 注意：只刷新 UI，不向 LLM 注入任何内容。
 */
export function registerAsyncPanel(pi: ExtensionAPI): () => void {
	// P2：interval 推迟到 session_start（pi 官方模式：工厂不启动后台资源）
	let interval: ReturnType<typeof setInterval> | null = null;
	let sessionGen = 0;
	pi.on("session_start", () => {
		clearAsyncPanelUi(); // 新周期丢弃旧 UI 引用
		const myGen = ++sessionGen;
		if (interval) clearInterval(interval);
		interval = setInterval(() => {
			if (myGen !== sessionGen) return; // 过期周期 no-op
			refreshAsyncPanel();
		}, 10_000);
		interval.unref?.();
	});
	return () => {
		sessionGen++; // 使当前周期 closed
		if (interval) clearInterval(interval);
	};
}
