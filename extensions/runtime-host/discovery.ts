/**
 * runtime-host/discovery.ts — G2：host.json 读写 + host 活性判定（总计划 §25 / G2 计划 §2-§3）
 *
 * host.json = `~/.pi/agent/runtime/host.json`（经 PI_RUNTIME_DIR 覆盖，同 defaultRuntimeDir）。
 *
 * 关键纪律（research 风险 4）：**host.json 是 hint 而非 truth**——崩溃（非优雅退出）后
 * 文件残留 = 僵尸文件。本层任何「host 活着吗」的答案都不能只信文件：
 *   - `dead`：`process.kill(pid, 0)` 探针失败（含 EPERM 视为存活——进程在、只是无权发信号）
 *   - `alive`：pid 存活 **且** `GET 127.0.0.1:<port>/v1/health` 带超时探活成功
 *   - `stale`：pid 存活但探活失败/超时（进程在、服务面不可用）
 *   - `missing`：文件缺失或不可解析
 *
 * 写路径（tmp+rename 原子，同 registry.ts::writeRawAtomic 模式）：server 启动 listen 成功后
 * 写一次；优雅退出 / stop 时删除。**僵尸文件可被新实例直接覆盖**（新实例 listen 成功即
 * 重写 host.json——覆盖前不校验旧文件活性，活性只影响「是否要重新 spawn」，不影响覆盖安全性：
 * 旧实例若还活着，其 stop/退出清理会按 instanceId 匹配才删，不会误删新文件）。
 *
 * 红线：纯 node 内建 + `extensions/runtime/*`（journal.ts 的 defaultRuntimeDir）；
 * 禁 Pi API。所有读/探活函数 never-throw（失败落 null / "dead" 等兜底值）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { dirname, join } from "node:path";
import { defaultRuntimeDir } from "../runtime/journal.ts";
// isProcessAlive 唯一实现在 runtime/liveness.ts（0920 backlog B7 移居；runtime-host→runtime 方向合规）
import { isProcessAlive } from "../runtime/liveness.ts";
export { isProcessAlive };

/** 协议版本（首版冻结；G5 GUI 对接时按此分叉）。 */
export const PROTOCOL_VERSION = 1;

/** host.json 内容契约（总计划 §25；端口动态——127.0.0.1:0 启动，实际端口写盘做发现）。 */
export interface HostInfo {
	/** 本实例 id（`host_<base36>_<rand>`）；清理时按此匹配，防误删僵尸覆盖后的新文件。 */
	instanceId: string;
	pid: number;
	/** 实际监听端口（127.0.0.1）。 */
	port: number;
	/** ISO 时间。 */
	startedAt: string;
	protocolVersion: number;
	/** G6-P1：本机认证 token（host 启动生成；同机进程可读；仅 WS 升级面校验，
	 *  绝不出现在任何 HTTP 响应里）。旧文件/测试夹具可缺省（可选字段）。 */
	token?: string;
}

/** host 四态：missing（无/坏文件）、alive（探活成功）、stale（进程在但探活失败）、dead（进程不在，僵尸文件）。 */
export type HostState = "missing" | "alive" | "stale" | "dead";

/** 探活超时缺省 1.5s（GUI poll 1-3s 节奏内的低档）。 */
export const HEALTH_PROBE_TIMEOUT_MS = 1500;

export function hostInfoPath(): string {
	return join(defaultRuntimeDir(), "host.json");
}

/** 生成 host 实例 id（同族格式：`host_<base36 时间戳>_<随机>`）。 */
export function newInstanceId(now: Date = new Date()): string {
	const rand = Math.random().toString(36).slice(2, 8);
	return `host_${now.getTime().toString(36)}_${rand}`;
}

/** G6-P1：生成 WS 认证 token（192-bit 随机，base64url——URL/Cookie 安全字符集）。 */
export function generateHostToken(): string {
	return randomBytes(24).toString("base64url");
}

// ── 读（tolerant：缺失/坏 JSON/字段缺 → null，永不 throw）─────────

export function readHostInfo(path: string = hostInfoPath()): HostInfo | null {
	let raw: string;
	try {
		if (!existsSync(path)) return null;
		raw = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	try {
		const v = JSON.parse(raw) as Record<string, unknown>;
		if (
			typeof v !== "object" || v === null ||
			typeof v.instanceId !== "string" || v.instanceId.length === 0 ||
			typeof v.pid !== "number" || v.pid <= 0 ||
			typeof v.port !== "number" || v.port <= 0 ||
			typeof v.startedAt !== "string" ||
			typeof v.protocolVersion !== "number"
		) {
			return null;
		}
		return {
			instanceId: v.instanceId,
			pid: v.pid,
			port: v.port,
			startedAt: v.startedAt,
			protocolVersion: v.protocolVersion,
			...(typeof v.token === "string" && v.token.length > 0 ? { token: v.token } : {}),
		};
	} catch {
		return null;
	}
}

// ── 写 / 删（原子；失败吞掉——host.json 是易失投影，写失败 ≠ server 起不来）──

/**
 * tmp+rename 原子写（同 registry.ts::writeRawAtomic；tmp 名带 pid 段防同目录竞争）。
 * 写失败返回 false 不抛——host.json 是易失投影，写失败 ≠ server 起不来（残留 tmp 尽力清理）。
 */
export function writeHostInfo(info: HostInfo, path: string = hostInfoPath()): boolean {
	const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(tmp, `${JSON.stringify(info, null, 2)}\n`, "utf8");
		renameSync(tmp, path);
		return true;
	} catch {
		try {
			rmSync(tmp, { force: true });
		} catch {
			/* ignore */
		}
		return false;
	}
}

// ── 进程 / 探活探针（never-throw）─────────────────────────────────

/** 删 host.json（stop / 优雅退出用；幂等，永不 throw）。 */
export function removeHostInfo(path: string = hostInfoPath()): void {
	try {
		rmSync(path, { force: true });
	} catch {
		/* ignore */
	}
}

/**
 * 带超时的 `GET 127.0.0.1:<port>/v1/health` 探活（JSON 可解析 = 成功）。
 * 永不 throw：任何失败（ECONNREFUSED / 超时 / 坏 JSON）→ null。
 */
export function fetchHostHealth(port: number, opts?: { timeoutMs?: number }): Promise<unknown | null> {
	const timeoutMs = opts?.timeoutMs ?? HEALTH_PROBE_TIMEOUT_MS;
	return new Promise((resolve) => {
		let settled = false;
		const finish = (v: unknown | null): void => {
			if (settled) return;
			settled = true;
			resolve(v);
		};
		let req: ReturnType<typeof httpRequest> | null = null;
		try {
			req = httpRequest(
				{ host: "127.0.0.1", port, path: "/v1/health", method: "GET", timeout: timeoutMs },
				(res) => {
					const chunks: Buffer[] = [];
					res.on("data", (c: Buffer) => chunks.push(c));
					res.on("end", () => {
						if (res.statusCode !== 200) {
							finish(null);
							return;
						}
						try {
							finish(JSON.parse(Buffer.concat(chunks).toString("utf8")));
						} catch {
							finish(null);
						}
					});
					res.on("error", () => finish(null));
				},
		 );
		} catch {
			finish(null);
			return;
		}
		req.on("timeout", () => {
			req?.destroy();
			finish(null);
		});
		req.on("error", () => finish(null));
		req.end();
	});
}

/** host 四态判定：先 pid 探针（cheap），再 health 探活。host.json 内容缺失/不可用由调用方先判 missing。 */
export async function classifyHost(info: HostInfo, opts?: { timeoutMs?: number }): Promise<HostState> {
	if (!isProcessAlive(info.pid)) return "dead";
	const health = await fetchHostHealth(info.port, opts);
	return health === null ? "stale" : "alive";
}
