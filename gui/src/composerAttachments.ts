/**
 * composerAttachments.ts — 输入框图片附件（纯逻辑，Node 可测；ChatPage 只做渲染与调用）。
 *
 * 口径（2026-10-16 用户要求 + 拍板）：
 *   - **只在输入框内粘贴（Ctrl+V）/拖拽/选择图片**，显示缩略图，可逐张删除；
 *   - 图片**只落盘**（`POST /v1/uploads`），消息里只带 uploadId，服务端落 outbox 时转成**路径**；
 *     会话 JSONL 里**不出现 base64**（用户口径：「只走附件 + 路径，别放进 jsonl」）；
 *   - 上限与服务端同源：≤4 张、单张 ≤5MiB（超限**明确拒绝并给理由**，不静默丢弃、不自动压缩）。
 *
 * 纯函数约定：不碰 DOM、不碰 fetch；由调用方把 File/DataTransfer 之类的形状喂进来。
 */

/** 与服务端 `UPLOAD_MAX_PER_MESSAGE` / `UPLOAD_MAX_BYTES` 同源（改这里要同步后端）。 */
export const MAX_ATTACHMENTS = 4;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/** 只白名单位图（与服务端魔数白名单对齐；svg 明确排除——可执行脚本面）。 */
export const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

export interface FileLike {
	name: string;
	type: string;
	size: number;
}

export type RejectReason = "not-image" | "too-large" | "too-many";

export interface AttachmentItem {
	/** 本地预览 URL（URL.createObjectURL）；调用方负责 revoke。 */
	previewUrl: string;
	name: string;
	bytes: number;
	/** 上传成功后的服务端 id；null = 还没传完（发送前必须全部就绪）。 */
	uploadId: string | null;
}

/** 文件名兜底显示（无扩展名的粘贴图 → 用类型给个可读名）。 */
export function displayName(f: FileLike, index: number): string {
	return f.name.trim().length > 0 ? f.name : `粘贴的图片 ${index + 1}`;
}

export function isAcceptedImage(f: FileLike): boolean {
	return (ACCEPTED_IMAGE_TYPES as readonly string[]).includes(f.type);
}

/** 人类可读大小（缩略图脚注用）。 */
export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 从一批候选中挑出可接收的（按现有数量算配额），其余给出**逐条理由**。
 * 顺序语义：先到先得——超配额的在后面被拒（不给「随机丢哪张」的隐性行为）。
 */
export function pickAttachments(
	current: AttachmentItem[],
	candidates: FileLike[],
): { accept: { file: FileLike; name: string }[]; rejected: { name: string; reason: RejectReason }[] } {
	const accept: { file: FileLike; name: string }[] = [];
	const rejected: { name: string; reason: RejectReason }[] = [];
	let count = current.length;
	candidates.forEach((f, i) => {
		const name = displayName(f, i);
		if (!isAcceptedImage(f)) {
			rejected.push({ name, reason: "not-image" });
			return;
		}
		if (f.size > MAX_ATTACHMENT_BYTES) {
			rejected.push({ name, reason: "too-large" });
			return;
		}
		if (count >= MAX_ATTACHMENTS) {
			rejected.push({ name, reason: "too-many" });
			return;
		}
		count += 1;
		accept.push({ file: f, name });
	});
	return { accept, rejected };
}

/** 拒绝理由 → 面向用户的中文提示（避免「什么都没发生」）。 */
export function rejectHint(r: { name: string; reason: RejectReason }): string {
	switch (r.reason) {
		case "not-image":
			return `${r.name}：只支持 png / jpeg / webp / gif 图片`;
		case "too-large":
			return `${r.name}：超过 ${formatBytes(MAX_ATTACHMENT_BYTES)}，请压缩后再发`;
		case "too-many":
			return `${r.name}：一条消息最多 ${MAX_ATTACHMENTS} 张`;
	}
}

/** 从粘贴/拖拽事件里取候选文件形状（无 files 的纯文本粘贴 → 空数组 = 走默认粘贴）。 */
export type FileListLike = ArrayLike<FileLike> | null | undefined;
export function candidatesFrom(files: FileListLike): FileLike[] {
	return files === null || files === undefined ? [] : Array.from(files);
}

/** 发送闸门：有文字或有（已上传完成的）附件即可发；附件未传完 ⇒ 不可发。 */
export function canSendMessage(text: string, attachments: AttachmentItem[]): boolean {
	if (attachments.some((a) => a.uploadId === null)) return false;
	return text.trim().length > 0 || attachments.length > 0;
}

/** 发送用 uploadId 列表（顺序稳定；未上传完成的项被过滤——发送闸门已挡）。 */
export function attachmentIds(attachments: AttachmentItem[]): string[] {
	return attachments.map((a) => a.uploadId).filter((id): id is string => id !== null);
}

// ── 粘贴入口（对齐 ZCode v4 composer 的三条口径）────────────────────
//
// ZCode 依据（实测 file:line，勿凭印象）：
//   - `ui/src/v4/composer/useComposerAttachments.ts:738-774` —— files 优先 + Excel 文本优先
//   - `ui/src/lib/chatAttachmentMetadata.ts:1-11` —— 表格证据判据
//
// 我们此前的缺陷（2026-10-19 实测）：只读 `clipboardData.files`，而部分来源
// （微信/QQ 截图、跨应用复制图片）只把图放在 `clipboardData.items` 里 ⇒ files 为空
// ⇒ 不 preventDefault、不接收、**也不提示** = 完全静默（AGENTS R-2 同形状）。

/** 输入框正文上限（与服务端 `session.message` 的 8000 一致；超限必须显式提示，不静默截断）。 */
export const DRAFT_MAX_CHARS = 8000;

/** `DataTransferItem` 的最小可用形状（只取我们需要的两个成员，便于 Node 侧造假对象测试）。 */
export interface ClipboardItemLike {
	kind: string;
	getAsFile(): FileLike | null;
}

/** `ClipboardData` 的最小可用形状（同上：不依赖 DOM 类型，纯函数可测）。 */
export interface ClipboardLike {
	files?: ArrayLike<FileLike> | null;
	items?: ArrayLike<ClipboardItemLike> | null;
	getData(type: string): string;
}

/**
 * Excel/表格剪贴板判据（照抄 ZCode `chatAttachmentMetadata.ts:1-11` 的口径）。
 *
 * 为什么需要：Excel 复制一个选区时会**同时**写入 plain text、HTML 和一张合成 PNG。
 * 若只看到“有图”就吃掉粘贴，用户拿到的是表格截图而不是可编辑数据。
 * 判据：文本含 Tab（多列复制）或 HTML 含 Excel 标记（单列/单格复制）。
 */
const SPREADSHEET_CLIPBOARD_HTML_PATTERN =
	/(?:<table\b|urn:schemas-microsoft-com:office:excel|\bExcel\.Sheet\b|\bMicrosoft\s+Excel\b|\bmso-(?:number-format|displayed-decimal-separator)\b)/iu;

export function isSpreadsheetClipboard(text: string, html: string): boolean {
	if (text.length === 0) return false;
	return text.includes("\t") || SPREADSHEET_CLIPBOARD_HTML_PATTERN.test(html);
}

export type PasteReason = "files" | "items" | "spreadsheet-text" | "none";

export interface PastePlan {
	/** 要作为附件接收的图片（顺序：files 优先，其次 items）。 */
	files: FileLike[];
	/** true ⇒ **不要** preventDefault，让浏览器走默认文本粘贴（表格文本获胜）。 */
	preferText: boolean;
	reason: PasteReason;
}

/**
 * 粘贴决策（纯函数）：给定剪贴板形状，决定「收图 / 让位文本 / 什么都不做」。
 *
 * 优先级（与 ZCode 一致）：
 *   1. 有文件 + 有表格证据 ⇒ preferText（表格文本获胜）
 *   2. 有文件（files 或 items 任一）⇒ 收图
 *   3. 无图 ⇒ none（调用方不应 preventDefault）
 *
 * **files 与 items 的并集**：两者在真实浏览器里可能互补（部分平台只填 items）。
 * 去重按「name+size+type」三元组，避免同一张图被两条通道各收一次。
 */
export function pickPastePlan(cb: ClipboardLike): PastePlan {
	const files = candidatesFrom(cb.files ?? null);
	//
	// ── 两个通道**不得并集取值**（2026-10-19 用户真机实测：必出两张重复图）──
	//
	// 实测证据：`runtime/uploads/` 落下 `up_TjUuHFoNllj4.png` 与 `up_FYVghXZgGjZa.png`，
	// 字节数都是 93,609，sha256 前缀都是 `94e7ea95…`——同一张图被上传了两次。
	// 原因：`clipboardData.files` 与 `items[i].getAsFile()` 在 Chromium 上返回**内容相同但
	// 对象不同**的 File；而对象身份去重（WeakSet）只能去掉「同一个对象」，拦不住这种重复。
	//
	// 这个取舍与 L4 M1 并不矛盾：M1 禁止的是「用元数据判内容身份」⇒ 会误删**不同的**图。
	// 正确做法是**不做合并**：两个通道本就能单独覆盖全部场景（下表的实测依据来自 ZCode
	// `useComposerAttachments.ts:740` 只读 files、ai-elements `prompt-input-textarea.tsx:78` 只读 items），
	// 于是「主通道有就用主通道，主通道空才回退」天然不会重复，也不需要任何去重。
	//
	//   场景                        files      items
	//   Windows Chrome 粘贴截图     有         有（同一图、不同对象）
	//   微信/QQ 复制图片            常为空     有
	//   仅文件选择 / 拖放            有         有
	//
	// 例：files 非空 ⇒ **只看 files**，完全不读 items（重复的根源就在这里）。
	const fromItems: FileLike[] = [];
	if (files.length === 0) {
		const items = cb.items ?? null;
		if (items !== null) {
			for (const it of Array.from(items)) {
				if (!it || it.kind !== "file") continue;
				let f: FileLike | null = null;
				try {
					f = it.getAsFile();
				} catch {
					f = null; // 单条取文件失败不放弃整批
				}
				if (f !== null) fromItems.push(f);
			}
		}
	}
	const merged = files.length > 0 ? files : fromItems;
	if (merged.length === 0) return { files: [], preferText: false, reason: "none" };
	const text = safeGetData(cb, "text/plain");
	const html = safeGetData(cb, "text/html");
	if (isSpreadsheetClipboard(text, html)) {
		// 表格文本获胜：**不接收**这批图，让浏览器把文本贴进输入框。
		return { files: [], preferText: true, reason: "spreadsheet-text" };
	}
	return { files: merged, preferText: false, reason: files.length > 0 ? "files" : "items" };
}

/** `getData` 在部分环境（合成事件/测试桩）会抛；读取失败一律当空串（只影响表格判定）。 */
function safeGetData(cb: ClipboardLike, type: string): string {
	try {
		return cb.getData(type) ?? "";
	} catch {
		return "";
	}
}

/** 超长粘贴的插入结果（可直接喂 setDraft）。 */
export interface OversizePasteResult {
	/** 新正文（已按剩余容量截断）。 */
	next: string;
	/** 丢弃的字符数（0 = 未截断）。 */
	dropped: number;
	/** 給用户的提示；未超限为 null。 */
	notice: string | null;
}

/**
 * 超长粘贴接管（L4 M2，2026-10-19）：按选区替换语义插入，只在容量内保留。
 *
 * 为什么必须接管而不是交给 `maxLength`：浏览器端 maxLength 只会在提交前默默截断，
 * 用户看不到丢了多少；attachHint 也必须与实际发生的丢失联动，否则就是「假提示」。
 *
 * 行为与浏览器默认粘贴对齐：先删选区，再从 start 处插入。
 */
export function applyOversizePaste(
	draft: string,
	start: number,
	end: number,
	pastedText: string,
	max = DRAFT_MAX_CHARS,
): OversizePasteResult {
	const s = Math.min(Math.max(0, start), draft.length);
	const e = Math.min(Math.max(s, end), draft.length);
	const base = draft.slice(0, s) + draft.slice(e);
	const capacity = Math.max(0, max - base.length);
	const kept = pastedText.slice(0, capacity);
	const dropped = pastedText.length - kept.length;
	if (dropped <= 0) {
		// 未超限：保持浏览器默认行为（返回原样，调用方不应 preventDefault）
		return { next: draft, dropped: 0, notice: null };
	}
	return {
		next: base.slice(0, s) + kept + base.slice(s),
		dropped,
		notice: `粘贴内容过长：输入框上限 ${max} 字符，仅保留前 ${kept.length} 个（本次丢弃 ${dropped} 个）。建议改成分段粘贴或作为文件附上。`,
	};
}
