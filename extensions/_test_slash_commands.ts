/**
 * _test_slash_commands.ts — 斜杠命令回归门（2026-10-20）。
 *
 * 三层：
 *   S1 纯函数（GUI 补全逻辑）：parseSlashDraft / filterCommands / slashKeyAction / moveIndex
 *   S2 命令名白名单（后端）：unknown-command / commands-unavailable / dispatched 三态
 *   S3 真实接线：session_start 注册 → 真实 fs.watch → slash 被派发（sendUserMessage 收到原样正文）
 *
 * 反例守卫（都是**读 pi 源码得到的真实风险**，不是假想）：
 *   - `sendUserMessage` 默认 `expandPromptTemplates: false`（agent-session.js:1803）
 *     ⇒ 不显式传 true，命令会被当正文发出去
 *   - 命令名不在白名单 ⇒ pi 会 `return false` 退回 prompt ⇒ `/typo` 污染上下文
 *   - slash 不得走 message-outbox（那里会追加 eventId 标记，破坏命令解析）
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyCommandSelection,
	filterCommands,
	moveIndex,
	parseSlashDraft,
	slashKeyAction,
	sourceHint,
} from "../gui/src/slashCommands.ts";
import { commandsDir, normalizeCommands, readCommandNames, writeCommandsSnapshot } from "./runtime/commands-snapshot.ts";
import { controlDir, newControlRequest, readControlRequest, writeControlRequest } from "./runtime/session-control.ts";
import { executeControlAction, registerSessionControl } from "./runtime/session-control-register.ts";

let n = 0;
const ok = (m: string): void => {
	n++;
	console.log(`ok ${n} - ${m}`);
};

const tmp = mkdtempSync(join(tmpdir(), "sw-slash-"));

try {
	// ── S1 GUI 补全纯函数 ────────────────────────────────────────────
	{
		// 何时弹补全
		assert.deepEqual(parseSlashDraft("/mod"), { active: true, prefix: "mod" });
		assert.deepEqual(parseSlashDraft("/"), { active: true, prefix: "" });
		assert.equal(parseSlashDraft("/model xxx").active, false, "有空格 ⇒ 参数段，不再补全命令名");
		assert.equal(parseSlashDraft("hello").active, false);
		assert.equal(parseSlashDraft("//path").active, false, "// 开头不算命令（路径/注释习惯）");

		// 排序：extension 在前，skill/prompt 在后；完全匹配顶到第一
		const cmds = [
			{ name: "skill:review", source: "skill" as const },
			{ name: "model", source: "extension" as const },
			{ name: "models", source: "extension" as const },
			{ name: "prompt:plan", source: "prompt" as const },
		];
		const filtered = filterCommands(cmds, "mod");
		assert.deepEqual(filtered.map((c) => c.name), ["model", "models"], "只留前缀匹配，且 extension 靠前");
		const exact = filterCommands(cmds, "model");
		assert.equal(exact[0]!.name, "model", "完全匹配顶到第一（打全了回车即选）");
		assert.equal(filterCommands(cmds, "skill")[0]!.name, "skill:review", "skill 也能补全");

		// 语义标注：skill/prompt 必须标「插入正文」（它们会被展开成正文写进对话）
		assert.equal(sourceHint("extension"), null, "extension 是真命令，不标注");
		assert.equal(sourceHint("skill"), "插入正文");
		assert.equal(sourceHint("prompt"), "插入正文");

		// 插入后退出补全态（末尾空格）
		const next = applyCommandSelection("model");
		assert.equal(next, "/model ");
		assert.equal(parseSlashDraft(next).active, false, "选中后退出补全态");

		// 键盘动作
		assert.equal(slashKeyAction("ArrowUp", { open: true, candidateCount: 3 }), "up");
		assert.equal(slashKeyAction("Enter", { open: true, candidateCount: 3 }), "accept");
		assert.equal(slashKeyAction("Enter", { open: false, candidateCount: 3 }), "none", "面板关着时 Enter 正常发送");
		assert.equal(slashKeyAction("Enter", { open: true, candidateCount: 0 }), "none", "没候选时 Enter 正常发送");
		assert.equal(slashKeyAction("Escape", { open: true, candidateCount: 3 }), "dismiss");

		// 下标循环
		assert.equal(moveIndex(-1, 1, 3), 0, "未选时向下 → 0");
		assert.equal(moveIndex(-1, -1, 3), 2, "未选时向上 → 末尾");
		assert.equal(moveIndex(2, 1, 3), 0, "越过末尾回环");
		assert.equal(moveIndex(0, -1, 3), 2, "越过开头回环");
		assert.equal(moveIndex(0, 1, 0), -1, "无候选 → -1");
		ok("S1 GUI 补全：补全态判定 / 排序 / 语义标注 / 键盘 / 回环");
	}

	// ── S2 命令名白名单（后端三态）───────────────────────────────────
	{
		const cdir = commandsDir(tmp);
		const names = new Set(["model", "compact"]);
		writeCommandsSnapshot("cs1", normalizeCommands([
			{ name: "model", source: "extension", description: "切换模型" },
			{ name: "compact", source: "extension" },
			{ name: "", source: "extension" }, // 空名丢弃
		]), { dir: cdir });

		assert.deepEqual([...readCommandNames("cs1", cdir)!].sort(), ["compact", "model"], "快照读回命令名");
		assert.equal(readCommandNames("nope", cdir), null, "快照缺失 ⇒ null");

		const req = newControlRequest({
			sessionId: "cs1",
			action: "slash",
			commandKey: "sl1",
			payload: { name: "model", args: "glm-5.2" },
		});
		let sent: string | null = null;
		let sentOpts: unknown = null;

		// dispatched：命令在白名单里
		const r1 = executeControlAction(req, { sessionManager: {} }, {
			sendUserMessage: (body, o) => { sent = body; sentOpts = o; },
			commandNames: names,
		});
		assert.deepEqual(r1, { ok: true, result: "dispatched" });
		assert.equal(sent, "/model glm-5.2", "正文是 `/<name> <args>`，**原样**（无 eventId 装饰）");
		assert.deepEqual(sentOpts, { expandPromptTemplates: true }, "expandPromptTemplates 必须显式 true");

		// 无 args
		sent = null;
		executeControlAction(
			newControlRequest({ sessionId: "cs1", action: "slash", commandKey: "sl2", payload: { name: "compact", args: "" } }),
			{},
			{ sendUserMessage: (b) => { sent = b; }, commandNames: names },
		);
		assert.equal(sent, "/compact", "无 args 时不带尾空格");

		// unknown-command：命令名不在快照里（防 /typo 被当正文发给 LLM）
		const r2 = executeControlAction(
			newControlRequest({ sessionId: "cs1", action: "slash", commandKey: "sl3", payload: { name: "modle", args: "" } }),
			{},
			{ sendUserMessage: () => { throw new Error("不该被调用"); }, commandNames: names },
		);
		assert.deepEqual(r2, { ok: true, result: "unknown-command" }, "拼错的命令名被拒，不发给 LLM");

		// commands-unavailable：快照不可用
		const r3 = executeControlAction(req, {}, { sendUserMessage: () => {}, commandNames: null });
		assert.deepEqual(r3, { ok: true, result: "commands-unavailable" });

		// stale-ctx：sendUserMessage 缺失
		const r4 = executeControlAction(req, {}, { commandNames: names });
		assert.deepEqual(r4, { ok: true, result: "stale-ctx" });

		// 抛错 → failed（不吞成成功）
		const r5 = executeControlAction(req, {}, { sendUserMessage: () => { throw new Error("boom"); }, commandNames: names });
		assert.equal(r5.ok, false);
		ok("S2 白名单：dispatched / unknown-command / commands-unavailable / stale-ctx / 抛错");
	}

	// ── S3 真实接线：fs.watch → slash 派发 ──────────────────────────
	{
		const sdir = controlDir(join(tmp, "s3"));
		const cdir = commandsDir(join(tmp, "s3"));
		writeCommandsSnapshot("s3", normalizeCommands([{ name: "model", source: "extension" }]), { dir: cdir });

		const handlers = new Map<string, (event: unknown, ctx?: unknown) => void>();
		const sent: { body: string; opts?: unknown }[] = [];
		const pi = {
			on: (event: string, cb: (e: unknown, c?: unknown) => void) => {
				handlers.set(event, cb);
				return () => handlers.delete(event);
			},
			sendUserMessage: (body: string, opts?: unknown) => { sent.push({ body, opts }); },
			getCommands: () => [{ name: "model", source: "extension", description: "切换模型" }],
		} as never;

		const dispose = registerSessionControl(pi, { dir: sdir, cmdsDir: cdir, tickMs: 60_000 });
		handlers.get("session_start")!({}, { sessionManager: { sessionId: "s3" } });

		// session_start 时应写了一份命令快照（基线）
		assert.deepEqual([...readCommandNames("s3", cdir)!], ["model"], "session_start 写了命令快照基线");

		// 落一条 pending slash 请求（模拟 daemon）
		const req = newControlRequest({
			sessionId: "s3",
			action: "slash",
			commandKey: "wire_slash",
			payload: { name: "model", args: "glm-5.2" },
		});
		writeControlRequest(req, sdir);

		const deadline = Date.now() + 3000;
		while (sent.length === 0 && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 50));
		}
		assert.equal(sent.length, 1, "真实 fs.watch 触发 ⇒ sendUserMessage 被调用");
		assert.equal(sent[0]!.body, "/model glm-5.2");
		assert.deepEqual(sent[0]!.opts, { expandPromptTemplates: true });
		assert.equal(readControlRequest(req.id, sdir)?.result, "dispatched", "回写 dispatched");

		dispose();
		ok("S3 真实接线：session_start 写快照 → 真实 fs.watch → sendUserMessage('/model glm-5.2', expand)");
	}

	// ── S4 静态守卫 ──────────────────────────────────────────────────
	{
		const reg = readFileSync(new URL("./runtime/session-control-register.ts", import.meta.url), "utf8");
		// 反例守卫：expandPromptTemplates 必须显式传（默认 false 会把命令当正文发出去）
		assert.ok(
			/expandPromptTemplates: true/.test(reg),
			"必须显式 expandPromptTemplates: true（sendUserMessage 默认 false）",
		);
		// 命令快照必须**两个时机**都刷新：session_start（基线）+ 每轮（懒刷新）
		// 为什么不能只一处：`bindExtensions` 里 `emit(session_start)` 在
		// `extendResourcesFromExtensions` **之前** ⇒ 只在 session_start 写会漏掉 skill 命令。
		const startIdx = reg.indexOf('pi.on("session_start"');
		const msgIdx = reg.indexOf('pi.on("message_start"');
		assert.ok(startIdx >= 0 && msgIdx >= 0, "session_start 与 message_start 都注册了");
		const startBlock = reg.slice(startIdx, msgIdx > startIdx ? msgIdx : undefined);
		const msgBlock = reg.slice(msgIdx);
		assert.ok(/refreshCommands\(/.test(startBlock), "session_start 里写了命令快照基线");
		assert.ok(/refreshCommands\(/.test(msgBlock), "每轮（message_start）里懒刷新命令快照（补 skill 命令）");

		const proto = readFileSync(new URL("./runtime/protocol.ts", import.meta.url), "utf8");
		assert.ok(/"session\.slash"/.test(proto), "session.slash 在 COMMAND_TYPES 白名单");

		// 反例守卫：slash 不得塞进 message-outbox（那里会追加 eventId 标记破坏命令解析）
		const executor = readFileSync(new URL("./runtime/command-executor.ts", import.meta.url), "utf8");
		const slashFn = executor.slice(executor.indexOf("function runSessionSlash"));
		assert.ok(!/newOutboxItem/.test(slashFn.slice(0, 2000)), "runSessionSlash 不得走 outbox（会破坏命令解析）");
		assert.ok(/writeControlRequest/.test(slashFn.slice(0, 2000)), "runSessionSlash 走控制通道");

		const server = readFileSync(new URL("./runtime-host/server.ts", import.meta.url), "utf8");
		assert.ok(/session-commands/.test(server), "server.ts 暴露 GET /v1/session-commands/:sid");
		ok("S4 静态：expand 显式 / 快照三处刷新 / 协议白名单 / 不走 outbox / 端点");
	}
} finally {
	rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n_test_slash_commands: all assertions passed (${n})`);
