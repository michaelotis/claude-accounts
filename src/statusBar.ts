import * as vscode from 'vscode';
import { AccountRegistry, readIdentity, hasCredentials } from './accounts';
import { log } from './log';
import { WindowBinding } from './binding';
import { defaultSourceDir } from './capture';
import {
  UsageMonitor,
  formatUsageBar,
  formatAccountsTable,
  type AccountUsageRow,
  type UsageSnapshot,
} from './usage';

/** Marketplace / local id — hover links to the extension page when published. */
const EXTENSION_ID = 'michaelotis.claude-accounts';

const ERROR_BG = new vscode.ThemeColor('statusBarItem.errorBackground');
const WARN_BG = new vscode.ThemeColor('statusBarItem.warningBackground');
/** Tooltip rows older than this get a "(stale)" hint (2× the background tier). */
const STALE_ROW_MS = 10 * 60_000;

/** Compact "12s" / "3m" / "1h 05m" age for the tooltip's Refreshed line. */
function formatAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

/**
 * Status bar: active account + usage (5h / 7d / Fable…) for THIS window, plus an
 * all-accounts table in the tooltip. Usage comes from the machine-wide shared
 * cache (one coordinated fetch per account, any window) — never a Windows
 * Claude binary.
 *
 * Account name is one item; each usage metric is its own item so only the
 * over-threshold number gets a warning/error background (VS Code cannot
 * color substrings within a single StatusBarItem).
 */
export class StatusBarManager implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly sessionItem: vscode.StatusBarItem;
  private readonly weeklyItem: vscode.StatusBarItem;
  private readonly fableItem: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  /** True while a user-initiated Refresh Usage is fetching (spinner + tooltip note). */
  private refreshing = false;
  /** Set when this window's stale token was quietly restocked; cleared by reload. */
  private staleTokenNote = false;

  constructor(
    private readonly registry: AccountRegistry,
    private readonly binding: WindowBinding,
    private readonly usage: UsageMonitor
  ) {
    this.item = vscode.window.createStatusBarItem(
      'claudeAccounts.status',
      vscode.StatusBarAlignment.Right,
      90
    );
    this.item.command = 'claudeProfiles.showStatus';
    this.item.name = 'Claude Account + Usage';

    this.sessionItem = vscode.window.createStatusBarItem(
      'claudeAccounts.usage.session',
      vscode.StatusBarAlignment.Right,
      89
    );
    this.sessionItem.command = 'claudeProfiles.showStatus';
    this.sessionItem.name = 'Claude 5h session usage';

    this.weeklyItem = vscode.window.createStatusBarItem(
      'claudeAccounts.usage.weekly',
      vscode.StatusBarAlignment.Right,
      88
    );
    this.weeklyItem.command = 'claudeProfiles.showStatus';
    this.weeklyItem.name = 'Claude 7d weekly usage';

    this.fableItem = vscode.window.createStatusBarItem(
      'claudeAccounts.usage.fable',
      vscode.StatusBarAlignment.Right,
      87
    );
    this.fableItem.command = 'claudeProfiles.showStatus';
    this.fableItem.name = 'Claude Fable usage';

    this.disposables.push(
      this.binding.onDidChange.event(() => {
        this.usage.setActiveDir(this.effectiveDir());
        void this.usage.refresh(this.effectiveDir());
        this.refresh();
      }),
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused) this.refresh();
      }),
      this.usage.onChange(() => this.render())
    );
  }

  initialize(): void {
    this.item.show();
    this.usage.setActiveDir(this.effectiveDir());
    this.usage.start(() => this.effectiveDir());
    this.refresh();
  }

  reconfirm(): void {
    // Repaint only. Focus/reconcile used to force a usage refresh here, which
    // multiplied fetch attempts across windows; the central poll + cache watcher
    // own data freshness now, and a repaint reads the shared result.
    this.refresh();
  }

  /** Show/clear the inline "updating usage…" spinner + tooltip note (Refresh Usage). */
  setRefreshing(on: boolean): void {
    this.refreshing = on;
    this.render();
  }

  /**
   * Inline note: another window rotated this account's token and reconcile
   * restocked this window's copy. The running Claude Code may hold the old grant
   * in memory until restart, so tell the user what to do IF it errors — in the
   * tooltip, never a toast, never an automatic reload. Cleared by window reload.
   */
  noteStaleRestock(): void {
    this.staleTokenNote = true;
    this.render();
  }

  private effectiveDir(): string {
    return this.binding.getEnvDir() ?? defaultSourceDir();
  }

  // The account shown comes from the window's own config file (readIdentity) plus
  // whether its token file exists — the fast, local signals the rest of the
  // extension already trusts. We deliberately do NOT shell out to `claude auth
  // status` here: that binary cold-starts slowly and errors intermittently, which
  // surfaced as a flickering "Confirming…" / "Could not run claude auth status"
  // tooltip. Usage (fetched from the token) is the live signal instead.
  private refresh(): void {
    this.render();
  }

  private resolve(dir: string): { email?: string; signedOut: boolean } {
    const signedOut = !hasCredentials(dir);
    return { email: signedOut ? undefined : readIdentity(dir)?.email, signedOut };
  }

  private card(sections: string[]): vscode.MarkdownString {
    const arg = (v: unknown) => encodeURIComponent(JSON.stringify(v));
    const links = [
      `[$(extensions) Extension](command:extension.open?${arg([EXTENSION_ID])} "Open the extension page")`,
      `[$(refresh) Refresh usage](command:claudeProfiles.refreshUsage "Fetch latest usage for this window")`,
      `[$(output) Log](command:claudeProfiles.showLog "Show what this extension has been doing")`,
    ].join(' &nbsp;·&nbsp; ');

    const body = sections.filter(Boolean).join('\n\n');
    const md = new vscode.MarkdownString(
      `$(account) **Claude Accounts + Usage**\n\n${body}\n\n---\n\n${links}`
    );
    md.isTrusted = true;
    md.supportThemeIcons = true;
    return md;
  }

  private usageFor(dir: string): UsageSnapshot | null | undefined {
    return this.usage.getCached(dir);
  }

  /** Background for one metric from its own percent only. */
  private metricBackground(percent: number, warnAt: number): vscode.ThemeColor | undefined {
    if (percent >= 80) return ERROR_BG;
    if (percent >= warnAt) return WARN_BG;
    return undefined;
  }

  private hideMetricItems(): void {
    this.sessionItem.hide();
    this.weeklyItem.hide();
    this.fableItem.hide();
  }

  private renderMetricItems(usage: UsageSnapshot | null | undefined): void {
    if (!usage) {
      this.hideMetricItems();
      return;
    }

    // Hovering any pill shows the same card as the account item (usage detail + actions).
    this.sessionItem.tooltip = this.item.tooltip;
    this.weeklyItem.tooltip = this.item.tooltip;
    this.fableItem.tooltip = this.item.tooltip;

    this.sessionItem.text = `5h ${usage.sessionPercent}%`;
    this.sessionItem.backgroundColor = this.metricBackground(usage.sessionPercent, 65);
    this.sessionItem.show();

    this.weeklyItem.text = `7d ${usage.weeklyPercent}%`;
    this.weeklyItem.backgroundColor = this.metricBackground(usage.weeklyPercent, 70);
    this.weeklyItem.show();

    const fable = usage.modelLimits.find((m) => /fable/i.test(m.name));
    if (fable) {
      this.fableItem.text = `Fable ${fable.percent}%`;
      this.fableItem.backgroundColor = this.metricBackground(fable.percent, 70);
      this.fableItem.show();
    } else {
      this.fableItem.hide();
    }
  }

  /**
   * Rows for the all-accounts tooltip table: the window's own account first,
   * then every other saved account, each with its last-known snapshot from the
   * shared cache (fed machine-wide by whichever window fetched it).
   */
  private accountRows(activeEmail: string): AccountUsageRow[] {
    const byEmail = this.usage.getAllCachedByEmail();
    const activeLower = activeEmail.toLowerCase();
    const rows: AccountUsageRow[] = [];
    const seen = new Set<string>();
    const push = (emailLower: string, label: string, active: boolean) => {
      if (!emailLower || seen.has(emailLower)) return;
      seen.add(emailLower);
      const snap = byEmail.get(emailLower) ?? null;
      const stale = Boolean(snap && snap.fetchedAt && Date.now() - snap.fetchedAt > STALE_ROW_MS);
      rows.push({ label, active, snap, stale });
    };
    const activeAccount = this.registry.savedForEmail(activeEmail);
    push(activeLower, activeAccount?.name ?? activeEmail.split('@')[0], true);
    const others = this.registry
      .listUniqueByEmail()
      .map((a) => ({ a, email: (this.registry.emailOf(a) || '').toLowerCase() }))
      .filter((x) => x.email && x.email !== activeLower)
      .sort((x, y) => x.a.name.localeCompare(y.a.name));
    for (const { a, email } of others) push(email, a.name, false);
    return rows;
  }

  private render(): void {
    const dir = this.effectiveDir();
    const active = this.binding.getActiveName();
    const savedName = this.registry.getByDir(dir)?.name;

    const { email, signedOut } = this.resolve(dir);
    const notLoggedIn = signedOut;
    const usage = this.usageFor(dir);

    if (email) {
      const savedByEmail = email ? this.registry.savedForEmail(email) : undefined;
      const isSaved = Boolean(savedName || active || savedByEmail);
      // Account pill only — usage meters are separate items (per-metric color)
      const main = `$(account) ${email.split('@')[0]}${isSaved ? '' : ' $(circle-outline)'}${
        this.refreshing ? ' $(sync~spin)' : ''
      }`;
      this.item.text = main.length > 80 ? main.slice(0, 77) + '…' : main;

      const unique = this.registry.listUniqueByEmail();
      const hasOthers = unique.some((a) => this.registry.emailOf(a) !== email);
      const actions = [
        !isSaved
          ? '[$(save) Save this account](command:claudeProfiles.captureAccount "Save it so you can switch back to it later")'
          : '',
        hasOthers
          ? '[$(arrow-swap) Switch account](command:claudeProfiles.switchAccount "Pick another account for this window")'
          : '',
        unique.length > 0
          ? '[$(trash) Forget…](command:claudeProfiles.removeProfile "Sign the account out and remove it from the list")'
          : '',
      ].filter(Boolean);

      const freshness = this.refreshing
        ? '⟳ _Updating usage…_'
        : this.usage.isRateLimited(dir)
          ? '⚠ _Usage API is rate-limiting — showing the last known figures; retrying shortly._'
          : '';
      const staleNote = this.staleTokenNote
        ? '$(info) _Your sign-in was refreshed in another window and this window picked up the ' +
          'new token. If Claude Code still reports an auth error, reload this window once._'
        : '';
      const refreshedLine =
        usage && usage.fetchedAt
          ? `_Refreshed ${formatAgo(Date.now() - usage.fetchedAt)} ago_`
          : '';
      this.item.tooltip = this.card([
        `**${email}**${usage?.planLabel ? ` · ${usage.planLabel}` : ''}${
          usage?.orgName ? ` · ${usage.orgName}` : ''
        }`,
        freshness,
        staleNote,
        formatAccountsTable(this.accountRows(email)),
        refreshedLine,
        this.binding.rememberedForFolder() ? '_auto-selected: this folder used it last time_' : '',
        !isSaved
          ? '_$(circle-outline) Not saved yet — saving lets you switch back to it later._'
          : '',
        actions.join(' &nbsp;·&nbsp; '),
      ]);
      // Account item never carries usage hot/warn background
      this.item.backgroundColor = undefined;
      this.renderMetricItems(usage);
    } else if (notLoggedIn) {
      // A logout ends the "your token was restocked earlier" storyline — without
      // this, a later re-login would resurrect a note about a grant that no longer
      // exists.
      this.staleTokenNote = false;
      const wasEmail = readIdentity(dir)?.email;
      this.item.text = '$(account) Claude: sign in';
      this.item.tooltip = this.card([
        `**Not signed in**`,
        wasEmail
          ? `This window last ran **${wasEmail}**, but that account is signed out here — a \`/logout\`, ` +
            `or it was forgotten. Claude Code may keep showing it until the window reloads.`
          : `No Claude account is signed in for this window.`,
        `Sign in with Claude Code (Account menu → Login, or \`/login\` in a chat) and the account is ` +
          `saved here automatically — no extra step.`,
        `_If you ARE signed in, check that the Linux \`claude\` CLI is on your PATH (not a /mnt/c Windows binary)._`,
        this.registry.listUniqueByEmail().length > 0
          ? '[$(arrow-swap) Switch account](command:claudeProfiles.switchAccount "Use one of your saved accounts in this window")'
          : '',
      ]);
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.hideMetricItems();
    } else {
      this.item.text = '$(account) Claude $(sync~spin)';
      this.item.tooltip = this.card(['Reading the Claude account this window is signed in as…']);
      this.item.backgroundColor = undefined;
      this.hideMetricItems();
    }
  }

  async onClick(): Promise<void> {
    const dir = this.effectiveDir();
    const { email } = this.resolve(dir);
    const savedByEmail = email ? this.registry.savedForEmail(email) : undefined;
    const others = this.registry
      .listUniqueByEmail()
      .filter((a) => this.registry.emailOf(a) !== email);
    log(
      `onClick: dir=${dir} email=${email ?? '(none)'} saved=${savedByEmail?.name ?? '(no)'} others=${others.length}`
    );

    if (!email) {
      if (this.registry.listUniqueByEmail().length > 0) {
        await vscode.commands.executeCommand('claudeProfiles.switchAccount');
        return;
      }
      vscode.window.showWarningMessage(
        'No signed-in Claude account. Sign in in the Claude Code panel (its account menu, or /login ' +
          'in the chat) — the account is saved here automatically.'
      );
      return;
    }
    if (others.length > 0) {
      await vscode.commands.executeCommand('claudeProfiles.switchAccount');
      return;
    }
    if (!savedByEmail) {
      await vscode.commands.executeCommand('claudeProfiles.captureAccount');
      return;
    }
    // Single account: show usage detail
    const u = this.usageFor(dir);
    if (u) {
      vscode.window.showInformationMessage(
        `${email}: ${formatUsageBar(u)}` +
          (u.modelLimits.length
            ? ` · models: ${u.modelLimits.map((m) => `${m.name} ${m.percent}%`).join(', ')}`
            : '')
      );
    } else {
      vscode.window.showInformationMessage(
        `${email} is your only saved account. To add another: /login as it in Claude Code. Usage will appear after refresh.`
      );
      void this.usage.refresh(dir);
    }
  }

  dispose(): void {
    this.item.dispose();
    this.sessionItem.dispose();
    this.weeklyItem.dispose();
    this.fableItem.dispose();
    this.usage.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
