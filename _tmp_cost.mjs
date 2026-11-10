import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const RUNS = "C:/Users/Annacomnena/.pi/agent/trace-fusion-runs";
const dirs = readdirSync(RUNS).filter(d => d.startsWith("tfl-")).sort();
const laneDurs = []; const e2e = [];
for (const d of dirs) {
  const metaPath = join(RUNS, d, "meta.json");
  if (!existsSync(metaPath)) continue;
  let m; try { m = JSON.parse(readFileSync(metaPath, "utf8")); } catch { continue; }
  const t0 = m.createdAt ? Date.parse(m.createdAt) : NaN;
  // lane 完成时刻取 lanes/{A,B,C}/meta.json 或 lane .at 字段
  const lanes = [];
  for (const L of ["A","B","C"]) {
    const p = join(RUNS, d, "lanes", L, "meta.json");
    if (!existsSync(p)) continue;
    try { const lm = JSON.parse(readFileSync(p,"utf8"));
      const at = lm.finishedAt || lm.meta?.finishedAt || lm.at;
      if (at) lanes.push(Date.parse(at));
    } catch {}
  }
  if (!Number.isNaN(t0) && lanes.length) {
    const last = Math.max(...lanes);
    if (last > t0) laneDurs.push((last - t0) / 60000);
  }
  const fat = m.fusion?.at;
  if (!Number.isNaN(t0) && fat) { const e = Date.parse(fat); if (e > t0) e2e.push((e - t0)/60000); }
}
const st = a => { if(!a.length) return "n=0"; const s=[...a].sort((x,y)=>x-y);
  return `n=${a.length} min ${s[0].toFixed(1)} median ${s[Math.floor(s.length/2)].toFixed(1)} mean ${(a.reduce((x,y)=>x+y,0)/a.length).toFixed(1)} max ${s[s.length-1].toFixed(1)}`; };
console.log("lane 阶段全部完成:  " + st(laneDurs));
console.log("端到端到 fusion.at:  " + st(e2e));
