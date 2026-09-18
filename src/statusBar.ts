import * as vscode from 'vscode';
import { AccountRegistry, readIdentity, hasCredentials } from './accounts';
import { log } from './log';
import { WindowBinding } from './binding';
import { defaultSourceDir } from './capture';
import {
  UsageMonitor,
  USAGE_CACHE_TTL_MS,
  formatUsageBar,
  formatAccountsTable,
  type AccountUsageRow,
  type UsageSnapshot,
} from './usage';
import {
  headroomEvents,
  describeHeadroom,
  escapeTableCell,
  HEADROOM_MIN_DROP,
  type HeadroomEvent,
} from './usageParse';
import { describeWindows, readWindows, type WindowInfo } from './windowPresence';

/** Marketplace / local id — hover links to the extension page when published. */
const EXTENSION_ID = 'michaelotis.claude-accounts';

const ERROR_BG = new vscode.ThemeColor('statusBarItem.errorBackground');
const WARN_BG = new vscode.ThemeColor('statusBarItem.warningBackground');
/** Tooltip rows older than this get a "(stale)" hint (2× the background tier). */
const STALE_ROW_MS = 20 * 60_000;
/**
 * How long a Refresh Usage receipt stays in the tooltip. It reports what one
 * click did; past this it is describing a moment that has gone, and a receipt
 * must never be the reason a live degradation warning isn't shown.
 */
const REFRESH_NOTE_TTL_MS = 30_000;
/**
 * How long a "headroom came back" cue stays up. Long enough to be seen after a
 * break, short enough that it never describes a window that has since filled
 * again — the 5h bucket can be spent inside an hour.
 */
const HEADROOM_NOTE_TTL_MS = 30 * 60_000;
/**
 * How long a reading of the window records is reused for. Reading the directory
 * is synchronous, and render() is not the rare event it looks like — every poll
 * tick, every focus edge, every usage change and every state change repaints the
 * bar, so a burst of repaints would otherwise be a burst of directory scans. A
 * few seconds behind is invisible on a per-minute heartbeat; this window's own
 * bind is the one change that must show at once, and it clears the memo.
 */
const WINDOWS_MEMO_MS = 5_000;

/** What a headroom event's bucket reads now, or null when the snapshot lost it. */
function bucketPercent(usage: UsageSnapshot, label: string): number | null {
  if (label === '5h') return usage.sessionPercent;
  if (label === '7d') return usage.weeklyPercent;
  const lower = label.toLowerCase();
  const m = (usage.modelLimits ?? []).find(
    (x) => x && typeof x.name === 'string' && x.name.toLowerCase() === lower
  );
  return m ? m.percent : null;
}

/**
 * Has the bucket this cue describes filled back up? A cue that outlives its own
 * figure is worse than no cue: a 5h reset noted at 0% would still read "$(sparkle)
 * 5h 0%" while the pill beside it says 94%. The same margin that made the drop
 * worth reporting makes the refill worth believing.
 */
function refilled(event: HeadroomEvent, usage: UsageSnapshot): boolean {
  if (!usage.fetchedAt) return false;
  const now = bucketPercent(usage, event.label);
  return now != null && now - event.to >= HEADROOM_MIN_DROP;
}

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
  /** Latch so an unreadable presence dir is reported once, not once per repaint. */
  private presenceReadLogged = false;
  /** Last window listing and when it was read — see WINDOWS_MEMO_MS. */
  private windowsMemo: { at: number; dir: string | undefined; value: WindowInfo[] } | null = null;
  /** Outcome line for the last Refresh Usage click, with the time it was set. */
  private refreshNote: { text: string; at: number; claimsCurrent: boolean } | null = null;
  /**
   * Last snapshot this window saw per account (lowercased email, the key
   * getAllCachedByEmail uses) — the baseline a drop is measured against. Kept in
   * process on purpose: the cue is a live per-window nudge, two windows both
   * showing it is correct, and no new shared file means no mixed-version hazard
   * between windows on different releases.
   */
  private readonly lastSeenUsage = new Map<string, UsageSnapshot>();
  /** Accounts that recently gained headroom, with when this window noticed. */
  private readonly headroomNotes = new Map<
    string,
    { label: string; events: HeadroomEvent[]; at: number }
  >();

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
        // This window has just moved to another dir and rewritten its own
        // record; a cached listing would show it on the account it left.
        this.windowsMemo = null;
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
    // A new click supersedes what the last one reported.
    if (on) this.refreshNote = null;
    this.render();
  }

  /**
   * What the last Refresh Usage click actually did — served figures that were
   * already current, or waited out a rate-limit. Tooltip only: the Refresh Usage
   * toast was deliberately removed, and a click must not reopen that door.
   */
  setRefreshNote(note: string, claimsCurrent = false): void {
    this.refreshNote = note ? { text: note, at: Date.now(), claimsCurrent } : null;
    this.render();
  }

  /**
   * The click receipt while it still describes the present: gone after its TTL,
   * and gone the moment a receipt that called the figures current would sit over
   * a snapshot that has aged past the freshness clock.
   */
  private liveRefreshNote(usage: UsageSnapshot | null | undefined): string {
    const note = this.refreshNote;
    if (!note) return '';
    if (Date.now() - note.at >= REFRESH_NOTE_TTL_MS) return '';
    if (note.claimsCurrent && usage?.fetchedAt && Date.now() - usage.fetchedAt > USAGE_CACHE_TTL_MS)
      return '';
    return note.text;
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

  /** Registry name for an account, falling back to the email's local part. */
  private labelForEmail(emailLower: string): string {
    for (const a of this.registry.listUniqueByEmail()) {
      if ((this.registry.emailOf(a) || '').toLowerCase() === emailLower) return a.name;
    }
    return emailLower.split('@')[0];
  }

  /**
   * Compare every account's newest snapshot with the last one this window saw
   * and record the buckets whose percentage fell. Usage only rises with use, so
   * a fall is headroom returning — whether a window rolled over or Anthropic
   * moved the allowance, which no clock predicts. The first pass only seeds the
   * baseline: with nothing to compare against there is nothing to say.
   *
   * The same pass retires cues: a bucket that has filled again is no longer
   * headroom, so its event goes and the note goes with the last of them. The TTL
   * is only the backstop for a bucket that simply sits where it landed.
   */
  private detectHeadroom(): void {
    for (const [emailLower, snap] of this.usage.getAllCachedByEmail()) {
      const prev = this.lastSeenUsage.get(emailLower);
      this.lastSeenUsage.set(emailLower, snap);
      const fresh = headroomEvents(prev, snap);
      const note = this.headroomNotes.get(emailLower);
      if (!note && !fresh.length) continue;
      // Buckets come back one at a time — a 5h rollover then a Fable raise are
      // two pieces of the same answer to "what can I use now", so they are kept
      // together, the older reading giving the span the newer one continues.
      const live = new Map<string, HeadroomEvent>();
      for (const e of note?.events ?? []) {
        if (!refilled(e, snap)) live.set(e.label.toLowerCase(), e);
      }
      for (const e of fresh) {
        const held = live.get(e.label.toLowerCase());
        live.set(e.label.toLowerCase(), held ? { ...e, from: Math.max(held.from, e.from) } : e);
      }
      if (!live.size) {
        this.headroomNotes.delete(emailLower);
        continue;
      }
      this.headroomNotes.set(emailLower, {
        label: this.labelForEmail(emailLower),
        events: [...live.values()],
        at: fresh.length ? Date.now() : (note?.at ?? Date.now()),
      });
    }
  }

  /**
   * Live headroom cues: the card lines, and the bucket labels that should
   * sparkle on the active account's pills. Notes decay at their TTL, and the
   * same bucket returning on several accounts collapses to one line — an
   * allowance change hits the whole fleet at once (two accounts went Fable 100%
   * → ~70% six seconds apart), and N copies of that is noise, not news.
   */
  private liveHeadroom(activeEmailLower: string): { lines: string[]; sparkle: Set<string> } {
    const now = Date.now();
    for (const [emailLower, note] of [...this.headroomNotes]) {
      if (now - note.at >= HEADROOM_NOTE_TTL_MS) this.headroomNotes.delete(emailLower);
    }

    // Keyed lowercase — the bucket identity `bucketPercent` and the fleet
    // collapse already use. A name that comes back in another case is the same
    // bucket the cue was raised on, and a pill that quietly stopped matching
    // would leave a card line with nothing on screen to explain it.
    const sparkle = new Set<string>();
    for (const e of this.headroomNotes.get(activeEmailLower)?.events ?? [])
      sparkle.add(e.label.toLowerCase());

    // Keyed case-insensitively: one account calling the bucket `Fable` and
    // another `fable` is still one bucket moving across the fleet.
    const perLabel = new Map<string, HeadroomEvent[]>();
    for (const note of this.headroomNotes.values()) {
      for (const e of note.events) {
        const list = perLabel.get(e.label.toLowerCase());
        if (list) list.push(e);
        else perLabel.set(e.label.toLowerCase(), [e]);
      }
    }
    const lines: string[] = [];
    const fleetLabels = new Set<string>();
    for (const [key, events] of perLabel) {
      if (events.length < 2) continue;
      fleetLabels.add(key);
      const verb = events.every((e) => e.kind === 'reset') ? 'reset' : 'allowance went up';
      lines.push(`${escapeTableCell(events[0].label)} ${verb} across ${events.length} accounts`);
    }

    // The window's own account first: its line is the one that explains a pill.
    const notes = [...this.headroomNotes].sort(([a], [b]) =>
      a === activeEmailLower ? -1 : b === activeEmailLower ? 1 : a.localeCompare(b)
    );
    for (const [, note] of notes) {
      const line = describeHeadroom(
        note.events.filter((e) => !fleetLabels.has(e.label.toLowerCase())),
        note.label
      );
      if (line) lines.push(line);
    }
    return { lines, sparkle };
  }

  private renderMetricItems(usage: UsageSnapshot | null | undefined, sparkle: Set<string>): void {
    if (!usage) {
      this.hideMetricItems();
      return;
    }

    // Hovering any pill shows the same card as the account item (usage detail + actions).
    this.sessionItem.tooltip = this.item.tooltip;
    this.weeklyItem.tooltip = this.item.tooltip;
    this.fableItem.tooltip = this.item.tooltip;

    // fetchedAt 0 is emptySnap / never-fetched — 0% would look like a real reading.
    if (usage.fetchedAt === 0) {
      this.sessionItem.text = '5h –';
      this.sessionItem.backgroundColor = undefined;
      this.sessionItem.show();
      this.weeklyItem.text = '7d –';
      this.weeklyItem.backgroundColor = undefined;
      this.weeklyItem.show();
      this.fableItem.hide();
      return;
    }

    // A bucket that just gained headroom is marked on its own pill — no toast,
    // no reload; the number is already on screen, this only says it moved down.
    const mark = (label: string) => (sparkle.has(label.toLowerCase()) ? '$(sparkle) ' : '');

    this.sessionItem.text = `${mark('5h')}5h ${usage.sessionPercent}%`;
    this.sessionItem.backgroundColor = this.metricBackground(usage.sessionPercent, 65);
    this.sessionItem.show();

    this.weeklyItem.text = `${mark('7d')}7d ${usage.weeklyPercent}%`;
    this.weeklyItem.backgroundColor = this.metricBackground(usage.weeklyPercent, 70);
    this.weeklyItem.show();

    const fable = usage.modelLimits.find((m) => /fable/i.test(m.name));
    if (fable) {
      this.fableItem.text = `${mark(fable.name)}Fable ${fable.percent}%`;
      this.fableItem.backgroundColor = this.metricBackground(fable.percent, 70);
      this.fableItem.show();
    } else {
      this.fableItem.hide();
    }
  }

  /**
   * Rows for the all-accounts tooltip table: the window's own account first,
   * then every other saved account, each with its last-known snapshot from the
   * shared cache (fed machine-wide by whichever window fetched it). The email
   * rides along as the switch target for the row's link.
   */
  private accountRows(activeEmail: string): AccountUsageRow[] {
    const byEmail = this.usage.getAllCachedByEmail();
    const activeLower = activeEmail.toLowerCase();
    const rows: AccountUsageRow[] = [];
    const seen = new Set<string>();
    const push = (emailLower: string, label: string, active: boolean) => {
      if (!emailLower || seen.has(emailLower)) return;
      seen.add(emailLower);
      const cached = byEmail.get(emailLower) ?? null;
      // fetchedAt 0 is emptySnap / never-fetched — the table's null path renders "—".
      const snap = cached && cached.fetchedAt !== 0 ? cached : null;
      const stale = Boolean(snap && snap.fetchedAt && Date.now() - snap.fetchedAt > STALE_ROW_MS);
      rows.push({ label, active, snap, stale, email: emailLower });
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

  /**
   * Which windows are on which account, under the accounts table. Read at render
   * time — the records are already on disk, so this needs no timer and no event
   * of its own, and it can never be a reason the card fails to open. render()
   * runs often (see WINDOWS_MEMO_MS), so the reading itself is memoized rather
   * than the directory being scanned once per repaint.
   */
  private windowsSection(): string {
    try {
      const now = Date.now();
      // Keyed on this window's dir as well as the clock: activation can move the
      // dir without a binding event, and a memo filled a moment earlier would list
      // this window under the account it has just left.
      const envDir = this.binding.getEnvDir();
      let memo = this.windowsMemo;
      if (!memo || memo.dir !== envDir || now - memo.at >= WINDOWS_MEMO_MS) {
        memo = { at: now, dir: envDir, value: readWindows(now) };
        this.windowsMemo = memo;
      }
      return describeWindows(memo.value, (email) => this.labelForEmail(email));
    } catch (err) {
      // Once: the card is rebuilt on every focus edge and poll tick, and a
      // persistent failure would otherwise write a line for each of them.
      if (!this.presenceReadLogged) {
        this.presenceReadLogged = true;
        log(`could not read window presence: ${(err as Error).message}`);
      }
      return '';
    }
  }

  private render(): void {
    this.detectHeadroom();
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
      const prefix = '$(account) ';
      const badges = `${isSaved ? '' : ' $(circle-outline)'}${this.refreshing ? ' $(sync~spin)' : ''}`;
      // Truncate the name BEFORE composing: slicing the composed string can cut
      // inside a `$(codicon)` and leave the bar rendering the markup.
      const room = Math.max(1, 80 - prefix.length - badges.length);
      const name = email.split('@')[0];
      const shown = name.length > room ? `${name.slice(0, Math.max(0, room - 1))}…` : name;
      this.item.text = `${prefix}${shown}${badges}`;

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

      // Say how stale the figures are and when we will ask again, in the numbers
      // we actually hold: "retrying shortly" was printed over waits of minutes.
      const waitMs = this.usage.rateLimitWaitMs(dir);
      const nextAttempt =
        waitMs != null
          ? `next attempt in ${Math.ceil(waitMs / 1000)}s`
          : 'retrying at the next poll';
      const rateNote =
        !usage || usage.fetchedAt === 0
          ? `⚠ _Usage API is rate-limiting this account — no figures yet, ${nextAttempt}._`
          : `⚠ _Usage API is rate-limiting this account — last figures are ${formatAgo(
              Date.now() - usage.fetchedAt
            )} old, ${nextAttempt}._`;
      // A live degradation warning outranks a click receipt: the receipt reports
      // one moment, the warning describes the figures on screen right now.
      const refreshNote = this.liveRefreshNote(usage);
      const freshness = this.refreshing
        ? '⟳ _Updating usage…_'
        : this.usage.isRateLimited(dir)
          ? rateNote
          : refreshNote
            ? `$(info) _${refreshNote}_`
            : '';
      const staleNote = this.staleTokenNote
        ? '$(info) _Your sign-in was refreshed in another window and this window picked up the ' +
          'new token. If Claude Code still reports an auth error, reload this window once._'
        : '';
      const refreshedLine =
        usage && usage.fetchedAt === 0
          ? '_Usage not fetched yet — the first poll is pending or failed; see the log._'
          : usage && usage.fetchedAt
            ? `_Refreshed ${formatAgo(Date.now() - usage.fetchedAt)} ago_`
            : '';
      // Headroom on any account is card-only; only the active account's own
      // buckets also mark a pill. The line names the account because it is the
      // answer to "which account can I use right now".
      const headroom = this.liveHeadroom(email.toLowerCase());
      const headroomNote = headroom.lines.map((l) => `$(sparkle) _${l}_`).join('\n\n');
      this.item.tooltip = this.card([
        `**${email}**${usage?.planLabel ? ` · ${usage.planLabel}` : ''}${
          usage?.orgName ? ` · ${usage.orgName}` : ''
        }`,
        freshness,
        headroomNote,
        staleNote,
        formatAccountsTable(this.accountRows(email)),
        this.windowsSection(),
        refreshedLine,
        this.binding.rememberedForFolder() ? '_auto-selected: this folder used it last time_' : '',
        !isSaved
          ? '_$(circle-outline) Not saved yet — saving lets you switch back to it later._'
          : '',
        actions.join(' &nbsp;·&nbsp; '),
      ]);
      // Account item never carries usage hot/warn background — each metric pill
      // colors itself from its own percent.
      this.item.backgroundColor = undefined;
      this.renderMetricItems(usage, headroom.sparkle);
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
    // Single account: show usage detail. A never-fetched snap (fetchedAt 0) is
    // not a real reading — same message as a missing cache, then kick a refresh.
    const u = this.usageFor(dir);
    if (!u || u.fetchedAt === 0) {
      vscode.window.showInformationMessage(
        `${email} is your only saved account. To add another: /login as it in Claude Code. Usage will appear after refresh.`
      );
      void this.usage.refresh(dir);
    } else {
      vscode.window.showInformationMessage(
        `${email}: ${formatUsageBar(u)}` +
          (u.modelLimits.length
            ? ` · models: ${u.modelLimits.map((m) => `${m.name} ${m.percent}%`).join(', ')}`
            : '')
      );
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
