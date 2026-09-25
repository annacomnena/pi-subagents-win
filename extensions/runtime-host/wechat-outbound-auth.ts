/**
 * 0925 P0 · 出站广播收件授权（outbound recipient authorization）。
 *
 * 授权缺口背景（astra §二第 1 项，plans/0925_next_step_by_astra.md）：
 * `WechatStore.knownChats()` 只排空 fromId / @im.bot 域 / 重复，**不排 rejected、不查入站
 * 白名单**，而 0924 广播把它直接当收件人集合 ⇒「曾发过消息」=「有权接收 master 全部最终回复」。
 * 本模块建立**显式出站授权集合**，与入站授权彻底解耦：
 *
 *   出站授权 = 绑定 owner（credentials.json 的 ownerOpenId） ∪ `channels.wechat.reply.allowOut`
 *   入站授权 = 绑定 owner ∪ `channels.wechat.input.allowFrom`   ← 两条集合互不读取、互不复制
 *
 * - 缺省（allowOut 缺失/坏文件）= 只有绑定 owner；owner 不可读（未绑定/坏凭据）⇒ 连 owner 都不放行
 *   ⇒ 授权集合只可能收缩，**任何配置损坏路径都不扩张接收范围**（fail-closed）。
 * - 可撤销：从 allowOut 移除（或解绑换绑 owner）即刻生效——hook 选收件人与 watcher 发送前
 *   二次复核都现读本模块，历史已排队 intent 同样被拦下并进可解释终态（见 runtime-host/wechat-reply.ts）。
 * - 可解释：决策带 reason（bound-owner / outbound-subscriber / owner-unbound /
 *   not-outbound-subscriber / bot-domain / empty-from），审计行只落掩码 fromId。
 *
 * 明确不做：不读 `input.allowFrom`、不读 knownChats（knownChats 仅是 hook 侧**候选池**，
 * 是否可收由本模块裁决）、不改 reply/intent schema。
 */
import { readWechatCreds, wechatCredsPath } from "./wechat-bind.ts";

/** 出站授权上下文：绑定 owner 身份 + 显式订阅集合（allowOut 来自 reply 配置）。 */
export interface OutboundAuthContext {
	/** credentials.json 的 ownerOpenId；不可读/未绑定 → null（owner 位缺席，绝不回退到历史私聊）。 */
	ownerOpenId: string | null;
	/** `channels.wechat.reply.allowOut`（已 trim/去重；缺失/坏文件 → []）。 */
	allowOut: readonly string[];
}

export type OutboundAuthReason =
	| "bound-owner" | "outbound-subscriber"
	| "empty-from" | "bot-domain" | "owner-unbound" | "not-outbound-subscriber";

export interface OutboundAuthDecision {
	authorized: boolean;
	/** authorized 时的角色（审计/报告用）；denied 时 null。 */
	role: "owner" | "subscriber" | null;
	reason: OutboundAuthReason;
}

/**
 * 读绑定 owner 身份（never-throw）：凭据缺失/坏 JSON/缺 ownerOpenId → null。
 * fail-closed 方向：读不出来就当没绑（owner 位不放行，而不是放行全部历史联系人）。
 */
export function readOutboundOwnerOpenId(runtimeDir: string): string | null {
	try { return readWechatCreds(wechatCredsPath(runtimeDir))?.ownerOpenId ?? null; } catch { return null; }
}

/**
 * 单收件人授权裁决（纯函数，hook 选收件人与 watcher 发送前二次复核共用同一实现）。
 * 调用方自行组 ctx（owner 现读凭据 + allowOut 取 reply 配置）：两处都已经读了 cfg，
 * 不在这里重复读盘（避免同轮两次读配置不一致）。
 * 判定顺序：形态门（空/bot 防环）→ 绑定 owner → 显式订阅 allowOut → 拒绝
 * （owner 在位却没中 → "not-outbound-subscriber" = 既非绑定 owner 也未订阅；owner 不可读 →
 * "owner-unbound"，连 owner 位都缺席）。
 * **入站白名单、历史私聊、inbox state（含 rejected）一概不参与本判定。**
 */
export function authorizeBroadcastRecipient(fromId: string, ctx: OutboundAuthContext): OutboundAuthDecision {
	if (typeof fromId !== "string" || fromId.length === 0) return { authorized: false, role: null, reason: "empty-from" };
	// 防环纵深：即使 allowOut 误配了 bot 域也不放行（与 knownChats 过滤口径一致）。
	if (fromId.endsWith("@im.bot")) return { authorized: false, role: null, reason: "bot-domain" };
	if (ctx.ownerOpenId && fromId === ctx.ownerOpenId) return { authorized: true, role: "owner", reason: "bound-owner" };
	if (ctx.allowOut.includes(fromId)) return { authorized: true, role: "subscriber", reason: "outbound-subscriber" };
	return { authorized: false, role: null, reason: ctx.ownerOpenId ? "not-outbound-subscriber" : "owner-unbound" };
}
