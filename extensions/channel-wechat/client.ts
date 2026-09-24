/**
 * channel-wechat/client.ts — iLink getupdates 最小 HTTP 客户端（W1 只收不投）
 *
 * 规格：plans/0924_wechat_receive_w1_spec.md §2（接口收敛）。协议契约（源码指南 §3，
 * 见 Wiki/Architecture/wechat-ilink-channel.md）：
 *   - POST {base}/ilink/bot/getupdates
 *   - headers：Content-Type: application/json、AuthorizationType: ilink_bot_token、
 *     Authorization: Bearer <bot_token>、X-WECHAT-UIN: base64(String(randomUint32))
 *     （1..4294967295，**不得为 0**；每次请求随机生成）
 *   - body：{"base_info":{"channel_version":"2.0.0"},"get_updates_buf":"<上次 buf | 首次空串>"}
 *   - 响应：{"ret":0,"buf":"<next cursor>","item_list":[...]}；长轮询 60~90s → 客户端
 *     超时留余量（95s 硬上限缺省 + 外部 AbortController）。
 *
 * 错误分类（W1 规格 §2）：auth(401/403——「确认失效码」真网未测，v1 只认 HTTP 401/403) /
 * transient(5xx/超时/网络) / rate_limited(429，honor Retry-After) / protocol(坏 JSON/ret≠0/缺 buf)。
 *
 * 安全红线（规格 §4.1）：错误对象**永不携带 token**——消息只含 kind/HTTP 状态/ret 码/超时毫秒，
 * 不含 URL、headers、请求体。token 只进 Authorization header（内存 → 出站 TLS），不落任何文件。
 *
 * 红线：只 import node 内建 + ../runtime-host/wechat-bind.ts（unwrapPayload/常量，纯函数）。
 * fetch 可注入（单测 fake fetch）。禁 Pi API。
 */

import { randomInt } from "node:crypto";
import { unwrapPayload, type WechatFetch } from "../runtime-host/wechat-bind.ts";

/** getupdates 客户端 HTTP 超时缺省（95s：服务端长轮询 60~90s + 余量，指南 §3）。 */
export const GETUPDATES_DEFAULT_TIMEOUT_MS = 95_000;

export type WechatIlinkErrorKind = "auth" | "transient" | "rate_limited" | "protocol";

/** 分类错误（fail-closed 分类面；message 无 token/URL/正文）。 */
export class WechatIlinkError extends Error {
	readonly kind: WechatIlinkErrorKind;
	readonly status?: number;
	readonly ret?: number;
	/** rate_limited：Retry-After 折算 ms（缺省 60s；honor 上限 10min 防恶意值）。 */
	readonly retryAfterMs?: number;
	constructor(
		kind: WechatIlinkErrorKind,
		message: string,
		fields: { status?: number; ret?: number; retryAfterMs?: number } = {},
	) {
		super(message);
		this.name = "WechatIlinkError";
		this.kind = kind;
		if (fields.status !== undefined) this.status = fields.status;
		if (fields.ret !== undefined) this.ret = fields.ret;
		if (fields.retryAfterMs !== undefined) this.retryAfterMs = fields.retryAfterMs;
	}
}

/** X-WECHAT-UIN：base64(String(randomUint32))，1..4294967295（不得为 0）。 */
export function newUin(): string {
	return Buffer.from(String(randomInt(1, 0x100000000)), "utf8").toString("base64");
}

export interface GetUpdatesReq {
	baseUrl: string;
	/** bot_token（只进 Authorization header；永不进错误/日志/URL）。 */
	botToken: string;
	/** 缺省每次请求随机生成（newUin）。 */
	uin?: string;
	/** 上次游标 buf；首次空串。 */
	buf: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

/** 响应（原始 item_list 透传——形状交 parser 收敛；buf = 下次游标）。 */
export interface GetUpdatesRes {
	buf: string;
	items: unknown[];
}

function parseRetryAfterMs(v: string | null): number | undefined {
	if (v === null) return undefined;
	const s = Number.parseInt(v.trim(), 10);
	if (!Number.isFinite(s) || s < 0) return undefined;
	// 上限 10min：恶意/荒谬值不放大成停摆（诚实 honor 正常值，钳制异常值）
	return Math.min(Math.max(s * 1000, 1000), 600_000);
}

/**
 * 拉一批更新。失败抛 WechatIlinkError（已分类、无秘密）；外部 signal abort → 抛
 * 普通 Error（name=AbortError 语义，由调用方判 signal.aborted 决定停机，不当 transient）。
 */
export async function getUpdates(req: GetUpdatesReq, fetchImpl: WechatFetch = globalThis.fetch as WechatFetch): Promise<GetUpdatesRes> {
	const baseUrl = req.baseUrl.replace(/\/+$/, "");
	const timeoutMs = req.timeoutMs ?? GETUPDATES_DEFAULT_TIMEOUT_MS;
	const controller = new AbortController();
	let timedOut = false;
	const onOuterAbort = (): void => {
		try {
			controller.abort();
		} catch {
			/* ignore */
		}
	};
	const outer = req.signal;
	if (outer?.aborted) onOuterAbort();
	else outer?.addEventListener("abort", onOuterAbort, { once: true });
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	timer.unref?.();
	try {
		const res = await fetchImpl(`${baseUrl}/ilink/bot/getupdates`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				AuthorizationType: "ilink_bot_token",
				Authorization: `Bearer ${req.botToken}`,
				"X-WECHAT-UIN": req.uin ?? newUin(),
			},
			body: JSON.stringify({ base_info: { channel_version: "2.0.0" }, get_updates_buf: req.buf }),
			signal: controller.signal,
		});
		if (res.status === 401 || res.status === 403) {
			throw new WechatIlinkError("auth", `getupdates 认证失败（HTTP ${res.status}）：bot_token 已失效或被拒，需重新扫码绑定`, { status: res.status });
		}
		if (res.status === 429) {
			const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after")) ?? 60_000;
			throw new WechatIlinkError("rate_limited", `getupdates 限流（HTTP 429）：${retryAfterMs}ms 后重试`, { status: 429, retryAfterMs });
		}
		if (res.status >= 500) {
			throw new WechatIlinkError("transient", `getupdates 服务端错误（HTTP ${res.status}）`, { status: res.status });
		}
		if (res.status >= 400) {
			throw new WechatIlinkError("protocol", `getupdates 请求被拒（HTTP ${res.status}）`, { status: res.status });
		}
		const text = await res.text();
		let json: unknown;
		try {
			json = text.length > 0 ? JSON.parse(text) : null;
		} catch {
			throw new WechatIlinkError("protocol", "getupdates 响应不是合法 JSON");
		}
		const p = unwrapPayload(json);
		const ret = typeof p.ret === "number" ? p.ret : typeof p.errcode === "number" ? p.errcode : 0;
		if (ret !== 0) {
			// 「确认失效码」真网未测（W1 诚实延期）：v1 ret≠0 一律 protocol（退避重试），不臆测 auth 码
			throw new WechatIlinkError("protocol", `getupdates 业务失败 ret=${ret}${typeof p.errmsg === "string" && p.errmsg ? `（${p.errmsg.slice(0, 120)}）` : ""}`, { ret });
		}
		if (typeof p.buf !== "string" || p.buf.length === 0) {
			throw new WechatIlinkError("protocol", "getupdates 响应缺 buf 游标（不推进游标）");
		}
		const items = Array.isArray(p.item_list) ? p.item_list : [];
		return { buf: p.buf, items };
	} catch (e) {
		if (e instanceof WechatIlinkError) throw e;
		// 外部取消（worker 停机）→ 透传 abort 语义；其余（含超时 abort、网络错）按分类面归一
		if (outer?.aborted) {
			const err = new Error("getupdates 已取消");
			err.name = "AbortError";
			throw err;
		}
		if (timedOut) {
			throw new WechatIlinkError("transient", `getupdates 超时（${timeoutMs}ms，长轮询余量内重试）`);
		}
		// 网络错误：不嵌 e.message/cause（undici cause 可能含 URL）——只记分类语义
		throw new WechatIlinkError("transient", "getupdates 网络错误（fetch failed）");
	} finally {
		clearTimeout(timer);
		outer?.removeEventListener("abort", onOuterAbort);
	}
}
