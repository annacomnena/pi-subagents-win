/**
 * runtime-host/identity.ts — Runtime Daemon 身份基座（第一切片 skeleton）
 *
 * 依据 plans/0923_runtime_daemon_final_plan.md §2.2（单实例/身份挑战）与 §9（第一批切片）：
 *   - runtimeId：规范化 runtimeDir → 稳定 id（同一目录恒同一 id；不同目录必不同）。
 *   - processStartIdentity：进程启动身份（pid + 启动时刻 ISO；G0 脚本据此核对 OS 创建时间，
 *     脚本侧做日期归一 + 容差比对，本字段固定 ISO 格式）。
 *   - nonce challenge：本地受保护通道。服务端用实例秘钥（host.json token，同用户可读）
 *     对 client 随机 nonce 做 HMAC，回显 nonce + instanceId/runtimeId/版本/启动身份；
 *     client 用 host.json 中的 token 本地重算比对。token 本身永不进响应（匿名 /v1/health
 *     只报非敏感就绪信息，见 server.ts）。
 *   - releaseId：不可变 release 标识（package 版本 + gui/dist 内容 hash；dist 缺失 → nodist
 *     后缀，生产发布要求 dist 与 daemon 同步）。
 *   - schemaVersion：host.json / challenge 契约版本（首版冻结为 1）。
 *
 * 红线：纯 node 内建；禁 Pi API；所有函数 never-throw 倾向（解析失败落 null/false，不抛）。
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** host.json / challenge 契约版本（首版冻结；升级需按 §2.4 走迁移程序）。 */
export const RUNTIME_SCHEMA_VERSION = 1;

/** 规范化 runtimeDir：resolve +（win32）小写，保证同一目录恒同一输入。 */
export function normalizeRuntimeDir(dir: string): string {
	const r = resolve(dir);
	return process.platform === "win32" ? r.toLowerCase() : r;
}

/** runtimeId：`rt_<sha256(规范化路径)前12hex>`（稳定、可比对、非敏感可进 health）。 */
export function runtimeIdForDir(dir: string): string {
	const h = createHash("sha256").update(normalizeRuntimeDir(dir), "utf8").digest("hex").slice(0, 12);
	return `rt_${h}`;
}

/** 进程启动身份字符串：`<pid>@<ISO启动时刻>`（G0 脚本解析 @ 后日期核对 OS 创建时间）。 */
export function captureProcessStartIdentity(startedAt: string = new Date().toISOString()): string {
	return `${process.pid}@${startedAt}`;
}

/** 解析 processStartIdentity → { pid, startedAt }；坏格式 → null（never-throw）。 */
export function parseProcessStartIdentity(v: unknown): { pid: number; startedAt: string } | null {
	try {
		if (typeof v !== "string") return null;
		const m = /^(\d+)@(.+)$/.exec(v);
		if (!m) return null;
		const pid = Number(m[1]);
		const startedAt = m[2];
		if (!Number.isInteger(pid) || pid <= 0) return null;
		if (Number.isNaN(Date.parse(startedAt))) return null;
		return { pid, startedAt };
	} catch {
		return null;
	}
}

/**
 * releaseId：`rel_<pkgVersion>_<distHash8>`；dist/index.html 不可读 → `rel_<ver>_nodist`；
 * package.json 不可读 → ver=`0.0.0`。与 daemon 发布同步（§2.1 不可变 release）。
 */
export function computeReleaseId(repoRoot: string, distDir: string): string {
	let ver = "0.0.0";
	try {
		const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version?: unknown };
		if (typeof pkg.version === "string" && pkg.version.length > 0) ver = pkg.version;
	} catch {
		/* ignore */
	}
	try {
		const html = readFileSync(join(distDir, "index.html"));
		const h = createHash("sha256").update(html).digest("hex").slice(0, 8);
		return `rel_${ver}_${h}`;
	} catch {
		return `rel_${ver}_nodist`;
	}
}

// ── nonce challenge（HMAC-SHA256；secret = host.json token）─────────

export interface ChallengeMeta {
	instanceId: string;
	runtimeId: string;
	protocolVersion: number;
	releaseId: string;
	schemaVersion: number;
	processStartIdentity: string;
}

export interface ChallengeResponse extends ChallengeMeta {
	nonce: string;
	/** hex(HMAC-SHA256(secret, nonce))；secret 本身永不外发。 */
	mac: string;
}

/** 生成 client 随机 nonce（128-bit，hex）。 */
export function newChallengeNonce(): string {
	return randomBytes(16).toString("hex");
}

/** 服务端：对 nonce 签名并组装回显体（secret 缺失/空 → null，调用方回 503 fail-closed）。 */
export function answerChallenge(secret: string | null | undefined, nonce: string, meta: ChallengeMeta): ChallengeResponse | null {
	try {
		if (typeof secret !== "string" || secret.length === 0) return null;
		if (typeof nonce !== "string" || nonce.length < 8 || nonce.length > 256) return null;
		const mac = createHmac("sha256", secret).update(nonce, "utf8").digest("hex");
		return { ...meta, nonce, mac };
	} catch {
		return null;
	}
}

/**
 * 客户端：用 host.json 中的 token 本地重算并比对（timingSafeEqual）。
 * expected.meta 字段逐项相等 + mac 匹配 → true；任一不符/异常 → false（fail-closed）。
 */
export function verifyChallengeResponse(
	secret: string | null | undefined,
	nonce: string,
	resp: Record<string, unknown> | null | undefined,
	expected: ChallengeMeta,
): boolean {
	try {
		if (typeof secret !== "string" || secret.length === 0) return false;
		if (!resp || typeof resp !== "object") return false;
		if (resp.nonce !== nonce) return false;
		for (const k of ["instanceId", "runtimeId", "protocolVersion", "releaseId", "schemaVersion", "processStartIdentity"] as const) {
			if ((resp as Record<string, unknown>)[k] !== expected[k]) return false;
		}
		if (typeof resp.mac !== "string") return false;
		const want = createHmac("sha256", secret).update(nonce, "utf8").digest("hex");
		const a = Buffer.from(resp.mac, "utf8");
		const b = Buffer.from(want, "utf8");
		return a.length === b.length && timingSafeEqual(a, b);
	} catch {
		return false;
	}
}

/**
 * 一次完整本地挑战：读 host.json 取 token → POST /v1/challenge {nonce} →
 * 本地 verify。返回 { ok, reason }（ok=false 绝不抛，由调用方判 uncertain）。
 * 用途：ensure 复用前确权（ready 必须本次挑战成功，非仅看文件更新，§2.3）。
 */
export async function runLocalChallenge(opts: {
	hostPath: string;
	port: number;
	expected: ChallengeMeta;
	timeoutMs?: number;
}): Promise<{ ok: boolean; reason: string }> {
	const timeoutMs = opts.timeoutMs ?? 3000;
	try {
		let secret: string | null = null;
		let file: Record<string, unknown> | null = null;
		try {
			if (!existsSync(opts.hostPath)) return { ok: false, reason: "host.json 缺失" };
			file = JSON.parse(readFileSync(opts.hostPath, "utf8")) as Record<string, unknown>;
			secret = typeof file.token === "string" && file.token.length > 0 ? file.token : null;
		} catch {
			return { ok: false, reason: "host.json 不可读" };
		}
		if (!secret) return { ok: false, reason: "legacy host.json 无 token（挑战不可用 → 身份不符）" };
		const nonce = newChallengeNonce();
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), timeoutMs);
		let resp: Record<string, unknown>;
		try {
			const r = await fetch(`http://127.0.0.1:${opts.port}/v1/challenge`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ nonce }),
				signal: ctrl.signal,
			});
			if (r.status !== 200) return { ok: false, reason: `challenge 端点 ${r.status}` };
			resp = (await r.json()) as Record<string, unknown>;
		} catch {
			return { ok: false, reason: "challenge 请求失败/超时" };
		} finally {
			clearTimeout(timer);
		}
		const ok = verifyChallengeResponse(secret, nonce, resp, opts.expected);
		return ok ? { ok: true, reason: "ok" } : { ok: false, reason: "回显与 host.json 身份不符" };
	} catch {
		return { ok: false, reason: "challenge 异常" };
	}
}
