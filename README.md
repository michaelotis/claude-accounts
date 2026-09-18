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

Every change lands through a pull request. Bump `package.json` and add the `## X.Y.Z` section to `CHANGELOG.md` in that PR; once it is merged, tag the release from a clean, up-to-date `main`:

```bash
git checkout main && git pull
npm run ship          # tags v<package.json version> and pushes only the tag
```

`ship.sh` refuses unless HEAD equals `origin/main`, the tree is clean, the changelog has the matching section, and the tag does not exist yet. Tag `v*` builds the VSIX and attaches it to a [GitHub Release](https://github.com/michaelotis/claude-accounts/releases). CI runs tests on every pull request and on every push to `main`.

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

**Which window is on which account.** Hovering the meter lists, under the accounts
table, one line per account with a window on it:

```text
**work** — 2 windows: work-client, my-project
**personal** — 1 window: side-project
```

Workspace names come from the workspace file or the first folder; a window with no
folder open reads `(no folder)`, past two names collapse into `+N`, and a window
whose directory names no readable account is grouped under `unknown account`. Every
window keeps a record of its own, so two windows on the same folder — which share a
working directory, and therefore an account — are two entries, and closing one leaves
the other listed. It is hover text only — nothing pops up and nothing reloads. The
same list is in
[`scripts/claude-usage`](#reading-usage-from-a-script-scriptsclaude-usage), which
also explains the five-minute liveness bound.

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
Turn idle is inferred from **this window’s own** transcripts only: the watcher finds this window’s live `claude` processes, maps their working directories to `projects/<slug>`, and looks for recent writes there (workspace folders are the fallback). Other windows’ activity never counts, and a live process alone is not “busy”. The watcher runs only while `panelCutover` is `idleReload`.

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

## Reading usage from a script (`scripts/claude-usage`)

The extension writes what it collects to a shared cache file, and each open window
records itself in `~/.config/claude-accounts/windows/` — one file per window, naming
its workspace, its config directory, its pid, the `host` that wrote it and its last
heartbeat. `scripts/claude-usage` reads those — nothing else. It **never writes,
locks or fetches**, so it works with every VS Code window closed and can never spend
an account's rate limit.

```bash
scripts/claude-usage                      # JSON on stdout
scripts/claude-usage --text               # compact table
scripts/claude-usage --account a@example.com
scripts/claude-usage --max-age 2m         # how fresh a reading must be
```

```json
{
  "schema": "claude-accounts/usage@1",
  "generatedAt": 1767225600000,
  "stale": false,
  "accounts": [
    {
      "email": "a@example.com",
      "planLabel": "Max",
      "orgName": "Example",
      "present": true,
      "sessionPercent": 12,
      "sessionResetsAt": "2026-01-01T00:00:00Z",
      "weeklyPercent": 34,
      "weeklyResetsAt": null,
      "models": [{ "name": "Fable", "percent": 40, "resetsAt": null }],
      "fetchedAt": 1767225595000,
      "ageMs": 5000,
      "stale": false,
      "windows": [
        {
          "workspace": "my-project",
          "configDir": "/home/YOU/.claude-windows/aaaa1111",
          "pid": 4242,
          "lastSeen": 1767225597000
        }
      ]
    }
  ],
  "otherWindows": [],
  "warnings": []
}
```

- `ageMs` is `now - fetchedAt`; an account is `stale` once that passes `--max-age`
  (default `10m`). Top-level `stale` is true if **any** listed account that is still
  `present` is stale, or if none was listed.
- An account that has **never** been fetched has `fetchedAt`, `ageMs` and every
  percentage as `null` with `stale: true` — its zeros in the cache are placeholders,
  not a reading, and are never reported as 0%. A fetch that recovered no percentage
  at all is `stale` the same way, with a line in `warnings`: unknown is not fresh.
- A reading stamped in the future is clock jitter within a minute and reads as
  `ageMs: 0`; beyond that its age cannot be known, so it is `ageMs: null` and
  `stale: true` with a warning (`--text` shows `?`, never `0s`).
- A reading whose fetch came back carrying no bucket at all is `stale` with every
  percentage `null` and `<account>: the last fetch carried no usage buckets` in
  `warnings`. The extension stores a bucket the response left out as 0, so without
  that line the account would read as fresh with its whole allowance intact.
- `present` has three outcomes. **`true`, no warning**: the credentials file is there.
  **`false`**: it is genuinely gone. Nothing prunes the cache, so a removed account
  would otherwise sit in it forever and hold the exit code at `1`; absent accounts
  stay in the list (`gone` in the `--text` STATE column) but count towards neither the
  top-level `stale` nor the exit code. Since that quietly narrows what exit `0` means,
  each one also adds a line to `warnings`:
  `<account>: no credentials in its config directory — left out of the exit code`.
  **`true`, with a warning**: the check could not be made —
  the config directory is not an absolute path (`CLAUDE_CONFIG_DIR` is stored exactly
  as it was set, so `~/…` and relative values occur), or looking at it failed for some
  other reason such as `EACCES`. Not being able to look is not the same as being
  signed out, so the account keeps its place in the exit code and the warning says the
  check did not happen. The credentials file is only checked for, never opened, and
  its directory never appears in the output.
- A percentage outside 0–100 becomes `null` and adds a line to `warnings`.
- Warnings about an account are printed only for accounts the output lists, so
  `--account` never names a different one. Warnings about the cache file itself —
  missing, unreadable, corrupt, an entry that is not an object — are always printed.
- An entry keyed by directory rather than email has `email: null`. Accounts sort by
  email. Warnings name such an entry by its directory's basename, with the parent's
  basename added when two of them share one (`projA/.claude`), never by its path.
- `windows` is every **live** VS Code window running that account — always an array,
  `[]` when none. Per window: `workspace` (the workspace file or first folder's
  name, `""` for a window with no folder open), `configDir` (the `CLAUDE_CONFIG_DIR`
  it runs), `pid` and `lastSeen` (epoch ms of its last heartbeat). The `--text`
  table shows the count as `WIN`.
- `otherWindows` is every live window no listed account claims — same fields plus
  its own `email`, which is `null` when its `configDir` names no readable account.
  A window belonging to an account that `--account` filtered out is **not** listed
  here; it has been accounted for. `--text` has no row to hang them on, so it
  prints one `other windows: N (no cached usage for their account)` line and the
  per-window detail stays in `--json`.
- A window counts as live while its process answers **and** its record has beaten
  within five minutes, so a window that has just closed can be listed for up to
  that long. A record whose `host` is not this machine's — a home directory shared
  between machines — is judged on its heartbeat alone, and its pid is never probed:
  that number is about a machine this one cannot ask. The account is read from the
  window's `configDir` at report time, never from the record, so a switch shows up on
  the next run and a record left behind by a crash can never name the wrong account.

Exit codes: `0` everything listed is fresh · `1` some of it is stale · `2` no data
(no cache yet, unreadable, nothing matched `--account`, or every account listed is
gone) · `3` a flag was wrong, `dist/usage-cli.js` is not built, or something failed
unexpectedly (message on stderr, stdout empty). In the default `--json` mode stdout
is valid JSON on `0`, `1` and `2`; `--text` is a table for people to read, and its
layout is not a contract to parse.

Run `npm run compile` (or install the extension) first — the wrapper runs
`dist/usage-cli.js` next to it.

## Safety

- Never discovers reserved sidecars; does not migrate **forgotten** dirs into `~/.claude-shared`
- Refuses Windows `/mnt/c` config paths for usage
- Resolves Linux `claude` only for `auth status`
- Does **not** mint OAuth sessions (Claude Code owns login); usage poll may refresh access tokens via the stored refresh token
- **Usage is fetched centrally**: one call per account machine-wide per cycle (a per-account lock + shared cache dedupe the windows); for saved accounts, token refreshes run against the account **store**, so the extension has one rotation source per account no matter how many windows are open (an unsaved window still uses its own copy)
- Same account in several windows: a token refresh in one window rotates the grant; the others quietly re-stock their **token file** from the account store (no reload, no popup — the tooltip explains if Claude Code errors once before its next restart)
- `~/.claude` follows the last explicitly chosen account (Switch Account, Save, in-window /login); a passive reconcile only refills an empty default or refreshes the same account with a newer grant — it never flips between saved accounts
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
scripts/      install-latest.sh + ship.sh + claude-usage
test/         node:test suites
```
