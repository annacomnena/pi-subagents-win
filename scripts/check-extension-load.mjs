/**
 * check-extension-load.mjs — 扩展加载冒烟检查：用与 pi 完全相同的 jiti 加载管线
 * 加载 extensions/index.ts，在提交前捕获「模板字符串语法错误导致扩展加载失败」这类
 * 整图解析/加载错误。
 *
 * 做法：定位 pi 安装树里的 jiti（先仓库内 junction，再全局回退），
 * createJiti(import.meta.url, { moduleCache: false }) + jiti.import(index.ts, { default: true })，
 * 断言 default 导出是 function（与 pi 的 loadExtensionModule 行为一致）。
 *
 * 用法：
 *   node ./scripts/check-extension-load.mjs
 * 退出码 0 = 扩展可加载；1 = 加载失败或 default 导出不是 function。
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 仓库根 = 本脚本所在目录的上一级（不依赖 cwd）
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const indexTsPath = join(repoRoot, "extensions", "index.ts");

// pi 安装树里的 jiti 候选位置（目录）：仓库内 junction 优先，全局安装树回退
const JITI_CANDIDATES = [
  join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "jiti"),
  join("C:/nvm4w/nodejs/node_modules/@earendil-works/pi-coding-agent/node_modules", "jiti"),
];

function findJitiDir() {
  for (const dir of JITI_CANDIDATES) {
    if (existsSync(dir)) return dir;
  }
  return null;
}

async function main() {
  const jitiDir = findJitiDir();
  if (!jitiDir) {
    throw new Error(
      `jiti 未找到（候选：\n  ${JITI_CANDIDATES.join("\n  ")}）。` +
        "请确认 pi 已安装（node_modules/@earendil-works/pi-coding-agent 存在）。",
    );
  }
  const jitiPkgJson = join(jitiDir, "package.json");
  // 以该 jiti 的 package.json 为基准生成 require（与 pi loader 相同，保证相对该包解析）
  const require = createRequire(pathToFileURL(jitiPkgJson).href);
  // Windows 路径一律经 pathToFileURL 转成 ESM URL，不直接拼成 "C:/..." 形式的 href
  const { createJiti } = await import(pathToFileURL(join(jitiDir, "lib", "jiti.mjs")).href);
  const jiti = createJiti(import.meta.url, { moduleCache: false });
  const module = await jiti.import(indexTsPath, { default: true });
  if (typeof module !== "function") {
    throw new Error(`extensions/index.ts 的 default 导出不是 function，实际为 ${typeof module}`);
  }
  console.log("extension load OK");
}

main().catch((err) => {
  console.error(`extension load FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});