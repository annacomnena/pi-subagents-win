/**
 * runtime/master-injection.ts — L3 本机受信 GUI→master 注入窄路径策略库
 * （plans/0923_gui_master_unlock_impl.md：只解锁一条路径）。
 *
 * 背景：POST /v1/commands 的 session.message 缺省拒绝 master owner 会话
 * （command-executor.ts 护栏一/二 → 403 master-session-protected）。本模块提供
 * 唯一例外路径的判定原语，调用方（runtime-host/server.ts）在执行前计算、
 * 以显式 opts 传入 executor；executor 缺省（字段缺失）= 拒绝不变。
 *
 * 例外成立的合取条件（缺一即 403 不变）：
 *   1. trustedLocal —— 本机存在性校验：loopback socket + loopback Host +
 *      token 经 HttpOnly 同源 cookie 呈现（`sw_host_token=<hostToken>` 旧兼容或
 *      B 案 `sw_gui_token=<deriveGuiToken(hostToken)>` 浏览器作用域化凭据；裸 header
 *      呈现不授信：curl/进程用 header 呈现永远走旧 403；但本机持 token 进程改用
 *      cookie 呈现即可过门，本地威胁模型下与持 token 全权无差异）+ 附带的 Origin/Referer
 *      若出现必须同为 loopback 同源（跨站坏 Origin → 拒绝）；
 *   2. guiEnabled —— config.json `gui.autoStart === true`（`/gui on` 显式启用，
 *      缺省 OFF；未启用时本通道不存在）；
 *   3. masterAlive —— daemon 侧可核验证据：timers/sessions/<sid>.json 心跳
 *      在宽限内（sessionAlive，心跳文件内容判活，不用 mtime 猜），由 server 侧
 *      计算后传入；判不出活 → 新拒绝码 master-offline（409）。
 *
 * 另含两件配套：
 *   - Bootstrap OTT（一次性短时令牌 → HttpOnly SameSite=Strict 同源 cookie）：
 *     生产 GUI（daemon 自托管 dist，直连无 proxy）浏览器此前无任何 cookie，
 *     WS 与 POST 写端点对其全 401——此前只有 token 进 header/URL/proxy，
 *     无可信 bootstrap。本模块提供进程内 OTT 签发/核销；server.ts 落
 *     POST /v1/bootstrap（host token 换 OTT）与 GET /v1/bootstrap/exchange
 *     （OTT 换 Set-Cookie + 302 回 `/`，长 token 永不进 URL/HTML/JS）。
 *   - 审计：auditMasterInjection 写 `<stateDir>/master-injections.jsonl`
 *    （{at,by,targetSessionId,source,result,commandKey}，无正文字段；
 *     accepted 由 executor 记，窄路径被拒（gui-off/master-offline/坏 policy）的
 *     denied 行由 server.ts 在回执后补记；审计失败永不影响回执）。
 *
 * 纯库（node 内建 + IncomingMessage 类型）：无 Pi API 依赖；server.ts 红线内
 * （extensions/runtime/*）。never-throw：判定失败一律 {ok:false}，审计写失败吞掉。
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** POST /v1/commands 写端点的 cookie 名（与 ws.ts WS_COOKIE_NAME 同值，运行时不反向 import 防层倒置）。
 *  B 案后该名仅留作 host token 直呈（dev proxy/既有测试兼容）；浏览器正常只拿派生凭据
 *  GUI_COOKIE_NAME，见下。 */
export const MASTER_INJECTION_COOKIE_NAME = "sw_host_token";

/** B 案：浏览器持有的作用域化凭据 cookie 名（值 = deriveGuiToken(hostToken)，非 host token 本体）。 */
export const GUI_COOKIE_NAME = "sw_gui_token";

/** B 案：浏览器凭据 TTL 12h（真上限：/v1/bootstrap 不认该 cookie，无自续期）。 */
export const GUI_COOKIE_MAX_AGE_SECONDS = 43200;

/** B 案域分离常量（写死字符串字面量，见 deriveGuiToken 注释）。 */
const GUI_TOKEN_DOMAIN = "pi:gui-cookie:v1";

/**
 * B 案派生：guiToken = HMAC-SHA256(key=域常量, msg=hostToken)（hex 编码；key/message 与
 * 身份挑战刻意互换，见下）。纯函数；hostToken 生成不动。HMAC 单向性保证由派生值逆推
 * hostToken 不可行。重启轮换 hostToken ⇒ 派生值变化 ⇒ 旧 cookie 自动失效。
 * hostToken 为空时返回空串（调用方按无凭据处理）。
 */
export function deriveGuiToken(hostToken: string | null): string {
	if (typeof hostToken !== "string" || hostToken.length === 0) return "";
	// 必须 key/message 互换：挑战预言机 /v1/challenge 只能产出 key=hostToken 的 HMAC，无法产出 key=域常量的那一份。
	return createHmac("sha256", GUI_TOKEN_DOMAIN).update(hostToken, "utf8").digest("hex");
}

/** Cookie 头中按名取值（ws.ts parseCookieToken 同规则，不跨层 import）。 */
export function parseNamedCookie(cookieHeader: string | undefined, name: string): string | null {
	if (cookieHeader === undefined) return null;
	for (const part of cookieHeader.split(";")) {
		const eq = part.indexOf("=");
		if (eq < 0) continue;
		if (part.slice(0, eq).trim() === name) {
			const value = part.slice(eq + 1).trim();
			return value.length > 0 ? value : null;
		}
	}
	return null;
}

/** OTT 有效期缺省 60s；单次使用，核销即删。 */
export const BOOTSTRAP_OTT_TTL_MS = 60_000;

// ── gui opt-in（`/gui on` 写 config.json gui.autoStart；缺省 OFF）──

/** 缺省 config 路径（包根 config.json；本文件位于 <pkg>/extensions/runtime/）。 */
export function defaultPkgConfigPath(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "config.json");
}

/** gui 显式启用？缺段/不可读/坏 JSON → false（默认 OFF，fail-closed）。never-throw。 */
export function readGuiEnabled(configPath: string): boolean {
	try {
		const raw = JSON.parse(readFileSync(configPath, "utf8")) as { gui?: { autoStart?: unknown } };
		return raw?.gui?.autoStart === true;
	} catch {
		return false;
	}
}

// ── loopback 判定 ────────────────────────────────────────────────

function normHost(h: string): string {
	let s = h.trim().toLowerCase();
	if (s.startsWith("[")) {
		const end = s.indexOf("]");
		if (end > 0) s = s.slice(1, end);
	} else if (s.split(":").length > 2) {
		// 裸 IPv6（无端口）
	} else {
		s = s.split(":")[0];
	}
	return s;
}

/** loopback 主机名封闭集（127/8 只认 .1；0.0.0.0 是通配监听不是本机身份，不认）。 */
export function isLoopbackHostname(hostname: string): boolean {
	const h = normHost(hostname);
	return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

function socketRemoteIsLoopback(req: IncomingMessage): boolean {
	const r = req.socket?.remoteAddress ?? "";
	return r === "127.0.0.1" || r === "::1" || r === "::ffff:127.0.0.1";
}

/** 同文件内最小 cookie 解析（ws.ts parseCookieToken 同规则，不跨层 import）。 */
function parseCookieToken(cookieHeader: string | undefined, name: string): string | null {
	return parseNamedCookie(cookieHeader, name);
}

function tokensEqual(a: string, b: string): boolean {
	const ba = Buffer.from(a, "utf8");
	const bb = Buffer.from(b, "utf8");
	// 长度先比（timingSafeEqual 要求等长；token 长度本身不是秘密）
	if (ba.length !== bb.length || ba.length === 0) return false;
	try {
		return timingSafeEqual(ba, bb);
	} catch {
		return false;
	}
}

// ── 本机受信校验（窄路径门 1）────────────────────────────────────

export interface TrustedLocalCheck {
	ok: boolean;
	/** 呈现方式：cookie = 浏览器 HttpOnly 会话；header = 裸 header 呈现（不授信）；none = 无凭证。 */
	via?: "cookie" | "header" | "none";
	reason?: "non-loopback-socket" | "non-loopback-host" | "header-token-not-cookie-channel" | "no-cookie-auth" | "bad-origin";
}

/**
 * 本机存在性校验（fail-closed，never-throw）：
 * loopback socket → loopback Host → token 必须经 cookie 呈现且匹配 →
 * Origin/Referer 若出现必须 loopback 同源（端口显式时须等于本 daemon 端口）。
 * 裸 header 呈现永远不授信（保持旧 403；本地持 token 进程改 cookie 呈现即过门）。
 * B 案：cookie 位置接受两类值——旧 `sw_host_token=<hostToken>`（dev/既有测试兼容）与
 * 新 `sw_gui_token=<deriveGuiToken(hostToken)>`（浏览器作用域化凭据）；header 位置
 * 只认 hostToken 本体（派生值当 header 用永远不授信，即此处 header 分支恒 false）。
 */
export function checkTrustedLocalChannel(
	req: IncomingMessage,
	expectedToken: string | null,
	serverPort: number,
): TrustedLocalCheck {
	try {
		if (!socketRemoteIsLoopback(req)) return { ok: false, via: "none", reason: "non-loopback-socket" };
		const hostHeader = req.headers.host;
		if (typeof hostHeader !== "string" || !isLoopbackHostname(hostHeader)) {
			return { ok: false, via: "none", reason: "non-loopback-host" };
		}
		const hostCookie = parseCookieToken(req.headers.cookie, MASTER_INJECTION_COOKIE_NAME);
		const guiCookie = parseCookieToken(req.headers.cookie, GUI_COOKIE_NAME);
		const headerToken = req.headers["x-command-token"];
		const headerPresented = typeof headerToken === "string" ? headerToken.length > 0 : Array.isArray(headerToken) && headerToken.length > 0;
		if (expectedToken === null || expectedToken.length === 0) return { ok: false, via: "none", reason: "no-cookie-auth" };
		// B 案：任一 cookie 位置值匹配即授信（host 本体或派生值；派生值仅 cookie 位置有效）。
		const hostOk = hostCookie !== null && tokensEqual(hostCookie, expectedToken);
		const guiOk = guiCookie !== null && tokensEqual(guiCookie, deriveGuiToken(expectedToken));
		if (!hostOk && !guiOk) {
			return {
				ok: false,
				via: headerPresented ? "header" : "none",
				reason: headerPresented ? "header-token-not-cookie-channel" : "no-cookie-auth",
			};
		}
		// 附带源校验：出现即必须 loopback 同源（SameSite=Strict + JSON 预检之外的显式 CSRF 门）
		for (const key of ["origin", "referer"] as const) {
			const v = req.headers[key];
			if (typeof v !== "string" || v.length === 0) continue;
			let u: URL;
			try {
				u = new URL(v);
			} catch {
				return { ok: false, via: "cookie", reason: "bad-origin" };
			}
			if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, via: "cookie", reason: "bad-origin" };
			if (!isLoopbackHostname(u.hostname)) return { ok: false, via: "cookie", reason: "bad-origin" };
			if (u.port !== "" && Number(u.port) !== serverPort) return { ok: false, via: "cookie", reason: "bad-origin" };
		}
		return { ok: true, via: "cookie" };
	} catch {
		return { ok: false, via: "none", reason: "no-cookie-auth" };
	}
}

// ── Bootstrap OTT（一次性短时令牌；进程内，单实例 daemon 持有）───

export interface BootstrapStore {
	mint(ttlMs?: number): { ott: string; expiresAt: string };
	consume(ott: unknown): boolean;
}

/** OTT 签发/核销（Map + 定时清理；单用一次，过期/复用一律 false）。 */
export function createBootstrapStore(nowMs: () => number = Date.now): BootstrapStore {
	const pending = new Map<string, number>();
	return {
		mint(ttlMs: number = BOOTSTRAP_OTT_TTL_MS): { ott: string; expiresAt: string } {
			const now = nowMs();
			// 顺手清过期（无界增长封顶：Map 小，登录态只在 /gui open 时 mint）
			for (const [k, exp] of pending) if (exp <= now) pending.delete(k);
			const ott = randomBytes(16).toString("hex");
			pending.set(ott, now + ttlMs);
			return { ott, expiresAt: new Date(now + ttlMs).toISOString() };
		},
		consume(ott: unknown): boolean {
			if (typeof ott !== "string" || ott.length !== 32) return false;
			const now = nowMs();
			let hit: string | null = null;
			for (const k of pending.keys()) {
				try {
					if (k.length === ott.length && timingSafeEqual(Buffer.from(k, "utf8"), Buffer.from(ott, "utf8"))) hit = k;
				} catch {
					/* ignore */
				}
			}
			if (hit === null) return false;
			const exp = pending.get(hit) ?? 0;
			pending.delete(hit); // 单次：无论过期与否先删
			return exp > now;
		},
	};
}

// ── 审计（trusted 路径 accepted/denied 专记；无正文字段）─────────────────

export interface MasterInjectionAudit {
	at: string;
	/** frame.issuedBy（服务端注入 agent://runtime-host）。 */
	by: string;
	targetSessionId: string;
	/** 来源（IP/Host/Origin，不含正文；denied 行的 source 尾部带 deny=<reason>）。 */
	source: string;
	/** accepted = executor 放行记；denied = server 层窄路径被拒补记（字段与 accepted 相同）。 */
	result: "accepted" | "denied";
	commandKey: string;
}

/** 审计文件名（state 根下独立 jsonl；冻结五本账之外的新文件）。 */
export const MASTER_INJECTION_AUDIT_FILE = "master-injections.jsonl";

/**
 * 审计体积上限（~1MB）：轮转策略 = 超限后把现文件 rename 为 `.1`（覆盖上一个
 * `.1`，只保留两代），再写新行。不做多代/压缩：门探测审计量小，两代足够定位；
 * 无界增长不允许（daemon 常驻，多用户机器磁盘与 world-readable 面 exposure 窗口）。
 */
export const MASTER_INJECTION_AUDIT_MAX_BYTES = 1_048_576;

/**
 * 追加审计行（best-effort never-throw；失败吞掉——调用方回执不受影响）。
 * 文件显式 0600（与 host.json 一致；多用户机器上 master 会话 ID+时间线不 world-readable）。
 */
export function auditMasterInjection(stateDir: string, rec: MasterInjectionAudit): boolean {
	try {
		mkdirSync(stateDir, { recursive: true });
		const file = join(stateDir, MASTER_INJECTION_AUDIT_FILE);
		try {
			if (statSync(file).size > MASTER_INJECTION_AUDIT_MAX_BYTES) {
				try {
					renameSync(file, `${file}.1`);
				} catch {
					/* 轮转失败则继续追加（审计不断），下次再转 */
				}
			}
		} catch {
			/* 文件不存在/不可 stat = 首次写，走追加创建 */
		}
		appendFileSync(file, `${JSON.stringify(rec)}\n`, { encoding: "utf8", mode: 0o600 });
		try {
			chmodSync(file, 0o600); // 已存在文件的权限收敛（mode 仅创建时生效）
		} catch {
		/* Windows 等 chmod 语义不足的平台尽力而为 */
		}
		return true;
	} catch {
		return false;
	}
}
