import assert from "node:assert/strict";
import { getTabRunId, isMainSession, isSubagent, isTabSession, registerIdentityFlag } from "./identity.ts";

// 环境隔离：先清空全部身份相关环境
delete process.env.PI_SUBAGENT;
delete process.env.PI_TAB_RUN_ID;

// ── 无身份 → 主会话 ──────────────────────────────────────────────
{
	assert.equal(getTabRunId(), undefined);
	assert.equal(isMainSession(), true);
	assert.equal(isTabSession(), false);
	assert.equal(isSubagent(), false);
}

// ── env PI_TAB_RUN_ID → 标签页身份（向后兼容兜底）────────────────
{
	process.env.PI_TAB_RUN_ID = "tab_env_1";
	assert.equal(getTabRunId(), "tab_env_1");
	assert.equal(isMainSession(), false);
	assert.equal(isTabSession(), true);
	delete process.env.PI_TAB_RUN_ID;
}

// ── PI_SUBAGENT → 子 agent（即使有 tab 身份也不是标签页）─────────
{
	process.env.PI_SUBAGENT = "1";
	process.env.PI_TAB_RUN_ID = "tab_env_2";
	assert.equal(isSubagent(), true);
	assert.equal(isTabSession(), false, "子 agent 不拥有标签页身份");
	assert.equal(isMainSession(), false);
	delete process.env.PI_SUBAGENT;
	delete process.env.PI_TAB_RUN_ID;
}

// ── flag 注册 + 惰性读取（模拟 CLI flag 在扩展加载后写入）────────
{
	// 注册时 flag 值尚未就绪（工厂时序），但 getTabRunId 惰性读取到它
	let flagValue: string | boolean | undefined = undefined;
	const fakePi = {
		registerFlag: (_name: string, _opts: unknown) => {},
		getFlag: (_name: string) => flagValue,
	};

	assert.equal(registerIdentityFlag(fakePi as never), undefined, "注册时 flag 未就绪 → undefined");
	assert.equal(getTabRunId(), undefined, "flag 未写入时无身份");

	// 模拟 applyExtensionFlagValues 在扩展加载后写入
	flagValue = "tab_flag_1";
	assert.equal(getTabRunId(), "tab_flag_1", "惰性读取到 flag 值");
	assert.equal(isTabSession(), true);
	assert.equal(isMainSession(), false);

	// flag 优先于 env
	process.env.PI_TAB_RUN_ID = "tab_env_3";
	assert.equal(getTabRunId(), "tab_flag_1", "flag 优先于 env");
	delete process.env.PI_TAB_RUN_ID;

	// flag 为空串 → 退回 env
	flagValue = "";
	process.env.PI_TAB_RUN_ID = "tab_env_4";
	assert.equal(getTabRunId(), "tab_env_4", "flag 空串退回 env");
	delete process.env.PI_TAB_RUN_ID;
}

console.log("identity tests passed");
