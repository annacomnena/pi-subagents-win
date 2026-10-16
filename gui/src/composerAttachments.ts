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
