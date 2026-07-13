# Claude Accounts + Usage

Multi-account **Claude Code** for **Linux / WSL / Remote-SSH**, with live usage (5h / 7d / **Fable**) and optional **CLI failover** via a PATH orchestrator.

## Why

| Tool | Problem |
|------|---------|
| Parallel Accounts | Multi-account OK; no usage |
| Claudemeter | Usage OK; `extensionKind: ui` runs on **Windows** host under WSL remote → wrong binary, re-login thrash |
| This extension | **workspace** only + usage + policy for CLI failover |

Upstream credit: [Parallel Accounts](https://github.com/DercasDrol/claude-parallel-profiles) + usage patterns from [Claudemeter](https://github.com/hyperi-io/claudemeter) (both MIT). See `NOTICE`.

## Install extension (VSIX)

**From GitHub Releases (recommended):**

```bash
cd ~/projects/claude-accounts && npm run install-latest
# then: Extensions → ⋯ → Install from VSIX → the printed path
```

**From source:**

```bash
cd ~/projects/claude-accounts
npm install && npm run compile && npm run package
```

In a **WSL** VS Code window:

1. Disable **Claudemeter** and **Claude Parallel Accounts**
2. Extensions → ⋯ → **Install from VSIX**
3. Reload window

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

Hard map directory trees to an email. **Longest matching prefix wins.**

Under a match, the CLI orchestrator **always** uses that account (no failover to the other account). VS Code also auto-binds that account when you open the folder (reloads once if needed).

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
You can also **Switch Account** once in a folder — that learns a route into the policy (settings still win on the same prefix).

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
| **`idleReload`** | After idle, auto-pick next account (`strategy` / `accountOrder`) and `switchTo` (bind + window reload). **Not** mid-turn. |
| **`off`** | No panel cutover |

Workspace routes still **block** auto panel cutover (work folder stays on work account).

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

Set **failover.mode** to **`cli`**, set primary/secondary emails, let usage refresh once (or run **Claude Accounts: Refresh Usage**). Then:

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
