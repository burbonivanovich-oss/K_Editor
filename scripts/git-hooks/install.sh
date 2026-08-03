#!/usr/bin/env bash
# Установка локальных git-хуков. Использует git config core.hooksPath —
# не требует Husky или другой зависимости.
#
# Запуск:
#   bash scripts/git-hooks/install.sh
#
# После установки git автоматически запустит scripts/git-hooks/pre-commit
# перед каждым коммитом.

set -e

ROOT=$(git rev-parse --show-toplevel)
HOOKS_DIR="$ROOT/scripts/git-hooks"

chmod +x "$HOOKS_DIR/pre-commit"

git config core.hooksPath "$HOOKS_DIR"

echo "✓ git core.hooksPath → $HOOKS_DIR"
echo "  pre-commit factcheck-guard активирован"
echo ""
echo "Снять:    git config --unset core.hooksPath"
echo "Bypass:   git commit --no-verify"
