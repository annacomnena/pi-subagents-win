/** GUI store -> real API serialization -> isolated HTTP daemon -> fake terminal spawn.
 * No mouse/keyboard/windows, production config, or production messages.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, lstatSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRuntimeHostServer } from "./runtime-host/server.ts";
import { writeSessionOwner } from "./runtime/session-owner.ts";
import { processStartedAt } from "./runtime/liveness.ts";
import { listOutboxItems } from "./runtime/message-outbox.ts";
register("./_gui_store_ts_loader.mjs", import.meta.url);
const { useGui } = await import("../gui/src/store.ts");
const { api } = await import("../gui/src/api/client.ts");
const root = mkdtempSync(join(tmpdir(), "gui-continue-resume-"));
const stateDir = join(root, "state");
const sessionsDir = join(root, "sessions");
mkdirSync(sessionsDir);
const configPath = join(root, "config.json");
writeFileSync(configPath, JSON.stringify({ gui: { autoStart: true } }));
function session(id: string, cwd = root) {
  writeFileSync(join(sessionsDir, `2026-11-04T00-00-00-000Z_${id}.jsonl`),
    JSON.stringify({ type: "session", id, cwd, timestamp: new Date().toISOString() }) + "\n");
}
for (const id of ["history", "alive", "broken", "throws", "invalid", "unauthorized", "plain"]) session(id);
session("badcwd", join(root, "missing-cwd"));
writeSessionOwner({ sessionId: "alive", pid: process.pid, startedAt: processStartedAt(), stateDir });
const spawns: Array<{ sessionFile: string; cwd: string; title: string }> = [];
let attempts = 0;
const handle = await createRuntimeHostServer({
  hostPath: join(root, "host.json"), stateDir, sessionsDir, configPath,
  journalPath: join(root, "events.jsonl"), tabRunsDir: join(root, "tabs"),
  runsDir: join(root, "runs"), timersDir: join(root, "timers"), distDir: join(root, "dist"),
  wechatRuntimeDir: join(root, "wechat"), uploadsRuntimeDir: join(root, "uploads"),
  spawnSessionTab: (args) => {
    attempts++;
    if (args.sessionFile.endsWith("_broken.jsonl")) return { error: "diagnostic spawn error" };
    if (args.sessionFile.endsWith("_throws.jsonl")) throw new Error("diagnostic thrown spawn");
    spawns.push(args);
    return { runId: "fake-starting" };
  },
});
const originalFetch = globalThis.fetch;
let beforeCommandResponse: (() => Promise<void>) | undefined;
const sent: Array<{ commandKey: string; payload: { text: string; forceResume?: boolean }; to: string }> = [];
globalThis.fetch = (async (path, init) => {
  if (typeof path === "string" && path.startsWith("/v1/")) {
    if (path === "/v1/commands") sent.push(JSON.parse(String(init?.body)));
    const response = await originalFetch(`http://127.0.0.1:${handle.info.port}${path}`, {
      ...init, headers: { ...init?.headers, cookie: `sw_host_token=${handle.info.token}` },
    });
    if (path === "/v1/commands") await beforeCommandResponse?.();
    return response;
  }
  return originalFetch(path, init);
}) as typeof fetch;
function latest() { return Object.values(useGui.getState().chatOutbox).at(-1)!; }
let checks = 0;
function ok(label: string) { console.log(`ok ${++checks} - ${label}`); }
try {
  useGui.setState({ chatOutbox: {} });
  await useGui.getState().sendChatMessage("history", "继续原来的任务");
  assert.equal(spawns.length, 1, "普通继续对话必须恢复没有 owner 记录的历史会话");
  assert.equal(sent[0].payload.forceResume, true);
  assert.equal(sent[0].payload.text, "继续原来的任务");
  assert.equal(latest().status, "pending");
  assert.match(latest().detail!, /恢复/);
  assert.match(spawns[0].sessionFile, /_history\.jsonl$/);
  const outbox = listOutboxItems(join(stateDir, "message-outbox"));
  assert.equal(outbox[0].text, "继续原来的任务");
  assert.equal(outbox[0].commandKey, sent[0].commandKey);
  ok("GUI 普通发送保留原正文与 commandKey，经真实 HTTP 恢复原 session");

  const upload = await api.uploadImage(new Blob([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvJkAAAAASUVORK5CYII=", "base64")], { type: "image/png" }));
  assert.ok(upload.ok, "隔离上传必须成功");
  await useGui.getState().sendChatMessage("history", "第二条消息", [upload.data.uploadId]);
  assert.equal(spawns.length, 1, "不同 commandKey，owner 尚未就绪也不得重复开窗");
  assert.equal(listOutboxItems(join(stateDir, "message-outbox")).length, 2);
  assert.deepEqual(listOutboxItems(join(stateDir, "message-outbox")).find(item => item.commandKey === sent[1].commandKey)?.attachments, [upload.data.path]);
  assert.match(latest().detail!, /恢复/);
  await api.sessionMessage("history", sent[1].payload.text, undefined, sent[1].commandKey, true);
  assert.equal(spawns.length, 1, "同 commandKey 重放不得重复启动");
  ok("启动期间不同消息合并启动，附件路径保留，同 key 重放仍幂等");

  await useGui.getState().sendChatMessage("alive", "你还在吗");
  assert.equal(spawns.length, 1, "活进程不因显式恢复标记而重复启动");
  assert.equal(latest().status, "pending");
  ok("真实活 owner 会话只投递不启动");

  for (const id of ["badcwd", "broken", "throws"]) {
    await useGui.getState().sendChatMessage(id, "继续");
    assert.equal(latest().status, "pending", "消息仍保留在服务端 outbox，不能伪报投递终态");
    assert.match(latest().detail!, /无法恢复|恢复失败/);
  }
  const beforeRetry = attempts;
  await useGui.getState().sendChatMessage("broken", "重试恢复");
  assert.equal(attempts, beforeRetry + 1, "spawn 报错必须释放启动保护，允许新消息重试");
  ok("cwd 缺失、spawn 返回错误及抛错均有反馈；失败允许重试");

  const beforeInvalid = attempts;
  const invalidResponse = await originalFetch(`http://127.0.0.1:${handle.info.port}/v1/commands`, {
    method: "POST", headers: { "content-type": "application/json", cookie: `sw_host_token=${handle.info.token}` },
    body: JSON.stringify({ frame: "command", type: "session.message", to: "pi://invalid", commandKey: "invalid", issuedAt: new Date().toISOString(), payload: { text: "", forceResume: true } }),
  });
  await invalidResponse.text();
  assert.equal(invalidResponse.status, 400);
  assert.equal(attempts, beforeInvalid, "业务拒绝发生在启动副作用之前");
  const unauthorized = await originalFetch(`http://127.0.0.1:${handle.info.port}/v1/commands`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ frame: "command", type: "session.message", to: "pi://unauthorized", commandKey: "unauthorized", issuedAt: new Date().toISOString(), payload: { text: "继续", forceResume: true } }),
  });
  await unauthorized.text();
  assert.equal(unauthorized.status, 401);
  assert.equal(attempts, beforeInvalid);
  ok("无权限与无效正文都不能触发开窗");

  const plain = await api.sessionMessage("plain", "无恢复意图");
  assert.equal(plain.ok, true);
  assert.equal(attempts, beforeInvalid, "未明确恢复的 API 调用继续保持 unknown 不启动");
  ok("API 默认 unknown 不启动保持原语义，恢复意图仅来自 GUI 用户发送");

  for (const status of ["delivered", "failed", "expired"] as const) {
    beforeCommandResponse = async () => {
      const commandKey = sent.at(-1)!.commandKey;
      await useGui.getState().applyChatFrame({ type: "event", topic: "outbox", seq: 100,
        envelope: { type: `message.${status}`, payload: { commandKey, outboxId: "test", sessionId: "history", error: "test failure" } },
      } as never);
      assert.equal(useGui.getState().chatOutbox[commandKey].status, status);
    };
    await useGui.getState().sendChatMessage("history", `HTTP 晚于 WS ${status}`);
    assert.equal(latest().status, status, "真实 WS handler 已更新的终态不被迟到 HTTP 覆盖");
  }
  beforeCommandResponse = undefined;
  ok("WS delivered/failed/expired 先到，HTTP accepted 后到，终态均不倒退");
  console.log(`gui-continue-resume: ${checks} checks passed`);
} finally {
  globalThis.fetch = originalFetch;
  await handle.close();
  // Never follow junctions when cleaning a test tree (AGENTS.md R-16).
  function noLinks(dir: string): void {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name), stat = lstatSync(path);
      assert.equal(stat.isSymbolicLink(), false, `refuse recursive cleanup through link: ${path}`);
      if (stat.isDirectory()) noLinks(path);
    }
  }
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + "\\") || resolve(root).startsWith(resolve(tmpdir()) + "/"));
  noLinks(root);
  rmSync(root, { recursive: true, force: true });
}
