/**
 * ensure-pi-test-deps.mjs — 为本包的独立 Node 测试准备 host（pi）依赖。
 *
 * 根因：本包运行时依赖（@earendil-works/pi-tui、typebox）位于 pi 的 nested
 * node_modules 里。裸 Node 的 ESM resolver 只向祖先目录查 node_modules，
 * 不会向下钻进另一个包的 node_modules，因此直接 `node` 跑测试会 ERR_MODULE_NOT_FOUND。
 * （NODE_PATH 是 CommonJS 机制，对 ESM 无效。）
 *
 * 做法：在包内（被 .gitignore 的）node_modules/ 下创建三个**包叶子级 junction**，
 * 指向 pi 安装树里的真实包。幂等：realpath 比对，已存在且目标一致则跳过，冲突则失败。
 *
 * Windows 用 junction（不需管理员权限）。目标用绝对路径。
 *
 * 用法：
 *   node ./scripts/ensure-pi-test-deps.mjs
 *   PI_NODE_MODULES_DIR=<pi 的 node_modules 绝对路径> node ./scripts/ensure-pi-test-deps.mjs
 */
import { existsSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const piNodeModules = resolve(
	process.env.PI_NODE_MODULES_DIR ?? join(dirname(process.execPath), "node_modules"),
);
const piCodingAgent = join(piNodeModules, "@earendil-works", "pi-coding-agent");
const piNestedModules = join(piCodingAgent, "node_modules");

const packages = [
	["@earendil-works/pi-coding-agent", piCodingAgent],
	["@earendil-works/pi-tui", join(piNestedModules, "@earendil-works", "pi-tui")],
	["typebox", join(piNestedModules, "typebox")],
];

function canonical(path) {
	return realpathSync(path).toLowerCase();
}

let failures = 0;
for (const [specifier, rawTarget] of packages) {
	const target = resolve(rawTarget);
	const link = join(packageRoot, "node_modules", ...specifier.split("/"));

	if (!existsSync(join(target, "package.json"))) {
		console.error(
			`MISSING ${specifier}\n` +
				`  expected: ${target}\n` +
				`  Use the Node that installed pi, or set PI_NODE_MODULES_DIR to its node_modules directory.`,
		);
		failures++;
		continue;
	}

	if (existsSync(link)) {
		try {
			if (canonical(link) !== canonical(target)) {
				console.error(
					`CONFLICT ${specifier}\n` +
						`  link:    ${link}\n` +
						`  resolves elsewhere; refusing to replace an existing path.`,
				);
				failures++;
				continue;
			}
			console.log(`ok      ${specifier}`);
		} catch (err) {
			console.error(`CONFLICT ${specifier}: cannot resolve existing link ${link}: ${err.message}`);
			failures++;
		}
		continue;
	}

	mkdirSync(dirname(link), { recursive: true });
	try {
		symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
	} catch (err) {
		console.error(`FAIL    ${specifier}: could not create junction ${link} -> ${target}: ${err.message}`);
		failures++;
		continue;
	}
	if (canonical(link) !== canonical(target)) {
		console.error(`FAIL    ${specifier}: created junction does not resolve to expected target ${target}`);
		failures++;
		continue;
	}
	console.log(`linked  ${specifier}  ->  ${target}`);
}

if (failures > 0) {
	console.error(`\n${failures} package(s) could not be prepared.`);
	process.exit(1);
}
console.log("\npi test deps ready.");
