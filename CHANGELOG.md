# Changelog

## 0.9.0

- Release 0.9.0


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
