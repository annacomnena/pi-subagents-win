/**
 * _test_chat_collapse_state.ts — ChatPage 折叠块（思考 / 工具调用）展开态的**受控性**回归门。
 *
 * 背景（2026-10-20 用户报障）：
 *   - 「思考展不开」：reasoning 用 Radix **非受控** state，行列表重新切片（`hiddenHead` 分块渲染 /
 *     回看滚动）会卸载重挂 ⇒ state 丢失 ⇒ 点开的思考变回收起。
 *   - 「工具调用合不上」：toolCall 直接 `const isOpen = toolCardOpenState.get(rowId)` 当渲染真相，
 *     而 `onOpenChange` 只在 `open === true` 时 setState ⇒ **关闭不触发 re-render**。
 *     加 `memo` 之前靠父级 2-6s 轮询「顺带」刷回来；加 `memo` 之后永久停在展开态。
 *
 * 本测试用**静态断言**钉住「受控 + 本地 state」这条结构约束：
 *   1. 两个折叠块的展开态都必须来自本地 `useState`（不能直接把模块 Map 读成渲染真相）；
 *   2. `onOpenChange` 必须同时写 Map（持久）与 setState（重渲染）；
 *   3. Map 仍然存在（卸载重挂后要能恢复）。
 *
 * 为什么是静态断言：真实点击行为已用无头 Chrome CDP 实测（连点 4 次双向正确、滚动后保持），
 * 但那种验证需要浏览器，不能进 Node 单测；这里守住**导致该 bug 的代码形状**。
 *
 * 运行：npm run test:chat-collapse
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let n = 0;
const ok = (name: string): void => {
	n += 1;
	console.log(`ok ${n} - ${name}`);
};

const src = readFileSync(new URL("./pages/ChatPage.tsx", import.meta.url), "utf8");

// ── ① 两个折叠块都有「本地 state + 模块 Map」双写 ─────────────────
{
	const hasReasoningMap = /const reasoningOpenState = new Map<string, boolean>\(\)/.test(src);
	const hasToolMap = /const toolCardOpenState = new Map<string, boolean>\(\)/.test(src);
	assert.ok(hasReasoningMap, "reasoningOpenState 模块级 Map 存在（卸载重挂后恢复展开态）");
	assert.ok(hasToolMap, "toolCardOpenState 模块级 Map 存在");

	// 两个组件都必须用本地 useState 初始化自 Map
	const stateFromMap = src.match(/const \[open, setOpen\] = useState<boolean>\(\(\) => \w+OpenState\.get\(row\.rowId\) \?\? false\)/g) ?? [];
	assert.equal(stateFromMap.length, 2, `两个折叠块都从 Map 初始化本地 state（实得 ${stateFromMap.length}）`);
	ok("① reasoning / toolCall 都是「本地 state + 模块 Map」双写");
}

// ── ② 关闭路径必须 setState（这是「合不上」的直接原因）──────────────
{
	// onOpenChange 里同时出现 Map.set 与 setOpen（两处）
	const handlers = src.match(/onOpenChange=\{\(next\) => \{[\s\S]{0,400}?\n\t*\}/g) ?? [];
	const withBoth = handlers.filter((h) => /\.set\(row\.rowId, next\)/.test(h) && /setOpen\(next\)/.test(h));
	assert.ok(withBoth.length >= 2, `两个 onOpenChange 都同时写 Map 与 setOpen（实得 ${withBoth.length}）`);

	// 反例守卫：不得再出现「直接把 Map 读成渲染真相」
	assert.ok(
		!/const isOpen = toolCardOpenState\.get\(row\.rowId\) \?\? false;/.test(src),
		"toolCall 不得再直接把 Map 读成渲染真相（必须经本地 state）",
	);
	ok("② onOpenChange 双向写（Map + setState），且不再直接读 Map 当渲染真相");
}

// ── ③ 受控 open 必须绑定到本地 state（而不是表达式）────────────────
{
	const controlled = src.match(/<Collapsible\s*\n?\s*open=\{open\}/g) ?? [];
	assert.ok(controlled.length >= 2, `两个 Collapsible 都以 open={open} 受控（实得 ${controlled.length}）`);

	// reasoning 的 Collapsible 必须受控（原 bug：非受控 ⇒ 卸载丢 state）
	const reasoningBlock = src.slice(src.indexOf("function ReasoningRowView"), src.indexOf("// ── toolCall"));
	assert.ok(/<Collapsible\s*\n\t*open=\{open\}/.test(reasoningBlock), "reasoning 的 Collapsible 是受控的");
	assert.ok(!/<Collapsible className="w-full">/.test(reasoningBlock), "reasoning 不得再退回非受控 <Collapsible className>");
	ok("③ 两个 Collapsible 均受控；reasoning 不再是非受控");
}

// ── ④ 默认收起口径不变（zcode Reasoning 口径）──────────────────────
{
	const reasoningBlock = src.slice(src.indexOf("function ReasoningRowView"), src.indexOf("// ── toolCall"));
	assert.ok(/\?\? false/.test(reasoningBlock), "reasoning 默认收起（?? false）");
	ok("④ 默认收起口径保持不变");
}

// ── ⑤ chevron 的 group 名必须有声明处（2026-10-20 用户截图实测的 bug）────
{
	// 事故：ChatPage 三处 chevron 用 `group-data-[state=open]/collapsible:rotate-90`，
	// 但 `Collapsible` 根只有 data-slot，没有任何元素带 `group/collapsible` 类
	// ⇒ 选择器 `:where(.group\/collapsible)[data-state=open] *` 永不匹配
	// ⇒ 三个箭头永远指向右（收起），即使内容已展开。CDP 实测：
	//     collapsibleRoots=280, elementsWithGroupCollapsible=0, chevronRotate="none"
	const ui = readFileSync(new URL("./ui/collapsible.tsx", import.meta.url), "utf8");
	assert.ok(
		/cn\("group\/collapsible",\s*className\)/.test(ui),
		"Collapsible 根必须声明 `group/collapsible` 类（否则 chevron 选择器永不匹配）",
	);
	assert.ok(
		!/className="group\/collapsible"/.test(ui),
		"group/collapsible 必须经 cn() 与外部 className 合并，不能写死覆盖外部类",
	);
	const chat = readFileSync(new URL("./pages/ChatPage.tsx", import.meta.url), "utf8");
	const uses = (chat.match(/group-data-\[state=open]\/collapsible:/g) ?? []).length;
	assert.ok(uses >= 3, `ChatPage 至少三处 chevron 依赖该 group（实得 ${uses}）`);
	ok(`⑤ chevron 的 group/collapsible 有声明处（${uses} 处使用）`);
}

console.log(`\n_test_chat_collapse_state: all assertions passed (${n})`);
