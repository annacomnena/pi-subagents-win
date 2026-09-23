/**
 * runtime-host/static.ts — Runtime Daemon 同源静态托管（第一切片，只读）
 *
 * 依据 plans/0923_runtime_daemon_final_plan.md §2.1/§9：
 *   - 同源 GET `/` → gui/dist/index.html；GET `/assets/*` → dist 内文件；
 *   - `/v1/*` **永不** SPA fallback（未知 API 路径一律 JSON 404，由 server.ts 路由保证；
 *     本模块对非 `/`、非 `/assets/*` 路径返回 handled=false，绝不回 index.html）；
 *   - 路径穿越必须拒绝：`..` 段、绝对路径、反斜杠盘符、空字节、编码绕过
 *     （`%2e`/`%2f`/`%5c` 大小写变体、双重编码）→ 400/404，绝不读出 dist 外文件；
 *   - dist 缺失 → `/` 回 503（明确 gui-dist-missing，不炸 server；生产发布要求 dist
 *     与 daemon 不可变 release 同步，见 identity.computeReleaseId）。
 *
 * 红线：纯 node 内建；同步小文件读取（dist 资源构建产物，体积可控）；never-throw
 * （异常一律 500 JSON，不崩 server）。
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";

/** 默认 dist 目录：仓库根 gui/dist（server.ts 同目录上两级）。 */
export function defaultDistDir(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	return join(here, "..", "..", "gui", "dist");
}

/** dist 目录解析：显式注入 > PI_GUI_DIST_DIR env > 默认（测试经 opts.distDir 隔离）。 */
export function resolveDistDir(explicit?: string): string {
	if (explicit && explicit.trim()) return resolve(explicit.trim());
	const env = process.env.PI_GUI_DIST_DIR;
	if (env && env.trim()) return resolve(env.trim());
	return defaultDistDir();
}

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".txt": "text/plain; charset=utf-8",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
};

function contentTypeFor(file: string): string {
	const dot = file.lastIndexOf(".");
	const ext = dot >= 0 ? file.slice(dot).toLowerCase() : "";
	return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

function json(res: ServerResponse, status: number, body: unknown): void {
	try {
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	} catch {
		try {
			res.destroy();
		} catch {
			/* ignore */
		}
	}
}

/**
 * 原始路径穿越预检（解码前）：拦截 `%2e`（.）、`%2f`（/）、`%5c`（\）、`%00`
 * 的大小写/双重编码变体。返回 false = 必须拒绝。
 */
function rawTraversalPrecheck(rawPath: string): boolean {
	try {
		// %25 是 '%' 本身：出现即可能是双重编码（如 %252e → 解码一次得 %2e）→ 拒绝
		if (/%(25|2e|2f|5c|00)/i.test(rawPath)) return false;
		return true;
	} catch {
		return false;
	}
}

/**
 * 解码后路径安全判定：拒绝 `..` 段、反斜杠、空字节、绝对路径。
 * 返回规范化后的相对路径（以 / 分隔），不安全 → null。
 */
function safeRelPath(decoded: string): string | null {
	try {
		if (decoded.includes("\0") || decoded.includes("\\")) return null;
		// 必须以 / 开头（server 侧只传 pathname）；顺手拒绝对路径的其它形态
		if (!decoded.startsWith("/")) return null;
		const norm = normalize(decoded);
		if (norm === ".." || norm.startsWith(`..${sep}`) || norm.startsWith("../")) return null;
		const segs = norm.split(sep);
		if (segs.includes("..")) return null;
		const rel = norm.startsWith(sep) ? norm.slice(sep.length) : norm;
		if (rel === "" || rel === "." || rel.startsWith("..")) return null;
		return rel.split(sep).join("/");
	} catch {
		return null;
	}
}

export interface StaticServeOptions {
	distDir: string;
}

/**
 * 静态托管 handler。
 * @returns true = 已处理（响应已写）；false = 非静态路径（调用方继续走 API 路由，
 *   特别地 `/v1/*` 永远落到这里，保证不 SPA fallback）。
 */
export function serveStatic(req: IncomingMessage, res: ServerResponse, opts: StaticServeOptions): boolean {
	try {
		if (req.method !== "GET" && req.method !== "HEAD") return false;
		const rawUrl = req.url ?? "/";
		const rawPath = rawUrl.split("?")[0].split("#")[0];
		// 仅 / 与 /assets/* 走静态；其余（含 /v1/*）一律 false → API 路由（JSON 404）
		if (rawPath !== "/" && rawPath !== "/assets" && !rawPath.startsWith("/assets/")) return false;
		if (!rawTraversalPrecheck(rawPath)) {
			json(res, 400, { error: "bad-path", hint: "非法路径（编码穿越已拒绝）" });
			return true;
		}
		let decoded: string;
		try {
			decoded = decodeURIComponent(rawPath);
		} catch {
			json(res, 400, { error: "bad-path", hint: "URL 解码失败" });
			return true;
		}
		const distDir = resolve(opts.distDir);
		if (!existsSync(join(distDir, "index.html"))) {
			json(res, 503, { error: "gui-dist-missing", hint: "gui/dist 未构建（先 npm run gui:build；生产要求 dist 与 daemon 同步发布）" });
			return true;
		}
		let file: string;
		if (decoded === "/") {
			file = join(distDir, "index.html");
		} else {
			const rel = safeRelPath(decoded);
			if (rel === null || !rel.startsWith("assets/")) {
				json(res, 400, { error: "bad-path", hint: "非法静态路径" });
				return true;
			}
			file = join(distDir, rel);
		}
		//  containment：解析后必须仍在 dist 内（防 symlink/规范化绕过）
		const abs = resolve(file);
		if (abs !== distDir && !abs.startsWith(distDir + sep)) {
			json(res, 403, { error: "forbidden", hint: "路径越界已拒绝" });
			return true;
		}
		let st: ReturnType<typeof statSync> | null = null;
		try {
			st = statSync(abs);
		} catch {
			st = null;
		}
		if (!st || !st.isFile()) {
			json(res, 404, { error: "not-found", hint: "静态资源不存在（无 SPA fallback）" });
			return true;
		}
		let body: Buffer;
		try {
			body = readFileSync(abs);
		} catch {
			json(res, 500, { error: "read-failed" });
			return true;
		}
		try {
			res.writeHead(200, {
				"content-type": contentTypeFor(abs),
				"content-length": body.length,
				"cache-control": decoded === "/" ? "no-cache" : "public, max-age=31536000, immutable",
			});
			if (req.method === "GET") res.end(body);
			else res.end();
		} catch {
			try {
				res.destroy();
			} catch {
				/* ignore */
			}
		}
		return true;
	} catch {
		try {
			json(res, 500, { error: "internal" });
		} catch {
			/* ignore */
		}
		return true;
	}
}
