/**
 * runtime/commands-snapshot.ts — 会话**可用斜杠命令**快照（2026-10-20）。
 *
 * ## 为什么需要快照
 * `pi.getCommands()` 只在**会话进程内**可用；daemon / GUI 是独立进程，拿不到 pi 对象。
 * GUI 要做命令面板与补全，就必须有一份可读的盘面。
 *
 * ## 三种 source 语义不同（读 pi 源码 `dist/core/agent-session.js::_bindExtensionCore`）
 * ```js
 * return [
 *   ...extensionCommands,   // source: "extension" → _tryExecuteExtensionCommand，**不落消息**
 *   ...templates,           // source: "prompt"    → expandPromptTemplate 展开成正文 ⇒ 会落消息
 *   ...skills,              // source: "skill"     → _expandSkillCommand 展开成正文 ⇒ 会落消息
 * ];
 * ```
 * ⇒ GUI 必须按 source 分组标注，否则用户以为 `/skill:xxx` 是「命令」，实际它在对话流里
 * 留下一条长消息 —— 那是语义欺骗。快照里保留 `source`，UI 据此区分。
 *
 * ## 时机（V3 实测风险，`bindExtensions` 顺序）
 * ```
 * this._applyExtensionBindings(...)
 * await this._extensionRunner.emit(this._sessionStartEvent);   // ← session_start 在这里
 * this._extensionRunner.reportUnhandledMcpServers();
 * await this.extendResourcesFromExtensions(...);               // ← skill 在这之后才加载
 * ```
 * ⇒ 只在 `session_start` 写会**漏掉 skill 命令**。故：
 *   - `session_start` 写一次（基线）
 *   - `agent_start` 再写一次（懒刷新：那时资源肯定已加载，且用户马上要用命令）
 *
 * ## 红线
 * - never-throw：写失败只是「GUI 命令面板空着」，不影响对话。
 * - 不写 journal。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultRuntimeDir } from "./journal.ts";
import { COMMAND_ARGUMENT_HINTS } from "./builtin-cmd-bridge.ts";

/** 命令来源（与 pi 的 `SlashCommandSource` 对齐，但只保留本仓关心的三种 + 兜底）。 */
export type CommandSource = "extension" | "prompt" | "skill" | "builtin" | "other";

export interface CommandEntry {
	name: string;
	description?: string;
	source: CommandSource;
	/** 参数提示（additive，2026-10-21）。
	 *
	 * 来源：pi 的 `BUILTIN_SLASH_COMMANDS` 自带 `argumentHint`（如 `/model` = `<provider/model>`），
	 * 但 `getCommands()` 返回的 `SlashCommandInfo` 不带它。本仓自注册的命令可在
	 * registerCommand 时自己补。GUI 面板拿它渲染输入提示。
	 *
	 * 加法字段：老读端忽略即可，不破坏契约。
	 */
	argumentHint?: string;
}

export interface CommandsSnapshot {
	version: 1;
	sessionId: string;
	at: string;
	commands: CommandEntry[];
	pid: number;
}

export function commandsDir(runtimeDir: string = defaultRuntimeDir()): string {
	return join(runtimeDir, "state", "commands");
}

export function commandsSnapshotPath(sessionId: string, runtimeDir: string = defaultRuntimeDir()): string {
	return join(commandsDir(runtimeDir), `${sessionId}.json`);
}

/**
 * 把 pi 的 `SlashCommandInfo[]` 归一成快照条目。
 *
 * 纯函数（可单测）：不认的 source 归 `other`，缺失 name 的条目丢弃。
 */
export function normalizeCommands(raw: unknown): CommandEntry[] {
	if (!Array.isArray(raw)) return [];
	const out: CommandEntry[] = [];
	for (const item of raw) {
		if (typeof item !== "object" || item === null) continue;
		const rec = item as Record<string, unknown>;
		const name = typeof rec.name === "string" ? rec.name : "";
		if (name.length === 0) continue;
		const src = typeof rec.source === "string" ? rec.source : "";
		const source: CommandSource =
			src === "extension" || src === "prompt" || src === "skill" || src === "builtin"
				? src
				: "other";
		const description = typeof rec.description === "string" && rec.description.length > 0 ? rec.description : undefined;
		// hint 两个来源：① 源头自带（pi 内建将来若透传）；② 本仓映射表（registerCommand 没有该字段，
		// 见 builtin-cmd-bridge.ts 注释）。源头优先。
		const hintFromSource =
			typeof rec.argumentHint === "string" && rec.argumentHint.length > 0 ? rec.argumentHint : undefined;
		const argumentHint = hintFromSource ?? COMMAND_ARGUMENT_HINTS[name];
		out.push({
			name,
			source,
			...(description !== undefined ? { description } : {}),
			...(argumentHint !== undefined ? { argumentHint } : {}),
		});
	}
	return out;
}

/**
 * 写快照（原子 tmp+rename）。
 * `now` / `dir` 可注入（测试确定性/隔离）。
 */
export function writeCommandsSnapshot(
	sessionId: string,
	commands: CommandEntry[],
	opts: { dir?: string; now?: () => Date } = {},
): boolean {
	const dir = opts.dir ?? commandsDir();
	const now = opts.now ?? (() => new Date());
	const path = join(dir, `${sessionId}.json`);
	try {
		mkdirSync(dir, { recursive: true });
		const snap: CommandsSnapshot = {
			version: 1,
			sessionId,
			at: now().toISOString(),
			commands,
			pid: process.pid,
		};
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(snap), "utf8");
		renameSync(tmp, path);
		return true;
	} catch {
		return false; // never-throw
	}
}

/**
 * 该会话的命令名集合（executor 白名单校验用；读端在 daemon 进程）。
 * 快照缺失/坏 JSON → null（调用方按 `commands-unavailable` 拒绝）。
 */
export function readCommandNames(sessionId: string, dir: string = commandsDir()): Set<string> | null {
	const path = join(dir, `${sessionId}.json`);
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as CommandsSnapshot;
		if (parsed === null || typeof parsed !== "object") return null;
		if (!Array.isArray(parsed.commands)) return null;
		const names = new Set<string>();
		for (const c of parsed.commands) {
			if (typeof c?.name === "string" && c.name.length > 0) names.add(c.name);
		}
		return names;
	} catch {
		return null;
	}
}
