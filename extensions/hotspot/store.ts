/**
 * hotspot/store — v4 存储层：分片追加写、snapshot 原子写、TTL 清理、坏行容忍读
 *
 * plans/0924_hotspot_v4_impl_plan.md §B.3/§C.2/§C.5。目录布局：
 *   <agentDir = PI_CODING_AGENT_DIR ?? ~/.pi/agent>/hotspot/<wsid>/
 *     meta.json          # {schema, workspaceRoot, createdAt} 首次建分片时 best-effort 写
 *     events/<pid>-<startTs>-<rand4>.jsonl   # 每进程独占追加（无锁；单文件单写者）
 *     snapshot.json      # 派生缓存（tmp+rename 原子写；唯一写者=主会话）
 *     log.jsonl          # 效果日志（log.ts）
 * - wsid = sha1(normalizeExactPath(findRepoRoot(cwd))).slice(0,16)：worktree 各自 .git → 各自 wsid
 * - snapshot 的 tmp+rename 模式沿用 v2 store.ts commitHotspot；单写者无需跨进程锁（拍板 #4）
 * - 不读写 Wiki/_hotspot.md（v2 已退役，拍板 #9）
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { normalizeExactPath } from "../runtime/recent-scopes.ts";
import { HARD_TTL_MS, SCHEMA_VERSION, type HotEvent, type HotspotSnapshot } from "./types.ts";

/** 仓库根：向上找 .git（目录或文件，worktree 的 .git 是文件）；找不到用 cwd。 */
export function findRepoRoot(cwd: string): string {
	const parts = cwd.split(/[\\/]/);
	for (let i = parts.length; i > 0; i--) {
		const dir = parts.slice(0, i).join(sep);
		if (dir && existsSync(join(dir, ".git"))) return dir;
	}
	return cwd;
}

/** agentDir：存储走 PI_CODING_AGENT_DIR ?? ~/.pi/agent（身份读 runtime state 另走 PI_RUNTIME_DIR，见 collect.ts）。 */
export function defaultAgentDir(): string {
	const override = process.env.PI_CODING_AGENT_DIR;
	if (override && override.trim()) return override.trim();
	return join(homedir(), ".pi", "agent");
}

/** 路径归一为仓库相对（正斜杠）；root 外绝对路径 / 空 → null。（吸收自 v2 usage.ts） */
export function toRepoRelative(p: string, root: string): string | null {
	const norm = p.replace(/\\/g, "/").trim();
	if (!norm) return null;
	const rootNorm = root.replace(/\\/g, "/").replace(/\/+$/, "");
	let rel: string | null = null;
	if (norm.toLowerCase().startsWith(`${rootNorm.toLowerCase()}/`)) rel = norm.slice(rootNorm.length + 1);
	else if (!norm.startsWith("/") && !/^[A-Za-z]:/.test(norm)) rel = norm; // 相对 token → 视作仓库相对（调用方存在性过滤）
	if (!rel) return null;
	rel = rel.replace(/^\.\//, "");
	return rel || null;
}

export interface WsPaths {
	wsDir: string;
	eventsDir: string;
	snapshotPath: string;
	logPath: string;
	metaPath: string;
}

/** wsid = sha1(normalizeExactPath(root)).slice(0,16)。 */
export function workspaceIdOf(root: string): string {
	return createHash("sha1").update(normalizeExactPath(root)).digest("hex").slice(0, 16);
}

export function wsPaths(agentDir: string, wsid: string): WsPaths {
	const wsDir = join(agentDir, "hotspot", wsid);
	return {
		wsDir,
		eventsDir: join(wsDir, "events"),
		snapshotPath: join(wsDir, "snapshot.json"),
		logPath: join(wsDir, "log.jsonl"),
		metaPath: join(wsDir, "meta.json"),
	};
}

/** 首次建分片时 best-effort 写 meta.json（幂等：已存在即跳过；失败静默）。 */
export function ensureWorkspace(agentDir: string, wsid: string, workspaceRoot: string): void {
	try {
		const p = wsPaths(agentDir, wsid);
		mkdirSync(p.eventsDir, { recursive: true });
		if (!existsSync(p.metaPath)) {
			writeFileSync(p.metaPath, `${JSON.stringify({ schema: SCHEMA_VERSION, workspaceRoot, createdAt: new Date().toISOString() }, null, "\t")}\n`);
		}
	} catch {
		/* 静默：存储不可用绝不打断主流程 */
	}
}

const PROCESS_START_TS = Date.now();

/** 分片文件名：每进程独占（pid+启动时间+随机后缀），交错追加互不覆盖。 */
export function newShardName(): string {
	return `${process.pid}-${PROCESS_START_TS}-${randomBytes(2).toString("hex")}.jsonl`;
}

let appendedCount = 0;

/** 本进程自加载以来成功追加的事件条数（snapshot 写入条件之一：本会话追过分片）。 */
export function appendedSinceLoad(): number {
	return appendedCount;
}

/** 非法事件路径字符：真实尖括号（可在注入块伪造闭合标签）与控制字符（\u0000-\u001f 含换行/制表、\u007f，可伪造行）。 */
const ILLEGAL_EVENT_PATH_RE = /[<>\u0000-\u001f\u007f]/;

/**
 * 事件路径合法性（写入侧拒绝，L4 must-fix 1a）：非法字符静默丢弃，与其他采集失败同口径；
 * 同时保持落盘 path 必须已是 repo 相对形态（拒绝绝对路径/盘符/`..` 越界段/空）。
 */
export function isLegalEventPath(path: unknown): path is string {
	return (
		typeof path === "string" &&
		path !== "" &&
		!ILLEGAL_EVENT_PATH_RE.test(path) &&
		!path.startsWith("/") &&
		!/^[A-Za-z]:/.test(path) &&
		!path.split("/").includes("..")
	);
}

/** 追加一条事件（单文件单写者，无锁）；非法路径（isLegalEventPath）与 IO 失败同口径：静默丢弃、返回 false。 */
export function appendEvent(eventsDir: string, shard: string, ev: HotEvent): boolean {
	if (!isLegalEventPath(ev?.path)) return false; // 注入块字段写入侧拒绝（不计数、不落盘）
	try {
		writeFileSync(join(eventsDir, shard), `${JSON.stringify(ev)}\n`, { flag: "a" });
		appendedCount++;
		return true;
	} catch {
		return false;
	}
}

/** 读全部分片：坏行/半行（崩溃残骸）跳过、v!==4 行跳过、坏时间戳跳过。 */
export function readEvents(eventsDir: string): HotEvent[] {
	let files: string[];
	try {
		files = readdirSync(eventsDir);
	} catch {
		return [];
	}
	const out: HotEvent[] = [];
	for (const f of files) {
		if (!f.endsWith(".jsonl")) continue;
		let raw: string;
		try {
			raw = readFileSync(join(eventsDir, f), "utf8");
		} catch {
			continue;
		}
		for (const line of raw.split("\n")) {
			const t = line.trim();
			if (!t) continue;
			try {
				const ev = JSON.parse(t) as HotEvent;
				if (
					ev &&
					ev.v === 4 &&
					(ev.kind === "write" || ev.kind === "read" || ev.kind === "test") &&
					typeof ev.at === "string" &&
					Number.isFinite(Date.parse(ev.at)) &&
					typeof ev.path === "string" &&
					ev.path
				) {
					out.push(ev);
				}
			} catch {
				continue;
			}
		}
	}
	return out;
}

/**
 * snapshot tmp+rename 原子写（单写者=主会话，无跨进程锁；失败清理 tmp）。
 * tmp 名 = pid + 随机后缀：同进程同刻并发也不会互写同一 tmp（L4 残余修复）。
 */
export function writeSnapshotAtomic(snapshotPath: string, snapshot: HotspotSnapshot): boolean {
	const tmp = `${snapshotPath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
	try {
		mkdirSync(dirname(snapshotPath), { recursive: true });
		writeFileSync(tmp, `${JSON.stringify(snapshot, null, "\t")}\n`);
		renameSync(tmp, snapshotPath);
		return true;
	} catch {
		try {
			if (existsSync(tmp)) rmSync(tmp);
		} catch {
			/* ignore */
		}
		return false;
	}
}

/** 容忍读 snapshot；缺失/坏 JSON → null。 */
export function readSnapshot(snapshotPath: string): HotspotSnapshot | null {
	try {
		const snap = JSON.parse(readFileSync(snapshotPath, "utf8")) as HotspotSnapshot;
		if (snap && snap.schema === 4 && Array.isArray(snap.entries)) return snap;
		return null;
	} catch {
		return null;
	}
}

/** 上次 snapshot 时间（ms）：generatedAt 优先，退 mtime，缺失 → 0。 */
export function lastSnapshotAtMs(snapshotPath: string): number {
	const snap = readSnapshot(snapshotPath);
	if (snap) {
		const t = Date.parse(snap.generatedAt);
		if (Number.isFinite(t)) return t;
	}
	try {
		return statSync(snapshotPath).mtimeMs;
	} catch {
		return 0;
	}
}

/** TTL 清理：删除 events/ 中 mtime < now-HARD_TTL-24h 的分片文件（幂等、静默）。返回删除数。 */
export function cleanupStaleShards(eventsDir: string, now: number): number {
	const cutoff = now - HARD_TTL_MS - 24 * 3600_000;
	let files: string[];
	try {
		files = readdirSync(eventsDir);
	} catch {
		return 0;
	}
	let n = 0;
	for (const f of files) {
		if (!f.endsWith(".jsonl")) continue;
		try {
			const p = join(eventsDir, f);
			if (statSync(p).mtimeMs < cutoff) {
				unlinkSync(p);
				n++;
			}
		} catch {
			/* 静默 */
		}
	}
	return n;
}
