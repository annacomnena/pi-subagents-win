/**
 * runtime/adapters/tab-run.ts — Legacy Tab 账本 → Runtime Event 适配器
 * （Phase 1F，设计稿 §10 / §44 Step 3；terra 裁决修订见各节）
 *
 * 职责：TabDispatchRecord / TabResult → RuntimeEnvelope 纯转换。
 *
 * 禁止（§10）：本文件不做任何 IO、不 import 任何 Pi API、不感知 journal 路径——
 * 转换产物由接线点（index.ts / event-bus.ts）经 emitRuntimeEvent 落盘。
 *
 * v1 冻结口径（terra 裁决 2026-09-17）：
 *   - at = 领域发生时间（dispatchedAt / finishedAt），recordedAt = 构造时刻；
 *     Timeline 与 projector 状态机以 at 为准，不依赖写入时间（裁决 #10 推翻原实现）。
 *   - executionKind 显式入 payload（"tab"），projector 不从 subject 推导（缺陷 3）。
 *   - dedupeKey = `<type>:<subject>`，语义去重键（缺陷 4）。
 *   - summary 上限 2048 UTF-8 字节；artifacts/openIssues 条数 ≤20、单项 512B（裁决 #6）。
 *   - finalText 严禁入 payload（§15）。
 */

import type { TabDispatchRecord, TabResult } from "../../tab-runs.ts";
import { newEventEnvelope, type RuntimeEnvelope } from "../envelope.ts";
import { masterAddress, tabRunAddress, type ObjectAddress } from "../address.ts";

// ── payload 预算（terra 裁决 #6）───────────────────────────────────

const SUMMARY_MAX_BYTES = 2048;
const LIST_MAX_ITEMS = 20;
const LIST_ITEM_MAX_BYTES = 512;

/** UTF-8 字节上限截断（多字节安全：从尾部逐码元收缩）。 */
function truncateUtf8(s: string, maxBytes: number): string {
	if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
	let out = s;
	while (out.length > 0 && Buffer.byteLength(out, "utf8") > maxBytes) {
		out = out.slice(0, -1);
	}
	return out;
}

function truncateList(items: string[] | undefined): string[] | undefined {
	if (!items) return undefined;
	return items.slice(0, LIST_MAX_ITEMS).map((x) => truncateUtf8(String(x), LIST_ITEM_MAX_BYTES));
}

// ── dispatch → run.dispatched | run.launch_failed ─────────────────

/** dispatch 账本记录 → run.dispatched | run.launch_failed（§12：failure 路径也要有终态事件）。 */
export function tabDispatchToRuntimeEvent(
	dispatch: TabDispatchRecord,
	source: ObjectAddress = masterAddress(),
): RuntimeEnvelope {
	const type = dispatch.dispatchStatus === "launch_failed" ? "run.launch_failed" : "run.dispatched";
	const subject = tabRunAddress(dispatch.id);
	return newEventEnvelope({
		type,
		source,
		subject,
		// at = 领域发生时间（裁决 #10）；recordedAt = 构造时刻
		at: dispatch.dispatchedAt,
		recordedAt: new Date().toISOString(),
		dedupeKey: `${type}:${subject}`,
		payload: {
			tabRunId: dispatch.id,
			executionKind: "tab" as const,
			externalTaskId: dispatch.taskId,
			mode: dispatch.mode,
			title: dispatch.title,
			cwd: dispatch.cwd,
			requestedModel: dispatch.requestedModel,
			dispatchedAt: dispatch.dispatchedAt,
			direct: dispatch.direct,
			error: dispatch.error,
		},
	});
}

// ── result → run.completed | run.failed | run.cancelled ───────────

/** tab 终态结果 → run.completed | run.failed | run.cancelled。不含 finalText（§15）。 */
export function tabResultToRuntimeEvent(
	result: TabResult,
	source: ObjectAddress = masterAddress(),
): RuntimeEnvelope {
	const subject = tabRunAddress(result.id);
	return newEventEnvelope({
		type: `run.${result.status}`,
		source,
		subject,
		// at = 领域发生时间：tab 自己声明的完成时刻，不受 watcher 延迟/claim/重启影响
		at: result.finishedAt,
		recordedAt: new Date().toISOString(),
		dedupeKey: `run.${result.status}:${subject}`,
		payload: {
			tabRunId: result.id,
			executionKind: "tab" as const,
			externalTaskId: result.taskId,
			status: result.status,
			summary: result.summary !== undefined ? truncateUtf8(result.summary, SUMMARY_MAX_BYTES) : undefined,
			artifacts: truncateList(result.artifacts),
			reportPath: result.reportPath,
			openIssues: truncateList(result.openIssues),
			usage: result.usage,
			finishedAt: result.finishedAt,
		},
	});
}
