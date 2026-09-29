import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { getCurrentSessionId, isMainSession, isSubagent } from "./identity.ts";
import { defaultRuntimeDir } from "./runtime/journal.ts";
import { deriveBroadcastClientId, deriveReplyClientId } from "./channel-wechat/send.ts";
import { WechatStore } from "./channel-wechat/store.ts";
import { deriveBroadcastIntentId, deriveReplyIntentId, newReplyIntent, readReplyIntent, replyIntentDir } from "./runtime/wechat-reply.ts";
import { readWechatConfigPath, readWechatReplyConfig, maskWechatOpenId } from "./runtime-host/wechat-bind.ts";
import { authorizeBroadcastRecipient, readOutboundOwnerOpenId, type OutboundAuthContext } from "./runtime-host/wechat-outbound-auth.ts";
import { readAttachment } from "./runtime/registry.ts";
import { masterAddress } from "./runtime/address.ts";

export type ReplySkipReason = "no-text" | "reply-disabled" | "no-inbox-match" | "marker-not-first" | "bot-domain"
 | "no-stash" | "no-known-chats" | "no-authorized-recipients" | "not-main-session" | "not-master-owner" | "master-attachment-unavailable"
 | "stash-session-mismatch";
export interface ReplyHookDeps {
 stateDir?: string; runtimeDir?: string; configPath?: string; subagent?: () => boolean;
 /** 当前会话 UUID（缺省 getCurrentSessionId()）——owner 资格门比对左值。 */
 sessionId?: () => string | undefined;
 /** global master attachment 的 sessionId（缺省 readAttachment(masterAddress())；不可读/未 attach → null → fail-closed 不广播）。 */
 masterSessionId?: () => string | null;
 /** isMainSession() 注入（sessionScope="main" 用，tab 模拟）。 */
 mainSession?: () => boolean;
 /** 时钟注入（intent createdAt）。 */
 now?: () => Date;
 /** 收件人候选池源（缺省 new WechatStore(join(runtimeDir,"wechat","receive")）：knownChats() 只是候选池 ≠ 授权集合，还需过出站授权门（0925 P0）。 */
 store?: () => WechatStore;
 /** 绑定 owner openid（缺省 readOutboundOwnerOpenId(runtimeDir) = credentials.json 现读）——出站授权 owner 位。 */
 ownerOpenId?: () => string | undefined;
}
function textOf(message: any): string {
 const c = message?.content;
 if (typeof c === "string") return c;
 if (Array.isArray(c)) return c.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("");
 return typeof message?.text === "string" ? message.text : "";
}
function audit(stateDir: string, row: Record<string, unknown>): void {
 try { const p = join(stateDir, "wechat-reply-audit.jsonl"); mkdirSync(dirname(p), { recursive: true }); appendFileSync(p, JSON.stringify(row) + "\n", { encoding: "utf8", mode: 0o600 }); } catch {}
}
function lastNonEmptyAssistantText(messages: unknown[]): string {
 for (let i = messages.length - 1; i >= 0; i--) { const m: any = messages[i]; if (m?.role !== "assistant") continue; const candidate = textOf(m); if (candidate.trim()) return candidate; }
 return "";
}

// ── 0924 出站广播：agent_end 暂存 / agent_settled flush ─────────────────
//
// 时机门（计划 §1.1 门 3，用户裁定③）：agent_end = 一次低层 run 结束（重试/compaction/
// steering 后可继续、可多次），agent_settled = 权威终界、每 session 级 run 一次（无 payload）。
// 故 agent_end 只暂存（每次覆盖 = 本轮最终态），agent_settled 时 flush 出意图。
interface BroadcastStash { sessionId: string; roundKey: string; firstUserText: string; firstUserTs: number | string | null; text: string; }
let pendingBroadcast: BroadcastStash | null = null;
/** 测试辅助：清空暂存（生产路径由 flush 自清）。 */
export function resetWechatBroadcastStash(): void { pendingBroadcast = null; }

/**
 * 轮次稳定标识 roundId（= roundKey，计划 §3 允许 roundId=roundKey 或再包一层 hash，本实现取前者）：
 *   sha256(`${sessionId}:${firstUserTimestamp ?? "no-ts"}:${sha256(firstUserText)}`)
 * 同会话同首问同时间戳 → 同 roundId → 同批 intent id → 重复 flush 幂等不重发（B3）。
 * 实现期验证（计划 §9.3）：pi-ai `UserMessage.timestamp: number` 存在（消息样例一致）；
 * 缺失/非数字/非字符串 → 退化 "no-ts"（无时间戳 + 同会话重复同文 → roundId 相同，可接受）。
 */
export function deriveBroadcastRoundId(sessionId: string, firstUserTs: number | string | null | undefined, firstUserText: string): string {
 const inner = createHash("sha256").update(firstUserText, "utf8").digest("hex");
 return createHash("sha256").update(`${sessionId}:${firstUserTs ?? "no-ts"}:${inner}`, "utf8").digest("hex");
}

/** mode=broadcast 时 agent_end 暂存（收件人集合与资格门留给 flush 判定，避免过早判定）。 */
function stashWechatBroadcast(messages: unknown[], deps: ReplyHookDeps): void {
 const first = messages.find((m: any) => m?.role === "user") as any;
 const firstUserText = first ? textOf(first) : "";
 const ts = first?.timestamp;
 const firstUserTs: number | string | null = typeof ts === "number" || typeof ts === "string" ? ts : null;
 let text = lastNonEmptyAssistantText(messages);
 if (text.length > 4000) text = text.slice(0, 4000) + "…[截断]";
 const sessionId = deps.sessionId?.() ?? getCurrentSessionId() ?? "unknown";
 pendingBroadcast = { sessionId, roundKey: deriveBroadcastRoundId(sessionId, firstUserTs, firstUserText), firstUserText, firstUserTs, text };
}

function defaultMasterSessionId(): string | null {
 try { return readAttachment(masterAddress())?.sessionId ?? null; } catch { return null; }
}

export interface BroadcastFlushResult { written: boolean; count: number; reason?: ReplySkipReason; }

/**
 * agent_settled flush：资格门（缺省 owner = 只有 global master 会话广播，用户裁定①；
 * readAttachment 不可读/无 attachment → fail-closed 不广播）→ 取暂存 → 内容检查 →
 * 收件人 = knownChats() 候选池 ∩ **出站授权集合**（绑定 owner ∪ reply.allowOut，0925 P0；
 * knownChats 不再直接当收件人集合，rejected / 入站白名单均不参与授权裁决）→
 * 每收件人写一个 kind:"broadcast" intent（一个 intent 一个收件人）。
 * 出站与否（connected 门 + TTL + **发送前二次复核**）在 watcher 侧判定，hook 只排队（计划 §1.1 门 4、§5）。
 */
export function flushWechatBroadcast(deps: ReplyHookDeps = {}): BroadcastFlushResult {
 try {
  const runtimeDir = deps.runtimeDir ?? defaultRuntimeDir(); const stateDir = deps.stateDir ?? join(runtimeDir, "state");
  if ((deps.subagent ?? isSubagent)()) return { written: false, count: 0 };
  const cfg = readWechatReplyConfig(deps.configPath ?? readWechatConfigPath());
  // disabled / mode 已翻回 reply-only：丢弃暂存静默返回（不产生任何 reply 侧副作用）
  if (!cfg.enabled || cfg.mode !== "broadcast") { pendingBroadcast = null; return { written: false, count: 0 }; }
  const at = () => new Date().toISOString();
  // S1（L4）：资格门失败但本会话无暂存 → 静默返回（audit jsonl 无轮转会单向增长，
  // 不能让每个 tab settled 轮都落一行）；有 stash 才记审计（真正丢弃了内容才值得记）。
  const hadStash = pendingBroadcast !== null;
  if (cfg.sessionScope === "owner") {
   const ownerSid = deps.masterSessionId ? deps.masterSessionId() : defaultMasterSessionId();
   const currentSid = deps.sessionId?.() ?? getCurrentSessionId();
   if (!ownerSid) { pendingBroadcast = null; if (hadStash) audit(stateDir, { at: at(), event: "skipped", reason: "master-attachment-unavailable", scope: "owner" }); return { written: false, count: 0, reason: "master-attachment-unavailable" }; }
   if (!currentSid || currentSid !== ownerSid) { pendingBroadcast = null; if (hadStash) audit(stateDir, { at: at(), event: "skipped", reason: "not-master-owner", scope: "owner" }); return { written: false, count: 0, reason: "not-master-owner" }; }
  } else if (cfg.sessionScope === "main" && !(deps.mainSession ?? isMainSession)()) {
   pendingBroadcast = null; if (hadStash) audit(stateDir, { at: at(), event: "skipped", reason: "not-main-session", scope: "main" }); return { written: false, count: 0, reason: "not-main-session" };
  } // scope "any"：仅 subagent 门（上方）
  const stash = pendingBroadcast; pendingBroadcast = null;
  if (!stash) { audit(stateDir, { at: at(), event: "skipped", reason: "no-stash" }); return { written: false, count: 0, reason: "no-stash" }; }
  // S4（L4）：暂存会话 ≠ 当前 settled 会话 → 丢弃 + 审计（防同进程内 tab 先暂存、
  // master 隗后 settled 时把 tab 轮内容按 owner 资格广播出去）。口径与 stashWechat
  // Broadcast 的 sessionId 记录一致（两端取不到时均为 "unknown"，视为同端）。
  if (stash.sessionId !== ((deps.sessionId?.() ?? getCurrentSessionId()) ?? "unknown")) {
   audit(stateDir, { at: at(), event: "skipped", reason: "stash-session-mismatch", scope: cfg.sessionScope });
   return { written: false, count: 0, reason: "stash-session-mismatch" };
  }
  if (!stash.text) { audit(stateDir, { at: at(), event: "skipped", reason: "no-text", msgId: maskWechatOpenId(stash.roundKey) }); return { written: false, count: 0, reason: "no-text" }; }
  const dir = replyIntentDir(stateDir);
  let chats: { fromId: string; lastAt: string }[] = [];
  try { chats = (deps.store ? deps.store() : new WechatStore(join(runtimeDir, "wechat", "receive"))).knownChats(); } catch { chats = []; }
  if (!chats.length) { audit(stateDir, { at: at(), event: "skipped", reason: "no-known-chats" }); return { written: false, count: 0, reason: "no-known-chats" }; }
  // 0925 P0 出站收件授权：knownChats 只是候选池（可寻址的历史 chat）；授权集合与入站解耦 =
  // 绑定 owner（credentials.ownerOpenId）∪ reply.allowOut（显式订阅，缺省空）。
  // B（入站被拒且未订阅）、C（已撤销订阅）在这一门被拦下 → 不生成新广播 intent；
  // owner 不可读 ⇒ owner 位缺席 ⇒ 授权集合只可能收缩（fail-closed，不扩张接收范围）。
  const authCtx: OutboundAuthContext = {
   ownerOpenId: deps.ownerOpenId ? deps.ownerOpenId() ?? null : readOutboundOwnerOpenId(runtimeDir),
   allowOut: cfg.allowOut ?? [],
  };
  const recipients = chats.filter((chat) => authorizeBroadcastRecipient(chat.fromId, authCtx).authorized);
  if (!recipients.length) {
   audit(stateDir, { at: at(), event: "skipped", reason: "no-authorized-recipients", candidates: chats.length });
   return { written: false, count: 0, reason: "no-authorized-recipients" };
  }
  if (recipients.length !== chats.length) {
   // 单行摘要（audit 无轮转，不逐收件人落行）；被拒明细见发送侧终态审计 broadcast-unauthorized。
   audit(stateDir, { at: at(), event: "recipients-filtered", kind: "broadcast", authorized: recipients.length, denied: chats.length - recipients.length });
  }
  const now = deps.now?.();
  let count = 0;
  for (const chat of recipients) {
   const id = deriveBroadcastIntentId(stash.roundKey, chat.fromId);
   if (readReplyIntent(dir, id)) continue; // 同轮重复 flush：同 id → 文件已存在 → 不重写不重发
   const result = newReplyIntent(dir, { id, msgId: stash.roundKey, outboxId: stash.roundKey, fromId: chat.fromId, clientId: deriveBroadcastClientId(stash.roundKey, chat.fromId), text: stash.text, kind: "broadcast", ...(now ? { now } : {}) });
   if (!result?.created) continue;
   count++;
   audit(stateDir, { at: at(), event: "intent-written", kind: "broadcast", msgId: maskWechatOpenId(stash.roundKey), from: maskWechatOpenId(chat.fromId) });
  }
  return { written: count > 0, count };
 } catch { return { written: false, count: 0 }; }
}

/** Testable extraction; all failures are contained and never escape. */
export function extractWechatReply(messages: unknown[], deps: ReplyHookDeps = {}): { written: boolean; reason?: ReplySkipReason } {
 try {
  const runtimeDir = deps.runtimeDir ?? defaultRuntimeDir(); const stateDir = deps.stateDir ?? join(runtimeDir, "state");
  if (deps.subagent?.()) return { written: false };
  const cfg = readWechatReplyConfig(deps.configPath ?? readWechatConfigPath());
  if (!cfg.enabled) { audit(stateDir, { at: new Date().toISOString(), event: "skipped", reason: "reply-disabled" }); return { written: false, reason: "reply-disabled" }; }
  // 0924 mode 分支（计划 §6①）：broadcast 只暂存（不看 marker——非微信触发轮同样广播，B1）；
  // flush 在 agent_settled。reply-only 走下方 marker 路径，逐字节原样（计划 §7 B5 红线）。
  if (cfg.mode === "broadcast") { stashWechatBroadcast(messages, deps); return { written: false }; }
  // 0929 修（长会话 marker-not-first 缺陷）：marker 必须从**最近**的 user 消息里找。
  // 原实现用 messages.find(⇒首条 user)，在长会话下恒命中历史首条（无 marker）⇒ 静默 return
  //（不写审计，不可观测）⇒ reply-only 路径对已运行多日的会话永久失效。
  // 与同文件 lastNonEmptyAssistantText（从后往前）对齐；findLast 优先，兼底手写逆序。
  const lastUser = typeof (messages as any).findLast === "function"
   ? (messages as any).findLast((m: any) => m?.role === "user")
   : [...messages].reverse().find((m: any) => m?.role === "user");
  if (!lastUser) { audit(stateDir, { at: new Date().toISOString(), event: "skipped", reason: "marker-not-first" }); return { written: false, reason: "marker-not-first" }; }
  const match = textOf(lastUser).match(/dedupe:outbox:([0-9a-f]{64})/);
  if (!match) { audit(stateDir, { at: new Date().toISOString(), event: "skipped", reason: "marker-not-first" }); return { written: false, reason: "marker-not-first" }; }
  const outboxId = match[1]; const rec = new WechatStore(join(runtimeDir, "wechat", "receive")).readInbox(0).find(r => r.outboxId === outboxId);
  if (!rec || rec.state !== "injected") { audit(stateDir, { at: new Date().toISOString(), event: "skipped", reason: "no-inbox-match" }); return { written: false, reason: "no-inbox-match" }; }
  if (rec.fromId.endsWith("@im.bot")) { audit(stateDir, { at: new Date().toISOString(), event: "skipped", msgId: maskWechatOpenId(rec.msgId), from: maskWechatOpenId(rec.fromId), reason: "bot-domain" }); return { written: false, reason: "bot-domain" }; }
  const dir = replyIntentDir(stateDir); const id = deriveReplyIntentId(outboxId); if (readReplyIntent(dir, id)) return { written: false };
  let text = lastNonEmptyAssistantText(messages);
  if (!text) { audit(stateDir, { at: new Date().toISOString(), event: "skipped", msgId: maskWechatOpenId(rec.msgId), from: maskWechatOpenId(rec.fromId), reason: "no-text" }); return { written: false, reason: "no-text" }; }
  if (text.length > 4000) text = text.slice(0, 4000) + "…[截断]";
  const result = newReplyIntent(dir, { id, msgId: rec.msgId, outboxId, fromId: rec.fromId, clientId: deriveReplyClientId(rec.msgId, outboxId), text });
  if (!result?.created) return { written: false };
  audit(stateDir, { at: new Date().toISOString(), event: "intent-written", msgId: maskWechatOpenId(rec.msgId), from: maskWechatOpenId(rec.fromId) });
  return { written: true };
 } catch { return { written: false }; }
}
export function registerWechatReplyHook(pi: ExtensionAPI): void {
 pi.on("agent_end", (event: any) => { try { if (isSubagent()) return; extractWechatReply(event?.messages ?? []); } catch {} });
 // 0924 广播时机门（计划 §1.1 门 3，用户裁定③）：agent_end 只暂存，agent_settled 才 flush。
 pi.on("agent_settled", () => { try { flushWechatBroadcast(); } catch {} });
}
