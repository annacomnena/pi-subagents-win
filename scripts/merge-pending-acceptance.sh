#!/usr/bin/env bash
# merge-pending-acceptance.sh — 宿主验收通过后，把 pending-acceptance-20261001 合回 dev
#
# 背景（2026-10-01）：GreenCAD dev 曾有 130 个未验收文件（3513/3514/3515/3516/3517 + UE 改动），
# 按用户裁定 C 方案存到临时分支 pending-acceptance-20261001（commit 0fb49bfc），
# dev 保持干净并继续推进（Blender P0-P5 共 7 commits）。
#
# 已预演（git merge-tree）：冲突仅 5 个文档/索引文件，无源码冲突：
#   Wiki/_keywords.json / Wiki/_navigation.json / Wiki/_search.json  ← wiki-nav 自动生成，rebuild 可解
#   changelog/2026/2026-10.md / recentwork.md                        ← 双方追加，需手工合并
#
# 用法：
#   bash scripts/merge-pending-acceptance.sh --dry-run   # 只检查，不改动
#   bash scripts/merge-pending-acceptance.sh             # 真正执行（需用户已验收）
#
# 前置：确认宿主验收已通过（AutoCAD 2018 六项 + 拓扑/写能力 + UE 阶梯）
set -euo pipefail

REPO="${GREENCAD_REPO:-G:/code/GreenCAD}"
BRANCH_TARGET="${BRANCH_TARGET:-dev}"
BRANCH_PENDING="${BRANCH_PENDING:-pending-acceptance-20261001}"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

cd "$REPO"

echo "=== 1. 前置检查 ==="
CUR=$(git branch --show-current)
echo "  当前分支: $CUR"
if [ "$CUR" != "$BRANCH_TARGET" ]; then
  echo "  ⚠️  不在 $BRANCH_TARGET 上；先 git checkout $BRANCH_TARGET"
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "  ⚠️  工作区不干净（$(git status --porcelain | wc -l) 个文件）；先处理"
  git status --porcelain | head -10
  exit 1
fi
echo "  ✅ 工作区干净"

echo
echo "=== 2. 冲突预演（merge-tree，只读）==="
MT=$(git merge-tree --write-tree --name-only "$BRANCH_TARGET" "$BRANCH_PENDING" 2>&1 || true)
CONFLICTS=$(printf '%s\n' "$MT" | grep -vE '^[0-9a-f]{40}$' | grep -vE '^Auto-merging' | grep -vE '^CONFLICT' | sed '/^$/d' || true)
echo "  预演结果（冲突文件）:"
printf '%s\n' "$MT" | grep '^CONFLICT' || echo "    （无冲突）"

if [ "$DRY_RUN" = "1" ]; then
  echo
  echo "--- DRY RUN 结束（未改动任何东西）---"
  exit 0
fi

echo
echo "=== 3. 执行 merge ==="
if ! git merge --no-ff "$BRANCH_PENDING" -m "merge: 合入 pending-acceptance-20261001（3513/3514/3515/3516/3517 + UE 改动，已通过宿主验收）"; then
  echo
  echo "=== 4. 解冲突（预期仅 5 个文档/索引文件）==="
  echo "  冲突文件:"
  git diff --name-only --diff-filter=U | sed 's/^/    /'

  # 索引文件：丢弃两边、稍后 rebuild 重新生成
  for f in Wiki/_keywords.json Wiki/_navigation.json Wiki/_search.json; do
    if git diff --name-only --diff-filter=U | grep -qx "$f"; then
      echo "  → $f: 取 dev 侧（稍后 wiki-nav rebuild 重新生成）"
      git checkout --ours -- "$f" && git add -- "$f"
    fi
  done

  # changelog / recentwork：双方追加 → 需人工合并（这里仅提示，不自动解）
  for f in changelog/2026/2026-10.md recentwork.md; do
    if git diff --name-only --diff-filter=U | grep -qx "$f"; then
      echo "  ⚠️  $f 需人工合并（双方都是追加）；解完后 git add $f"
    fi
  done

  REMAIN=$(git diff --name-only --diff-filter=U | wc -l)
  if [ "$REMAIN" -gt 0 ]; then
    echo
    echo "  还有 $REMAIN 个待人工解的冲突。解完后："
    echo "    git add <files> && git commit"
    echo "    # 然后重建 Wiki 索引："
    echo "    cd $REPO && node <pi-pkg>/scripts/wiki-nav-rebuild.mjs   # 或 wiki-nav rebuild 工具"
    exit 1
  fi
fi

echo
echo "=== 5. 重建 Wiki 索引（若 wiki-nav 可用）==="
echo "  提示：跑 wiki-nav rebuild（工具或脚本）以重新生成 _navigation/_search/_keywords"
echo
echo "=== ✅ merge 完成 ==="
git log --oneline -3
