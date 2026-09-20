/**
 * greencad 试点条目（v2 §11 第 5 步）：经真实引用验证 + CodeGraph 符号验证后写入。
 * 事实来源：2026-09-15 会话实测（codegraph query 确认两个符号位置；
 * Wiki 章节标题来自 mesh_push_ue.md grep）。运行：node extensions/hotspot/_seed_greencad.ts
 */

import { commitHotspot, findRepoRoot, hotspotPath, readHotspot } from "./store.ts";
import { sameRoutingContent, validateEntryShape, verifyReferences } from "./validate.ts";
import { SCHEMA_VERSION, nowIso, type HotspotEntry } from "./types.ts";

const ROOT = "G:/code/greencad";

const entry: HotspotEntry = {
	topicId: "mesh-push",
	title: "mesh 推送",
	scope: "CAD→UE 网格推送链路定位",
	wiki: [{ path: "Wiki/Modules/mesh_push_ue.md", section: "推送管线（单 job/请求）" }],
	symbols: [
		{ path: "GreenCAD.AutoCAD/Services/MeshPushCoordinator.cs", name: "MeshPushCoordinator" },
		{ path: "GreenCAD.AutoCAD/Services/IMeshPushCoordinator.cs", name: "IMeshPushCoordinator" },
	],
	evidence: [],
	updatedAt: nowIso(),
	verifiedAt: nowIso(),
};

const root = findRepoRoot(ROOT);
console.log(`repo root: ${root}`);
console.log(`hotspot: ${hotspotPath(root)}`);

const shape = validateEntryShape(entry, root);
if (shape.length) {
	console.error("结构校验失败:", shape);
	process.exit(1);
}
console.log("结构校验: 通过（含仓库边界）");

const validation = verifyReferences(entry, root);
console.log(`引用验证: ${validation.problems.length === 0 ? "通过" : "失败"}`);
console.log(`  CodeGraph 尝试: ${validation.codegraphAttempted}；符号验证: ${validation.symbolVerified}`);
for (const n of validation.notes) console.log(`  note: ${n}`);
for (const p of validation.problems) console.error(`  problem: [${p.field}] ${p.message}`);
if (validation.problems.length || !validation.symbolVerified) {
	console.error("验证未全部通过，不写入（不猜测补全）");
	process.exit(1);
}

const read = readHotspot(hotspotPath(root));
if (read.exists && read.parseError) {
	console.error(`已有热点文件无法解析（保留内容，停止写入）: ${read.parseError}`);
	process.exit(1);
}
const existing = read.exists && read.file ? read.file.revision : 0;
const prior = read.exists && read.file ? read.file.entries.find((e) => e.topicId === "mesh-push") : undefined;
if (prior && sameRoutingContent(prior, entry)) {
	console.log(`mesh-push 路由内容未变，跳过（revision 保持 ${existing}）`);
	process.exit(0);
}

const result = await commitHotspot(hotspotPath(root), {
	expectedRevision: existing,
	expectedFingerprint: read.fingerprint,
	mutate: (latest) => ({
		next: {
			schemaVersion: SCHEMA_VERSION,
			revision: latest?.revision ?? 0,
			entries: latest ? [...latest.entries.filter((e) => e.topicId !== "mesh-push"), entry] : [entry],
		},
	}),
});
if (!result.ok) {
	console.error(`写入失败 (${result.kind}): ${result.message}`);
	process.exit(1);
}
console.log(`已写入 mesh-push，revision ${result.revision}（${hotspotPath(root)}）`);
