/**
 * pi-deps-loader.mjs — daemon/worker 裸 Node 的宿主包 resolve hook（2026-10-08 peerDeps 修正）。
 *
 * 背景：`@earendil-works/pi-tui` 与 `typebox` 是 **pi 宿主提供**的包，声明在
 * peerDependencies("*")，进程内（pi 扩展加载器）由 loader 解析到宿主副本。
 * daemon（`node --experimental-strip-types server.ts` 裸跑，无 pi loader）必须另给解析：
 * ESM 的 NODE_PATH 无效，只能用 module register hook。本文件即该 hook。
 *
 * 用法：`node --experimental-strip-types --import <本文件绝对路径> server.ts`
 * （--import 先于入口执行；父进程 spawn 时还应传 env PI_HOST_NODE_MODULES）。
 *
 * 宿主 node_modules 发现顺序（解析到第一个两者都在的目录）：
 *   ① env PI_HOST_NODE_MODULES（daemon spawn 时由父进程传入，首选）
 *   ② 从本文件位置向上逐层找 node_modules（兼容本机 junction/残留副本）
 *   ③ 都找不到 → 抛错（错进 daemon-stderr.log，失败可诊断而非静默）
 *
 * 纯 JS、无副作用 import（只 import node: 内置），可被 --import 与 hooks 线程复用。
 */
import { register } from "node:module";
import { isMainThread } from "node:worker_threads";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOST_PACKAGES = ["@earendil-works/pi-tui", "typebox"];

/**
 * 本文件在 hooks 线程内被再次加载时不得重复 register。
 * 不能用 env 标记：env 会经 spawn 继承进子进程，导致子进程误判自己是 hooks 线程
 * 而跳过 register（2026-10-08 实测：测试父进程带 --import → 子 daemon 全灭）。
 * isMainThread 只区分线程不跨进程泄漏；globalThis 亦然（每进程/线程独立）。
 */

function findHostNodeModules() {
	// ① env（父进程 spawn 时传入；父进程侧已 realpath，这里再兜一层防 junction 路径）
	const fromEnv = process.env.PI_HOST_NODE_MODULES;
	if (fromEnv && isAbsolute(fromEnv) && hostCoversAll(fromEnv)) {
		return { dir: safeRealpath(fromEnv), via: "env:PI_HOST_NODE_MODULES" };
	}
	// ② 从本文件位置向上逐层找 node_modules
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 10; i++) {
		const candidate = join(dir, "node_modules");
		if (hostCoversAll(candidate)) return { dir: safeRealpath(candidate), via: `walk-up: ${candidate}` };
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	// ③ 当前 node 可执行文件相邻的全局 node_modules 树（pi 通常与其 node 同目录安装；
	// daemon/测试都跑在这个 node 上时命中；与 daemon-lifecycle computeHostNodeModules ② 同源）
	try {
		const adjacent = join(
			dirname(process.execPath), "node_modules", "@earendil-works", "pi-coding-agent", "node_modules",
		);
		if (hostCoversAll(adjacent)) return { dir: safeRealpath(adjacent), via: `exec-adjacent: ${adjacent}` };
	} catch { /* 掉到报错 */ }
	// ④ 找不到 → 明确报错（进 daemon-stderr.log）
	throw new Error(
		`pi-deps-loader: 找不到宿主 node_modules（需同时包含 ${HOST_PACKAGES.join("、")}）。` +
			` 已尝试 ① env PI_HOST_NODE_MODULES=${fromEnv || "(空)"} ② 自 ${fileURLToPath(import.meta.url)} 向上 10 层 ③ ${dirname(process.execPath)} 相邻全局树。` +
			` 修复：spawn 时传 PI_HOST_NODE_MODULES=<pi 安装的 node_modules 绝对路径>，` +
			` 或确认 pi 已安装（node_modules/@earendil-works/pi-coding-agent/node_modules 内嵌这两个包）。`,
	);
}

function hostCoversAll(nmDir) {
	if (!existsSync(nmDir)) return false;
	return HOST_PACKAGES.every((spec) => existsSync(join(nmDir, ...spec.split("/"), "package.json")));
}

/** junction/symlink 路径 → 真实路径（失败则原样返回）。 */
function safeRealpath(p) {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

/**
 * 手工解析包入口（hooks worker 线程内 createRequire().resolve 不可用——
 * “resolveSync() is not implemented”）：读 package.json，exports["."]（import→default→require）
 * 否则 main（缺省 index.js）。
 */
function resolveEntry(nmDir, spec) {
	const pkgDir = join(nmDir, ...spec.split("/"));
	const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
	let rel;
	const exp = pkg.exports;
	if (exp !== undefined) {
		const root = typeof exp === "string" ? exp : exp["."];
		if (typeof root === "string") rel = root;
		else if (root && typeof root === "object") {
			rel = typeof root.import === "string" ? root.import
				: typeof root.default === "string" ? root.default
				: typeof root.require === "string" ? root.require
				: null;
		}
	}
	rel ??= pkg.main ?? "index.js";
	return join(pkgDir, rel);
}

if (isMainThread && !globalThis.__piDepsLoaderRegistered) {
	globalThis.__piDepsLoaderRegistered = true;
	register(import.meta.url, import.meta.url);
}

const HOST_AGENT_SPEC = "@earendil-works/pi-coding-agent";

/**
 * pi-coding-agent 包根定位：它是宿主包（非内嵌）。hostNmDir 通常是其包内嵌
 * node_modules（…/pi-coding-agent/node_modules）→ 包根 = 其父目录；
 * 透传来的扁平 node_modules 则包在该目录内。两种都试。
 */
function findAgentPackage(hostNmDir) {
	const rel = join("@earendil-works", "pi-coding-agent");
	for (const nmDir of [dirname(dirname(dirname(hostNmDir))), hostNmDir]) {
		const pkgDir = join(nmDir, rel);
		try {
			if (existsSync(join(pkgDir, "package.json"))) return { root: safeRealpath(pkgDir), nmDir };
		} catch { /* 下一个 */ }
	}
	return null;
}

/** resolve hook：仅拦截三个宿主裸 specifier，映射到宿主安装内的真实文件。 */
export async function resolve(specifier, context, nextResolve) {
	if (specifier !== "@earendil-works/pi-tui" && specifier !== "typebox" && specifier !== HOST_AGENT_SPEC) {
		return nextResolve(specifier, context);
	}
	const { dir, via } = findHostNodeModules();
	let file;
	try {
		if (specifier === HOST_AGENT_SPEC) {
			const found = findAgentPackage(dir);
		if (!found) throw new Error(`宿主目录 ${dir}（来源 ${via}）附近找不到 pi-coding-agent 包根`);
		file = resolveEntry(found.nmDir, specifier);
	} else {
		file = resolveEntry(dir, specifier);
	}
	} catch (e) {
		throw new Error(
			`pi-deps-loader: 宿主目录 ${dir}（来源 ${via}）内无法解析 "${specifier}"：${e instanceof Error ? e.message : String(e)}`,
		);
	}
	return { url: pathToFileURL(file).href, shortCircuit: true };
}
