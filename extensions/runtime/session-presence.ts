/**
 * `runtime/session-presence.ts` — **会话占用只读观测**（step-0 第 1 步，2026-11-23）
 *
 * ## 为什么先做只读
 *
 * step-0 实测（`plans/20261123_pi_attach_step0_verification.md`）确认：
 * 两个 pi 进程用同一个 `--session <file>` 时，**Pi 不拦、零警告、双写成功**，
 * 而危险形状不是「文件损坏」而是**父链分叉 ⇒ 语义分裂**（一支在上下文里看不见）。
 *
 * 但**不知道真实发生率**。在加告警/409 之前先量化：我们这套用法里到底多久出现一次
 * 「同一会话被多个进程连着」。不做这一步就直接上告警面，会被 tab 场景刷屏
 * （tab 是可见独立 pi 进程，与用户手开 TUI 在 `isTTY` 上**无法区分**，见 step-0 §6-2）。
 *
 * ⇒ 本模块**只读、不写盘、不加锁、不阻断**。它回答一个问题：
 *    **「这个会话现在被几个进程连着」**
 *
 * ## 顺带修掉一个既有覆盖缺陷（这条是实测发现的）
 *
 * `runtime-host/server.ts::scanSessionCommandLines()` 返回 `Map<sessionId, pid>`
 * （单值）。一个会话被 2 个进程连着时，**后写覆盖先写** ⇒ 只记一个 pid ⇒
 * 该函数的所有消费方（`/v1/sessions` 的 liveness 索引、列表 activity 标签）
 * **在恰好多进程时给出错误的（但仍看起来合理的）单进程视图**。
 *
 * 这正是本模块要做多值的原因 —— 同时也是「为什么以前没人发现双控」的解释：
 * **观测能力本身就把多重占用抹平了。**
 *
 * ## 判据与它的边界（R-11：断言前先看分母）
 *
 * | 读数 | 证明 | **不**证明 |
 * |---|---|---|
 * | `processCount >= 2` | 有 N 个 pi 进程命令行含同一会话文件 | 不证明它们**同时**在写（可能一个已 idle） |
 * | `(pid, startTicks)` 唯一 | 是同一个进程实例（pid 复用被识破） | 不能证明它持有 TUI 键盘 |
 * | `multiWriter` | 至少 2 个**不同进程实例**连同一会话 | **不等于**已经发生双写 —— 双写要有 prompt |
 *
 * step-0 实验 E/E2 已验证 `CreationDate.Ticks` 逐位稳定、与 `Get-Process.StartTime`
 * 零偏差 ⇒ 用它做实例身份是可靠的（成本 1.4s/次，**必须缓存**，故本模块由调用方按需调用，
 * 不做周期轮询）。
 */

import { execFileSync } from "node:child_process";

/** 一个 pi 进程实例（实例身份 = pid + 启动时刻，防 pid 复用）。 */
export interface SessionProcessInstance {
	pid: number;
	/** Windows `Win32_Process.CreationDate.Ticks`（十进制字符串，逐位稳定；非 Windows ⇒ null） */
	startTicks: string | null;
}

/** 一个会话的占用观测。 */
export interface SessionPresence {
	sessionId: string;
	/** 该会话文件路径（命令行里读到的，可能为 null——`--session-id` 形态） */
	sessionFile: string | null;
	instances: SessionProcessInstance[];
	/** 按**实例身份**去重后的进程数（pid 复用不算两个） */
	processCount: number;
	/** `>= 2` ⇒ 多重占用（step-0 说的"双控风险"的形状） */
	multiWriter: boolean;
	/** 枚举是否成功；false ⇒ 下面数字全部无意义（R-11：不可读 ≠ 没有） */
	readable: boolean;
	/** 枚举方式（`win32-cim` / `ps` / `unavailable`） */
	via: "win32-cim" | "ps" | "unavailable";
}

/** 从命令行里抠 `--session <path>` 或 `<uuid>.jsonl` 会话文件路径。 */
export function sessionFileFromCommandLine(cmd: string): string | null {
	// 形态 1：`--session <path>`（tab/续接的标准形态）
	const flag = /--session\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i.exec(cmd);
	if (flag) {
		const p = flag[1] ?? flag[2] ?? flag[3];
		if (p && p.toLowerCase().endsWith(".jsonl")) return p;
	}
	// 形态 2：命令行里直接出现 `<...>.jsonl`（`--session-id` 由 pi 内部展开前的形态也可能带）
	const bare = /(?:^|\s)((?:\S+)\\(?:\S*)\.jsonl)(?:\s|$)/i.exec(cmd);
	if (bare) return bare[1];
	return null;
}

/** 从命令行里抠会话 UUID（文件名尾巴 `<uuid>.jsonl`）。 */
export function sessionIdFromCommandLine(cmd: string): string | null {
	const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.jsonl)?/i.exec(cmd);
	return m ? m[1] : null;
}

/**
 * 枚举当前所有 pi 进程的「会话占用」（**多值**，不覆盖）。
 *
 * never-throw：失败 ⇒ `readable:false` + 空列表（**不得**把"查不到"当成"没有被占用"）。
 *
 * 性能：一次 PowerShell CIM 枚举（实测 ~1.4s / 3 个进程的量级）。
 * **调用方必须自己决定频率**（列表页 5s 缓存已存在；本模块不内建缓存，
 * 因为「缓存多久」是消费方的策略，不是本模块的职责）。
 */
export function scanSessionPresence(): Map<string, SessionPresence> {
	const out = new Map<string, SessionPresence>();
	try {
		const script = process.platform === "win32"
			? `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ` +
				`Where-Object { $_.CommandLine -like '*pi-coding-agent*cli.js*' } | ` +
				`ForEach-Object { "" + $_.ProcessId + "|" + ${process.platform === "win32" ? "$_.CreationDate.Ticks" : "0"} + "|" + $_.CommandLine }`
			: "";
		if (process.platform !== "win32") {
			// 非 Windows：ps 没有 CreationDate ⇒ startTicks 恒 null，靠 pid 去重（诚实标注）
			const text = execFileSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8", timeout: 15_000 });
			collectPresenceRows(out, text, "ps", (line) => {
				const m = /^\s*(\d+)\s+(.*)$/.exec(line);
				return m ? { pid: Number.parseInt(m[1], 10), ticks: null, cmd: m[2] } : null;
			});
			return out;
		}
		const text = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
			encoding: "utf8", timeout: 20_000, windowsHide: true,
		});
		collectPresenceRows(out, text, "win32-cim", (line) => {
			const first = line.indexOf("|");
			const second = line.indexOf("|", first + 1);
			if (first <= 0 || second <= 0) return null;
			const pid = Number.parseInt(line.slice(0, first).trim(), 10);
			if (!Number.isInteger(pid) || pid <= 0) return null;
			const ticks = line.slice(first + 1, second).trim() || null;
			return { pid, ticks, cmd: line.slice(second + 1) };
		});
		return out;
	} catch {
		// 枚举失败：**空结果 + 标记不可读**（调用方据此不得声称"无占用"）
		return markUnreadable(out);
	}
}

function markUnreadable(m: Map<string, SessionPresence>): Map<string, SessionPresence> {
	// 用一个哨兵键让调用方能区分「空=真的没有」与「空=读不到」
	m.set("", { sessionId: "", sessionFile: null, instances: [], processCount: 0, multiWriter: false, readable: false, via: "unavailable" });
	return m;
}

/** 唯一聚合实现（导出供测试走**真实路径**，防「测自己的副本」假绿 —— R-4 教训）。 */
export function collectPresenceRows(
	out: Map<string, SessionPresence>,
	text: string,
	via: "win32-cim" | "ps",
	parse: (line: string) => { pid: number; ticks: string | null; cmd: string } | null,
): void {
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) continue;
		const row = parse(line);
		if (!row) continue;
		if (!row.cmd.includes("--session")) continue; // 只看明确带会话的进程
		const sid = sessionIdFromCommandLine(row.cmd);
		if (!sid) continue;
		const file = sessionFileFromCommandLine(row.cmd);
		const cur = out.get(sid);
		if (cur) {
			// **多值追加**（这正是既有单值 Map 的缺陷所在）
			cur.instances.push({ pid: row.pid, startTicks: row.ticks });
			cur.processCount = distinctInstanceCount(cur.instances);
			cur.multiWriter = cur.processCount >= 2;
			if (file && !cur.sessionFile) cur.sessionFile = file;
		} else {
			const instances: SessionProcessInstance[] = [{ pid: row.pid, startTicks: row.ticks }];
			out.set(sid, {
				sessionId: sid,
				sessionFile: file,
				instances,
				processCount: distinctInstanceCount(instances),
				multiWriter: distinctInstanceCount(instances) >= 2,
				readable: true,
				via,
			});
		}
	}
}

/** 按实例身份去重：同 pid 但不同 startTicks = **不同实例**（pid 复用被识破）。 */
export function distinctInstanceCount(instances: SessionProcessInstance[]): number {
	const keys = new Set<string>();
	for (const i of instances) keys.add(`${i.pid}@${i.startTicks ?? "-"}`);
	return keys.size;
}

/** 只取多重占用的会话（观测面用；空数组 = 当前无多重占用）。 */
export function listMultiWriterSessions(map: Map<string, SessionPresence>): SessionPresence[] {
	const out: SessionPresence[] = [];
	for (const [sid, p] of map) {
		if (sid === "") continue; // 哨兵
		if (!p.readable) continue;
		if (p.multiWriter) out.push(p);
	}
	return out;
}

/** 渲染成一行观测文案（纯函数；`/autonomy status` 与 GUI 共用同一文案口径）。 */
export function presenceLines(map: Map<string, SessionPresence>): string[] {
	const sentinel = map.get("");
	if (sentinel && !sentinel.readable) {
		return ["session-presence: (枚举不可读) —— 不可读 ≠ 无占用，不得据此判『没有双控』"];
	}
	const total = [...map.entries()].filter(([k]) => k !== "").length;
	const multi = listMultiWriterSessions(map);
	if (total === 0) return ["session-presence: 0 个会话被 pi 进程连着（枚举成功，确实为空）"];
	const lines = [
		`session-presence: ${total} 个会话被 pi 进程连着；多重占用 ${multi.length} 个${multi.length > 0 ? " ⚠️" : "（正常）"}`,
	];
	for (const m of multi.slice(0, 5)) {
		const who = m.instances.map((i) => `${i.pid}@${(i.startTicks ?? "?").slice(-6)}`).join(", ");
		lines.push(`  ⚠️ ${m.sessionId.slice(0, 13)} × ${m.processCount} 实例（${who}）⇒ 双写风险：Pi 不拦，父链会分叉`);
	}
	if (multi.length > 5) lines.push(`  …另有 ${multi.length - 5} 个多重占用会话未列出`);
	return lines;
}
