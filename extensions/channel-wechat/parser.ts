/**
 * channel-wechat/parser.ts — 入站批次纯函数解析（W1：私聊**文本**抽取 + 非文本 quarantine）
 *
 * 规格：plans/0924_wechat_receive_w1_spec.md §2/§4。输入 = client.getUpdates 返回的原始
 * item_list（未知形状，真网未测——保守解析）：
 *   条目形状（指南 §3）：{"id":"msg_001","msg":{"from":{"id","nickname"},"context_token":"...","item_list":[...]}}
 *
 * 纪律（§4.1/§4.6）：
 *   - context_token 是秘密：parser **彻底丢弃**，不进任何输出/日志/记录（W3 若需回复另建凭据面）。
 *   - 非文本/未知类型 → quarantine（脱敏 reason：只记类型名/结构原因，无正文、无 URL、无 token）；
 *     附件只记元数据标记 artifact_pending，不下载（W1 明确不做）。
 *   - 长度上限 + Unicode 控制符剥离（Cc 除 \t\n\r）；**不解析 HTML**。
 *   - 缺 msgId → quarantine（msgId=null），禁止伪造 id。
 *
 * 纯函数：无 IO、无时钟依赖（receivedAt 由调用方/now 注入）。零 import。
 */

/** 单条文本长度上限（字符；超长截断并标注——W1 不落大正文）。 */
export const INBOUND_TEXT_MAX_CHARS = 4000;

export interface InboundText {
	msgId: string;
	/** 发送者 from.id（原值进私有 inbox；GUI/端点层再做前缀脱敏）。 */
	fromId: string;
	fromNickname: string | null;
	/** 清洗后文本（控制符剥离 + 截断标注）。 */
	text: string;
	/** 接收时刻（ISO；worker 注入）。 */
	receivedAt: string;
}

export interface QuarantineEntry {
	/** 缺 id 条目 → null（调用方仍计数 + 落盘 reason，不伪造 id）。 */
	msgId: string | null;
	/** 脱敏原因（类型名/结构原因；无正文、无 URL、无 token）。 */
	reason: string;
	at: string;
	/** 附件类非文本（元数据待处理，不下载）。 */
	artifactPending?: boolean;
}

export interface ParseBatchResult {
	items: InboundText[];
	quarantined: QuarantineEntry[];
}

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, max: number): string | null {
	if (typeof v !== "string" || v.length === 0) return null;
	return v.length > max ? v.slice(0, max) : v;
}

/**
 * 脱敏形状签名（真网适配用）：只输出**键名 + 类型**，**绝不输出任何值**（正文/token/URL 均不入）。
 * 真机 `msgs[]` 条目形状未知（指南不可信）——未知结构 quarantine 时附上签名，便于一次性对齐真字段。
 */
function shapeSig(v: unknown, maxKeys = 24): string {
	if (!isObj(v)) return Array.isArray(v) ? `array(${v.length})` : typeof v;
	const parts: string[] = [];
	for (const k of Object.keys(v).slice(0, maxKeys)) {
		const val = (v as Record<string, unknown>)[k];
		const t = val === null ? "null" : Array.isArray(val) ? `array(${val.length})` : typeof val;
		parts.push(`${k.slice(0, 24)}:${t}`);
	}
	return `{${parts.join(",")}}`;
}

/** 宽容取 msgId（**真机实测 2026-09-24**：`msgs[]` 条目为 `{seq, message_id:number, from_user_id, ...}`）。
 *  接受数字 `message_id`（转字符串，id 远小于 2^53 无精度风险）、`id`/`msgId`/`msg_id`、`msg.*` 同名字段。
 *  缺 id 时**不伪造**（`seq` 不回退为 id：seq 可能重置，会与去重语义冲突）→ 调用方 quarantine。 */
function pickMsgId(entry: Record<string, unknown>): string | null {
	const m = isObj(entry.msg) ? entry.msg : null;
	for (const src of m ? [entry, m] : [entry]) {
		for (const cand of [src.message_id, src.id, src.msgId, src.msg_id]) {
			if (typeof cand === "string" && cand.length > 0) return cand;
			if (typeof cand === "number" && Number.isFinite(cand)) return String(cand);
		}
	}
	return null;
}

/** 剥离 Unicode 控制符（Cc，除 \t\n\r——保留换行语义）+ 截断标注。 */
export function sanitizeInboundText(raw: string): string {
	// eslint-disable-next-line no-control-regex
	let s = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0080-\u009F]/g, "");
	if (s.length > INBOUND_TEXT_MAX_CHARS) {
		s = `${s.slice(0, INBOUND_TEXT_MAX_CHARS)}…[截断@${INBOUND_TEXT_MAX_CHARS}字符]`;
	}
	return s;
}

/** 非文本类型名集合（小写比对；新类型未知 → 一律 quarantine，不猜）。 */
const NON_TEXT_TYPES = new Set([
	"image", "photo", "picture", "file", "attachment", "voice", "audio", "video", "emoji", "sticker",
	"location", "link", "url", "card", "mini_program", "appmsg", "system", "event", "recall", "revoked",
]);

/**
 * 解析一批原始 item_list：文本 → items；非文本/未知/坏结构 → quarantined（脱敏）。
 * 单条坏**条目**不拖垮整批（逐条独立 try 面）；无 msgId 或 msg 无 item_list → quarantine。
 */
export function parseBatch(rawItems: unknown[], receivedAt: string): ParseBatchResult {
	const items: InboundText[] = [];
	const quarantined: QuarantineEntry[] = [];
	/** L4 MF1：批内已见 msgId——重复必须 quarantine（fail-visible），不得让 worker 静默去重吞消息。 */
	const seenMsgIds = new Set<string>();
	for (const entry of rawItems) {
		if (!isObj(entry)) {
			quarantined.push({ msgId: null, reason: "条目不是对象", at: receivedAt });
			continue;
		}
		const msgId = pickMsgId(entry);
		if (msgId === null) {
			quarantined.push({ msgId: null, reason: `缺消息 id（不伪造 id，不推进重复处理）；shape=${shapeSig(entry)}`, at: receivedAt });
			continue;
		}
		// L4 MF3：msgId 未设界会造成记录膨胀（实测 2MB id → 2MB dedupe 行 + 等大 inbox）。与 from.id 同口径限长。
		if (msgId.length > 128) {
			quarantined.push({ msgId: null, reason: `msgId 超长（len=${msgId.length} > 128）；不记原值；shape=${shapeSig(entry)}`, at: receivedAt });
			continue;
		}
		// L4 MF1：批内 msgId 重复必须 fail-visible（否则第二条被 worker 去重静默吞掉、无痕迹）。
		if (seenMsgIds.has(msgId)) {
			quarantined.push({ msgId, reason: `批内 msgId 重复（entry.id 疑非消息级唯一）；shape=${shapeSig(entry)}`, at: receivedAt });
			continue;
		}
		seenMsgIds.add(msgId);
		// 真机条目可能**没有** msg 包装（指南写有）——无包装时把条目自身当消息，宽容处理。
		const hasWrapper = isObj(entry.msg);
		const msg = hasWrapper ? (entry.msg as Record<string, unknown>) : entry;
		// D15「仅私聊」：真机有 `group_id`（群消息非空）——群消息直接 quarantine（不入 inbox）。
		const groupId = str(entry.group_id, 128) ?? str(msg.group_id, 128);
		if (groupId !== null) {
			quarantined.push({ msgId, reason: `群消息（group_id 非空）：D15 仅私聊，拒收；shape=${shapeSig(entry)}`, at: receivedAt });
			continue;
		}
		const from = isObj(msg.from) ? msg.from : {};
		// 发送者：真机 = `from_user_id`（顶层）；兼容 from.id/openid/user_id。
		const fromId =
			str(from.id, 128) ??
			str(from.openid, 128) ??
			str(from.user_id, 128) ??
			str(entry.from_user_id, 128) ??
			str(msg.from_user_id, 128);
		const fromNickname = str(from.nickname, 128) ?? str(from.nick_name, 128);
		if (fromId === null) {
			quarantined.push({ msgId, reason: `缺发送者 from.id；shape=${shapeSig(entry)}`, at: receivedAt });
			continue;
		}
		// 内容项：真机未测；接受 item_list / items / content_list。
		const inner = Array.isArray(msg.item_list)
			? msg.item_list
			: Array.isArray(msg.items)
				? msg.items
				: Array.isArray(msg.content_list)
					? msg.content_list
					: [];
		if (inner.length === 0) {
			quarantined.push({ msgId, reason: `无内容项（item_list/items/content_list 均无）；shape=${shapeSig(entry)}`, at: receivedAt });
			continue;
		}
		// 内层内容项：取**第一条可识别文本**（v1：一条消息一条文本；多内容项其余 quarantine 记录）
		let textTaken = false;
		for (const c of inner) {
			if (!isObj(c)) {
				quarantined.push({ msgId, reason: "内容项不是对象", at: receivedAt });
				continue;
			}
			const typeRaw = typeof c.type === "string" ? c.type : typeof c.content_type === "string" ? c.content_type : typeof c.type === "number" ? String(c.type) : "";
			const type = typeRaw.trim().toLowerCase();
			const textItem = isObj(c.text_item) ? c.text_item : null;
			// 文本位置：真机 = `item_list[].text_item.text`（对象）；兼容 c.text / c.content。
			const textLike = typeof c.text === "string" ? c.text : textItem && typeof textItem.text === "string" ? textItem.text : null;
			const contentLike = typeof c.content === "string" ? c.content : null;
			// L4 MF2：**无 msg 包装**（真机未知路径）时收紧——只认 `text` 字段或 text_item，或显式文本类 type；
			// 否则未分类的 `content` 字符串会把控制帧/回执（如 {content:"delivered ok"}）误落 inbox。
			// 指南形状（有 msg 包装）保持原行为，零回归。
			const body = hasWrapper
				? (textLike ?? contentLike)
				: (textLike ?? (type === "text" || type === "msg_text" || typeRaw === "1" ? contentLike : null));
			if (body !== null && body.length > 0 && !NON_TEXT_TYPES.has(type)) {
				if (!textTaken) {
					items.push({ msgId, fromId, fromNickname, text: sanitizeInboundText(body), receivedAt });
					textTaken = true;
				} else {
					quarantined.push({ msgId, reason: "多余内容项（v1 单条文本）", at: receivedAt });
				}
				continue;
			}
			// 非文本（有类型名）→ quarantine + artifact_pending 标记（元数据：类型名 + 可选 size 数字；无 URL/正文）
			if (type !== "") {
				const size = typeof c.size === "number" && Number.isFinite(c.size) ? c.size : undefined;
				quarantined.push({
					msgId,
					reason: `非文本消息（type=${type.slice(0, 40)}${size !== undefined ? ` size=${size}` : ""}；W1 不下载附件）`,
					at: receivedAt,
					artifactPending: true,
				});
				continue;
			}
			quarantined.push({ msgId, reason: `未知消息结构（无文本字段、无类型名）；shape=${shapeSig(c)}`, at: receivedAt });
		}
	}
	return { items, quarantined };
}
