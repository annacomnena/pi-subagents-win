import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { isSubagent } from "./identity.ts";
import { defaultRuntimeDir } from "./runtime/journal.ts";
import { deriveReplyClientId } from "./channel-wechat/send.ts";
import { WechatStore } from "./channel-wechat/store.ts";
import { deriveReplyIntentId, newReplyIntent, readReplyIntent, replyIntentDir } from "./runtime/wechat-reply.ts";
import { readWechatConfigPath, readWechatReplyConfig, maskWechatOpenId } from "./runtime-host/wechat-bind.ts";

export type ReplySkipReason = "no-text" | "reply-disabled" | "no-inbox-match" | "marker-not-first" | "bot-domain";
export interface ReplyHookDeps { stateDir?: string; runtimeDir?: string; configPath?: string; subagent?: () => boolean; }
function textOf(message: any): string {
 const c = message?.content;
 if (typeof c === "string") return c;
 if (Array.isArray(c)) return c.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("");
 return typeof message?.text === "string" ? message.text : "";
}
function audit(stateDir: string, row: Record<string, unknown>): void {
 try { const p = join(stateDir, "wechat-reply-audit.jsonl"); mkdirSync(dirname(p), { recursive: true }); appendFileSync(p, JSON.stringify(row) + "\n", { encoding: "utf8", mode: 0o600 }); } catch {}
}
/** Testable extraction; all failures are contained and never escape. */
export function extractWechatReply(messages: unknown[], deps: ReplyHookDeps = {}): { written: boolean; reason?: ReplySkipReason } {
 try {
  const runtimeDir = deps.runtimeDir ?? defaultRuntimeDir(); const stateDir = deps.stateDir ?? join(runtimeDir, "state");
  if (deps.subagent?.()) return { written: false };
  if (!readWechatReplyConfig(deps.configPath ?? readWechatConfigPath()).enabled) { audit(stateDir, { at: new Date().toISOString(), event: "skipped", reason: "reply-disabled" }); return { written: false, reason: "reply-disabled" }; }
  const first = messages.find((m: any) => m?.role === "user"); if (!first) return { written: false, reason: "marker-not-first" };
  const match = textOf(first).match(/dedupe:outbox:([0-9a-f]{64})/); if (!match) return { written: false, reason: "marker-not-first" };
  const outboxId = match[1]; const rec = new WechatStore(join(runtimeDir, "wechat", "receive")).readInbox(0).find(r => r.outboxId === outboxId);
  if (!rec || rec.state !== "injected") { audit(stateDir, { at: new Date().toISOString(), event: "skipped", reason: "no-inbox-match" }); return { written: false, reason: "no-inbox-match" }; }
  if (rec.fromId.endsWith("@im.bot")) { audit(stateDir, { at: new Date().toISOString(), event: "skipped", msgId: maskWechatOpenId(rec.msgId), from: maskWechatOpenId(rec.fromId), reason: "bot-domain" }); return { written: false, reason: "bot-domain" }; }
  const dir = replyIntentDir(stateDir); const id = deriveReplyIntentId(outboxId); if (readReplyIntent(dir, id)) return { written: false };
  let text = "";
  for (let i = messages.length - 1; i >= 0; i--) { const m: any = messages[i]; if (m?.role !== "assistant") continue; const candidate = textOf(m); if (candidate.trim()) { text = candidate; break; } }
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
}
