import cp from "node:child_process";

const session = "C:\\Users\\Annacomnena\\.pi\\agent\\sessions\\--G--code-GreenCAD--\\2026-11-13T05-46-07-305Z_01a1d371-1a49-73df-8fe1-b5c774018815.jsonl";
const prompt = "C:\\Users\\Annacomnena\\.pi\\agent\\launch-prompts\\pi-resume-greencad-local-master.md";
const cwd = "G:\\code\\GreenCAD";
const execPath = "C:\\nvm4w\\nodejs\\node.exe";
const piCli = "C:\\nvm4w\\nodejs\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js";
const wt = "C:\\Users\\Annacomnena\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe";

const args = [
  "-w", "0",
  "new-tab",
  "--title", "GreenCAD-local-master",
  "--suppressApplicationTitle",
  "-d", cwd,
  execPath,
  piCli,
  "--session", session,
  "@" + prompt,
];

console.log("wt argv:", JSON.stringify(args, null, 1));
const child = cp.spawn(wt, args, { detached: true, stdio: "ignore", windowsHide: false });
child.unref();
console.log("spawned pid", child.pid);
