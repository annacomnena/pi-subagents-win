import { createHash, randomBytes } from "node:crypto";
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const REPLY_INTENT_STATUSES = ["pending", "sent", "failed", "unknown"] as const;
export type ReplyIntentStatus = (typeof REPLY_INTENT_STATUSES)[number];
export interface ReplyIntent {
 version: 1; id: string; msgId: string; outboxId: string; fromId: string; clientId: string; text: string;
 status: ReplyIntentStatus; attempts: number; createdAt: string; updatedAt: string;
 sentAt?: string; failedAt?: string; unknownAt?: string; error?: string;
}
export function replyIntentDir(stateDir: string): string { return join(stateDir, "wechat-reply"); }
export function deriveReplyIntentId(outboxId: string): string { return createHash("sha256").update(`wechat-reply:${outboxId}`).digest("hex"); }
function pathFor(dir: string, id: string): string { return join(dir, `${id}.json`); }
function valid(x: unknown): x is ReplyIntent {
 if (!x || typeof x !== "object") return false;
 const v = x as ReplyIntent;
 return v.version === 1 && /^[0-9a-f]{64}$/.test(v.id) && typeof v.msgId === "string" && typeof v.outboxId === "string" && typeof v.fromId === "string" && typeof v.clientId === "string" && typeof v.text === "string" && REPLY_INTENT_STATUSES.includes(v.status) && Number.isInteger(v.attempts) && typeof v.createdAt === "string" && typeof v.updatedAt === "string";
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
export function markReplyIntent(dir: string, id: string, patch: { status: Exclude<ReplyIntentStatus,"pending">; at?: string; error?: string }): ReplyIntent | null {
 return withIntentLock(dir, id, () => {
  const cur = readReplyIntent(dir, id); if (!cur || cur.status !== "pending") return null;
  const at = patch.at ?? new Date().toISOString(); const next: ReplyIntent = { ...cur, status: patch.status, updatedAt: at };
  if (patch.status === "sent") next.sentAt = at; else if (patch.status === "failed") { next.failedAt = at; if (patch.error !== undefined) next.error = patch.error; } else { next.unknownAt = at; if (patch.error !== undefined) next.error = patch.error; }
  try { atomic(pathFor(dir, id), next); return next; } catch { return null; }
 });
}

