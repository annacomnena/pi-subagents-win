/**
 * meta.json 路径（小工具，2026-11-02 抽出）。
 * launch-workers 里本来就有同名私有函数；这里导出给 lane-facts / supervisor 共用，
 * 避免三处各自 `join(runDir,"meta.json")` 漂移。
 */
import { join } from "node:path";

export function metaPath(runDir: string): string {
	return join(runDir, "meta.json");
}
