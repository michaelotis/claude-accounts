# Claude Accounts + Usage

Multi-account **Claude Code** for **Linux / WSL / Remote-SSH**: live usage (5h / 7d / **Fable**), per-window isolation, workspace → account auto-select, optional post-turn panel failover.

## What this is for

| Need                                 | How this helps                                                                                                                                                                                                        |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Two Claude accounts at once**      | Work in one VS Code window, personal in another — each has its own `CLAUDE_CONFIG_DIR` and credential copy                                                                                                            |
| **Open a folder → right account**    | `workspaceRoutes` (or Switch Account once) pins a tree to an email; preferred over “last used anywhere”                                                                                                               |
| **See usage live**                   | Status bar: 5h session, 7d all-models, Fable (and other model-scoped limits)                                                                                                                                          |
| **Failover when an account is hot**  | Status-bar meter shows the pressure; optional **post-turn** panel cutover switches accounts when a turn settles (never mid-stream)                                                                                    |
| **Keep one conversation history**    | Shared history store so multi-account does not fragment or hide past chats                                                                                                                                            |
| **Keep your MCP servers & settings** | User-scope `mcpServers` (from `~/.claude.json`) are merged into each window, and your `~/.claude/settings.json` (auto-compact, model, hooks, …) is shared into every window, so both apply under per-window isolation |
| **Keep your skills everywhere**      | Your personal `~/.claude/skills`, `agents`, and `commands` are linked into every window, so they work in every account (`plugins/` stays per-window — Claude Code manages live state there)                           |

Upstream credit: [Parallel Accounts](https://github.com/DercasDrol/claude-parallel-profiles) + usage patterns from [Claudemeter](https://github.com/hyperi-io/claudemeter) (both MIT). See `NOTICE`.

## What this is **not** for

| Not a goal                                         | Why                                                                                                                                                                                                          |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Context consolidation across accounts**          | Each account is a separate Anthropic identity. History is shared as **files** so chats are not lost — not a single Claude brain.                                                                             |
| **One panel, hot-swap mid-turn**                   | Claude Code reads `CLAUDE_CONFIG_DIR` at startup, so an account change reloads the window (only when you switch accounts).                                                                                   |
| **macOS / native Windows Claude**                  | Linux semantics only. Use a **WSL or Linux remote** window; inert elsewhere.                                                                                                                                 |
| **Replacing Parallel Accounts on Windows UI host** | `extensionKind: workspace` on purpose (avoids UI-host bugs under WSL). Install on the remote/WSL side.                                                                                                       |
| **Minting OAuth sessions / API proxy**             | Claude Code owns login. We copy credentials into per-window dirs; the usage meter may **refresh access tokens** with the stored refresh token so the poll stays valid — we do not act as an Anthropic proxy. |
| **Project memory / CLAUDE.md**                     | Repo-scoped by Claude Code itself; unrelated to accounts. (Personal `~/.claude` skills/agents/commands ARE shared — see above.)                                                                              |
| **Hiding usage from Anthropic**                    | Meter reads the same usage the product exposes; failover only picks which **saved account** runs next.                                                                                                       |

Supported model for more quota: **finish the turn → cut over or open another window on a cool account** — not transparent context merge.

## Why (vs other tools)

| Tool              | Problem                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------- |
| Parallel Accounts | Multi-account OK; no usage                                                                  |
| Claudemeter       | Usage OK; `extensionKind: ui` on **Windows** host under WSL → wrong binary, re-login thrash |
| This extension    | **workspace** only + usage + workspace pins + post-turn panel failover                      |

## Install / update (VSIX from GitHub)

Not on the Marketplace yet (dogfood via Releases first). Updates are a CLI step, not the Extensions “Update” button.

**Latest release (recommended):**

```bash
cd ~/projects/claude-accounts && npm run install-latest
# downloads the newest *.vsix and runs: code --install-extension …
# then: Command Palette → Developer: Reload Window
```

Needs `gh` auth. Uses `code`, `code-insiders`, or `cursor` if on PATH; otherwise prints the path for **Extensions → ⋯ → Install from VSIX**.  
Download only: `CLAUDE_ACCOUNTS_SKIP_INSTALL=1 npm run install-latest`.

**From source:**

```bash
cd ~/projects/claude-accounts
npm install && npm run compile && npm run package
# then install the printed .vsix the same way
```

In a **WSL** VS Code window:

1. Disable **Claudemeter** and **Claude Parallel Accounts** (avoid fighting over accounts)
2. `npm run install-latest` (or Install from VSIX)
3. Reload window

**Later:** Marketplace or Open VSX would give one-click auto-update. Until then: Releases + `install-latest`.

### Pushing updates (maintainers)

```bash
# commit your changes first, then:
npm run ship          # patch bump → tag vX.Y.Z → push → GH Release + VSIX
npm run ship -- minor
npm run ship -- 0.6.0
```

CI runs tests on every push to `main`. Tag `v*` builds the VSIX and attaches it to a [GitHub Release](https://github.com/michaelotis/claude-accounts/releases).

Status bar example:

```text
$(account) you · 5h 4% · 7d 89% · Fable 96%
```

## Workspace → account (work vs personal)

Hard-map directory trees to an email. **Longest matching prefix wins.** Emails match **case-insensitively**.

Under a match:

- VS Code **auto-selects** that account when you open the folder
- Panel cutover **will not** leave the pin

### Multiple VS Code windows

Each window has its own extension host — work and personal can run at once:

1. Window A → `/home/YOU/projects/work-client` → work Claude
2. Window B → `/home/YOU/projects/side-project` → personal Claude

Pin trees in settings (or **Switch Account** once so it learns):

```json
// settings.json (WSL / remote) — use your own paths and emails
{
  "claudeAccounts.failover.strategy": "lowestUsage",
  "claudeAccounts.failover.accountOrder": ["personal@example.com", "work@example.com"],
  "claudeAccounts.workspaceRoutes": [
    { "pathPrefix": "/home/YOU/projects/work-client", "email": "work@example.com" },
    { "pathPrefix": "/home/YOU/projects", "email": "personal@example.com" }
  ]
}
```

Longer prefixes win: a specific work tree uses **work**; other repos under `projects/` use **personal**.

**Auto-select order** for the open folder:

1. `workspaceRoutes` **or** learned map from a prior **Switch Account** (longest prefix; **settings win** on the same prefix)
2. This window’s last choice for that workspace
3. Global “last used anywhere” — only for a brand-new window with no folder mapping and no working dir yet

**Settings pins reassert.** If routes map this folder to work, **Switch Account → personal** reloads for this session, but the next open applies the pin again. Change or remove the route to stick a different default. The Switch picker warns when a settings pin is active.

**Reload behavior:** if the working dir already has the pin’s credentials, activation binds without reload. If empty (e.g. after `/logout`) or wrong account, the extension force-stocks the pin and reloads once (metered).

## Failover modes (Settings → Claude Accounts)

Applies when **no** workspace route matched the cwd. Supports **N accounts**, not just two.

| `failover.mode`        | Behavior                                                |
| ---------------------- | ------------------------------------------------------- |
| **`notify`** (default) | Usage pressure shows on the status-bar meter (no popup) |
| **`off`**              | Same as `notify` — meter only                           |

`failover.mode` is effectively legacy: both values just show the meter, and neither is read anywhere else since the CLI orchestrator was removed. Account switching is driven entirely by **panel cutover** (below); the failover **flags** (`onSession` / `onWeekly` / `onFable` + thresholds) still decide what counts as "hot".

### Panel cutover (after the turn finishes)

Never switches mid-stream. Watches session file activity + `claude` processes; when settled (~4s quiet):

| `failover.panelCutover` | Behavior                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| **`notify`** (default)  | After idle, offer Switch (or toast while deferred during a turn)                                   |
| **`idleReload`**        | After idle, auto-pick next **cool** account and `switchTo` (bind + window reload). 5‑min cooldown. |
| **`off`**               | No panel cutover                                                                                   |

Workspace routes still **block** auto panel cutover.  
Turn idle is inferred from **this window’s** session/project file activity (not other windows; process-alone is not “busy”).

### Strategy (how to pick among many accounts)

| `failover.strategy`         | Behavior                                                                                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **`lowestUsage`** (default) | Among **cool** accounts, pick lowest score = max(enabled dimension %%). If all hot, pick least-bad. Optional `accountOrder` restricts the pool. |
| **`ordered`**               | Walk `accountOrder` (emails or registry names); first **cool** wins; if all hot, first in list.                                                 |

```json
{
  "claudeAccounts.failover.panelCutover": "idleReload",
  "claudeAccounts.failover.strategy": "lowestUsage",
  "claudeAccounts.failover.accountOrder": [
    "personal@example.com",
    "work@example.com",
    "other@example.com"
  ]
}
```

Empty `accountOrder` = all accounts known to the policy cache (from usage polls / logins).

### What counts as “hot” (triggers account pick)

Meter always shows 5h / 7d / Fable. Failover only uses dimensions you enable:

| Setting              | Default   | Meaning                                       |
| -------------------- | --------- | --------------------------------------------- |
| `failover.onSession` | **true**  | 5h session ≥ threshold → hot                  |
| `failover.onWeekly`  | **true**  | 7d all-models ≥ threshold → hot               |
| `failover.onFable`   | **false** | Fable ≥ threshold → **not** hot for switching |

Thresholds: `sessionThreshold` / `weeklyThreshold` / `fableThreshold` (default 90).

Legacy `primaryEmail` / `secondaryEmail` still seed `accountOrder` if that list is empty.

## Safety

- Never discovers reserved sidecars; does not migrate **forgotten** dirs into `~/.claude-shared`
- Refuses Windows `/mnt/c` config paths for usage
- Resolves Linux `claude` only for `auth status`
- Does **not** mint OAuth sessions (Claude Code owns login); usage poll may refresh access tokens via the stored refresh token
- **Usage is fetched centrally**: one call per account machine-wide per cycle (a per-account lock + shared cache dedupe the windows); for saved accounts, token refreshes run against the account **store**, so the extension has one rotation source per account no matter how many windows are open (an unsaved window still uses its own copy)
- Same account in several windows: a token refresh in one window rotates the grant; the others quietly re-stock their **token file** from the account store (no reload, no popup — the tooltip explains if Claude Code errors once before its next restart)
- **Forget** still signs out that **email** everywhere — use carefully
- Shared history is for **not losing chats**, not consolidating identity/context across accounts

## Dev

```bash
npm run compile
npm test
npm run package
```

## Layout

```text
src/          extension (TypeScript)
scripts/      install-latest.sh + ship.sh
test/         node:test suites
```
