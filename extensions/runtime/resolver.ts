/**
 * runtime/resolver.ts — Logical Recipient 解析（Phase 4a，附记 A4 F1）
 *
 * resolveRecipient(logical) → {sessionId, generation} | null（原子快照）。
 *
 * 规则（terra 仲裁冻结）：
 *   - 返回快照含 generation（消费端 claim 时凭此做 fencing 判定）；
 *   - registry 激活后不得回退"当前主会话"（防无关 main session 越权接收）；
 *   - links.jsonl 仅作 registry 未启用前的迁移回退——v1 未实现（legacy 路径
 *     在 4d 切换前保持原行为，不需要 resolver 兜底），此处显式返回 null 并记录。
 *
 * 纯库、无接线。
 */

import { isObjectAddress, parseObjectAddress, type ObjectAddress } from "./address.ts";
import { readAttachment } from "./registry.ts";

export interface RecipientSnapshot {
	sessionId: string;
	generation: number;
}

/**
 * 解析 logical recipient 到当前物理承载快照。
 * v1 只支持 agent://（master）；其它 scheme 返回 null（Workstream 等 Phase 5）。
 * 无 attachment → null（未 attach：legacy 行为保持，调用方不得自行回退）。
 */
export function resolveRecipient(logical: ObjectAddress): RecipientSnapshot | null {
	if (!isObjectAddress(logical)) return null;
	const parsed = parseObjectAddress(logical);
	if (!parsed || parsed.scheme !== "agent") return null;
	const attachment = readAttachment(logical);
	if (!attachment) return null;
	return { sessionId: attachment.sessionId, generation: attachment.generation };
}
