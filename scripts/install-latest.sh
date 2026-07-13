#!/usr/bin/env bash
# Download latest VSIX from GitHub Releases and print install path.
set -euo pipefail
REPO="${CLAUDE_ACCOUNTS_REPO:-michaelotis/claude-accounts}"
OUT="${1:-/tmp}"
mkdir -p "$OUT"
cd "$OUT"
rm -f claude-accounts-*.vsix
gh release download -R "$REPO" -p "*.vsix" --clobber
VSIX=$(ls -1 claude-accounts-*.vsix | sort -V | tail -1)
echo "Downloaded: $OUT/$VSIX"
echo "Install in WSL VS Code: Extensions → ⋯ → Install from VSIX → $OUT/$VSIX"
echo "Or CLI (if code on PATH): code --install-extension \"$OUT/$VSIX\""
