# Changelog

## 0.9.4

### Changed
- The self-healing token refresh (0.9.3) no longer shows a "session refreshed" notice
  when it reloads a window. A token refresh is routine background maintenance you
  didn't ask about and don't need told about each time; the reload still happens
  silently (and the event stays in the log for diagnostics).

## 0.9.3

### Fixed
- **Self-healing token when two windows share an account.** Each window kept its own
  copy of the account's OAuth grant; because Anthropic rotates the refresh token on
  refresh, the window that refreshed kept working while the others were left on the
  dead copy and signed out. Now the account store always holds the newest grant (a
  window can't overwrite it with an older copy — the flap behind the sign-out churn),
  and a window left on a stale grant re-stocks its token from the store and reloads
  once its turn is idle (never mid-stream) so Claude Code picks up the live token. Only
  the credential is refreshed — the window's per-project state is kept — and the reload
  is metered. Windows also heal proactively on focus.

### Internal
- `refreshStore` is a newest-wins compare-and-set under the same per-store credentials
  lock the token refresh uses (async — never blocks the extension host), fail-closed on
  an unparseable/older grant while still able to repair a corrupt store. The `~/.claude`
  fallback mirror is no longer regressed to a stale grant, and a heal can no longer race
  a usage-driven account switch.

## 0.9.2

### Fixed
- **Status bar no longer shells out to `claude auth status`.** That 250 MB binary cold-starts slowly and errored intermittently, which showed up as a flickering "Confirming with `claude auth status`…" / "Could not run `claude auth status`…" tooltip. The account shown now comes from the window's own config file (the signal the rest of the extension already trusts) and usage from the token — no CLI spawn, no flicker.
- **Recovering a contaminated account is no longer blocked.** Reconcile now follows a fresh in-window `/login` *before* the "this store was overwritten" prompt, so signing in again as the affected account actually lands and heals its store (previously the prompt short-circuited the login). The "shared grant" warning also no longer fires in the healthy (victim) window — only the window whose account was actually overwritten is prompted.

## 0.9.1

### Fixed
- **Critical — account credential cross-contamination.** With more than one saved account, one account's OAuth token could be written into another account's store, leaving every `.credentials.json` sharing a single token: switching to account B ran as account A, and a `/logout` could sign out both. Root cause: reconcile copied a working dir's token into the store chosen by the dir's _identity_ file, which can drift from the token. Now:
  - token propagation is decided by which account actually **owns** the token (matched on its refresh token), never the mutable identity field;
  - a hard tripwire refuses to write a grant into any store it doesn't belong to (fails closed on unreadable identity, skips sidecars), and the capture/snapshot path is guarded the same way;
  - a working dir whose identity drifted but whose token is unchanged is corrected in place — no reload, no store write;
  - a store detected as contaminated prompts a one-time "sign in again" instead of looping.
- Account switching no longer reverts on reload for contaminated stores; a fresh sign-in restores the affected account cleanly.

### Changed
- **Meter-only usage pressure.** Removed the modal usage popups ("usage high", "no cooler account / staying put", the post-turn "switch to X?" prompt, and the cooldown prompt) — switching always needs a reload, so they were noise on top of the status-bar meter. The per-metric meter now colours as each limit crosses its threshold and you switch when you choose. `failover.panelCutover = idleReload` still auto-switches (opt-in); account-safety prompts (signed-out / re-login) are unchanged.
- Usage meter now refreshes every **1 minute** (was 5). The old interval was a self-imposed cache TTL, not an API limit; the disk cache is shared and deduped across windows, so this stays ~1 fetch/min per account, and a real 429 still backs off.

## 0.9.0

### Improved
- Multi-window data integrity: atomic writes (unique temp files) and advisory locks for the shared `$HOME` files; on-disk `policy.json` membership; single-writer shared-history migration; per-account 429 backoff; serialized token refresh; overlap-guarded polling
- MCP servers configured at user scope now propagate into managed windows
- `~/.claude/settings.json` (auto-compact threshold + message, model, hooks) is shared into every managed window
- Usage meter colors the individual over-threshold metric, not the whole bar

### Fixed
- Account safety: logout no longer resurrects a revoked token; the CLI orchestrator fails closed on a missing pin; cutover never fires mid-turn
- Stripped personal context; added ESLint + Prettier in CI

## 0.8.2

### Fixed
- Usage poll sequence: (1) 5‑min cache (2) **preliminary `ensureFreshToken`** → `console.anthropic.com/v1/oauth/token` when near expiry (3) single `GET /api/oauth/usage` (4) 401 → force-refresh once (5) **429 → backoff + last cache / policy / zeros**, never a hard “sign in” toast
- No parallel `/profile` call on the usage path (was doubling request pressure)
- Refresh Usage prefers cache; falls back to policy.json account rows when usage-cache is empty

## 0.8.1

### Fixed
- Usage fetch aligned with **claudemeter** patterns: refresh near-expiry tokens, 5‑minute disk cache, 429/network serves last good meter (not “sign in again”), one poll per email
- Double-reload after Switch Account (reconcile no longer requests a second auto-reload within the cooldown)
- Clearer usage error toasts when there is no cache to fall back on

## 0.8.0

### Improved
- **Per-workspace auto-select for multi-window**: folder routes + learned Switch-Account map bind **before** global last-used, so opening a work project and a personal project in two VS Code windows each get the right account without a wrong-bind + reload
- Persist folder→account at activation when the working dir already has the pin’s credentials (no reload)
- Force-stock + metered reload when the pin’s dir is empty/wrong (avoids empty-dir + reconcile wrongly forgetting a good account)
- `clearMachineOverride` before `remember` (isolation-critical clear is not delayed by state I/O)
- Case-insensitive email match for routes and account lookup
- Switch Account warns when a **settings** pin will re-apply after reload
- `npm run install-latest` downloads the GitHub Release VSIX **and** runs `code --install-extension` when a CLI is on PATH (Marketplace later, after dogfood)
- README: what the extension is for / not for (no context consolidation across accounts, etc.)

### Fixed
- Preferred route + empty working dir no longer reports a healthy bind and can no longer cascade into `handleLoggedOut` forgetting the route account

## 0.7.0

### Fixed (review Top 5)
- Panel cutover pressure no longer gated on `failover.mode` (works with mode=off)
- `idleReload` only switches to a **cool** target; 5-minute auto-reload cooldown
- Turn detection: file activity on **this** config dir only (not shared store / process-alone)
- Poll **all** registry accounts into policy; prune on Forget; fetch-fail ≠ 100%
- Shared `selectFailoverAccount` via `scripts/pick-account.cjs` + built `usageParse.cjs`
- `syncCutover` uses same accountOrder merge as usage settings

## 0.6.0

### Added
- **Post-turn panel cutover**: `failover.panelCutover` = `off` | `notify` | `idleReload`
- Turn watcher infers IN_TURN from session/project writes + live `claude` processes
- Pressure during a turn is deferred; cutover only after settle (~4s idle)
- `idleReload` auto-selects next account (same strategy as CLI) then bind+reload
- Workspace pins never auto-left by panel cutover

## 0.5.0

### Changed
- Failover is **N-account**, not primary/secondary pair
- `failover.strategy`: `lowestUsage` (default) | `ordered`
- `failover.accountOrder`: emails or registry names (pool / preference list)
- Legacy primaryEmail/secondaryEmail only seed accountOrder when empty
- Policy version 3

## 0.4.0

### Added
- Per-dimension failover flags: `failover.onSession`, `onWeekly`, `onFable` (defaults: session+weekly **true**, Fable **false**)
- Meter still shows all buckets; only enabled flags drive notify / CLI account switch
- Policy JSON includes `triggers` for the orchestrator

## 0.3.0

### Added
- **Workspace → account routes** (`claudeAccounts.workspaceRoutes`): longest path prefix wins; hard pin for CLI orch and VS Code auto-bind
- Learned folder→account from Switch Account still exported to policy; settings override same prefix
- Policy version 2 includes `workspaceRoutes`
- Orchestrator picks workspace route **before** failover / inherited env

## 0.2.0

### Fixed
- Shared-history migration no longer includes **forgotten** account dirs or sidecars (reserved names / Windows paths)
- `claude auth status` resolution prefers a **Linux** binary and never deliberately uses `/mnt/c`

### Added
- Usage pure parse module + unit tests (Fable `weekly_scoped` limits)
- Settings: `claudeAccounts.failover.*` (`mode`: off | notify | cli, thresholds, primary/secondary emails)
- High-usage **notify** toast with optional Switch account
- Policy cache `~/.config/claude-accounts/policy.json` for CLI orchestrator
- `scripts/claude-orch` + `npm run install-orch` — PATH shim for CLI failover without VS Code reload

## 0.1.0

- Initial combine of Parallel Accounts + OAuth usage (workspace extension, WSL-first)
