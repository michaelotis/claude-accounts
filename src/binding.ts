import * as vscode from 'vscode';
import * as fs from 'fs';
import { Account, hasCredentials, readIdentity } from './accounts';
import { materialize, windowWorkingDir } from './workdir';
import { ensureSharedHistory } from './sharedHistory';
import { log } from './log';
import { emailsEqual, pickStoredAccountName } from './workspaceRoutes';

/** Result of a sync activation bind attempt. */
export interface ApplyStoredResult {
  account: Account;
  /**
   * Working dir has credentials after materialize. False means empty/logout dir
   * (or store missing tokens) — callers must not treat this as a healthy bind
   * for a folder route (escalate to force bind + reload).
   */
  stocked: boolean;
}

/**
 * Per-window binding of a Claude account.
 *
 * How isolation actually works
 * ────────────────────────────
 * Claude Code resolves its data directory from `process.env.CLAUDE_CONFIG_DIR`
 * (verified against the extension bundle: it builds the child env as
 * `{ ...process.env, ...claudeCode.environmentVariables }`). Each VSCode window
 * runs in its OWN remote extension host process, so `process.env` is
 * independent per window. By setting `process.env.CLAUDE_CONFIG_DIR` here, and
 * making sure the machine-scoped `claudeCode.environmentVariables` setting does
 * NOT also define it (that setting would override us), each window can point at
 * a different account simultaneously on a single WSL host.
 *
 * The active account for a window is remembered in workspaceState so it sticks
 * across reloads of the same workspace.
 */

const ACTIVE_KEY = 'claudeProfiles.activeAccount';
/** Global map: repo/workspace folder path → last account name used there. */
const REPO_MAP_KEY = 'claudeProfiles.repoAccounts';
/** Global: the account most recently bound anywhere — the default for a new window. */
const LAST_KEY = 'claudeProfiles.lastAccount';
const ENV_VAR = 'CLAUDE_CONFIG_DIR';

export class WindowBinding {
  /** Fires whenever the active account for this window changes. */
  readonly onDidChange = new vscode.EventEmitter<void>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Absolute path of this window's first workspace folder, if any. */
  private getRepoKey(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private getRepoMap(): Record<string, string> {
    return this.context.globalState.get<Record<string, string>>(REPO_MAP_KEY, {});
  }

  /** Repo/workspace path → account name (learned when the user switches in a folder). */
  getRepoAccountMap(): Record<string, string> {
    return { ...this.getRepoMap() };
  }

  /**
   * The account name remembered for this window: the per-workspace value first,
   * then the global repo→account map (so reopening a repo restores its account
   * even on a fresh window). Undefined if never chosen.
   */
  getActiveName(): string | undefined {
    const fromWorkspace = this.context.workspaceState.get<string>(ACTIVE_KEY);
    if (fromWorkspace) return fromWorkspace;
    const repo = this.getRepoKey();
    return repo ? this.getRepoMap()[repo] : undefined;
  }

  /**
   * The account a window falls back to when it has never chosen one: whichever was
   * bound last, anywhere.
   *
   * Not a convenience — a correctness requirement. A window that activates with NO
   * account leaves CLAUDE_CONFIG_DIR unset, so Claude Code reads the default dir
   * and caches it; the moment we then adopt an account, the window has to RELOAD to
   * make Claude Code look again. Without this fallback that reload would fire on
   * every newly opened project. Binding before Claude Code ever reads the variable
   * is what makes the reload unnecessary — the same race the whole extension is
   * built around.
   */
  private getLastName(): string | undefined {
    return this.context.globalState.get<string>(LAST_KEY);
  }

  /**
   * Forgets an account everywhere this binding could restore it from —
   * workspaceState, the repo→account map (all repos), and process.env if this
   * window currently points at it. Without the env release, a forgotten (and
   * possibly deleted-from-disk) dir would silently stay in use until reload.
   */
  async forget(account: Account): Promise<void> {
    // A window is bound to an account by NAME (its dir is the window's own working
    // copy, not the account's), so that — not a path comparison — is what says
    // whether this window was the one running it.
    const wasActive = this.context.workspaceState.get<string>(ACTIVE_KEY) === account.name;
    if (wasActive) {
      await this.context.workspaceState.update(ACTIVE_KEY, undefined);
      delete process.env[ENV_VAR];
      this.applyTerminalEnv(undefined);
    }
    const map = this.getRepoMap();
    const filtered = Object.fromEntries(
      Object.entries(map).filter(([, v]) => v !== account.name)
    );
    if (Object.keys(filtered).length !== Object.keys(map).length) {
      await this.context.globalState.update(REPO_MAP_KEY, filtered);
    }
    // And out of the "last used anywhere" default, or the next new window would
    // adopt the very account the user just signed out of.
    if (this.getLastName() === account.name) {
      await this.context.globalState.update(LAST_KEY, undefined);
    }
    this.onDidChange.fire();
  }

  /**
   * Releases this window's binding entirely — for when the bound account no
   * longer exists (it was forgotten, possibly while this window was closed).
   *
   * The stale name must be scrubbed from EVERY place getActiveName() can
   * restore it from — workspaceState AND this repo's entry in the repo map —
   * because both survive a window reload. v1.2.1 reloaded without doing this,
   * and the "account is gone" branch re-fired on the same stale name after
   * every reload: an infinite reload loop.
   */
  async release(): Promise<void> {
    await this.context.workspaceState.update(ACTIVE_KEY, undefined);
    const repo = this.getRepoKey();
    if (repo) {
      const map = { ...this.getRepoMap() };
      if (map[repo] !== undefined) {
        delete map[repo];
        await this.context.globalState.update(REPO_MAP_KEY, map);
      }
    }
    delete process.env[ENV_VAR];
    this.applyTerminalEnv(undefined);
    this.onDidChange.fire();
  }

  /**
   * True when the active account came from the repo→account memory rather
   * than an explicit choice in this window — surfaced in the status bar so an
   * auto-selected account doesn't look like a mystery.
   */
  rememberedForFolder(): boolean {
    if (this.context.workspaceState.get<string>(ACTIVE_KEY)) return false;
    const repo = this.getRepoKey();
    return Boolean(repo && this.getRepoMap()[repo]);
  }

  /** The CLAUDE_CONFIG_DIR currently in this host's process env, if any. */
  getEnvDir(): string | undefined {
    return process.env[ENV_VAR];
  }

  /**
   * Points this window's TERMINALS at the same account as its Claude Code.
   *
   * Terminals are not children of the extension host — VSCode spawns them from
   * its own pty host — so our runtime `process.env` mutation never reaches them.
   * Without this, `claude` run in an integrated terminal silently falls back to
   * the DEFAULT account, no matter which account the window is pinned to: you
   * think you're working as one account and the terminal bills another.
   * `environmentVariableCollection` is the official channel for an extension to
   * contribute env vars to the terminals of its OWN window, so each window's
   * terminals follow that window's account.
   *
   * Not to be confused with the `terminal.integrated.env.*` SETTING, which
   * clearMachineOverride() strips: that one is machine-wide and would force
   * every window onto a single account.
   *
   * Terminals already open keep the old value until restarted — VSCode flags
   * them with its own "terminal needs to be restarted" indicator.
   *
   * External terminals (a plain WSL shell, Windows Terminal, ssh) are NOT
   * children of VSCode at all and cannot be reached by any extension API; they
   * keep using the default account.
   */
  private applyTerminalEnv(dir: string | undefined): void {
    const collection = this.context.environmentVariableCollection;
    collection.description = 'Claude account for this window';
    if (dir) collection.replace(ENV_VAR, dir);
    else collection.delete(ENV_VAR);
  }

  /**
   * Binds this window to the given account: sets process.env so any `claude`
   * process spawned afterwards (e.g. a new conversation) uses this account's
   * data dir, and remembers the choice in workspaceState.
   *
   * Does NOT affect an already-running Claude session — the caller decides
   * whether to start a new conversation or reload the window.
   */
  /** This window's own CLAUDE_CONFIG_DIR — never shared with another window. */
  workingDir(): string {
    return windowWorkingDir(this.context);
  }

  async bind(account: Account): Promise<void> {
    // The window runs a COPY of the account, in a dir only it uses. Pointing two
    // windows at an account's own dir is what let a sign-in in one of them wipe
    // the other's account — see workdir.ts.
    // force: an explicit bind (switch, or saving a just-signed-in account) must
    // stock the dir even when it's empty — unlike the restore at activation, where
    // an empty dir means the user logged out and refilling it would undo that.
    const dir = this.workingDir();
    materialize(account, dir, true);
    // A working dir born MID-SESSION (a bind between activations, e.g. a manual
    // save in an unbound window) must see the shared history IMMEDIATELY:
    // `claude` processes spawned from now on use this dir, and without the links
    // they'd write history into real directories invisible to every other
    // account — and fail to resume/fork any conversation recorded before the
    // bind ("Session … not found", the v1.2.0/1.2.1 incident). The activation
    // pass only covers dirs that exist at activation; this covers the gap.
    ensureSharedHistory([dir]);
    log(`bind: ${account.name} → ${dir} (was ${process.env[ENV_VAR] ?? '(default)'})`);
    process.env[ENV_VAR] = dir;
    this.applyTerminalEnv(dir);
    await this.context.workspaceState.update(ACTIVE_KEY, account.name);
    await this.context.globalState.update(LAST_KEY, account.name);
    const repo = this.getRepoKey();
    if (repo) {
      const map = { ...this.getRepoMap(), [repo]: account.name };
      await this.context.globalState.update(REPO_MAP_KEY, map);
    }
    this.onDidChange.fire();
  }

  /**
   * Applies the remembered account to process.env at activation time —
   * synchronously, because Claude Code reads CLAUDE_CONFIG_DIR the moment IT
   * activates and we have to get there first.
   *
   * Preference order:
   *   1. `preferredName` — workspace route or learned folder→account (multi-window:
   *      work tree vs personal tree; wins over global last-used)
   *   2. This window's choice / exact repo map entry (`getActiveName`)
   *   3. Global last-used — only when this window has never had a working dir
   *
   * Stocking the working dir here doubles as the migration off the old model
   * (where a window pointed straight at the account's dir): the first activation
   * after the upgrade copies the account into the window's own dir, and from then
   * on nothing else can write to it.
   */
  applyStored(
    resolve: (name: string) => Account | undefined,
    preferredName?: string
  ): ApplyStoredResult | undefined {
    const tryResolve = (name: string | undefined): Account | undefined =>
      name ? resolve(name) : undefined;

    const dir = this.workingDir();
    const name = pickStoredAccountName({
      preferredName,
      activeName: this.getActiveName(),
      lastName: this.getLastName(),
      hasWorkingDir: fs.existsSync(dir),
    });
    // A name that no longer resolves (forgotten account) falls through to "no
    // account" — never resurrected. That is what turned a stale name into a reload
    // loop in v1.2.1.
    const account = tryResolve(name);
    if (!account) {
      // The terminal collection is persisted by VSCode across restarts, so a
      // forgotten account's dir can survive there and keep pointing terminals at
      // a signed-out account. Drop it whenever this window has no account.
      this.applyTerminalEnv(undefined);
      return undefined;
    }

    // Folder route / learned pin: force-stock empty dirs. A real /logout forgets
    // the account from the registry, so a still-resolvable preferred account is
    // not resurrecting a revoked token — it is restocking a pin (or a different
    // account than the one that emptied the dir). Non-preferred keeps the
    // empty-dir guard so voluntary logout of the active account is not undone.
    const fromPreferred = Boolean(preferredName && account.name === preferredName);
    materialize(account, dir, fromPreferred);

    const dirEmail = readIdentity(dir)?.email;
    const accountEmail = account.email ?? readIdentity(account.dir)?.email;
    const stocked =
      hasCredentials(dir) &&
      (!dirEmail || !accountEmail || emailsEqual(dirEmail, accountEmail));

    if (stocked || !fromPreferred) {
      // Always set env when stocked. For non-preferred empty logout, still point
      // at the working dir so reconcile can handleLoggedOut.
      process.env[ENV_VAR] = dir;
      this.applyTerminalEnv(dir);
    } else {
      // Preferred failed to stock — do not claim a healthy env bind.
      log(
        `applyStored: preferred ${account.name} did not stock ${dir} (empty or missing store token)`
      );
      this.applyTerminalEnv(undefined);
    }
    return { account, stocked };
  }

  /**
   * Persists which account this window/folder uses without reloading.
   * Used when activation already pointed process.env at the right dir (race with
   * Claude Code) and we only need workspaceState + the global repo map to match.
   */
  async remember(account: Account): Promise<void> {
    await this.context.workspaceState.update(ACTIVE_KEY, account.name);
    await this.context.globalState.update(LAST_KEY, account.name);
    const repo = this.getRepoKey();
    if (repo) {
      const map = { ...this.getRepoMap(), [repo]: account.name };
      await this.context.globalState.update(REPO_MAP_KEY, map);
    }
    this.onDidChange.fire();
  }

  /**
   * Ensures NO settings define CLAUDE_CONFIG_DIR, in ANY scope. Two sources
   * override our per-window process.env and make binding look like a no-op:
   *  - `claudeCode.environmentVariables` (Claude Code merges it OVER the
   *    process env when spawning `claude`) — must be purged from global,
   *    workspace and folder scopes, not just global;
   *  - `terminal.integrated.env.*` — v1.0.0 of this extension wrote
   *    CLAUDE_CONFIG_DIR there; it hijacks any `claude` run in a terminal.
   *
   * Returns true if anything was removed.
   */
  async clearMachineOverride(): Promise<boolean> {
    let cleared = false;
    const tryUpdate = async (
      cfg: vscode.WorkspaceConfiguration,
      key: string,
      value: unknown,
      target: vscode.ConfigurationTarget
    ) => {
      try {
        await cfg.update(key, value, target);
        cleared = true;
      } catch {
        /* scope unavailable (e.g. no workspace open) — nothing to clear there */
      }
    };

    const cfg = vscode.workspace.getConfiguration('claudeCode');
    const info = cfg.inspect<Array<{ name: string; value: string }>>('environmentVariables');
    const envScopes: Array<
      [Array<{ name: string; value: string }> | undefined, vscode.ConfigurationTarget]
    > = [
      [info?.globalValue, vscode.ConfigurationTarget.Global],
      [info?.workspaceValue, vscode.ConfigurationTarget.Workspace],
      [info?.workspaceFolderValue, vscode.ConfigurationTarget.WorkspaceFolder],
    ];
    for (const [value, target] of envScopes) {
      if (!value) continue;
      const filtered = value.filter((e) => e.name !== ENV_VAR);
      if (filtered.length === value.length) continue;
      await tryUpdate(cfg, 'environmentVariables', filtered.length ? filtered : undefined, target);
    }

    const term = vscode.workspace.getConfiguration('terminal.integrated');
    for (const key of ['env.linux', 'env.osx', 'env.windows']) {
      const tinfo = term.inspect<Record<string, string>>(key);
      const termScopes: Array<[Record<string, string> | undefined, vscode.ConfigurationTarget]> = [
        [tinfo?.globalValue, vscode.ConfigurationTarget.Global],
        [tinfo?.workspaceValue, vscode.ConfigurationTarget.Workspace],
        [tinfo?.workspaceFolderValue, vscode.ConfigurationTarget.WorkspaceFolder],
      ];
      for (const [value, target] of termScopes) {
        if (!value || !(ENV_VAR in value)) continue;
        const rest = { ...value };
        delete rest[ENV_VAR];
        await tryUpdate(term, key, Object.keys(rest).length ? rest : undefined, target);
      }
    }
    return cleared;
  }
}
