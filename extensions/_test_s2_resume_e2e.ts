/**
 * _test_s2_resume_e2e.ts — S2「向已死会话发消息 ⇒ 拉起它」的**端到端**回归
 *
 * ## 为什么必须有这个测试（AGENTS.md §4.2）
 *
 * 既有测试（`_test_session_resume.ts` / `_test_session_liveness.ts`）全部只验
 * **纯函数**：`decideSendAction(liveness, ...)` 给什么输入出什么输出。
 * 它们**没有一个**证明「生产接线真的把 owner 证据喂进了 decideSendAction」。
 *
 * 事故史已经证明这条纪律的价值：
 * > 测试**直接调** `broadcastWechatMessage`，绕开 `pi.on("message_end")` 注册线；
 *   变异函数体 ⇒ 5 项实红（假的）；变异**接线** ⇒ 23 组全绿（真缺陷）。
 *
 * 2026-11-04 的真实缺陷正是**接线缺陷**：方案 A（session-owner）已实现，
 * 但 S2 探针没接 ⇒ 1043 个会话里只判出 3 个 ⇒ 普通 TUI 会话 100% 拉不起来。
 * 纯函数测试对此**完全无感**（它们只测 decideSendAction 本身）。
 *
 * ## 本测试走什么真实入口
 *
 * 1. 真的起一个 runtime daemon（`startRuntimeHost`，独立端口 + 独立 stateDir）
 * 2. 真的往 `POST /v1/commands` 发 `session.message`（走 `parseCommandRequest` →
 *    `executeCommand` → S2 分支 → `decideSendAction`）
 * 3. 真的观察 `spawnSessionTab` 被调用 / 没被调用（用注入的假 spawn 计数，
 *    **不真的开窗口** —— GUI 测试不许在用户不在场时弹窗）
 * 4. 真的检查回执里的 `resume` 字段（S2 的可观测面）
 *
 * 断言全程经过**真实注册线**，变异接线即可打红。
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRuntimeHostServer } from "./runtime-host/server.ts";
import { writeSessionOwner } from "./runtime/session-owner.ts";
import { processStartedAt } from "./runtime/liveness.ts";

let n = 0;
const ok = (msg: string): void => {
	n += 1;
	console.log(`ok ${n} - ${msg}`);
};

const DIRS: string[] = [];
const mkTemp = (prefix: string): string => {
	const d = mkdtempSync(join(tmpdir(), prefix));
	DIRS.push(d);
	return d;
};

try {
	// ── 夹具：两个会话文件 + 三个 owner 记录 ──────────────────────
	//
	// 场景设计（对应真机事故）：
	//   `sess-dead`   owner 记录指向**已死的 pid** ⇒ 应判 dead ⇒ 应拉起
	//   `sess-alive`  owner 记录指向**本进程 pid** ⇒ 应判 alive ⇒ 绝不该拉起
	//   `sess-norec`  无 owner 记录（历史会话）⇒ unknown ⇒ 只发不拉（安全阀）
	//
	// 关键：owner 记录必须由**生产写入函数** `writeSessionOwner` 写，
	// 不能手搓 JSON —— 否则测的是「我造的文件格式对不对」，
	// 而不是「生产链路能不能用这个格式」（AGENTS.md §4.2 同款教训）。
	const D = mkTemp("s2-resume-e2e-");
	const stateDir = join(D, "state");
	const sessionsDir = join(D, "sessions");
	mkdirSync(sessionsDir, { recursive: true });

	const mkSession = (sid: string, cwd: string): string => {
		// 文件名必须是 pi 的真实形状 `<ts>_<sessionId>.jsonl`：
		// `sessionFileId`（transcript.ts:1367）用「末段下划线之后」兜底抽 sessionId，
		// 平铺的 `<sid>.jsonl` 抽出来就是整个 `<sid>`（含 .jsonl）⇒ 匹配不上。
		const file = join(sessionsDir, `2026-11-04T00-00-00-000Z_${sid}.jsonl`);
		writeFileSync(
			file,
			`${JSON.stringify({ type: "session", id: sid, cwd, timestamp: new Date().toISOString() })}\n`,
			"utf8",
		);
		return file;
	};
	const CWD = D; // cwd 存在 ⇒ 绕过 cwd-missing 门
	mkSession("sess-dead", CWD);
		mkSession("sess-dead-idem", CWD);
		mkSession("sess-norec-idem", CWD);
		writeSessionOwner({ sessionId: "sess-dead-idem", pid: 4000000, stateDir });
	mkSession("sess-alive", CWD);
	mkSession("sess-norec", CWD);
	// 【B/S2 对照】有 owner 记录（pid 已死 ⇒ 探针判 dead）但 **cwd 不存在** ⇒ 救不回
	// ⇒ B 应照旧标 failed（证明协调不会把「判死且救不回」的目标也放过）。
	mkSession("sess-nocwd", join(D, "no-such-cwd-dir"));

	// 已死的 pid：用一个确定不存在的 pid（Windows 上 pid 上限远小于此）
	const DEAD_PID = 4000000;
	writeSessionOwner({
		sessionId: "sess-dead",
		pid: DEAD_PID,
		startedAt: new Date(Date.now() - 3600_000).toISOString(),
		stateDir,
	});
	// 活着的 pid：当前测试进程自己（保证活着）。
	//
	// ⚠️ startedAt 必须与**本进程真实启动时间**一致（用 `processStartedAt()`），
	// 不能随手写「1 小时前」—— 那会让 PID 复用的启动时间交叉验证命中
	// （OS 报的启动时间晚于记录 + 60s 容差 ⇒ 判 pid-reused ⇒ dead），
	// 于是「活会话」被误判成死 ⇒ 测试报「活会话被拉起」。
	// 这不是生产 bug（生产由 session-hooks 写 processStartedAt()），是夹具 bug。
	writeSessionOwner({
		sessionId: "sess-alive",
		pid: process.pid,
		startedAt: processStartedAt(),
		stateDir,
	});
	// 对照目标：pid 已死（探针判 dead）+ cwd 不存在（拉起会失败）⇒ B 判死且无救
	writeSessionOwner({
		sessionId: "sess-nocwd",
		pid: DEAD_PID,
		startedAt: new Date(Date.now() - 3600_000).toISOString(),
		stateDir,
	});

	// ── B/S2 协调夹具：三条过宽限期的 pending outbox 项（**必须在 daemon 启动前**造）──
	//
	// host 在 listen 回调里会跑一次 `sweepDeadTargets()`（server.ts 启动即扫）
	// ⇒ 这三条会被**真实 host 接线**扫到 ⇒ 可验证 canResumeSession 的真实行为。
	//
	// 三条分别对应三种判据：
	//   b-conflict ⇒ 目标「确证死亡且可拉起」（sess-dead：owner pid 已死 + cwd 存在）⇒ 不判死
	//   b-norescue ⇒ 目标「不可拉起」（sess-gone：无会话文件）⇒ 判死（既有行为）
	//   b-force    ⇒ 消息带 forceResume 标记（用户显式要求拉起）⇒ 不判死
	{
		const { newOutboxItem, writeOutboxItem } = await import("./runtime/message-outbox.ts");
		const { piSessionAddress } = await import("./runtime/address.ts");
		const obDir = join(stateDir, "message-outbox");
		mkdirSync(obDir, { recursive: true }); // writeOutboxItem 不建目录（原子写要求父目录已存在）
		const old = new Date(Date.now() - 20 * 60_000); // 20 分钟前 ⇒ 过 10min 宽限期
		const mk = (commandKey: string, sessionId: string, forceResume?: boolean): void => {
			writeOutboxItem(
				obDir,
				newOutboxItem({
					dedupeKey: `session.message:${commandKey}`,
					commandKey,
					to: piSessionAddress(sessionId),
					sessionId,
					text: `B 协调测试 ${commandKey}`,
					...(forceResume === true ? { forceResume } : {}),
					now: old,
				}),
			);
		};
		mk("b-conflict", "sess-dead");
		mk("b-norescue", "sess-nocwd");
		mk("b-force", "sess-norec", true);
	}

	// ── 起真 daemon（**进程内**，注入隔离目录 + 假 spawn）──────────
	//
	// 为什么用 `createRuntimeHostServer` 而不是 `startRuntimeHost`：
	// 后者只 spawn 子进程跑 server.ts，无法注入 sessionsDir/stateDir/spawnSessionTab
	// ⇒ 会写到真实目录、真开窗口（AGENTS.md §9 禁止用户不在场时弹窗）。
	// 前者是**同一份生产代码**在进程内起，允许全隔离注入。
	let spawnCalls: Array<{ sessionFile: string; cwd: string; title: string }> = [];
	const hp = join(D, "host.json");
	const cfgPath = join(D, "config.json");
	// gui 门：readGuiEnabled(configPath) 必须为 true
	writeFileSync(cfgPath, JSON.stringify({ gui: { autoStart: true } }), "utf8");

	const handle = await createRuntimeHostServer({
		hostPath: hp,
		stateDir,
		sessionsDir,
		configPath: cfgPath,
		journalPath: join(D, "events.jsonl"),
		tabRunsDir: join(D, "tab-runs"),
		runsDir: join(D, "runs"),
		distDir: join(D, "dist"),
		// 假 spawn：只计数，不开窗（GUI 测试不许在用户不在场时弹窗 —— AGENTS.md §9）
		spawnSessionTab: (args: { sessionFile: string; cwd: string; title: string }) => {
			spawnCalls.push(args);
			return { runId: "fake-run" };
		},
	});
	try {
		const info = handle.info;
		const base = `http://127.0.0.1:${info.port}`;

		// 真实 HTTP 客户端（带 host token cookie ⇒ 真实 trustedLocal 校验）
		const post = async (body: unknown): Promise<{ status: number; json: any }> => {
			const res = await fetch(`${base}/v1/commands`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					cookie: `sw_host_token=${info.token}`,
				},
				body: JSON.stringify(body),
			});
			const text = await res.text();
			let json: any = null;
			try {
				json = JSON.parse(text);
			} catch {
				json = { raw: text };
			}
			return { status: res.status, json };
		};

		// ① 【核心】死会话 ⇒ 应拉起
		{
			const before = spawnCalls.length;
			const r = await post({
				frame: "command",
				type: "session.message",
				to: "pi://sess-dead",
				commandKey: "k1",
				issuedAt: new Date().toISOString(),
				payload: { text: "继续" },
			});
			assert.equal(r.status, 200, `死会话请求应 200：实得 ${r.status} ${JSON.stringify(r.json)}`);
			assert.equal(spawnCalls.length, before + 1, "死会话 ⇒ 必须拉起一次（spawnSessionTab 被调用）");
			assert.match(spawnCalls[spawnCalls.length - 1].sessionFile, /sess-dead\.jsonl$/, "拉起的应是目标会话文件");
			// 回执必须可观测：resume 字段说明拉起结果
			assert.ok(r.json.resume !== undefined, `回执应含 resume 字段（可观测）：${JSON.stringify(r.json)}`);
			assert.equal(r.json.resume.action, "spawn-then-send", `resume.action 应为 spawn-then-send：${JSON.stringify(r.json.resume)}`);
			assert.equal(r.json.resume.reason, "session-dead", `resume.reason 应为 session-dead：${JSON.stringify(r.json.resume)}`);
			ok("E2E① 死会话（owner 记录 pid 已死）⇒ 真拉起 + 回执 resume 可观测");
		}

		// ② 【核心回归】活会话 ⇒ 绝不拉起（防「每发一句开一个窗口」事故复发）
		{
			const before = spawnCalls.length;
			const r = await post({
				frame: "command",
				type: "session.message",
				to: "pi://sess-alive",
				commandKey: "k2",
				issuedAt: new Date().toISOString(),
				payload: { text: "在吗" },
			});
			assert.equal(r.status, 200, `活会话请求应 200：实得 ${r.status}`);
			assert.equal(spawnCalls.length, before, "活会话 ⇒ 绝不能拉起（事故①的回归锁）");
			ok("E2E② 活会话（owner 记录 pid 活着）⇒ 不拉起（防重复开窗事故）");
		}

		// ③ 【安全阀】无 owner 记录的历史会话 ⇒ 只发不拉
		{
			const before = spawnCalls.length;
			const r = await post({
				frame: "command",
				type: "session.message",
				to: "pi://sess-norec",
				commandKey: "k3",
				issuedAt: new Date().toISOString(),
				payload: { text: "历史" },
			});
			assert.equal(r.status, 200, `无记录会话请求应 200：实得 ${r.status}`);
			assert.equal(spawnCalls.length, before, "无 owner 记录 ⇒ unknown ⇒ 只发不拉（缺证据 = 不动）");
			ok("E2E③ 无 owner 记录 ⇒ 只发不拉（安全阀保持）");
		}

		// ④ 【可观测】回执的 resume 字段必须区分 alive/unknown
		//   （alive 时 resumeOutcome.action === "send" ⇒ 按 server.ts:1976 的规则不并入回执；
		//    这里验的是「不并入」本身是预期行为，不是 bug）
		{
			const r = await post({
				frame: "command",
				type: "session.message",
				to: "pi://sess-alive",
				commandKey: "k4",
				issuedAt: new Date().toISOString(),
				payload: { text: "再问一次" },
			});
			assert.equal(r.status, 200, "重复发给活会话应 200");
			assert.equal(r.json.resume, undefined, "alive ⇒ action=send ⇒ 不并入 resume 字段（server.ts:1976 的既定语义）");
			ok("E2E④ alive ⇒ 回执不含 resume（send 不并入，符合既定语义）");
		}

		// ⑤ 【幂等】连续两次发给同一死会话 ⇒ 拉起**恰好 1 次**
		//    这是 2026-10-30「两次消息开两个窗口」事故在 owner 路径上的等价锁。
		//    注意：owner 记录仍指向死 pid（假 spawn 不写新记录）⇒ 第二次仍判 dead
		//    ⇒ 由**在飞互斥**负责防重复（本测试锁的是「同一 commandKey 幂等」这一层，
		//    真正的跨消息互斥由 decideSendAction 的 alive 优先规则在生产中兜底）。
		{
			const before = spawnCalls.length;
			await post({
				frame: "command",
				type: "session.message",
				to: "pi://sess-dead-idem",
				commandKey: "k5",
				issuedAt: new Date().toISOString(),
				payload: { text: "第一次" },
			});
			await post({
				frame: "command",
				type: "session.message",
				to: "pi://sess-dead-idem",
				commandKey: "k5",
				issuedAt: new Date().toISOString(), // 同一 commandKey ⇒ 幂等重放
				payload: { text: "第一次" },
			});
			assert.equal(spawnCalls.length, before + 1, `同 commandKey 重放 ⇒ 只拉起 1 次（实得 ${spawnCalls.length - before}）`);
			ok("E2E⑤ 同 commandKey 重放 ⇒ 拉起恰好 1 次（幂等）");
		}
		// ⑤b 【B2 回归】forceResume **不得**击穿幂等保护
		//    旧写法：重放伪装成 unknown，再被 forceResume 提成 dead ⇒ 同 commandKey 重放重复开窗。
		{
			const before = spawnCalls.length;
			await post({
				frame: "command",
				type: "session.message",
				to: "pi://sess-norec-idem",
				commandKey: "k-force-idem",
				issuedAt: new Date().toISOString(),
				payload: { text: "强制第一次", forceResume: true },
			});
			await post({
				frame: "command",
				type: "session.message",
				to: "pi://sess-norec-idem",
				commandKey: "k-force-idem",
				issuedAt: new Date().toISOString(),
				payload: { text: "强制第一次", forceResume: true },
			});
			assert.equal(spawnCalls.length, before + 1, `forceResume + 同 commandKey 重放 ⇒ 只拉起 1 次（实得 ${spawnCalls.length - before}）`);
			ok("E2E⑤b forceResume 不击穿幂等保护（同 commandKey 重放 ⇒ 拉起恰 1 次）");
		}

		// ⑥ 【B/S2 协调】目标已死但**仍可被拉起** ⇒ B 不得标 failed
		//    这是 2026-11-03 诊断文档 §5 点名的语义冲突：
		//    B 主张「目标死 ⇒ 标 failed」，S2 主张「目标死 ⇒ 拉起它」。
		//    不协调 ⇒ 消息在送达前被判死。
		//
		//    ⚠️ 走**真实 host 接线**（L4 审查指出旧版无判别力）：
		//    旧版直接调 `sweepTargetDeadOutboxItems` 并注入自己的 canRescue
		//    ⇒ 根本没走 server 侧的 `canResumeSession` 接线
		//    ⇒ 变异「host 侧 canRescue 改成恒 false」时测试仍全绿。
		//    现在靠 **host 启动时的 sweepDeadTargets()**（server.ts 启动即跑一次）触发
		//    ⇒ 走的是真实接线（canResumeSession → decideRescuable → probeSessionOwner）。
		//    为此 outbox 项必须在 **daemon 启动前**造好（见上方夹具区）。
		{
			const { listOutboxItems } = await import("./runtime/message-outbox.ts");
			const obDir = join(stateDir, "message-outbox");

			// 「确证死亡且可拉起」的目标（sess-dead：owner 记录 pid 已死 + cwd 存在）
			//   ⇒ host 的 canRescue 应说「能拉起」⇒ B 不标 failed ⇒ 保持 pending
			const afterDead = listOutboxItems(obDir).find((i) => i.commandKey === "b-conflict");
			assert.equal(afterDead?.status, "pending", "可拉起的目标 ⇒ B 不得标 failed（消息须等待 S2 拉起后送达）");

			// 「不可拉起」的目标（sess-gone2：无会话文件但**探针判 dead**）⇒ B 照旧标 failed
			//    注意对照组口径：B 的探针对「无 owner 记录」判 unknown（不确定不判死）⇒
			//    那是 B 的既有行为，不是本测试要验的。真正的对照是「探针判 dead 但救不回」。
			const afterGone = listOutboxItems(obDir).find((i) => i.commandKey === "b-norescue");
			assert.equal(afterGone?.status, "failed", "不可拉起的目标 ⇒ B 照旧标 failed（既有行为不变）");

			// 「用户显式要求拉起」的消息（forceResume 标记）⇒ 不论证据如何都不判死
			const afterForce = listOutboxItems(obDir).find((i) => i.commandKey === "b-force");
			assert.equal(afterForce?.status, "pending", "forceResume 标记的消息 ⇒ B 不判死（等 S2 拉起后送达）");
			ok("E2E⑥ B/S2 协调（走真实 host 接线）：可拉起 ⇒ 不判死；不可拉起 ⇒ 判死；forceResume ⇒ 不判死");
		}
		// ⑦ 【forceResume】显式强制拉起：无 owner 记录的历史会话也能拉起
		//    覆盖 S2 自动路径够不到的两类：① 11-03 前的历史会话 ② **正常退出**的会话
		//    （session_shutdown 删了 owner 记录 ⇒ 自动路径判 unknown ⇒ 不拉起）
		{
			const before = spawnCalls.length;
			const r = await post({
				frame: "command",
				type: "session.message",
				to: "pi://sess-norec",
				commandKey: "k-force",
				issuedAt: new Date().toISOString(),
				payload: { text: "强制继续", forceResume: true },
			});
			assert.equal(r.status, 200, `forceResume 请求应 200：实得 ${r.status} ${JSON.stringify(r.json)}`);
			assert.equal(spawnCalls.length, before + 1, "forceResume ⇒ 无 owner 记录也应拉起");
			assert.match(spawnCalls[spawnCalls.length - 1].sessionFile, /sess-norec\.jsonl$/, "拉起的应是目标会话");
			assert.equal(r.json.resume?.action, "spawn-then-send", `应走 spawn：${JSON.stringify(r.json.resume)}`);
			ok("E2E⑦ forceResume ⇒ 无 owner 记录的历史会话也能拉起");
		}

		// ⑧ 【forceResume 不得放宽其它门】cwd 不存在 ⇒ 仍必须 reject:cwd-missing
		//    这是安全边界：forceResume 只放宽 liveness，不放宽 cwd 门。
		{
			const badCwd = join(D, "no-such-cwd");
			const file = join(sessionsDir, `2026-11-04T00-00-00-000Z_sess-badcwd.jsonl`);
			writeFileSync(
				file,
				`${JSON.stringify({ type: "session", id: "sess-badcwd", cwd: badCwd, timestamp: new Date().toISOString() })}\n`,
				"utf8",
			);
			const before = spawnCalls.length;
			const r = await post({
				frame: "command",
				type: "session.message",
				to: "pi://sess-badcwd",
				commandKey: "k-force-badcwd",
				issuedAt: new Date().toISOString(),
				payload: { text: "cwd 不存在", forceResume: true },
			});
			assert.equal(spawnCalls.length, before, "cwd 不存在 ⇒ forceResume 也不该拉起（门未被放宽）");
			// 回执必须**明确**是 cwd-missing（不能用 `|| status===200` 短路 —— 那恒真、无判别力）
			assert.equal(r.json.resume?.reason, "cwd-missing", `应明确报 cwd-missing：${JSON.stringify(r.json.resume)}`);
			assert.equal(r.json.resume?.action, "reject", `动作应为 reject：${JSON.stringify(r.json.resume)}`);
			ok("E2E⑧ forceResume 不放宽 cwd 门（cwd 不存在 ⇒ 明确 reject:cwd-missing）");
		}

		// ⑨ 【forceResume 不得放宽权限门】无凭据 ⇒ 不得拉起
		{
			const before = spawnCalls.length;
			const res = await fetch(`${base}/v1/commands`, {
				method: "POST",
				headers: { "content-type": "application/json" }, // 无 cookie ⇒ 无 trustedLocal
				body: JSON.stringify({
					frame: "command",
					type: "session.message",
					to: "pi://sess-dead",
					commandKey: "k-force-noauth",
					issuedAt: new Date().toISOString(),
					payload: { text: "无凭据", forceResume: true },
				}),
			});
			await res.text();
			assert.equal(spawnCalls.length, before, "无 trustedLocal ⇒ forceResume 也不该拉起（权限门未被放宽）");
			ok("E2E⑨ forceResume 不放宽权限门（无凭据 ⇒ 不拉起）");
		}
	} finally {
		await handle.close().catch(() => undefined);
	}

	console.log(`\n_s2_resume_e2e: ${n} checks passed`);
} finally {
	for (const d of DIRS) rmSync(d, { recursive: true, force: true });
}
