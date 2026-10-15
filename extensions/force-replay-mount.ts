/**
 * force-replay-mount — PI_FORCE_REASONING_REPLAY 开关 → 子 agent pi argv 的 -e 追加解析
 *
 * 背景：DeepSeek 类 provider 要求请求里带 reasoning_content 回传，否则 400。
 * pi-force-reasoning-replay 扩展（pi.on("context") 纯变换）解决此事，但 harness
 * 派的子 agent 是独立 pi 子进程（spawn("node",[piCliPath,"--mode","json",…])），
 * 不会自动加载项目级扩展 ⇒ 需在 argv 显式追加 `-e <扩展绝对路径>`。
 *
 * 契约（默认零差异）：
 *   - PI_FORCE_REASONING_REPLAY 未设/非真值 ⇒ 完全不追加（args 与历史逐字一致）
 *   - 真值语义与扩展本体一致："1"|"true"|"yes"|"on"（大小写/首尾空白不敏感）
 *   - 路径：PI_FORCE_REASONING_REPLAY_EXT 可覆盖；默认 pi-force-reasoning-replay 包目录
 *   - 路径不存在 ⇒ 不追加 + 返回可见警告（fail-open 但不得静默）
 *
 * 纯解析、无副作用（existsSync 只读）；env 由调用方传入以便单测改道。
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const FORCE_REPLAY_SWITCH_ENV = "PI_FORCE_REASONING_REPLAY";
export const FORCE_REPLAY_EXT_PATH_ENV = "PI_FORCE_REASONING_REPLAY_EXT";

/** 默认扩展包目录（pi -e 接受文件或目录；该包根含 index.ts）。 */
export const DEFAULT_FORCE_REPLAY_EXT_PATH =
	"C:/Users/Annacomnena/pi-packages/pi-force-reasoning-replay";

export interface ForceReplayMount {
	/** 存在时由调用方 push 进 pi argv：`argv.push("-e", extensionArg)`。开关未开/路径缺失 → undefined。 */
	extensionArg?: string;
	/** 开关已开但扩展路径不存在时的可见警告文本（fail-open）。 */
	warning?: string;
}

/** 与扩展本体（pi-force-reasoning-replay/src/transform.ts）一致的真值语义。 */
export function isForceReplayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env[FORCE_REPLAY_SWITCH_ENV] ?? "").trim().toLowerCase();
	return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * 解析子 agent pi 子进程的 -e 挂载：仅当开关打开且扩展路径存在时产出 extensionArg。
 * 不做任何写入/spawn；警告文案含实际检查的绝对路径，供 Logger 级输出。
 */
export function resolveForceReplayMount(env: NodeJS.ProcessEnv = process.env): ForceReplayMount {
	if (!isForceReplayEnabled(env)) return {};
	const rawPath = env[FORCE_REPLAY_EXT_PATH_ENV]?.trim() || DEFAULT_FORCE_REPLAY_EXT_PATH;
	const extPath = resolve(rawPath);
	if (!existsSync(extPath)) {
		return {
			warning:
				`[subagent-win] ${FORCE_REPLAY_SWITCH_ENV}=on but extension path not found: ${extPath} ` +
				`(override via ${FORCE_REPLAY_EXT_PATH_ENV}); NOT appending -e — DeepSeek-style subagents may 400`,
		};
	}
	return { extensionArg: extPath };
}
