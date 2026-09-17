/**
 * runtime/adapters/tab-run.ts — Legacy Tab 账本 → Runtime Event 适配器
 * （Phase 1F，设计稿 §10 / §44 Step 3）
 *
 * 职责：TabDispatchRecord / TabResult → RuntimeEnvelope 纯转换。
 *
 * 禁止（§10）：本文件不做任何 IO、不 import 任何 Pi API、不感知 journal 路径——
 * 转换产物由接线点（index.ts / event-bus.ts，Commit 3/4）经 emitRuntimeEvent 落盘。
 *
 * payload 纪律（§15）：轻量摘要字段直接进 payload；full finalText / 大报告
 * 一律不进 journal（result 里已有，journal 只做投影）。
 */

import type { TabDispatchRecord, TabResult } from "../../tab-runs.ts";
import { newEventEnvelope, type RuntimeEnvelope } from "../envelope.ts";
import { masterAddress, tabRunAddress, type ObjectAddress } from "../address.ts";

/** dispatch 账本记录 → run.dispatched | run.launch_failed（§12：failure 路径也要有终态事件）。 */
export function tabDispatchToRuntimeEvent(
	dispatch: TabDispatchRecord,
	source: ObjectAddress = masterAddress(),
): RuntimeEnvelope {
	const type = dispatch.dispatchStatus === "launch_failed" ? "run.launch_failed" : "run.dispatched";
	return newEventEnvelope({
		type,
		source,
		subject: tabRunAddress(dispatch.id),
		payload: {
			tabRunId: dispatch.id,
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

/** tab 终态结果 → run.completed | run.failed | run.cancelled。不含 finalText（§15）。 */
export function tabResultToRuntimeEvent(
	result: TabResult,
	source: ObjectAddress = masterAddress(),
): RuntimeEnvelope {
	return newEventEnvelope({
		type: `run.${result.status}`,
		source,
		subject: tabRunAddress(result.id),
		payload: {
			tabRunId: result.id,
			externalTaskId: result.taskId,
			status: result.status,
			summary: result.summary,
			artifacts: result.artifacts,
			reportPath: result.reportPath,
			openIssues: result.openIssues,
			usage: result.usage,
			finishedAt: result.finishedAt,
		},
	});
}
