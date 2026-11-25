/**
 * _wechat_notify.mjs — 给业主微信发一条纯文本进度通知（iLink sendmessage 最小入口）
 *
 * 用法：node --experimental-strip-types scripts/_wechat_notify.mjs <textFile>
 *      （文本放文件，避免命令行/引号转义吃掉换行——本仓实测教训）
 * 收件人 = credentials.json 的 ownerOpenId ∪ config.json channels.wechat.reply.allowOut
 * 红线：botToken 只在内存 → Authorization header；本脚本**不打印** token/URL/请求体，
 *       只输出 {sent, recipients, kinds, error} 摘要。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultRuntimeDir } from "../extensions/runtime/journal.ts";
import { defaultPkgConfigPath } from "../extensions/runtime/master-injection.ts";
import { readWechatCreds, readWechatReplyConfig, wechatCredsPath } from "../extensions/runtime-host/wechat-bind.ts";
import { deriveCommandClientId, sendMessage } from "../extensions/channel-wechat/send.ts";

const [textFile] = process.argv.slice(2);
if (!textFile) {
	console.error("usage: node --experimental-strip-types scripts/_wechat_notify.mjs <textFile>");
	process.exit(2);
}

const runtimeDir = defaultRuntimeDir();
const creds = readWechatCreds(wechatCredsPath(runtimeDir));
if (!creds) {
	console.error(JSON.stringify({ ok: false, error: "wechat not bound (credentials.json missing/unreadable)" }));
	process.exit(3);
}

// 收件人：绑定 owner ∪ reply.allowOut（缺省 owner）
const cfg = readWechatReplyConfig(defaultPkgConfigPath());
const to = new Set();
if (creds.ownerOpenId) to.add(creds.ownerOpenId);
for (const id of cfg.allowOut ?? []) to.add(id);
if (to.size === 0) {
	console.error(JSON.stringify({ ok: false, error: "no outbound recipient (owner unbound & allowOut empty)" }));
	process.exit(4);
}

// iLink 文本上限：留出余量，4000 字符截断（W3 拍板③ 同口径）
const raw = readFileSync(textFile, "utf8");
const text = raw.length > 4000 ? `${raw.slice(0, 3980)}\n…（截断）` : raw;

const out = [];
for (const toUserId of to) {
	const msgId = `notify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const r = await sendMessage({
		baseUrl: creds.baseUrl,
		botToken: creds.botToken,
		toUserId,
		clientId: deriveCommandClientId(msgId, toUserId),
		text,
	});
	out.push({ to: toUserId.slice(0, 12) + "…", kind: r.kind, error: r.kind === "failed" ? r.error.message : r.kind === "unknown" ? r.reason : undefined });
}
console.log(JSON.stringify({ ok: out.every((o) => o.kind === "sent"), chars: text.length, results: out }));
process.exit(out.every((o) => o.kind === "sent") ? 0 : 1);
