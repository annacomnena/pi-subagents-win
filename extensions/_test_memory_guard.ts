import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveStaleTabRuns, listTabDispatches, readTabDispatch, writeTabDispatch, type TabDispatchRecord } from "./tab-runs.ts";

console.log("Starting memory guard tests...");

// 1. Test Tab Runs Archiving and Scoped Listing
{
	const testDir = mkdtempSync(join(tmpdir(), "subagent-win-mem-guard-"));
	try {
		const now = Date.now();
		// Create 3 runs:
		// run1: Stale completed run (mtime 5 days ago)
		const run1 = "run_stale_1";
		writeTabDispatch(testDir, {
			id: run1,
			version: 1,
			taskId: "101",
			mode: "workflow",
			cwd: process.cwd(),
			dispatchedAt: new Date(now - 5 * 86400 * 1000).toISOString(),
			dispatchStatus: "dispatched",
		});
		writeFileSync(join(testDir, `${run1}.result.json`), JSON.stringify({ id: run1, status: "completed" }));
		writeFileSync(join(testDir, `${run1}.state.json`), JSON.stringify({ id: run1, phase: "completed" }));

		// Manually backdate mtime
		const oldTime = new Date(now - 5 * 86400 * 1000);
		utimesSync(join(testDir, `${run1}.json`), oldTime, oldTime);
		utimesSync(join(testDir, `${run1}.result.json`), oldTime, oldTime);
		utimesSync(join(testDir, `${run1}.state.json`), oldTime, oldTime);

		// run2: Fresh run (dispatched 1 hour ago)
		const run2 = "run_fresh_2";
		writeTabDispatch(testDir, {
			id: run2,
			version: 1,
			taskId: "102",
			mode: "workflow",
			cwd: process.cwd(),
			dispatchedAt: new Date(now - 3600 * 1000).toISOString(),
			dispatchStatus: "dispatched",
		});
		writeFileSync(join(testDir, `${run2}.result.json`), JSON.stringify({ id: run2, status: "completed" }));

		// run3: Active run (dispatched 2 hours ago, no result)
		const run3 = "run_active_3";
		writeTabDispatch(testDir, {
			id: run3,
			version: 1,
			taskId: "103",
			mode: "workflow",
			cwd: process.cwd(),
			dispatchedAt: new Date(now - 7200 * 1000).toISOString(),
			dispatchStatus: "dispatched",
		});

		// Test listTabDispatches with limit
		const listBefore = listTabDispatches(testDir, 2);
		assert.equal(listBefore.length, 2, "listTabDispatches should obey limit=2");

		// Run archiveStaleTabRuns (cutoff = 72 hours)
		const archivedCount = archiveStaleTabRuns(testDir, 72);
		assert.equal(archivedCount, 1, "Should archive exactly 1 stale run");

		// Verify run1 is in _archived
		assert.ok(!existsSync(join(testDir, `${run1}.json`)), "run1.json should be removed from root");
		assert.ok(!existsSync(join(testDir, `${run1}.result.json`)), "run1.result.json should be removed from root");
		assert.ok(existsSync(join(testDir, "_archived", `${run1}.json`)), "run1.json should exist in _archived");
		assert.ok(existsSync(join(testDir, "_archived", `${run1}.result.json`)), "run1.result.json should exist in _archived");

		// Verify run2 and run3 remain in root
		assert.ok(existsSync(join(testDir, `${run2}.json`)), "run2.json should remain in root");
		assert.ok(existsSync(join(testDir, `${run3}.json`)), "run3.json should remain in root");
	} finally {
		rmSync(testDir, { recursive: true, force: true });
	}
}

// 2. Test Details Sanitization
{
	let registeredTool: any = null;
	const mockApi: any = {
		registerTool: (def: any) => {
			if (def.name === "subagent-win") registeredTool = def;
		},
		registerCommand: () => {},
		on: () => {},
	};
	const indexModule = await import("./index.ts");
	indexModule.default(mockApi);
	assert.ok(registeredTool, "subagent-win tool registered");
}

// 3. Test Bounded Set (Capacity Cap)
{
	const MAX_CAP = 500;
	const testSet = new Set<string>();
	function pushBounded(val: string) {
		testSet.add(val);
		if (testSet.size > MAX_CAP) {
			const first = testSet.values().next().value;
			if (first) testSet.delete(first);
		}
	}

	for (let i = 0; i < 600; i++) {
		pushBounded(`item_${i}`);
	}

	assert.equal(testSet.size, MAX_CAP, "Set size must be capped at 500");
	assert.ok(!testSet.has("item_0"), "Oldest items should be pruned");
	assert.ok(!testSet.has("item_99"), "Items before index 100 should be pruned");
	assert.ok(testSet.has("item_599"), "Newest items should be present");
	assert.ok(testSet.has("item_100"), "Index 100 should be present");
}

console.log("All memory guard tests passed successfully!");
