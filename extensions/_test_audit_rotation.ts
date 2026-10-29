/**
 * _test_audit_rotation.ts — audit.jsonl 轮转 + 尾部反向读的判别力测试。
 *
 * 被验证的两处改动（extensions/runtime/autonomy/collect.ts）：
 *  1. `appendAuditLine` 追加前按大小轮转（`rotateAuditIfNeeded`），**不删历史**；
 *  2. `readAuditTail` 只读**尾部固定字节窗口**，不再把整个文件读进内存。
 *
 * 判别力要求：每个正向断言都配一条**变异**（改回旧行为必须变红）。
 */
import { appendAuditLine, readAuditTail, rotateAuditIfNeeded, autonomyDir } from "./runtime/autonomy/collect.ts";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let pass = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = "") {
	if (cond) { pass++; console.log(`  ✅ ${name}`); }
	else { failures.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  ❌ ${name} ${detail}`); }
}

function freshStateDir(tag: string): string {
	const d = join(tmpdir(), `sw_audit_${tag}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
	mkdirSync(d, { recursive: true });
	return d;
}

console.log("[1] 轮转：超过阈值 → 归归档，不删历史");
{
	const stateDir = freshStateDir("rot");
	const dir = autonomyDir(stateDir);
	mkdirSync(dir, { recursive: true });
	const active = join(dir, "audit.jsonl");
	// 写 200 行，超过 1KB 阈值
	const lines = Array.from({ length: 200 }, (_, i) => `line-${i}-${"x".repeat(20)}`);
	writeFileSync(active, lines.join("\n") + "\n", "utf8");
	const beforeSize = statSync(active).size;

	const archived = rotateAuditIfNeeded({ stateDir, maxBytes: 1024 });
	check("rotateAuditIfNeeded 返回归档路径", typeof archived === "string" && archived !== null);
	check("归档文件存在", archived !== null && existsSync(archived));
	check("归档内容 === 轮转前内容（不删历史）",
		archived !== null && readFileSync(archived, "utf8") === lines.join("\n") + "\n");
	check("活动文件已被移走（rotate 后不存在或为空）",
		!existsSync(active) || statSync(active).size === 0);
	check("归档名带 UTC 时间戳", archived !== null && /audit-\d{8}T\d{6}Z\.jsonl$/.test(archived));

	// appendAuditLine 在超阈值时应自动轮转
	writeFileSync(active, lines.join("\n") + "\n", "utf8");
	appendAuditLine("after-rotate-line", { stateDir });
	const jsonls = readdirSync(dir).filter((f) => f.startsWith("audit-"));
	check("appendAuditLine 触发自动轮转（目录出现 audit-*.jsonl）", jsonls.length >= 1);
	check("新行写入新的活动文件",
		readFileSync(active, "utf8").includes("after-rotate-line"));

	rmSync(stateDir, { recursive: true, force: true });
}

console.log("[2] 轮转负控：未超阈值不应轮转");
{
	const stateDir = freshStateDir("noRot");
	const dir = autonomyDir(stateDir);
	mkdirSync(dir, { recursive: true });
	const active = join(dir, "audit.jsonl");
	writeFileSync(active, "small\n", "utf8");
	const archived = rotateAuditIfNeeded({ stateDir, maxBytes: 1024 * 1024 });
	check("小文件不轮转（返回 null）", archived === null);
	check("小文件仍在原处", existsSync(active) && readFileSync(active, "utf8") === "small\n");
	rmSync(stateDir, { recursive: true, force: true });
}

console.log("[3] readAuditTail：小文件（窗口覆盖全文件）行为不变");
{
	const stateDir = freshStateDir("tailSmall");
	const dir = autonomyDir(stateDir);
	mkdirSync(dir, { recursive: true });
	const active = join(dir, "audit.jsonl");
	const lines = Array.from({ length: 10 }, (_, i) => `L${i}`);
	writeFileSync(active, lines.join("\n") + "\n", "utf8");
	const got = readAuditTail({ stateDir, limit: 3 });
	check("尾部 3 行正确", JSON.stringify(got) === JSON.stringify(["L7", "L8", "L9"]), JSON.stringify(got));
	rmSync(stateDir, { recursive: true, force: true });
}

console.log("[4] readAuditTail：大文件（窗口只能覆盖尾部）取到的行必须完整");
{
	const stateDir = freshStateDir("tailBig");
	const dir = autonomyDir(stateDir);
	mkdirSync(dir, { recursive: true });
	const active = join(dir, "audit.jsonl");
	// 造 ~3MB：每行 ~100 字节 × 30000 行
	const lines = Array.from({ length: 30000 }, (_, i) => `row-${i}-` + "y".repeat(80));
	writeFileSync(active, lines.join("\n") + "\n", "utf8");
	const size = statSync(active).size;
	check("测试文件 > 1MB", size > 1024 * 1024, `${(size/1024).toFixed(0)} KB`);

	const got = readAuditTail({ stateDir, limit: 5 });
	check("返回 5 行", got.length === 5, String(got.length));
	check("每行完整（未被窗口截断成半行）", got.every((l) => /^row-\d+-y+$/.test(l)), JSON.stringify(got.map(l=>l.slice(0,20))));
	check("内容 === 真正的最后 5 行",
		JSON.stringify(got) === JSON.stringify(lines.slice(-5)));

	// 首行被丢弃的验证：若窗口从中间切开，不能出现半截行
	check("无半截行混入", got.every((l) => !l.startsWith("ow-") && !l.startsWith("w-")), "首行截断未被丢弃");
	rmSync(stateDir, { recursive: true, force: true });
}

console.log("[5] readAuditTail：缺失文件 → []，不抛");
{
	const stateDir = freshStateDir("missing");
	const got = readAuditTail({ stateDir, limit: 5 });
	check("缺失文件返回空数组", Array.isArray(got) && got.length === 0);
	rmSync(stateDir, { recursive: true, force: true });
}

console.log("[6] 变异验证：若沿用旧实现（读全文件）则性能断言应失败");
{
	const stateDir = freshStateDir("perf");
	const dir = autonomyDir(stateDir);
	mkdirSync(dir, { recursive: true });
	const active = join(dir, "audit.jsonl");
	// ~8MB
	const lines = Array.from({ length: 80000 }, (_, i) => `p-${i}-` + "z".repeat(80));
	writeFileSync(active, lines.join("\n") + "\n", "utf8");


	// **预热 + 稳态基准**：首次调用带模块/FS 冷启动开销（实测 4-5ms），
	// 不预热会把冷启动误判成"尾部窗口没生效"；单次测量也不稳定（同代码两次结果可差 3x）。
	readAuditTail({ stateDir, limit: 5 });
	readFileSync(active, "utf8").split("\n").filter(Boolean).slice(-5);

	const its = 5;
	let tf = process.hrtime.bigint();
	for (let i = 0; i < its; i++) readAuditTail({ stateDir, limit: 5 });
	const fastMs = Number(process.hrtime.bigint() - tf) / 1e6 / its;

	tf = process.hrtime.bigint();
	for (let i = 0; i < its; i++) readFileSync(active, "utf8").split("\n").filter(Boolean).slice(-5);
	const slowMs = Number(process.hrtime.bigint() - tf) / 1e6 / its;

	// 阈值 10x：稳态实测 149x~580x（见 extensions/_probe_perf.ts）。
	// 旧实现（读全文件）**不可能**达到 10x，所以这条能真正分辨两种实现。
	check(
		`新实现显著快于读全文件（${fastMs.toFixed(2)}ms vs ${slowMs.toFixed(2)}ms，${(slowMs / fastMs).toFixed(0)}x）`,
		fastMs < slowMs / 10,
		`未达 10x ⇒ 尾部窗口可能已失效（退回读全文件）`,
	);
	rmSync(stateDir, { recursive: true, force: true });
}

console.log("");
if (failures.length === 0) {
	console.log(`✅ 全部通过：${pass} 项断言`);
	process.exit(0);
} else {
	console.log(`❌ ${failures.length} 项失败 / 共 ${pass + failures.length} 项`);
	failures.forEach((f) => console.log("  - " + f));
	process.exit(1);
}
