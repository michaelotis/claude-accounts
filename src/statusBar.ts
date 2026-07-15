import * as vscode from 'vscode';
import { AccountRegistry, readIdentity, hasCredentials } from './accounts';
import { log } from './log';
import { WindowBinding } from './binding';
import { defaultSourceDir } from './capture';
import { UsageMonitor, formatUsageBar, formatUsageTooltip, type UsageSnapshot } from './usage';

/** Marketplace / local id — hover links to the extension page when published. */
const EXTENSION_ID = 'michaelotis.claude-accounts';

const ERROR_BG = new vscode.ThemeColor('statusBarItem.errorBackground');
const WARN_BG = new vscode.ThemeColor('statusBarItem.warningBackground');

/**
 * Status bar: active account + usage (5h / 7d / Fable…) for THIS window.
 * Usage is read via OAuth API against the window's CLAUDE_CONFIG_DIR only —
 * never a Windows Claude binary.
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
    void this.usage.refresh(this.effectiveDir());
    this.refresh();
  }

  /** Show/clear the inline "updating usage…" spinner + tooltip note (Refresh Usage). */
  setRefreshing(on: boolean): void {
    this.refreshing = on;
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
      this.item.tooltip = this.card([
        `**${email}**${usage?.planLabel ? ` · ${usage.planLabel}` : ''}${
          usage?.orgName ? ` · ${usage.orgName}` : ''
        }`,
        freshness,
        formatUsageTooltip(usage ?? null),
        `This window runs this account. Other windows can run others at the same time.`,
        `Accounts saved: **${unique.length}**${
          this.binding.rememberedForFolder()
            ? ' · _auto-selected: this folder used it last time_'
            : ''
        }`,
        !isSaved
          ? '_$(circle-outline) Not saved yet — saving lets you switch back to it later._'
          : '',
        actions.join(' &nbsp;·&nbsp; '),
      ]);
      // Account item never carries usage hot/warn background
      this.item.backgroundColor = undefined;
      this.renderMetricItems(usage);
    } else if (notLoggedIn) {
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
