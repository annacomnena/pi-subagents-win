/**
 * _test_chat_auto_expand.ts — 折叠块「自动展开 / 自动合上」的**判定规则**回归门（2026-10-20）。
 *
 * 用户诉求：「当前执行的思考或者工具调用，自动展开，然后完毕后自动合上」。
 *
 * 这里有三个**必须钉住**的规则，任何一条错了都会直接表现为「卡片乱开乱合」：
 *   R1 工具调用：`running` ⇒ 展开；`running → 终态` ⇒ 合上。
 *   R2 历史卡片不动：一打开会话时就已经是终态的工具卡**不得**被自动合上
 *      （否则用户展开的历史卡片会全部塌掉）。
 *   R3 用户手动操作优先：手动点过之后，自动逻辑永久让位（不能和用户抢）。
 *
 * 为什么是纯函数 + 静态断言：
 *   - 判定逻辑抽成 `autoExpandTarget`（纯函数，可 Node 直测，含所有边界）；
 *   - 「用户锁定」「effect 接线」用静态断言守住代码形状（浏览器行为另用 CDP 实测）。
 *
 * 运行：npm run test:chat-auto-expand
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { autoExpandTarget } from "./chatAutoExpand.ts";

let n = 0;
const ok = (name: string): void => {
	n += 1;
	console.log(`ok ${n} - ${name}`);
};

// ── R1 工具调用：running 展开 / 结束合上 ──────────────────────────
{
	assert.equal(autoExpandTarget({ isRunning: true, wasRunning: true, userLocked: false }), true, "running ⇒ 展开");
	assert.equal(autoExpandTarget({ isRunning: false, wasRunning: true, userLocked: false }), false, "running → 终态 ⇒ 合上");
	ok("R1 工具调用：running 展开，结束后合上");
}

// ── R2 历史卡片不动 ──────────────────────────────────────────────
{
	// 一打开会话：所有历史卡片都是终态且从未 running ⇒ null（不动）
	assert.equal(autoExpandTarget({ isRunning: false, wasRunning: false, userLocked: false }), null, "从未 running 的历史卡片 ⇒ 不动");
	ok("R2 历史卡片不被自动合上（返回 null = 不做任何改变）");
}

// ── R3 用户手动操作优先 ──────────────────────────────────────────
{
	assert.equal(autoExpandTarget({ isRunning: true, wasRunning: true, userLocked: true }), null, "用户锁定 ⇒ running 也不自动展开");
	assert.equal(autoExpandTarget({ isRunning: false, wasRunning: true, userLocked: true }), null, "用户锁定 ⇒ 结束也不自动合上");
	ok("R3 用户手动操作后自动逻辑让位（锁定 ⇒ null）");
}

// ── 边界：错误态与成功态同等对待（都是终态）───────────────────────
{
	assert.equal(autoExpandTarget({ isRunning: false, wasRunning: true, userLocked: false }), false, "出错也合上（终态）");
	ok("边界：error 与 done 同为终态 ⇒ 合上");
}

// ── 静态断言：接线形状（防止回退成「直接读 Map」或漏掉锁定）────────
{
	const src = readFileSync(new URL("./pages/ChatPage.tsx", import.meta.url), "utf8");

	// toolCall：必须用 autoExpandTarget + 本地 state 双写
	assert.ok(src.includes("autoExpandTarget({"), "toolCall 用纯函数 autoExpandTarget 决策");
	assert.ok(src.includes("const wasRunningRef = useRef(row.status === \"running\")"), "toolCall 记录「曾 running」（R2 依赖它）");
	assert.ok(src.includes("const userLockedRef = useRef(false)"), "存在用户锁定 ref");

	// 锁定必须在两个 onOpenChange 里都设置（reasoning + toolCall）
	const lockWrites = (src.match(/userLockedRef\.current = true/g) ?? []).length;
	assert.equal(lockWrites, 2, `两个折叠块的 onOpenChange 都设锁定（实得 ${lockWrites}）`);

	// 自动决策必须把锁定传进纯函数（不能绕过它直接 setOpen）
	const lockedPassed = (src.match(/userLocked: userLockedRef\.current/g) ?? []).length;
	assert.equal(lockedPassed, 2, `两个自动决策都把锁定传给纯函数（实得 ${lockedPassed}）`);

	// reasoning 自动展开只能来自「流式刚结束」这个信号，不能是「最后一行」这种常驻条件
	assert.ok(src.includes("streamJustEnded"), "reasoning 自动展开依赖「流式刚结束」信号");
	assert.ok(!/streaming !== null && streaming\.kind === "reasoning" && rows\.length > 0/.test(src), "不得再退回「流式中取最后一行」的错误判定");
	ok("静态：决策走纯函数 + 两处锁定 + 流式结束信号（无回退形状）");
}

console.log(`\n_test_chat_auto_expand: all assertions passed (${n})`);
