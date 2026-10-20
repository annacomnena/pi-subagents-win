/**
 * _test_outbox_envelope.ts — GUI 投递信封解析 / 配对（纯逻辑，Node 直跑）。
 *
 * 事故背景（2026-10-19 用户真机）：
 *   经 Web Console 发消息后 GUI 出现**两条**：
 *     ① transcript 的 userInput = 注入信封全文（dedupe 头 + 附件块 + [evt:…]）
 *     ② 本地 outbox 回显 = 原文 +「已提交·等待注入」，且**永不退场**
 *
 * 用户裁决：**TUI 保留信封可接受** ⇒ 注入正文一字不改（改它会断
 * `async-result-watcher` 的 consumed ACK 与 `wechat-reply-hook` 的微信回路）。
 * 因此这里只测 GUI 渲染层：解析 + 配对退场。
 *
 * 夹具纪律（AGENTS §5）：下面 `REAL_*` 是**从真实 session JSONL 抓的原文**，不是手编形状。
 *
 * 运行：npm run test:outbox-envelope --prefix gui
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
	isEchoedInTranscript,
	outboxIdForCommandKey,
	parseOutboxEnvelope,
	sha256Hex,
} from "./outboxEnvelope.ts";

let n = 0;
const ok = (name: string): void => {
	n += 1;
	console.log(`ok ${n} - ${name}`);
};

// ── ① 纯 JS SHA-256 必须与 node:crypto 逐字节一致 ─────────────────────
// 这是整个配对方案的地基：GUI 在浏览器里跑，只能用纯 JS 实现；
// 一旦实现有偏差，outboxIdForCommandKey 就永远配不上 transcript。
{
	const samples = [
		"",
		"a",
		"abc",
		"session.message:gui_mvelwdxe_msg_issrln",
		"session.message:gui_mvey2qto_msg_xv5pfn",
		"中文测试 UTF-8 🖼 emoji",
		"x".repeat(1_000),
		"y".repeat(55), // 56 字节边界减一（padding 分界）
		"z".repeat(56), // 恰在分界
		"w".repeat(64),
		"v".repeat(65),
	];
	for (const s of samples) {
		const mine = sha256Hex(s);
		const node = createHash("sha256").update(s, "utf8").digest("hex");
		assert.equal(mine, node, `sha256 与 node:crypto 不一致：${JSON.stringify(s.slice(0, 30))}`);
	}
	ok("① 纯 JS SHA-256 ≡ node:crypto（含 UTF-8/emoji/边界长度）");
}

// ── ② outboxIdForCommandKey 与 message-outbox.ts 的 outboxItemId 同口径 ──
// dedupeKey = `${frame.type}:${frame.commandKey}`，type 恒为 "session.message"
// （extensions/runtime/message-outbox.ts:136 outboxItemId）。
{
	// 两条**真实历史样本**（从 runtime/state/message-outbox 实测得到）
	assert.equal(
		outboxIdForCommandKey("gui_mvelwdxe_msg_issrln"),
		"c8bfa593c83a0f19904685410bdda184bc9f3aac3c960f405a9930c502b1b94e",
		"真实样本 1：outboxId 必须精确命中",
	);
	assert.equal(
		outboxIdForCommandKey("gui_mvey2qto_msg_xv5pfn"),
		"2748fd10c9d74e291fcf0a3a03cfe8ff5b1a664a76cd8f1755d69cf52f38f0c6",
		"真实样本 2：outboxId 必须精确命中",
	);
	// 与 node 侧同口径（等价于 sha256("session.message:" + ck)）
	assert.equal(
		outboxIdForCommandKey("abc"),
		createHash("sha256").update("session.message:abc", "utf8").digest("hex"),
		"同口径：session.message:<commandKey>",
	);
	ok("② outboxIdForCommandKey ≡ outboxItemId 口径（两条真实样本）");
}

// ── ③ 解析真实注入正文（从 session JSONL 抓的原文）──────────────────────
const REAL_TEXT_ONLY =
	"（Web Console 远程输入｜dedupe:outbox:c8bfa593c83a0f19904685410bdda184bc9f3aac3c960f405a9930c502b1b94e）\n" +
	"01a1518c-ecec-74ee-be07-257fa0767371 我发送了一个图片，你能看到吗\n" +
	"[evt:async:outbox_c8bfa593c83a0f19904685410bdda184bc9f3aac3c960f405a9930c502b1b94e:1a9d210cbb27d028]";

const REAL_WITH_ATTACHMENT =
	"（Web Console 远程输入｜dedupe:outbox:2a95841efd7e60852079683cd0d69a52ff29ac895eb4b2e3c647b6e45a64cabd）\n" +
	"probe 附件链\n" +
	"\n" +
	"[用户上传图片 1 张；图片未内联在会话里，需要时用 read 工具按下列路径读取]\n" +
	"1. C:\\Users\\Annacomnena\\.pi\\agent\\runtime\\uploads\\up_tGQ4ujIOxDTS.png\n" +
	"[evt:async:outbox_2a95841efd7e60852079683cd0d69a52ff29ac895eb4b2e3c647b6e45a64cabd:485bb326b815a100]";

{
	// (a) 纯文本注入
	const a = parseOutboxEnvelope(REAL_TEXT_ONLY);
	assert.ok(a !== null, "真实样本（纯文本）必须被识别");
	assert.equal(a!.outboxId, "c8bfa593c83a0f19904685410bdda184bc9f3aac3c960f405a9930c502b1b94e", "outboxId 精确");
	assert.equal(a!.source, "Web Console 远程输入", "来源标注");
	assert.equal(a!.text, "01a1518c-ecec-74ee-be07-257fa0767371 我发送了一个图片，你能看到吗", "正文只留用户原文");
	assert.deepEqual(a!.attachmentPaths, [], "无附件");
	assert.equal(a!.eventIds.length, 1, "evt 标记被抓到");
	assert.ok(a!.eventIds[0]!.startsWith("async:outbox_c8bfa593"), "evt id 内容正确");

	// (b) 带附件的注入
	const b = parseOutboxEnvelope(REAL_WITH_ATTACHMENT);
	assert.ok(b !== null, "真实样本（带附件）必须被识别");
	assert.equal(b!.text, "probe 附件链", "正文剥掉附件块后只剩原文（尾部空行也要剥）");
	assert.deepEqual(
		b!.attachmentPaths,
		["C:\\Users\\Annacomnena\\.pi\\agent\\runtime\\uploads\\up_tGQ4ujIOxDTS.png"],
		"附件路径逐字保留",
	);
	assert.equal(b!.eventIds.length, 1, "evt 标记仍被抓到");
	ok("③ 解析真实注入正文（纯文本 / 带附件两种形状）");
}

// ── ④ 保守门：普通消息一律不剥（宁可漏剥不可误剥）──────────────────────
{
	// 用户手输的普通消息
	assert.equal(parseOutboxEnvelope("你好"), null, "普通短消息不剥");
	assert.equal(parseOutboxEnvelope(""), null, "空串不剥");
	assert.equal(parseOutboxEnvelope("（这不是信封）"), null, "括号但无 dedupe 不剥");
	// 只有信封首行、没有 evt 也没有附件块 ⇒ 保守拒绝（可能是用户手打相似文本）
	assert.equal(
		parseOutboxEnvelope("（Web Console 远程输入｜dedupe:outbox:" + "a".repeat(64) + "）\n正文"),
		null,
		"仅首行像信封但无 evt/附件 ⇒ 不剥（防误剥用户手写）",
	);
	// 首行不是整行信封形状
	assert.equal(
		parseOutboxEnvelope("前缀（Web Console 远程输入｜dedupe:outbox:" + "a".repeat(64) + "）\n[evt:async:x]"),
		null,
		"首行不是整行信封 ⇒ 不剥",
	);
	// 64 hex 不合法（63 位）
	assert.equal(
		parseOutboxEnvelope("（Web Console｜dedupe:outbox:" + "a".repeat(63) + "）\n[evt:async:x]"),
		null,
		"outboxId 长度不对 ⇒ 不剥",
	);
	// 多行正文 + evt 绑定：正文里的「1. xxx」不应被误当附件路径（附件块之前）
	const B64 = "b".repeat(64);
	const c = parseOutboxEnvelope(
		"（Web Console｜dedupe:outbox:" + B64 + "）\n第一行\n1. 这是正文里的编号行\n[evt:async:outbox_" + B64 + ":rev1]",
	);
	assert.ok(c !== null && c.text.includes("1. 这是正文里的编号行"), "附件块之前的编号行属于正文");
	assert.deepEqual(c!.attachmentPaths, [], "不误收集附件路径");
	ok("④ 保守门：普通/相似文本不剥，正文与附件块不混淆");
}

// ── ④b L4 M1 对抗样本：用户讨论/手打这个格式时不得被误剥 ────────────────
// **我们这次对话本身就在引用该格式**，所以这不是假想威胁（L4 审查员的原话）。
{
	const ID = "c".repeat(64);
	// (a) 首行像信封，但正文里挂着**别人的** evt 标记 ⇒ 拒剥（双向绑定不成立）
	assert.equal(
		parseOutboxEnvelope(
			"（Web Console 远程输入｜dedupe:outbox:" + ID + "）\n我在讨论这个格式\n[evt:async:outbox_" + "d".repeat(64) + ":rev]",
		),
		null,
		"evt 标记不绑定本 outboxId ⇒ 拒剥（防用户手写被吞）",
	);
	// (b) 首行像信封 + 一个不相干的短 evt ⇒ 拒剥
	assert.equal(
		parseOutboxEnvelope("（Web Console 远程输入｜dedupe:outbox:" + ID + "）\n正文\n[evt:async:y]"),
		null,
		"无绑定 evt ⇒ 拒剥",
	);
	// (c) 正例：evt 真绑定本 outboxId ⇒ 照常剥
	const okCase = parseOutboxEnvelope(
		"（Web Console 远程输入｜dedupe:outbox:" + ID + "）\n正文\n[evt:async:outbox_" + ID + ":rev9]",
	);
	assert.ok(okCase !== null && okCase.text === "正文", "绑定 evt ⇒ 正常剥离");
	assert.deepEqual(okCase!.eventIds, ["async:outbox_" + ID + ":rev9"], "只收绑定本 id 的 evt");
	ok("④b M1 对抗：格式讨论不被误剥（双向绑定 evt↔outboxId）");
}

// ── ④c L4 M2 对抗样本：附件块按声明数量收敛，不得吞后续正文 ──────────────
{
	const ID = "e".repeat(64);
	const head = "[用户上传图片 2 张；图片未内联在会话里，需要时用 read 工具按下列路径读取]";
	const evt = "[evt:async:outbox_" + ID + ":rev]";
	// (a) 声明 2 条、给 2 条、第 3 行是正文 ⇒ 第 3 行必须留在正文
	const a = parseOutboxEnvelope(
		["（Web Console｜dedupe:outbox:" + ID + "）", "看看这几张", "", head, "1. C:\\a.png", "2. C:\\b.png", "3. 这是我说的话", evt].join("\n"),
	);
	assert.ok(a !== null, "结构正确 ⇒ 应解析");
	assert.deepEqual(a!.attachmentPaths, ["C:\\a.png", "C:\\b.png"], "只收声明数量的路径");
	assert.ok(a!.text.includes("3. 这是我说的话"), "第 N+1 条编号行回到正文（不被吞）");

	// (b) 声明 2 条却只给 1 条 ⇒ 结构不符 ⇒ 整体拒剥（宁可漏剥不可吞正文）
	assert.equal(
		parseOutboxEnvelope(
			["（Web Console｜dedupe:outbox:" + ID + "）", "正文", "", head, "1. C:\\a.png", "后面这段是正文"].join("\n"),
		),
		null,
		"声明数量不足 ⇒ 拒剥（不吞正文）",
	);

	// (c) 失效附件块同样按数量收敛
	const deadHead = "[另有 1 张图片附件已失效（文件不存在，可能已过期被清理）；不要尝试 read，向用户说明需重新发送]";
	const d = parseOutboxEnvelope(["（Web Console｜dedupe:outbox:" + ID + "）", "正文", "", deadHead, "1. C:\\gone.png", evt].join("\n"));
	assert.ok(d !== null, "失效块也按数量解析");
	assert.deepEqual(d!.attachmentPaths, ["C:\\gone.png"], "失效路径也收（供诊断）");
	ok("④c M2 对抗：附件块按声明数量收敛，N+1 行回到正文，数量不足拒剥");
}

// ── ⑤ 配对退场：isEchoedInTranscript ────────────────────────────────────
{
	const ck = "gui_mvelwdxe_msg_issrln";
	// transcript 里已有同 outboxId ⇒ 视为已回显
	assert.equal(isEchoedInTranscript(ck, [REAL_TEXT_ONLY]), true, "同 outboxId ⇒ 已回显");
	assert.equal(isEchoedInTranscript(ck, [REAL_WITH_ATTACHMENT]), false, "不同 outboxId ⇒ 未回显");
	assert.equal(isEchoedInTranscript(ck, []), false, "空 transcript ⇒ 未回显");
	assert.equal(isEchoedInTranscript(ck, ["你好", "随便说点什么"]), false, "普通行不误判");
	// 混合：先有无关行，再有命中行
	assert.equal(isEchoedInTranscript(ck, ["你好", REAL_TEXT_ONLY]), true, "混合列表中命中即可");
	// 反向：用另一个 commandKey 去配 REAL_TEXT_ONLY 的 id ⇒ 不应命中
	assert.equal(
		isEchoedInTranscript("gui_mvey2qto_msg_xv5pfn", [REAL_TEXT_ONLY]),
		false,
		"不同 commandKey 不串号（精确判等，非模糊匹配）",
	);
	ok("⑤ 配对退场：按 outboxId 精确判等，不串号不误判");
}

// ── ⑥ 作用域不变量（L4 B 项）：chatOutbox 的唯一写入点必须是 session.message ──
// 本函数的口径只对 Web GUI 成立；若将来有人在 GUI 里插别的 type，这里要红。
{
	const store = readFileSync(new URL("./store.ts", import.meta.url), "utf8");
	// chatOutbox 的写入全部走 set({chatOutbox: {...get().chatOutbox, [commandKey]: ...}})
	// 新增条的形态是 `[commandKey]: entry`；只允许出现在 sendChatMessage 内。
	const insertSites = [...store.matchAll(/\[commandKey\]:\s*entry/g)].length;
	assert.equal(insertSites, 1, `chatOutbox 新增条目恰好 1 处（发现 ${insertSites}）`);
	// 该唯一插入点所在函数只调 api.sessionMessage
	const fnStart = store.indexOf("sendChatMessage: async");
	assert.ok(fnStart >= 0, "sendChatMessage 存在");
	const fnEnd = store.indexOf("pollChatSessions:", fnStart);
	assert.ok(fnEnd > fnStart, "能切出 sendChatMessage 函数体");
	const fnBody = store.slice(fnStart, fnEnd);
	assert.ok(fnBody.includes("api.sessionMessage("), "写入点用 api.sessionMessage");
	assert.ok(fnBody.includes('[commandKey]: entry'), "新增条目就在该函数内");
	// api.sessionMessage 的 type 恒为 session.message（与 outboxIdForCommandKey 同口径）
	const client = readFileSync(new URL("./api/client.ts", import.meta.url), "utf8");
	const smStart = client.indexOf("sessionMessage:");
	assert.ok(smStart >= 0, "client 有 sessionMessage");
	const smBody = client.slice(smStart, smStart + 900);
	assert.ok(smBody.includes('type: "session.message"'), "sessionMessage 的 type 恒为 session.message");
	ok("⑥ 作用域不变量：chatOutbox 唯一写入点 = session.message（口径可证）");
}

// ── ⑦ commandKey 单一来源（2026-10-19 真机缺陷根因）────────────────────
// 事故：store 用 `gui_msg_<ts>_<rand>` 作本地 key，client 内部又用
// `gui_<ts>_msg_<rand>` 另造一个发出去 ⇒ **两个 key 不同** ⇒ outboxId 算错 ⇒
// 本地回显永不退场（用户：「一直排在 GUI 最下边一条」）。
{
	const client = readFileSync(new URL("./api/client.ts", import.meta.url), "utf8");
	const store = readFileSync(new URL("./store.ts", import.meta.url), "utf8");

	// (a) client.sessionMessage 必须接受**调用方传入的** commandKey
	assert.ok(
		/client\.sessionMessage|sessionMessage:\s*\(/.test(client) &&
			client.includes("commandKey?: string"),
		"client.sessionMessage 接受可选 commandKey 参数",
	);
	const smStart = client.indexOf("sessionMessage:");
	const smBody = client.slice(smStart, smStart + 2_000);
	assert.ok(
		smBody.includes("commandKey: commandKey ?? newCommandKey(\"msg\")"),
		"client 用调用方给的 key（缺省才自造）——不得无条件另造",
	);
	assert.ok(
		!/commandKey:\s*newCommandKey\(\"msg\"\),/.test(smBody),
		"client 不得无条件 newCommandKey（旧缺陷原形）",
	);

	// (b) store 必须把同一个 key 传下去
	const fnStart = store.indexOf("sendChatMessage: async");
	const fnEnd = store.indexOf("pollChatSessions:", fnStart);
	const fnBody = store.slice(fnStart, fnEnd);
	assert.ok(
		/api\.sessionMessage\(sessionId, text, attachments, commandKey\)/.test(fnBody),
		"store 把本地 commandKey 传给 api.sessionMessage（同源）",
	);
	assert.ok(
		!/api\.sessionMessage\(sessionId, text, attachments\)/.test(fnBody),
		"store 不得省略 commandKey（否则 key 双生成）",
	);

	// (c) store 用于本地 key 的那个变量，必须来自导出的 newCommandKey（与 client 同实现）
	assert.ok(store.includes('newCommandKey("msg")'), "store 用 newCommandKey 生成 key");
	assert.ok(client.includes("export function newCommandKey"), "newCommandKey 已导出（两处共用同一实现）");
	ok("⑦ commandKey 单一来源：本地记录 ↔ 服务端 outbox ↔ transcript 标记三者同源");
}

// ── ⑧ 状态行不再复述正文（用户裁决：不要第二条气泡）────────────────────
{
	const chat = readFileSync(new URL("./pages/ChatPage.tsx", import.meta.url), "utf8");
	const fnStart = chat.indexOf("function OutboxStatusLine");
	assert.ok(fnStart >= 0, "存在 OutboxStatusLine");
	const fnBody = chat.slice(fnStart, fnStart + 1_200);
	assert.ok(!fnBody.includes("bg-bubble-user"), "状态行不得再画 user 气泡");
	assert.ok(!fnBody.includes("{e.text}"), "状态行不得复述正文（那是重复的根源）");
	assert.ok(fnBody.includes('e.status === "delivered"') && fnBody.includes("return null"), "已送达 ⇒ 静默不显示");
	// 失败类必须仍可见（AGENTS R-2：静默失败不可接受）
	assert.ok(fnBody.includes("destructive"), "失败类仍可见（不静默）");
	ok("⑧ 状态行极简化：不复述正文，已送达静默，失败仍可见");
}

console.log(`\n_test_outbox_envelope: all assertions passed (${n})`);
