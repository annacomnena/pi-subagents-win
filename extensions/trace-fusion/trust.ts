/**
 * trace-fusion/trust.ts — worktree 预信任（真实运行修复，2026-09-15 首跑发现）
 *
 * 问题：pi 对含 .pi 资源的项目目录有 Trust 交互确认（project-trust.js）。
 * launch-tabs 从不遇到它，因为派发目录是用户已信任的仓库；而 trace worktree
 * （~/.pi/tfl-wt/<runId>/{a,b,c}）每次 run 都是全新路径 → 每个 tab 卡在
 * "Trust project folder?" 选择器上，永不进入任务。
 *
 * 修复：pi 的信任解析（findNearestTrustEntry）会从 cwd 向上逐级查找——
 * 只需在 trust.json 中把 worktree 根（~/.pi/tfl-wt）标记为 trusted=true，
 * 一次写入覆盖所有 run 的 lane 树与 eval 树，且不随 run 累积条目。
 *
 * trust.json 契约（pi trust-manager.js）：{ "<canonicalized-path>": true|false|null }，
 * key 为 realpathSync 后的绝对路径；写入必须保留既有条目（那是用户对其它项目的信任决定）。
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function defaultTrustStorePath(): string {
	return join(homedir(), ".pi", "agent", "trust.json");
}

export interface TrustResult {
	ok: boolean;
	/** 本次实际写入的路径（已存在 trusted=true 时为 undefined）。 */
	wrote?: string;
	error?: string;
}

/**
 * 确保 trust.json 中 <dir>=true（realpath 规范化）。幂等；损坏的 trust.json
 * 视为不可触碰（返回 error，不打断派发——tab 会退回旧的交互确认行为）。
 */
export function ensureDirTrusted(dir: string, trustStorePath: string = defaultTrustStorePath()): TrustResult {
	let target: string;
	try {
		// native realpath 与 pi 的 canonicalizePath 同口径（Windows 大小写/盘符归一）
		target = realpathSync.native(dir);
	} catch {
		return { ok: false, error: `目录不存在，无法预信任：${dir}` };
	}

	let data: Record<string, boolean | null> = {};
	if (existsSync(trustStorePath)) {
		try {
			const parsed = JSON.parse(readFileSync(trustStorePath, "utf8")) as unknown;
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
				return { ok: false, error: `trust store 格式异常，保守起见不写入：${trustStorePath}` };
			}
			for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
				if (typeof v === "boolean") data[k] = v;
			}
		} catch (err) {
			return { ok: false, error: `trust store 读取失败（不写入）：${(err as Error).message}` };
		}
	}

	if (data[target] === true) return { ok: true };

	data[target] = true;
	try {
		mkdirSync(dirnameSafe(trustStorePath), { recursive: true });
		const tmp = `${trustStorePath}.tfl-tmp`;
		// 与 pi 的写出口径一致：排序 + 2 空格缩进 + 尾换行；temp+rename 避免半写
		const sorted: Record<string, boolean | null> = {};
		for (const k of Object.keys(data).sort()) sorted[k] = data[k];
		writeFileSync(tmp, `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
		renameSync(tmp, trustStorePath);
		return { ok: true, wrote: target };
	} catch (err) {
		return { ok: false, error: `trust store 写入失败：${(err as Error).message}` };
	}
}

function dirnameSafe(p: string): string {
	const idx = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
	return idx > 0 ? p.slice(0, idx) : p;
}
