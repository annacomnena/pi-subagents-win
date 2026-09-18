/**
 * _test_runtime_master_pressure.ts — Phase 5.5 M4：Context Pressure Gauge
 *
 * 覆盖（纯函数，无副作用）：
 *   缺席/非法输入 → 全 null，不抛错
 *   阈值判定：75% 线上下 + percent null 恒 false（不猜，§9）
 *   自定义阈值；展示文案（已知/未知）
 *   masterPressureLogic：达线提示 / 未知提示
 *
 * 运行：npm run test:runtime-master-pressure
 */

import assert from "node:assert/strict";

import { masterPressureLogic } from "./master-tools.ts";
import {
	DEFAULT_PROPOSAL_PERCENT,
	formatPressure,
	meetsProposalThreshold,
	readPressure,
} from "./runtime/master-pressure.ts";

let n = 0;
const ok = (name: string) => { n++; console.log(`ok ${n} - ${name}`); };

{
	assert.deepEqual(readPressure(null), { tokens: null, contextWindow: null, percent: null });
	assert.deepEqual(readPressure(undefined), { tokens: null, contextWindow: null, percent: null });
	assert.deepEqual(readPressure({}), { tokens: null, contextWindow: null, percent: null });
	assert.deepEqual(readPressure({ tokens: -5, contextWindow: NaN, percent: "76" as never }),
		{ tokens: null, contextWindow: null, percent: null });
	ok("缺席/非法输入归一化");
}

{
	assert.equal(DEFAULT_PROPOSAL_PERCENT, 0.75);
	assert.equal(meetsProposalThreshold({ tokens: 60000, contextWindow: 200000, percent: 30 }), false);
	assert.equal(meetsProposalThreshold({ tokens: null, contextWindow: null, percent: 74.9 }), false);
	assert.equal(meetsProposalThreshold({ tokens: null, contextWindow: null, percent: 75 }), true);
	assert.equal(meetsProposalThreshold({ tokens: 1, contextWindow: 2, percent: null }), false);
	assert.equal(meetsProposalThreshold({ tokens: null, contextWindow: null, percent: 90 }, 0.9), true);
	ok("阈值判定 + null 恒 false");
}

{
	assert.match(formatPressure({ tokens: 152000, contextWindow: 200000, percent: 76 }), /76%.*152000\/200000/);
	assert.match(formatPressure({ tokens: null, contextWindow: null, percent: null }), /未知.*no decision/);
	ok("展示文案");
}

{
	const over = masterPressureLogic({ tokens: 152000, contextWindow: 200000, percent: 76 });
	assert.match(over.text, /提议线/);
	const unknown = masterPressureLogic(null);
	assert.match(unknown.text, /no decision/);
	ok("masterPressureLogic");
}

console.log(`\n# pass ${n}`);
