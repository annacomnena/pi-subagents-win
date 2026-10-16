/**
 * _test_composer_attachments.ts — 输入框图片附件（S4）纯逻辑 + 接线静态门禁（零依赖，Node 直跑）。
 *
 * 覆盖：
 *   ① 常数与**服务端同源**（从 extensions/runtime-host/uploads.ts 源里读值比对，防漂移）；
 *   ② pickAttachments：接收/逐条拒绝（非图片、超 5MiB、超 4 张）+ 先到先得语义；
 *   ③ canSendMessage：无文字无图不发；粘图无文字可发；**有图未传完不发**；
 *   ④ attachmentIds 过滤未完成项；formatBytes/rejectHint 文案；
 *   ⑤ 接线静态断言：ChatPage（onPaste / 拖放接收 / 缩略图节点 / 隐藏 file input / 发送带 ids）、
 *      store（attachments 透传）、client（POST /v1/uploads，非 JSON base64）。
 *
 * 运行：npm run test:gui-composer
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
	ACCEPTED_IMAGE_TYPES,
	MAX_ATTACHMENTS,
	MAX_ATTACHMENT_BYTES,
	attachmentIds,
	canSendMessage,
	candidatesFrom,
	formatBytes,
	isAcceptedImage,
	pickAttachments,
	rejectHint,
	type AttachmentItem,
} from "./composerAttachments.ts";

let n = 0;
const ok = (name: string): void => {
	n += 1;
	console.log(`ok ${n} - ${name}`);
};

const f = (name: string, type: string, size = 1024): { name: string; type: string; size: number } => ({ name, type, size });

// ① 与服务端同源（读服务端源文件比对；改一端不改另一端 ⇒ 本断言红）
{
	const src = readFileSync(new URL("../../extensions/runtime-host/uploads.ts", import.meta.url), "utf8");
	assert.ok(src.includes("export const UPLOAD_MAX_BYTES = 5 * 1024 * 1024;"), "服务端单张上限常量存在");
	assert.ok(src.includes("export const UPLOAD_MAX_PER_MESSAGE = 4;"), "服务端条数上限常量存在");
	assert.equal(MAX_ATTACHMENT_BYTES, 5 * 1024 * 1024, "GUI 单张上限与服务端一致（5 MiB）");
	assert.equal(MAX_ATTACHMENTS, 4, "GUI 条数上限与服务端一致（4）");
	for (const t of ACCEPTED_IMAGE_TYPES) assert.ok(src.includes(`"${t}"`), `服务端白名单含 ${t}`);
	assert.ok(!(ACCEPTED_IMAGE_TYPES as readonly string[]).includes("image/svg+xml"), "svg 不进白名单（脚本面）");
	assert.ok(isAcceptedImage(f("a.png", "image/png")) && !isAcceptedImage(f("a.svg", "image/svg+xml")), "isAcceptedImage");
}
ok("① 与服务端同源（上限/白名单）+ svg 拒绝");

// ② pickAttachments：接收 + 逐条理由 + 先到先得
{
	const cur: AttachmentItem[] = [];
	const r = pickAttachments(cur, [f("a.png", "image/png"), f("b.jpg", "image/jpeg")]);
	assert.equal(r.accept.length, 2, "两张合法图接收");
	assert.deepEqual(r.accept.map((a) => a.name), ["a.png", "b.jpg"], "名字按序");
	assert.equal(r.rejected.length, 0, "无拒绝");

	const r2 = pickAttachments(cur, [
		f("ok.png", "image/png"),
		f("big.png", "image/png", MAX_ATTACHMENT_BYTES + 1),
		f("evil.svg", "image/svg+xml"),
		f("", "image/webp", 2048), // 无文件名（粘贴图）→ 兜底名
	]);
	assert.deepEqual(r2.accept.map((a) => a.name), ["ok.png", "粘贴的图片 4"], "接收项（含粘贴图兜底名）");
	assert.deepEqual(r2.rejected, [
		{ name: "big.png", reason: "too-large" },
		{ name: "evil.svg", reason: "not-image" },
	], "逐条拒绝理由");

	// 配额：已有 3 张 → 只再收 1 张，其余 too-many（先到先得，不随机丢）
	const full3 = [1, 2, 3].map((i) => ({ previewUrl: `blob:${i}`, name: `p${i}.png`, bytes: 1, uploadId: `up_${i}` }));
	const r3 = pickAttachments(full3, [f("x.png", "image/png"), f("y.png", "image/png")]);
	assert.deepEqual(r3.accept.map((a) => a.name), ["x.png"], "只剩 1 个名额：先到先得");
	assert.deepEqual(r3.rejected, [{ name: "y.png", reason: "too-many" }], "超额项 too-many");
	const full4 = [1, 2, 3, 4].map((i) => ({ previewUrl: `blob:${i}`, name: `p${i}.png`, bytes: 1, uploadId: `up_${i}` }));
	assert.equal(pickAttachments(full4, [f("z.png", "image/png")]).accept.length, 0, "满 4 张拒绝新图");
}
ok("② pickAttachments：接收/逐条理由/先到先得");

// ③ canSendMessage：发送闸门（含「有图未传完不发」这个关键反例）
{
	const done = (id: string | null): AttachmentItem => ({ previewUrl: `blob:${id ?? "x"}`, name: "a.png", bytes: 10, uploadId: id });
	assert.equal(canSendMessage("", []), false, "空文本无图 → 不发");
	assert.equal(canSendMessage("   ", []), false, "纯空白 → 不发");
	assert.equal(canSendMessage("hi", []), true, "有文字 → 发");
	assert.equal(canSendMessage("", [done("up_a")]), true, "粘图无文字 → 可发（空正文合法）");
	assert.equal(canSendMessage("hi", [done(null)]), false, "有图但**未上传完成** → 不发（防发出去引用不到）");
	assert.equal(canSendMessage("", [done("up_a"), done(null)]), false, "一张未完成即不发");
}
ok("③ canSendMessage：空文本+图可发 / 未传完不发");

// ④ attachmentIds 过滤 + 文案
{
	assert.deepEqual(attachmentIds([{ previewUrl: "b1", name: "a", bytes: 1, uploadId: "up_a" }, { previewUrl: "b2", name: "b", bytes: 1, uploadId: null }]), ["up_a"], "只回 completed 的 id");
	assert.equal(formatBytes(512), "512 B");
	assert.equal(formatBytes(2048), "2 KB");
	assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MB");
	assert.ok(rejectHint({ name: "a.svg", reason: "not-image" }).includes("png / jpeg / webp / gif"), "not-image 文案给白名单");
	assert.ok(rejectHint({ name: "b.png", reason: "too-large" }).includes("5.0 MB"), "too-large 文案给上限");
	assert.ok(rejectHint({ name: "c.png", reason: "too-many" }).includes("4"), "too-many 文案给条数");
	assert.deepEqual(candidatesFrom(null), [], "candidatesFrom(null) = []");
}
ok("④ attachmentIds/formatBytes/rejectHint");

// ⑤ 接线静态断言（只做存在性/形状，不跑 DOM）
{
	const chat = readFileSync(new URL("./pages/ChatPage.tsx", import.meta.url), "utf8");
	assert.ok(chat.includes("onPaste={"), "输入框有 onPaste（Ctrl+V）");
	assert.ok(chat.includes("e.clipboardData?.files"), "onPaste 读剪贴板图片");
	assert.ok(chat.includes("e.dataTransfer?.files"), "拖放真正接收文件（不再是占位）");
	assert.ok(chat.includes('data-composer-attachments="1"'), "缩略图行节点存在");
	assert.ok(chat.includes("<img") && chat.includes("a.previewUrl"), "缩略图渲染 previewUrl");
	assert.ok(chat.includes("removeAttachment"), "可逐张删除");
	assert.ok(chat.includes('type="file"') && chat.includes('accept="image/png,image/jpeg,image/webp,image/gif"'), "隐藏 file input + 白名单 accept");
	assert.ok(chat.includes("sendChatMessage(activeId, text, ids.length > 0 ? ids : undefined)"), "发送带附件 id");

	const store = readFileSync(new URL("./store.ts", import.meta.url), "utf8");
	assert.ok(store.includes("api.sessionMessage(sessionId, text, attachments)"), "store 透传 attachments");
	const client = readFileSync(new URL("./api/client.ts", import.meta.url), "utf8");
	assert.ok(client.includes('"/v1/uploads"'), "client 打上传端点");
	assert.ok(client.includes("body: file"), "上传发送**原始字节**（非 JSON base64）");
	assert.ok(/payload: attachments !== undefined && attachments\.length > 0 \? \{ text, attachments \} : \{ text \}/.test(client), "命令载荷按有无附件分形");
}
ok("⑤ 接线静态断言（ChatPage/store/client）");

console.log(`\n_test_composer_attachments: all assertions passed (${n})`);
