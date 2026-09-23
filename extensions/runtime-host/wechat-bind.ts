/**
 * runtime-host/wechat-bind.ts — 微信 iLink 扫码登录：daemon 内有界异步流程（v1：绑定/解绑/状态，仅绑定切片）
 *
 * 计划：plans/0923_wechat_gui_bind_plan.md（阶段 2 切片）+ D14 进程放置（daemon 内有界异步任务，
 * 不进事件循环、不起独立 worker）：取码 1 次（10s 超时）+ ≤120s/2.5s 轮询 + 结束即释放；
 * AbortController 可取消。长驻长轮询通道仍走受监督 worker（后续切片）。
 *
 * 协议契约（源码已验证，见 Wiki/Architecture/wechat-ilink-channel.md#登录/绑定协议契约）：
 *   - 取码：GET {base}/ilink/bot/get_bot_qrcode?bot_type=3
 *     → `qrcode`（别名 `qr_code`，轮询凭证串）+ `qrcode_img_content`（别名 `qrcode_url`，图片 URL，
 *       按 URL 设计）+ `expires_in`（数字秒，缺省 120）；`payload = json.data ?? json`；
 *     `ret`/`errcode` ≠ 0 → 失败。【bot_type=3 语义未确认，三处交叉验证均硬编码 3】
 *   - 轮询：GET {base}/ilink/bot/get_qrcode_status?qrcode=<urlenc>
 *     → `status`（别名 `qrcode_status`）：数字 0=pending / 1=scanned / 2=confirmed / 3,4=expired
 *       （其他数字同 probe 一律 expired）；字符串大小写不敏感（confirmed|success|authorized|ok /
 *       expired|timeout|cancel|cancelled）；未知串/缺失 → pending（继续轮询，probe 行为）。
 *     网络错误/HTTP 非 ok → 退避继续（api_error，不抛错中断，probe 同口径；无独立错误码已验证——未确认）。
 *   - confirmed：**同一次轮询响应**直接带回 `bot_token`（别名 `token`）+ `ilink_bot_id`
 *     （别名 `bot_id`，可选），无需二次请求。token 的 TTL/续期语义未确认（后续切片真网测量）。
 *
 * 安全红线（plans/0923_wechat_gui_bind_plan.md 阶段 2 + binding-delta §G）：
 *   - `bot_token` 永不进日志/响应/WS/argv——只记存在性与长度；
 *   - 凭据落盘 `<runtimeDir>/wechat/credentials.json`（{botToken,botId,boundAt,baseUrl}）：
 *     0o600（Windows ACL 尽力 + 文档声明）+ 原子 rename（tmp exclusive-create → rename，daemon-lifecycle
 *     锁文件口径）；解绑 = unlink（不留空壳）；不写 plans/；host.json 零变化；
 *   - QR 图片由 daemon 代理取图转 data URL（≤200KB / 10s 超时，失败回退 URL 文本）；URL 仅认
 *     http/https 方案（防 file:// 等）；前端永不直连第三方、永不拿轮询凭证串渲染。
 *
 * 红线：只 import node 内建 + ../runtime/* 纯函数。fetch 可注入（单测 fake fetch）。
 */

import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultRuntimeDir } from "../runtime/journal.ts";
import { defaultPkgConfigPath } from "../runtime/master-injection.ts";

// ── 常量（缺省口径：probe scripts/wechat-ilink-probe.mjs + zcode 交叉验证）──

/** iLink 服务基址（probe DEFAULT_BASE_URL；指南 §二同）。 */
export const WECHAT_DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
/** 凭据目录名（<runtimeDir>/wechat/）。 */
export const WECHAT_DIR_NAME = "wechat";
/** 凭据文件名。 */
export const WECHAT_CREDENTIALS_FILE = "credentials.json";
/** 取码 HTTP 超时（10s）。 */
export const QR_FETCH_TIMEOUT_MS = 10_000;
/** 轮询节拍（2.5s，probe QR_POLL_INTERVAL_MS / zcode pollQrLoop 同）。 */
export const QR_POLL_INTERVAL_MS = 2_500;
/** 有界上限（≤120s；实际 deadline = min(开始+expires_in, 开始+上限)）。 */
export const QR_BIND_MAX_MS = 120_000;
/** expires_in 缺省（120s，probe `payload.expires_in || 120` / zcode 同）。 */
export const QR_EXPIRES_DEFAULT_SECONDS = 120;
/** QR 图片代理上限（200KB）与超时（10s）。 */
export const QR_IMAGE_MAX_BYTES = 200 * 1024;
export const QR_IMAGE_TIMEOUT_MS = 10_000;

/** fetch 注入口（默认 global fetch；单测传 fake）。 */
export type WechatFetch = (input: string, init?: RequestInit) => Promise<Response>;

// ── 错误面（server 层映射 HTTP 状态）────────────────────────────────

export class WechatBindError extends Error {}
/** 已绑定（会话 bound 或磁盘凭据存在）→ 409 already-bound。 */
export class WechatAlreadyBoundError extends WechatBindError {
	constructor() {
		super("already-bound");
	}
}
/** 流程在途被取消 → 409 cancelled。 */
export class WechatCancelledError extends WechatBindError {
	constructor() {
		super("cancelled");
	}
}
/** 无在途绑定会话（qr-image 用）→ 409 no-active-session。 */
export class WechatNoActiveSessionError extends WechatBindError {
	constructor() {
		super("no-active-session");
	}
}

// ── 凭据（{botToken,botId,boundAt,baseUrl}；token 永不进任何响应）──

export interface WechatCreds {
	botToken: string;
	botId?: string;
	boundAt: string;
	baseUrl: string;
}

export function wechatCredsPath(runtimeDir: string): string {
	return join(runtimeDir, WECHAT_DIR_NAME, WECHAT_CREDENTIALS_FILE);
}

/** 0o600（Windows 尽力）+ 原子 rename（tmp exclusive-create → rename，锁文件同口径）。
 *  失败向上抛（调用方 catch 成 error 态）；tmp 清理尽力。 */
export function writeWechatCreds0600(path: string, creds: WechatCreds): void {
	const body = JSON.stringify(creds, null, 2) + "\n";
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`;
	const fd = openSync(tmp, "wx", 0o600);
	try {
		writeFileSync(fd, body, "utf8");
	} finally {
		try {
			closeSync(fd);
		} catch {
			/* ignore */
		}
	}
	try {
		chmodSync(tmp, 0o600);
	} catch {
		/* 尽力（Windows ACL 不保证） */
	}
	try {
		renameSync(tmp, path);
	} catch (e) {
		try {
			rmSync(tmp, { force: true });
		} catch {
			/* ignore */
		}
		throw e;
	}
	// rename 后收敛一次（Windows 下 openSync 的 mode 不生效，尽力 chmod）
	try {
		chmodSync(path, 0o600);
	} catch {
		/* 尽力（见清单「安全与约束速查」：Windows 0600 仅尽力） */
	}
}

/** 宽容读：缺失/坏 JSON/字段缺失 → null（never-throw；错误信息不含 token 原文）。 */
export function readWechatCreds(path: string): WechatCreds | null {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<WechatCreds>;
		if (typeof raw.botToken !== "string" || raw.botToken.length === 0) return null;
		if (typeof raw.boundAt !== "string" || raw.boundAt.length === 0) return null;
		if (typeof raw.baseUrl !== "string" || raw.baseUrl.length === 0) return null;
		return {
			botToken: raw.botToken,
			...(typeof raw.botId === "string" && raw.botId.length > 0 ? { botId: raw.botId } : {}),
			boundAt: raw.boundAt,
			baseUrl: raw.baseUrl,
		};
	} catch {
		return null;
	}
}

/** 解绑 = unlink（不留空壳）。返回是否删到了文件。 */
export function deleteWechatCreds(path: string): boolean {
	try {
		if (!statSync(path).isFile()) return false;
	} catch {
		return false;
	}
	try {
		rmSync(path, { force: true });
		return true;
	} catch {
		return false;
	}
}

// ── opt-in 闸（config channels.wechat.enabled；缺省 OFF，fail-closed）──

/** `channels.wechat.enabled === true`？缺段/不可读/坏 JSON → false（默认 OFF，
 *  与 readGuiEnabled 同口径；never-throw）。未启用 → /v1/wechat/* 全 403 + GUI 不渲染入口。 */
export function readWechatEnabled(configPath: string): boolean {
	try {
		const raw = JSON.parse(readFileSync(configPath, "utf8")) as {
			channels?: { wechat?: { enabled?: unknown } };
		};
		return raw?.channels?.wechat?.enabled === true;
	} catch {
		return false;
	}
}

/** 缺省 config 路径（包根 config.json；与 readGuiEnabled 同源，独立 re-export 供 server 测试）。 */
export const readWechatConfigPath = defaultPkgConfigPath;

// ── 协议解析（纯函数；fake fetch 单测面）────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** `payload = json.data ?? json`（probe/zcode 同款兼容：服务端 data 直包或顶层包均可）。 */
export function unwrapPayload(json: unknown): Record<string, unknown> {
	if (!isObj(json)) return {};
	if (isObj(json.data)) return json.data;
	return json;
}

export interface QrFetchResult {
	/** 轮询凭证串（仅服务端内部用；永不进任何 HTTP 响应）。 */
	qr: string;
	/** QR 图片 URL（按 URL 设计；daemon 代理转 data URL，GUI 另用作「手机打开」直链）。 */
	qrImageUrl: string;
	/** 有效期秒数（服务端 expires_in；缺省 120）。 */
	expiresIn: number;
}

interface HttpJsonResult {
	ok: boolean;
	httpStatus: number;
	payload: Record<string, unknown> | null;
}

/** 带超时的 GET + JSON 解析（超时/取消 abort；HTTP 非 ok 不抛，只标记 ok:false）。 */
async function fetchJsonT(fetchImpl: WechatFetch, url: string, timeoutMs: number, signal: AbortSignal): Promise<HttpJsonResult> {
	// 内层 controller 管超时；外层 signal（会话取消）只联动 abort 内层——这样调用方可区分
	// “超时”（外层未 abort）与“取消”（外层已 abort），不会把 10s 超时误判成 WechatCancelledError。
	const controller = new AbortController();
	const onOuterAbort = (): void => {
		try {
			controller.abort();
		} catch {
			/* ignore */
		}
	};
	if (signal.aborted) onOuterAbort();
	else signal.addEventListener("abort", onOuterAbort, { once: true });
	const timer = setTimeout(onOuterAbort, timeoutMs);
	timer.unref?.();
	try {
		const res = await fetchImpl(url, {
			method: "GET",
			headers: { "iLink-App-ClientVersion": "1" },
			signal: controller.signal,
		});
		const text = await res.text();
		let json: unknown = null;
		try {
			json = text.length > 0 ? JSON.parse(text) : null;
		} catch {
			json = null;
		}
		const payload = isObj(json) ? json : null;
		if (res.status >= 400) return { ok: false, httpStatus: res.status, payload };
		return { ok: true, httpStatus: res.status, payload };
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", onOuterAbort);
	}
}

/** 取码（10s 超时缺省）；失败抛 WechatBindError（消息不含任何 token/凭据内容）。 */
export async function fetchQrCode(opts: {
	baseUrl: string;
	fetchImpl: WechatFetch;
	timeoutMs?: number;
	signal: AbortSignal;
}): Promise<QrFetchResult> {
	const { baseUrl, fetchImpl, signal } = opts;
	const timeoutMs = opts.timeoutMs ?? QR_FETCH_TIMEOUT_MS;
	const r = await fetchJsonT(fetchImpl, `${baseUrl}/ilink/bot/get_bot_qrcode?bot_type=3`, timeoutMs, signal);
	if (!r.ok) throw new WechatBindError(`申请二维码失败: HTTP ${r.httpStatus}`);
	const p = unwrapPayload(r.payload);
	const ret = typeof p.ret === "number" ? p.ret : typeof p.errcode === "number" ? p.errcode : 0;
	if (ret !== 0) {
		throw new WechatBindError(`申请二维码失败: ret=${ret}${typeof p.errmsg === "string" && p.errmsg ? ` ${p.errmsg}` : ""}`);
	}
	const qr = str(p.qrcode) ?? str(p.qr_code);
	const qrImageUrl = str(p.qrcode_img_content) ?? str(p.qrcode_url);
	if (!qr || !qrImageUrl) throw new WechatBindError("微信未返回有效的二维码数据（qrcode / qrcode_img_content 缺失）");
	const rawExp = p.expires_in;
	let expiresIn = QR_EXPIRES_DEFAULT_SECONDS;
	if (typeof rawExp === "number" && Number.isFinite(rawExp) && rawExp > 0) expiresIn = rawExp;
	else if (typeof rawExp === "string" && rawExp.trim() !== "" && Number.isFinite(Number(rawExp)) && Number(rawExp) > 0) expiresIn = Number(rawExp);
	return { qr, qrImageUrl, expiresIn };
}

export type QrStatusKind = "pending" | "scanned" | "confirmed" | "expired";

export interface QrStatusParse {
	kind: QrStatusKind;
	/** kind=confirmed 时 bot_token（别名 token）；未确认恒空串。 */
	botToken: string;
	/** kind=confirmed 时 ilink_bot_id（别名 bot_id），可选。 */
	botId?: string;
}

/** 状态映射（源码已验证）：数字 0/1/2 → pending/scanned/confirmed，3,4（及任何其他数字）→ expired
 *  （probe `raw===3||4` 同口径）；字符串 `status ?? qrcode_status` 大小写不敏感 + 别名集；
 *  未知串/缺失 → pending（继续轮询，不中断，probe 行为）。 */
export function parseQrStatus(payload: Record<string, unknown> | null): QrStatusParse {
	const p = payload ?? {};
	const raw = p.status ?? p.qrcode_status;
	let kind: QrStatusKind;
	if (typeof raw === "number") {
		kind = raw === 0 ? "pending" : raw === 1 ? "scanned" : raw === 2 ? "confirmed" : "expired";
	} else if (typeof raw === "string") {
		const s = raw.trim().toLowerCase();
		if (s === "confirmed" || s === "success" || s === "authorized" || s === "ok") kind = "confirmed";
		else if (s === "scanned") kind = "scanned";
		else if (s === "expired" || s === "timeout" || s === "cancel" || s === "cancelled") kind = "expired";
		else kind = "pending"; // "pending"/"waiting"/未知 → 继续轮询
	} else {
		kind = "pending";
	}
	if (kind !== "confirmed") return { kind, botToken: "" };
	const botToken = str(p.bot_token) ?? str(p.token) ?? "";
	const botId = str(p.ilink_bot_id) ?? str(p.bot_id);
	return { kind, botToken, ...(botId !== undefined ? { botId } : {}) };
}

/** 轮询一次状态。null = api_error（HTTP 非 ok / 网络错误，退避继续，不抛——probe 同口径）；
 *  被取消 → 抛原错误（调用方终止流程）。 */
export async function fetchQrStatus(opts: {
	baseUrl: string;
	qr: string;
	fetchImpl: WechatFetch;
	timeoutMs?: number;
	signal: AbortSignal;
}): Promise<QrStatusParse | null> {
	const { baseUrl, qr, fetchImpl, signal } = opts;
	const timeoutMs = opts.timeoutMs ?? QR_FETCH_TIMEOUT_MS;
	try {
		const r = await fetchJsonT(fetchImpl, `${baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr)}`, timeoutMs, signal);
		if (!r.ok) return null; // api_error：只记继续（probe 无 ret≠0 分支——错误码未确认）
		return parseQrStatus(unwrapPayload(r.payload));
	} catch (e) {
		if (signal.aborted) throw e;
		return null; // 网络错误 → 退避继续（有界：deadline 到即 expired）
	}
}

// ── 有界异步管理器（daemon 内单例；结束即释放，无长驻 timer）──────────

export interface WechatBindOptions {
	/** runtime 根目录（凭据 <dir>/wechat/credentials.json；缺省 defaultRuntimeDir()＝env PI_RUNTIME_DIR 覆盖）。 */
	runtimeDir?: string;
	/** iLink base URL（缺省 https://ilinkai.weixin.qq.com）。 */
	baseUrl?: string;
	/** fetch 注入（缺省 global fetch；单测 fake fetch）。 */
	fetchImpl?: WechatFetch;
	/** 轮询节拍 ms（缺省 2500）。 */
	pollIntervalMs?: number;
	/** 取码超时 ms（缺省 10000）。 */
	qrFetchTimeoutMs?: number;
	/** 有界上限 ms（缺省 120000；deadline = min(开始+expires_in, 开始+上限)）。 */
	maxBindMs?: number;
	/** 时钟注入（缺省 Date.now；测试）。 */
	now?: () => number;
}

interface ActiveSession {
	kind: "active";
	controller: AbortController;
	qr: string;
	qrImageUrl: string;
	expiresIn: number;
	startedAt: number;
	/** 客户端 deadline（ms epoch；min(开始+expires_in, 开始+上限)）。 */
	expiresAt: number;
	phase: "waiting" | "scanned";
}
interface BoundSession {
	kind: "bound";
	boundAt: string;
	botId?: string;
}
interface ExpiredSession {
	kind: "expired";
	expiresAt: number;
	at: number;
}
interface ErrorSession {
	kind: "error";
	message: string;
	at: number;
}
type Session = ActiveSession | BoundSession | ExpiredSession | ErrorSession;

export type WechatStateName = "idle" | "waiting" | "scanned" | "bound" | "expired" | "error";

/** 状态投影（**token 永不出现**；bot id 只报存在性——v1 口径与 probe 一致，不暴露 id 值）。 */
export interface WechatStateView {
	state: WechatStateName;
	/** waiting/scanned：QR 图片 URL（GUI「手机微信里打开」直链；不是轮询凭证串）。 */
	qrImageUrl: string | null;
	/** waiting/scanned：过期时刻（ms epoch）。 */
	expiresAt: number | null;
	/** waiting/scanned：有效期秒数（服务端 expires_in）。 */
	expiresIn: number | null;
	/** bound：绑定时刻（ISO）。 */
	boundAt: string | null;
	/** bound：是否取到 bot id（token/bot id 值均不出现，只存在性）。 */
	botIdPresent: boolean;
	/** error：用户可读消息（不含 token）。 */
	message: string | null;
}

export interface WechatStartResult {
	qrImageUrl: string;
	expiresAt: number;
	expiresIn: number;
}

export interface WechatQrImageResult {
	/** data URL（content-type 非 image/* 时兜底 image/png）；null = 取图失败（GUI 回退 URL 文本 + 复制）。 */
	dataUrl: string | null;
	/** QR 图片 URL（回退展示 + 手机打开）。 */
	url: string;
	/** 失败原因（成功 null；不含 token）。 */
	error: string | null;
}

/** 睡眠；取消 → false（timer unref，不挂住事件循环/进程退出）。 */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve(false);
			return;
		}
		let settled = false;
		const t = setTimeout(() => finish(true), ms);
		t.unref?.();
		const onAbort = (): void => finish(false);
		const finish = (ok: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(t);
			signal.removeEventListener("abort", onAbort);
			resolve(ok);
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

export class WechatBindManager {
	private readonly runtimeDir: string;
	private readonly baseUrl: string;
	private readonly fetchImpl: WechatFetch;
	private readonly pollIntervalMs: number;
	private readonly qrFetchTimeoutMs: number;
	private readonly maxBindMs: number;
	private readonly now: () => number;
	private readonly credsPath: string;
	private session: Session | null = null;

	constructor(opts: WechatBindOptions = {}) {
		this.runtimeDir = opts.runtimeDir ?? defaultRuntimeDir();
		this.baseUrl = (opts.baseUrl ?? WECHAT_DEFAULT_BASE_URL).replace(/\/+$/, "");
		this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as WechatFetch);
		this.pollIntervalMs = opts.pollIntervalMs ?? QR_POLL_INTERVAL_MS;
		this.qrFetchTimeoutMs = opts.qrFetchTimeoutMs ?? QR_FETCH_TIMEOUT_MS;
		this.maxBindMs = opts.maxBindMs ?? QR_BIND_MAX_MS;
		this.now = opts.now ?? (() => Date.now());
		this.credsPath = wechatCredsPath(this.runtimeDir);
	}

	/** 当前状态投影（never-throw；token 永不出现）。磁盘凭据在会话为空时兜出 bound。 */
	getState(): WechatStateView {
		const s = this.session;
		if (s === null) {
			const creds = readWechatCreds(this.credsPath);
			if (creds) {
				return { state: "bound", qrImageUrl: null, expiresAt: null, expiresIn: null, boundAt: creds.boundAt, botIdPresent: creds.botId !== undefined, message: null };
			}
			return { state: "idle", qrImageUrl: null, expiresAt: null, expiresIn: null, boundAt: null, botIdPresent: false, message: null };
		}
		if (s.kind === "active") {
			return { state: s.phase, qrImageUrl: s.qrImageUrl, expiresAt: s.expiresAt, expiresIn: s.expiresIn, boundAt: null, botIdPresent: false, message: null };
		}
		if (s.kind === "bound") {
			return { state: "bound", qrImageUrl: null, expiresAt: null, expiresIn: null, boundAt: s.boundAt, botIdPresent: s.botId !== undefined, message: null };
		}
		if (s.kind === "expired") {
			return { state: "expired", qrImageUrl: null, expiresAt: s.expiresAt, expiresIn: null, boundAt: null, botIdPresent: false, message: null };
		}
		return { state: "error", qrImageUrl: null, expiresAt: null, expiresIn: null, boundAt: null, botIdPresent: false, message: s.message };
	}

	/** 启动取码 + 后台轮询（**幂等**：同未过期会话重调返回同一 qr+expiresAt）。
	 *  已绑定（会话 bound 或磁盘凭据存在）→ WechatAlreadyBoundError（需先解绑）；
	 *  在途被取消 → WechatCancelledError；取码失败 → WechatBindError。 */
	async start(): Promise<WechatStartResult> {
		const cur = this.session;
		if (cur !== null && cur.kind === "active") {
			return { qrImageUrl: cur.qrImageUrl, expiresAt: cur.expiresAt, expiresIn: cur.expiresIn };
		}
		if ((cur !== null && cur.kind === "bound") || readWechatCreds(this.credsPath) !== null) {
			throw new WechatAlreadyBoundError();
		}
		// 终态（expired/error）或 idle → 清场开新会话
		this.session = null;
		const controller = new AbortController();
		let qr: QrFetchResult;
		try {
			qr = await fetchQrCode({ baseUrl: this.baseUrl, fetchImpl: this.fetchImpl, timeoutMs: this.qrFetchTimeoutMs, signal: controller.signal });
		} catch (e) {
			// 外层（会话）abort = 真取消 → WechatCancelledError；否则（含 10s 超时 abort 内层）→ bind-failed
			if (controller.signal.aborted) throw new WechatCancelledError();
			const aborted = e instanceof Error && (e.name === "AbortError" || /abort/i.test(e.message));
			throw e instanceof WechatBindError
				? e
				: new WechatBindError(aborted ? `申请二维码超时（${this.qrFetchTimeoutMs}ms）` : `申请二维码失败: ${e instanceof Error ? e.message : String(e)}`);
		}
		if (controller.signal.aborted) {
			this.session = null;
			throw new WechatCancelledError();
		}
		const startedAt = this.now();
		// 有界：服务端 expires_in 与 120s 上限取小（服务端过期 120s 缺省；zcode 同款客户端超时）
		const expiresAt = startedAt + Math.min(qr.expiresIn * 1000, this.maxBindMs);
		const active: ActiveSession = { kind: "active", controller, qr: qr.qr, qrImageUrl: qr.qrImageUrl, expiresIn: qr.expiresIn, startedAt, expiresAt, phase: "waiting" };
		this.session = active;
		this.runLoop(active);
		return { qrImageUrl: active.qrImageUrl, expiresAt: active.expiresAt, expiresIn: active.expiresIn };
	}

	/** 取消在途绑定（幂等；**不**删已有凭据——解绑是 unbind 的事）。 */
	cancel(): void {
		const s = this.session;
		if (s === null) return;
		if (s.kind === "active") s.controller.abort();
		if (s.kind !== "bound") this.session = null;
	}

	/** 解绑：取消在途流程 + unlink 凭据（不留空壳）→ 回 idle。返回是否删到了凭据文件。 */
	unbind(): boolean {
		const s = this.session;
		if (s !== null && s.kind === "active") s.controller.abort();
		const removed = deleteWechatCreds(this.credsPath);
		this.session = null;
		return removed;
	}

	/** 进程退出（server close）：停流程、清内存终态，**不**动磁盘（bound 跨重启保留）。 */
	dispose(): void {
		this.cancel();
		if (this.session !== null && this.session.kind !== "bound") this.session = null;
	}

	/** QR 图片代理：取会话 qrImageUrl 转 data URL（≤200KB / 10s；方案白名单 http/https）。
	 *  无在途会话 → WechatNoActiveSessionError；取图失败 → {dataUrl:null, url, error}（GUI 回退 URL 文本）。 */
	async fetchQrImage(): Promise<WechatQrImageResult> {
		const s = this.session;
		if (s === null || s.kind !== "active") throw new WechatNoActiveSessionError();
		const url = s.qrImageUrl;
		let u: URL;
		try {
			u = new URL(url);
		} catch {
			return { dataUrl: null, url, error: "QR 图片 URL 非法" };
		}
		// 限定同源代理：QR URL 来自远端响应，若只检查 http(s) 会成为任意 URL/内网 SSRF 代理。
		// 生产 baseUrl 为 https://ilinkai.weixin.qq.com；HTTP 仅供同源本地 stub 测试。
		let base: URL;
		try {
			base = new URL(this.baseUrl);
		} catch {
			return { dataUrl: null, url, error: "iLink base URL 非法" };
		}
		if ((u.protocol !== "https:" && u.protocol !== "http:") || u.origin !== base.origin || u.username !== "" || u.password !== "") {
			return { dataUrl: null, url, error: "QR 图片 URL 必须与 iLink 服务同源" };
		}
		const controller = new AbortController();
		const onAbort = (): void => {
			try {
				controller.abort();
			} catch {
				/* ignore */
			}
		};
		if (s.controller.signal.aborted) onAbort();
		else s.controller.signal.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(onAbort, QR_IMAGE_TIMEOUT_MS);
		timer.unref?.();
		try {
			const res = await this.fetchImpl(url, { signal: controller.signal });
			if (!res.ok) return { dataUrl: null, url, error: `HTTP ${res.status}` };
			const ctRaw = res.headers.get("content-type");
			const ct = ctRaw !== null ? ctRaw.toLowerCase().split(";")[0].trim() : "";
			const mime = ct.startsWith("image/") ? ct : "image/png";
			const body = (res.body as ReadableStream<Uint8Array> | null | undefined) ?? null;
			const chunks: Buffer[] = [];
			let total = 0;
			let oversize = false;
			if (body !== null) {
				const reader = body.getReader();
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					if (value !== undefined) {
						total += value.byteLength;
						if (total > QR_IMAGE_MAX_BYTES) {
							oversize = true;
							try {
								await reader.cancel();
							} catch {
								/* ignore */
							}
							break;
						}
						chunks.push(Buffer.from(value));
					}
				}
			}
			if (oversize) return { dataUrl: null, url, error: `QR 图片超过 ${QR_IMAGE_MAX_BYTES} 字节上限` };
			if (chunks.length === 0) return { dataUrl: null, url, error: "空图片" };
			const b64 = Buffer.concat(chunks).toString("base64");
			return { dataUrl: `data:${mime};base64,${b64}`, url, error: null };
		} catch (e) {
			if (s.controller.signal.aborted) throw new WechatNoActiveSessionError();
			return { dataUrl: null, url, error: e instanceof Error ? e.message : String(e) };
		} finally {
			clearTimeout(timer);
			s.controller.signal.removeEventListener("abort", onAbort);
		}
	}

	/** 终态落位（会话已被替换 → no-op，防旧 loop 覆盖新会话）。 */
	private terminal(target: ActiveSession, next: Exclude<Session, ActiveSession>): void {
		if (this.session !== target) return;
		this.session = next;
	}

	/** 后台轮询 loop（fire-and-forget；never-throw；deadline 到即 expired，结束即释放）。 */
	private runLoop(target: ActiveSession): void {
		void (async (): Promise<void> => {
			try {
				for (;;) {
					if (this.session !== target || target.controller.signal.aborted) return;
					if (this.now() >= target.expiresAt) {
						this.terminal(target, { kind: "expired", expiresAt: target.expiresAt, at: this.now() });
						return;
					}
					const alive = await sleep(this.pollIntervalMs, target.controller.signal);
					if (!alive || this.session !== target) return;
					const remainingMs = target.expiresAt - this.now();
					if (remainingMs <= 0) {
						this.terminal(target, { kind: "expired", expiresAt: target.expiresAt, at: this.now() });
						return;
					}
					const st = await fetchQrStatus({
						baseUrl: this.baseUrl,
						qr: target.qr,
						fetchImpl: this.fetchImpl,
						timeoutMs: Math.min(QR_FETCH_TIMEOUT_MS, remainingMs),
						signal: target.controller.signal,
					});
					if (st === null) {
						// API/网络错误也必须退避；否则故障时会 tight-loop 打满 daemon。
						const aliveAfterError = await sleep(Math.min(this.pollIntervalMs, Math.max(0, target.expiresAt - this.now())), target.controller.signal);
						if (!aliveAfterError) return;
						continue;
					}
					if (this.session !== target) return;
					switch (st.kind) {
						case "pending":
							continue;
						case "scanned":
							if (target.phase === "waiting") target.phase = "scanned";
							continue;
						case "expired":
							this.terminal(target, { kind: "expired", expiresAt: target.expiresAt, at: this.now() });
							return;
						case "confirmed": {
							if (st.botToken.length === 0) {
								this.terminal(target, { kind: "error", message: "扫码已确认但服务端未返回 bot_token，请重新生成二维码", at: this.now() });
								return;
							}
							const boundAt = new Date().toISOString();
							const creds: WechatCreds = {
								botToken: st.botToken,
								...(st.botId !== undefined ? { botId: st.botId } : {}),
								boundAt,
								baseUrl: this.baseUrl,
							};
							try {
								writeWechatCreds0600(this.credsPath, creds);
							} catch (e) {
								this.terminal(target, { kind: "error", message: `凭据落盘失败: ${e instanceof Error ? e.message : String(e)}`, at: this.now() });
								return;
							}
							this.terminal(target, { kind: "bound", boundAt, botId: st.botId });
							// token 永不进日志：只记存在性与长度（daemon stdio 通常 ignore；此行仅供前台调试）
							try {
								console.log(`[wechat-bind] bound ok bot_token=<present len=${st.botToken.length}> botId=${st.botId !== undefined ? "<present>" : "<absent>"}`);
							} catch {
								/* ignore */
							}
							return;
						}
					}
				}
			} catch {
				if (this.session === target) {
					this.session = { kind: "error", message: "绑定流程异常，请重新生成二维码", at: this.now() };
				}
			}
		})();
	}
}
