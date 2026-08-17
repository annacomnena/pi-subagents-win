import assert from "node:assert/strict";
import {
	EXTERNAL_BACKENDS,
	buildAtomcodeArgs,
	buildMimoArgs,
	buildZcodeArgs,
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
assert.deepEqual(buildZcodeArgs("say hello"), ["-p", "say hello"]);
assert.deepEqual(buildMimoArgs("say hello", "C:/repo"), [
	"run", "say hello", "--format", "json", "--dangerously-skip-permissions", "--dir", "C:/repo",
]);

assert.deepEqual(parseExternalCliModel("cli:zcode"), {
	backend: "zcode",
	canonical: "cli:zcode",
});
assert.equal(parseExternalCliModel("cli:zcode/other-model"), null);
assert.equal(normalizeExternalCliModel("  CLI:ZCode "), "cli:zcode");
assert.deepEqual(parseExternalCliModel("cli:mimo"), {
	backend: "mimo",
	canonical: "cli:mimo",
});
assert.equal(parseExternalCliModel("cli:mimo/other-model"), null);
assert.equal(normalizeExternalCliModel("  CLI:Mimo "), "cli:mimo");
assert.equal(normalizeExternalCliModel("cli:mimocode"), "cli:mimo", "产品名别名应归一到可执行文件名");

for (const backend of ["claude", "codex", "agy", "atomcode", "zcode", "mimo"] as const) {
	assert.deepEqual(parseExternalCliModel(`cli:${backend}`), {
		backend,
		canonical: `cli:${backend}`,
	});
}

const options = listExternalCliModelOptions();
assert.equal(options.length, EXTERNAL_BACKENDS.length);
assert.equal(options.some((option) => option.ref === "cli:atomcode" && option.label.includes("AtomCode")), true);
assert.equal(options.some((option) => option.ref === "cli:zcode" && option.label.includes("ZCode")), true);
assert.equal(options.some((option) => option.ref === "cli:mimo" && option.label.includes("MimoCode")), true);

const available = detectAvailableBackends();
assert.equal(typeof available.atomcode, "boolean");
assert.equal(typeof available.zcode, "boolean");
assert.equal(typeof available.mimo, "boolean");

console.log("external CLI backend assertions passed");
