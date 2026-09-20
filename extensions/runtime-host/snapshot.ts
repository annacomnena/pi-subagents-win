/**
 * runtime-host/snapshot.ts — G1：read-only runtime snapshot（Phase 6，总计划 §20-28 / §42 G1 行）
 *
 * 交付：`RuntimeSnapshot` 契约类型（§27 逐字段，version:1 冻结）+ 纯函数
 * `buildRuntimeSnapshot()`。G2 的 `runtime-host/server.ts` 届时直接
 * `import { buildRuntimeSnapshot } from "./snapshot.ts"` 接 `GET /v1/snapshot`。
 *
 * 数据源决策（plans/0918_G1_snapshot_plan.md §0 拍板 (a)：journal 全量 rebuild）：
 *   - 单一 source of truth = journal（journal.ts#L7-12「journal 仍是唯一 source of truth」）；
 *   - 不用 `listProjectedRuns`（state/runs 物化缓存，state/ 缺失或落后时静默过期）；
 *   - 不用 `projectJournalToState`（写盘，违反 R1「snapshot 不落盘」+ R7 读不改写）；
 *   - `rebuildFromEnvelopes`（projector.ts，纯函数无 IO）+ `listRuntimeEnvelopes`
 *     （journal.ts，tolerant：坏行计数、绝不改写文件）组合 = 零落盘、零状态、无 staleness。
 *   - 已知缺口：journal 投影无 phase/waiting/lastStopReason（tab-runs 状态机字段）——
 *     记 open issue 交 G3/G5 决策第二数据源合并；G1 的 RunView = ProjectedRun 原样。
 *
 * master 段注入限制：`getMasterStatus()` 无参数，registry/cutover 目录只能经
 *   `PI_RUNTIME_DIR` 环境变量解析（registry.ts → journal.ts::defaultRuntimeDir#L20）。
 *   测试隔离沿用 `_test_runtime_*` 惯例（import 前设 PI_RUNTIME_DIR）；不为 master
 *   单造注入通道，与全库一致。G5.2 additive：liveness（readLiveness 原生带 stateDir
 *   注入）与 autoHandoff（configPath 注入）跟随已注入通道，不新造面。
 *
 * 红线（总计划 R1/R2/R7）：纯函数、零写盘、零网络、无全局状态；每段独立 try/catch，
 *   单段失败 → 兜底值 + 错误进 sectionErrors[]，**永不 throw**（最外层再兜一层，
 *   G2 的 GET /v1/snapshot 依赖此契约）。
 *
 * sectionErrors 收窄语义（G1 L4 review 必须修复项 3 拍板：收窄而非扩 reader）：
 *   **源文件缺失不算 error**（与 readAttachment「缺失→null」的 tolerant 语义对齐），
 *   **底层 tolerant reader 按设计吞掉的逐文件解析错误也不算 error**——readAttachment
 *   「损坏→null」、listWorkstreams/listTasks「坏文件跳过」、listLettersSynthetic「坏信
 *   跳过」、listRuntimeEnvelopes「坏行计数入 skippedBadLines」，这些解析异常已在各段
 *   自己的容忍通道内可观测（或已被有意丢弃），snapshot 不重复记录；sectionErrors 只记
 *   **底层 API 未吞掉而抛出的调用级异常**（如 EACCES/ENOTDIR 等意外 IO、内部逻辑错误）。
 *
 * 注意：本文件禁止任何写路径（writeFile 系 / mkdirSync 系 / appendFile）——snapshot 是投影
 *   复制，不是第二真相源（R1）。
 */

import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAttentionItems } from "./attention.ts";
import { buildTimelineItems } from "./timeline.ts";
import { workstreamAddress } from "../runtime/address.ts";
import type { RuntimeEnvelope } from "../runtime/envelope.ts";
import { defaultJournalPath, defaultRuntimeDir, listRuntimeEnvelopes } from "../runtime/journal.ts";
import { readLiveness, type MasterLiveness } from "../runtime/liveness.ts";
import { defaultMailboxDir, mailboxBacklog, mailboxDirFor } from "../runtime/mailbox.ts";
import { normalizeMasterSuccession, type MasterSuccessionConfig } from "../runtime/master-auto.ts";
import { getMasterStatus, type MasterStatusView } from "../runtime/master-control.ts";
import type { TaskRecord, WorkstreamRecord } from "../runtime/objects.ts";
import { rebuildFromEnvelopes, type ProjectedRun } from "../runtime/projector.ts";
import { readWakeState, type WakeState } from "../runtime/wake.ts";
import { listTasks, listWorkstreams } from "../runtime/workstreams.ts";

// ── 契约类型（G1 冻结，避免 G3/G5 改 version）──────────────────────

/** G1 保 schema 位（主会话拍板③：G3 只做加法、不收紧已有类型）；真实形状见
 * runtime-host/attention.ts（type 别名，可赋值 Record<string, unknown>）。 */
export type AttentionItem = Record<string, unknown>;
/** 同上；真实形状见 runtime-host/timeline.ts。 */
export type TimelineItem = Record<string, unknown>;

/**
 * master 段：getMasterStatus 视图 + stale 派生位。
 * G5.2 additive：liveness（owner 心跳活压力，readLiveness 直出）+ autoHandoff
 * （config.masterSuccession 归一化切片，GUI auto 开关真实态）。
 */
export type MasterView = MasterStatusView & {
  stale: boolean;
  /** owner 心跳活压力（owner 会话 agent_end 写手落盘；无心跳 = null）。 */
  liveness: MasterLiveness | null;
  /** config.masterSuccession 归一化切片（缺失/坏文件 → 默认切片）。 */
  autoHandoff: MasterSuccessionConfig;
};
/** G5.2 additive：每项加运行时唤醒态与 per-ws 信箱积压。 */
export type WorkstreamView = WorkstreamRecord & {
  /** readWakeState 直出（缺失 = 默认空态）。 */
  wakeState: WakeState;
  /** 本工作流信箱未领积压（mailboxBacklog 按 spool 目录名匹配；读失败 → 0）。 */
  mailboxBacklog: { pending: number; claimed: number };
};
export type TaskView = TaskRecord;
/** runs 段：journal 投影原样（无 tab-runs phase——open issue 1，G3 决策）。 */
export type RunView = ProjectedRun;

export interface RuntimeView {
	/** G1 恒 null 占位；G2 server 起来后注入自信息（open issue 2 冻结字段）。 */
	host: { pid: number; startedAt: string } | null;
	counts: {
		workstreams: number;
		tasks: number;
		runs: number;
		pendingMailbox: number;
	};
	journal: {
		/** 本次全量 rebuild 读到的 envelope 数（不过滤）。 */
		totalEvents: number;
		/** tolerant 读跳过的坏行数（文件保持原样）。 */
		skippedBadLines: number;
		/** rebuild 应用的 envelope 数（dedupe 跳过不计）。 */
		applied: number;
		/** rebuild 跳过数（dedupe 重复 / 未知类型 / subject 缺失）。 */
		skipped: number;
		/** 尾部 N 条（G3 timeline 的现成原料；totalEvents 与 recent 的 limit 语义分开）。 */
		recent: RuntimeEnvelope[];
	};
}

export interface RuntimeSnapshot {
	version: 1;
	/** = opts.now?.toISOString() ?? new Date().toISOString()（now 注入保证同输入同输出）。 */
	generatedAt: string;
	master: MasterView;
	workstreams: WorkstreamView[];
	tasks: TaskView[];
	runs: RunView[];
	/** G3 投影（runtime-host/attention.ts；段级 never-throw，降级 []）。 */
	attention: AttentionItem[];
	/** G3 投影（runtime-host/timeline.ts；默认尾 200 条，at 升序；降级 []）。 */
	timeline: TimelineItem[];
	runtime: RuntimeView;
	/**
	 * 段级调用异常（段名 + message）；仅记底层 API 未吞掉而抛出的异常（如意外 IO）。
	 * 源文件缺失、以及底层 tolerant reader 按设计吞掉的逐文件解析错误不记（收窄语义，
	 * 见文件头注）。正常时 []。
	 */
	sectionErrors: string[];
}

/** 全参数注入（同 HydrateOptions 模式）。master 段不在内（见文件头注：PI_RUNTIME_DIR）。 */
export interface SnapshotOptions {
	/** 缺省 join(defaultRuntimeDir(), "state")——workstreams/tasks 读。 */
	stateDir?: string;
	/** 缺省 defaultMailboxDir()。 */
	mailboxDir?: string;
	/** 缺省 defaultJournalPath()。 */
	journalPath?: string;
	/** timeline 溯源用 links.jsonl 路径（缺省 defaultLinksPath()；G3 加法，拍板③）。 */
	linksPath?: string;
	/** Date 注入，测试确定性（generatedAt 与 stale 判定同源）。 */
	now?: Date;
	/** config.json 路径（G5.2 master.autoHandoff 切片读；缺省包根 config.json，测试注入隔离）。 */
	configPath?: string;
}

// ── 常量与兜底值 ───────────────────────────────────────────────────

/**
 * master stale 阈值：10 分钟。与 registry.ts#L189（attach 的 forceStale 路径
 * `staleAfterMs` 缺省 10*60*1000，局部 const 未 export）同源；master-succession.ts
 * 无现成 isStale 可复用（L1 检索 §3.6 grep verified），此处独立命名常量指回出处。
 */
export const STALE_AFTER_MS = 10 * 60 * 1000;

/** recent 尾部条数（G3 timeline 原料，只读尾 20 条，零成本）。 */
const RECENT_LIMIT = 20;

const FALLBACK_MASTER: MasterView = {
	attachment: null,
	cutover: null,
	snapshot: null,
	backlog: [],
	stale: false,
	liveness: null,
	autoHandoff: normalizeMasterSuccession(undefined),
};

/** 缺省 config：包根 config.json（本文件位于 <pkg>/extensions/runtime-host/，上跳两级；同 command-executor 惯例）。 */
function defaultPkgConfigPath(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "config.json");
}

/**
 * config.masterSuccession 归一化切片（只读）。缺失文件 → 默认切片（非 error，同
 * command-executor.readConfigRaw「无 config = 空对象起步」）；坏 JSON/意外 IO → 抛给
 * 段级记 sectionErrors（防静默重建的语义同源）。
 */
function readAutoHandoffSlice(configPath: string): MasterSuccessionConfig {
	let text: string;
	try {
		text = readFileSync(configPath, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return normalizeMasterSuccession(undefined);
		throw e;
	}
	const parsed = JSON.parse(text) as { masterSuccession?: unknown };
	return normalizeMasterSuccession(parsed?.masterSuccession);
}

const FALLBACK_RUNTIME: RuntimeView = {
	host: null,
	counts: { workstreams: 0, tasks: 0, runs: 0, pendingMailbox: 0 },
	journal: { totalEvents: 0, skippedBadLines: 0, applied: 0, skipped: 0, recent: [] },
};

// ── 段装配（每段一个私有纯函数，各自 tolerant，失败不抛）──────────

function err(section: string, e: unknown): string {
	return `${section}: ${e instanceof Error ? e.message : String(e)}`;
}

function buildMasterSection(now: Date, stateDir: string, configPath: string, sectionErrors: string[]): MasterView {
	try {
		const s = getMasterStatus();
		const age = s.attachment ? now.getTime() - Date.parse(s.attachment.lastHeartbeatAt) : NaN;
		// G5.2 additive（各自 tolerant，失败只记子段、不拖垮 master 段）：
		let liveness: MasterLiveness | null = null;
		try {
			liveness = readLiveness(stateDir); // never-throw（缺失 → null），此处仅兑意外 IO
		} catch (e) {
			sectionErrors.push(err("master.liveness", e));
		}
		let autoHandoff = normalizeMasterSuccession(undefined);
		try {
			autoHandoff = readAutoHandoffSlice(configPath);
		} catch (e) {
			sectionErrors.push(err("master.autoHandoff", e));
		}
		return {
			...s,
			stale: s.attachment !== null && Number.isFinite(age) && age > STALE_AFTER_MS,
			liveness,
			autoHandoff,
		};
	} catch (e) {
		sectionErrors.push(err("master", e));
		return FALLBACK_MASTER;
	}
}

function buildWorkstreamsSection(stateDir: string, mailboxDir: string, now: Date, sectionErrors: string[]): WorkstreamView[] {
	try {
		// G5.2 additive：per-ws 信箱积压一次全量扫描按 spool 目录名匹配（mailboxDirFor 同源
		// sanitize；mailbox 读失败只记子段，工作流清单照常出）。
		let backlogByDir = new Map<string, { pending: number; claimed: number }>();
		try {
			backlogByDir = new Map(mailboxBacklog(mailboxDir).map((r) => [r.recipient, { pending: r.pending, claimed: r.claimed }]));
		} catch (e) {
			sectionErrors.push(err("workstreams.mailboxBacklog", e));
		}
		return listWorkstreams(stateDir).map((ws) => ({
			...ws,
			// tolerant：缺失 → 默认空态；now 注入保证「同种子 + 同 now → 同输出」确定性（G1 契约）
			wakeState: readWakeState(ws.id, stateDir, now),
			mailboxBacklog: backlogByDir.get(basename(mailboxDirFor(workstreamAddress(ws.id), mailboxDir))) ?? { pending: 0, claimed: 0 },
		}));
	} catch (e) {
		sectionErrors.push(err("workstreams", e));
		return [];
	}
}

function buildTasksSection(stateDir: string, sectionErrors: string[]): TaskView[] {
	try {
		return listTasks(undefined, stateDir); // 全量（不按 workstream 过滤）
	} catch (e) {
		sectionErrors.push(err("tasks", e));
		return [];
	}
}

/** 单数据源 = journal 全量 rebuild（§0 拍板 (a)）；输出按 subject 排序（展示序稳定）。 */
function buildRunsSection(journalPath: string, sectionErrors: string[]): RunView[] {
	try {
		const { envelopes } = listRuntimeEnvelopes({ path: journalPath });
		const { state } = rebuildFromEnvelopes(envelopes);
		return [...state.runs.values()].sort((a, b) => a.subject.localeCompare(b.subject));
	} catch (e) {
		sectionErrors.push(err("runs", e));
		return [];
	}
}

function buildRuntimeSection(
	opts: { mailboxDir: string; journalPath: string },
	counts: { workstreams: number; tasks: number; runs: number },
	sectionErrors: string[],
): RuntimeView {
	try {
		// 两次读（§2 表）：一次无 limit 供 rebuild 计数，一次 limit 供 recent；10k 行两次仍是毫秒级（T5）。
		const full = listRuntimeEnvelopes({ path: opts.journalPath });
		const { applied, skipped } = rebuildFromEnvelopes(full.envelopes);
		const recent = listRuntimeEnvelopes({ path: opts.journalPath, limit: RECENT_LIMIT }).envelopes;
		const pendingMailbox = mailboxBacklog(opts.mailboxDir).reduce((n, r) => n + r.pending, 0);
		return {
			host: null, // G2 server 注入自信息；G1 无 host 进程
			counts: { ...counts, pendingMailbox },
			journal: {
				totalEvents: full.envelopes.length,
				skippedBadLines: full.skippedBadLines,
				applied,
				skipped,
				recent,
			},
		};
	} catch (e) {
		sectionErrors.push(err("runtime", e));
		return FALLBACK_RUNTIME;
	}
}

// ── 入口（纯函数，永不 throw）─────────────────────────────────────

/**
 * 装配 RuntimeSnapshot：只读 runtime 文件，无 IO 写、无网络、无子进程、无全局状态。
 * 任何单段（乃至整段装配）失败都落兜底值 + sectionErrors，不向调用方抛。
 */
export function buildRuntimeSnapshot(opts: SnapshotOptions = {}): RuntimeSnapshot {
	// never-throw（G1 L4 review 必须修复项 1）：无效 Date 注入（如 new Date("invalid")）
	// 一律兜底 new Date()；且下方 generatedAt 的生成也在 try/catch 保护内，
	// 任何异常（含异常 now 对象）都不可能漏到调用方。
	let now: Date;
	try {
		const raw = opts.now ?? new Date();
		now = Number.isFinite(raw.getTime()) ? raw : new Date();
	} catch {
		now = new Date();
	}
	const stateDir = opts.stateDir ?? join(defaultRuntimeDir(), "state");
	const mailboxDir = opts.mailboxDir ?? defaultMailboxDir();
	const journalPath = opts.journalPath ?? defaultJournalPath();
	const configPath = opts.configPath ?? defaultPkgConfigPath();

	const sectionErrors: string[] = [];
	let body: Omit<RuntimeSnapshot, "generatedAt" | "sectionErrors">;
	try {
		const master = buildMasterSection(now, stateDir, configPath, sectionErrors);
		const workstreams = buildWorkstreamsSection(stateDir, mailboxDir, now, sectionErrors);
		const tasks = buildTasksSection(stateDir, sectionErrors);
		const runs = buildRunsSection(journalPath, sectionErrors);
		const runtime = buildRuntimeSection(
			{ mailboxDir, journalPath },
			{ workstreams: workstreams.length, tasks: tasks.length, runs: runs.length },
			sectionErrors,
		);
		// G3 填充预留位（拍板③：只做加法）：两纯函数本就 never-throw；外层 try/catch 仅兜
		// 理论上的一切意外抛点 → 段级降级 [] + sectionErrors（与 G1 段纪律一致）。
		let att: AttentionItem[] = [];
		try {
			att = buildAttentionItems({ stateDir, mailboxDir });
		} catch (e) {
			sectionErrors.push(err("attention", e));
		}
		let tl: TimelineItem[] = [];
		try {
			tl = buildTimelineItems({ stateDir, journalPath, linksPath: opts.linksPath });
		} catch (e) {
			sectionErrors.push(err("timeline", e));
		}
		body = { version: 1, master, workstreams, tasks, runs, attention: att, timeline: tl, runtime };
	} catch (e) {
		// 顶层兜底：「snapshot 构建失败」也不炸调用方（G2 GET /v1/snapshot 契约）。
		sectionErrors.push(err("top", e));
		body = {
			version: 1,
			master: FALLBACK_MASTER,
			workstreams: [],
			tasks: [],
			runs: [],
			attention: [],
			timeline: [],
			runtime: FALLBACK_RUNTIME,
		};
	}
	let generatedAt: string;
	try {
		generatedAt = now.toISOString();
	} catch {
		// 双保险：now 已在上方规范化为有效 Date，此处仅兜住一切理论上的残留抛点。
		generatedAt = new Date().toISOString();
	}
	return { version: 1, generatedAt, ...body, sectionErrors };
}
