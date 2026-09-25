/**
 * _test_wechat_artifact.ts — 0925 M1 入站图片附件（worker 侧下载+解密+去重落盘，opt-in）离线单测
 *
 * 运行：npx tsx extensions/_test_wechat_artifact.ts（或 npm run test:wechat-artifact）。
 * 验收：plans/0925_wechat_artifact_M1_plan.md §5 V1–V17（对齐 recon §7 A1–A15）。
 * **零真网**：stub CDN = 本地 node:http（loopback，allowlist 经 extraHosts 显式注入 127.0.0.1）；
 * iLink stub 同 _test_wechat_receive 模式（只吸收子进程 getupdates）。
 *
 * 用例组：
 *   T1  漏斗单元：isHostAllowed 后缀正反 / deriveAesKey 三格式 / decryptImage PKCS7+魔数
 *   V6  原子写：故障注入 write/rename → 目标不存在、artifacts 树无 *.tmp
 *   T3  解析等价：gate OFF 输出逐字节等价（无 attachments 键）；ON 只抽 type=2 真机两键
 *   V1  白名单通过：JPEG/PNG 落盘、内容==明文、0600（win 跳过权限断言）、纯图合成 text:"" 记录
 *   V2  类型黑名单：type=4 不进漏斗（照旧 quarantine，CDN 零请求）；type=2 MZ 内容不落盘
 *   V3  魔数不符：随机字节 → magic-mismatch、0 落盘、无 tmp 残留
 *   V4  超限：Content-Length 谎报 + 流式 >8MB 两形态 → too-large、0 落盘
 *   V5  sha256 去重：同内容两消息 → files/ 恰 1 文件、artifactRef 相等
 *   V8  解密失败隔离：错 key → decrypt-failed 行 + 0 半成品 + 游标照常提交（含 mid_size 断言）
 *   V12 302 越域拒：host-not-allowed hops=1、越域响应体 0 落盘（同域重定向对照通过）
 *   V15 批预算：超预算剩余附件 fail-visible（batch-budget）、游标提交、下批正常
 *   V7  坏 JSON 恢复：坏 config → gate false；坏 inbox 记录跳过且注入不抛；坏 quarantine 行跳过
 *   V13 游标顺序：附件文件 + inbox(artifactRef) + 失败行全部先于 commitBatch 落盘
 *   V14 幂等/崩溃重放：commit 前抛 → 同批重放 → 文件 1、失败行 1、inbox 1
 *   V9  路径引用注入：正文含 〔附件：<绝对路径> (<mime>, <bytes>B)〕，无 base64/URL/key；纯图 text:""
 *   V17 投影：/v1/wechat/inbox 含 artifactRef（相对路径），无绝对盘符/URL/key
 *   V10 秘密哨兵：SENTINEL_TOKEN/AES_KEY/CDN_URL × 文件树+stdout/stderr+state/审计+端点响应 = 0 命中
 *   V11 opt-in OFF 零行为：缺省 gate → 零 CDN 请求/零目录/parseBatch 等价/注入正文精确等于旧格式
 */

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 测试隔离：PI_RUNTIME_DIR 先指到临时目录（懒加载默认路径全部生效；receive 测试同模式）
process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "wechat-art-test-env-")).replace(/[\\/]+$/, "");

import {
	ARTIFACT_REL_BASE,
	deriveAesKey,
	decryptImage,
	isHostAllowed,
	quarantineHasArtifactFailure,
	safeDownload,
	storeArtifact,
} from "./channel-wechat/artifact.ts";
import { parseBatch } from "./channel-wechat/parser.ts";
import { WechatStore, type InboundRecord } from "./channel-wechat/store.ts";
import { startWechatWorker, type WechatWorkerHandle, type WechatWorkerOptions } from "./channel-wechat/worker.ts";
import {
	readWechatArtifactConfig,
	wechatCredsPath,
	writeWechatCreds0600,
} from "./runtime-host/wechat-bind.ts";
import { tryInjectPending } from "./runtime-host/wechat-input.ts";
import { listOutboxItems } from "./runtime/message-outbox.ts";
import { classifyRemoteCommand } from "./runtime/wechat-remote-command.ts";
import { createRuntimeHostServer, type RuntimeHostHandle } from "./runtime-host/server.ts";
import { touchSessionHeartbeat } from "./timers.ts";

// ── 小工具（receive 测试同款）────────────────────────────────────────

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
	try {
		await fn();
		passed += 1;
		console.log(`  ok  ${name}`);
	} catch (e) {
		failures.push(name);
		console.error(`  FAIL ${name}\n${e instanceof Error ? e.stack : String(e)}`);
	}
}

function mkdtemp(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
	const t0 = Date.now();
	while (!cond()) {
		if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor 超时: ${what}`);
		await new Promise((r) => setTimeout(r, 25));
	}
}

function walkFiles(dir: string): { path: string; body: string }[] {
	const out: { path: string; body: string }[] = [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return out;
	}
	for (const name of entries) {
		const p = join(dir, name);
		let st;
		try {
			st = statSync(p);
		} catch {
			continue;
		}
		if (st.isDirectory()) out.push(...walkFiles(p));
		else {
			try {
				out.push({ path: p, body: readFileSync(p, "utf8") });
			} catch {
				/* 二进制/占用跳过 */
			}
		}
	}
	return out;
}

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const mask = (s: string): string => (s.length > 10 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s);

// ── 常量与夹具 ────────────────────────────────────────────────────────

const KEY_HEX = "00112233445566778899aabbccddeeff";
/** 真机主格式：base64(hex32)（44B base64 → 32B ASCII hex → 16B key）。 */
const RAW_KEY = Buffer.from(KEY_HEX, "utf8").toString("base64");
const WRONG_HEX = "ffeeddccbbaa99887766554433221100";
const WRONG_KEY = Buffer.from(WRONG_HEX, "utf8").toString("base64");

const JPEG_PLAIN = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("JFIF\0test-image-payload-0123456789abcdef")]);
const PNG_PLAIN = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from("PNG-body-test-payload-0123456789")]);
const MZ_PLAIN = Buffer.concat([Buffer.from("MZ"), Buffer.from("not-an-image-executable-payload-012345")]);

const SENTINEL_TOKEN = "SENTINEL_TOKEN_9f";
const SENTINEL_AES = "SENTINEL_AES_KEY_00"; // 非法 base64 ⇒ bad-key（绝不下载、绝不落盘）
const SENTINEL_CDN = "SENTINEL_CDN_URL_9x"; // 出现在 full_url 路径段（下载成功也不得持久化）

const ALLOWED = "openid-allowed-sentinel";
const SID = "owner-session-123";
const BODY = "BODY_SENTINEL_ART";

const owner = {
	agentAddress: "pi://master" as `pi://${string}`,
	sessionId: SID,
	generation: 1,
	attachedAt: "",
	lastHeartbeatAt: "",
	attemptId: "",
};

function enc(plain: Buffer, hex = KEY_HEX): Buffer {
	const c = createCipheriv("aes-128-ecb", Buffer.from(hex, "hex"), null);
	return Buffer.concat([c.update(plain), c.final()]);
}

/** 单内容项私聊消息（真机形状：数字 type + msg 包装 + from.id）。 */
function msgEntry(msgId: string, item: Record<string, unknown>, fromId = `wx_${msgId}`): Record<string, unknown> {
	return { id: msgId, msg: { from: { id: fromId, nickname: `昵称_${msgId}` }, item_list: [item] } };
}

function imageItem(plain: Buffer, url: string, key = RAW_KEY, midSize?: number): Record<string, unknown> {
	return {
		type: 2,
		image_item: { mid_size: midSize ?? plain.length, media: { full_url: url, aes_key: key } },
	};
}

const filesDirOf = (dir: string): string => join(dir, "wechat", "artifacts", "files");
function listArtifactFiles(dir: string): string[] {
	try {
		return readdirSync(filesDirOf(dir));
	} catch {
		return [];
	}
}
function tmpLeftovers(dir: string): string[] {
	try {
		return readdirSync(join(dir, "wechat", "artifacts")).filter((f) => f.endsWith(".tmp"));
	} catch {
		return [];
	}
}
function quarantineRaw(dir: string): string {
	try {
		return readFileSync(join(WechatStore.resolveDir(dir), "quarantine.jsonl"), "utf8");
	} catch {
		return "";
	}
}
function quarantineLines(dir: string): { msgId: string | null; reason: string }[] {
	return quarantineRaw(dir)
		.split("\n")
		.filter((l) => l.trim() !== "")
		.flatMap((l) => {
			try {
				return [JSON.parse(l) as { msgId: string | null; reason: string }];
			} catch {
				return [];
			}
		});
}
const failLines = (dir: string): { msgId: string | null; reason: string }[] =>
	quarantineLines(dir).filter((l) => l.reason.startsWith("附件失败[#"));

// ── stub CDN（本地 loopback；不触外网）────────────────────────────────

interface CdnStub {
	port: number;
	base: string;
	log: string[];
	hits: (p: string) => number;
	close: () => Promise<void>;
}

async function startCdn(): Promise<CdnStub> {
	const log: string[] = [];
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const u = new URL(req.url ?? "/", "http://127.0.0.1");
		log.push(u.pathname);
		res.on("error", () => {});
		const p = u.pathname;
		const send = (b: Buffer): void => {
			res.setHeader("content-type", "application/octet-stream");
			res.setHeader("content-length", String(b.length));
			res.end(b);
		};
		if (p === "/img/png") return void send(enc(PNG_PLAIN));
		if (p === "/img/mz") return void send(enc(MZ_PLAIN));
		if (p === "/img/random") return void send(enc(Buffer.concat([Buffer.from("RND~"), randomBytes(64)])));
		if (p === "/img/jpeg" || p.startsWith("/img/")) return void send(enc(JPEG_PLAIN));
		if (p === "/redirect/same") {
			res.statusCode = 302;
			res.setHeader("location", "/img/jpeg");
			res.end();
			return;
		}
		if (p === "/redirect/evil") {
			res.statusCode = 302;
			res.setHeader("location", "http://evil.example.com/img/jpeg");
			res.end();
			return;
		}
		if (p === "/redirect/loop") {
			res.statusCode = 302;
			res.setHeader("location", "/redirect/loop");
			res.end();
			return;
		}
		if (p === "/slow") {
			setTimeout(() => send(enc(JPEG_PLAIN)), 900);
			return;
		}
		if (p === "/big") {
			// 无 content-length ⇒ chunked 流式；9MB（> 8MB + 16B padding 余量）
			const chunk = Buffer.alloc(1024 * 1024, 7);
			for (let i = 0; i < 9; i++) res.write(chunk);
			res.end();
			return;
		}
		if (p === "/big-lie") {
			// Content-Length 谎报（999MB）+ 空 body → 客户头预拒，不读 body
			res.writeHead(200, { "content-length": String(999 * 1024 * 1024), "content-type": "application/octet-stream" });
			res.flushHeaders();
			const t = setTimeout(() => {
				try {
					res.destroy();
				} catch {
					/* ignore */
				}
			}, 1500);
			res.on("close", () => clearTimeout(t));
			return;
		}
		res.statusCode = 404;
		res.end("nf");
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
	const addr = server.address();
	const port = typeof addr === "object" && addr !== null ? addr.port : 0;
	return {
		port,
		base: `http://127.0.0.1:${port}`,
		log,
		hits: (p: string) => log.filter((x) => x === p).length,
		close: () => new Promise<void>((r) => server.close(() => r())),
	};
}

/** iLink stub（只吸收真子进程 getupdates；receive 测试同款形状）。 */
async function startStubIlink(): Promise<{ port: number; close: () => Promise<void> }> {
	let count = 0;
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const u = new URL(req.url ?? "/", "http://127.0.0.1");
		if (u.pathname === "/ilink/bot/getupdates") {
			count += 1;
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ ret: 0, buf: `stub-buf-${count}`, item_list: [] }));
			return;
		}
		res.statusCode = 404;
		res.end("nf");
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
	const addr = server.address();
	const port = typeof addr === "object" && addr !== null ? addr.port : 0;
	return { port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function writeFixtureConfig(path: string, wechat: Record<string, unknown>): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ channels: { wechat } }, null, 2)}\n`, "utf8");
}

function writeFixtureCreds(rt: string, baseUrl: string, token: string): void {
	writeWechatCreds0600(wechatCredsPath(rt), { botToken: token, boundAt: new Date().toISOString(), baseUrl });
}

function hostServerOpts(dir: string, configPath: string, rt: string): Parameters<typeof createRuntimeHostServer>[0] {
	return {
		hostPath: join(dir, "host.json"),
		timersDir: join(dir, "timers"),
		stateDir: join(dir, "state"),
		mailboxDir: join(dir, "m"),
		journalPath: join(dir, "events.jsonl"),
		sessionsDir: join(dir, "sessions"),
		lockWaitMs: 500,
		configPath,
		wechatRuntimeDir: rt,
	} as Parameters<typeof createRuntimeHostServer>[0];
}

/** 在跑 worker 注册表（测试失败时也不泄漏轮询循环——否则 ref'd 定时器拽住事件循环、进程不退出）。 */
const runningWorkers: WechatWorkerHandle[] = [];
function track(w: WechatWorkerHandle): WechatWorkerHandle {
	runningWorkers.push(w);
	return w;
}

/** gate-ON worker 工厂（脚本批次队列；队列空且已消费过目标批次 → **恒定回放尾 buf** ⇒ 游标稳定可断言）。 */
function flowWorker(dir: string, extra: Partial<WechatWorkerOptions> = {}): {
	store: WechatStore;
	w: WechatWorkerHandle;
	push: (buf: string, items: unknown[]) => void;
	logs: string[];
} {
	const store = new WechatStore(WechatStore.resolveDir(dir));
	const queue: { buf: string; items: unknown[] }[] = [];
	const logs: string[] = [];
	let last: string | null = null; // 最近一个出队的批次 buf（尾态稳定锚）
	const w = track(
		startWechatWorker({
			baseUrl: "https://stub.example",
			botToken: "T-flow",
			store,
			fetchUpdates: async () => {
				if (queue.length > 0) {
					const b = queue.shift()!;
					last = b.buf;
					return b;
				}
				// 稳定尾态：游标停在最后一个目标 buf（否则 5ms pollGap 的空批会把它冲掉，
				// waitFor 25ms 轮询会错过目标窗口——首版测试即踩此坑）。
				return { buf: last ?? "warmup", items: [] };
			},
			pollGapMs: 5,
			backoffStartMs: 40,
			backoffMaxMs: 80,
			log: (m) => void logs.push(m),
			readArtifactGate: () => true,
			artifactDir: join(dir, "wechat", "artifacts"),
			artifactExtraHosts: ["127.0.0.1"],
			...extra,
		}),
	);
	return { store, w, push: (buf, items) => void queue.push({ buf, items }), logs };
}

// ── T1 漏斗单元（纯函数直击）──────────────────────────────────────────

async function t1(): Promise<void> {
	// allowlist 后缀正/负（含 evilqq.com / qq.com.evil.com 两类经典绕过）
	for (const u of ["https://a.qq.com/x", "https://x.qpic.cn/y", "https://weixin.qq.com/z", "https://dl.cdn.cn/p"]) {
		assert.equal(isHostAllowed(u).ok, true, `应放行 ${u}`);
	}
	for (const u of ["https://evilqq.com/a", "https://qq.com.evil.com/a", "http://127.0.0.1:1/a", "ftp://x.qq.com/a", "not a url"]) {
		assert.equal(isHostAllowed(u).ok, false, `应拒绝 ${u}`);
	}
	assert.equal(isHostAllowed("http://127.0.0.1:1/a", ["127.0.0.1"]).ok, true, "显式 extra host 放行");
	assert.equal(isHostAllowed("https://X.QQ.COM/a").ok, true, "大小写不敏感");

	// deriveAesKey 三格式正/反
	assert.equal(deriveAesKey(RAW_KEY)?.toString("hex"), KEY_HEX, "① base64(hex32)");
	assert.equal(deriveAesKey(KEY_HEX)?.toString("hex"), KEY_HEX, "② 顶层 hex32 交叉");
	const raw16 = randomBytes(16);
	assert.deepEqual(deriveAesKey(raw16.toString("base64")), raw16, "③ 严格 base64(raw16)");
	for (const bad of [SENTINEL_AES, "", "   ", "not base64 !!", "z".repeat(64), Buffer.from("z".repeat(32)).toString("base64"), 42, null, undefined]) {
		assert.equal(deriveAesKey(bad as never), null, `乱码/非严格 → null（拒绝尽力解码）: ${String(bad).slice(0, 16)}`);
	}

	// decryptImage：PKCS7 通过 **且** 魔数 jpeg/png 才成功
	const key = Buffer.from(KEY_HEX, "hex");
	const d1 = decryptImage(enc(JPEG_PLAIN), key);
	assert.ok(d1.ok && d1.value.mime === "image/jpeg" && d1.value.ext === "jpg" && d1.value.plain.equals(JPEG_PLAIN), "JPEG 解密回环");
	const d2 = decryptImage(enc(PNG_PLAIN), key);
	assert.ok(d2.ok && d2.value.mime === "image/png" && d2.value.plain.equals(PNG_PLAIN), "PNG 解密回环");
	const d3 = decryptImage(enc(JPEG_PLAIN), Buffer.from(WRONG_HEX, "hex"));
	assert.equal(d3.ok, false, "错 key 必须失败");
	assert.equal(d3.ok === false && d3.reason, "decrypt-failed", "错 key → PKCS7 不过 → decrypt-failed");
	const d4 = decryptImage(enc(MZ_PLAIN), key);
	assert.equal(d4.ok === false && d4.reason, "magic-mismatch", "PKCS7 过但非白名单魔数 → magic-mismatch");
	const ct = enc(JPEG_PLAIN);
	const d5 = decryptImage(ct.subarray(0, ct.length - 1), key);
	assert.equal(d5.ok === false && d5.reason, "decrypt-failed", "密文非 16B 倍数 → decrypt-failed");

	// storeArtifact：内容寻址 + sha256 去重
	const dir = mkdtemp("wx-art-t1-");
	try {
		const adir = join(dir, "wechat", "artifacts");
		const r1 = storeArtifact(JPEG_PLAIN, { artifactsDir: adir });
		assert.ok(r1.ok, "首写成功");
		const sha = sha256(JPEG_PLAIN);
		assert.equal(r1.ok && r1.value.relPath, `${ARTIFACT_REL_BASE}/${sha}.jpg`, "relPath 内容寻址（纯 sha + 魔数扩展名）");
		const target = join(adir, "files", `${sha}.jpg`);
		assert.ok(readFileSync(target).equals(JPEG_PLAIN), "落盘内容 == 明文");
		if (process.platform !== "win32") assert.equal(statSync(target).mode & 0o777, 0o600, "0600");
		const r2 = storeArtifact(JPEG_PLAIN, { artifactsDir: adir });
		assert.ok(r2.ok && r2.value.deduped, "同内容第二次 → 去重命中");
		assert.deepEqual(readdirSync(join(adir, "files")), [`${sha}.jpg`], "files/ 恰 1 文件");
		// 路径安全：文件名不含原名/`..`（内容寻址天然防穿越）
		assert.ok(!readdirSync(join(adir, "files")).some((f) => f.includes("..") || f.includes("/") || f.includes("\\")));
		// 黑名单（以断言形式存在）：MZ 内容绝不派生扩展名落盘
		const rMZ = storeArtifact(MZ_PLAIN, { artifactsDir: adir });
		assert.equal(rMZ.ok, false, "MZ 内容拒绝落盘");
		assert.deepEqual(readdirSync(join(adir, "files")), [`${sha}.jpg`], "拒绝后 files/ 不变");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── V6 原子写（故障注入）──────────────────────────────────────────────

async function v6(): Promise<void> {
	const dir = mkdtemp("wx-art-v6-");
	try {
		const adir = join(dir, "wechat", "artifacts");
		const pngSha = sha256(PNG_PLAIN);
		const pngTarget = join(adir, "files", `${pngSha}.png`);
		for (const fault of ["write", "rename"] as const) {
			const r = storeArtifact(PNG_PLAIN, { artifactsDir: adir, fault });
			assert.equal(r.ok, false, `${fault} 故障 → 失败`);
			assert.equal(r.ok === false && r.reason, "write-failed", `${fault} 故障 → write-failed`);
			assert.equal(existsSync(pngTarget), false, `${fault} 故障 → 目标不存在`);
			assert.deepEqual(tmpLeftovers(adir), [], `${fault} 故障 → 无 *.tmp 残留`);
		}
		assert.deepEqual(readdirSync(join(adir, "files")), [], "files/ 仍为空（半成品绝不进正式路径）");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── T3 解析等价（gate OFF 逐字节 / ON 只抽真机两键）───────────────────

async function t3(): Promise<void> {
	const at = "2026-09-25T00:00:00.000Z";
	const url = "https://cdn.example.qq.com/a.jpg";
	const withImg: Record<string, unknown> = {
		id: "q1",
		msg: {
			from: { id: "fq", nickname: "nq" },
			item_list: [{ type: 2, image_item: { mid_size: JPEG_PLAIN.length, media: { full_url: url, aes_key: RAW_KEY } } }],
		},
	};
	const withImgNoMid: Record<string, unknown> = {
		id: "q2",
		msg: { from: { id: "fq2" }, item_list: [{ type: "2", image_item: { media: { full_url: url, aes_key: RAW_KEY } } }] },
	};
	const raw: unknown[] = [
		{ id: "p1", msg: { from: { id: "f1", nickname: "n1" }, item_list: [{ type: "text", text: "你好" }] } },
		{ id: "p2", msg: { from: { id: "f2" }, item_list: [{ type: "image", size: 5 }] } },
		{
			id: "p3",
			msg: {
				from: { id: "f3" },
				item_list: [{ type: 4, file_item: { file_name: "evil.exe", media: { full_url: url, aes_key: RAW_KEY } } }],
			},
		},
		{ id: "p4", msg: { from: { id: "f4" }, item_list: [{ type: 2 }] } },
		{ id: "p5", msg: { from: { id: "f5" }, item_list: [{ nope: 1 }] } },
	];

	const off = parseBatch(raw, at);
	assert.equal("attachments" in off, false, "OFF 返回对象不含 attachments 键（逐字节等价）");
	assert.deepEqual(parseBatch(raw, at, { extractAttachments: false }), off, "extractAttachments:false ≡ 缺省");
	// 字面量锚 = 改动前实现的输出（reason 全文锁死）
	assert.deepEqual(off, {
		items: [{ msgId: "p1", fromId: "f1", fromNickname: "n1", text: "你好", receivedAt: at }],
		quarantined: [
			{ msgId: "p2", reason: "非文本消息（type=image size=5；W1 不下载附件）", at, artifactPending: true },
			{ msgId: "p3", reason: "非文本消息（type=4；W1 不下载附件）", at, artifactPending: true },
			{ msgId: "p4", reason: "非文本消息（type=2；W1 不下载附件）", at, artifactPending: true },
			{ msgId: "p5", reason: "未知消息结构（无文本字段、无类型名）；shape={nope:number}", at },
		],
	});

	const on = parseBatch([withImg, withImgNoMid, ...raw], at, { extractAttachments: true });
	assert.equal(on.attachments?.length, 2, "ON：type=2 两键命中 → attachments（数字与字符串 type 均兼容）");
	assert.deepEqual(on.attachments?.[0], {
		msgId: "q1",
		itemIdx: 0,
		kind: "image",
		url,
		aesKey: RAW_KEY,
		midSize: JPEG_PLAIN.length,
		fromId: "fq",
		fromNickname: "nq",
	});
	assert.equal("midSize" in (on.attachments?.[1] ?? {}), false, "mid_size 缺席 ⇒ 不臆造");
	assert.deepEqual(on.quarantined, off.quarantined, "ON：type=3/4/无键/未知结构照旧 quarantine（reason 与 OFF 全等）");
	assert.deepEqual(on.items, off.items, "ON：文本抽取不变");
	assert.ok(!on.quarantined.some((q) => q.msgId === "q1" || q.msgId === "q2"), "命中项不再进 quarantine");
	// 键路径不命中（type=2 无 image_item）→ 落回 quarantine，不臆造键
	assert.ok(on.quarantined.some((q) => q.msgId === "p4" && q.reason.includes("type=2")), "type=2 无键 → 照旧 quarantine");
}

// ── V1 白名单通过（worker + stub CDN 全流程）──────────────────────────

async function v1(): Promise<void> {
	const cdn = await startCdn();
	const dir = mkdtemp("wx-art-v1-");
	try {
		const { store, w, push, logs } = flowWorker(dir);
		push("v1b1", [
			msgEntry("v1a", imageItem(JPEG_PLAIN, `${cdn.base}/img/jpeg`)),
			msgEntry("v1b", imageItem(PNG_PLAIN, `${cdn.base}/img/png`)),
		]);
		push("v1b2", []);
		await waitFor(() => store.getCursor().lastBuf === "v1b2", 10_000, "两图批次提交");
		await w.stop();

		const jpgSha = sha256(JPEG_PLAIN);
		const pngSha = sha256(PNG_PLAIN);
		assert.deepEqual(listArtifactFiles(dir).sort(), [`${jpgSha}.jpg`, `${pngSha}.png`].sort(), "files/ 恰 2 文件（魔数派生扩展名）");
		assert.ok(readFileSync(join(filesDirOf(dir), `${jpgSha}.jpg`)).equals(JPEG_PLAIN), "JPEG 内容 == 明文");
		assert.ok(readFileSync(join(filesDirOf(dir), `${pngSha}.png`)).equals(PNG_PLAIN), "PNG 内容 == 明文");
		if (process.platform !== "win32") {
			assert.equal(statSync(join(filesDirOf(dir), `${jpgSha}.jpg`)).mode & 0o777, 0o600, "0600");
		}
		const recs = store.readInbox(0);
		assert.equal(recs.length, 2, "纯图成功 → 合成 inbox 记录");
		for (const r of recs) {
			assert.equal(r.text, "", '纯图记录 text:""');
			assert.match(r.artifactRef ?? "", /^wechat\/artifacts\/files\/[0-9a-f]{64}\.(jpg|png)$/, "artifactRef 形态（内容寻址相对路径）");
		}
		const refs = recs.map((r) => r.artifactRef).sort();
		assert.deepEqual(refs, [`${ARTIFACT_REL_BASE}/${jpgSha}.jpg`, `${ARTIFACT_REL_BASE}/${pngSha}.png`].sort(), "artifactRef = 相对路径");
		assert.equal(store.readState().counts.received, 2, "received 计 2");
		assert.ok(logs.some((l) => l.startsWith("artifact ok: kind=image host=127.0.0.1")), "日志只记 kind/host/hops/bytes");
		assert.ok(logs.every((l) => !l.includes("://") && !l.includes(RAW_KEY)), "日志无 URL/key");
	} finally {
		await cdn.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── V2 类型黑名单（type=4 不进漏斗；type=2 MZ 不落盘）─────────────────

async function v2(): Promise<void> {
	const cdn = await startCdn();
	const dir = mkdtemp("wx-art-v2-");
	try {
		const { store, w, push } = flowWorker(dir);
		push("v2b1", [
			msgEntry("v2a", { type: 4, file_item: { file_name: "evil.exe", media: { full_url: `${cdn.base}/img/never`, aes_key: RAW_KEY } } }),
			msgEntry("v2b", imageItem(MZ_PLAIN, `${cdn.base}/img/mz`)),
		]);
		push("v2b2", []);
		await waitFor(() => store.getCursor().lastBuf === "v2b2", 10_000, "V2 批次提交");
		await w.stop();

		assert.deepEqual(listArtifactFiles(dir), [], "0 落盘（黑名单：可执行体结构进不来）");
		assert.deepEqual(tmpLeftovers(dir), [], "无 tmp 残留");
		const q = quarantineLines(dir);
		assert.ok(q.some((l) => l.msgId === "v2a" && l.reason === "非文本消息（type=4；W1 不下载附件）"), "type=4 照旧 quarantine（不进漏斗）");
		assert.ok(q.some((l) => l.msgId === "v2b" && l.reason === "附件失败[#0]:magic-mismatch（无 URL/key）"), "type=2 MZ → magic-mismatch 失败行");
		assert.equal(cdn.hits("/img/never"), 0, "type=4 绝不发起 CDN 请求");
		assert.equal(cdn.hits("/img/mz"), 1, "type=2 请求 1 次");
		assert.equal(store.readInbox(0).length, 0, "纯图失败不产 inbox 记录");
	} finally {
		await cdn.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── V3 魔数不符（随机字节）────────────────────────────────────────────

async function v3(): Promise<void> {
	const cdn = await startCdn();
	const dir = mkdtemp("wx-art-v3-");
	try {
		const { store, w, push } = flowWorker(dir);
		push("v3b1", [msgEntry("v3a", imageItem(Buffer.alloc(0), `${cdn.base}/img/random`))]);
		push("v3b2", []);
		await waitFor(() => store.getCursor().lastBuf === "v3b2", 10_000, "V3 批次提交");
		await w.stop();
		assert.deepEqual(listArtifactFiles(dir), [], "随机字节 → 0 落盘");
		assert.deepEqual(tmpLeftovers(dir), [], "无 tmp 残留");
		assert.ok(quarantineLines(dir).some((l) => l.msgId === "v3a" && l.reason === "附件失败[#0]:magic-mismatch（无 URL/key）"), "magic-mismatch 行");
		assert.equal(store.readInbox(0).length, 0);
	} finally {
		await cdn.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── V4 超限（Content-Length 谎报 + 流式 >8MB）────────────────────────

async function v4(): Promise<void> {
	const cdn = await startCdn();
	const dir = mkdtemp("wx-art-v4-");
	try {
		const { store, w, push } = flowWorker(dir);
		push("v4b1", [
			msgEntry("v4a", imageItem(Buffer.alloc(0), `${cdn.base}/big-lie`)),
			msgEntry("v4b", imageItem(Buffer.alloc(0), `${cdn.base}/big`)),
		]);
		push("v4b2", []);
		await waitFor(() => store.getCursor().lastBuf === "v4b2", 20_000, "V4 批次提交");
		await w.stop();
		const q = quarantineLines(dir);
		assert.ok(q.some((l) => l.msgId === "v4a" && l.reason === "附件失败[#0]:too-large（无 URL/key）"), "Content-Length 谎报 → too-large（预拒）");
		assert.ok(q.some((l) => l.msgId === "v4b" && l.reason === "附件失败[#0]:too-large（无 URL/key）"), "流式超限 → too-large（复拒）");
		assert.deepEqual(listArtifactFiles(dir), [], "0 落盘");
		assert.equal(store.readInbox(0).length, 0);
	} finally {
		await cdn.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── V5 sha256 去重（同内容两消息）─────────────────────────────────────

async function v5(): Promise<void> {
	const cdn = await startCdn();
	const dir = mkdtemp("wx-art-v5-");
	try {
		const { store, w, push } = flowWorker(dir);
		push("v5b1", [
			msgEntry("v5a", imageItem(JPEG_PLAIN, `${cdn.base}/img/jpeg`)),
			msgEntry("v5b", imageItem(JPEG_PLAIN, `${cdn.base}/img/jpeg`)),
		]);
		push("v5b2", []);
		await waitFor(() => store.getCursor().lastBuf === "v5b2", 10_000, "V5 批次提交");
		await w.stop();
		const sha = sha256(JPEG_PLAIN);
		assert.deepEqual(listArtifactFiles(dir), [`${sha}.jpg`], "同内容 → files/ 恰 1 文件");
		const recs = store.readInbox(0);
		assert.equal(recs.length, 2, "两条记录都在");
		assert.equal(recs[0]!.artifactRef, recs[1]!.artifactRef, "两 artifactRef 相等（共享同一路径）");
		assert.equal(recs[0]!.artifactRef, `${ARTIFACT_REL_BASE}/${sha}.jpg`);
		assert.equal(cdn.hits("/img/jpeg"), 2, "两次下载各自发生（去重在落盘点）");
	} finally {
		await cdn.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── V8 解密失败隔离 + mid_size 断言（游标照常提交）────────────────────

async function v8(): Promise<void> {
	const cdn = await startCdn();
	const dir = mkdtemp("wx-art-v8-");
	try {
		const { store, w, push } = flowWorker(dir);
		push("v8b1", [
			msgEntry("v8a", imageItem(JPEG_PLAIN, `${cdn.base}/img/jpeg`, WRONG_KEY)),
			msgEntry("v8b", imageItem(JPEG_PLAIN, `${cdn.base}/img/jpeg`, RAW_KEY, JPEG_PLAIN.length + 5)),
			msgEntry("v8c", imageItem(PNG_PLAIN, `${cdn.base}/img/png`)),
		]);
		push("v8b2", []);
		await waitFor(() => store.getCursor().lastBuf === "v8b2", 10_000, "V8 批次提交（游标不卡死）");
		await w.stop();
		const q = quarantineLines(dir);
		assert.ok(q.some((l) => l.msgId === "v8a" && l.reason === "附件失败[#0]:decrypt-failed（无 URL/key）"), "错 key → decrypt-failed 行（含 msgId）");
		assert.ok(q.some((l) => l.msgId === "v8b" && l.reason === "附件失败[#0]:mid-size-mismatch（无 URL/key）"), "mid_size 不等 → 不落盘");
		assert.deepEqual(listArtifactFiles(dir), [`${sha256(PNG_PLAIN)}.png`], "0 半成品：只有成功那 1 个文件");
		const recs = store.readInbox(0);
		assert.equal(recs.length, 1, "成功项入 inbox；失败项无记录（quarantine 可查可恢复）");
		assert.equal(recs[0]!.msgId, "v8c");
		assert.equal(store.getCursor().epoch >= 2, true, "批照常提交（单附件失败绝不卡游标）");
	} finally {
		await cdn.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── V12 302 越域拒（+ 同域重定向对照 + 日志脱敏）──────────────────────

async function v12(): Promise<void> {
	const cdn = await startCdn();
	const dir = mkdtemp("wx-art-v12-");
	try {
		const { store, w, push, logs } = flowWorker(dir);
		push("v12b1", [
			msgEntry("v12a", imageItem(JPEG_PLAIN, `${cdn.base}/redirect/evil`)),
			msgEntry("v12b", imageItem(JPEG_PLAIN, `${cdn.base}/redirect/same`)),
			msgEntry("v12c", imageItem(JPEG_PLAIN, `${cdn.base}/redirect/loop`)),
		]);
		push("v12b2", []);
		await waitFor(() => store.getCursor().lastBuf === "v12b2", 10_000, "V12 批次提交");
		await w.stop();
		const q = quarantineLines(dir);
		assert.ok(q.some((l) => l.msgId === "v12a" && l.reason === "附件失败[#0]:host-not-allowed（无 URL/key）"), "302 越域 → host-not-allowed");
		assert.ok(q.some((l) => l.msgId === "v12c" && l.reason === "附件失败[#0]:too-many-hops（无 URL/key）"), "跳数超限 → too-many-hops");
		assert.ok(logs.some((l) => l.includes("host=evil.example.com") && l.includes("hops=1")), `越域 hops=1 可见：${logs.join(" | ")}`);
		assert.deepEqual(listArtifactFiles(dir), [`${sha256(JPEG_PLAIN)}.jpg`], "越域响应体 0 落盘；同域重定向对照通过");
		assert.equal(store.readInbox(0).length, 1, "只有同域重定向那条成功");
		assert.ok(logs.every((l) => !l.includes("://") && !l.includes(RAW_KEY)), "日志无完整 URL/key");
	} finally {
		await cdn.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── V15 批预算（超预算剩余附件 fail-visible、游标提交、下批正常）──────

async function v15(): Promise<void> {
	const cdn = await startCdn();
	const dir = mkdtemp("wx-art-v15-");
	try {
		const { store, w, push } = flowWorker(dir, { artifactBatchBudgetMs: 200 });
		push("v15b1", [
			msgEntry("v15a", imageItem(JPEG_PLAIN, `${cdn.base}/slow`)), // ~900ms，吃掉批预算
			msgEntry("v15b", imageItem(PNG_PLAIN, `${cdn.base}/img/png`)), // 超预算 → batch-budget
		]);
		push("v15b2", []);
		await waitFor(() => store.getCursor().lastBuf === "v15b2", 10_000, "V15 批提交（不卡死）");
		assert.ok(quarantineLines(dir).some((l) => l.msgId === "v15b" && l.reason === "附件失败[#0]:batch-budget（无 URL/key）"), "剩余附件 → batch-budget fail-visible");
		push("v15b3", [msgEntry("v15c", imageItem(PNG_PLAIN, `${cdn.base}/img/png`))]);
		await waitFor(() => store.getCursor().lastBuf === "v15b3", 10_000, "下批正常");
		await w.stop();
		assert.deepEqual(listArtifactFiles(dir).sort(), [`${sha256(JPEG_PLAIN)}.jpg`, `${sha256(PNG_PLAIN)}.png`].sort(), "预算内 1 个 + 下批 1 个");
		assert.equal(store.readInbox(0).length, 2);
	} finally {
		await cdn.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── V7 坏 JSON 恢复 ───────────────────────────────────────────────────

async function v7(): Promise<void> {
	const dir = mkdtemp("wx-art-v7-");
	try {
		// ① 坏 config → gate=false（never-throw / fail-closed）
		const cfg = join(dir, "config.json");
		writeFileSync(cfg, "{oops");
		assert.equal(readWechatArtifactConfig(cfg).enabled, false, "坏 JSON → false");
		writeFileSync(cfg, JSON.stringify({ channels: { wechat: { artifact: { enabled: "true" } } } }));
		assert.equal(readWechatArtifactConfig(cfg).enabled, false, "非 true 字符串 → false");
		writeFileSync(cfg, JSON.stringify({ channels: { wechat: {} } }));
		assert.equal(readWechatArtifactConfig(cfg).enabled, false, "缺段 → false");
		assert.equal(readWechatArtifactConfig(join(dir, "missing.json")).enabled, false, "缺文件 → false");

		// ② 坏 inbox 记录 → readInbox 跳过；注入不抛
		const store = new WechatStore(WechatStore.resolveDir(dir));
		mkdirSync(join(WechatStore.resolveDir(dir), "inbox"), { recursive: true });
		writeFileSync(join(WechatStore.resolveDir(dir), "inbox", "garbage.json"), "not-json{{{");
		store.putInbox({ msgId: "v7ok", fromId: ALLOWED, fromNickname: null, text: BODY, receivedAt: "2026-01-01T00:00:01.000Z", state: "pending" });
		assert.equal(store.readInbox(0).length, 1, "坏记录被跳过、好记录在");
		const inCfg = join(dir, "input.json");
		writeFileSync(inCfg, JSON.stringify({ channels: { wechat: { input: { enabled: true, allowFrom: [ALLOWED] } } } }));
		const timers = join(dir, "timers");
		touchSessionHeartbeat(timers, SID);
		let injected = false;
		let threw: unknown = null;
		try {
			injected = tryInjectPending({ runtimeDir: dir, configPath: inCfg, timersDir: timers, stateDir: join(dir, "state"), readOwner: () => owner, alive: () => true }).injected;
		} catch (e) {
			threw = e;
		}
		assert.equal(threw, null, "坏 inbox 记录存在时注入不抛");
		assert.equal(injected, true, "好记录照常注入");

		// ③ 坏 quarantine 行 → 预扫描跳过（不抛）
		const qPath = join(WechatStore.resolveDir(dir), "quarantine.jsonl");
		writeFileSync(qPath, `{bad line\n${JSON.stringify({ msgId: "v7q", reason: "附件失败[#0]:decrypt-failed（无 URL/key）", at: "t" })}\n`);
		assert.equal(quarantineHasArtifactFailure(qPath, "v7q", 0), true, "有效失败行命中（坏行被跳过）");
		assert.equal(quarantineHasArtifactFailure(qPath, "v7q", 1), false, "不同 itemIdx 不命中");
		assert.equal(quarantineHasArtifactFailure(qPath, "other", 0), false);
		assert.equal(quarantineHasArtifactFailure(join(dir, "nope.json"), "v7q", 0), false, "缺文件 → false 不抛");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── V13 游标顺序（文件 + inbox(artifactRef) + 失败行全部先于 commit）────

async function v13(): Promise<void> {
	const cdn = await startCdn();
	const dir = mkdtemp("wx-art-v13-");
	try {
		const real = new WechatStore(WechatStore.resolveDir(dir));
		const sha = sha256(JPEG_PLAIN);
		const rel = `${ARTIFACT_REL_BASE}/${sha}.jpg`;
		let snap: { file: boolean; ref: boolean; qline: boolean } | null = null;
		const proxied = new Proxy(real, {
			get(target, prop) {
				if (prop === "commitBatch") {
					return (prevBuf: string, nextBuf: string, recs: InboundRecord[]): void => {
						snap = {
							file: existsSync(join(filesDirOf(dir), `${sha}.jpg`)),
							ref: target.readInbox(0).some((r) => r.artifactRef === rel),
							qline: quarantineRaw(dir).includes("附件失败[#0]:http-404"),
						};
						return target.commitBatch(prevBuf, nextBuf, recs);
					};
				}
				const v = Reflect.get(target, prop, target);
				return typeof v === "function" ? v.bind(target) : v;
			},
		});
		let sent = false;
		const w = track(startWechatWorker({
			baseUrl: "https://stub.example",
			botToken: "T",
			store: proxied as WechatStore,
			fetchUpdates: async () => (sent ? { buf: "v13done", items: [] } : ((sent = true), { buf: "v13a", items: [
				msgEntry("v13a", imageItem(JPEG_PLAIN, `${cdn.base}/img/jpeg`)),
				msgEntry("v13b", imageItem(JPEG_PLAIN, `${cdn.base}/404`)),
			] })),
			pollGapMs: 5,
			readArtifactGate: () => true,
			artifactDir: join(dir, "wechat", "artifacts"),
			artifactExtraHosts: ["127.0.0.1"],
		}));
		await waitFor(() => real.getCursor().lastBuf === "v13done", 10_000, "V13 完成");
		await w.stop();
		assert.ok(snap !== null, "commitBatch 已执行");
		assert.equal(snap!.file, true, "commit 时刻附件文件已在盘（先落盘后提交）");
		assert.equal(snap!.ref, true, "commit 时刻 inbox 记录已带 artifactRef");
		assert.equal(snap!.qline, true, "commit 时刻失败 quarantine 行已在盘");
	} finally {
		await cdn.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── V14 幂等/崩溃重放（commit 前抛 → 同批重放 → 文件1/失败行1/inbox1）──

async function v14(): Promise<void> {
	const cdn = await startCdn();
	const dir = mkdtemp("wx-art-v14-");
	try {
		const real = new WechatStore(WechatStore.resolveDir(dir));
		const order: string[] = [];
		const proxied = new Proxy(real, {
			get(target, prop) {
				if (prop === "commitBatch") {
					return (): void => {
						order.push("commit:THROW");
						throw new Error("注入崩溃：commit 前断电");
					};
				}
				const v = Reflect.get(target, prop, target);
				return typeof v === "function" ? v.bind(target) : v;
			},
		});
		const batch = [
			msgEntry("v14a", imageItem(JPEG_PLAIN, `${cdn.base}/img/jpeg`)),
			msgEntry("v14b", imageItem(JPEG_PLAIN, `${cdn.base}/img/jpeg`, WRONG_KEY)),
		];
		const gate = {
			readArtifactGate: () => true,
			artifactDir: join(dir, "wechat", "artifacts"),
			artifactExtraHosts: ["127.0.0.1"],
		};
		const wA = track(startWechatWorker({
			baseUrl: "https://stub.example",
			botToken: "T",
			store: proxied as WechatStore,
			fetchUpdates: async () => ({ buf: "rb1", items: batch }),
			pollGapMs: 5,
			backoffStartMs: 300,
			backoffMaxMs: 600,
			...gate,
		}));
		await waitFor(() => order.includes("commit:THROW"), 8000, "A 触发 commit 崩溃");
		await wA.stop();
		assert.equal(listArtifactFiles(dir).length, 1, "崩溃前文件已落 1 个");
		assert.equal(real.readInbox(0).length, 1, "崩溃前 inbox 已落 1 条");
		assert.equal(failLines(dir).length, 1, "崩溃前失败行已落 1 行");
		assert.equal(real.getCursor().lastBuf, "", "崩溃点游标未推进");
		const hitsAfterA = cdn.hits("/img/jpeg");

		// 新实例同批重放（服务端 seq 回放语义）
		let sent = false;
		const wB = track(startWechatWorker({
			baseUrl: "https://stub.example",
			botToken: "T",
			store: real,
			fetchUpdates: async () => (sent ? { buf: "rb1x", items: [] } : ((sent = true), { buf: "rb1x", items: batch })),
			pollGapMs: 5,
			...gate,
		}));
		await waitFor(() => real.getCursor().lastBuf === "rb1x", 10_000, "B 提交新游标");
		await wB.stop();
		assert.equal(listArtifactFiles(dir).length, 1, "重放不重复落文件（幂等跳过 + sha 去重）");
		assert.equal(failLines(dir).length, 1, "失败行不重复追加（msgId+itemIdx 预扫描）");
		assert.equal(real.readInbox(0).length, 1, "inbox 恰一条");
		assert.equal(real.readState().counts.quarantined, 1, "quarantined 只计 1");
		assert.equal(cdn.hits("/img/jpeg"), hitsAfterA, "重放零新下载（已有 ref / 失败行 → 跳过）");
	} finally {
		await cdn.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── V9 路径引用注入（+ 纯图 text:"" 注入形态）─────────────────────────

async function v9(): Promise<void> {
	const dir = mkdtemp("wx-art-v9-");
	try {
		const store = new WechatStore(WechatStore.resolveDir(dir));
		const sha = sha256(JPEG_PLAIN);
		const rel = `${ARTIFACT_REL_BASE}/${sha}.jpg`;
		mkdirSync(filesDirOf(dir), { recursive: true });
		writeFileSync(join(filesDirOf(dir), `${sha}.jpg`), JPEG_PLAIN);
		store.putInbox({ msgId: "v9text", fromId: ALLOWED, fromNickname: null, text: "看这张图", receivedAt: "2026-01-01T00:00:01.000Z", state: "pending", artifactRef: rel });
		store.putInbox({ msgId: "v9pure", fromId: ALLOWED, fromNickname: null, text: "", receivedAt: "2026-01-01T00:00:02.000Z", state: "pending", artifactRef: rel });
		const cfg = join(dir, "config.json");
		writeFileSync(cfg, JSON.stringify({ channels: { wechat: { input: { enabled: true, allowFrom: [ALLOWED] } } } }));
		const timers = join(dir, "timers");
		touchSessionHeartbeat(timers, SID);
		const base = { runtimeDir: dir, configPath: cfg, timersDir: timers, stateDir: join(dir, "state"), readOwner: () => owner, alive: () => true };
		assert.equal(tryInjectPending(base).injected, true, "混合记录注入成功");
		assert.equal(tryInjectPending(base).injected, true, "纯图记录注入成功");
		const items = listOutboxItems(join(dir, "state", "message-outbox")) as unknown as { text: string }[];
		assert.equal(items.length, 2);
		const abs = join(dir, rel);
		const suffix = `〔附件：${abs} (image/jpeg, ${JPEG_PLAIN.length}B)〕`;
		assert.equal(items[0]!.text, `[微信 ${mask(ALLOWED)}] 看这张图 ${suffix}`, "混合消息：旧正文 + 一个带前导空格的路径后缀");
		assert.equal(items[1]!.text, `[微信 ${mask(ALLOWED)}] ${suffix}`, "纯图：正文即路径后缀");
		const all = items.map((i) => i.text).join("\n");
		assert.ok(!all.includes(enc(JPEG_PLAIN).toString("base64")), "无 base64 密文块");
		assert.ok(!all.includes(RAW_KEY) && !all.includes(WRONG_KEY), "无 aes_key");
		assert.ok(!/https?:\/\//.test(all), "无 CDN URL");
		assert.ok(!all.includes("aes_key") && !all.includes("full_url"), "无键名");
		assert.ok(all.includes(abs), "含绝对路径（注入时 join 现解）");
		assert.equal(classifyRemoteCommand("").kind, "not-command", "纯图 text:\"\" 过命令门");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── V17 投影（/v1/wechat/inbox 含相对 artifactRef，无盘符/URL/key）─────

async function v17(): Promise<void> {
	const dir = mkdtemp("wx-art-v17-");
	let h: RuntimeHostHandle | null = null;
	try {
		const rt = join(dir, "wechat-rt");
		mkdirSync(rt, { recursive: true });
		const cfg = join(dir, "config.json");
		// 无 credentials ⇒ supervisor 不 spawn（端点只读，零副作用）
		writeFixtureConfig(cfg, { enabled: true, receive: { enabled: true } });
		const rel = `${ARTIFACT_REL_BASE}/${sha256(JPEG_PLAIN)}.jpg`;
		const store = new WechatStore(WechatStore.resolveDir(rt));
		store.putInbox({ msgId: "v17a", fromId: ALLOWED, fromNickname: null, text: "投影记录", receivedAt: "2026-01-01T00:00:01.000Z", state: "pending", artifactRef: rel });
		h = await createRuntimeHostServer(hostServerOpts(dir, cfg, rt));
		const base = `http://127.0.0.1:${h.info.port}`;
		const H = { "x-command-token": h.info.token };
		const body = await (await fetch(`${base}/v1/wechat/inbox?limit=10`, { headers: H })).text();
		const j = JSON.parse(body) as { messages: { msgId: string; artifactRef?: string }[] };
		assert.equal(j.messages[0]?.artifactRef, rel, "投影含 artifactRef（相对路径）");
		assert.ok(!body.includes(rt), "响应不含绝对盘符/runtimeDir");
		assert.ok(!body.includes(RAW_KEY) && !/https?:\/\//.test(body), "响应无 URL/key");
		assert.ok(!body.includes(join(dir, "wechat")), "无绝对布局");
		// 其余两个只读端点同样 200 且无绝对路径
		for (const p of ["/v1/wechat/quarantine", "/v1/wechat/worker/status"]) {
			const b = await (await fetch(`${base}${p}`, { headers: H })).text();
			assert.ok(!b.includes(rt) && !b.includes(RAW_KEY), `${p} 无绝对路径/key`);
		}
	} finally {
		if (h !== null) await h.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── V10 秘密哨兵（token/aes_key/CDN URL × 文件树+输出+审计+端点）────────

async function v10(): Promise<void> {
	const cdn = await startCdn();
	const stub = await startStubIlink();
	const dir = mkdtemp("wx-art-v10-");
	let h: RuntimeHostHandle | null = null;
	let w: WechatWorkerHandle | null = null;
	const captured: string[] = [];
	const origLog = console.log;
	const origErr = console.error;
	console.log = ((...a: unknown[]) => void captured.push(a.map(String).join(" "))) as typeof console.log;
	console.error = ((...a: unknown[]) => void captured.push(a.map(String).join(" "))) as typeof console.error;
	try {
		const rt = join(dir, "wechat-rt"); // daemon 树（credentials.json 哨兵例外 + 端点投影）
		const rt2 = join(dir, "artifact-worker-rt"); // gate-ON worker 树（无 creds ⇒ 无子进程同游标争用）
		mkdirSync(rt, { recursive: true });
		mkdirSync(rt2, { recursive: true });
		const cfg = join(dir, "config.json");
		writeFixtureConfig(cfg, { enabled: true, receive: { enabled: true }, artifact: { enabled: true } });
		writeFixtureCreds(rt, `http://127.0.0.1:${stub.port}`, SENTINEL_TOKEN);
		h = await createRuntimeHostServer(hostServerOpts(dir, cfg, rt));

		// gate-ON worker：成功项 URL 含 CDN 哨兵（下载成功也绝不持久化）+ bad-key 项 aes_key 哨兵（绝不联网）
		const store2 = new WechatStore(WechatStore.resolveDir(rt2));
		const logs: string[] = [];
		let sent = false;
		w = track(startWechatWorker({
			baseUrl: "https://stub.example",
			botToken: "T",
			store: store2,
			fetchUpdates: async () =>
				sent
					? { buf: "sent-done", items: [] }
					: ((sent = true), {
							buf: "sent-1",
							items: [
								msgEntry("secA", imageItem(JPEG_PLAIN, `${cdn.base}/img/${SENTINEL_CDN}`)),
								msgEntry("secB", imageItem(JPEG_PLAIN, `${cdn.base}/img/other`, SENTINEL_AES)),
							],
						}),
			pollGapMs: 5,
			log: (m) => void logs.push(m),
			readArtifactGate: () => true,
			artifactDir: join(rt2, "wechat", "artifacts"),
			artifactExtraHosts: ["127.0.0.1"],
		}));
		await waitFor(() => store2.getCursor().lastBuf === "sent-done" && store2.readInbox(0).length === 1, 10_000, "哨兵批完成");
		await w.stop();
		w = null;
		assert.equal(listArtifactFiles(rt2).length, 1, "成功项照常落盘（哨兵 URL 不入文件内容）");
		assert.equal(cdn.hits("/img/other"), 0, "bad-key 绝不联网");

		// 注入（独立 config，避免 daemon watch 抢跑）→ 审计 + outbox
		const inCfg = join(dir, "input.json");
		writeFileSync(inCfg, JSON.stringify({ channels: { wechat: { input: { enabled: true, allowFrom: ["wx_secA"] } } } }));
		const timers = join(dir, "timers");
		touchSessionHeartbeat(timers, SID);
		const inj = tryInjectPending({ runtimeDir: rt2, configPath: inCfg, timersDir: timers, stateDir: join(rt2, "state"), readOwner: () => owner, alive: () => true });
		assert.equal(inj.injected, true, "注入成功（审计/outbox 落盘，随后入扫描面）");

		// rt 树投影记录（端点响应进扫描面）
		new WechatStore(WechatStore.resolveDir(rt)).putInbox({
			msgId: "secProj",
			fromId: "wx_proj",
			fromNickname: null,
			text: "投影记录",
			receivedAt: "2026-01-01T00:00:00.000Z",
			state: "pending",
			artifactRef: `${ARTIFACT_REL_BASE}/${sha256(JPEG_PLAIN)}.jpg`,
		});

		// 端点响应
		const base = `http://127.0.0.1:${h.info.port}`;
		const H = { "x-command-token": h.info.token };
		const bodies: string[] = [];
		for (const p of ["/v1/wechat/inbox?limit=10", "/v1/wechat/quarantine", "/v1/wechat/worker/status", "/v1/wechat/bind/status"]) {
			bodies.push(await (await fetch(`${base}${p}`, { headers: H })).text());
		}
		assert.ok(bodies[0]!.includes("artifactRef"), "端点确实投影了 artifactRef（扫描面有意义）");

		// 扫描：整目录树（credentials.json 仅 token 例外）+ stdout/stderr + worker 日志 + 端点响应
		const scanned = [
			...walkFiles(dir).filter((f) => !f.path.endsWith(join("wechat", "credentials.json"))),
			...captured.map((c, i) => ({ path: `console:${i}`, body: c })),
			...logs.map((l, i) => ({ path: `worker-log:${i}`, body: l })),
			...bodies.map((b, i) => ({ path: `http:${i}`, body: b })),
		];
		const sentinels = [SENTINEL_TOKEN, SENTINEL_AES, SENTINEL_CDN];
		const hits = scanned.flatMap((f) => sentinels.filter((s) => f.body.includes(s)).map((s) => `${f.path} ← ${s}`));
		assert.deepEqual(hits, [], "秘密哨兵 0 命中（文件树+输出+日志+投影）");
		// 例外面：credentials.json 合法持有 bot_token（唯一允许位置）
		assert.ok(readFileSync(wechatCredsPath(rt), "utf8").includes(SENTINEL_TOKEN), "凭据文件合法持有 token（例外生效）");
		assert.ok(logs.every((l) => !l.includes("://")), "worker 日志无完整 URL");
	} finally {
		console.log = origLog;
		console.error = origErr;
		if (w !== null) await w.stop();
		if (h !== null) await h.close();
		await cdn.close();
		await stub.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── V11 opt-in OFF 零行为 ─────────────────────────────────────────────

async function v11(): Promise<void> {
	const cdn = await startCdn();
	const dir = mkdtemp("wx-art-v11-");
	try {
		const store = new WechatStore(WechatStore.resolveDir(dir));
		let fetches = 0;
		let sent = false;
		// readArtifactGate **缺省**（不传）；artifactDir/fetch 传了也必须零调用 —— 证明由门控制
		const w = track(startWechatWorker({
			baseUrl: "https://stub.example",
			botToken: "T",
			store,
			fetchUpdates: async () =>
				sent
					? { buf: "off2", items: [] }
					: ((sent = true), { buf: "off1", items: [msgEntry("off1", imageItem(JPEG_PLAIN, `${cdn.base}/img/jpeg`, RAW_KEY))] }),
			pollGapMs: 5,
			artifactDir: join(dir, "wechat", "artifacts"),
			artifactFetch: async () => {
				fetches += 1;
				throw new Error("OFF 不得发起附件下载");
			},
		}));
		await waitFor(() => store.getCursor().lastBuf === "off2", 10_000, "OFF 批次提交");
		await w.stop();
		assert.equal(fetches, 0, "零 CDN fetch");
		assert.deepEqual(cdn.log, [], "stub CDN 零请求");
		assert.equal(existsSync(join(dir, "wechat", "artifacts")), false, "零 artifacts 目录");
		assert.equal(store.readInbox(0).length, 0, "纯图不产 inbox（今天形态）");
		assert.ok(
			quarantineLines(dir).some((l) => l.msgId === "off1" && l.reason === "非文本消息（type=2；W1 不下载附件）"),
			"quarantine 文案与今天逐字节同",
		);
		assert.equal("attachments" in parseBatch([msgEntry("x", imageItem(JPEG_PLAIN, `${cdn.base}/img/jpeg`))], "t"), false, "parseBatch 第三参不生效");

		// 注入正文精确等于旧格式 `[微信 <mask>] <text>`（无附件后缀）
		const cfg2 = join(dir, "config.json");
		writeFileSync(cfg2, JSON.stringify({ channels: { wechat: { input: { enabled: true, allowFrom: [ALLOWED] } } } }));
		store.putInbox({ msgId: "offinj", fromId: ALLOWED, fromNickname: null, text: BODY, receivedAt: "2026-01-01T00:00:01.000Z", state: "pending" });
		const timers = join(dir, "timers");
		touchSessionHeartbeat(timers, SID);
		const r = tryInjectPending({ runtimeDir: dir, configPath: cfg2, timersDir: timers, stateDir: join(dir, "state"), readOwner: () => owner, alive: () => true });
		assert.equal(r.injected, true);
		const text = (listOutboxItems(join(dir, "state", "message-outbox")) as unknown as { text: string }[])[0]!.text;
		assert.equal(text, `[微信 ${mask(ALLOWED)}] ${BODY}`, "注入正文精确等于旧格式（OFF 零行为外部锚）");
	} finally {
		await cdn.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── main ──────────────────────────────────────────────────────────────

const WATCHDOG_MS = 240_000;
const watchdog = setTimeout(() => {
	const handles = (process as unknown as { _getActiveHandles?: () => { constructor?: { name?: string } }[] })._getActiveHandles?.() ?? [];
	console.error(`\n[watchdog] 超过 ${WATCHDOG_MS}ms 未结束 —— 判定卡死并强制退出（exit 3）`);
	console.error(`[watchdog] 活跃句柄: ${handles.map((h) => h?.constructor?.name ?? "?").join(", ")}`);
	process.exit(3);
}, WATCHDOG_MS);
watchdog.unref?.();

const t0 = Date.now();
try {
	console.log("wechat-artifact M1 离线单测（临时 runtimeDir + loopback stub CDN，零真网；计划 §5 V1–V17）：");
	await test("T1 漏斗单元：allowlist 后缀正反 / deriveAesKey 三格式 / decryptImage PKCS7+魔数 / 内容寻址去重", t1);
	await test("V6 原子写：故障注入 write/rename → 目标不存在、artifacts 树无 *.tmp 残留", v6);
	await test("T3 解析等价：OFF 逐字节（无 attachments 键）/ ON 只抽 type=2 真机两键、其余照旧 quarantine", t3);
	await test("V1 白名单通过：JPEG/PNG 落盘（内容==明文、0600）、纯图合成 text:\"\" 记录 + artifactRef", v1);
	await test("V2 类型黑名单：type=4 不进漏斗（CDN 零请求）；type=2 MZ 内容 → magic-mismatch 不落盘", v2);
	await test("V3 魔数不符：随机字节 → magic-mismatch、0 落盘、无 tmp 残留", v3);
	await test("V4 超限：Content-Length 谎报 + 流式 >8MB 两形态 → too-large、0 落盘", v4);
	await test("V5 sha256 去重：同内容两消息 → files/ 恰 1 文件、两 artifactRef 相等", v5);
	await test("V8 解密失败隔离：错 key → decrypt-failed 行 + mid_size 断言 + 游标照常提交", v8);
	await test("V12 302 越域拒：host-not-allowed hops=1、越域 0 落盘（同域重定向对照 + 超跳 too-many-hops）", v12);
	await test("V15 批预算：超预算剩余附件 batch-budget fail-visible、游标提交、下批正常", v15);
	await test("V7 坏 JSON 恢复：坏 config → gate false；坏 inbox 记录跳过且注入不抛；坏 quarantine 行跳过", v7);
	await test("V13 游标顺序：附件文件 + inbox(artifactRef) + 失败行全部先于 commitBatch 落盘", v13);
	await test("V14 幂等/崩溃重放：commit 前抛 → 同批重放 → 文件 1、失败行 1、inbox 1、零重下载", v14);
	await test("V9 路径引用注入：〔附件：<绝对路径> (<mime>, <bytes>B)〕，无 base64/URL/key；纯图 text:\"\"", v9);
	await test("V17 投影：/v1/wechat/inbox 含相对 artifactRef，无绝对盘符/URL/key", v17);
	await test("V10 秘密哨兵 0 命中：token/aes_key/CDN URL × 文件树+stdout/stderr+state/审计+端点响应", v10);
	await test("V11 opt-in OFF 零行为：零 CDN 请求/零目录/parseBatch 等价/注入正文精确等于旧格式", v11);
} catch (e) {
	console.error(`主流程异常: ${e instanceof Error ? e.stack : String(e)}`);
	process.exitCode = 1;
}

// 收尾：无论成败，停掉全部在跑 worker（泄漏的 ref'd 轮询定时器会让进程不退出）
for (const w of runningWorkers) {
	try {
		await w.stop();
	} catch {
		/* ignore */
	}
}

if (failures.length > 0) {
	console.error(`\n${failures.length} 项失败: ${failures.join(" | ")}`);
	process.exitCode = 1;
} else {
	console.log(`\n全部通过（${passed} 组断言块，${Date.now() - t0}ms）`);
}
