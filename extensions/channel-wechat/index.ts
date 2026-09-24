/**
 * channel-wechat/index.ts — 微信 iLink 接收 worker 组装 + 子进程入口（W1：只收不投）
 *
 * 规格：plans/0924_wechat_receive_w1_spec.md §2。职责：
 *   - 组装：读凭据（<runtimeDir>/wechat/credentials.json，**只读不打印**）→ client + store +
 *     worker 循环；凭据缺失 → 返回 null（不 spawn 不轮询，fail-closed）。
 *   - 子进程入口（isMainModule，被 runtime-host/channel-supervisor.ts 以
 *     `node --experimental-strip-types index.ts` spawn，spawn 形状照抄 defaultSpawnDaemon）：
 *     · runtimeDir ← env PI_RUNTIME_DIR（supervisor 注入；绝不经 argv 传凭据）；
 *     · config 门（channels.wechat.enabled + channels.wechat.receive.enabled 均真才跑；
 *       路径 ← env PI_CHANNEL_WECHAT_CONFIG，缺省包根 config.json——supervisor 已 gate，此处
 *       双重 fail-closed）；
 *     · SIGINT/SIGTERM → 优雅 stop；父进程死亡看门狗（5s 节拍）→ 自行退出（daemon 崩溃时
 *       不留孤儿，不变量 §4.7 的第二层防线；第一层 = supervisor.stop + daemon close 钩子）；
 *     · auth_required 停 poll 后循环自然终结 → 进程退出（supervisor 读 state.json 不重启）。
 *
 * 安全（§4.1）：bot_token 只从凭据文件读入内存 → client Authorization header；不进 argv/env/
 * 日志/状态。红线：只 import node 内建 + 本目录模块 + runtime 纯函数 + runtime-host/wechat-bind
 * （凭据读写纯函数）。禁 Pi API / extensions/index.ts。
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { defaultRuntimeDir } from "../runtime/journal.ts";
import { defaultPkgConfigPath } from "../runtime/master-injection.ts";
import { readWechatCreds, readWechatEnabled, readWechatReceiveEnabled, wechatCredsPath, WECHAT_DEFAULT_BASE_URL, type WechatFetch } from "../runtime-host/wechat-bind.ts";
import { isProcessAlive } from "../runtime/liveness.ts";
import { WechatStore } from "./store.ts";
import { getUpdates, type GetUpdatesReq } from "./client.ts";
import { startWechatWorker, type WechatWorkerHandle } from "./worker.ts";

export interface CreateWechatWorkerOptions {
	runtimeDir: string;
	/** fetch 注入（缺省 global fetch；单测 fake）。 */
	fetch?: WechatFetch;
	now?: () => number;
	signal?: AbortSignal;
	/** base URL 覆盖（缺省取凭据 baseUrl；测试 stub）。 */
	baseUrl?: string;
	/** worker 调优项（透传；见 worker.WechatWorkerOptions）。 */
	timeoutMs?: number;
	pollGapMs?: number;
	backoffStartMs?: number;
	backoffMaxMs?: number;
	log?: (msg: string) => void;
}

export type CreateWechatWorkerResult =
	| { ok: true; handle: WechatWorkerHandle; store: WechatStore }
	| { ok: false; reason: "no-credentials" };

/**
 * 组装并启动 worker（凭据缺失 → {ok:false}，不轮询）。凭据只读；token 永不进任何输出。
 */
export function createWechatWorker(opts: CreateWechatWorkerOptions): CreateWechatWorkerResult {
	const creds = readWechatCreds(wechatCredsPath(opts.runtimeDir));
	if (creds === null) return { ok: false, reason: "no-credentials" };
	const store = new WechatStore(WechatStore.resolveDir(opts.runtimeDir), opts.now !== undefined ? { now: () => new Date(opts.now()) } : {});
	const handle = startWechatWorker({
		baseUrl: opts.baseUrl ?? creds.baseUrl ?? WECHAT_DEFAULT_BASE_URL,
		botToken: creds.botToken,
		store,
		...(opts.signal !== undefined ? { signal: opts.signal } : {}),
		...(opts.now !== undefined ? { now: opts.now } : {}),
		...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
		...(opts.pollGapMs !== undefined ? { pollGapMs: opts.pollGapMs } : {}),
		...(opts.backoffStartMs !== undefined ? { backoffStartMs: opts.backoffStartMs } : {}),
		...(opts.backoffMaxMs !== undefined ? { backoffMaxMs: opts.backoffMaxMs } : {}),
		...(opts.log !== undefined ? { log: opts.log } : {}),
		// fetch 注入：包装真 client（缺省 fetchUpdates = 真 client + global fetch）
		...(opts.fetch !== undefined ? { fetchUpdates: (req: GetUpdatesReq) => getUpdates(req, opts.fetch) } : {}),
	});
	return { ok: true, handle, store };
}

// ── 子进程入口（standalone：node --experimental-strip-types index.ts）──

function isMainModule(): boolean {
	try {
		const entry = process.argv[1] ? resolve(process.argv[1]) : "";
		return entry !== "" && entry === fileURLToPath(import.meta.url);
	} catch {
		return false;
	}
}

/** 父进程死亡看门狗节拍（daemon 崩溃兜底：孤儿 worker 自行退出，不变量 §4.7 第二层）。 */
const PARENT_WATCHDOG_MS = 5000;

if (isMainModule()) {
	const runtimeDir = process.env.PI_RUNTIME_DIR ? resolve(process.env.PI_RUNTIME_DIR) : defaultRuntimeDir();
	const configPath = process.env.PI_CHANNEL_WECHAT_CONFIG ? resolve(process.env.PI_CHANNEL_WECHAT_CONFIG) : defaultPkgConfigPath();
	// 双重 fail-closed 门（supervisor 已 gate；直接手跑也要求显式 opt-in）
	if (!readWechatEnabled(configPath) || !readWechatReceiveEnabled(configPath)) {
		console.error("wechat worker: 未启用（channels.wechat.enabled / channels.wechat.receive.enabled 需均为 true）");
		process.exit(0);
	}
	if (!existsSync(wechatCredsPath(runtimeDir))) {
		console.error("wechat worker: 凭据缺失（先完成扫码绑定）");
		process.exit(0);
	}
	const r = createWechatWorker({ runtimeDir });
	if (!r.ok) {
		console.error("wechat worker: 凭据不可读，退出");
		process.exit(0);
	}
	const handle = r.handle;
	let stopping = false;
	const shutdown = (): void => {
		if (stopping) return;
		stopping = true;
		void handle
			.stop()
			.catch(() => {})
			.finally(() => process.exit(0));
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	// 父进程看门狗：daemon 死亡（含硬杀）→ 有界内自行退出，不留孤儿 poller
	const watchdog = setInterval((): void => {
		try {
			if (!isProcessAlive(process.ppid)) shutdown();
		} catch {
			shutdown();
		}
	}, PARENT_WATCHDOG_MS);
	watchdog.unref?.();
}
