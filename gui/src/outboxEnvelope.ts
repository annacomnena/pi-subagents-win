/**
 * outboxEnvelope.ts — GUI 侧「投递信封」解析与配对（纯逻辑，Node 可测；ChatPage 只做渲染）。
 *
 * ── 问题由来（2026-10-19 用户真机反馈）─────────────��──────────────────
 * 经 Web Console 发消息后，GUI 里出现**两条**：
 *   ① transcript 那条 userInput —— 正文是**注入信封全文**：
 *      `（Web Console 远程输入｜dedupe:outbox:<64hex>）\n<原文>\n[用户上传图片…]\n1. path\n[evt:async:…]`
 *   ② 本地 outbox 回显 —— 只显示 `<原文>` + 「已提交·等待注入」，且**永不退场**
 * 两者视觉不同、无法配对，用户体感是「一条消息画了两遍，下面那条永远赖着」。
 *
 * ── 用户裁决（本次，重要）────────────────────────────────────────────
 * **TUI 里显示信封是可以接受的**（用户明确：「TUI 里这么显示没什么问题」，附 TUI 截图）。
 * ⇒ **注入正文一字不改**。理由与证据：
 *   - `extensions/async-result-watcher.ts:495` 靠 `extractEventIdsFromMessages` 扫 `[evt:async:…]`
 *     写 `consumed` ACK；删标记 ⇒ 交付账本永久 `unconfirmed`（R-2 静默失效）
 *   - `extensions/wechat-reply-hook.ts:310` 靠 `/dedupe:outbox:([0-9a-f]{64})/` 定位微信入站记录；
 *     删标记 ⇒ 微信自动回复永久失效（该缺陷历史上修过两次）
 * ⇒ 本模块**只做 GUI 渲染层解析**，绝不改写注入正文。
 *
 * ── 配对可以做成确定性的（实测）────────────────────────────────────
 * `outboxId = sha256("session.message:" + commandKey)`（`extensions/runtime/message-outbox.ts:136`
 * `outboxItemId(dedupeKey)`，`dedupeKey = \`${frame.type}:${frame.commandKey}\``）。
 * GUI 手上有 `commandKey`（`chatOutbox` 的 key）⇒ 能自己算出 outboxId ⇒
 * 与 transcript 行正文里的 `dedupe:outbox:<id>` **精确配对**，无需按正文模糊匹配。
 * 实测两条历史样本双向命中：
 *   gui_mvelwdxe_msg_issrln → c8bfa593…b94e ✔
 *   gui_mvey2qto_msg_xv5pfn → 2748fd10…f0c6 ✔
 */

/** 从注入正文里解析出的结构（未命中任何信封特征 ⇒ `null`）。 */
export interface ParsedOutboxEnvelope {
	/** 投递信封里声明的 outboxId（64 hex）。 */
	outboxId: string;
	/** 来源标注（如「Web Console 远程输入」）；缺省为 undefined。 */
	source?: string;
	/** 用户原文（已剥掉信封首行、附件块、evt 标记）。 */
	text: string;
	/** 附件绝对路径（按出现顺序）。 */
	attachmentPaths: string[];
	/** 正文里出现的 eventId（`[evt:async:...]` 内层，去掉 `evt:` 前缀）。 */
	eventIds: string[];
}

/** 信封首行：`（<来源>｜dedupe:outbox:<64hex>）` —— 整行锚定（防止误剥正文）。 */
const ENVELOPE_LINE_RE = /^（(?<source>[^）｜\n]{1,64})｜dedupe:outbox:(?<id>[0-9a-f]{64})）$/;
/** evt 标记行（可独占一行，也可紧贴正文末尾）。 */
const EVENT_MARKER_RE = /\[evt:(?<id>async:[^\]\s]+)\]/g;

/**
 * evt id 是否**真属于**该 outboxId。注入模板是 `async:outbox_<outboxId>:<rev>`
 * （`extensions/delivery-ledger.ts` ensureEvent + `outbox-bridge.ts` eventId）。
 *
 * 2026-10-19 L4 M1：只要求「有任意 evt 标记」太宽 —— 用户手打/讨论这个格式时
 * （例：**我们这次对话本身**就在引用该格式）会连正文一起被吞。
 * 改成双向绑定：evt id 必须显式含同一 outboxId，才认这是投递信封。
 */
function evtBelongsToOutbox(evtId: string, outboxId: string): boolean {
	return evtId.includes(`outbox_${outboxId}`) || evtId.includes(outboxId);
}
/** 附件块头：`[用户上传图片 N 张可用；…]` 或 `[用户上传图片 N 张；…]`。 */
const ATTACHMENT_HEAD_RE = /^\[用户上传图片 (?<n>\d+) 张(?:可用)?；.*\]$/;
/** 失效附件块头（`attachmentBlock` 的降级分支产物）。 */
const ATTACHMENT_DEAD_RE = /^\[另有 (?<n>\d+) 张图片附件(?:已失效|暂时无法确认).*\]$/;
/** 附件路径行：`<序号>. <路径>`。 */
const ATTACHMENT_PATH_RE = /^\d+\. (?<path>.+)$/;

/**
 * 解析注入信封（**保守**：任一处不匹配就整体返回 null，绝不误剥）。
 *
 * 保守的原因是 AGENTS §2：误剥会把用户真正想说的话吞掉，比漏剥（保留信封）严重得多。
 * 因此要求：
 *   - 首行必须**整行**是信封形状（`（来源｜dedupe:outbox:<64hex>）`）
 *   - 且必须另有 `[evt:async:…]` 标记 或 附件块 —— 二者之一
 *     （用户手动输入的正文几乎不可能同时满足）
 */
export function parseOutboxEnvelope(raw: string): ParsedOutboxEnvelope | null {
	if (typeof raw !== "string" || raw.length === 0) return null;
	const lines = raw.split(/\r?\n/);
	const first = lines[0] ?? "";
	const m = ENVELOPE_LINE_RE.exec(first);
	if (m === null || m.groups === undefined) return null;
	const outboxId = m.groups.id ?? "";
	const source = m.groups.source ?? undefined;
	if (!/^[0-9a-f]{64}$/.test(outboxId)) return null;

	// evt 标记：从全文抓，但**只保留真属于该 outboxId 的**
	// （L4 M1：任何 evt 都算 ⇒ 用户讨论该格式时会被误剥）
	const allEventIds: string[] = [];
	for (const mm of raw.matchAll(EVENT_MARKER_RE)) {
		const id = mm.groups?.id;
		if (typeof id === "string" && id.length > 0) allEventIds.push(id);
	}
	const boundEventIds = allEventIds.filter((id) => evtBelongsToOutbox(id, outboxId));
	// 若出现的 evt 标记**没有一个**绑定到本 outboxId ⇒ 这不是注入信封（可能是用户手写）⇒ 拒剥
	if (allEventIds.length > 0 && boundEventIds.length === 0) return null;

	// 正文 = 首行之后的非「附件块 / evt 标记」行
	const bodyLines: string[] = [];
	const attachmentPaths: string[] = [];
	let sawAttachmentBlock = false;
	// 附件块按**声明数量**收敛（L4 M2）：头里写 N 张，就只吃紧随其后的 N 条路径行；
	// 第 N+1 行起回到正文 —— 否则「附件块之后的正文若恰以 `1. ` 开头」会被当路径吞掉。
	let remainingPaths = 0;
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const stripped = line.replace(EVENT_MARKER_RE, "").trimEnd();
		const head = ATTACHMENT_HEAD_RE.exec(stripped) ?? ATTACHMENT_DEAD_RE.exec(stripped);
		if (head !== null) {
			sawAttachmentBlock = true;
			remainingPaths = Number.parseInt(head.groups?.n ?? "0", 10);
			if (!Number.isFinite(remainingPaths) || remainingPaths < 0) remainingPaths = 0;
			continue;
		}
		if (remainingPaths > 0) {
			const pm = ATTACHMENT_PATH_RE.exec(stripped);
			if (pm !== null && pm.groups?.path !== undefined) {
				attachmentPaths.push(pm.groups.path);
				remainingPaths -= 1;
				continue;
			}
			// 声明了但这条不是路径行 ⇒ 结构不符（宁可整体拒剥也不吞正文）
			return null;
		}
		bodyLines.push(stripped);
	}
	// 声明了 N 条却只收到 <N 条 ⇒ 结构不符 ⇒ 拒剥
	if (sawAttachmentBlock && remainingPaths > 0) return null;
	// 去掉尾部空行（注入模板在附件块/evt 之前会留一个空行）
	while (bodyLines.length > 0 && (bodyLines[bodyLines.length - 1] ?? "").trim() === "") bodyLines.pop();

	// 保守门：必须另有**绑定到本 outboxId 的** evt 标记 或 附件块；否则判为用户手写 ⇒ 不剥
	if (boundEventIds.length === 0 && !sawAttachmentBlock) return null;

	return {
		outboxId,
		...(source !== undefined ? { source } : {}),
		text: bodyLines.join("\n"),
		attachmentPaths,
		eventIds: boundEventIds,
	};
}

/**
 * `sha256("session.message:" + commandKey)` 的十六进制 —— 与
 * `extensions/runtime/message-outbox.ts::outboxItemId` 同口径（**双写**，见该文件注释：
 * 消费端在浏览器里跑，不能直接 import node:crypto 的同步接口之外的 node 模块）。
 *
 * 浏览器可用性：`crypto.subtle.digest` 是异步的 ⇒ 本函数用纯 JS SHA-256 实现（无依赖），
 * 保证在 Node 测试与浏览器里行为**逐字节一致**（同一输入的 hex 相同）。
 */
export function outboxIdForCommandKey(commandKey: string): string {
	return sha256Hex(`session.message:${commandKey}`);
}

/** 纯 JS SHA-256（FIPS 180-4）。返回 64 位小写 hex。 */
export function sha256Hex(input: string): string {
	const K = [
		0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
		0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
		0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
		0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
		0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
		0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
		0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
		0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
	];
	const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
	// UTF-8 编码（浏览器与 Node 一致）
	const bytes: number[] = [];
	for (const ch of input) {
		const cp = ch.codePointAt(0) ?? 0;
		if (cp < 0x80) bytes.push(cp);
		else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
		else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
		else
			bytes.push(
				0xf0 | (cp >> 18),
				0x80 | ((cp >> 12) & 0x3f),
				0x80 | ((cp >> 6) & 0x3f),
				0x80 | (cp & 0x3f),
			);
	}
	const bitLen = bytes.length * 8;
	bytes.push(0x80);
	while (bytes.length % 64 !== 56) bytes.push(0);
	// 64-bit big-endian 长度（高 32 位恒 0：正文远小于 512MiB）
	bytes.push(0, 0, 0, 0, (bitLen >>> 24) & 0xff, (bitLen >>> 16) & 0xff, (bitLen >>> 8) & 0xff, bitLen & 0xff);

	let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
	let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
	const w = new Array<number>(64);
	for (let off = 0; off < bytes.length; off += 64) {
		for (let i = 0; i < 16; i++) {
			const j = off + i * 4;
			w[i] = ((bytes[j]! << 24) | (bytes[j + 1]! << 16) | (bytes[j + 2]! << 8) | bytes[j + 3]!) >>> 0;
		}
		for (let i = 16; i < 64; i++) {
			const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
			const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
			w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
		}
		let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
		for (let i = 0; i < 64; i++) {
			const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
			const ch = (e & f) ^ (~e & g);
			const t1 = (h + S1 + ch + K[i]! + w[i]!) >>> 0;
			const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
			const maj = (a & b) ^ (a & c) ^ (b & c);
			const t2 = (S0 + maj) >>> 0;
			h = g; g = f; f = e;
			e = (d + t1) >>> 0;
			d = c; c = b; b = a;
			a = (t1 + t2) >>> 0;
		}
		h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
		h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
	}
	return [h0, h1, h2, h3, h4, h5, h6, h7].map((x) => x.toString(16).padStart(8, "0")).join("");
}

/**
 * 本地 outbox 回显是否应退场：transcript 里已经出现**同 outboxId** 的行 ⇒ 该条目不再需要本地回显。
 *
 * 为什么不按正文比：附件块让文本不等；同文本重复发送会误配。
 * 按 outboxId 配对是**确定性**的（见模块头 `outboxId = sha256(...)`）。
 *
 * ── 作用域不变量（L4 B 项，2026-10-19）─────────────────────────────
 * `outboxIdForCommandKey` **只对 Web GUI 的 session.message 成立**：
 *   - `gui/src/store.ts::sendChatMessage` 是 `chatOutbox` 的**唯一**写入点
 *     （全仓 grep：除它以外的 chatOutbox 引用都是 set/读，无第二处插入条目）
 *   - 它只调 `api.sessionMessage` ⇒ `type: "session.message"`
 *     （`gui/src/api/client.ts::sessionMessage`，payload 分形不影响 type）
 * 而**其他 outbox 生产者口径不同**，不得拿本函数去算：
 *   - 微信入站：`dedupeKey = \`wechat:${msgId}\``（`extensions/runtime-host/wechat-input.ts:84`）
 *   - delivery-reconciler：沿用既有 dedupeKey（`delivery-reconciler-loop.ts:239`）
 * 两者都不进 GUI 的 `chatOutbox`，所以在本函数的调用面上不可达。
 * 这仍是**依赖上游不变量**而非本地强制 —— 已在 L4 报告登记为已知结构风险。
 */
export function isEchoedInTranscript(
	commandKey: string,
	transcriptTexts: readonly string[],
): boolean {
	const want = outboxIdForCommandKey(commandKey);
	for (const t of transcriptTexts) {
		const parsed = parseOutboxEnvelope(t);
		if (parsed !== null && parsed.outboxId === want) return true;
	}
	return false;
}

/**
 * 批量版：一次性解析 transcript 建 Set，再对多个 commandKey 判等。
 *
 * 为何需要（L4 S3，2026-10-19）：
 * `ChatPage` 里是对每条 outbox 调一次 `isEchoedInTranscript` ⇒ 在 n 条 outbox × m 行 transcript
 * 上重复解析全文（每次分配行数组 + 多轮 regex）。长会话（实测 2–4k 行）+ 最多 20 条 outbox
 * 的上界约 40k 次全文解析，且 transcript 每次变化（首屏/增量/resync）都重算。
 * 本函数把「解析 transcript」压到 1 轮（O(m)），后面每个 key 只做一次 Set 查找（O(1)）。
 */
export function echoedOutboxIds(transcriptTexts: readonly string[]): Set<string> {
	const ids = new Set<string>();
	for (const t of transcriptTexts) {
		const parsed = parseOutboxEnvelope(t);
		if (parsed !== null) ids.add(parsed.outboxId);
	}
	return ids;
}
