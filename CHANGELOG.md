# Changelog

## 0.9.12

### Fixed
- **The turn watcher walked every account's history, in every window, every 2 s.** The
  session dirs it scanned (`projects`, `sessions`, `session-env`, `file-history`,
  `shell-snapshots`) are symlinks into the shared store, so each window did ~1,200
  directory reads per tick over everyone's transcripts, and any window's turn marked
  every window busy — deferring `idleReload` cutovers while anything on the machine was
  working. It now walks only `projects/<slug>` for this window's own `claude` processes
  (working directory via `/proc`, workspace folders as fallback), and it runs only while
  `failover.panelCutover` is `idleReload` — in the default `notify` mode nothing polls.
  Because transcript appends are now the only activity signal, the idle settle time
  rises from 12 s to 30 s so a long silent tool call is less likely to read as idle,
  and the watcher logs once when it has no transcript directory to watch.

## 0.9.11

### Changed
- **Usage is a central repository now: one fetch per account machine-wide.** Every
  window used to poll usage — and refresh OAuth tokens — against its own private copy
  of the account, so N windows meant N pollers and N independent token refreshes.
  Anthropic rotates the refresh token on every refresh, so those parallel refreshes
  kept stranding each other's copies (the "OAuth session expired" churn) and piled
  onto one rate budget (the 429s). Now whichever window finds the shared cache stale
  takes a per-account lock, re-checks under it, fetches once, and writes the shared
  cache; every other window just reads it, and a cache watcher repaints all windows
  within a couple of seconds of any fetch. For saved accounts, token refreshes run
  against the account STORE's credentials — one extension-driven rotation source per
  account (an unsaved window still uses its own copy); window copies converge through
  the 0.9.9 store-watch restock. Note: windows still on older versions keep the old
  per-window behavior until reloaded, so update every window promptly.
- **Every saved account is polled again — once, centrally.** The 0.9.6 change stopped
  cross-account polling because every window was doing it; with the central fetcher
  it costs one call per account (active accounts each minute, idle ones every five),
  so the tooltip can show all accounts without rate pressure. Cutover target picks
  and turn-transition checks read the shared cache and never touch the network.
- **Tooltip is a compact all-accounts table.** Account | 5h | 7d | Fable, one row per
  saved account with reset countdowns inline — including your secondary account — in
  place of the old multi-paragraph block. The toolbar's four items are unchanged.

### Fixed
- "rate-limit backoff active" now logs once per backoff episode instead of per call,
  and focus/reconcile no longer trigger usage fetches at all (repaint only).

## 0.9.10

### Added
- **Personal skills, agents, and slash commands now work in every account.** Claude
  Code looks for them under `CLAUDE_CONFIG_DIR`, and a managed window points that at
  its own per-window dir — so anything in `~/.claude/skills`, `~/.claude/agents`, or
  `~/.claude/commands` silently vanished in managed windows. Those three dirs are now
  linked into every window (same linking approach as the shared `settings.json` —
  symlink + one-time backup — but a directory of your files is never deleted): one
  source of truth in `~/.claude`, visible under every account. A real local dir that a
  window already had is preserved as `<name>.bak`. `plugins/` deliberately stays
  per-window — Claude Code manages live state there. Claude Code reads these at
  startup, so each window shows them from its next reload after upgrading.

### Docs
- README: skills/agents/commands sharing documented; the stale "skills are unrelated"
  row corrected; the 0.9.9 stale-token restock added to Safety.

## 0.9.9

### Fixed
- **"OAuth session expired and could not be refreshed" after working a while.** With
  the same account in more than one window, any window refreshing the token makes
  Anthropic rotate the refresh token — every other window's private copy silently dies,
  and that window hits this error once its access token expires. The account store
  always keeps the newest grant, but since 0.9.7 (no automatic reloads) nothing brought
  a *running* window's copy back in step; a reload fixed it only because folder-pinned
  windows restock from the store at startup. Now every window bound to a saved account
  watches that account's store, and when another window rotates the grant it quietly
  rewrites its own token **file** from the store within a couple of seconds — no
  process kill, no reload, no popup. If Claude Code's in-memory copy still trips the error before its next restart,
  the status-bar tooltip explains it inline, and one reload (which boots straight onto
  the live token) clears it.

### Internal
- `restockTokenOnly` is back (token file only — never the store's frozen
  `.claude.json`, which would revert live per-project state), now without the SIGKILL +
  reload it shipped with in 0.9.3. It reads the store grant once and writes exactly
  those bytes, compare-and-swaps against the dir's judged grant (a `/login` or
  `/logout` racing the reconcile bails out instead of being clobbered or resurrected),
  and refuses a store grant that also lives in another account's store. The `~/.claude`
  fallback mirror stays skipped for stale dirs — the window holding the live grant
  keeps it fresh, as before.

## 0.9.8

### Fixed
- **The account watcher no longer treats every `.claude.json` write as an account
  change.** Claude Code rewrites that file every few seconds during a turn (project
  state, history), and the watcher fired on each write — running a full reconcile,
  usage refresh, and policy write ~30×/minute and logging a
  `usage: cache hit` / `cutover: pressure during turn — deferred` pair every ~2 seconds
  while an account sat at its threshold. The watcher now fingerprints what it actually
  guards — the identity email, the home-root identity, and the credential bytes — and
  fires only when one of those changed (login, logout, forget, token rotation). Routine
  turn churn no longer triggers anything.

### Changed
- Quieter logs: the per-read `usage: cache hit` line is gone (real network fetches still
  log), the "pressure during turn — deferred" line logs once per turn instead of per
  event, and the idle "usage high — meter shows it" line repeats at most every
  10 minutes while pressure persists.

## 0.9.7

### Changed
- **Windows no longer reload themselves to refresh a token.** The self-healing token
  refresh (0.9.3) reloaded a window on focus/idle/startup whenever another window sharing
  the same account had rotated the OAuth token — and since 0.9.4 it did so silently, so a
  window you'd left on a plan prompt could come back reloaded with your work gone. That
  automatic heal-and-reload is removed: a window running its own account no longer reloads
  on focus/idle/startup just because another window refreshed the shared token — the case
  that was silently reloading windows mid-task. (Reloads still happen when you switch a
  window's account, sign in or out inside it, or via the opt-in post-turn cutover — all
  deliberate.) Trade-off: if you run the *same* account in several windows, a window can
  get signed out when the shared token rotates away; recover it with a fresh `/login` in
  that window. The clean fix is the extension's actual design: one account per window, so
  tokens never collide.

### Removed
- **The CLI orchestrator is gone.** The PATH-shim orchestrator (`scripts/claude-orch`,
  `install-orch`, `scripts/pick-account.cjs`) and the `failover.mode = "cli"` option are
  removed — it was an unused path that also caused stray "open with" popups on Windows.
  `failover.mode` is now `off` / `notify` (both meter-only); automatic account switching
  is `failover.panelCutover = idleReload`, unchanged. Existing `mode: "cli"` settings
  harmlessly read as `notify`.

### Internal
- Dead-code sweep: removed `healStaleTokenIfNeeded` / `restockTokenOnly` / `getMode`, the
  orch esbuild build steps and its tests, and renamed the write-only `OrchPolicy` type to
  `PolicyCache` (the on-disk cache is now used only as the cross-window usage fallback).

## 0.9.6

### Fixed
- **Stop polling other accounts from every window (the real source of the 429s).**
  Each window was fetching usage for *every* registered account on every poll cycle,
  even though nothing in meter-only mode reads another account's numbers — the status
  bar only shows the window's own account. Those extra calls piled onto the same
  per-token rate budget and tripped 429s, which then froze the meter (it looked stuck
  at an old percent while you actually climbed to 100%). Now a window polls only its
  own bound account; the full multi-account poll runs only when an auto-cutover
  strategy needs it (`failover.panelCutover = idleReload` or `failover.mode = cli`).
- **Don't fan-fetch every account when the meter is hot.** In the default meter-only
  mode, whenever the active account went over threshold the cutover check fetched usage
  for *all* registered accounts to find a cooler one — then threw the answer away,
  because meter-only mode never auto-switches. That fired on every poll while you were
  near your limit, adding cross-account API calls at the worst possible moment. Meter-
  only mode now skips that lookup entirely (the meter already shows the pressure; you
  switch when you choose). Only `idleReload` still computes a target.

## 0.9.5

### Fixed
- **Usage meter now actually updates in the background.** The 5-hour / weekly / model
  figures could sit at an old percent for minutes (stuck at 95% while you actually ran
  out) because the background poll fetched fresh numbers but only wrote them to disk and
  policy — the status-bar meter reads an in-memory value that was refreshed only on
  window focus or a manual refresh. The poll now updates that in-memory value too, so the
  meter moves on its own. And a rate-limit (429) used to freeze the meter for 5 minutes;
  that backoff is now one poll cycle, each window jitters its poll so several open windows
  don't stampede the API into a 429, and the tooltip says when it's rate-limited.

### Changed
- **Refresh Usage is inline, not a toast.** It forces a fresh fetch, shows a spinner on
  the status-bar account plus "Updating usage…" in the tooltip, and repaints the meter in
  place — no popup. While the API is backing off it won't hammer it; a hard failure such
  as being signed out still surfaces a message.

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
