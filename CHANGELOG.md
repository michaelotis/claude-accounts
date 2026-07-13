# Changelog

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
- Shared-history migration no longer includes **forgotten** account dirs or sidecars (camwatch / reserved names / Windows paths)
- `claude auth status` resolution prefers a **Linux** binary and never deliberately uses `/mnt/c`

### Added
- Usage pure parse module + unit tests (Fable `weekly_scoped` limits)
- Settings: `claudeAccounts.failover.*` (`mode`: off | notify | cli, thresholds, primary/secondary emails)
- High-usage **notify** toast with optional Switch account
- Policy cache `~/.config/claude-accounts/policy.json` for CLI orchestrator
- `scripts/claude-orch` + `npm run install-orch` — PATH shim for CLI failover without VS Code reload

## 0.1.0

- Initial combine of Parallel Accounts + OAuth usage (workspace extension, WSL-first)
