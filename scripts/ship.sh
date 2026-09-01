#!/usr/bin/env bash
# ship.sh — tag the already-merged main and push that tag (GitHub Release / VSIX).
#
# Usage:
#   ./scripts/ship.sh
#
# Requires: on main, clean tree, HEAD == origin/main after fetch, CHANGELOG
# section matching package.json's version, gh auth, push access. Version bumps
# land through a PR first; this script only tags.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "not a git repo" >&2
  exit 1
fi

BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != "main" ]; then
  echo "not on main (on $BRANCH)" >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "working tree not clean — commit or stash first" >&2
  git status -sb
  exit 1
fi

git fetch origin main
head=$(git rev-parse HEAD) || exit 1
remote=$(git rev-parse origin/main) || exit 1
if [ "$head" != "$remote" ]; then
  echo "HEAD is not origin/main — land the version bump through a PR first" >&2
  exit 1
fi

NEW=$(node -p "require('./package.json').version")
[ -f CHANGELOG.md ] || { echo "CHANGELOG.md missing" >&2; exit 1; }
if ! grep -qxF -- "## $NEW" CHANGELOG.md; then
  echo "CHANGELOG.md has no ## $NEW section" >&2
  exit 1
fi

TAG="v$NEW"
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "tag $TAG already exists" >&2
  exit 1
fi

# Sanity
npm test
npm run compile
npx @vscode/vsce package --no-dependencies --allow-star-activation

git tag -a "$TAG" -m "Claude Accounts + Usage $NEW"
if ! git push origin "$TAG"; then
  if git tag -d "$TAG"; then
    echo "local tag $TAG removed; retry is clean" >&2
  else
    echo "could not remove local tag $TAG — delete it before retrying" >&2
  fi
  exit 1
fi

echo ""
echo "Pushed $TAG. GitHub Actions will attach the VSIX to the release."
echo "  https://github.com/michaelotis/claude-accounts/releases/tag/$TAG"
echo ""
echo "Install update in VS Code (WSL):"
echo "  cd ~/projects/claude-accounts && npm run install-latest"
echo "  # downloads VSIX + code --install-extension when CLI is on PATH"
echo "  # then: Developer: Reload Window"
