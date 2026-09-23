/**
 * _test_runtime_master_control.ts — Phase 5.5 M1：Master Control Service
 *
 * 覆盖（零行为变化 parity，隔离运行时目录）：
 *   getMasterStatus：空目录视图形状；attach 后视图有值
 *   setMasterCutover：无 attachment 开启 → not-attached；关闭恒允许；
 *       attach 后开启 → ok
 *   attachCurrentSession：genesis 成功；他人无 token 再 attach → 拒绝
 *   issueMasterHandoffToken：非 owner → precheck not-owner；
 *       owner → token + attachment 保留（无空窗 §6）
 *   prepareMasterHandoff：返回 doc（path + manifest）
 *
 * 运行：npm run test:runtime-master-control
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "runtime-master-control-env-"));

/** home 守卫迁移（0923）：控制层必填 cwd/initialCwd；存量用例以真实 home 通过门（仅作比较，不写 home）。 */
const HOME = homedir();

import {
	attachCurrentSession,
	getMasterStatus,
	issueMasterHandoffToken,
	prepareMasterHandoff,
	setMasterCutover,
} from "./runtime/master-control.ts";
import {
	masterAttachLogic,
	masterCutoverLogic,
	masterDetachLogic,
	masterHandoffLogic,
	masterStatusLogic,
} from "./master-tools.ts";
import { readAttachment } from "./runtime/registry.ts";
import { masterAddress } from "./runtime/address.ts";

let n = 0;
const ok = (name: string) => { n++; console.log(`ok ${n} - ${name}`); };

// ① 空视图
{
	const st = getMasterStatus();
	assert.equal(st.attachment, null);
	assert.equal(st.cutover, null);
	assert.equal(st.snapshot, null);
	assert.deepEqual(st.backlog, []);
	ok("getMasterStatus 空目录");
}

// ② cutover 门
{
	const r1 = setMasterCutover({ enabled: true, by: "sess_a" });
	assert.equal(r1.ok, false);
	const r2 = setMasterCutover({ enabled: false, by: "sess_a" });
	assert.equal(r2.ok, true);
	ok("setMasterCutover 无 attachment：开拒绝/关允许");
}

// ③ attach
{
	const a1 = attachCurrentSession({ sessionId: "sess_owner_1", cwd: HOME, initialCwd: HOME });
	assert.equal(a1.ok, true);
	if (a1.ok) assert.equal(a1.attachment.generation, 1);
	const a2 = attachCurrentSession({ sessionId: "sess_other", cwd: HOME, initialCwd: HOME });
	assert.equal(a2.ok, false);
	const r3 = setMasterCutover({ enabled: true, by: "sess_owner_1" });
	assert.equal(r3.ok, true);
	const st = getMasterStatus();
	assert.equal(st.attachment?.sessionId, "sess_owner_1");
	assert.equal(st.cutover?.enabled, true);
	assert.equal(st.snapshot?.sessionId, "sess_owner_1");
	ok("attachCurrentSession genesis + 他人拒绝 + 开启成功");
}

// ④ token
{
	const bad = issueMasterHandoffToken({ sessionId: "sess_other", reason: "t" });
	assert.equal(bad.ok, false);
	const good = issueMasterHandoffToken({ sessionId: "sess_owner_1", reason: "t" });
	assert.equal(good.ok, true);
	if (good.ok && "token" in good) assert.match(good.token!, /^ho_/);
	assert.equal(readAttachment(masterAddress())?.sessionId, "sess_owner_1");
	ok("issueMasterHandoffToken 非 owner precheck + owner 发 token 且 attachment 保留");
}

// ⑤ handoff
{
	const doc = prepareMasterHandoff({});
	assert.equal(typeof doc.path, "string");
	assert.ok(Array.isArray(doc.manifest));
	ok("prepareMasterHandoff 返回 doc");
}

// ⑥ tool 纯逻辑（显式 sessionId，与命令同文案）
{
	const s = masterStatusLogic();
	assert.match(s.text, /attachment: /);
	const cf = masterAttachLogic("sess_x", { forceStale: true }, { cwd: HOME, initialCwd: HOME });
	assert.equal(cf.isError, true);
	const co = masterCutoverLogic("sess_owner_1", { enabled: false });
	assert.equal(co.isError, undefined);
	assert.match(co.text, /关闭/);
	const bad = masterDetachLogic("sess_other");
	assert.equal(bad.isError, true);
	assert.match(bad.text, /不是当前 owner/);
	const good = masterDetachLogic("sess_owner_1", { reason: "tool-test" });
	assert.equal(good.isError, undefined);
	assert.match(good.text, /handoff token=ho_/);
	const h = masterHandoffLogic({});
	assert.equal(h.isError, undefined);
	assert.match(h.text, /manifest \d+\/\d+ 项 present/);
	ok("master-tools 纯逻辑：文案 parity + 门控");
}

console.log(`\n# pass ${n}`);
