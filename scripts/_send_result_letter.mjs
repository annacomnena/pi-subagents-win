// 用 deliverLetter 给 global master 投一封 RESULT 信（/send-letter 是 pi 命令，脚本无 CLI 入口）
// 用法：node --experimental-strip-types scripts/_send_result_letter.mjs <subjectFile> <bodyFile>
import { readFileSync } from "node:fs";
import { deliverLetter } from "../extensions/runtime/mailbox.ts";
import { newMessageFrame } from "../extensions/runtime/protocol.ts";
import { newEnvelopeId } from "../extensions/runtime/ids.ts";
import { masterAddress } from "../extensions/runtime/address.ts";

const [subjectFile, bodyFile] = process.argv.slice(2);
if (!subjectFile || !bodyFile) {
	console.error("usage: node ... <subjectFile> <bodyFile>");
	process.exit(2);
}
const subject = readFileSync(subjectFile, "utf8").trim();
const body = readFileSync(bodyFile, "utf8");
const from = "agent://master_local_subagent-win";
const to = masterAddress();
const frame = newMessageFrame({
	id: newEnvelopeId("msg"),
	kind: "REPORT",
	from,
	to,
	sentAt: new Date().toISOString(),
	summary: subject.slice(0, 400),
	details: { text: body.slice(0, 8000), kind: "RESULT" },
});
const r = deliverLetter(frame, {});
console.log(JSON.stringify({ ok: true, messageId: r.letter.frame.id, created: r.created }));
