/**
 * _test_capabilities.ts — 会话能力矩阵测试（Commit 1）
 *
 * 覆盖：
 *   - identity 推导分支与现状完全等价（无身份→main / tab→workflow-tab / subagent）
 *   - env PI_SESSION_PROFILE 显式声明（trace-worker 休眠检测通道）
 *   - flag authoritative：flag > env > 推导（fake pi，模拟工厂时序）
 *   - 能力矩阵快照（CAPS 字段断言，防无意识漂移）
 *   - canDelegateAgent 白名单语义（"*" / 列表 / 空）
 *
 * 运行：npm run test:capabilities
 */

import assert from "node:assert/strict";
import {
	assertDelegationAllowed,
	canDelegateAgent,
	capabilities,
	currentProfile,
	isTraceWorker,
	isWorkflowTab,
	registerCapabilityFlags,
	type SessionProfile,
} from "./capabilities.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 环境隔离：先清空全部身份相关环境
delete process.env.PI_SUBAGENT;
delete process.env.PI_TAB_RUN_ID;
delete process.env.PI_SESSION_PROFILE;

// ── 1. 无身份 → main（与 isMainSession 完全等价）──────────────────
{
	assert.equal(currentProfile(), "main");
	const c = capabilities();
	assert.deepEqual(c, {
		workflow: true,
		lite: true,
		launchTabs: true,
		delegateAgents: "*",
		timerOrchestration: true,
		directExecution: true,
	});
	assert.equal(canDelegateAgent("searcher"), true);
	assert.equal(canDelegateAgent("planner"), true);
	assert.equal(canDelegateAgent("general"), true, "main 的 \"*\" 允许任意名字");
	assert.equal(canDelegateAgent("trace-probe"), true);
}

// ── 2. env PI_TAB_RUN_ID → workflow-tab ──────────────────────────
{
	process.env.PI_TAB_RUN_ID = "tab_env_1";
	assert.equal(currentProfile(), "workflow-tab");
	assert.equal(isWorkflowTab(), true);
	assert.equal(isTraceWorker(), false);
	const c = capabilities();
	assert.equal(c.workflow, true, "workflow-tab 允许执行 workflow 链");
	assert.equal(c.lite, false);
	assert.equal(c.launchTabs, false, "tab 严禁再开 tab");
	assert.equal(c.timerOrchestration, false);
	assert.equal(c.directExecution, false, "workflow-tab 是 PM，不自己动手");
	// 角色白名单：允许 workflow 六角色，拒绝其余
	for (const a of ["searcher", "planner", "plan-reviewer", "implementer", "code-reviewer", "consultant"]) {
		assert.equal(canDelegateAgent(a), true, `workflow-tab 应允许 ${a}`);
	}
	assert.equal(canDelegateAgent("general"), false, "workflow-tab 不允许无角色 agent");
	assert.equal(canDelegateAgent("trace-probe"), false);
	delete process.env.PI_TAB_RUN_ID;
}

// ── 3. PI_SUBAGENT → subagent（即使带 tab 身份也不是标签页）────────
{
	process.env.PI_SUBAGENT = "1";
	process.env.PI_TAB_RUN_ID = "tab_env_2";
	assert.equal(currentProfile(), "subagent");
	const c = capabilities();
	assert.equal(c.workflow, false);
	assert.equal(c.launchTabs, false);
	assert.deepEqual(c.delegateAgents, [], "无头子 agent 禁止一切委派（防递归）");
	assert.equal(canDelegateAgent("searcher"), false);
	assert.equal(c.timerOrchestration, false);
	assert.equal(c.directExecution, true, "子 agent 自己干活");
	delete process.env.PI_SUBAGENT;
	delete process.env.PI_TAB_RUN_ID;
}

// ── 4. env PI_SESSION_PROFILE=trace-worker（休眠检测通道）─────────
{
	process.env.PI_SESSION_PROFILE = "trace-worker";
	assert.equal(currentProfile(), "trace-worker");
	assert.equal(isTraceWorker(), true);
	assert.equal(isWorkflowTab(), false);
	const c = capabilities();
	assert.equal(c.workflow, false, "trace worker 不是 workflow PM");
	assert.equal(c.lite, false);
	assert.equal(c.launchTabs, false);
	assert.deepEqual(c.delegateAgents, ["searcher"], "唯一允许委派 searcher（设计稿 §7 能力矩阵）");
	assert.equal(c.timerOrchestration, false);
	assert.equal(c.directExecution, true, "trace worker 自己动手（设计稿 §8：我就是一次完整 rollout）");
	// 委派白名单：只放行 searcher
	assert.equal(canDelegateAgent("searcher"), true);
	assert.equal(canDelegateAgent("planner"), false);
	assert.equal(canDelegateAgent("implementer"), false);
	assert.equal(canDelegateAgent("reviewer"), false);
	assert.equal(canDelegateAgent("consultant"), false);
	assert.equal(canDelegateAgent("general"), false, "agent omitted / general 必须被拒（设计稿 §55）");
	delete process.env.PI_SESSION_PROFILE;
}

// ── 5. env 非法值 → 忽略，落回推导 ─────────────────────────────────
{
	process.env.PI_SESSION_PROFILE = "hacker";
	assert.equal(currentProfile(), "main", "非法 profile 值必须被忽略");
	delete process.env.PI_SESSION_PROFILE;
}

// ── 6. flag authoritative：flag > env > 推导（fake pi 惰性读取）────
{
	// 模拟 pi：flag 值在工厂后才就绪，getFlag 惰性返回
	let flagValue: string | boolean | undefined = undefined;
	const fakePi = {
		registerFlag(_name: string, _opts: unknown) {
			/* 工厂时序：注册时不读值 */
		},
		getFlag(_name: string) {
			return flagValue;
		},
	} as unknown as ExtensionAPI;

	registerCapabilityFlags(fakePi);

	// 6a. flag 未就绪（工厂时序）→ env 兜底
	process.env.PI_SESSION_PROFILE = "workflow-tab";
	assert.equal(currentProfile(), "workflow-tab", "flag 未就绪时 env 兜底");

	// 6b. flag 就绪 → flag 压过 env（authoritative）
	flagValue = "trace-worker";
	assert.equal(currentProfile(), "trace-worker", "flag 是 authoritative source");
	assert.equal(canDelegateAgent("planner"), false);
	assert.equal(canDelegateAgent("searcher"), true);

	// 6c. flag 空串（默认值）→ 视为未设置，落回 env
	flagValue = "";
	assert.equal(currentProfile(), "workflow-tab", "flag 空串不生效");

	// 6d. flag 非法值 → 忽略，落回 env
	flagValue = "root";
	assert.equal(currentProfile(), "workflow-tab");

	// 6e. env 也清掉 → 推导分支
	flagValue = undefined;
	delete process.env.PI_SESSION_PROFILE;
	assert.equal(currentProfile(), "main");
}

// ── 7. 显式 profile 参数覆盖（供 guard 测试，不依赖进程身份）───────
{
	const t: SessionProfile = "trace-worker";
	assert.equal(capabilities(t).delegateAgents, capabilities("trace-worker").delegateAgents);
	assert.equal(canDelegateAgent("searcher", "subagent"), false, "显式 subagent 不受进程环境影响");
	assert.equal(canDelegateAgent("searcher", "trace-worker"), true);
}

// ── 8. 矩阵快照：四个 profile 的能力面一览（防无意识漂移）───────────
{
	const rows = (["main", "workflow-tab", "trace-worker", "subagent"] as const).map((p) => {
		const c = capabilities(p);
		return `${p}: workflow=${c.workflow} lite=${c.lite} tabs=${c.launchTabs} delegate=${JSON.stringify(c.delegateAgents)} timers=${c.timerOrchestration} exec=${c.directExecution}`;
	});
	assert.deepEqual(rows, [
		'main: workflow=true lite=true tabs=true delegate="*" timers=true exec=true',
		"workflow-tab: workflow=true lite=false tabs=false delegate=[\"searcher\",\"planner\",\"plan-reviewer\",\"implementer\",\"code-reviewer\",\"consultant\"] timers=false exec=false",
		"trace-worker: workflow=false lite=false tabs=false delegate=[\"searcher\"] timers=false exec=true",
		"subagent: workflow=false lite=false tabs=false delegate=[] timers=false exec=true",
	]);
}

// ── 9. 委派白名单 gate（assertDelegationAllowed，设计稿 §55）─────────
{
	// main：无条件放行（含 omitted 空列表）
	assert.deepEqual(assertDelegationAllowed([], "main"), { ok: true });
	assert.deepEqual(assertDelegationAllowed(["planner", "general"], "main"), { ok: true });

	// trace-worker：只放行 searcher；omitted / 空 / 其它角色全部拒绝
	assert.deepEqual(assertDelegationAllowed(["searcher"], "trace-worker"), { ok: true });
	const omitted = assertDelegationAllowed([], "trace-worker");
	assert.equal(omitted.ok, false, "agent omitted 必须拒绝（unrestricted child）");
	const omittedSingle = assertDelegationAllowed([""], "trace-worker");
	assert.equal(omittedSingle.ok, false, "空串 agent 同 omitted");
	const plannerReq = assertDelegationAllowed(["planner"], "trace-worker");
	assert.equal(plannerReq.ok, false);
	assert.ok(!plannerReq.ok && plannerReq.reason.includes("planner"), "拒绝原因应点名被拒 agent");
	const mixed = assertDelegationAllowed(["searcher", "implementer"], "trace-worker");
	assert.equal(mixed.ok, false, "混合委派只要含越权角色即整体拒绝");

	// subagent：一切委派拒绝
	assert.equal(assertDelegationAllowed(["searcher"], "subagent").ok, false);

	// workflow-tab：六角色放行，general 拒绝
	assert.deepEqual(assertDelegationAllowed(["planner"], "workflow-tab"), { ok: true });
	assert.equal(assertDelegationAllowed(["general"], "workflow-tab").ok, false);

	// 进程身份兜底（无显式 profile 参数）：当前环境已是 main
	assert.deepEqual(assertDelegationAllowed(["searcher"]), { ok: true });
}

console.log("capabilities tests passed");
