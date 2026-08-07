import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultLinksPath, groupLinksBySession, listLinks, recordLink, sessionIdentity } from "./links.ts";

delete process.env.PI_SUBAGENT;
delete process.env.PI_TAB_RUN_ID;

const dir = mkdtempSync(join(tmpdir(), "links-test-"));
const linksPath = join(dir, "links.jsonl");

// ── 记录 + 读取 ───────────────────────────────────────────────────
{
	recordLink({ sessionId: "sess_a", kind: "tab", targetId: "tab_1", detail: "task=1007" }, { linksPath, at: "2026-08-07T01:00:00.000Z" });
	recordLink({ sessionId: "sess_a", kind: "async", targetId: "run_x", detail: "agent=searcher" }, { linksPath, at: "2026-08-07T02:00:00.000Z" });
	recordLink({ sessionId: "tab_1", kind: "timer", targetId: "timer_t", detail: "self" }, { linksPath, at: "2026-08-07T03:00:00.000Z" });

	const links = listLinks(linksPath);
	assert.equal(links.length, 3);
	// 倒序：最近的在最前
	assert.equal(links[0]?.kind, "timer");
	assert.equal(links[0]?.sessionId, "tab_1");
	assert.equal(links[2]?.kind, "tab");
	assert.ok(links.every((l) => l.at && l.pid > 0), "每行应有 at + pid");
}

// ── 按会话分组 ────────────────────────────────────────────────────
{
	const groups = groupLinksBySession(linksPath);
	assert.ok(groups["sess_a"], "sess_a 应有两组");
	assert.equal(groups["sess_a"].length, 2);
	assert.equal(groups["tab_1"].length, 1);
}

// ── sessionIdentity ───────────────────────────────────────────────
{
	assert.equal(sessionIdentity(null), "unknown", "无 sessionManager 时 unknown");
	assert.equal(
		sessionIdentity({ sessionManager: { sessionId: "sess_123" } }),
		"sess_123",
		"有 sessionId 时用它",
	);
	process.env.PI_TAB_RUN_ID = "tab_env_1";
	assert.equal(sessionIdentity({ sessionManager: { sessionId: "sess_123" } }), "tab_env_1", "PI_TAB_RUN_ID 优先");
	delete process.env.PI_TAB_RUN_ID;
}

// ── 损坏行跳过 ────────────────────────────────────────────────────
{
	const { writeFileSync } = await import("node:fs");
	writeFileSync(linksPath, "not json\n", { flag: "a" });
	const links = listLinks(linksPath);
	assert.equal(links.length, 3, "损坏行应跳过");
}

rmSync(dir, { recursive: true, force: true });

console.log("links tests passed");
