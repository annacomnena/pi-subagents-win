/**
 * hotspot — 热点路由缓存模块入口
 *
 * 设计文档：plans/20260915_plan_hotspot_memory_layer.md（v2，已批准首版实施）
 * 结构约束（v2 §11）：主 extensions/index.ts 只 import 本入口并调用 registerHotspot(pi)。
 *
 * 首版范围：首轮 <system-reminder> 注入、hotspot 工具（read/upsert/remove）、
 * 引用验证+预算+乐观锁+跨进程锁、/hotspot 诊断、热度排序与效果记录。
 * 0922 组合：+ 使用度量（④ held-out）、③ 拒收回显（tool.ts）、② 手写边（rel）、
 * ① 动态投影（graph.ts）、P0 自动探测（detect.ts）。
 * 不含：curator、知识晋升、自动删除、daemon、向子代理复制热点块。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerHotspotCommand } from "./command.ts";
import { registerHotspotDetection } from "./detect.ts";
import { registerInject } from "./inject.ts";
import { registerHotspotTool } from "./tool.ts";
import { registerUsage } from "./usage.ts";

export function registerHotspot(pi: ExtensionAPI): void {
	// 子 agent 进程（PI_SUBAGENT=1）：注入/工具/命令内部自 gate 早退——
	// 不注入（任务 prompt 由主会话组装时自行携带路由）、不暴露写入工具、无诊断命令。
	// 0922 组合：+ 使用度量（④ held-out 门控，子 agent 的外部工具调用也算真实使用）
	// + P0 自动探测（③，主会话行为；detect 内部自 gate 子 agent）。
	registerInject(pi);
	registerHotspotTool(pi);
	registerHotspotCommand(pi);
	registerUsage(pi);
	registerHotspotDetection(pi);
}
