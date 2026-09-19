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
	proposalThresholdTokens,
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
	assert.match(over.text, /已达提议线（150,000 tokens）/);
	const unknown = masterPressureLogic(null);
	assert.match(unknown.text, /no decision/);
	ok("masterPressureLogic");
}

{
	// A1 精确边界（200K 档）：149,999 差 1 → false；150,000 → true。
	// 反证①：改回旧纯 percent 规则 ⇒ 75>=75 均 true ⇒ 前者变 true ⇒ 红。
	assert.equal(meetsProposalThreshold({ tokens: 149999, contextWindow: 200000, percent: 75 }), false);
	assert.equal(meetsProposalThreshold({ tokens: 150000, contextWindow: 200000, percent: 75 }), true);
	ok("A1 精确边界 200K：149999 false / 150000 true");
}

{
	// A2 1M 解冻：line(1M)=round(0.75×min(1M,200K))=150,000；161K 实测最重会话可达。
	// 反证②：旧规则（15/14.9/16.1 均 <75）⇒ 全 false ⇒ 红。
	assert.equal(meetsProposalThreshold({ tokens: 150000, contextWindow: 1000000, percent: 15 }), true);
	assert.equal(meetsProposalThreshold({ tokens: 149999, contextWindow: 1000000, percent: 14.9 }), false);
	assert.equal(meetsProposalThreshold({ tokens: 161000, contextWindow: 1000000, percent: 16.1 }), true);
	ok("A2 1M 解冻：150000 true / 149999 false / 161000 最重会话可达 true");
}

{
	// A3 旋钮保活（非裸 CAP）：threshold=0.5 @1M → line=100,000；{100000,1M,10} → true。
	// 裸 CAP 方案此条必红（任何 p≥15% 都得 150K）⇒ 钉死设计选择。
	assert.equal(meetsProposalThreshold({ tokens: 100000, contextWindow: 1000000, percent: 10 }, 0.5), true);
	ok("A3 旋钮保活：0.5@1M 线=100K");
}

{
	// A4 退化/门：percent=null 恒 false（含 tokens=1/W=2 旧例）；percent 在而 tokens/W 缺 → 旧行为。
	assert.equal(meetsProposalThreshold({ tokens: 1, contextWindow: 2, percent: null }), false);
	assert.equal(meetsProposalThreshold({ tokens: null, contextWindow: null, percent: 74.9 }), false);
	assert.equal(meetsProposalThreshold({ tokens: null, contextWindow: null, percent: 75 }), true);
	ok("A4 退化/门：percent=null 恒 false；缺 tokens/W 走 percent 兜底");
}

{
	// proposalThresholdTokens 三档线位（128K/200K/1M）钉死
	assert.equal(proposalThresholdTokens(128000), 96000);
	assert.equal(proposalThresholdTokens(199999), 149999);
	assert.equal(proposalThresholdTokens(200000), 150000);
	assert.equal(proposalThresholdTokens(200001), 150000);
	assert.equal(proposalThresholdTokens(1000000), 150000);
	assert.equal(proposalThresholdTokens(1000000, 0.5), 100000);
	ok("proposalThresholdTokens 三档线位");
}

console.log(`\n# pass ${n}`);
