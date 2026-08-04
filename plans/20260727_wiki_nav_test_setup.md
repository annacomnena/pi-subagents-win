# wiki-nav 独立 smoke test 环境方案

## 依据

- Task 提供的已验证事实（没有单独的 searcher 摘要或 `plans/*_research.md`）：
  - Pi 安装在 `C:/Users/Annacomnena/AppData/Local/nvm/v22.19.0/node_modules/`；`@earendil-works/pi-coding-agent` 位于该目录，而 `@earendil-works/pi-tui` 与 `typebox` 位于其 nested `node_modules/`。
  - `subagent-win` 没有自己的 `node_modules/`，Pi 扩展加载器中可以运行；裸 Node 的 ESM loader 不能通过 `NODE_PATH` 查找该 nested 目录。
  - 目标 Node 是 v22.19.0，当前命令为 `node --experimental-strip-types extensions/_smoke_wiki_nav.ts`。
- 已读取源码与配置：
  - `extensions/wiki-nav.ts`：顶层有 `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"`、运行时 `@earendil-works/pi-tui` 和 `typebox` import；导出的 `dispatch()` 是 smoke 的现有测试入口。
  - `extensions/_smoke_wiki_nav.ts`：通过构造 `_navigation.json` 后调用 `dispatch()` 间接覆盖 `buildTree`、`actFind` 等内部纯逻辑。
  - `extensions/index.ts`：使用同一组 Pi/TUI/typebox import，说明这组 host 提供的依赖在 Pi 加载环境中可用。
  - `package.json`：`"type": "module"`，没有 scripts 或依赖声明。
  - `.gitignore`：已忽略 `node_modules/` 与 `dist/`。
- 本次复核结果：在包根运行现有 smoke，Node v22.19.0 以 `ERR_MODULE_NOT_FOUND`（`@earendil-works/pi-tui`）退出；Task 给出的三个 Pi 依赖路径均存在。
- 正式 Wiki：仓库内未发现 `Wiki/` 正式页；本任务不创建、不更新 Wiki。

## 目标

建立一条在 Windows 上可重复执行的独立测试路径：

1. 不启动 Pi，也不依赖 Pi 扩展加载器；
2. 用 Node v22 的 `--experimental-strip-types` 运行 `wiki-nav` smoke；
3. 让当前 `dispatch()` 间接验证 `buildTree`、`actFind`、树形/别名/隐藏页/错误分支等纯逻辑；
4. 将这套依赖准备能力复用于包内将来的直接 Node 测试；
5. 不安装全局工具、不添加 lockfile、不把 host 私有依赖或生成目录提交到版本库。

## 根因分析

`--experimental-strip-types` 只移除可擦除的 TypeScript 语法；它**不**改变 Node ESM 的 bare-specifier（例如 `"typebox"`）解析规则。

从 `extensions/wiki-nav.ts` 导入 `@earendil-works/pi-tui` 时，Node 的 ESM resolver 只会从该文件所在目录开始向祖先目录查找 `node_modules`，例如：

```text
subagent-win/extensions/node_modules/
subagent-win/node_modules/
pi-packages/node_modules/
...
```

Pi 的实际 TUI/typebox 目录却在另一个包的下方：

```text
.../node_modules/@earendil-works/pi-coding-agent/node_modules/
```

这个目录既不是 `wiki-nav.ts` 的祖先，也不是 Node 会为了某个 bare specifier 自动向下遍历的目录。因此裸 Node 看不到它。Pi 自己的扩展加载器拥有 host 安装位置的解析上下文，所以 Pi 运行正常；直接运行 Node 没有该 loader 上下文。

补充：`wiki-nav.ts` 中的 `pi-coding-agent` 是 `import type`，在当前 Node strip-types smoke 运行时会被擦除，故本次报错首先是两个运行时 import（TUI/typebox）。不过依赖准备器仍应同时暴露 `pi-coding-agent`：它支持未来的类型检查、以及直接加载其他包内扩展文件时的解析一致性。

`NODE_PATH` 是 CommonJS 历史机制，Node ESM package resolver 不把它作为 bare-package 查找路径，因此不能解决本问题。

## 工程约束

- 只使用 Node v22 已有能力及 `node:*` 内建模块；不要求 `tsx`、测试框架、bundler 或任何全局安装。
- 使用 `scripts/*.mjs`，与本包的 `"type": "module"` 对齐；不得把开发期 resolver 混入 `extensions/wiki-nav.ts` 的 Pi 运行时代码。
- Windows 上使用目录 **junction**，而不是需要管理员权限的传统目录 symlink。junction 目标必须为绝对路径。
- 不能把整个 `subagent-win/node_modules` 指向 Pi 的某一个目录：
  - 指向全局 Node modules 时找得到 `pi-coding-agent`，但找不到其 nested 的 TUI/typebox；
  - 指向 `pi-coding-agent/node_modules` 时找得到 TUI/typebox，却找不到 `pi-coding-agent` 本身。
  应建立三个**包叶子级** junction。
- 复用现有 `.gitignore` 的 `node_modules/` 规则；不修改 `.gitignore`，不运行 `npm install`，不新增依赖或 lockfile。
- 不传 `--preserve-symlinks`：默认 realpath 行为能让已链接 Pi 包继续从其真实安装位置解析自己的传递依赖。

## 候选方案对比

| 方案 | 做法 | 优点 | 缺点 / 不采用原因 |
| --- | --- | --- | --- |
| A. 包内叶子 junction（推荐） | 在被忽略的 `node_modules/` 内，把三个精确 package 路径 junction 到 Pi 安装树；由内建 Node 脚本幂等创建。 | 裸 Node 的标准 ESM 解析无需特殊 flag；Windows junction 通常不需管理员；零额外工具；能服务未来任意同类测试；不修改被测模块；Pi 更新后重跑即可。 | 依赖本机 Pi 安装，安装目录被移除/换 Node 后须重跑；需明确不能把一个已有的、不同目标的本地包静默覆盖。 |
| B. ESM loader hook | 用 `node --import` 预加载模块，再用 `node:module` 的 `register()` 注册 `resolve()` hook，将三个 bare specifier 映射到 Pi 路径。 | 不创建项目下链接；可把映射完全保留在测试启动过程。 | resolver 要处理 package exports、URL、缓存和传递依赖，调试成本高；loader hook 是进程级的特殊行为，未来测试容易漏带启动参数。Node v22 没有可直接替代此问题的通用 browser-style import map；`package.json#imports` 也只能服务 `#` 内部 specifier，不会重写第三方 bare specifier。相对此任务过度设计。 |
| C. 抽取无 host 依赖的 core module | 把导航模型、`buildTree`、动作函数抽到 `wiki-nav-core.ts`，让 `wiki-nav.ts` 保留索引 I/O 与 Pi tool/TUI adapter；测试只导入 core。 | 测试在任何 Node 环境都不必装 Pi 依赖；core module 有更深的 interface，纯逻辑的测试 seam 清晰。 | 需要重构刚建立的扩展、移动类型与接口，并仍应为 `wiki-nav.ts` adapter 保留至少一条加载/集成测试；超过“先可靠跑现有 smoke”的最小改动面。适合作为逻辑继续增长时的后续优化，不阻塞本方案。 |
| D. 声明并安装 devDependencies | 在 `package.json`/lockfile 中安装与 Pi 匹配的 `pi-coding-agent`、TUI、typebox，执行常规 `npm install`。 | 对 CI 和新机器最常见、最显式；不借用本机 nested 目录。 | 需要确定兼容版本、下载/安装并维护 lockfile；可能与实际 Pi host 版本漂移，也可能把扩展应由 host 提供的包重复安装。与“无需额外安装、复用现有 Pi”优先级不符。若未来要在没有 Pi 的 CI 上测试，可重新评估。 |
| E. `tsx` / bundler / transpile | 安装 `tsx` 或使用 bundler aliases，把依赖打包或改写到 Pi 目录。 | 可顺带提供 richer test runner 或单文件产物。 | `tsx` 本身不会自动发现另一个包的 nested `node_modules`，仍需要 alias/resolver；bundler 配置与额外依赖增加维护面。现有 Node 已可 strip types，收益不足。 |

## 推荐方案

采用 **方案 A：一个可提交的、幂等的 Node 准备脚本 + 被忽略的三个叶子 junction + npm convenience script**。

准备脚本以 `process.execPath` 所在 Node 版本目录为默认 Pi Node modules 根目录：在本机它会得到 `C:/Users/Annacomnena/AppData/Local/nvm/v22.19.0/node_modules`，避免把 `v22.19.0` 写死在源码中。提供 `PI_NODE_MODULES_DIR` 覆盖，供 Pi 和运行 Node 不是同一安装树时使用。

准备器只创建下列链接，而不会用一个粗粒度链接污染或遮蔽 `node_modules`：

```text
subagent-win/node_modules/@earendil-works/pi-coding-agent
  -> <PI_NODE_MODULES>/@earendil-works/pi-coding-agent
subagent-win/node_modules/@earendil-works/pi-tui
  -> <PI_NODE_MODULES>/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui
subagent-win/node_modules/typebox
  -> <PI_NODE_MODULES>/@earendil-works/pi-coding-agent/node_modules/typebox
```

这样，`wiki-nav.ts` 所在位置向上查找的 `subagent-win/node_modules` 含有全部直接 package 名；Node 在进入链接后仍按各包真实位置处理其传递依赖。该机制不仅覆盖当前 smoke，也覆盖未来直接 import Pi/TUI/typebox 的 Node 测试。

## 前置任务 / 可并行任务 / 后续任务

### 前置任务

1. 保持 Pi 与 Node v22.19.0 的当前安装可用，确认三个目标目录各自包含 `package.json`。
2. 从 `C:/Users/Annacomnena/pi-packages/subagent-win` 执行命令；若用另一套 Node 执行，设置 `PI_NODE_MODULES_DIR` 指向实际承载 Pi 的 Node modules 根目录。
3. 若本地已存在同名真实目录或指向其他位置的 junction，先人工决定保留还是删除；准备器必须拒绝覆盖，不能擅自删除用户已安装依赖。

### 可并行任务

- 新建通用 junction 准备器，并把 `package.json` scripts 接到它。
- 把现有 smoke 从“打印人工检查”升级为 `node:assert/strict` 断言，同时用系统临时目录和 `try/finally` 清理 fixture。两项可独立开发，合并后再执行验证。

### 后续任务

- 当导航纯逻辑明显扩展、需要大量 edge-case/unit 测试或希望在无 Pi 的 CI 上运行时，再评估方案 C，提取 `wiki-nav-core.ts`。届时让 core 的 interface 接受导航索引与参数、返回文本/错误结果；Pi tool 文件保留为加载和渲染 adapter。
- 若需要无 Pi 的 CI，再选择锁定的 devDependencies 或在 CI 安装 Pi；不要让当前本机 junction 假装是跨机器依赖管理。

## 要修改的文件 / 新建文件

| 路径 | 操作 | 内容与责任 |
| --- | --- | --- |
| `scripts/ensure-pi-test-deps.mjs` | 新建 | 唯一的 host 依赖 adapter：发现 Pi 根、验证目标、幂等创建精确 junction，遇到冲突安全失败。仅用 `node:fs`、`node:path`、`node:url`。 |
| `package.json` | 修改 | 增加 `prepare:test-deps` 和 `smoke:wiki-nav` scripts；不添加 dependencies、devDependencies 或 package manager lockfile。 |
| `extensions/_smoke_wiki_nav.ts` | 修改 | 保持对 `dispatch` 的黑盒调用；用断言和临时 fixture 使失败返回非零、清理可靠。 |
| `.gitignore` | 不修改 | 已覆盖 `node_modules/`；确认 junction 不会被 Git 跟踪。 |
| `extensions/wiki-nav.ts` | 不修改 | 推荐方案不为测试而改变 Pi tool 的 interface 或实现。 |

### `scripts/ensure-pi-test-deps.mjs` 的建议完整内容

```js
import { existsSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const piNodeModules = resolve(
  process.env.PI_NODE_MODULES_DIR ?? join(dirname(process.execPath), "node_modules"),
);
const piCodingAgent = join(piNodeModules, "@earendil-works", "pi-coding-agent");
const piNestedModules = join(piCodingAgent, "node_modules");

const packages = [
  ["@earendil-works/pi-coding-agent", piCodingAgent],
  ["@earendil-works/pi-tui", join(piNestedModules, "@earendil-works", "pi-tui")],
  ["typebox", join(piNestedModules, "typebox")],
];

function canonical(path) {
  return realpathSync(path).toLowerCase();
}

for (const [specifier, rawTarget] of packages) {
  const target = resolve(rawTarget);
  const link = join(packageRoot, "node_modules", ...specifier.split("/"));

  if (!existsSync(join(target, "package.json"))) {
    throw new Error(
      `Pi test dependency is missing: ${target}\n` +
      "Use the Node that installed Pi, or set PI_NODE_MODULES_DIR to its node_modules directory.",
    );
  }

  if (existsSync(link)) {
    if (canonical(link) !== canonical(target)) {
      throw new Error(
        `Refusing to replace existing path: ${link}\n` +
        `Expected junction target: ${target}`,
      );
    }
    console.log(`ok    ${specifier}`);
    continue;
  }

  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  if (canonical(link) !== canonical(target)) {
    throw new Error(`Created junction does not resolve to expected target: ${link}`);
  }
  console.log(`linked ${specifier}`);
}
```

Implementation notes for the change:

- `realpathSync` comparison is deliberately used instead of trusting directory names; it makes a second run idempotent and causes an existing normal package or foreign link to fail safely.
- The script does not remove links. This avoids a cleanup implementation accidentally traversing a directory junction. Links are development setup state and remain reusable for subsequent tests.
- If a developer deliberately runs Node from a different installation, set the override before the script, for example:

  ```powershell
  $env:PI_NODE_MODULES_DIR = "C:\Users\Annacomnena\AppData\Local\nvm\v22.19.0\node_modules"
  node .\scripts\ensure-pi-test-deps.mjs
  ```

### `package.json` 的建议 scripts

在现有顶层字段中加入（保留现有字段不变）：

```json
"scripts": {
  "prepare:test-deps": "node ./scripts/ensure-pi-test-deps.mjs",
  "smoke:wiki-nav": "node ./scripts/ensure-pi-test-deps.mjs && node --experimental-strip-types ./extensions/_smoke_wiki_nav.ts"
}
```

`npm run smoke:wiki-nav` 只是 convenience entry；真正依赖的只有随 Node 安装的 Node/npm。也可不经 npm 直接顺序执行这两个 `node` 命令。

### smoke 断言的落地范围

将 fixture 目录改为：

```ts
const tmp = mkdtempSync(join(tmpdir(), "subagent-win-wiki-nav-"));
try {
  // 写入现有 navigation fixture，并做如下断言
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
```

保留当前数据集，并至少断言：

1. `tree` depth 1 排除 `navHidden` 页面，且 depth 2 出现 `plant_seed`、`plant_harvest`；
2. `around` 接受别名 `State Bus`；
3. `find plants` 返回植物页，`find auth` 保留当前“搜索可命中隐藏页”的语义；
4. `path Modules/plant_seed` 产生祖先链；
5. 缺失索引返回构建提示但不是执行错误，缺失 `around.node`/未知节点返回预期错误文本和 `isError`；
6. 每个预期都用 `assert.match`、`assert.equal` 或 `assert.ok`，而不是仅 `console.log`。

这保持测试通过公开 `dispatch()` 接口跨越同一 seam，间接覆盖内部 `buildTree`/`actFind`，不为测试导出不必要的内部函数。

## 测试与验证

在包根执行下列 Windows 命令。

### PowerShell

```powershell
node .\scripts\ensure-pi-test-deps.mjs
node .\scripts\ensure-pi-test-deps.mjs     # 第二次应只输出 ok，验证幂等
node --experimental-strip-types .\extensions\_smoke_wiki_nav.ts
npm run smoke:wiki-nav
```

### cmd.exe

```bat
node scripts\ensure-pi-test-deps.mjs
node --experimental-strip-types extensions\_smoke_wiki_nav.ts
npm run smoke:wiki-nav
```

验收项：

- 所有命令退出码为 0；最后两条 smoke 命令在断言失败时必须非 0。
- 第一次准备显示三个 `linked`/`ok` 条目；第二次不改变目标并显示三个 `ok` 条目。
- 在**包外**用绝对路径执行准备器和 smoke 也成功；因为链接位于包根且 smoke fixture 已移入系统 temp，不依赖调用者的 CWD。
- 使用错误的 `PI_NODE_MODULES_DIR` 执行准备器必须非 0，错误信息包含缺失目标与 override 指引；不得创建半套或覆盖现有非匹配目录。
- `git status --ignored` 只把新建 junction 归类在已忽略的 `node_modules/`，`git status` 不出现跟踪文件变更（除计划中明确的 `scripts/`、`package.json`、smoke 文件）。
- 重新启动正常 Pi 后加载该扩展，确认本方案没有修改 `wiki-nav.ts` 的 Pi runtime import 或 resolver 行为。

若需移除本机开发链接，先确认路径确实是本方案的 junction，再从 **cmd.exe** 使用不带 `/s` 的 `rmdir` 删除链接本身：

```bat
rmdir node_modules\@earendil-works\pi-coding-agent
rmdir node_modules\@earendil-works\pi-tui
rmdir node_modules\typebox
```

不要对这些路径使用 `rmdir /s` 或递归删除命令，避免把目标目录误当作要清理的内容。删除后重新运行准备器应能恢复完整环境。

## 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| Pi 被升级、卸载，或测试 Node 与 Pi 所属 Node 不同 | junction 成为失效/旧版本映射，测试无法启动或与 host 不一致。 | 每次 test script 先运行准备器；默认从 `process.execPath` 推导，跨安装树时明确设置 `PI_NODE_MODULES_DIR`；启动前验证每个 `package.json`。 |
| 开发者已有真实的同名 local dependency | 自动覆盖会破坏本地测试环境。 | `realpath` 不匹配立即失败，不删除、不重定向任何已有路径。 |
| Windows junction 清理误操作 | 可能误删目标依赖。 | 不提供递归自动清理；文档只允许确认后使用不带 `/s` 的 `rmdir` 删除 junction。 |
| smoke 只覆盖 dispatch 逻辑，不覆盖 Pi TUI rendering/register 行为 | 不能替代真实 Pi 交互集成验证。 | 把本测试明确定位为纯逻辑 smoke；Pi 中的加载/交互单独手工或后续集成验证。 |
| 本机 junction 不是无 Pi CI 的完整依赖策略 | CI 无法复现 Pi host 时会失败。 | 当前目标是本机独立 Node 测试；需要无 Pi CI 时再采用 core extraction 或锁定 devDependencies，不悄悄依赖开发机路径。 |
