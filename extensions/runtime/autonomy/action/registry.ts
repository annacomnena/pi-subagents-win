/**
 * runtime/autonomy/action/registry.ts — 动作类注册表（name → ActionClass）。
 *
 * P1 = diagnostic-report；阶段二 +notify-local-master（两 class 并存）。run.ts 编排层
 * 按 class 名取用事务原语（targetPath/withinSurface/snapshot/effect/postverify/rollback）。
 * 未注册 = null → fail-closed（L1 白名单已拦，此为防御性二次校验）。
 *
 * **惰性构建**（破除 ESM 循环 import）：notify.ts → scope.ts → wake.ts → run.ts → registry.ts
 * 构成环。若在本模块顶层立即访问 `notifyLocalMasterClass`（TDZ）会抛 ReferenceError。
 * 故注册表在**首次调用时**构建（此时所有模块已完成初始化）；顶层不触碰具体类绑定。
 */
import { diagnosticReportClass } from "./classes/report.ts";
import { notifyLocalMasterClass } from "./classes/notify.ts";
import type { ActionClass } from "./classes/types.ts";

let _registry: Readonly<Record<string, ActionClass>> | null = null;

/** 注册表（惰性构建；首次访问时所有 import 已完成初始化，安全）。 */
export function getActionClassRegistry(): Readonly<Record<string, ActionClass>> {
	if (!_registry) {
		_registry = {
			[diagnosticReportClass.name]: diagnosticReportClass,
			[notifyLocalMasterClass.name]: notifyLocalMasterClass,
		};
	}
	return _registry;
}

/** 按 name 取动作类（未注册 = null → fail-closed）。 */
export function getClass(name: string): ActionClass | null {
	return getActionClassRegistry()[name] ?? null;
}
