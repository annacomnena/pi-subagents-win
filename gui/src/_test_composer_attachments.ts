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
	DRAFT_MAX_CHARS,
	MAX_ATTACHMENTS,
	MAX_ATTACHMENT_BYTES,
	attachmentIds,
	canSendMessage,
	candidatesFrom,
	applyOversizePaste,
	formatBytes,
	isAcceptedImage,
	isSpreadsheetClipboard,
	pickAttachments,
	pickPastePlan,
	rejectHint,
	type AttachmentItem,
	type ClipboardLike,
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

// ⑥ 粘贴决策（对齐 ZCode v4 composer：files+items 并集 / Excel 文本优先）
// 事故背景（2026-10-19 实测）：旧 onPaste 只读 `clipboardData.files`，而微信/截图工具/
// 跨应用复制图时 files 为空、图只在 items 里 ⇒ 不拦截也不提示 = 完全静默（AGENTS R-2）。
{
	const mkFile = (name: string, type: string, size = 1024): { name: string; type: string; size: number } => ({ name, type, size });
	const item = (f: { name: string; type: string; size: number } | null): { kind: string; getAsFile: () => typeof f } => ({ kind: "file", getAsFile: () => f });
	const cb = (o: {
		files?: { name: string; type: string; size: number }[] | null;
		items?: { kind: string; getAsFile: () => { name: string; type: string; size: number } | null }[] | null;
		text?: string;
		html?: string;
	}): ClipboardLike => ({
		files: o.files ?? null,
		items: o.items ?? null,
		getData: (t: string) => (t === "text/plain" ? (o.text ?? "") : t === "text/html" ? (o.html ?? "") : ""),
	});

	// (a) files 有图 ⇒ 用它（reason=files）
	const a = pickPastePlan(cb({ files: [mkFile("s.png", "image/png")] }));
	assert.equal(a.reason, "files", "files 通道优先");
	assert.equal(a.files.length, 1, "收到 1 张");
	assert.equal(a.preferText, false, "不 preferText");

	// (b) files 空、items 有图 ⇒ 回退到 items（**这正是修复前完全失效的那条路**）
	const b = pickPastePlan(cb({ files: [], items: [item(mkFile("w.png", "image/png"))] }));
	assert.equal(b.reason, "items", "files 空时必须回退 items");
	assert.equal(b.files.length, 1, "items 也能收到图");

	// (c) items 里非 file 的项（纯文本 item）不干扰
	const c = pickPastePlan(cb({ files: null, items: [{ kind: "string", getAsFile: () => null }, item(mkFile("x.png", "image/png"))] }));
	assert.equal(c.files.length, 1, "非 file 项被跳过");

	// (d) 同一对象出现在两通道 ⇒ 只收一次（对象身份）
	const sameObj = mkFile("dup.png", "image/png");
	const d = pickPastePlan(cb({ files: [sameObj], items: [item(sameObj)] }));
	assert.equal(d.files.length, 1, "两通道同一对象只收一次");

	// (d1) 【真实缺陷回归，2026-10-19 用户真机】Chromium 的 files 与 items.getAsFile()
	// 返回**内容相同但对象不同**的 File。旧实现做并集 + WeakSet 去重？⇒ 判不出重复，
	// 落盘两份（实测 up_TjUuHFoNllj4 / up_FYVghXZgGjZa，各 93609B，sha256 相同）。
	// 这里用两个**同名同大小但不同对象**的 File 模拟那个形状。
	const twinA = mkFile("shot.png", "image/png", 93609);
	const twinB = mkFile("shot.png", "image/png", 93609);
	assert.notStrictEqual(twinA, twinB, "前提：两个不同对象");
	const d1 = pickPastePlan(cb({ files: [twinA], items: [item(twinB)] }));
	assert.equal(d1.files.length, 1, "files 与 items 内容相同但对象不同时，**只能收 1 张**（否则必出重复上传）");
	assert.strictEqual(d1.files[0], twinA, "以 files 通道为准（主通道优先）");

	// (d2) L4 M1 仍成立：**同一个通道内**两个同元数据但不同对象的图必须都保留
	const d2 = pickPastePlan(
		cb({ files: [mkFile("shot.png", "image/png", 4096), mkFile("shot.png", "image/png", 4096)] }),
	);
	assert.equal(d2.files.length, 2, "同通道内同元数据的不同图片必须都保留（不误删）");

	// (e) getAsFile 抛错 ⇒ 不搞崩整批
	const e = pickPastePlan(cb({ files: null, items: [{ kind: "file", getAsFile: () => { throw new Error("boom"); } }, item(mkFile("ok.png", "image/png"))] }));
	assert.equal(e.files.length, 1, "单条抛错不放弃整批");

	// (f) 无图 ⇒ none（调用方**不得** preventDefault）
	const f = pickPastePlan(cb({ files: [], items: [], text: "纯文字" }));
	assert.equal(f.reason, "none", "无图 = none");
	assert.equal(f.files.length, 0, "无图不收");

	// (g) Excel 陷阱：有图 + 文本含 Tab ⇒ 表格文本获胜
	const g = pickPastePlan(cb({ files: [mkFile("excel.png", "image/png")], text: "a\tb\tc" }));
	assert.equal(g.reason, "spreadsheet-text", "Tab ⇒ 表格文本获胜");
	assert.equal(g.files.length, 0, "表格场景不收合成 PNG");
	assert.equal(g.preferText, true, "让位给文本粘贴");

	// (h) Excel 陷阱：单列复制（无 Tab，但 HTML 有标记）—— 前提是**文本非空**
	// 注：ZCode 的原函数是 `if (text.length === 0) return false;`（`chatAttachmentMetadata.ts:8`），
	// 所以 HTML-only + 空文本不会触发表格优先。Excel 实际复制总会带文本，因此这是
	// 防御性兜底而非真实场景。此处按**ZCode 真实语义**断言（不能自己发明行为）。
	const h = pickPastePlan(cb({ files: [mkFile("excel.png", "image/png")], text: "123", html: '<html xmlns:x="urn:schemas-microsoft-com:office:excel">' }));
	assert.equal(h.reason, "spreadsheet-text", "Excel HTML 标记 + 非空文本 ⇒ 文本获胜");
	// (h2) 反向：HTML-only（文本空）⇒ 不触发（与 ZCode 逐字同口径）
	const h2 = pickPastePlan(cb({ files: [mkFile("excel.png", "image/png")], html: '<html xmlns:x="urn:schemas-microsoft-com:office:excel">' }));
	assert.equal(h2.reason, "files", "文本为空时 HTML 标记不足以触发（同 ZCode 防御性口径）");

	// (i) 普通图片 + 无关 HTML ⇒ 仍收图
	const i = pickPastePlan(cb({ files: [mkFile("p.png", "image/png")], html: "<b>hi</b>" }));
	assert.equal(i.reason, "files", "无关 HTML 不影响收图");

	// (j) 纯空白文本 + 图 ⇒ 收图（不误判成表格）
	const j = pickPastePlan(cb({ files: [mkFile("q.png", "image/png")], text: "   " }));
	assert.equal(j.reason, "files", "空文本不触发表格优先");

	// (k) isSpreadsheetClipboard 直测
	assert.equal(isSpreadsheetClipboard("", "<table>"), false, "空文本不算表格（与 ZCode 同口径）");
	assert.equal(isSpreadsheetClipboard("a\tb", ""), true, "Tab 算");
	assert.equal(isSpreadsheetClipboard("abc", ""), false, "无表格证据不算");

	// (l) 超长粘贴接管（L4 M2）：必须真的控制插入量与提示，而不是只算一个数字
	// 未超限 ⇒ 不接管（notice=null、next 原样），调用方才放行浏览器默认粘贴
	const l0 = applyOversizePaste("abc", 3, 3, "def");
	assert.equal(l0.notice, null, "未超限 = 不接管");
	assert.equal(l0.next, "abc", "未超限不改正文");
	assert.equal(l0.dropped, 0, "未超限不丢弃");

	// 超限 ⇒ 按剩余容量截断，next 与 dropped 必须自洽（提示不能与实际丢失脱钩）
	const l1 = applyOversizePaste("x".repeat(7998), 7998, 7998, "ABCDEFG");
	assert.equal(l1.dropped, 5, "8000 上限下只留 2 个，丢 5 个");
	assert.equal(l1.next.length, DRAFT_MAX_CHARS, "结果恰达上限");
	assert.ok(l1.next.endsWith("AB"), "保留的是粘贴内容的前缀");
	assert.ok(l1.notice !== null && l1.notice.includes("8000") && l1.notice.includes("丢弃 5"), "提示的丢弃数与实际一致");

	// 选区替换语义：先删选区再插（与浏览器默认粘贴一致）
	const l2 = applyOversizePaste("AAABBB", 3, 6, "X".repeat(9000));
	assert.ok(l2.next.startsWith("AAA"), "选区前的部分保留");
	assert.equal(l2.next.length, DRAFT_MAX_CHARS, "替换后仍受上限约束");
	assert.equal(l2.dropped, 9000 - (DRAFT_MAX_CHARS - 3), "选区替换后的丢弃数正确");

	// 已满 ⇒ 一个字都插不进去，但必须仍给提示（不得静默）
	const l3 = applyOversizePaste("y".repeat(DRAFT_MAX_CHARS), DRAFT_MAX_CHARS, DRAFT_MAX_CHARS, "z");
	assert.equal(l3.dropped, 1, "已满时全丢");
	assert.equal(l3.next, "y".repeat(DRAFT_MAX_CHARS), "正文不变");
	assert.ok(l3.notice !== null && l3.notice.includes("仅保留前 0"), "已满时保留数为 0 且提示存在");
}
ok("⑥ 粘贴决策（files/items 并集 + Excel 文本优先 + 超长提示）");

// ⑤ 接线静态断言（只做存在性/形状，不跑 DOM）
{
	const chat = readFileSync(new URL("./pages/ChatPage.tsx", import.meta.url), "utf8");
	assert.ok(chat.includes("onPaste={"), "输入框有 onPaste（Ctrl+V）");
	// 2026-10-19：不再是直接读 clipboardData.files（那是静默失效的缺陷源头），
	// 改为经纯函数 pickPastePlan（files+items 并集 / Excel 文本优先）。
	assert.ok(!chat.includes("e.clipboardData?.files"), "onPaste 不再只读 files（旧缺陷不得回归）");
	assert.ok(chat.includes("pickPastePlan("), "onPaste 走 pickPastePlan 纯函数");
	assert.ok(chat.includes("plan.preferText"), "表格文本优先分支存在");
	assert.ok(chat.includes("plan.files.length > 0"), "收图分支存在");
	assert.ok(chat.includes("applyOversizePaste"), "超长粘贴走 applyOversizePaste（真接管，不靠 maxLength 静默截断）");
	assert.ok(chat.includes("res.notice === null"), "未超限时放行默认粘贴（不误拦）");
	assert.ok(chat.includes("e.dataTransfer?.files"), "拖放真正接收文件（不再是占位）");
	assert.ok(chat.includes('data-composer-attachments="1"'), "缩略图行节点存在");
	assert.ok(chat.includes("<img") && chat.includes("a.previewUrl"), "缩略图渲染 previewUrl");
	assert.ok(chat.includes("removeAttachment"), "可逐张删除");
	assert.ok(chat.includes('type="file"') && chat.includes('accept="image/png,image/jpeg,image/webp,image/gif"'), "隐藏 file input + 白名单 accept");
	assert.ok(chat.includes("sendChatMessage(activeId, text, ids.length > 0 ? ids : undefined)"), "发送带附件 id");
	// 2026-10-19：远程注入信封折叠 + 本地回显退场（用户要求「一条消息不要画两遍」）
	assert.ok(chat.includes("parseOutboxEnvelope(row.text)"), "userInput 走信封解析");
	assert.ok(chat.includes("投递详情"), "信封细节折叠（默认收起）");
	assert.ok(chat.includes("data-user-attachment-chips"), "附件以 chip 呈现");
	assert.ok(chat.includes("echoedIds.has(outboxIdForCommandKey(e.commandKey))"), "本地回显按 outboxId 配对后退场");
	assert.ok(chat.includes("echoedOutboxIds("), "transcript 一次解析建 Set（L4 S3 性能）");

	const store = readFileSync(new URL("./store.ts", import.meta.url), "utf8");
	// 2026-10-19：契约升级为 api.sessionMessage(sessionId, text, attachments, commandKey)
	// （commandKey 单一来源，见 _test_outbox_envelope ⑦）；attachments 仍在第 3 参。
	assert.ok(
		store.includes("api.sessionMessage(sessionId, text, attachments, commandKey)"),
		"store 透传 attachments（+ commandKey 单一来源）",
	);
	const client = readFileSync(new URL("./api/client.ts", import.meta.url), "utf8");
	assert.ok(client.includes('"/v1/uploads"'), "client 打上传端点");
	assert.ok(client.includes("body: file"), "上传发送**原始字节**（非 JSON base64）");
	assert.ok(/payload: attachments !== undefined && attachments\.length > 0 \? \{ text, attachments \} : \{ text \}/.test(client), "命令载荷按有无附件分形");
}
ok("⑤ 接线静态断言（ChatPage/store/client）");

console.log(`\n_test_composer_attachments: all assertions passed (${n})`);
