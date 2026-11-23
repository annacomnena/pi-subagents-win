// 给指定 logical recipient 投一封消息信（复用 deliverLetter 单一投递咽喉点）。
// 用法：node --experimental-strip-types scripts/_send_letter_to.mjs <to> <subjectFile> <bodyFile> [kind]
//   to      ObjectAddress，如 agent://master_local_GreenCAD
//   kind    可选，MESSAGE_KINDS 之一，缺省 DELEGATION
import { readFileSync } from "node:fs";
import { deliverLetter } from "../extensions/runtime/mailbox.ts";
import { newMessageFrame } from "../extensions/runtime/protocol.ts";
import { newEnvelopeId } from "../extensions/runtime/ids.ts";

const [to, subjectFile, bodyFile, kindArg] = process.argv.slice(2);
if (!to || !subjectFile || !bodyFile) {
	console.error("usage: node --experimental-strip-types scripts/_send_letter_to.mjs <to> <subjectFile> <bodyFile> [kind]");
	process.exit(2);
}
const kind = kindArg ?? "DELEGATION";
const subject = readFileSync(subjectFile, "utf8").trim();
const body = readFileSync(bodyFile, "utf8");
const from = "agent://master_default";
const frame = newMessageFrame({
	id: newEnvelopeId("msg"),
	kind,
	from,
	to,
	sentAt: new Date().toISOString(),
	summary: subject.slice(0, 400),
	details: { text: body.slice(0, 20000), kind },
});
const r = deliverLetter(frame, {});
console.log(JSON.stringify({ ok: true, messageId: r.letter.frame.id, created: r.created, to }));
