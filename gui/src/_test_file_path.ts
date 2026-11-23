/**
 * _test_file_path.ts — 2026-11-20 可点击路径的判据 + 接线（node 直载，不依赖 JSX 运行时）。
 *
 * 判据本体在 filePath.ts（纯函数）；.tsx 无法 node 直载，故接线用源码断言锁定
 * （同 _test_right_rail.ts 的范式）。变异接线（如删掉 ChatPage 的 onOpenPath）必须红。
 *
 * 运行：node --experimental-strip-types ./gui/src/_test_file_path.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { looksLikeFilePath } from "./filePath.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (rel: string): string => readFileSync(join(HERE, rel), "utf8");

let passed = 0;
const ok = (label: string): void => {
	passed += 1;
	console.log(`  ok  ${label}`);
};

// ── 判据：真路径 ──────────────────────────────────────────────
for (const p of [
	"plans/20261119_3583_com/report.md",
	"./report.md",
	"../plans/a/b.tsx",
	"C:\\Users\\me\\a.md",
	"F:/工作文档/会议材料/2026-11-09_文稿.md",
]) {
	assert.equal(looksLikeFilePath(p), true, `should detect: ${p}`);
}
ok("FP1 常见相对/绝对/中文路径均识别");

// ── 判据：反例（满屏假链接比没有链接更糟）────────────────────────
for (const p of [
	"net48",
	"$4",
	"Math.max",
	"http://example.com/a.md",
	"file:///C:/a.md",
	"a/b",
	".md",
	"foo/*.md",
	"a/b.md:12",
	"\\\\server\\share\\evil.bat", // UNC 触发 SMB 外联，后端同样拒绝
	"C:\\a.md:stream", // NTFS 备用数据流
	"",
]) {
	assert.equal(looksLikeFilePath(p), false, `should NOT detect: ${p}`);
}
ok("FP2 符号/URL/无扩展名/通配符不误判");

// ── 接线（源码断言）──────────────────────────────────────────
{
	const md = src("ui/Markdown.tsx");
	assert.match(md, /filePathInCode\(raw\)/);
	assert.match(md, /className="md-inline-code md-path-link"/);
	assert.match(md, /onClick=\{\(\) => openPath\?\.\(filePath\)\}/);
	assert.match(md, /export function Markdown\(\{ text, onOpenPath \}/);
	ok("FP3 Markdown 把识别出的路径渲染为可点按钮");
}
{
	const chat = src("pages/ChatPage.tsx");
	assert.match(chat, /<Markdown text=\{row\.text\} onOpenPath=\{openDocPreview\} \/>/);
	assert.equal((chat.match(/onOpenPath=\{openDocPreview\}/g) ?? []).length, 2, "正文 + 思考过程两处都要可点");
	ok("FP4 助手正文与思考过程都传了 onOpenPath（变异该行必须红）");
}
{
	const store = src("store.ts");
	assert.match(store, /railPanel: PANEL_DOC/);
	assert.match(store, /railOpen: true/);
	assert.match(store, /docPreviewPath: path/);
	ok("FP5 点路径 ⇒ 切到文档预览面板并展开右栏");
}
{
	const panels = src("rightRail/panels.ts");
	assert.match(panels, /PANEL_DOC/);
	assert.match(panels, /DocPreviewPanel/);
	const panel = src("rightRail/DocPreviewPanel.tsx");
	assert.match(panel, /api\.fileRead\(path, cwd\)/);
	assert.match(panel, /api\.fileOpen\(target, cwd\)/);
	assert.match(panel, /api\.fileReveal\(target, cwd\)/);
	assert.match(panel, /默认应用打开/);
	assert.match(panel, /打开文件夹/);
	assert.match(panel, /reqIdRef\.current !== id/); // 迟到响应丢弃
	assert.match(panel, /openDocPreview\(p, dirOf\(data\.path\)\)/); // 预览内相对路径以当前文件目录为基准
	ok("FP6 面板注册 + 两个按钮 + 请求序号防串台");
}
{
	const client = src("api/client.ts");
	assert.match(client, /postJson<FilePreviewResult>\("\/v1\/files\/read", \{ path, cwd: cwd \?\? null \}\)/);
	assert.match(client, /postJson<FileActionResult>\("\/v1\/files\/open", \{ path, cwd: cwd \?\? null \}\)/);
	assert.match(client, /postJson<FileActionResult>\("\/v1\/files\/reveal", \{ path, cwd: cwd \?\? null \}\)/);
	ok("FP7 三个端点字符串与 cwd 透传（变异端点名必须红）");
}
{
	const md = src("ui/Markdown.tsx");
	assert.match(md, /\{renderInline\(link\.text, key\)\}/); // <a> 内不产 button
	const panel = src("rightRail/DocPreviewPanel.tsx");
	assert.ok(panel.includes("return /^[A-Za-z]:$/.test(head) ? p.slice(0, i + 1) : head;"), "盘符根 dirOf 修复");
	ok("FP8 链接内不嵌套按钮 + 盘符根相对路径基准正确");
}
{
	const panel = src("rightRail/DocPreviewPanel.tsx");
	// N-4：读取失败态不能复制相对路径（粘到资源管理器找不到）⇒ 复制按钮禁用 + copyPath 只认 data.path
	assert.match(panel, /const full = data\?\.path;/);
	assert.match(panel, /disabled=\{data === null\}/);
	ok("FP9 失败态复制绝对路径按钮禁用（变异必须红）");
}

console.log(`\nFILE_PATH_OK passed=${passed}`);
