#!/usr/bin/env bash
# Устанавливает git-хуки из scripts/hooks/ в .git/hooks/
set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel)
HOOKS_SRC="${REPO_ROOT}/scripts/hooks"
HOOKS_DST="${REPO_ROOT}/.git/hooks"

for hook in "$HOOKS_SRC"/*; do
  name=$(basename "$hook")
  dest="${HOOKS_DST}/${name}"
  cp "$hook" "$dest"
  chmod +x "$dest"
  echo "Установлен: .git/hooks/${name}"
done

echo ""
echo "Хуки установлены. Проверить: git commit --dry-run"
