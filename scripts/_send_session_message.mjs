// 把一条 session.message 投进「正在运行的某个 pi 会话」（走 outbox 两段式第二段的合法入口）：
// 第一段本应 executor 写盘；这里手工构造等价的 pending 项，由目标会话的 registerOutboxBridge
// （extensions/index.ts:2777）在 tick 内 claimInjection → pi.sendUserMessage 注入。
// 用法：node --experimental-strip-types scripts/_send_session_message.mjs <sessionId> <textFile> <dedupeKey> [reason]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newOutboxItem, outboxDir, writeOutboxItem, readOutboxItem } from "../extensions/runtime/message-outbox.ts";
import { defaultRuntimeDir } from "../extensions/runtime/journal.ts";

const [sessionId, textFile, dedupeKey, reason] = process.argv.slice(2);
if (!sessionId || !textFile || !dedupeKey) {
	console.error("usage: <sessionId> <textFile> <dedupeKey> [reason]");
	process.exit(2);
}
const text = readFileSync(textFile, "utf8");
const dir = outboxDir(join(defaultRuntimeDir(), "state"));
const item = newOutboxItem({
	dedupeKey,
	commandKey: dedupeKey,
	to: `pi://${sessionId}`,
	sessionId,
	text,
	...(reason ? { reason } : {}),
	now: new Date(),
});
const existing = readOutboxItem(dir, item.id);
if (existing) {
	console.log(JSON.stringify({ ok: true, created: false, id: item.id, status: existing.status }));
	process.exit(0);
}
writeOutboxItem(dir, item);
console.log(JSON.stringify({ ok: true, created: true, id: item.id, to: item.to, bytes: Buffer.byteLength(text, "utf8") }));
