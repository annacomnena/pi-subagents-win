import { createHash, randomBytes } from "node:crypto";
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const REPLY_INTENT_STATUSES = ["pending", "sent", "failed", "unknown"] as const;
export type ReplyIntentStatus = (typeof REPLY_INTENT_STATUSES)[number];
/** 意图种类（0924 广播）：缺省/旧文件 = "reply"；"broadcast" 走 watcher 的 connected 门 + TTL（计划 §6）；
 *  "command" = 远程斜杠命令回执（0924 旁路）：与 reply 同待遇（watcher 无 mode 门/TTL/connected 门），
 *  但可分型审计；消费端不产生 turn ⇒ 不进广播环路。 */
export type ReplyIntentKind = "reply" | "broadcast" | "command";
export interface ReplyIntent {
 version: 1; id: string; msgId: string; outboxId: string; fromId: string; clientId: string; text: string;
 status: ReplyIntentStatus; attempts: number; createdAt: string; updatedAt: string;
 sentAt?: string; failedAt?: string; unknownAt?: string; error?: string;
 /** 可选（向后兼容红线）：旧文件/缺省按 reply 处理，valid() 已放宽。 */
 kind?: ReplyIntentKind;
}
export function replyIntentDir(stateDir: string): string { return join(stateDir, "wechat-reply"); }
export function deriveReplyIntentId(outboxId: string): string { return createHash("sha256").update(`wechat-reply:${outboxId}`).digest("hex"); }
/**
 * 广播意图 id（一个 intent 一个收件人，方案 A）：sha256("wechat-broadcast:"+roundId+":"+fromId)。
 * 同轮重复 flush → 同 roundId → 同 id → linkSync EEXIST → created:false（幂等不重发）；
 * 不同轮 → 不同 roundId → 不同文件按 createdAt 排队（不同轮不覆盖）。前缀与
 * deriveReplyIntentId(wechat-reply:) / deriveBroadcastClientId(wechat-broadcast-client:) 均不同源。
 */
export function deriveBroadcastIntentId(roundId: string, fromId: string): string {
 return createHash("sha256").update(`wechat-broadcast:${roundId}:${fromId}`).digest("hex");
}
/**
 * 命令回执 intent id（0924 远程斜杠命令旁路）：sha256("wechat-command:"+msgId)。
 * 同 msgId 重复消费（stale 接管 / at-least-once 重放）→ 同 id → linkSync EEXIST → 不重写；
 * 前缀与 wechat-reply: / wechat-broadcast: 均不同源（命名空间隔离）。64hex 同口径。
 */
export function deriveCommandIntentId(msgId: string): string {
 return createHash("sha256").update(`wechat-command:${msgId}`).digest("hex");
}
function pathFor(dir: string, id: string): string { return join(dir, `${id}.json`); }
function valid(x: unknown): x is ReplyIntent {
 if (!x || typeof x !== "object") return false;
 const v = x as ReplyIntent;
 return v.version === 1 && /^[0-9a-f]{64}$/.test(v.id) && typeof v.msgId === "string" && typeof v.outboxId === "string" && typeof v.fromId === "string" && typeof v.clientId === "string" && typeof v.text === "string" && REPLY_INTENT_STATUSES.includes(v.status) && Number.isInteger(v.attempts) && typeof v.createdAt === "string" && typeof v.updatedAt === "string" && (v.kind === undefined || v.kind === "reply" || v.kind === "broadcast" || v.kind === "command");
}
function atomic(path: string, value: unknown): void {
 mkdirSync(join(path, ".."), { recursive: true });
 const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
 writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
 try { for (let n = 0;; n++) { try { renameSync(tmp, path); break; } catch (e) { if ((e as NodeJS.ErrnoException).code === "EPERM" && n < 3) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); continue; } throw e; } } }
 catch (e) { try { unlinkSync(tmp); } catch {} throw e; }
}
export function readReplyIntent(dir: string, id: string): ReplyIntent | null { try { const v: unknown = JSON.parse(readFileSync(pathFor(dir, id), "utf8")); return valid(v) && v.id === id ? v : null; } catch { return null; } }
export function listReplyIntents(dir: string): ReplyIntent[] { try { return readdirSync(dir).filter(f => f.endsWith(".json")).map(f => readReplyIntent(dir, f.slice(0, -5))).filter((x): x is ReplyIntent => x !== null).sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)); } catch { return []; } }
const LOCK_STALE_MS = 30_000;
function withIntentLock<T>(dir: string, id: string, fn: () => T): T | null {
 const lock = `${pathFor(dir, id)}.lock`;
 mkdirSync(dir, { recursive: true });
 for (let attempt = 0; attempt < 2; attempt++) {
  let fd: number;
  try { fd = openSync(lock, "wx", 0o600); }
  catch (e) {
   if ((e as NodeJS.ErrnoException).code === "EEXIST") {
    try {
     if (Date.now() - (awaitlessStat(lock) ?? Date.now()) > LOCK_STALE_MS) {
      const stale = `${lock}.stale-${process.pid}-${randomBytes(6).toString("hex")}`;
      try { renameSync(lock, stale); } catch (moveError) { if ((moveError as NodeJS.ErrnoException).code === "ENOENT") continue; throw moveError; }
      try { fd = openSync(lock, "wx", 0o600); }
      catch { try { unlinkSync(stale); } catch {} return null; }
      try { return fn(); } finally { try { closeSync(fd); } catch {} try { unlinkSync(lock); } catch {} try { unlinkSync(stale); } catch {} }
     }
    } catch {}
   }
   return null;
  }
  try { return fn(); } finally { try { closeSync(fd); } catch {} try { unlinkSync(lock); } catch {} }
 }
 return null;
}
function awaitlessStat(path: string): number | null { try { return statSync(path).mtimeMs; } catch { return null; } }
export function newReplyIntent(dir: string, input: Omit<ReplyIntent, "version" | "status" | "attempts" | "createdAt" | "updatedAt"> & { now?: Date }): { item: ReplyIntent; created: boolean } | null {
 const at = (input.now ?? new Date()).toISOString();
 const { now: _now, ...fields } = input;
 const item: ReplyIntent = { ...fields, version: 1, status: "pending", attempts: 0, createdAt: at, updatedAt: at };
 mkdirSync(dir, { recursive: true });
 cleanupReplyTemps(dir);
 const tmp = `${pathFor(dir, item.id)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
 try {
  writeFileSync(tmp, `${JSON.stringify(item, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try { linkSync(tmp, pathFor(dir, item.id)); return { item, created: true }; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") { const existing = readReplyIntent(dir, item.id); return existing ? { item: existing, created: false } : null; } throw e; }
 } finally { try { unlinkSync(tmp); } catch {} }
}
const REPLY_TMP_MAX_AGE_MS = 5 * 60_000;
function cleanupReplyTemps(dir: string): void {
 try { const now = Date.now(); for (const name of readdirSync(dir)) if (/^[0-9a-f]{64}\.json\.\d+\.[0-9a-f]+\.tmp$/.test(name)) { const file = join(dir, name); try { if (now - statSync(file).mtimeMs > REPLY_TMP_MAX_AGE_MS) unlinkSync(file); } catch {} } } catch {}
}
export function incrementReplyAttempts(dir: string, id: string, at = new Date().toISOString()): ReplyIntent | null {
 return withIntentLock(dir, id, () => {
  const cur = readReplyIntent(dir, id); if (!cur || cur.status !== "pending") return null;
  const next = { ...cur, attempts: cur.attempts + 1, updatedAt: at };
  try { atomic(pathFor(dir, id), next); return next; } catch { return null; }
 });
}
export function markReplyIntent(dir: string, id: string, patch: { status: Exclude<ReplyIntentStatus,"pending">; at?: string; error?: string }): ReplyIntent | null {
 return withIntentLock(dir, id, () => {
  const cur = readReplyIntent(dir, id); if (!cur || cur.status !== "pending") return null;
  const at = patch.at ?? new Date().toISOString(); const next: ReplyIntent = { ...cur, status: patch.status, updatedAt: at };
  if (patch.status === "sent") next.sentAt = at; else if (patch.status === "failed") { next.failedAt = at; if (patch.error !== undefined) next.error = patch.error; } else { next.unknownAt = at; if (patch.error !== undefined) next.error = patch.error; }
  try { atomic(pathFor(dir, id), next); return next; } catch { return null; }
 });
}

