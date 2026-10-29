import { readAuditTail } from "./runtime/autonomy/collect.ts";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { autonomyDir } from "./runtime/autonomy/collect.ts";

for (const n of [80000, 200000, 400000]) {
  const stateDir = join(tmpdir(), `probe_${n}_${Date.now()}`);
  const dir = autonomyDir(stateDir); mkdirSync(dir,{recursive:true});
  const active = join(dir,"audit.jsonl");
  const lines = Array.from({length:n},(_,i)=>`p-${i}-`+"z".repeat(80));
  writeFileSync(active, lines.join("\n")+"\n","utf8");
  const size = statSync(active).size;

  // 预热一次（避免首次 require/IO 冷启动污染）
  readAuditTail({stateDir,limit:5});
  readFileSync(active,"utf8").split("\n").filter(Boolean).slice(-5);

  const its = 5;
  let t0=process.hrtime.bigint();
  for(let i=0;i<its;i++) readAuditTail({stateDir,limit:5});
  const fast=Number(process.hrtime.bigint()-t0)/1e6/its;

  t0=process.hrtime.bigint();
  for(let i=0;i<its;i++) readFileSync(active,"utf8").split("\n").filter(Boolean).slice(-5);
  const slow=Number(process.hrtime.bigint()-t0)/1e6/its;

  console.log(`${(size/1048576).toFixed(1)}MB  fast=${fast.toFixed(2)}ms  slow=${slow.toFixed(2)}ms  提速 ${(slow/fast).toFixed(1)}x`);
  rmSync(stateDir,{recursive:true,force:true});
}
