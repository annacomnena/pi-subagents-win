/**
 * _test_gui_chat_guard.ts — G6-P2 L4 必修 4：GUI Master 禁输入标识改服务端权威（plans/
 * 0922_g6p2_review.md §必修 4）+ 真 403 回执映射 + expired 投影（必修 2 的 UI 面）。
 *
 * 覆盖（store 级断言，gui/src 无 node 可直连 DOM 框架——同 test:gui-store 的 module
 * customization hooks 模式，api 打桩）：
 *   G1 sessions 元数据权威：/v1/sessions 条目 masterProtected flag 进 store；ChatPage 禁
 *      输入/徽标唯一数据源 = 该 flag（health 心跳猜测已移除——health 里伪造 stale attachment
 *      会话 id 不再影响 chat 判定）
 *   G2 真实 403：POST 回 403 {status:"rejected",reason:"master-session-protected"} →
 *      sendChatMessage → entry rejected + 403 detail（服务端权威回执驱动）
 *   G3 expired 投影：WS outbox message.expired → entry expired（终态不可逆）
 *   G4 非 403 业务拒绝回归：invalid-payload → rejected + reason detail
 *
 * 运行：npm run test:gui-chat-guard
 */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./_gui_store_ts_loader.mjs", import.meta.url);

const { useGui } = await import("../gui/src/store.ts");
const { api } = await import("../gui/src/api/client.ts");

let n = 0;
const ok = (name: string): void => {
	n += 1;
	console.log(`ok ${n} - ${name}`);
};
const AT = "2026-09-22T15:00:00.000Z";

function mkSession(sessionId: string, masterProtected?: true) {
	return {
		sessionId,
		cwd: "C:\\ws",
		startedAt: AT,
		parentSession: null,
		file: `2026-09-22T15-00-00-000Z_${sessionId}.jsonl`,
		sizeBytes: 10,
		mtimeMs: 1,
		...(masterProtected ? { masterProtected } : {}),
	};
}

/** ChatPage 派生逻辑（与 ChatPage.tsx 同式）：唯一数据源 = sessions 条目 flag。 */
function isMasterSession(state: ReturnType<typeof useGui.getState>): boolean {
	const activeSession = state.chatActiveId !== null ? state.chatSessions.find((s) => s.sessionId === state.chatActiveId) : undefined;
	return activeSession?.masterProtected === true;
}

// ── G1 sessions 元数据权威 ─────────────────────────────────────────
{
	(api as { sessions: unknown }).sessions = async () => ({
		ok: true as const,
		status: 200,
		at: AT,
		data: {
			version: 1 as const,
			count: 2,
			sessions: [mkSession("s-normal"), mkSession("s-master", true)],
			masterProtectedSessionId: "s-master",
		},
	});
	// health 伪造 stale 猜测源（修复前前端拿它判 Master）：attachment.sessionId 指向普通会话
	(api as { health: unknown }).health = async () => ({
		ok: true as const,
		status: 200,
		at: AT,
		data: {
			version: 1 as const,
			host: { instanceId: "i", pid: 1, port: 1, startedAt: AT, protocolVersion: 1 },
			master: { attachment: { agentAddress: "agent://master_default", sessionId: "s-normal", generation: 1, attachedAt: AT, lastHeartbeatAt: AT, attemptId: "a" }, cutover: false },
			masterOwnerAlive: false,
			sessionHeartbeats: [],
			journalTail: { lastEnvelopeAt: null, lastRecordedAt: null, totalEvents: 0 },
			mailboxPending: 0,
			generatedAt: AT,
		},
	});
	useGui.setState({ chatSessions: [], chatActiveId: null, chatRowsBySession: {}, chatHeadBySession: {}, chatSeqBySession: {} });
	await useGui.getState().pollHealth(); // stale health 先进 store（旧行为会拿它当真相）
	await useGui.getState().pollChatSessions();
	const sessions = useGui.getState().chatSessions;
	assert.equal(sessions.find((s) => s.sessionId === "s-master")?.masterProtected, true, "服务端权威 flag 进 store");
	assert.equal(sessions.find((s) => s.sessionId === "s-normal")?.masterProtected, undefined, "普通会话无 flag");
	// health 猜测已断路：health.attachment.sessionId = s-normal，但 flag 判定不受影响
	await useGui.getState().openChatSession("s-normal");
	assert.equal(isMasterSession(useGui.getState()), false, "health stale 猜测不再误标普通会话（必修 4：去 health 猜测）");
	await useGui.getState().openChatSession("s-master");
	assert.equal(isMasterSession(useGui.getState()), true, "flag 会话判 Master（禁输入徽标数据源）");
	ok("G1 sessions 元数据权威：flag 唯一数据源，health 心跳猜测断路");
}

// ── G2 真实 403 回执 → rejected + detail ───────────────────────────
{
	(api as { sessionMessage: unknown }).sessionMessage = async () => ({
		ok: false as const,
		status: 403,
		resync: false,
		at: AT,
		body: { status: "rejected", reason: "master-session-protected", replayed: false },
	});
	await useGui.getState().openChatSession("s-normal");
	await useGui.getState().sendChatMessage("s-normal", "hi");
	const entries = Object.values(useGui.getState().chatOutbox);
	const last = entries[entries.length - 1]!;
	assert.equal(last.status, "rejected", "真实 403 → rejected");
	assert.ok(last.detail?.includes("403") && last.detail?.includes("master-session-protected"), `detail 含 403 与 reason：${last.detail}`);
	ok("G2 真实 403 回执驱动：rejected + master-protected detail");
}

// ── G4 非 403 业务拒绝回归 ─────────────────────────────────────────
{
	(api as { sessionMessage: unknown }).sessionMessage = async () => ({
		ok: true as const,
		status: 200,
		at: AT,
		data: { status: "rejected", reason: "invalid-payload", replayed: false },
	});
	await useGui.getState().sendChatMessage("s-normal", "bad");
	const entries = Object.values(useGui.getState().chatOutbox);
	const last = entries[entries.length - 1]!;
	assert.equal(last.status, "rejected");
	assert.equal(last.detail, "invalid-payload");
	ok("G4 非 403 拒绝回归：rejected + reason detail");
}

// ── G3 expired 投影 + 终态不可逆 ───────────────────────────────────
{
	(api as { sessionMessage: unknown }).sessionMessage = async () => ({
		ok: true as const,
		status: 200,
		at: AT,
		data: { status: "accepted", summary: "queued", replayed: false },
	});
	useGui.setState({ chatOutbox: {} });
	await useGui.getState().sendChatMessage("s-normal", "will-expire");
	const ck = Object.keys(useGui.getState().chatOutbox)[0]!;
	assert.equal(useGui.getState().chatOutbox[ck]!.status, "pending", "accepted → pending");
	await useGui.getState().applyChatFrame({
		type: "event",
		topic: "outbox",
		seq: 42,
		envelope: { type: "message.expired", payload: { commandKey: ck, outboxId: "x", sessionId: "s-normal" } },
	} as never);
	assert.equal(useGui.getState().chatOutbox[ck]!.status, "expired", "message.expired → expired");
	assert.ok(useGui.getState().chatOutbox[ck]!.detail?.includes("24h"), "expired detail");
	// 终态不可逆：迟到的 delivered 不回改
	await useGui.getState().applyChatFrame({
		type: "event",
		topic: "outbox",
		seq: 43,
		envelope: { type: "message.delivered", payload: { commandKey: ck, outboxId: "x", sessionId: "s-normal" } },
	} as never);
	assert.equal(useGui.getState().chatOutbox[ck]!.status, "expired", "终态不可逆（迟到 delivered 不回改）");
	ok("G3 expired 投影：TTL 过期终态 + 终态不可逆");
}

console.log("_test_gui_chat_guard: all assertions passed");
