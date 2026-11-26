#!/usr/bin/env bash
# Baseline / regression runner for all registered test:* scripts (bounded).
# Usage: bash scripts/_run_all_tests.sh <outfile>
set -u
OUT="${1:-/tmp/all-tests.log}"
cd "$(dirname "$0")/.."
# 2026-11-26（P0-1 结构根因修复）：不加这一行，任何带 `scripts/ensure-pi-test-deps.mjs` 的
# `test:*` 都会因依赖预检 MISSING 而红 —— 它按 `process.execPath`（`C:\Program Files\nodejs`）
# 推 node_modules，而 pi 装在 roaming/npm。⇒ 实测 18 个 FAIL 里有一批是这类假失败。
# 正规做法是环境变量（AGENTS.md R-16），不是 junction。
export PI_NODE_MODULES_DIR="${PI_NODE_MODULES_DIR:-$PWD/node_modules}"
: > "$OUT"
node -e '
const p=require("./package.json");
const names=Object.keys(p.scripts).filter(k=>k.startsWith("test:"));
console.log(names.join("\n"));
' > /tmp/_alltest_names.txt
TOTAL=0; PASS=0; FAIL=0; SKIP=0
while IFS= read -r name; do
  [ -z "$name" ] && continue
  TOTAL=$((TOTAL+1))
  line="$(node -e 'const p=require("./package.json");process.stdout.write(p.scripts[process.argv[1]])' "$name")"
  start=$(date +%s)
  if timeout 300 bash -c "$line" > /tmp/_t.out 2>&1; then
    rc=0
  else
    rc=$?
  fi
  dur=$(( $(date +%s) - start ))
  if [ "$rc" = "0" ]; then
    PASS=$((PASS+1)); echo "PASS|$name|${dur}s" >> "$OUT"
  else
    FAIL=$((FAIL+1)); echo "FAIL|$name|${dur}s|rc=$rc" >> "$OUT"
    sed -n '1,25p' /tmp/_t.out | sed 's/^/    /' >> "$OUT"
  fi
done < /tmp/_alltest_names.txt
echo "TOTALS|total=$TOTAL pass=$PASS fail=$FAIL" >> "$OUT"
echo "TOTALS total=$TOTAL pass=$PASS fail=$FAIL"
