import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AccountRegistry } from './accounts';
import { WindowBinding } from './binding';
import { StatusBarManager } from './statusBar';
import { SetupWizard, NOTICE_KEY } from './setupWizard';
import { ensureSharedHistory } from './sharedHistory';
import { defaultSourceDir } from './capture';
import { AccountWatcher } from './accountWatcher';
import { allWorkingDirs, workingRoot } from './workdir';
import { log, showLog } from './log';
import { UsageMonitor, writePolicyCache, type WorkspaceRoutePolicy } from './usage';
import { isSidecarConfigDir } from './sidecars';
import { matchWorkspaceRoute, mergeRoutes, type WorkspaceRoute } from './workspaceRoutes';

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
function activateUnsupported(context: vscode.ExtensionContext): void {
  const label =
    process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'native Windows' : process.platform;
  const msg =
    `Claude Accounts + Usage supports Linux only (workspace extension) — desktop Linux, WSL, Remote-SSH ` +
    `to a Linux host, or a dev container. On ${label} it stays inactive so it never attaches to a ` +
    `Windows Claude binary. No files are read or written.` +
    (process.platform === 'win32' ? ' Tip: open your folder in a WSL window and install it there.' : '');
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
  const usage = new UsageMonitor(180_000);

  const accountByEmail = (email: string) =>
    registry.list().find((a) => (registry.emailOf(a) || a.email) === email);

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

  const applyUsageSettings = () => {
    const cfg = vscode.workspace.getConfiguration('claudeAccounts');
    const mode = cfg.get<'off' | 'notify' | 'cli'>('failover.mode', 'notify');
    const routes = buildWorkspaceRoutes();
    const thresholds = {
      session: cfg.get<number>('failover.sessionThreshold', 90),
      weekly: cfg.get<number>('failover.weeklyThreshold', 90),
      fable: cfg.get<number>('failover.fableThreshold', 90),
    };
    // Which buckets trigger account failover (vs meter-only / model switch).
    // Defaults: session+weekly yes; Fable no (leave model fallback to Claude Code).
    const triggers = {
      session: cfg.get<boolean>('failover.onSession', true),
      weekly: cfg.get<boolean>('failover.onWeekly', true),
      fable: cfg.get<boolean>('failover.onFable', false),
    };
    let accountOrder = (cfg.get<string[]>('failover.accountOrder', []) || [])
      .map((s) => String(s).trim())
      .filter(Boolean);
    // Legacy primary/secondary → ordered list if accountOrder empty
    if (!accountOrder.length) {
      const primary = cfg.get<string>('failover.primaryEmail', '') || '';
      const secondary = cfg.get<string>('failover.secondaryEmail', '') || '';
      accountOrder = [primary, secondary].map((s) => s.trim()).filter(Boolean);
    }
    const strategy = cfg.get<'lowestUsage' | 'ordered'>(
      'failover.strategy',
      'lowestUsage'
    );
    const nameByEmail: Record<string, string> = {};
    for (const a of registry.list()) {
      const em = registry.emailOf(a);
      if (em) nameByEmail[em] = a.name;
    }
    usage.configure({
      mode,
      thresholds,
      triggers,
      strategy,
      accountOrder,
      workspaceRoutes: routes,
      nameByEmail,
      storeDirForEmail: (email) => accountByEmail(email)?.dir,
    });
    // Persist routes/triggers even without a fresh usage poll
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
  usage.onHot = (snap, reasons) => {
    const mode = usage.getMode();
    if (mode === 'off') return;
    const msg = `Claude usage high on ${snap.email ?? 'this account'}: ${reasons.join(', ')}`;
    if (mode === 'cli') {
      void vscode.window.showWarningMessage(
        `${msg}. CLI orchestrator will pick another account on new \`claude\` invocations (unmapped paths only; workspace pins stay put).`
      );
    } else {
      void vscode.window
        .showWarningMessage(msg, 'Switch account', 'Dismiss')
        .then((pick) => {
          if (pick === 'Switch account') {
            void vscode.commands.executeCommand('claudeProfiles.switchAccount');
          }
        });
    }
  };

  const statusBar = new StatusBarManager(registry, binding, usage);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeAccounts')) applyUsageSettings();
    })
  );

  // A forgotten account no longer resolves, so a window that remembered one
  // falls back to the default dir and — via auto-save — onto whichever saved
  // account is signed in there. That's intended: the user then either picks
  // another account from the list, or signs in to a new one in Claude Code and
  // we capture it.
  const resolveAccount = (name: string) => registry.get(name);

  // Bind this window to its remembered account FIRST and synchronously, so
  // process.env.CLAUDE_CONFIG_DIR is set before Claude Code spawns `claude`
  // (both extensions activate on startup — minimise the race window).
  let bound = binding.applyStored(resolveAccount);

  // ── The critical fix ───────────────────────────────────────────────────────
  // The machine-scoped `claudeCode.environmentVariables` setting is shared by
  // every window on this host; if it defines CLAUDE_CONFIG_DIR it overrides our
  // per-window process.env and forces all windows onto one account. Clear it so
  // isolation flows through process.env instead.
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

  // Pick up any accounts already logged in on disk, then retry binding in case
  // the remembered account was only discovered just now.
  await registry.discoverAndMerge();
  if (!bound) bound = binding.applyStored(resolveAccount);

  // Workspace path pins: if this folder is mapped to an email, bind that account
  // (work tree → work Claude, personal tree → personal). Uses switchTo so the
  // panel reloads onto the correct token when the route disagrees with last-used.
  const folderPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (folderPath) {
    const route = matchWorkspaceRoute(folderPath, buildWorkspaceRoutes());
    if (route) {
      const acc = accountByEmail(route.email);
      if (acc) {
        const currentEmail = bound ? registry.emailOf(bound) : undefined;
        if (currentEmail !== route.email) {
          log(`workspace route: ${folderPath} → ${route.email} (${acc.name})`);
          // switchTo binds + reloads (Claude Code only reads config at startup)
          await wizard.switchTo(acc);
          return; // activation continues after reload
        }
      } else {
        log(`workspace route ${route.email} has no saved account yet — sign in as it once`);
        void vscode.window.showWarningMessage(
          `Claude Accounts: this folder is mapped to ${route.email}, but that account is not saved yet. ` +
            `Sign in with /login as that email once, then reopen the folder.`
        );
      }
    }
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
  // migrated into ~/.claude-shared (that rewired Scrypted CamWatch when it
  // lived under ~/.claude-camwatch). History already in the shared store stays;
  // forgotten dirs simply keep whatever local or linked layout they already have.
  const allDirs = (): string[] =>
    [defaultSourceDir(), ...registry.list().map((a) => a.dir), ...allWorkingDirs()].filter(
      (d) => !isSidecarConfigDir(d)
    );
  const warnings = ensureSharedHistory(allDirs());
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
      const snap = await usage.refresh(dir);
      if (!snap) {
        vscode.window.showWarningMessage(
          'Could not fetch usage for this window (missing token or network). Sign in with Claude Code first.'
        );
        return;
      }
      const models = snap.modelLimits.map((m) => `${m.name} ${m.percent}%`).join(', ');
      vscode.window.showInformationMessage(
        `Usage: 5h ${snap.sessionPercent}% · 7d ${snap.weeklyPercent}%` +
          (models ? ` · ${models}` : '') +
          (snap.planLabel ? ` (${snap.planLabel})` : '')
      );
    }),
    // Only the focused window repairs a dir whose account was replaced by a
    // sign-in (it's the window the user signed in from). So a window that was
    // unfocused while that happened must reconcile when focus comes back —
    // otherwise a handoff nobody was around to finish would sit unrepaired.
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) void wizard.reconcile().finally(() => statusBar.reconfirm());
    }),
    statusBar
  );

  statusBar.initialize();

  // When this window's account state changes on disk (a /login or /logout inside
  // this window, or a forget from another one), reconcile: mirror the token into
  // its shadow copy, save a newly-seen account, and — if a sign-in landed on top
  // of the account this dir held — move the new account into a dir of its own and
  // restore the displaced one. Then repaint the bar so it never lags behind.
  const watcher = new AccountWatcher(binding, () => {
    void wizard.reconcile().finally(() => statusBar.reconfirm());
  });
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
          void vscode.commands.executeCommand('workbench.extensions.search', 'claude parallel accounts');
        }
      });
  }

  if (cleared) {
    vscode.window.showInformationMessage(
      'Claude Accounts: removed CLAUDE_CONFIG_DIR from the shared machine setting. ' +
        'Isolation now works per-window. Pick this window\'s account from the status bar.'
    );
  }

  // Bring this window in step with what's on disk: save the account it's signed
  // in as (no "Save" click), and follow a sign-in that changed which account its
  // dir holds. Runs after the synchronous env binding above, so it never delays
  // the critical activation race with Claude Code.
  await wizard.reconcile({ atActivation: true });
  // reconcile() may have just bound this window to a freshly-saved account.
  if (!bound) bound = binding.applyStored(resolveAccount);

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
      .showInformationMessage(`Claude Accounts: ${notice}`, ...(canSwitch ? ['Switch account'] : []))
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
