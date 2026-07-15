import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AccountRegistry, hasCredentials, readIdentity, type Account } from './accounts';
import { WindowBinding } from './binding';
import { StatusBarManager } from './statusBar';
import { SetupWizard, NOTICE_KEY } from './setupWizard';
import { ensureSharedHistory } from './sharedHistory';
import { defaultSourceDir } from './capture';
import { AccountWatcher } from './accountWatcher';
import { allWorkingDirs, foreignTokenConflict } from './workdir';
import { log, showLog } from './log';
import { UsageMonitor, writePolicyCache, type WorkspaceRoutePolicy } from './usage';
import { isSidecarConfigDir } from './sidecars';
import {
  emailsEqual,
  matchWorkspaceRoute,
  mergeRoutes,
  normalizeEmail,
  type WorkspaceRoute,
} from './workspaceRoutes';
import { IdleCutoverController, type PanelCutoverMode } from './cutover';
import { looksLikeLogout } from './reclaim';

/**
 * Everything this extension does rests on Linux semantics that we verified:
 * Claude Code keeping credentials as FILES (macOS uses the Keychain instead),
 * /proc for finding live sessions, symlinks for shared history, a POSIX shell
 * for the CLI. On any other OS those assumptions silently break — up to
 * destructive misbehaviour (e.g. the registry pruning every account because it
 * sees no credential files). So elsewhere the extension must not guess: it
 * activates into an INERT mode that touches nothing and says why.
 *
 * The Marketplace additionally publishes Linux-only packages, so this mode is
 * normally reached only by a side-loaded VSIX. The check runs where the
 * extension actually executes — in a WSL/SSH/container window that's the
 * REMOTE side (extensionKind "workspace"), so a Windows desktop driving a
 * Linux remote is fully supported and never lands here.
 */
/** True if a store's own `.credentials.json` holds a grant that belongs to a different account. */
function storeTokenIsForeign(storeDir: string, email: string | undefined): boolean {
  try {
    const buf = fs.readFileSync(path.join(storeDir, '.credentials.json'));
    return Boolean(foreignTokenConflict(storeDir, buf, email));
  } catch {
    return false;
  }
}

function activateUnsupported(context: vscode.ExtensionContext): void {
  const label =
    process.platform === 'darwin'
      ? 'macOS'
      : process.platform === 'win32'
        ? 'native Windows'
        : process.platform;
  const msg =
    `Claude Accounts + Usage supports Linux only (workspace extension) — desktop Linux, WSL, Remote-SSH ` +
    `to a Linux host, or a dev container. On ${label} it stays inactive so it never attaches to a ` +
    `Windows Claude binary. No files are read or written.` +
    (process.platform === 'win32'
      ? ' Tip: open your folder in a WSL window and install it there.'
      : '');
  log(`platform ${process.platform} is unsupported — inert mode, nothing will be touched`);

  const item = vscode.window.createStatusBarItem(
    'claudeProfiles.status',
    vscode.StatusBarAlignment.Right,
    90
  );
  item.name = 'Claude Account + Usage';
  item.text = '$(account) Claude: unsupported OS';
  const tooltip = new vscode.MarkdownString(`$(account) **Claude Accounts + Usage**\n\n${msg}`);
  tooltip.supportThemeIcons = true;
  item.tooltip = tooltip;
  item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  item.command = 'claudeProfiles.showStatus';
  item.show();

  // The commands stay registered so palette entries and keybindings don't die
  // with a cryptic "command not found" — they all explain the same thing.
  const explain = () => void vscode.window.showInformationMessage(msg);
  context.subscriptions.push(
    item,
    vscode.commands.registerCommand('claudeProfiles.switchAccount', explain),
    vscode.commands.registerCommand('claudeProfiles.captureAccount', explain),
    vscode.commands.registerCommand('claudeProfiles.removeProfile', explain),
    vscode.commands.registerCommand('claudeProfiles.showStatus', explain),
    vscode.commands.registerCommand('claudeProfiles.refreshUsage', explain),
    vscode.commands.registerCommand('claudeProfiles.showLog', () => showLog())
  );
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  if (process.platform !== 'linux') {
    activateUnsupported(context);
    return;
  }

  const registry = new AccountRegistry(context);
  const binding = new WindowBinding(context);
  const wizard = new SetupWizard(registry, binding, context);
  // 1 min poll — matches the (disk-shared, cross-window-deduped) usage cache TTL,
  // so the meter stays responsive without extra API pressure. A real 429 backs off.
  const usage = new UsageMonitor(60_000);

  const accountByEmail = (email: string) => {
    const want = normalizeEmail(email);
    if (!want) return undefined;
    return registry.list().find((a) => normalizeEmail(registry.emailOf(a) || a.email) === want);
  };

  /** Settings routes + learned folder→account map (from prior Switch Account). */
  const buildWorkspaceRoutes = (): WorkspaceRoutePolicy[] => {
    const cfg = vscode.workspace.getConfiguration('claudeAccounts');
    const settingsRoutes = (cfg.get<WorkspaceRoute[]>('workspaceRoutes', []) || []).filter(
      (r) => r?.pathPrefix && r?.email
    );
    const learned: WorkspaceRoute[] = [];
    const repoMap = binding.getRepoAccountMap();
    for (const [folder, accountName] of Object.entries(repoMap)) {
      const acc = registry.get(accountName);
      const email = acc ? registry.emailOf(acc) : undefined;
      if (email) learned.push({ pathPrefix: folder, email });
    }
    return mergeRoutes(settingsRoutes, learned);
  };

  /** Shared accountOrder merge (settings + legacy primary/secondary). */
  const resolveAccountOrder = (): string[] => {
    const cfg = vscode.workspace.getConfiguration('claudeAccounts');
    let accountOrder = (cfg.get<string[]>('failover.accountOrder', []) || [])
      .map((s) => String(s).trim())
      .filter(Boolean);
    if (!accountOrder.length) {
      const primary = cfg.get<string>('failover.primaryEmail', '') || '';
      const secondary = cfg.get<string>('failover.secondaryEmail', '') || '';
      accountOrder = [primary, secondary].map((s) => s.trim()).filter(Boolean);
    }
    return accountOrder;
  };

  const applyUsageSettings = () => {
    const cfg = vscode.workspace.getConfiguration('claudeAccounts');
    const mode = cfg.get<'off' | 'notify'>('failover.mode', 'notify');
    const panelMode = cfg.get<PanelCutoverMode>('failover.panelCutover', 'notify');
    const routes = buildWorkspaceRoutes();
    const thresholds = {
      session: cfg.get<number>('failover.sessionThreshold', 90),
      weekly: cfg.get<number>('failover.weeklyThreshold', 90),
      fable: cfg.get<number>('failover.fableThreshold', 90),
    };
    const triggers = {
      session: cfg.get<boolean>('failover.onSession', true),
      weekly: cfg.get<boolean>('failover.onWeekly', true),
      fable: cfg.get<boolean>('failover.onFable', false),
    };
    const accountOrder = resolveAccountOrder();
    const strategy = cfg.get<'lowestUsage' | 'ordered'>('failover.strategy', 'lowestUsage');
    const nameByEmail: Record<string, string> = {};
    for (const a of registry.list()) {
      const em = registry.emailOf(a);
      if (em) nameByEmail[em] = a.name;
    }
    usage.listAccountsToPoll = () =>
      registry
        .listUniqueByEmail()
        .map((a) => {
          const email = registry.emailOf(a);
          if (!email || !a.dir) return null;
          return { email, dir: a.dir, name: a.name };
        })
        .filter((x): x is { email: string; dir: string; name: string } => Boolean(x));
    usage.configure({
      mode,
      thresholds,
      triggers,
      strategy,
      accountOrder,
      workspaceRoutes: routes,
      nameByEmail,
      storeDirForEmail: (email) => accountByEmail(email)?.dir,
      // Only auto-cutover (idleReload) reads other accounts' usage; in meter-only
      // mode each window polls just its own account (no cross-account 429 pressure).
      pollAllAccounts: panelMode === 'idleReload',
    });
    writePolicyCache({
      mode,
      thresholds,
      triggers,
      strategy,
      accountOrder,
      workspaceRoutes: routes,
      nameByEmail,
      snapshots: [],
    });
  };
  applyUsageSettings();

  const cutover = new IdleCutoverController(
    context,
    registry,
    binding,
    wizard,
    () => binding.getEnvDir() ?? defaultSourceDir()
  );
  const syncCutover = () => {
    const cfg = vscode.workspace.getConfiguration('claudeAccounts');
    cutover.configure({
      panelMode: cfg.get<PanelCutoverMode>('failover.panelCutover', 'notify'),
      thresholds: {
        session: cfg.get<number>('failover.sessionThreshold', 90),
        weekly: cfg.get<number>('failover.weeklyThreshold', 90),
        fable: cfg.get<number>('failover.fableThreshold', 90),
      },
      triggers: {
        session: cfg.get<boolean>('failover.onSession', true),
        weekly: cfg.get<boolean>('failover.onWeekly', true),
        fable: cfg.get<boolean>('failover.onFable', false),
      },
      strategy: cfg.get<'lowestUsage' | 'ordered'>('failover.strategy', 'lowestUsage'),
      accountOrder: resolveAccountOrder(),
      workspaceRoutes: buildWorkspaceRoutes(),
    });
  };
  syncCutover();
  cutover.start();

  // Panel cutover always gets pressure (even if failover.mode is off)
  usage.onPressure = (snap, reasons) => {
    cutover.notePressure(snap, reasons);
  };

  // Usage pressure is surfaced by the status-bar meter (each metric colours itself
  // as it crosses its threshold), not by popups. Switching always needs a reload,
  // so a "usage high — switch?" toast is just noise on top of the meter; the user
  // sees the colour and switches when they choose. The cutover controller still
  // receives pressure via onPressure (for the opt-in idle auto-switch).
  usage.onHot = (snap, reasons) => {
    log(`usage hot on ${snap.email ?? 'this account'}: ${reasons.join(', ')} (shown on the meter)`);
  };

  const statusBar = new StatusBarManager(registry, binding, usage);
  context.subscriptions.push(
    { dispose: () => cutover.dispose() },
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeAccounts')) {
        applyUsageSettings();
        syncCutover();
      }
    })
  );

  // A forgotten account no longer resolves, so a window that remembered one
  // falls back to the default dir and — via auto-save — onto whichever saved
  // account is signed in there. That's intended: the user then either picks
  // another account from the list, or signs in to a new one in Claude Code and
  // we capture it.
  const resolveAccount = (name: string) => registry.get(name);

  /**
   * Account for this window's folder: settings workspaceRoutes + learned
   * Switch-Account map (longest prefix). Multi-window: open work tree in one
   * VS Code window and personal in another — each host binds its own account.
   */
  const resolveFolderPreferred = ():
    | { account: Account; email: string; folderPath: string }
    | { account: undefined; email: string; folderPath: string }
    | undefined => {
    const folderPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folderPath) return undefined;
    const route = matchWorkspaceRoute(folderPath, buildWorkspaceRoutes());
    if (!route) return undefined;
    const acc = accountByEmail(route.email);
    if (acc) return { account: acc, email: route.email, folderPath };
    return { account: undefined, email: route.email, folderPath };
  };

  // Bind FIRST and synchronously so process.env.CLAUDE_CONFIG_DIR is set before
  // Claude Code spawns `claude`. Prefer the folder route over global last-used
  // so two windows (work + personal) each start on the right account without a
  // wrong-bind-then-reload dance.
  const preferredAtStart = resolveFolderPreferred();
  const preferredName = preferredAtStart?.account?.name;
  if (preferredAtStart?.account) {
    log(
      `workspace auto-select: ${preferredAtStart.folderPath} → ${preferredAtStart.email} (${preferredName})`
    );
  } else if (preferredAtStart && !preferredAtStart.account) {
    log(`workspace route ${preferredAtStart.email} has no saved account yet — sign in as it once`);
  }
  const appliedStart = binding.applyStored(resolveAccount, preferredName);
  // Healthy bind only when the working dir is stocked. Preferred + unstocked is
  // escalated after override clear (force bind + metered reload).
  let bound = appliedStart?.stocked
    ? appliedStart.account
    : preferredName
      ? undefined
      : appliedStart?.account;

  // ── The critical fix ───────────────────────────────────────────────────────
  // The machine-scoped `claudeCode.environmentVariables` setting is shared by
  // every window on this host; if it defines CLAUDE_CONFIG_DIR it overrides our
  // per-window process.env and forces all windows onto one account. Clear it so
  // isolation flows through process.env instead. Do this BEFORE remember() so
  // state I/O does not widen the window where the machine override still wins.
  const cleared = await binding.clearMachineOverride();

  // A short-lived earlier design kept a "shadow vault" of credential copies. The
  // per-window working dirs made it unnecessary — an account's store IS the spare
  // copy now — but it held real tokens, so leave none behind.
  try {
    const vault = path.join(os.homedir(), '.claude-vault');
    if (fs.existsSync(vault)) {
      fs.rmSync(vault, { recursive: true, force: true });
      log('removed the obsolete credential vault');
    }
  } catch (err) {
    log(`could not remove the obsolete vault: ${(err as Error).message}`);
  }

  // Pick up any accounts already logged in on disk, then re-resolve the folder
  // route (discovery may have added the mapped email) and bind again if needed.
  await registry.discoverAndMerge();
  const preferredAfter = resolveFolderPreferred();
  if (preferredAfter?.account) {
    const workDir = binding.workingDir();
    const dirEmail = hasCredentials(workDir) ? readIdentity(workDir)?.email : undefined;
    const routeOk = emailsEqual(dirEmail, preferredAfter.email);
    if (!routeOk && looksLikeLogout(workDir)) {
      // The pinned account was logged out in this window. Do NOT restock it —
      // refilling from the store would resurrect a token the server revoked.
      // Leave the dir empty; reconcile (at activation, below) concludes the
      // logout, forgets the account, and prompts a fresh sign-in.
      log(
        `workspace route ${preferredAfter.folderPath}: pinned ${preferredAfter.email} was logged out here — not restocking`
      );
    } else if (!routeOk && storeTokenIsForeign(preferredAfter.account.dir, preferredAfter.email)) {
      // The pinned account's own store holds a token that belongs to a DIFFERENT
      // account (the credential-mix state). Forcing a switch would just restock the
      // wrong token and reload — surface the real fix instead and let the window
      // come up; reconcile shows the same guidance and the user signs in again.
      log(
        `workspace route ${preferredAfter.folderPath}: pinned ${preferredAfter.email} store is ` +
          `contaminated (token belongs to another account) — not force-switching; prompting re-login`
      );
      void vscode.window.showWarningMessage(
        `Claude Accounts: ${preferredAfter.email}'s saved credentials were overwritten by another ` +
          `account. Sign in again as ${preferredAfter.email} (Claude Code /login) to restore it.`
      );
    } else if (!routeOk) {
      // Dir not stocked with the pin (empty first stock, late discovery, or
      // wrong account). Force bind + reload; metered so a bug cannot loop.
      log(
        `workspace route reload: ${preferredAfter.folderPath} → ${preferredAfter.email} (${preferredAfter.account.name}) ` +
          `dirEmail=${dirEmail ?? '(none)'}`
      );
      await wizard.switchTo(preferredAfter.account, {
        userInitiated: false,
        notice: `This folder is pinned to ${preferredAfter.email}.`,
      });
      return; // activation continues after reload
    } else {
      // Dir already correct — persist folder→account without reload.
      if (binding.getActiveName() !== preferredAfter.account.name) {
        await binding.remember(preferredAfter.account);
      }
      bound = preferredAfter.account;
    }
  } else if (preferredAfter && !preferredAfter.account) {
    void vscode.window.showWarningMessage(
      `Claude Accounts: this folder is mapped to ${preferredAfter.email}, but that account is not saved yet. ` +
        `Sign in with /login as that email once, then reopen the folder.`
    );
  } else if (!bound) {
    const again = binding.applyStored(resolveAccount);
    bound = again?.stocked ? again.account : again?.account;
  }
  applyUsageSettings();

  // One history, in one store, symlinked from every dir — the same single history
  // vanilla Claude Code has. Do this BEFORE Claude Code reads the dir, otherwise
  // the first paint of the panel would show empty history.
  //
  // This is not a "share between accounts" feature, it is what keeps history from
  // being LOST: a window runs on its own working dir, which starts out empty, so
  // without the links every conversation the user ever had (they live in the
  // default ~/.claude) would simply disappear from the panel the moment this
  // extension was installed. Hence no setting to turn it off — an off switch only
  // ever meant "fragment my history across N directories", which is why it also
  // used to copy the entire store into each of them.
  //
  // Active accounts + working dirs only. Forgotten / sidecar paths are NOT
  // migrated into ~/.claude-shared. History already in the shared store stays;
  // forgotten dirs simply keep whatever local or linked layout they already have.
  const allDirs = (): string[] =>
    [defaultSourceDir(), ...registry.list().map((a) => a.dir), ...allWorkingDirs()].filter(
      (d) => !isSidecarConfigDir(d)
    );
  const warnings = await ensureSharedHistory(allDirs());
  if (warnings.length > 0) {
    vscode.window.showWarningMessage(
      `Claude Accounts: shared history migration hit ${warnings.length} issue(s); ` +
        `will retry on next reload. First: ${warnings[0]}`
    );
  }

  log(
    `activated: env=${process.env.CLAUDE_CONFIG_DIR ?? '(default)'} ` +
      `active=${binding.getActiveName() ?? '(none)'} ` +
      `accounts=${registry.list().length} forgotten=${registry.listForgotten().length} ` +
      `clearedSettingsOverride=${cleared}`
  );

  // A command that dies silently reads as "the button does nothing" — every
  // handler logs and SHOWS its errors instead. Registration itself is also
  // guarded: a duplicate copy of this extension (e.g. the same code published
  // under another publisher) registering the same command IDs used to crash
  // activation halfway and leave a dead status bar button.
  const conflicts: string[] = [];
  const cmd = (id: string, fn: () => Promise<unknown> | unknown): vscode.Disposable => {
    try {
      return vscode.commands.registerCommand(id, async () => {
        log(`command: ${id}`);
        try {
          await fn();
        } catch (err) {
          log(`ERROR in ${id}: ${(err as Error).stack ?? String(err)}`);
          const pick = await vscode.window.showErrorMessage(
            `Claude Accounts: ${(err as Error).message}`,
            'Show log'
          );
          if (pick === 'Show log') showLog();
        }
      });
    } catch (err) {
      conflicts.push(id);
      log(`FAILED to register ${id}: ${(err as Error).message}`);
      return new vscode.Disposable(() => undefined);
    }
  };

  context.subscriptions.push(
    cmd('claudeProfiles.switchAccount', () => wizard.switchAccountInteractive()),
    cmd('claudeProfiles.captureAccount', () => wizard.captureCurrentAccount()),
    cmd('claudeProfiles.removeProfile', () => wizard.removeAccountInteractive()),
    cmd('claudeProfiles.showStatus', () => statusBar.onClick()),
    cmd('claudeProfiles.showLog', () => showLog()),
    cmd('claudeProfiles.refreshUsage', async () => {
      const dir = binding.getEnvDir() ?? defaultSourceDir();
      // User-initiated: show it updating INLINE (status-bar spinner + tooltip note) and
      // repaint the meter in place via onChange — no "here's your usage" toast. Force a
      // fresh fetch, BUT if we're already in the post-429 backoff don't hammer the API
      // (that just re-stamps the window and keeps the meter stale); a non-force refresh
      // still adopts a newer cross-window cache and the tooltip shows the rate-limit note.
      const force = !usage.isRateLimited(dir);
      let hardMsg: string | undefined;
      statusBar.setRefreshing(true);
      try {
        const snap = await usage.refresh(dir, force);
        if (!snap && usage.lastFailure && usage.lastFailure.kind !== 'rate_limited') {
          hardMsg =
            usage.lastFailure.message ??
            'Could not fetch usage for this window. Sign in with Claude Code first (/login).';
        }
      } finally {
        statusBar.setRefreshing(false); // clear the spinner BEFORE any modal
      }
      // Only a hard failure that isn't a rate-limit (e.g. signed out) surfaces — it needs action.
      if (hardMsg) {
        const pick = await vscode.window.showWarningMessage(hardMsg, 'Show log');
        if (pick === 'Show log') showLog();
      }
    }),
    // Only the focused window repairs a dir whose account was replaced by a
    // sign-in (it's the window the user signed in from). So a window that was
    // unfocused while that happened must reconcile when focus comes back —
    // otherwise a handoff nobody was around to finish would sit unrepaired.
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused)
        void wizard
          .reconcile()
          .catch((e) => log(`reconcile failed: ${e instanceof Error ? e.message : String(e)}`))
          .finally(() => statusBar.reconfirm());
    }),
    statusBar
  );

  statusBar.initialize();

  // When this window's account state changes on disk (a /login or /logout inside
  // this window, or a forget from another one), reconcile: mirror the token into
  // its shadow copy, save a newly-seen account, and — if a sign-in landed on top
  // of the account this dir held — move the new account into a dir of its own and
  // restore the displaced one. Then repaint the bar so it never lags behind.
  const watcher = new AccountWatcher(binding, () =>
    // Returned (not voided) so the watcher can re-read the fingerprint after the
    // reconcile settles — the latch must reflect any in-place repair it made.
    wizard
      .reconcile()
      .catch((e) => log(`reconcile failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => statusBar.reconfirm())
  );
  watcher.start();
  context.subscriptions.push(watcher);

  if (conflicts.length > 0) {
    void vscode.window
      .showErrorMessage(
        `Claude Accounts: another extension already owns ${conflicts.length} of this extension's ` +
          `commands — most likely a duplicate copy under a different publisher ` +
          `(e.g. "tundak.claude-parallel-accounts"). Uninstall the duplicate and reload the window.`,
        'Show extensions'
      )
      .then((pick) => {
        if (pick === 'Show extensions') {
          void vscode.commands.executeCommand(
            'workbench.extensions.search',
            'claude parallel accounts'
          );
        }
      });
  }

  if (cleared) {
    vscode.window.showInformationMessage(
      'Claude Accounts: removed CLAUDE_CONFIG_DIR from the shared machine setting. ' +
        "Isolation now works per-window. Pick this window's account from the status bar."
    );
  }

  // Bring this window in step with what's on disk: save the account it's signed
  // in as (no "Save" click), and follow a sign-in that changed which account its
  // dir holds. Runs after the synchronous env binding above, so it never delays
  // the critical activation race with Claude Code.
  await wizard.reconcile({ atActivation: true });
  // reconcile() may have just bound this window to a freshly-saved account.
  if (!bound) {
    const after = binding.applyStored(resolveAccount);
    bound = after?.stocked ? after.account : after?.account;
  }

  // An account handoff finishes with a reload, which kills any toast raised
  // before it — so the news of what happened is delivered here instead.
  const notice = context.globalState.get<string>(NOTICE_KEY);
  if (notice) {
    await context.globalState.update(NOTICE_KEY, undefined);
    // A notice typically reports an account handoff. If this window came out of
    // it with NO account while saved ones exist (forget reloaded it into limbo),
    // the news must come with the way out attached, not read as a dead end.
    const canSwitch = !binding.getActiveName() && registry.listUniqueByEmail().length > 0;
    void vscode.window
      .showInformationMessage(
        `Claude Accounts: ${notice}`,
        ...(canSwitch ? ['Switch account'] : [])
      )
      .then((pick) => {
        if (pick === 'Switch account') {
          void vscode.commands.executeCommand('claudeProfiles.switchAccount');
        }
      });
  }

  // First-run guidance only when there's genuinely nothing to work with: no
  // saved accounts and this window isn't signed in anywhere (so auto-save had
  // nothing to capture). Otherwise the status bar already shows the account.
  if (!bound && registry.list().length === 0) {
    const key = 'claudeProfiles.introShown';
    if (!context.globalState.get<boolean>(key, false)) {
      await context.globalState.update(key, true);
      vscode.window.showInformationMessage(
        'Claude Accounts: no accounts detected yet. Sign in with Claude Code (Account menu → Login, ' +
          'or /login in a chat) and this window will remember the account automatically.'
      );
    }
  }
}

export function deactivate(): void {
  /* nothing to clean up */
}
