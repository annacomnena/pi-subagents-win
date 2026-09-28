/**
 * channel-wechat/artifact.ts — M1 入站图片附件漏斗（下载 → 解密 → 白名单 → sha256 原子落盘）
 *
 * 计划：plans/0925_wechat_artifact_M1_plan.md §2.1/§3/§4（决策 D-M1-1：下载发生在受监督的
 * worker 子进程内，inline 于 `commitBatch` 之前）。参考实现：scripts/wechat-ilink-probe.mjs
 * （allowlist / 严格 base64 / AES-128-ECB 解密 / 魔数 / redirect:"manual" 每跳复检——已真机跑通）。
 *
 * 纪律（计划 §3 权限/脱敏 + 研究 §5.5④，A10 哨兵锁死）：
 *   - **零凭据 import**：只 import node 内建；本模块不读 bot_token/config，CDN GET 不带鉴权头
 *     （凭据面零增长——即使被误用也无法构造鉴权面）。
 *   - **秘密不落盘**：`aes_key` / `full_url` 只在 worker 内存出现，绝不进返回值/日志/quarantine/
 *     投影。所有失败结果只含 `{reason, host?, hops?}`（失败类别 + 主机名；无 URL、无 key、无正文）
 *     —— 否则经 worker 的 lastError 落 state.json 即泄（worker.ts 错误面）。
 *   - **fail-closed**：白名单未命中 / 魔数不符 / PKCS7 不过 / 超限 / 任何 IO 失败 → 一律不落盘，
 *     由调用方（worker）落幂等 quarantine 行；本模块不重试、不抛出（返回失败类）。
 *   - opt-in：只被 worker 在 `channels.wechat.artifact.enabled === true` 时调用（缺省零调用）。
 *
 * 落盘（计划 §3）：`<runtimeDir>/wechat/artifacts/files/<sha256hex>.jpg|png`
 *   - 内容寻址：文件名 = 明文 sha256 全量 hex + **魔数派生**扩展名（无原名参与拼接 ⇒ 天然防路径穿越）；
 *   - `existsSync` 即 sha256 去重（同内容跨消息共享同一文件）；
 *   - 原子写：tmp（`wx` 独占创建，0600，位于 artifacts/ 根、不进 files/）+ rename；失败即 rm tmp；
 *     崩溃残留 tmp 不匹配 `<sha>.<ext>` 名 ⇒ 永不参与去重/引用。
 *   - L4-S3（0925 复核建议修）：每次 storeArtifact 顺手 `sweepStaleTmp` 删 artifacts 根下
 *     **>1h** 的 `tmp*.tmp` 崩溃残留（含明文图片）；**只清 tmp、不递归删目录、不动 files/**。
 *     ⚠️ 边界：这**不是**图片隐私问题的全部——正式产物（`files/*.jpg|png`）仍是明文长期保留，
 *     其保留期限/容量/清理规则属 **M2 R1**（artifacts GC），本模块刻意不实现。
 *   - M1 不建索引 json / .trash / 配额 GC（推 M2）——删 `artifacts/` 即回 M0，零迁移。
 */

import { createDecipheriv, createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// ── 常数（计划 §3：代码常数非 config；真机冒烟回采 U8 校准）─────────────

/** CDN host 后缀白名单（探针 probe#L143 同款；后缀含点前缀 ⇒ `evilqq.com`/`qq.com.evil.com` 均不命中）。 */
export const CDN_SUFFIX_ALLOW = [".qq.com", ".qpic.cn", ".weixin.qq.com", ".wx.qq.com", ".cdn.cn"];

/** 单文件明文上限 8MB（计划 §3；超限 → too-large，不落盘）。 */
export const ARTIFACT_MAX_PLAIN_BYTES = 8 * 1024 * 1024;
/** 密文上限 = 明文上限 + 16B（PKCS7 单块 padding 余量）。 */
export const ARTIFACT_MAX_CIPHER_BYTES = ARTIFACT_MAX_PLAIN_BYTES + 16;
/** 单次下载最大跳数（redirect:"manual" 每跳复检；probe safeDownload 同款）。 */
export const ARTIFACT_MAX_HOPS = 3;
/** 单请求超时（计划 §3 批预算行：单请求 ≤15s）。 */
export const ARTIFACT_REQUEST_TIMEOUT_MS = 15_000;
/** 单批 artifact 阶段累计预算（计划 §3：超预算剩余附件 → quarantine `batch-budget`，游标照常提交）。 */
export const ARTIFACT_BATCH_BUDGET_MS = 30_000;
/** artifactRef 相对 runtimeDir 的基（记录/投影只存相对路径，注入时 join 现解绝对路径）。 */
export const ARTIFACT_REL_BASE = "wechat/artifacts/files";
/** L4-S3：崩溃残留 tmp 的最小滞留时长（>1h 才清；单次写入毫秒级、批预算 30s ⇒ 1h 远超任何在写窗口）。 */
export const ARTIFACT_TMP_MAX_AGE_MS = 60 * 60 * 1000;
/** artifacts 根下崩溃残留 tmp 的文件名形状（`tmp<pid>.<base36 时刻>.<随机>.tmp`）。 */
const ARTIFACT_TMP_NAME_RE = /^tmp.*\.tmp$/;

// ── host allowlist（probe#L144 同款 + 仅 http/https 方案）──────────────

/**
 * CDN host 是否放行：显式 extra host（单测 127.0.0.1 注入）> 后缀白名单；仅 http/https。
 * 返回值只含 host（可进日志/错误面），不含 URL。
 */
export function isHostAllowed(urlStr: string, extraHosts: readonly string[] = []): { ok: boolean; host: string } {
	let host: string;
	try {
		const u = new URL(urlStr);
		host = u.hostname.toLowerCase();
		if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, host: `<${u.protocol.replace(":", "") || "bad"}-scheme>` };
	} catch {
		return { ok: false, host: "<invalid-url>" };
	}
	const lower = extraHosts.map((h) => h.trim().toLowerCase()).filter(Boolean);
	if (lower.includes(host)) return { ok: true, host };
	if (CDN_SUFFIX_ALLOW.some((s) => host.endsWith(s))) return { ok: true, host };
	return { ok: false, host };
}

// ── AES key 派生（真机 B：media.aes_key = base64(hex32)；wrapup §5.1 三格式）──

const HEX32_RE = /^[a-f0-9]{32}$/i;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** 严格 base64 解码（拒绝尽力解码的垃圾：字母表 + 回环校验；probe decodeB64 同款）。 */
function decodeB64Strict(s: string): Buffer | null {
	if (typeof s !== "string" || s === "" || !BASE64_RE.test(s)) return null;
	const norm = s + "=".repeat((4 - (s.length % 4)) % 4);
	if (norm.length % 4 !== 0) return null;
	const b = Buffer.from(norm, "base64");
	if (b.length === 0) return null;
	// 回环校验：解出的 base64 必须与规范化输入一致（否则是非法字符被静默吞掉）。
	if (b.toString("base64").replace(/=+$/, "") !== norm.replace(/=+$/, "")) return null;
	return b;
}

/**
 * raw `media.aes_key` → 16B 密钥（wrapup §5.1 规格，按序）：
 *   ① 严格 base64 解出 32B 且为 ASCII hex32 → 取 hex 16B（真机主格式 base64(hex32)）；
 *   ② 字符串本身即 hex32 → 直接 hex 16B（顶层 aeskey 交叉）；
 *   ③ 严格 base64 解出恰好 16B 原始字节 → 用之；
 *   其余（乱码/非严格字母表/长度不符）→ null（fail-closed，调用方落 `bad-key`）。
 */
export function deriveAesKey(rawKey: unknown): Buffer | null {
	if (typeof rawKey !== "string") return null;
	const s = rawKey.trim();
	if (s.length === 0) return null;
	const b64 = decodeB64Strict(s);
	if (b64 !== null && b64.length === 32) {
		const latin = b64.toString("latin1");
		if (HEX32_RE.test(latin)) return Buffer.from(latin, "hex"); // ① base64(hex32)
	}
	if (HEX32_RE.test(s)) return Buffer.from(s, "hex"); // ② 顶层 hex32
	if (b64 !== null && b64.length === 16) return b64; // ③ 严格 base64(raw16)
	return null;
}

// ── 解密 + 魔数白名单（AES-128-ECB + PKCS7；PKCS7 通过 **且** 魔数 jpeg/png）──

export interface DecryptedImage {
	plain: Buffer;
	mime: "image/jpeg" | "image/png";
	ext: "jpg" | "png";
}

export type DecryptResult = { ok: true; value: DecryptedImage } | { ok: false; reason: "decrypt-failed" | "magic-mismatch" };

/**
 * AES-128-ECB + PKCS7 解密，**且** 明文魔数 ∈ {FFD8FF(jpeg), 89504E47(png)} 才算成功
 * （比探针的「PKCS7 > 魔数」判优更严：M1 白名单只有 JPEG/PNG，fail-closed）。
 *   - PKCS7 不过 / 密文长度非 16B 倍数 / key ≠ 16B → `decrypt-failed`；
 *   - PKCS7 过但魔数不在白名单 → `magic-mismatch`（结构性排除可执行体等）。
 */
export function decryptImage(cipher: Buffer, key: Buffer): DecryptResult {
	if (key.length !== 16) return { ok: false, reason: "decrypt-failed" };
	if (cipher.length === 0 || cipher.length % 16 !== 0) return { ok: false, reason: "decrypt-failed" };
	let plain: Buffer;
	try {
		const d = createDecipheriv("aes-128-ecb", key, null); // 缺省 PKCS7
		plain = Buffer.concat([d.update(cipher), d.final()]);
	} catch {
		return { ok: false, reason: "decrypt-failed" };
	}
	const m3 = plain.subarray(0, 3).toString("hex").toUpperCase();
	const m4 = plain.subarray(0, 4).toString("hex").toUpperCase();
	if (m3 === "FFD8FF") return { ok: true, value: { plain, mime: "image/jpeg", ext: "jpg" } };
	if (m4 === "89504E47") return { ok: true, value: { plain, mime: "image/png", ext: "png" } };
	return { ok: false, reason: "magic-mismatch" };
}

/** 魔数派生扩展名（只此两行；声称字段/MIME 一概不作依据）。 */
function extFromMagic(bytes: Buffer): "jpg" | "png" | null {
	const m3 = bytes.subarray(0, 3).toString("hex").toUpperCase();
	const m4 = bytes.subarray(0, 4).toString("hex").toUpperCase();
	if (m3 === "FFD8FF") return "jpg";
	if (m4 === "89504E47") return "png";
	return null;
}

// ── sha256 内容寻址原子落盘 ─────────────────────────────────────────────

export interface StoreArtifactOptions {
	/** `<runtimeDir>/wechat/artifacts`（files/ 与 tmp 同级树；tmp 不进 files/，见头注）。 */
	artifactsDir: string;
	/** artifactRef 相对基（缺省 ARTIFACT_REL_BASE）。 */
	relBase?: string;
	/** 单测故障注入（A6 原子写断言）：write = tmp 写入时抛；rename = 提交时抛。生产不传。 */
	fault?: "write" | "rename";
}

export interface StoredArtifact {
	/** 相对 runtimeDir 的 artifactRef（`wechat/artifacts/files/<sha256>.<ext>`）。 */
	relPath: string;
	sha256: string;
	bytes: number;
	ext: "jpg" | "png";
	/** true = 命中 sha256 去重（未重写文件）。 */
	deduped: boolean;
}

export type StoreArtifactResult = { ok: true; value: StoredArtifact } | { ok: false; reason: "too-large" | "magic-mismatch" | "write-failed" };

/**
 * L4-S3 崩溃残留清扫：删 `<artifactsDir>/` **根一层**下超过 `maxAgeMs` 的 `tmp*.tmp` 明文残留。
 *
 * 边界（刻意不递归删目录，避免删到正在写的文件）：
 *   - 只扫 artifacts 根一层、只删匹配 `tmp*.tmp` 的**普通文件**：不碰 `files/` 正式产物，
 *     也不碰 `inbox/` 等处的 `<文件名>.<pid>.<ts>.tmp`（不以 `tmp` 开头）；
 *   - mtime 距今 ≤ maxAgeMs（缺省 1h）一律不动 ⇒ **正在写的 tmp 永不被删**（写入毫秒级、
 *     批预算 30s ≪ 1h；且 storeArtifact 的清扫发生在创建自己的 tmp **之前**）；
 *   - 单文件 stat/rm 失败只跳过该文件（Windows 被占用句柄 rm 失败不影响主流程）。
 * never-throw：清扫只是卫生，绝不能让落盘失败（目录不存在 ⇒ 返回 0）。
 * @returns 实际删除的文件数
 */
export function sweepStaleTmp(artifactsDir: string, maxAgeMs: number = ARTIFACT_TMP_MAX_AGE_MS): number {
	let names: string[];
	try {
		names = readdirSync(artifactsDir, { withFileTypes: true })
			.filter((d) => d.isFile() && ARTIFACT_TMP_NAME_RE.test(d.name))
			.map((d) => d.name);
	} catch {
		return 0; // 目录不存在/不可读 ⇒ 尚无残留
	}
	let removed = 0;
	const now = Date.now();
	for (const name of names) {
		const p = join(artifactsDir, name);
		try {
			if (now - statSync(p).mtimeMs <= maxAgeMs) continue; // 新鲜（含在写）⇒ 不动
			rmSync(p, { force: true });
			removed += 1;
		} catch {
			/* 跳过：被占用 / 并发已删 / 权限不足 */
		}
	}
	return removed;
}

/**
 * 明文 → `files/<sha256>.<ext>`（ext 只由魔数派生）：existsSync 即去重；
 * tmp（`wx` 独占 + 0600）→ rename 原子提交；任何失败即 rm tmp（不留半开文件）。
 * never-throw（IO 失败归一为 write-failed）。
 */
export function storeArtifact(bytes: Buffer, opts: StoreArtifactOptions): StoreArtifactResult {
	if (bytes.length === 0 || bytes.length > ARTIFACT_MAX_PLAIN_BYTES) return { ok: false, reason: "too-large" };
	const ext = extFromMagic(bytes);
	if (ext === null) return { ok: false, reason: "magic-mismatch" };
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const relBase = (opts.relBase ?? ARTIFACT_REL_BASE).replace(/[\\/]+$/, "");
	const relPath = `${relBase}/${sha256}.${ext}`;
	const filesDir = join(opts.artifactsDir, "files");
	const target = join(filesDir, `${sha256}.${ext}`);
	// L4-S3：顺手清扫 >1h 的崩溃残留 tmp（含明文）——刻意放在去重早退**之前**，
	// 保证「上次崩溃 → 本次同内容重发命中去重」的下次启动同样能清。never-throw。
	sweepStaleTmp(opts.artifactsDir);
	if (existsSync(target)) return { ok: true, value: { relPath, sha256, bytes: bytes.length, ext, deduped: true } };
	let fd = -1;
	let tmp: string | null = null;
	try {
		mkdirSync(filesDir, { recursive: true });
		// tmp 落 artifacts/ 根（files/ 的兄弟），崩溃残留不匹配 sha 名 ⇒ 不参与去重
		tmp = join(dirname(filesDir), `tmp${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`);
		fd = openSync(tmp, "wx", 0o600);
		if (opts.fault === "write") throw new Error("单测故障注入：tmp 写入失败");
		writeFileSync(fd, bytes);
		closeSync(fd);
		fd = -1;
		try {
			chmodSync(tmp, 0o600);
		} catch {
			/* Windows 尽力 */
		}
		if (opts.fault === "rename") throw new Error("单测故障注入：rename 失败");
		renameSync(tmp, target);
		tmp = null;
		try {
			chmodSync(target, 0o600);
		} catch {
			/* Windows 尽力 */
		}
		return { ok: true, value: { relPath, sha256, bytes: bytes.length, ext, deduped: false } };
	} catch {
		if (fd >= 0) {
			try {
				closeSync(fd);
			} catch {
				/* ignore */
			}
		}
		if (tmp !== null) {
			try {
				rmSync(tmp, { force: true });
			} catch {
				/* ignore */
			}
		}
		return { ok: false, reason: "write-failed" };
	}
}

// ── 下载（redirect:"manual" + 每跳复检 allowlist；probe safeDownload 同款）──

/** 附件下载 fetch 注入（缺省 global fetch；单测 stub。形状同 wechat-bind.WechatFetch）。 */
export type ArtifactFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface SafeDownloadDeps {
	fetch: ArtifactFetch;
	/** 单跳超时（缺省 ARTIFACT_REQUEST_TIMEOUT_MS）。 */
	timeoutMs?: number;
	/** 最大跳数（缺省 ARTIFACT_MAX_HOPS）。 */
	maxHops?: number;
	/** allowlist 显式额外 host（单测 127.0.0.1 注入；缺省空）。 */
	extraHosts?: readonly string[];
}

export type SafeDownloadResult =
	| { ok: true; res: Response; host: string; hops: number }
	| { ok: false; reason: "host-not-allowed" | "3xx-missing-location" | "too-many-hops" | "bad-location" | "timeout" | "fetch-failed"; host: string; hops: number };

function isAbortError(e: unknown): boolean {
	return e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");
}

/**
 * 下载：初始 host 复检 + 每跳复检（≤maxHops），`redirect:"manual"` ⇒ 302 越域在**发起请求前**
 * 被拒（stub 实锤：`host-not-allowed hops=1`）。失败对象只含 reason/host/hops（无 URL）。
 * never-throw（网络错误归一 fetch-failed / 超时归一 timeout）。
 */
export async function safeDownload(url: string, deps: SafeDownloadDeps): Promise<SafeDownloadResult> {
	const timeoutMs = deps.timeoutMs ?? ARTIFACT_REQUEST_TIMEOUT_MS;
	const maxHops = deps.maxHops ?? ARTIFACT_MAX_HOPS;
	let cur = url;
	for (let hops = 0; ; ) {
		const gate = isHostAllowed(cur, deps.extraHosts ?? []);
		if (!gate.ok) return { ok: false, reason: "host-not-allowed", host: gate.host, hops };
		let res: Response;
		try {
			res = await deps.fetch(cur, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
		} catch (e) {
			return { ok: false, reason: isAbortError(e) ? "timeout" : "fetch-failed", host: gate.host, hops };
		}
		if (res.status >= 300 && res.status < 400) {
			const loc = res.headers.get("location");
			if (loc === null || loc === "") return { ok: false, reason: "3xx-missing-location", host: gate.host, hops };
			if (++hops > maxHops) return { ok: false, reason: "too-many-hops", host: gate.host, hops };
			let next: string;
			try {
				next = new URL(loc, cur).toString();
			} catch {
				return { ok: false, reason: "bad-location", host: gate.host, hops };
			}
			cur = next;
			continue;
		}
		return { ok: true, res, host: gate.host, hops };
	}
}

// ── 响应体限额读取（Content-Length 预拒 + 流式复拒，双检防谎报头）────────

const TIMEOUT_MARK = { __artifactTimeout: true } as const;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const t = setTimeout(() => reject(TIMEOUT_MARK), ms);
		p.then(
			(v) => {
				clearTimeout(t);
				resolve(v);
			},
			(e: unknown) => {
				clearTimeout(t);
				reject(e);
			},
		);
	});
}

export type ReadBodyResult = { ok: true; body: Buffer } | { ok: false; reason: "too-large" | "timeout" | "read-failed" };

/** 流式读 body 到 limit（≥ 上限即中断）；超时/读错归一类别。never-throw。 */
export async function readBodyLimited(res: Response, limit: number, timeoutMs: number): Promise<ReadBodyResult> {
	// 双检①：Content-Length 预拒（谎报大头 → 不读 body）
	const cl = res.headers.get("content-length");
	if (cl !== null && cl !== "") {
		const n = Number(cl);
		if (Number.isFinite(n) && n > limit) {
			try {
				await res.body?.cancel();
			} catch {
				/* ignore */
			}
			return { ok: false, reason: "too-large" };
		}
	}
	const body = res.body;
	if (body === null) return { ok: true, body: Buffer.alloc(0) };
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	const cancel = async (): Promise<void> => {
		try {
			await reader.cancel();
		} catch {
			/* ignore */
		}
	};
	try {
		for (;;) {
			const r = await withTimeout(reader.read(), timeoutMs);
			if (r.done) break;
			total += r.value.byteLength;
			// 双检②：流式复拒（无/小 Content-Length 但实际超限）
			if (total > limit) {
				await cancel();
				return { ok: false, reason: "too-large" };
			}
			chunks.push(r.value);
		}
	} catch (e) {
		await cancel();
		if (e === TIMEOUT_MARK) return { ok: false, reason: "timeout" };
		return { ok: false, reason: isAbortError(e) ? "timeout" : "read-failed" };
	}
	return { ok: true, body: Buffer.concat(chunks, total) };
}

// ── 聚合漏斗 ───────────────────────────────────────────────────────────

/** parser 抽出的附件引用（**仅内存**：url/aesKey 绝不落盘/日志/投影；parser 已保证形状）。 */
export interface AttachmentRef {
	msgId: string;
	itemIdx: number;
	kind: "image";
	url: string;
	aesKey: string;
	midSize?: number;
}

export interface ProcessAttachmentDeps extends SafeDownloadDeps {
	/** `<runtimeDir>/wechat/artifacts`。 */
	artifactsDir: string;
	relBase?: string;
	/** 明文上限（缺省 8MB；单测可压小）。 */
	maxPlainBytes?: number;
	/** 单测故障注入（A6）。 */
	fault?: "write" | "rename";
}

export type ProcessAttachmentResult =
	| { ok: true; relPath: string; bytes: number; mime: string; host: string; hops: number }
	| { ok: false; reason: string; host?: string; hops?: number };

/**
 * 单附件聚合门：bad-key（不联网）→ 下载（allowlist + 每跳复检）→ 限额读 body →
 * AES 解密 + PKCS7 + 魔数白名单 → 明文限额 + `mid_size` 相等断言 → sha256 原子落盘。
 * 失败返回**只含 reason/host/hops** 的对象（防经 worker.lastError 落 state.json）。
 * never-throw。
 */
export async function processAttachment(att: AttachmentRef, deps: ProcessAttachmentDeps): Promise<ProcessAttachmentResult> {
	try {
		if (typeof att.url !== "string" || att.url.length === 0) return { ok: false, reason: "missing-url" };
		const key = deriveAesKey(att.aesKey);
		if (key === null) return { ok: false, reason: "bad-key" };
		const dl = await safeDownload(att.url, deps);
		if (!dl.ok) return { ok: false, reason: dl.reason, host: dl.host, hops: dl.hops };
		if (!dl.res.ok) {
			try {
				await dl.res.body?.cancel();
			} catch {
				/* ignore */
			}
			return { ok: false, reason: `http-${dl.res.status}`, host: dl.host, hops: dl.hops };
		}
		const maxPlain = deps.maxPlainBytes ?? ARTIFACT_MAX_PLAIN_BYTES;
		const rd = await readBodyLimited(dl.res, Math.min(maxPlain, ARTIFACT_MAX_PLAIN_BYTES) + 16, deps.timeoutMs ?? ARTIFACT_REQUEST_TIMEOUT_MS);
		if (!rd.ok) return { ok: false, reason: rd.reason, host: dl.host, hops: dl.hops };
		const dec = decryptImage(rd.body, key);
		if (!dec.ok) return { ok: false, reason: dec.reason, host: dl.host, hops: dl.hops };
		const plain = dec.value.plain;
		if (plain.length > maxPlain) return { ok: false, reason: "too-large", host: dl.host, hops: dl.hops };
		// 真机 B：mid_size 恒等于明文字节数 ⇒ 不等即截断/污染，fail-closed 不落盘
		if (typeof att.midSize === "number" && Number.isFinite(att.midSize) && att.midSize !== plain.length) {
			return { ok: false, reason: "mid-size-mismatch", host: dl.host, hops: dl.hops };
		}
		const st = storeArtifact(plain, {
			artifactsDir: deps.artifactsDir,
			...(deps.relBase !== undefined ? { relBase: deps.relBase } : {}),
			...(deps.fault !== undefined ? { fault: deps.fault } : {}),
		});
		if (!st.ok) return { ok: false, reason: st.reason, host: dl.host, hops: dl.hops };
		return { ok: true, relPath: st.value.relPath, bytes: plain.length, mime: dec.value.mime, host: dl.host, hops: dl.hops };
	} catch {
		return { ok: false, reason: "internal" }; // 防御分支：绝不把异常文本（可能含 URL）外泄
	}
}

// ── 幂等预扫描（绕开 F1 的 msgId 级 dedupe 耦合：键 = msgId + itemIdx）────

/** 失败行 reason 前缀（`附件失败[#<itemIdx>]:<类>`；不含 URL/key——计划 §3 失败隔离）。 */
export function artifactFailurePrefix(itemIdx: number): string {
	return `附件失败[#${itemIdx}]:`;
}

/**
 * quarantine.jsonl 是否已有该 msgId+itemIdx 的附件失败行（幂等预扫描；never-throw，
 * 坏行跳过）。用于：重放时不重复追加失败行、不重复下载（计划 §4.3 幂等判据）。
 */
export function quarantineHasArtifactFailure(quarantinePath: string, msgId: string, itemIdx: number): boolean {
	const prefix = artifactFailurePrefix(itemIdx);
	let raw: string;
	try {
		raw = readFileSync(quarantinePath, "utf8");
	} catch {
		return false; // 缺文件 = 尚无失败行
	}
	for (const line of raw.split("\n")) {
		const t = line.trim();
		if (t === "") continue;
		try {
			const v = JSON.parse(t) as { msgId?: unknown; reason?: unknown };
			if (v.msgId === msgId && typeof v.reason === "string" && v.reason.startsWith(prefix)) return true;
		} catch {
			/* 坏行跳过 */
		}
	}
	return false;
}
