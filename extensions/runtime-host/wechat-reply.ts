import { appendFileSync, chmodSync, closeSync, mkdirSync, openSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { listReplyIntents, incrementReplyAttempts, markReplyIntent, replyIntentDir } from "../runtime/wechat-reply.ts";
import { sendMessage } from "../channel-wechat/send.ts";
import { readWechatCreds, readWechatReplyConfig, wechatCredsPath, readWechatConfigPath, maskWechatOpenId, type WechatFetch } from "./wechat-bind.ts";

export interface WechatReplyWatcherOptions {
 runtimeDir: string; stateDir?: string; configPath?: string; fetchImpl?: WechatFetch; intervalMs?: number;
 readConfig?: typeof readWechatReplyConfig;
}
function audit(stateDir: string, row: Record<string, unknown>): void {
 try { mkdirSync(stateDir, { recursive: true }); const file = join(stateDir, "wechat-reply-audit.jsonl"); const fd = openSync(file, "a", 0o600); try { appendFileSync(fd, JSON.stringify(row) + "\n"); } finally { closeSync(fd); } try { chmodSync(file, 0o600); } catch {} } catch {}
}

export function startWechatReplyWatcher(opts: WechatReplyWatcherOptions): () => void {
 const stateDir = opts.stateDir ?? join(opts.runtimeDir, "state");
 const intentDir = replyIntentDir(stateDir);
 const configPath = opts.configPath ?? readWechatConfigPath();
 const readConfig = opts.readConfig ?? readWechatReplyConfig;
 let busy = false, stopped = false, debounce: ReturnType<typeof setTimeout> | null = null;
 const run = async (): Promise<void> => {
  if (busy || stopped) return; busy = true;
  try {
   if (!readConfig(configPath).enabled) return; // disabled: no consume, preserve pending
   for (const item of listReplyIntents(intentDir)) {
    if (stopped) break;
    if (item.status !== "pending") continue;
    const base = { at: new Date().toISOString(), msgId: maskWechatOpenId(item.msgId), from: maskWechatOpenId(item.fromId) };
    if (item.attempts >= 1) {
     const updated = markReplyIntent(intentDir, item.id, { status: "unknown", error: "attempts-exhausted" });
     if (updated) audit(stateDir, { ...base, event: "unknown", reason: "attempts-exhausted" });
     continue;
    }
    const creds = readWechatCreds(wechatCredsPath(opts.runtimeDir));
    if (!creds) { audit(stateDir, { ...base, event: "skipped", reason: "no-credentials" }); continue; }
    // Persist the attempt before any network request: a crash thereafter is conservatively unknown.
    const attempted = incrementReplyAttempts(intentDir, item.id);
    if (!attempted) continue;
    const result = await sendMessage({ baseUrl: creds.baseUrl, botToken: creds.botToken, toUserId: attempted.fromId, clientId: attempted.clientId, text: attempted.text }, opts.fetchImpl);
    if (result.kind === "sent") {
     if (markReplyIntent(intentDir, item.id, { status: "sent" })) audit(stateDir, { ...base, event: "sent" });
    } else if (result.kind === "failed") {
     const summary = `${result.error.kind}:${result.error.status ?? ""}:${result.error.ret ?? ""}`;
     if (markReplyIntent(intentDir, item.id, { status: "failed", error: summary })) audit(stateDir, { ...base, event: "failed", error: summary });
    } else {
     if (markReplyIntent(intentDir, item.id, { status: "unknown", error: "send-result-unknown" })) audit(stateDir, { ...base, event: "unknown", error: "send-result-unknown" });
    }
   }
  } catch { /* watcher is never-throw */ } finally { busy = false; }
 };
 let watcher: FSWatcher | null = null;
 try { watcher = watch(intentDir, () => { if (debounce) clearTimeout(debounce); debounce = setTimeout(() => { void run(); }, 200); debounce.unref?.(); }); } catch {}
 const tick = setInterval(() => { void run(); }, opts.intervalMs ?? 5000); tick.unref?.(); void run();
 return () => { stopped = true; clearInterval(tick); if (debounce) clearTimeout(debounce); try { watcher?.close(); } catch {} };
}
