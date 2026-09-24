/**
 * channel-wechat/send.ts — iLink sendmessage 最小发送客户端（W3a 纯库，只发不收）
 *
 * 规格：plans/0924_wechat_w3_impl_plan.md §A/§C（W3a 切片）。协议契约（recon① + probe 源码）：
 *   - POST {base}/ilink/bot/sendmessage
 *   - headers：同 client.ts::getUpdates 全套——Content-Type: application/json、
 *     AuthorizationType: ilink_bot_token、Authorization: Bearer <bot_token>、
 *     X-WECHAT-UIN: base64(String(randomUint32))（1..4294967295，不得为 0；每次随机）
 *   - body（逐字段锁，键序即序列化序）：
 *     {"base_info":{"channel_version":"2.0.0"},
 *      "msg":{"from_user_id":"","to_user_id":…,"client_id":…,"message_type":2,"message_state":2,
 *             "item_list":[{"type":1,"text_item":{"text":…}}]}}
 *     —— **不带 context_token**（recon③：真机入站信封顶层无此键，回复走 to_user_id 直发）。
 *
 * 结果三值（§C failed vs unknown 判定）：
 *   - {kind:"sent"}：HTTP 2xx 且业务码 ret/errcode === 0（payload = json.data ?? json，probe 同款）。
 *   - {kind:"failed", error}：**确定性拒绝**——401/403→auth、429→rate_limited（honor Retry-After，
 *     缺省 60s，钳 1s..10min）、其它 4xx→protocol、5xx→transient、2xx+ret≠0→protocol。
 *   - {kind:"unknown", reason}：**无响应或不可判**——超时/网络断/取消（请求可能已发出）、
 *     2xx+坏 JSON（可能已成功）。unknown 不盲重发（崩溃消歧靠意图文件 attempts 规则）。
 *
 * 安全红线（同 client.ts 头注）：错误对象/reason **永不携带 token/URL/请求体**——只含
 * kind/HTTP 状态/ret 码/毫秒数。botToken 只进 Authorization header（内存 → 出站 TLS）。
 *
 * 红线：只 import node 内建 + ./client.ts（WechatIlinkError/newUin）+
 * ../runtime-host/wechat-bind.ts（unwrapPayload，纯函数）。fetch 可注入（单测 fake fetch）。禁 Pi API。
 */

import { createHash } from "node:crypto";
import { WechatIlinkError, newUin } from "./client.ts";
import { unwrapPayload, type WechatFetch } from "../runtime-host/wechat-bind.ts";

/** sendmessage 客户端 HTTP 超时缺省（15s：非长轮询，出站单发的有界预算）。 */
export const SENDMESSAGE_DEFAULT_TIMEOUT_MS = 15_000;

export interface SendMessageReq {
	baseUrl: string;
	/** bot_token（只进 Authorization header；永不进错误/日志/URL）。 */
	botToken: string;
	/** 接收者 openid（只来自 inbox 记录反查，W3 拍板⑦①；本库不校验来源）。 */
	toUserId: string;
	/** 确定性派生的请求幂等 id（见 deriveReplyClientId）。 */
	clientId: string;
	/** 文本原文（长度预算由调用方负责，W3 拍板③ 4000+截断）。 */
	text: string;
	/** 缺省每次请求随机生成（newUin）。 */
	uin?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export type SendMessageResult =
	| { kind: "sent" }
	| { kind: "failed"; error: WechatIlinkError }
	| { kind: "unknown"; reason: string };

/**
 * 出站 client_id（服务端去重兜底）：sha256("wechat-reply:"+msgId+":"+outboxId) 全 64hex，
 * 确定性派生（拍板⑦③）。真机校准若发现服务端要求 UUID 形 → 改 UUIDv5 格式化同一 digest
 * （仍确定性，不改语义）。
 */
export function deriveReplyClientId(msgId: string, outboxId: string): string {
	return createHash("sha256").update(`wechat-reply:${msgId}:${outboxId}`, "utf8").digest("hex");
}

/**
 * 回复意图文件 id（W3b 消费）：sha256("wechat-reply:"+outboxId) 全 64hex，确定性
 * （同 outboxId 二次 agent_end → 同 id → 文件幂等，不覆盖）。
 */
export function deriveReplyIntentId(outboxId: string): string {
	return createHash("sha256").update(`wechat-reply:${outboxId}`, "utf8").digest("hex");
}

function parseRetryAfterMs(v: string | null): number | undefined {
	if (v === null) return undefined;
	const s = Number.parseInt(v.trim(), 10);
	if (!Number.isFinite(s) || s < 0) return undefined;
	// 上限 10min：恶意/荒谬值不放大成停摆（诚实 honor 正常值，钳制异常值）
	return Math.min(Math.max(s * 1000, 1000), 600_000);
}

/**
 * 发一条文本消息。永不抛错——结果只经三值返回（sent/failed=确定性拒绝、unknown=结果不明）；
 * 外部取消同样归 unknown（请求可能已发出）。
 */
export async function sendMessage(
	req: SendMessageReq,
	fetchImpl: WechatFetch = globalThis.fetch as WechatFetch,
): Promise<SendMessageResult> {
	const baseUrl = req.baseUrl.replace(/\/+$/, "");
	const timeoutMs = req.timeoutMs ?? SENDMESSAGE_DEFAULT_TIMEOUT_MS;
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
		const res = await fetchImpl(`${baseUrl}/ilink/bot/sendmessage`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				AuthorizationType: "ilink_bot_token",
				Authorization: `Bearer ${req.botToken}`,
				"X-WECHAT-UIN": req.uin ?? newUin(),
			},
			// 键序即线上序列化序（S1 锁）；无 context_token（recon③）
			body: JSON.stringify({
				base_info: { channel_version: "2.0.0" },
				msg: {
					from_user_id: "",
					to_user_id: req.toUserId,
					client_id: req.clientId,
					message_type: 2,
					message_state: 2,
					item_list: [{ type: 1, text_item: { text: req.text } }],
				},
			}),
			signal: controller.signal,
		});
		if (res.status === 401 || res.status === 403) {
			return {
				kind: "failed",
				error: new WechatIlinkError("auth", `sendmessage 认证失败（HTTP ${res.status}）：bot_token 已失效或被拒，需重新扫码绑定`, {
					status: res.status,
				}),
			};
		}
		if (res.status === 429) {
			const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after")) ?? 60_000;
			return {
				kind: "failed",
				error: new WechatIlinkError("rate_limited", `sendmessage 限流（HTTP 429）：${retryAfterMs}ms 后可重试`, { status: 429, retryAfterMs }),
			};
		}
		if (res.status >= 500) {
			return { kind: "failed", error: new WechatIlinkError("transient", `sendmessage 服务端错误（HTTP ${res.status}）`, { status: res.status }) };
		}
		if (res.status >= 400) {
			return { kind: "failed", error: new WechatIlinkError("protocol", `sendmessage 请求被拒（HTTP ${res.status}）`, { status: res.status }) };
		}
		if (res.status < 200 || res.status >= 300) {
			return { kind: "failed", error: new WechatIlinkError("protocol", `sendmessage 非预期 HTTP 状态（${res.status}）`, { status: res.status }) };
		}
		const text = await res.text();
		let json: unknown;
		try {
			json = text.length > 0 ? JSON.parse(text) : null;
		} catch {
			return { kind: "unknown", reason: "sendmessage 响应不是合法 JSON（消息可能已发出，结果不明）" };
		}
		const p = unwrapPayload(json);
		const ret = typeof p.ret === "number" ? p.ret : typeof p.errcode === "number" ? p.errcode : 0;
		if (ret !== 0) {
			// 不信任服务端 errmsg：可能回显请求中的秘密；错误面仅暴露数值业务码。
			return {
				kind: "failed",
				error: new WechatIlinkError("protocol", `sendmessage 业务失败 ret=${ret}`, { ret }),
			};
		}
		return { kind: "sent" };
	} catch {
		// 无响应（超时/网络断/取消）：请求可能已发出 ⇒ unknown（W3 不盲重发，崩溃消歧在意图层）
		if (outer?.aborted) return { kind: "unknown", reason: "sendmessage 已取消（请求可能已发出，结果不明）" };
		if (timedOut) return { kind: "unknown", reason: `sendmessage 超时（${timeoutMs}ms，请求可能已发出，结果不明）` };
		// 网络错误：不嵌 e.message/cause（undici cause 可能含 URL）——只记分类语义
		return { kind: "unknown", reason: "sendmessage 网络错误（fetch failed，请求可能已发出，结果不明）" };
	} finally {
		clearTimeout(timer);
		outer?.removeEventListener("abort", onOuterAbort);
	}
}
