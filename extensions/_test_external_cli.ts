import assert from "node:assert/strict";
import {
	EXTERNAL_BACKENDS,
	buildAtomcodeArgs,
	detectAvailableBackends,
	isExternalCliModel,
	listExternalCliModelOptions,
	normalizeExternalCliModel,
	parseExternalCliModel,
} from "./external-cli.ts";

assert.equal(isExternalCliModel("cli:atomcode"), true);
assert.equal(isExternalCliModel(" CLI:AtomCode "), true);
assert.deepEqual(parseExternalCliModel("CLI:AtomCode"), {
	backend: "atomcode",
	canonical: "cli:atomcode",
});
assert.equal(parseExternalCliModel("cli:atomcode/other-model"), null);
assert.equal(parseExternalCliModel("cli:unknown"), null);
assert.equal(normalizeExternalCliModel("  CLI:AtomCode "), "cli:atomcode");
assert.throws(() => normalizeExternalCliModel("cli:unknown"), /atomcode/);
assert.deepEqual(buildAtomcodeArgs("say hello"), ["-y", "-p", "say hello"]);

for (const backend of ["claude", "codex", "agy", "atomcode"] as const) {
	assert.deepEqual(parseExternalCliModel(`cli:${backend}`), {
		backend,
		canonical: `cli:${backend}`,
	});
}

const options = listExternalCliModelOptions();
assert.equal(options.length, EXTERNAL_BACKENDS.length);
assert.equal(options.some((option) => option.ref === "cli:atomcode" && option.label.includes("AtomCode")), true);

const available = detectAvailableBackends();
assert.equal(typeof available.atomcode, "boolean");

console.log("external CLI backend assertions passed");
