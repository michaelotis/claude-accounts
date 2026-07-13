#!/usr/bin/env bash
# ship.sh — bump version, tag, push, trigger GitHub Release (VSIX on the release).
#
# Usage:
#   ./scripts/ship.sh              # patch (0.5.0 → 0.5.1)
#   ./scripts/ship.sh minor        # 0.5.0 → 0.6.0
#   ./scripts/ship.sh major        # 0.5.0 → 1.0.0
#   ./scripts/ship.sh 0.6.0        # exact version
#   ./scripts/ship.sh --no-bump    # tag+push current package.json version only
#
# Requires: git clean working tree (or only intended changes), gh auth, push access.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "not a git repo" >&2
  exit 1
fi

BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != "main" ] && [ "$BRANCH" != "master" ]; then
  echo "warning: on branch $BRANCH (expected main)" >&2
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "working tree not clean — commit or stash first" >&2
  git status -sb
  exit 1
fi

ARG="${1:-patch}"
CURRENT=$(node -p "require('./package.json').version")

if [ "$ARG" = "--no-bump" ]; then
  NEW="$CURRENT"
else
  if [[ "$ARG" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    NEW="$ARG"
  else
    IFS=. read -r MA MI PA <<<"$CURRENT"
    case "$ARG" in
      patch) NEW="$MA.$MI.$((PA + 1))" ;;
      minor) NEW="$MA.$((MI + 1)).0" ;;
      major) NEW="$((MA + 1)).0.0" ;;
      *)
        echo "usage: $0 [patch|minor|major|X.Y.Z|--no-bump]" >&2
        exit 1
        ;;
    esac
  fi
  if [ "$NEW" != "$CURRENT" ]; then
    node -e "
      const fs=require('fs');
      const p=JSON.parse(fs.readFileSync('package.json','utf8'));
      p.version=process.argv[1];
      fs.writeFileSync('package.json', JSON.stringify(p,null,2)+'\n');
    " "$NEW"
    # Prefixed changelog entry if missing
    if ! grep -q "^## $NEW" CHANGELOG.md 2>/dev/null; then
      tmp=$(mktemp)
      {
        echo "# Changelog"
        echo ""
        echo "## $NEW"
        echo ""
        echo "- Release $NEW"
        echo ""
        tail -n +2 CHANGELOG.md 2>/dev/null | sed '1{/^# Changelog$/d;}' || true
      } >"$tmp"
      # simpler: prepend section after title
      {
        head -1 CHANGELOG.md
        echo ""
        echo "## $NEW"
        echo ""
        echo "- Release $NEW"
        echo ""
        tail -n +2 CHANGELOG.md
      } >"$tmp"
      mv "$tmp" CHANGELOG.md
    fi
    git add package.json CHANGELOG.md
    git commit -m "Release $NEW"
  fi
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
git push origin HEAD
git push origin "$TAG"

echo ""
echo "Pushed $TAG. GitHub Actions will attach the VSIX to the release."
echo "  https://github.com/michaelotis/claude-accounts/releases/tag/$TAG"
echo ""
echo "Install update in VS Code (WSL):"
echo "  cd ~/projects/claude-accounts && npm run install-latest"
echo "  # downloads VSIX + code --install-extension when CLI is on PATH"
echo "  # then: Developer: Reload Window"
