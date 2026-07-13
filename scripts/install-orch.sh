#!/usr/bin/env bash
# Install claude-orch ahead of real claude on PATH (~/bin/claude).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="${HOME}/bin"
mkdir -p "$BIN"
install -m 755 "$ROOT/scripts/claude-orch" "$BIN/claude-orch"
mkdir -p "$BIN/claude-accounts-lib"
# Shared pick + pure selection (built by npm run compile)
if [ -f "$ROOT/scripts/pick-account.cjs" ]; then
  install -m 644 "$ROOT/scripts/pick-account.cjs" "$BIN/claude-accounts-lib/pick-account.cjs"
fi
if [ -f "$ROOT/scripts/lib/usageParse.cjs" ]; then
  mkdir -p "$BIN/claude-accounts-lib/lib"
  install -m 644 "$ROOT/scripts/lib/usageParse.cjs" "$BIN/claude-accounts-lib/lib/usageParse.cjs"
fi
# Thin wrapper named `claude` that always goes through orch
cat > "$BIN/claude" <<'EOF'
#!/usr/bin/env bash
# CLAUDE_ACCOUNTS_ORCH — managed by claude-accounts install-orch.sh
exec "$(dirname "$0")/claude-orch" "$@"
EOF
chmod 755 "$BIN/claude"
# Point orch at installed pick-account when run from ~/bin
# (claude-orch searches fixed paths; also symlink for discovery)
ln -sfn "$BIN/claude-accounts-lib/pick-account.cjs" "$BIN/pick-account.cjs" 2>/dev/null || true

# Ensure ~/bin is first on PATH for interactive shells
MARKER='# claude-accounts orch'
for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
  [ -f "$rc" ] || continue
  if ! grep -qF "$MARKER" "$rc" 2>/dev/null; then
    {
      echo ""
      echo "$MARKER"
      echo 'export PATH="$HOME/bin:$PATH"'
    } >> "$rc"
    echo "Appended PATH to $rc"
  fi
done

echo "Installed:"
echo "  $BIN/claude -> claude-orch"
echo "  $BIN/claude-orch"
echo "Real binary will be resolved at runtime (skips ~/bin and /mnt/c)."
echo "Policy: ~/.config/claude-accounts/policy.json (written by the VS Code extension)."
echo "Failover only when policy.mode === \"cli\". Open a new terminal so PATH updates."
echo ""
echo "Also set in VS Code settings.json if integrated terminals should use the shim:"
echo '  "terminal.integrated.env.linux": { "PATH": "${env:HOME}/bin:${env:PATH}" }'
