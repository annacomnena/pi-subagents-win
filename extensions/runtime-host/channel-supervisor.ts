/**
 * runtime-host/channel-supervisor.ts — 微信接收 worker 子进程监督（W1，daemon 内）
 *
 * 规格：plans/0924_wechat_receive_w1_spec.md §2/§4。职责（D14：长驻长轮询走受监督 worker）：
 *   - 按配置 spawn/停止 worker 子进程：`channels.wechat.enabled` **且** `channels.wechat.receive.enabled`
 *     （缺省 false，D7 零行为变化）**且** 凭据存在 → spawn；任一不满足 → 收掉。
 *   - spawn 形状照抄 daemon-lifecycle.defaultSpawnDaemon（stdio:'ignore'、windowsHide:false、
 *     cwd=dirname(workerPath)、env:{...process.env, PI_RUNTIME_DIR}），但**不 detached、不 unref**：
 *     daemon 必须能收掉 worker（不变量 §4.7 第一层 = stop()/close 钩子 + 进程 exit 兜底 kill；
 *     第二层 = worker 自身父进程死亡看门狗，channel-wechat/index.ts）。
 *   - 意外退出 → 退避重启（5s 起指数，上限 5min；稳定运行 ≥stableMs 清零退避）；
 *     **auth_required 保持不重启**（state.json 持久终态；用户重新扫码绑定（creds.boundAt 更新）
 *     后自动恢复——boundAt 晚于 authRequiredAt 即放行）。
 *   - 残留 pid 文件识别与清理（不变量 §4.7）：上一代 worker 若还活着（daemon 崩溃遗留），
 *     等其看门狗自退（有界）；超时仍活 → fail-closed 不 spawn 不 kill（防 pid 复用误杀），如实上报。
 *   - 心跳/fence 字段留扩展位（daemonEpoch/workerAttempt 只记录不强制，规格 §2）。
 *
 * 安全（§4.1）：argv/env 不带任何凭据（worker 自己从凭据文件读 token；env 只传 PI_RUNTIME_DIR
 * 与 config 路径）。kill/退出处理 never-throw（监督面不炸 daemon）。
 *
 * 红线：只 import node 内建 + ./discovery（isProcessAlive）+ ./wechat-bind（配置/凭据纯读）+
 * ../channel-wechat/store（state.json 持久告警读）。禁 Pi API / extensions/index.ts。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isProcessAlive } from "./discovery.ts";
import { readWechatCreds, readWechatEnabled, readWechatReceiveEnabled, wechatCredsPath } from "./wechat-bind.ts";
import { WechatStore } from "../channel-wechat/store.ts";
import { traceSpawn } from "../spawn-trace.ts";

export interface WorkerSpawnHandle {
	pid?: number;
	kill: () => void;
}

export interface ChannelSupervisorOptions {
	/** worker 的 PI_RUNTIME_DIR（= store/凭据根）。 */
	runtimeDir: string;
	/** config 路径（读 channels.wechat.{enabled,receive.enabled}；亦经 env 透传给 worker 双重门）。 */
	configPath: string;
	/** worker 入口（缺省 ../channel-wechat/index.ts；测试注入）。 */
	workerPath?: string;
	/** spawn 注入（缺省照抄 defaultSpawnDaemon 形状；单测 fake）。 */
	spawnWorker?: (o: { workerPath: string; runtimeDir: string; configPath: string }) => WorkerSpawnHandle;
	now?: () => number;
	log?: (msg: string) => void;
	/** 意外退出重启退避（缺省 5s 起 / 5min 顶）。 */
	restartBackoffStartMs?: number;
	restartBackoffMaxMs?: number;
	/** 稳定运行多久后退避清零（缺省 60s）。 */
	stableMs?: number;
	/** 残留 pid 等待窗口（缺省 6s ≥ worker 看门狗 5s）。 */
	staleWaitMs?: number;
	/** killChild 等待退出窗口（缺省 3s；测试注入小值）。超时仍活 → 保留 pid 标记 fail-closed（MF3）。 */
	killWaitMs?: number;
	/** 周期对账节拍（缺省 30s；start() 后启用，unref 定时器，ws.ts:615 先例）。 */
	reconcileMs?: number;
}

export interface ChannelSupervisorStatus {
	running: boolean;
	pid: number | null;
	workerAttempt: number;
	daemonEpoch: string;
	/** 最近一次 sync/重启动作（脱敏；无 token）。 */
	lastAction: string | null;
	lastActionAt: string | null;
}

export type SyncResult = {
	action: "spawned" | "stopped" | "none" | "already" | "skipped-stale" | "auth-required-hold";
	running: boolean;
	note?: string;
};

function defaultWorkerPath(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "channel-wechat", "index.ts");
}

function defaultSpawnWorker(o: { workerPath: string; runtimeDir: string; configPath: string }): WorkerSpawnHandle {
	// 形状照抄 daemon-lifecycle.defaultSpawnDaemon（stdio ignore / windowsHide:false / cwd / env 覆写），
	// 差异仅两处（规格 §2）：不 detached（daemon 活着时 worker 随叫随收）、不 unref（持有 ChildProcess
	// 句柄监听 exit 做退避重启）。env 只加 PI_RUNTIME_DIR + config 路径——**绝无凭据**。
	traceSpawn("console-child", `channel-wechat worker spawn exec=${process.execPath} worker=${o.workerPath}`);
	const child: ChildProcess = spawn(process.execPath, ["--experimental-strip-types", o.workerPath], {
		stdio: "ignore",
		windowsHide: false,
		cwd: dirname(o.workerPath),
		env: { ...process.env, PI_RUNTIME_DIR: o.runtimeDir, PI_CHANNEL_WECHAT_CONFIG: o.configPath },
	});
	return {
		...(typeof child.pid === "number" ? { pid: child.pid } : {}),
		kill: () => {
			try {
				child.kill();
			} catch {
				/* ignore */
			}
		},
	};
}

/**
 * 微信接收 worker 监督器（daemon 内单例；never-throw 面）。
 * 生命周期：start()（初始 sync + 周期对账）→ sync()（enable/disable/unbind 等事件触发）→
 * dispose()（daemon close：收 worker + 清定时器；worker.json pid 文件按 daemonEpoch 条件删）。
 */
export class ChannelSupervisor {
	private readonly opts: Required<Pick<ChannelSupervisorOptions, "runtimeDir" | "configPath">> & ChannelSupervisorOptions;
	private readonly storeDir: string;
	private readonly daemonEpoch: string;
	private child: { handle: WorkerSpawnHandle; exited: boolean; startedAt: number; attempt: number } | null = null;
	private restartTimer: NodeJS.Timeout | null = null;
	private reconcileTimer: NodeJS.Timeout | null = null;
	private restartAttempt = 0;
	private lastAction: string | null = null;
	private lastActionAt: string | null = null;
	private syncing: Promise<SyncResult> | null = null;
	private disposed = false;
	private readonly exitHook: () => void;

	constructor(opts: ChannelSupervisorOptions) {
		this.opts = opts;
		this.storeDir = WechatStore.resolveDir(opts.runtimeDir);
		this.daemonEpoch = `de_${process.pid.toString(36)}_${(opts.now ?? Date.now)().toString(36)}`;
		this.exitHook = () => {
			// 进程 exit 兜底：同步 kill（exit handler 内只能同步动作；worker 另有父死亡看门狗）
			if (this.child !== null && !this.child.exited) this.child.handle.kill();
		};
		try {
			process.on("exit", this.exitHook);
		} catch {
			/* ignore */
		}
	}

	/** 是否应运行（配置 + 凭据；never-throw）。 */
	shouldRun(): boolean {
		try {
			return (
				readWechatEnabled(this.opts.configPath) &&
				readWechatReceiveEnabled(this.opts.configPath) &&
				readWechatCreds(wechatCredsPath(this.opts.runtimeDir)) !== null
			);
		} catch {
			return false;
		}
	}

	/** auth_required 保持：仅当告警时刻**晚于**最近绑定时刻才持续 hold（重绑后自动恢复）。 */
	private authHold(): boolean {
		try {
			const s = new WechatStore(this.storeDir).readState();
			if (s.status !== "auth_required" || s.authRequiredAt === null) return false;
			const creds = readWechatCreds(wechatCredsPath(this.opts.runtimeDir));
			if (creds === null) return false; // 无凭据 → shouldRun 已 false，无所谓 hold
			return creds.boundAt <= s.authRequiredAt;
		} catch {
			return false;
		}
	}

	private pidFilePath(): string {
		return join(this.storeDir, "worker.json");
	}

		private writePidFile(attempt: number, pid: number | undefined): void {
		if (pid === undefined) return; // 注入 spawn 无 pid → 不落文件（单测面）
		try {
			const path = this.pidFilePath();
			mkdirSync(this.storeDir, { recursive: true });
			const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
			const fd = openSync(tmp, "wx", 0o600);
			try {
				writeFileSync(fd, `${JSON.stringify({ kind: "wechat-worker", pid, daemonEpoch: this.daemonEpoch, workerAttempt: attempt, startedAt: new Date().toISOString(), runtimeDir: this.opts.runtimeDir }, null, 2)}\n`, "utf8");
			} finally {
				try {
					closeSync(fd);
				} catch {
					/* ignore */
				}
			}
			try {
				chmodSync(tmp, 0o600);
			} catch {
				/* Windows 尽力 */
			}
			renameSync(tmp, path);
			try {
				chmodSync(path, 0o600);
			} catch {
				/* Windows 尽力 */
			}
		} catch {
			/* pid 文件 best-effort（监督真相在内存 child 句柄） */
		}
	}

private removePidFile(): void {
		try {
			const path = this.pidFilePath();
			if (!existsSync(path)) return;
			const raw = JSON.parse(readFileSync(path, "utf8")) as { daemonEpoch?: unknown };
			// 条件删：daemonEpoch 仍是本监督器才删（防误删并发他代文件）
			if (raw?.daemonEpoch === this.daemonEpoch || raw?.daemonEpoch === undefined) rmSync(path, { force: true });
		} catch {
			/* ignore */
		}
	}

	private record(action: string): void {
		this.lastAction = action;
		this.lastActionAt = new Date().toISOString();
		(this.opts.log ?? (() => {}))(`[channel-supervisor] ${action}`);
	}

	private childAlive(): boolean {
		return this.child !== null && !this.child.exited && this.child.handle.pid !== undefined && isProcessAlive(this.child.handle.pid);
	}

	/**
	 * 对账（幂等、串行化）：应运行且未运行 → spawn；不应运行 → 收掉；auth hold → 不重启。
	 * never-throw（返回结果，异常归一 note）。
	 */
	sync(): Promise<SyncResult> {
		if (this.syncing !== null) return this.syncing;
		this.syncing = this.doSync()
			.catch((e: unknown): SyncResult => {
				this.record(`sync-error: ${e instanceof Error ? e.message : String(e)}`);
				return { action: "none", running: this.childAlive(), note: "sync 异常（已归一，不炸 daemon）" };
			})
			.finally(() => {
				this.syncing = null;
			});
		return this.syncing;
	}

	private async doSync(): Promise<SyncResult> {
		if (!this.shouldRun()) {
			if (this.child !== null) {
				await this.killChild("config/credentials 不再满足（sync 停止 worker）");
				return { action: "stopped", running: false };
			}
			return { action: "none", running: false };
		}
		if (this.childAlive()) return { action: "already", running: true };
		if (this.authHold()) {
			this.record("auth-required-hold（bot_token 失效，等重新扫码绑定；不重启防风暴）");
			return { action: "auth-required-hold", running: false, note: "auth_required 持久告警中：重新扫码绑定后自动恢复" };
		}
		// 残留 pid 文件（上一代 worker）：等其父死亡看门狗自退；仍活 → fail-closed 不 spawn
		const stale = await this.waitStaleWorkerGone();
		if (stale !== null) {
			this.record(`skipped-stale: 残留 worker pid=${stale} 仍存活（防双跑/误杀），跳过 spawn`);
			return { action: "skipped-stale", running: false, note: `残留 worker pid=${stale} 未自退（有界等待后放弃 spawn）` };
		}
		this.spawnWorker("sync spawn（配置+凭据就绪）");
		return { action: "spawned", running: this.childAlive() };
	}

	private async waitStaleWorkerGone(): Promise<number | null> {
		let path: string;
		try {
			path = this.pidFilePath();
			if (!existsSync(path)) return null;
		} catch {
			return null;
		}
		let pid: number | null = null;
		try {
			const raw = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
			if (typeof raw.pid === "number" && raw.pid > 0) pid = raw.pid;
		} catch {
			pid = null;
		}
		if (pid === null || !isProcessAlive(pid)) {
			this.removePidFile();
			return null;
		}
		const waitMs = this.opts.staleWaitMs ?? 6000;
		const t0 = Date.now();
		for (;;) {
			await new Promise((r) => setTimeout(r, 200));
			if (!isProcessAlive(pid)) {
				this.removePidFile();
				return null;
			}
			if (Date.now() - t0 > waitMs) return pid;
		}
	}

	private spawnWorker(why: string): void {
		if (this.disposed || this.childAlive()) return;
		this.restartAttempt += 1;
		const workerPath = this.opts.workerPath ?? defaultWorkerPath();
		const handle = (this.opts.spawnWorker ?? defaultSpawnWorker)({ workerPath, runtimeDir: this.opts.runtimeDir, configPath: this.opts.configPath });
		this.child = { handle, exited: false, startedAt: Date.now(), attempt: this.restartAttempt };
		this.writePidFile(this.restartAttempt, handle.pid);
		this.record(`spawned worker（${why}；attempt=${this.restartAttempt}${handle.pid !== undefined ? ` pid=${handle.pid}` : ""}）`);
		this.watchChild();
	}

	private watchChild(): void {
		const c = this.child;
		if (c === null) return;
		const pid = c.handle.pid;
		// 轮询探活（注入 spawn 无真实子进程事件面；也覆盖 kill 后 exit 事件丢失的边角）
		const timer = setInterval((): void => {
			if (this.child !== c) {
				clearInterval(timer);
				return;
			}
			if (pid !== undefined && !isProcessAlive(pid)) this.onChildExit(c);
		}, 500);
		timer.unref?.();
		// 记录 watcher 以便 dispose 清理
		this.childWatchers.set(c, timer);
	}
	private childWatchers = new Map<object, NodeJS.Timeout>();

	private onChildExit(c: { handle: WorkerSpawnHandle; exited: boolean; startedAt: number; attempt: number }): void {
		if (this.child !== c || c.exited) return;
		c.exited = true;
		const watcher = this.childWatchers.get(c);
		if (watcher !== undefined) {
			clearInterval(watcher);
			this.childWatchers.delete(c);
		}
		this.removePidFile();
		this.child = null;
		if (this.disposed) return;
		// 稳定运行 → 退避清零
		const stableMs = this.opts.stableMs ?? 60_000;
		if (Date.now() - c.startedAt >= stableMs) this.restartAttempt = 0;
		if (!this.shouldRun()) {
			this.record("worker 退出（配置/凭据已不满足，不重启）");
			return;
		}
		if (this.authHold()) {
			this.record("worker 退出于 auth_required（不重启防风暴）");
			return;
		}
		const startMs = this.opts.restartBackoffStartMs ?? 5000;
		const maxMs = this.opts.restartBackoffMaxMs ?? 300_000;
		const delay = Math.min(startMs * Math.pow(2, Math.max(0, this.restartAttempt)), maxMs);
		this.record(`worker 意外退出（attempt=${c.attempt}）：${delay}ms 后退避重启`);
		this.restartTimer = setTimeout((): void => {
			this.restartTimer = null;
			if (this.disposed || this.childAlive()) return;
			if (this.authHold()) return;
			this.spawnWorker("意外退出退避重启");
			void this.sync();
		}, delay);
		this.restartTimer.unref?.();
	}

	/**
	 * 收掉 worker（有界等待退出；幂等；never-throw）。MF3（0924 L4 复核）：仅在**确认 pid 已消失**
	 * （或注入 spawn 无 pid）后才走 onChildExit 清 pid 文件；超时仍存活 → **保留 pid 标记**并记录
	 * 原因（供下次启动 waitStaleWorkerGone fail-closed 识别），不把仍活进程当退出、不清识别凭据。
	 */
	async killChild(why: string): Promise<void> {
		const c = this.child;
		if (c === null) return;
		c.handle.kill();
		const pid = c.handle.pid;
		const waitMs = this.opts.killWaitMs ?? 3000;
		const t0 = Date.now();
		while (pid !== undefined && isProcessAlive(pid) && Date.now() - t0 < waitMs) {
			await new Promise((r) => setTimeout(r, 100));
		}
		if (pid !== undefined && isProcessAlive(pid)) {
			// 超时仍存活：不当退出处理。停 watcher（防后续误触发 onChildExit 清 pid 文件）；
			// child 引用保留（childAlive=true 如实反映）；pid 文件保留给下次启动识别。
			const watcher = this.childWatchers.get(c);
			if (watcher !== undefined) {
				clearInterval(watcher);
				this.childWatchers.delete(c);
			}
			this.record(`kill 超时 worker pid=${pid} 仍存活：保留 pid 文件待下次启动 fail-closed 识别（${why}）`);
			return;
		}
		this.onChildExit(c);
		if (c === this.child) this.child = null;
		this.record(`stopped worker（${why}）`);
	}

	/** daemon 侧最终收尾：收 worker + 清重启/对账定时器 + 卸 exit 钩子。 */
	async dispose(): Promise<void> {
		this.disposed = true;
		if (this.restartTimer !== null) {
			clearTimeout(this.restartTimer);
			this.restartTimer = null;
		}
		if (this.reconcileTimer !== null) {
			clearInterval(this.reconcileTimer);
			this.reconcileTimer = null;
		}
		for (const t of this.childWatchers.values()) clearInterval(t);
		this.childWatchers.clear();
		try {
			process.removeListener("exit", this.exitHook);
		} catch {
			/* ignore */
		}
		if (this.child !== null) await this.killChild("daemon close（dispose）");
	}

	/** 周期对账启动（初始 sync + reconcileMs 节拍；unref 定时器不挂住 daemon 事件循环）。 */
	start(): void {
		if (this.disposed) return;
		void this.sync();
		if (this.reconcileTimer !== null) return;
		const ms = this.opts.reconcileMs ?? 30_000;
		this.reconcileTimer = setInterval((): void => {
			void this.sync();
		}, ms);
		this.reconcileTimer.unref?.();
	}

	status(): ChannelSupervisorStatus {
		return {
			running: this.childAlive(),
			pid: this.child?.handle.pid ?? null,
			workerAttempt: this.restartAttempt,
			daemonEpoch: this.daemonEpoch,
			lastAction: this.lastAction,
			lastActionAt: this.lastActionAt,
		};
	}
}
