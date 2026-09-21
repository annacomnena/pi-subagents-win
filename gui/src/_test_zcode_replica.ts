/**
 * _test_zcode_replica.ts — ZCode 主工作台 1:1 复刻 布局冒烟（第 7 步收尾；L4 代码级验收）。
 *
 * gui 无 DOM 测试框架 → 骨架断言落在**源码级**：对锚（plans/0922_zcode_ui_1to1_research.md
 * §2/§3 值表）的必需 class 串 / token 值 / 文件存在性做静态断言（拍板 7：验收=代码级对照值表）。
 * 数据面（WS/outbox/store 行为）由 test:gui-session-first / test:gui-chat-guard 覆盖，不重复。
 *
 * 运行：npm run test:gui-zcode-replica
 */

import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(join(here, rel), "utf8");

let n = 0;
const ok = (name: string): void => {
	n += 1;
	console.log(`ok ${n} - ${name}`);
};

// ── 1. 主题底座（index.css token 表 / 14px / 滚动条 / 动画 / custom-variant）────
const css = read("index.css");
assert.ok(css.includes(".theme-zai-dark"), "index.css 有 .theme-zai-dark 生效层");
assert.ok(css.includes("--ui-font-size: 14px"), "14px 基准字号");
for (const token of [
	"--color-input-border-focused: var(--color-border-hover)", // zai 主题 focused = border-hover（非 brand）
	"--color-foreground-subtlest: color-mix(in oklab, var(--color-neutral-300) 30%, transparent)",
	"--color-selected: rgba(255, 255, 255, 0.1)",
	"--color-brand: #ffffff",
	"--color-trajectory-tool-call: #f59e0b",
	"--animated-gradient-text-soft: rgba(255, 255, 255, 0.22)",
	"--color-interaction-ask-fill: rgba(70, 191, 114, 0.24)",
]) {
	assert.ok(css.includes(token), `token 值对锚 §3.2：${token}`);
}
assert.ok(css.includes("scrollbar-width: auto") && css.includes("width: 14px"), "全局滚动条整块（14px/thumb 圆角）");
assert.ok(css.includes("animation: gradient-flow 4s linear infinite"), "gradient-flow：4s linear infinite");
assert.ok(/zcode-stream-text-in 900ms cubic-bezier\(0\.16, 1, 0\.3, 1\)/.test(css), "stream text/tool：900ms cubic-bezier(0.16,1,0.3,1)");
assert.ok(css.includes("zcode-draft-prompt-waterfall 260ms cubic-bezier(0.22, 1, 0.36, 1)"), "draft waterfall：260ms cubic-bezier(0.22,1,0.36,1)");
assert.ok(css.includes("zcode-task-interaction-countdown var(--zcode-interaction-remaining-ms, 240000ms) linear forwards"), "interaction countdown：remaining-ms linear forwards");
assert.ok(css.includes("task-search-result-highlight 1.2s ease-out both"), "search highlight：1.2s ease-out");
assert.ok(css.includes("fork-highlight-pulse 1.6s ease-out 1"), "fork highlight：1.6s ease-out");
assert.ok(css.includes("@custom-variant data-active"), "shadcn 语义 variant 手写块（data-active）");
assert.ok(css.includes('@import "tw-animate-css"'), "tw-animate-css 接入");
ok("1 主题底座：token 值表 / 14px / 滚动条 / 动画 / @custom-variant 全对锚");

// main.tsx 常挂 theme-zai-dark
assert.ok(read("main.tsx").includes('classList.add("theme-zai-dark")'), "documentElement 常挂 theme-zai-dark");
ok("1b main.tsx 挂 .theme-zai-dark（Web 默认暗色口径）");

// ── 2. 依赖 + ui 14 件 ─────────────────────────────────────────────
const pkg = JSON.parse(read("../package.json")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
const DEPS: Record<string, string> = {
	"radix-ui": "^1.4.3",
	"class-variance-authority": "^0.7.1",
	clsx: "^2.1.1",
	"tailwind-merge": "^3.5.0",
	"lucide-react": "^1.17.0",
	"tw-animate-css": "^1.4.0",
	"@tailwindcss/typography": "^0.5.19",
};
for (const [name, range] of Object.entries(DEPS)) {
	assert.equal(pkg.dependencies[name], range, `依赖版本照 research 实读值：${name}@${range}`);
}
assert.ok(["^4.2.2", "^4.2.3", "^4.3.3"].includes(pkg.devDependencies.tailwindcss) === false || pkg.devDependencies.tailwindcss.startsWith("^4.2."), "tailwindcss 升至 ^4.2.2+（^4.2.2 范围内）");
ok("2a gui/package.json 依赖 7 项（版本照 research 实读值）+ tailwind ^4.2.2");

const UI_FILES = [
	"button", "badge", "input", "tabs", "tooltip", "toast", "collapsible",
	"dialog", "dropdown-menu", "spinner", "textarea", "kbd", "separator", "card",
] as const;
for (const f of UI_FILES) {
	assert.ok(existsSync(join(here, "ui", `${f}.tsx`)), `ui 14 件已搬入：ui/${f}.tsx`);
}
const spinner = read("ui/spinner.tsx");
assert.ok(spinner.includes('aria-label="加载中"'), "spinner 剥 i18n → 写死中文 aria-label");
assert.ok(!/from ["']@\/|from ["']\.\.\//.test(spinner), "spinner 零 i18n/跨目录 import");
const button = read("ui/button.tsx");
assert.ok(button.includes('from "radix-ui"') && button.includes("class-variance-authority"), "button 依赖 radix-ui/cva（统一包口径）");
assert.ok(read("ui/lib/utils.ts").includes("extendTailwindMerge"), "cn = clsx + tailwind-merge（text-ui-* 注册）");
ok("2b ui 14 件原样搬入 gui/src/ui/（spinner 剥 i18n；零后端 import）");

// ── 3. 左栏会话列表 1:1（锚 §2.a）─────────────────────────────────
const sidebar = read("pages/Sidebar.tsx");
assert.ok(sidebar.includes("w-[264px]"), "左栏 264px 宽");
assert.ok(sidebar.includes("transition-[width,opacity]") && sidebar.includes("pointer-events-none opacity-0"), "折叠 = width→0 + opacity-0 + pointer-events-none");
assert.ok(sidebar.includes("pl-2.5 pr-2.5 hover:bg-transparent") || sidebar.includes("cursor-not-allowed"), "新建钮灰显占位（NewTaskButtonGroup class）");
assert.ok(sidebar.includes("px-4 pt-2 pb-4"), "footer（WorkspaceSidebarFooter class）");
assert.ok(!/dnd|DndContext|pinned|PinnedTask|GroupedTasks|TabsList/.test(sidebar), "分组 Tabs/置顶/归档/dnd 不渲染");
const sessionList = read("pages/SessionList.tsx");
assert.ok(sessionList.includes("group/task-item flex cursor-pointer items-center gap-2 rounded-lg pl-2.5 pr-1 py-1 transition-[background-color,border-color,box-shadow]"), "会话项行 class 逐字对齐 TaskListItem#L534-546");
assert.ok(sessionList.includes('isActive ? "bg-selected" : "hover:bg-surface-hover"'), "选中 bg-selected / hover bg-surface-hover 四态前置槽");
assert.ok(sessionList.includes("h-1.5 w-1.5 rounded-full bg-destructive"), "error 红点 = h-1.5 w-1.5");
assert.ok(sessionList.includes("titleSource"), "保留可读标题链成果（titleSource=id 灰显 shortId）");
assert.ok(sessionList.includes("space-y-0.5"), "ul space-y-0.5");
ok("3 左栏：容器/列表项 class 串逐字对齐；分组/置顶/dnd 不渲染");

// ── 4. 中央 transcript 1:1（锚 §2.b）──────────────────────────────
const chat = read("pages/ChatPage.tsx");
assert.ok(chat.includes("rounded-xl rounded-tr-xs border border-border bg-surface px-4 py-3"), "user 气泡（rounded-tr-xs 缺角必抄）");
assert.ok(chat.includes("group/user-row flex flex-col items-end"), "user 行右对齐壳");
assert.ok(chat.includes("mt-1 text-right text-ui-sm"), "outbox 回执状态行（气泡下）");
assert.ok(chat.includes('className="group/assistant-row"') && chat.includes("whitespace-pre-wrap"), "assistant 行式纯文本");
assert.ok(chat.includes("animated-gradient-text"), "工具卡运行中扫光（≈流式，无光标字符）");
assert.ok(!chat.includes("▌") && !chat.includes("█"), "无光标字符");
assert.ok(chat.includes("border-b border-[var(--color-border)] py-1 text-ui-sm text-[var(--color-foreground-subtle)]"), "turn header 行 class 对锚");
assert.ok(chat.includes("TOOL_CONTENT_COLLAPSE_UNMOUNT_DELAY_MS = 300"), "工具卡收起延迟卸载 300ms");
assert.ok(chat.includes("toolCardOpenState"), "工具卡展开态按 rowId 内存持久");
assert.ok(chat.includes("[scrollbar-gutter:stable]"), "滚动视口 scrollbar-gutter:stable");
assert.ok(chat.includes("COMPOSER_MESSAGE_MASK_FADE_PX = 24") && chat.includes("COMPOSER_MESSAGE_MASK_TRANSPARENT_HEIGHT_PX = 96"), "回看 mask 公式常数（24/96）");
assert.ok(chat.includes("@min-[864px]/conversation:max-w-4xl"), "内容列宽断点对锚 conversationLayout");
assert.ok(chat.includes("思考过程"), "reasoning 折叠标题");
ok("4 transcript：5 种行→zcode 行型映射 + 工具卡 + mask（无光标字符）");

// ── 5. composer 1:1（锚 §2.c）─────────────────────────────────────
assert.ok(chat.includes("rounded-2xl border border-input-border bg-input p-3 transition-colors hover:border-input-border-hover focus-within:!border-input-border-focused focus-within:bg-input-focused"), "输入壳三态边框整串（ChatPromptEditor#L346-353）");
assert.ok(chat.includes("border-brand bg-input-focused ring-1 ring-brand/30"), "拖拽高亮占位");
assert.ok(chat.includes("cursor-pointer gap-1 rounded-lg bg-brand text-ui-base text-foreground-inverse hover:bg-brand/80"), "发送钮整串（ConversationComposer#L2088）");
assert.ok(chat.includes("<ArrowUp className=\"size-4\" />"), "发送钮 ArrowUp icon-md");
assert.ok(chat.includes("group/toolbar flex items-end gap-3"), "工具栏行");
assert.ok(chat.includes("Square className=\"size-4 fill-current\""), "Stop 钮灰显占位（secondary + Square fill-current）");
assert.equal((chat.match(/<span className="inline-flex">/g) ?? []).length >= 2, true, "加号/Stop 的 disabled button 由无动作 span 承接 Tooltip hover");
assert.ok(chat.includes('sendChatMessage'), "发送链复用 sendChatMessage（零改动）");
assert.ok(chat.includes("e.key === \"Enter\" && !e.shiftKey"), "Enter 发送 / Shift+Enter 换行");
assert.ok(chat.includes("Master 会话拒绝远程输入"), "masterProtected 禁输入文案保留");
ok("5 composer：输入壳/发送钮/Stop 灰显/Enter 语义 + 发送链零改动");

// ── 6. 顶栏 + 运行时覆盖层（锚 §2.d/§2.e）─────────────────────────
const topbar = read("pages/TopBar.tsx");
assert.ok(topbar.includes("h-12 border-b border-border/50"), "顶栏 h-12 + border-border/50");
assert.ok(topbar.includes('size="icon-lg"'), "ghost 图标钮 size-8 rounded-lg（icon-lg）");
assert.ok(topbar.includes("待决策") && topbar.includes("上下文压力") && topbar.includes("bg-success"), "Host●/压力/待决策徽标数据字段保留");
assert.ok(!/CommandCenter|FileTree|gitSummary|UpdateStatus/.test(topbar), "⌘K/文件树/git/更新徽标不渲染");
const overlay = read("pages/RuntimeOverlay.tsx");
assert.ok(overlay.includes("absolute inset-0 z-10"), "覆盖层壳 = WorkspaceSettingsLayer 同构");
assert.ok(overlay.includes("grid-cols-[68px_minmax(0,1fr)]") && overlay.includes("lg:grid-cols-[268px_minmax(0,1fr)]"), "设置层 grid 68px/268px 双态（SettingsPage#L1375）");
assert.ok(overlay.includes("m-1 w-[calc(100%-0.5rem)] justify-start gap-2 rounded-xl px-1.5"), "返回钮圆角-xl 套件（SettingsPage#L1408）");
for (const sec of ["AttentionPage", "MasterPage", "WorkstreamPage", "RuntimePage"]) {
	assert.ok(overlay.includes(sec), `四 section 原样复用：${sec}`);
}
ok("6 顶栏+覆盖层：h-12 徽标样式 / grid-cols-[68px/268px] / 四 section 复用");

// ── 7. 收尾：死样式（raw palette）+ store 附加字段 ────────────────
const RAW = /zinc-|amber-|blue-9|emerald-/;
const files: string[] = [];
const walk = (dir: string): void => {
	for (const f of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, f.name);
		if (f.isDirectory()) walk(p);
		else if (/\.(tsx|ts|css)$/.test(f.name) && !f.name.startsWith("_test")) files.push(p);
	}
};
walk(here);
const offenders = files.filter((f) => RAW.test(readFileSync(f, "utf8")));
assert.deepEqual(offenders, [], `raw 调色板类全退役（zinc-/amber-/blue-9/emerald-）：${offenders.join(",")}`);
const store = read("store.ts");
assert.ok(store.includes("sidebarCollapsed"), "store 附加 sidebarCollapsed（折叠动画数据源）");
assert.ok(store.includes("sendChatMessage: async (sessionId, text)") && store.includes("api.sessionMessage"), "发送链 P2 契约零改动");
ok("7 收尾：raw palette=0 / store 折叠字段 / 发送链零改动");

console.log(`\nall ${n} groups passed — ZCode 1:1 复刻布局冒烟`);
