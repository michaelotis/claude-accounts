# Claude Accounts + Usage

Multi-account **Claude Code** for **Linux / WSL / Remote-SSH**, with live usage (5h / 7d / **Fable**), **per-window isolation**, **workspace → account auto-select**, and optional **CLI / panel failover**.

## What this is for

| Need | How this helps |
|------|----------------|
| **Two Claude accounts at once** | Work in one VS Code window, personal in another — each host has its own `CLAUDE_CONFIG_DIR` and working copy of credentials |
| **Open a folder → right account** | `workspaceRoutes` (or Switch Account once) pins a tree to an email; auto-select prefers that over “last used anywhere” |
| **See usage live** | Status bar: 5h session, 7d all-models, Fable (and other model-scoped limits) |
| **Failover when an account is hot** | Notify, CLI PATH orchestrator for **new** `claude` processes, and optional **post-turn** panel cutover (never mid-stream) |
| **Keep one conversation history** | Shared history store so installing multi-account does not fragment or hide your past chats |

Upstream credit: [Parallel Accounts](https://github.com/DercasDrol/claude-parallel-profiles) + usage patterns from [Claudemeter](https://github.com/hyperi-io/claudemeter) (both MIT). See `NOTICE`.

## What this is **not** for

| Not a goal | Why |
|------------|-----|
| **Context consolidation across accounts** | Each account is a separate Anthropic identity and billing subject. This extension does **not** merge chat context, memory, or “continue this thread” across work vs personal. History is **shared as files** so you do not *lose* conversations when switching windows — it is not a single Claude brain. |
| **One panel, hot-swap accounts mid-turn** | Claude Code reads `CLAUDE_CONFIG_DIR` at startup. Changing account reloads the window (or only affects **new** CLI processes via the orch). Mid-stream agent turns are never interrupted by failover. |
| **macOS / native Windows Claude** | Linux semantics only (files, `/proc`, symlinks). Use a **WSL or Linux remote** window. The extension stays inert on unsupported hosts. |
| **Replacing Parallel Accounts’ dual-window UX on Windows UI host** | We are `extensionKind: workspace` on purpose (Claudemeter-style UI-host bugs under WSL). Install in the remote/WSL side. |
| **OAuth token refresh / Anthropic API proxy** | Claude Code owns login and rotation. We copy credential files into per-window dirs; we do not mint or refresh tokens. |
| **Project memory / CLAUDE.md / skills management** | Unrelated. Use Claude Code and your own repo docs. |
| **Hiding usage from Anthropic** | The meter reads the same usage the product already exposes; failover only picks which **saved account** runs next work. |

If you need “one continuous agent with more quota,” the supported model is: **finish the turn → cut over or open another window on a cool account** — not transparent context merge.

## Why (vs other tools)

| Tool | Problem |
|------|---------|
| Parallel Accounts | Multi-account OK; no usage |
| Claudemeter | Usage OK; `extensionKind: ui` runs on **Windows** host under WSL remote → wrong binary, re-login thrash |
| This extension | **workspace** only + usage + workspace pins + policy for CLI/panel failover |

## Install / update (VSIX from GitHub)

Not on the VS Code Marketplace yet (on purpose — dogfood via Releases first). Updates are a short CLI step, not the Extensions “Update” button.

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

**Later:** once this has been stable for a while in real use, publishing to the Marketplace (or Open VSX) would give one-click auto-update. Until then, Releases + `install-latest` is the update channel.

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

Hard map directory trees to an email. **Longest matching prefix wins.** Emails are matched **case-insensitively**.

Under a match:

- CLI orchestrator **always** uses that account (no cross-account failover)
- VS Code **auto-selects** that account when you open the folder
- Panel cutover **will not** leave the pin

### Multiple VS Code windows

Each window has its own extension host, so you can run **work and personal at the same time**:

1. Window A → open `/home/YOU/projects/work-client` → work Claude  
2. Window B → open `/home/YOU/projects/side-project` → personal Claude  

Pin trees in settings (or **Switch Account** once in a folder so it learns):

```json
// settings.json (WSL / remote) — use your own paths and emails
{
  "claudeAccounts.failover.strategy": "lowestUsage",
  "claudeAccounts.failover.accountOrder": [
    "personal@example.com",
    "work@example.com"
  ],
  "claudeAccounts.workspaceRoutes": [
    { "pathPrefix": "/home/YOU/projects/work-client", "email": "work@example.com" },
    { "pathPrefix": "/home/YOU/projects", "email": "personal@example.com" }
  ]
}
```

Longer prefixes win: a specific work tree uses **work**; other repos under `projects/` use **personal**.

**How auto-select is chosen** for the open folder:

1. `workspaceRoutes` (settings) **or** learned map from a prior **Switch Account** in that tree (longest prefix; **settings win** on the same prefix)  
2. This window’s last choice for that workspace  
3. Global “last used anywhere” — only for a brand-new window with **no** folder mapping and no working dir yet  

So a mapped work folder never inherits personal just because you used personal last in another window.

**Settings pins reassert.** If `workspaceRoutes` maps this folder to work, **Switch Account → personal** reloads once for this session, but the **next** window open applies the pin again. Change or remove the settings route to stick a different default. The Switch picker warns when a settings pin is active.

**Reload behavior:** if the working dir already has the pin’s credentials, activation binds without reload. If the dir is empty (e.g. after `/logout`) or the wrong account, the extension force-stocks the pin and reloads once (metered).

## Failover modes (Settings → Claude Accounts)

Applies when **no** workspace route matched the cwd (unmapped paths only). Supports **N accounts**, not just two.

| `failover.mode` | Behavior |
|-----------------|----------|
| **`notify`** (default) | Toast when a failover-enabled dimension is hot |
| **`cli`** | PATH shim picks an account via `failover.strategy` on **new** CLI processes |
| **`off`** | Meter only for CLI/policy side |

### Panel cutover (after the turn finishes)

Never switches mid-stream. Watches session file activity + `claude` processes; when settled (~4s quiet):

| `failover.panelCutover` | Behavior |
|-------------------------|----------|
| **`notify`** (default) | After idle, offer Switch (or toast while deferred during a turn) |
| **`idleReload`** | After idle, auto-pick next **cool** account and `switchTo` (bind + window reload). 5‑min cooldown. **Not** mid-turn. |
| **`off`** | No panel cutover |

Workspace routes still **block** auto panel cutover (work folder stays on work account).  
Turn idle is inferred from **this window’s** session/project file activity (not other windows; process-alone is not “busy”).

### Strategy (how to pick among many accounts)

| `failover.strategy` | Behavior |
|---------------------|----------|
| **`lowestUsage`** (default) | Among **cool** accounts, pick lowest score = max(enabled dimension %%). If all hot, pick least-bad. Optional `accountOrder` restricts the pool. |
| **`ordered`** | Walk `accountOrder` (emails or registry names); first **cool** wins; if all hot, first in list. |

```json
{
  "claudeAccounts.failover.mode": "cli",
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

| Setting | Default | Meaning |
|---------|---------|---------|
| `failover.onSession` | **true** | 5h session ≥ threshold → account is hot |
| `failover.onWeekly` | **true** | 7d all-models ≥ threshold → hot |
| `failover.onFable` | **false** | Fable ≥ threshold → **not** hot for switching (Claude Code may change models) |

Thresholds: `sessionThreshold` / `weeklyThreshold` / `fableThreshold` (default 90).

Legacy `primaryEmail` / `secondaryEmail` still seed `accountOrder` if that list is empty.

### Why CLI failover does not reload VS Code

Claude Code’s **panel** reads `CLAUDE_CONFIG_DIR` at startup. Changing env mid-session does not re-auth the panel without a window reload (which kills in-flight agent turns).

The **orchestrator** only wraps **new process** invocations of `claude` (terminal, hooks, scripts). That is intentional and safe.

## Install CLI orchestrator

```bash
cd ~/projects/claude-accounts
npm run install-orch
# open a new terminal, or:
export PATH="$HOME/bin:$PATH"
```

Also for integrated terminals, in VS Code `settings.json`:

```json
"terminal.integrated.env.linux": {
  "PATH": "${env:HOME}/bin:${env:PATH}"
}
```

Set **failover.mode** to **`cli`**, set account order / strategy, let usage refresh once (or run **Claude Accounts: Refresh Usage**). Then:

```bash
# with primary hot and secondary cool:
claude auth status --json   # bills secondary via CLAUDE_CONFIG_DIR
```

Sticky multi-call agent runs:

```bash
export CLAUDE_ORCH_STICKY=1
# subsequent claude calls keep the same account for this shell
```

Verbose failover logs: `CLAUDE_ORCH_VERBOSE=1`.

## Safety

- Never discovers `~/.claude-camwatch` / reserved sidecars; does not migrate **forgotten** dirs into `~/.claude-shared`
- Refuses Windows `/mnt/c` config paths for usage
- Resolves Linux `claude` only for `auth status`
- Does **not** refresh OAuth tokens (Claude Code owns rotation)
- **Forget** still signs out that **email** everywhere — use carefully
- Shared history is for **not losing chats**, not for consolidating identity/context across accounts

## Dev

```bash
npm run compile
npm test
npm run package
```

## Layout

```text
src/          extension (TypeScript)
scripts/      claude-orch + install-orch.sh
test/         node:test suites
```
