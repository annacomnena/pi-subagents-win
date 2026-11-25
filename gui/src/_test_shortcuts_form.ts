/**
 * _test_shortcuts_form.ts — 快捷按钮表单校验 + **接线**回归（L4 复审重要项）。
 *
 * gui 无 DOM 测试框架、strip-types 不转 JSX ⇒ 纯函数（shortcutsForm.ts）可直接测，
 * .tsx 只能做源码串断言。两层一起才防住「纯函数全绿但面板没接线」的自欺。
 *
 * 运行：npm run test:gui-shortcuts-form
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { proposalsDirOf, sessionCwdOf, validateShortcutDraft } from "./rightRail/shortcutsForm.ts";

let n = 0;
const ok = (msg: string): void => { n += 1; console.log(`ok ${n} - ${msg}`); };
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(join(here, rel), "utf8");
/** 去注释：避免注释里的关键字让接线断言假绿。 */
const codeOnly = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const base = { id: "build", label: "编译", kind: "script" as const, command: "build.ps1", confirm: true };
assert.equal(validateShortcutDraft(base), null);
assert.equal(validateShortcutDraft({ id: "ci", label: "CI", kind: "url", url: "https://ci.local/x", confirm: false }), null);
assert.equal(validateShortcutDraft({ id: "log", label: "日志", kind: "file", path: "logs/build.log", confirm: false }), null);
assert.equal(validateShortcutDraft({ id: "kill", label: "关服", kind: "process", matchCommandLine: "MyApp.Server.dll", confirm: true }), null);
ok("四类合法 action 全部通过");

assert.match(validateShortcutDraft({ ...base, id: "Bad ID" }) ?? "", /id/);
assert.match(validateShortcutDraft({ ...base, label: "" }) ?? "", /名称/);
assert.match(validateShortcutDraft({ id: "u", label: "U", kind: "url", url: "file:///etc/passwd", confirm: false }) ?? "", /http/);
assert.match(validateShortcutDraft({ id: "f", label: "F", kind: "file", path: "../../secret", confirm: false }) ?? "", /\.\./);
assert.match(validateShortcutDraft({ id: "f", label: "F", kind: "file", path: "C:/secret", confirm: false }) ?? "", /相对路径/);
assert.match(validateShortcutDraft({ ...base, command: "../evil.ps1" }) ?? "", /\.ps1/);
assert.match(validateShortcutDraft({ ...base, args: ["a;calc"] }) ?? "", /元字符/);
assert.match(validateShortcutDraft({ id: "p", label: "P", kind: "process", matchCommandLine: "abcd*", confirm: true }) ?? "", /通配符/);
assert.match(validateShortcutDraft({ ...base, timeoutMs: 1 }) ?? "", /超时/);
assert.match(validateShortcutDraft({ ...base, confirm: false }) ?? "", /二次确认/);
assert.match(validateShortcutDraft({ id: "p", label: "P", kind: "process", matchCommandLine: "valid.dll", confirm: true, timeoutMs: 1 }) ?? "", /超时/);
ok("非法字段逐项被前端拦住（id/label/url/path/command/args/process/timeout/confirm）");

// ── 接线断言：变异下列任一行都必须让测试红 ──
const panel = codeOnly(read("rightRail/ShortcutsPanel.tsx"));
assert.match(panel, /validateShortcutDraft\(draft\)/, "表单必须调用校验函数");
assert.match(panel, /setFormError\(invalid\)/, "校验失败必须就地显示");
assert.match(panel, /api\.shortcuts\.run\(\{ cwd: c, id: a\.id, timeoutMs:/, "run 必须显式传服务端 action 的 timeoutMs");
assert.match(panel, /api\.fileReveal\(a\.path, c\)/, "file 必须有「定位」入口");
assert.match(panel, /currentCwd\(\) !== c/, "响应仍须做 cwd 快照比对（仓库或会话 cwd）");
assert.match(panel, /runState\.status === "running" \? \(runState\.detail \?\? "执行中…"\)/, "running 必须渲染 detail（长任务提示不能只写不显示）");
assert.match(panel, /disabled=\{runState\?\.status === "running"\}/, "运行中禁用其它动作，避免单例 runState 串台");
// 「让 agent 推荐」接线：变异任一行都必须红（只写文档不算实现）。
assert.match(panel, /让 agent 推荐/, "面板必须有推荐入口");
assert.match(panel, /api\.sessionMessage\(sid, text, undefined, newCommandKey\("shortcuts-recommend"\), true\)/, "推荐必须走 session.message 且独立 commandKey");
assert.match(panel, /proposalsDirOf\(configPath\)/, "注入内容必须含提案目录绝对路径");
assert.match(panel, /sourceSession 必须填/, "注入内容必须告诉 agent sourceSession 填本会话 id");
assert.match(panel, /baseHash 必须填这个值/, "注入内容必须告诉 agent baseHash 取当前 hash");
assert.match(panel, /现在只写提案文件，不要改主配置/, "注入必须明确提案阶段不得越过用户决策");
ok("面板接线：校验 / 超时 / 定位 / cwd 快照 / 长任务提示 / 并发禁用 / agent 推荐注入全部在位");
assert.equal(proposalsDirOf("C:\\Users\\x\\.pi\\agent\\gui-shortcuts\\abc.json"), "C:\\Users\\x\\.pi\\agent\\gui-shortcuts\\proposals");
assert.equal(proposalsDirOf("/home/x/.pi/agent/gui-shortcuts/abc.json"), "/home/x/.pi/agent/gui-shortcuts/proposals");
ok("提案目录推导：Windows 反斜杠与 POSIX 正斜杠都保留原分隔符");

assert.equal(sessionCwdOf([{ sessionId: "s1", cwd: "G:/repo" }], "s1"), "G:/repo");
assert.equal(sessionCwdOf([{ sessionId: "s1", cwd: null }], "s1"), null);
assert.equal(sessionCwdOf([{ sessionId: "s1", cwd: "G:/repo" }], "s2"), null);
assert.equal(sessionCwdOf(undefined, "s1"), null);
ok("聊天页 cwd 兜底：只认当前会话的非空 cwd");
assert.match(panel, /sessionCwdOf\(s\.chatSessions, s\.chatActiveId\)/, "面板必须用会话 cwd 兜底，否则聊天页看不到推荐按钮");
assert.match(panel, /const cwd = workspaceCwd \?\? sessionCwd/, "仓库主页优先、聊天会话兜底");

const client = codeOnly(read("api/client.ts"));
assert.match(client, /Math\.min\(\(input\.timeoutMs \?\? 120_000\) \+ 5_000, 605_000\)/, "run 超时必须覆盖默认 5s 且不超过服务端上限+余量");
ok("客户端 run 超时契约：不再用 5s 默认超时砍断编译脚本");

const rail = codeOnly(read("rightRail/RightRail.tsx"));
assert.match(rail, /overflow-x-auto/, "四面板切换条必须可横向滚动");
assert.match(rail, /className="shrink-0"/, "收起按钮必须固定可达");
ok("右栏切换条：窄宽下可滚动且收起键不被裁掉");

const agents = read("../../AGENTS.md");
assert.match(agents, /## 快捷按钮面板/, "AGENTS.md 必须有 agent 侧契约（本仓会话自动注入）");
assert.match(agents, /proposals\/<32位小写hex>\.json/, "必须写清提案落点");
assert.match(agents, /提案阶段只写提案文件，不改主配置/, "必须写清提案阶段不得越权");
ok("AGENTS.md：提案路径 / schema 指向 / 批准边界在位");

console.log(`\nALL ${n} ASSERTIONS PASSED`);
