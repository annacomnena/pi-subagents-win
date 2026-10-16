/**
 * uploads.ts — GUI 图片输入 S1：上传落盘（**附件 + 路径**，不把图片塞进会话 JSONL）。
 *
 * 设计由来（2026-10-16 用户拍板）：
 *   `/v1/commands` 请求体上限 64KB（commands.ts:22）⇒ base64 图片进不了命令载荷；
 *   用户明确要求「只走附件 + 路径，别放进 jsonl」⇒ 图片经独立端点落盘，
 *   会话里只出现**绝对路径文本**（agent 需要看图时用 `read` 工具自取）。
 *
 * 安全口径（远程可达端点，故收紧）：
 *   - 媒体类型**按魔数嗅探**（不信任 Content-Type / 扩展名）；
 *   - 白名单之外一律拒（含 SVG：可执行脚本面）；
 *   - 文件名由服务端生成（`up_<随机>`），**零用户输入进路径** ⇒ 无路径穿越；
 *   - 大小上限 UPLOAD_MAX_BYTES（超出 413，不截断、不静默降级）；
 *   - 原子写（`.part` → rename）：读到的要么是完整文件，要么没有；
 *   - 有界清理（pruneUploads：按 mtime 删超期文件，供上传时机会式调用）。
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 单张图片上限（5 MiB）。 */
export const UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

/** 一条消息最多带的附件数（S2 命令层用；此处定义便于单点口径）。 */
export const UPLOAD_MAX_PER_MESSAGE = 4;

/** 落盘保留时长（默认 7 天；超期由 pruneUploads 删除）。 */
export const UPLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type UploadMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

const EXT_OF: Record<UploadMediaType, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
};

/** 魔数嗅探：只认白名单四种位图；无法确证 → null（调用方拒收）。 */
export function sniffImageMediaType(buf: Buffer): UploadMediaType | null {
	if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
		return "image/png";
	}
	if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
	if (buf.length >= 6) {
		const head = buf.subarray(0, 6).toString("latin1");
		if (head === "GIF87a" || head === "GIF89a") return "image/gif";
	}
	if (
		buf.length >= 12 &&
		buf.subarray(0, 4).toString("latin1") === "RIFF" &&
		buf.subarray(8, 12).toString("latin1") === "WEBP"
	) {
		return "image/webp";
	}
	return null;
}

/** 上传根目录（`<runtimeDir>/uploads`；测试注入 runtimeDir 即隔离）。 */
export function uploadsDir(runtimeDir: string): string {
	return join(runtimeDir, "uploads");
}

export type SaveUploadResult =
	| { ok: true; uploadId: string; path: string; bytes: number; mediaType: UploadMediaType }
	| { ok: false; reason: "empty" | "too-large" | "unsupported-type"; detail: string };

/**
 * 落盘一张图片。失败不写任何文件（原子：`.part` 已替名删除）。
 * **不**接受客户端文件名/扩展名 —— 扩展名只由嗅探结果决定。
 */
export function saveUpload(opts: { runtimeDir: string; bytes: Buffer }): SaveUploadResult {
	const { runtimeDir, bytes } = opts;
	if (bytes.length === 0) return { ok: false, reason: "empty", detail: "空请求体" };
	if (bytes.length > UPLOAD_MAX_BYTES) {
		return { ok: false, reason: "too-large", detail: `单张上限 ${UPLOAD_MAX_BYTES} 字节（收到 ${bytes.length}）` };
	}
	const mediaType = sniffImageMediaType(bytes);
	if (mediaType === null) {
		return { ok: false, reason: "unsupported-type", detail: "仅接受 png / jpeg / webp / gif（按文件魔数判定，不看扩展名）" };
	}
	const dir = uploadsDir(runtimeDir);
	mkdirSync(dir, { recursive: true });
	const uploadId = `up_${randomBytes(9).toString("base64url")}`;
	const finalPath = join(dir, `${uploadId}.${EXT_OF[mediaType]}`);
	const tmpPath = `${finalPath}.part`;
	try {
		writeFileSync(tmpPath, bytes);
		renameSync(tmpPath, finalPath);
	} catch (e) {
		try {
			rmSync(tmpPath, { force: true });
		} catch {
			/* ignore */
		}
		throw e;
	}
	return { ok: true, uploadId, path: finalPath, bytes: bytes.length, mediaType };
}

/** 上传引用是否形如本模块生成的 id（S2 命令层校验用；不含路径分隔符即无穿越面）。 */
export function uploadIdOk(id: unknown): id is string {
	return typeof id === "string" && /^up_[A-Za-z0-9_-]{6,32}$/.test(id);
}

/**
 * 有界清理：删除 uploads 目录下**超期**的常规文件（含残留 `.part`）。返回删除数。
 * never-throw（清理失败不影响上传主路径）；目录缺失视为 0。
 */
export function pruneUploads(opts: { runtimeDir: string; ttlMs?: number; now?: number }): number {
	const ttl = opts.ttlMs ?? UPLOAD_TTL_MS;
	const now = opts.now ?? Date.now();
	const dir = uploadsDir(opts.runtimeDir);
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return 0;
	}
	let removed = 0;
	for (const name of names) {
		try {
			const st = statSync(join(dir, name));
			if (!st.isFile()) continue;
			if (now - st.mtimeMs > ttl) {
				rmSync(join(dir, name), { force: true });
				removed += 1;
			}
		} catch {
			/* 单个失败跳过 */
		}
	}
	return removed;
}
