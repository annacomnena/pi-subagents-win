import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAutonomyEnabled } from "./runtime-host/autonomy-config.ts";
const dir = mkdtempSync(join(tmpdir(), "autonomy-switch-"));
try {
 const path = join(dir, "config.json");
 const original = { channels: { wechat: { enabled: true, marker: 7 } }, autonomy: { enabled: false, other: "kept" }, unrelated: 42 };
 writeFileSync(path, JSON.stringify(original));
 assert.deepEqual(setAutonomyEnabled(true, path), { ok: true });
 const enabled = JSON.parse(readFileSync(path, "utf8"));
 assert.deepEqual(enabled.channels, original.channels); assert.equal(enabled.unrelated, 42); assert.equal(enabled.autonomy.other, "kept"); assert.equal(enabled.autonomy.enabled, true);
 const first = readFileSync(path, "utf8"); assert.deepEqual(setAutonomyEnabled(true, path), { ok: true }); assert.equal(readFileSync(path, "utf8"), first);
 const failure = setAutonomyEnabled(false, dir);
 assert.equal(failure.ok, false); assert.equal(readFileSync(path, "utf8"), first);
 console.log("_test_autonomy_switch: preserve-fields ✓ idempotent ✓ write-failure-no-partial-write ✓");
} finally { rmSync(dir, { recursive: true, force: true }); }
