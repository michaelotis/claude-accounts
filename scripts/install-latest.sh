#!/usr/bin/env bash
# Download latest VSIX from GitHub Releases and install it when a VS Code CLI is available.
# Marketplace auto-update is deferred until the extension has been dogfooded longer.
set -euo pipefail

REPO="${CLAUDE_ACCOUNTS_REPO:-michaelotis/claude-accounts}"
OUT="${1:-/tmp}"
SKIP_INSTALL="${CLAUDE_ACCOUNTS_SKIP_INSTALL:-0}"

mkdir -p "$OUT"
cd "$OUT"
rm -f claude-accounts-*.vsix

if ! command -v gh >/dev/null 2>&1; then
  echo "error: gh (GitHub CLI) is required to download releases" >&2
  exit 1
fi

echo "Downloading latest VSIX from github.com/$REPO …"
gh release download -R "$REPO" -p "*.vsix" --clobber

VSIX=$(ls -1 claude-accounts-*.vsix 2>/dev/null | sort -V | tail -1)
if [[ -z "${VSIX:-}" ]]; then
  echo "error: no claude-accounts-*.vsix on the latest release" >&2
  exit 1
fi

ABS="$OUT/$VSIX"
echo "Downloaded: $ABS"

find_cli() {
  local c
  for c in ${CODE_CLI:-} code code-insiders cursor; do
    [[ -z "$c" ]] && continue
    if command -v "$c" >/dev/null 2>&1; then
      echo "$c"
      return 0
    fi
  done
  return 1
}

if [[ "$SKIP_INSTALL" == "1" ]]; then
  echo "CLAUDE_ACCOUNTS_SKIP_INSTALL=1 — not installing."
  echo "Install manually: Extensions → ⋯ → Install from VSIX → $ABS"
  exit 0
fi

if CLI=$(find_cli); then
  echo "Installing with: $CLI --install-extension \"$ABS\""
  if "$CLI" --install-extension "$ABS"; then
    echo ""
    echo "Installed $VSIX."
    echo "Reload the window to run it: Command Palette → Developer: Reload Window"
    echo "(Or close and reopen the WSL/remote window.)"
    exit 0
  fi
  echo "warn: $CLI --install-extension failed; install manually below." >&2
else
  echo "No code/cursor CLI on PATH — install manually:"
fi

echo "  Extensions → ⋯ → Install from VSIX → $ABS"
echo "Or put the VS Code shell command on PATH, then re-run: npm run install-latest"
