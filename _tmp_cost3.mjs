import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
const RUNS = "C:/Users/Annacomnena/.pi/agent/trace-fusion-runs";
const laneDurs = [], e2e = [], byRun = [];
for (const d of readdirSync(RUNS).filter(x => x.startsWith("tfl-")).sort()) {
  const mp = join(RUNS, d, "meta.json");
  if (!existsSync(mp)) continue;
  let m; try { m = JSON.parse(readFileSync(mp, "utf8")); } catch { continue; }
  const t0 = m.createdAt ? Date.parse(m.createdAt) : NaN;
  if (Number.isNaN(t0)) continue;
  let lastLane = NaN;
  for (const L of ["A","B","C"]) {
    const r = join(RUNS, d, "lanes", L, "result.json");
    if (!existsSync(r)) continue;
    let at = NaN;
    try { const j = JSON.parse(readFileSync(r,"utf8")); if (j.finishedAt) at = Date.parse(j.finishedAt); } catch {}
    if (Number.isNaN(at)) at = statSync(r).mtimeMs;
    if (!Number.isNaN(at) && (!lastLane || at > lastLane)) lastLane = at;
  }
  let laneMin = NaN;
  if (!Number.isNaN(lastLane) && lastLane > t0) { laneMin = (lastLane - t0)/60000; laneDurs.push(laneMin); }
  let e2eMin = NaN;
  const fat = m.fusion?.at;
  if (fat) { const e = Date.parse(fat); if (e > t0) { e2eMin = (e-t0)/60000; e2e.push(e2eMin); } }
  if (!Number.isNaN(laneMin)) byRun.push({d, laneMin, e2eMin});
}
const st = a => { if(!a.length) return "n=0"; const s=[...a].sort((x,y)=>x-y);
  return `n=${a.length} min ${s[0].toFixed(1)} median ${s[Math.floor(s.length/2)].toFixed(1)} mean ${(a.reduce((x,y)=>x+y,0)/a.length).toFixed(1)} max ${s[s.length-1].toFixed(1)}`; };
console.log("lane 阶段全部完成:  " + st(laneDurs));
console.log("端到端到 fusion.at:  " + st(e2e));
console.log("--- run 明细 ---");
for (const r of byRun) {
  const t = Number.isNaN(r.e2eMin) ? "" : "  差 " + (r.e2eMin - r.laneMin).toFixed(1);
  console.log("  " + r.d.padEnd(28) + " lane " + r.laneMin.toFixed(1).padStart(6) + (Number.isNaN(r.e2eMin)?"":"  e2e " + r.e2eMin.toFixed(1).padStart(6)) + t);
}
