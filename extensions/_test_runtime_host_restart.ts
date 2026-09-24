import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { restartRuntimeDaemon } from "./runtime-host/daemon-lifecycle.ts";

const dir = mkdtempSync(join(tmpdir(), "runtime-restart-test-"));
const hostPath = join(dir, "host.json");
const stopped = { stopped: true, info: { pid: 111 } as any };
const started = { ok: true, info: { pid: 222, port: 4321 } as any };
const noLock = () => null;
try {
  {
    let ensured = false;
    const r = await restartRuntimeDaemon({ hostPath, stop: async () => ({ stopped: false, uncertain: true, reason: "identity uncertain", info: { pid: 111 } as any }), ensure: async () => { ensured = true; return started as any; } });
    assert.equal(r.ok, false); assert.match(r.message, /identity uncertain/); assert.match(r.message, /--force/); assert.equal(ensured, false);
  }
  {
    const calls: string[] = [];
    const r = await restartRuntimeDaemon({ hostPath, stop: async () => { calls.push("stop"); return stopped; }, readLock: () => { calls.push("lock"); return null; }, ensure: async () => { calls.push("ensure"); return started as any; } });
    assert.equal(r.ok, true); assert.deepEqual(calls, ["stop", "lock", "ensure"]); assert.match(r.message, /111.*222.*4321/); assert.match(r.message, /cookie 已失效/); assert.match(r.message, /worker.*supervisor/);
  }
  {
    let ensured = false; const begin = Date.now();
    const r = await restartRuntimeDaemon({ hostPath, waitForLockMs: 25, pollMs: 5, stop: async () => stopped, readLock: () => ({ kind: "daemon", pid: 99, instanceId: "i", runtimeId: "r", acquiredAt: "" }), isLockAlive: () => true, sleep: async (ms) => new Promise((resolve) => setTimeout(resolve, ms)), ensure: async () => { ensured = true; return started as any; } });
    assert.equal(r.ok, false); assert.equal(ensured, false); assert.match(r.message, /25ms/); assert.ok(Date.now() - begin < 1000);
  }
  {
    const r = await restartRuntimeDaemon({ hostPath, stop: async () => stopped, readLock: noLock, ensure: async () => ({ ok: false, error: "spawn failed", info: null, url: null, pid: null, port: null }) });
    assert.equal(r.ok, false); assert.match(r.message, /spawn failed/); assert.doesNotMatch(r.message, /已重启/);
  }
  {
    const passed: boolean[] = [];
    const stop = async (o: any) => { passed.push(o.force === true); return stopped; };
    await restartRuntimeDaemon({ hostPath, stop, readLock: noLock, ensure: async () => started as any });
    await restartRuntimeDaemon({ hostPath, force: true, stop, readLock: noLock, ensure: async () => started as any });
    assert.deepEqual(passed, [false, true]);
  }
  console.log("PASS 1 uncertain aborts without ensure; --force recovery hint");
  console.log("PASS 2 happy path stop → lock wait → ensure; pid/port and cookie/worker notice");
  console.log("PASS 3 live lock timeout is bounded; ensure not called");
  console.log("PASS 4 ensure failure reported without restart claim");
  console.log("PASS 5 force forwarded only when explicitly requested");
  console.log("SKIP 6 worker-only restart: optional feature not implemented");
} finally { rmSync(dir, { recursive: true, force: true }); }
