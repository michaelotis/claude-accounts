import * as vscode from 'vscode';
import { AccountRegistry, readIdentity, hasCredentials } from './accounts';
import { log } from './log';
import { WindowBinding } from './binding';
import { getAuthStatus, AuthStatus } from './cli';
import { defaultSourceDir } from './capture';
import {
  UsageMonitor,
  formatUsageBar,
  formatUsageTooltip,
  type UsageSnapshot,
} from './usage';

/** Marketplace / local id — hover links to the extension page when published. */
const EXTENSION_ID = 'michaelotis.claude-accounts';

/**
 * Status bar: active account + usage (5h / 7d / Fable…) for THIS window.
 * Usage is read via OAuth API against the window's CLAUDE_CONFIG_DIR only —
 * never a Windows Claude binary.
 */
export class StatusBarManager implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly statusCache = new Map<string, { status: AuthStatus | null; at: number }>();
  private static readonly STATUS_TTL_MS = 60_000;
  private readonly pendingDirs = new Set<string>();

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
    this.disposables.push(
      this.binding.onDidChange.event(() => {
        const dir = this.binding.getEnvDir();
        if (dir) this.statusCache.delete(dir);
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
    this.statusCache.delete(this.effectiveDir());
    void this.usage.refresh(this.effectiveDir());
    this.refresh();
  }

  private effectiveDir(): string {
    return this.binding.getEnvDir() ?? defaultSourceDir();
  }

  private cachedStatus(dir: string): AuthStatus | null | undefined {
    return this.statusCache.get(dir)?.status;
  }

  private refresh(): void {
    this.render();
    const dir = this.effectiveDir();
    const entry = this.statusCache.get(dir);
    if (entry && Date.now() - entry.at < StatusBarManager.STATUS_TTL_MS) return;
    if (this.pendingDirs.has(dir)) return;
    this.pendingDirs.add(dir);
    void getAuthStatus(dir).then((status) => {
      this.pendingDirs.delete(dir);
      this.statusCache.set(dir, { status, at: Date.now() });
      this.render();
    });
  }

  private resolve(dir: string): {
    email?: string;
    signedOut: boolean;
    confirmed: boolean;
    unreachable: boolean;
  } {
    const status = this.cachedStatus(dir);
    const unreachable = status === null;
    const cliSaysIn = status?.loggedIn === true;
    const cliSaysOut = status !== undefined && status !== null && status.loggedIn !== true;
    const signedOut = cliSaysOut || (!hasCredentials(dir) && !cliSaysIn);
    return {
      email: signedOut ? undefined : status?.email ?? readIdentity(dir)?.email,
      signedOut,
      confirmed: cliSaysIn,
      unreachable,
    };
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

  private render(): void {
    const dir = this.effectiveDir();
    const active = this.binding.getActiveName();
    const savedName = this.registry.getByDir(dir)?.name;

    const status = this.cachedStatus(dir);
    const { email, signedOut, confirmed, unreachable } = this.resolve(dir);
    const notLoggedIn = signedOut;
    const usage = this.usageFor(dir);
    const usageText = formatUsageBar(usage ?? null);

    if (email) {
      const savedByEmail = email ? this.registry.savedForEmail(email) : undefined;
      const isSaved = Boolean(savedName || active || savedByEmail);
      // Compact Claude-Code-like bar: email + 5h/7d/Fable
      const main = usageText
        ? `$(account) ${email.split('@')[0]} · ${usageText}`
        : `$(account) ${email}${isSaved ? '' : ' $(circle-outline)'}`;
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

      this.item.tooltip = this.card([
        `**${email}**${status?.subscriptionType ? ` · ${status.subscriptionType}` : ''}${
          usage?.planLabel ? ` · ${usage.planLabel}` : ''
        }${status?.orgName || usage?.orgName ? ` · ${status?.orgName ?? usage?.orgName}` : ''}`,
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
        unreachable
          ? '_Could not run `claude auth status` (is the Linux `claude` CLI on your PATH?) — showing the ' +
            'account from its config file, which may lag behind the real token._'
          : confirmed
            ? ''
            : '_Confirming with `claude auth status`…_',
        actions.join(' &nbsp;·&nbsp; '),
      ]);
      // Soft warning colors near limits
      const hot =
        (usage?.sessionPercent ?? 0) >= 80 ||
        (usage?.weeklyPercent ?? 0) >= 80 ||
        (usage?.modelLimits.some((m) => m.percent >= 80) ?? false);
      const warn =
        (usage?.sessionPercent ?? 0) >= 65 ||
        (usage?.weeklyPercent ?? 0) >= 70 ||
        (usage?.modelLimits.some((m) => m.percent >= 70) ?? false);
      this.item.backgroundColor = hot
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : warn
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;
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
    } else {
      this.item.text = '$(account) Claude $(sync~spin)';
      this.item.tooltip = this.card(['Reading the Claude account this window is signed in as…']);
      this.item.backgroundColor = undefined;
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

    if (!email && !this.statusCache.has(dir)) {
      vscode.window.showInformationMessage(
        'Still reading the current Claude account — try again in a moment.'
      );
      return;
    }
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
    this.usage.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
