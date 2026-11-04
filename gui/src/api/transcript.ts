/**
 * gui/src/api/transcript.ts — 兼容重导出（2026-11-04 P1）
 *
 * 实现已合并到 **唯一来源** `shared/transcript/model.ts`：行模型、5 操作封闭集、
 * `TranscriptView`、`applyTranscriptOp(s)` 全在那里，runtime 侧
 * `extensions/runtime/transcript.ts` 也从同一文件重导出。
 *
 * 保留本路径的原因：`gui/src/store.ts`（`applyChatFrame` 的 transcript 分支）与
 * `_test_*` 都按 `./api/transcript` 导入，重导出可让 P1 只动实现、不动调用方；
 * 等 P2/P4 统一契约后再决定是否删除本门面。
 *
 * 纪律：本文件只允许出现重导出，不得再落任何实现——否则重复又会从门面长回来。
 */

export {
	EMPTY_TRANSCRIPT_VIEW,
	applyTranscriptOp,
	applyTranscriptOps,
} from "../../../shared/transcript/model.ts";

export type { TranscriptOp, TranscriptRow, TranscriptView } from "../../../shared/transcript/model.ts";
