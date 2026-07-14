/**
 * Post-turn failover: never cut over mid-turn; only after TurnWatcher → idle.
 *
 * Panel cutover uses SetupWizard.switchTo (bind + reload) only when:
 *   • settled idle
 *   • current account needs failover
 *   • target is cool (not least-bad hot)
 *   • auto-reload cooldown elapsed
 *   • no workspace path pin
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import { AccountRegistry } from './accounts';
import { WindowBinding } from './binding';
import { SetupWizard } from './setupWizard';
import { log } from './log';
import { TurnWatcher } from './turnWatcher';
import { fetchUsage, type UsageSnapshot } from './usage';
import {
  selectFailoverAccount,
  needsFailover,
  accountIsCool,
  type FailoverThresholds,
  type FailoverTriggers,
  type FailoverStrategy,
  type SelectableAccount,
  DEFAULT_THRESHOLDS,
  DEFAULT_TRIGGERS,
  DEFAULT_STRATEGY,
} from './usageParse';
import { matchWorkspaceRoute, type WorkspaceRoute } from './workspaceRoutes';
import { defaultSourceDir } from './capture';

export type PanelCutoverMode = 'off' | 'notify' | 'idleReload';

const PENDING_KEY = 'claudeAccounts.pendingIdleCutover';
/** Min ms between automatic idleReload cutovers (survives reload). */
const AUTO_COOLDOWN_KEY = 'claudeAccounts.lastAutoCutoverAt';
const AUTO_COOLDOWN_MS = 5 * 60_000;

export class IdleCutoverController {
  private watcher: TurnWatcher;
  private pending = false;
  private busy = false;
  private evaluating = false;
  private startupTimer: ReturnType<typeof setTimeout> | undefined;

  private panelMode: PanelCutoverMode = 'off';
  private thresholds: FailoverThresholds = { ...DEFAULT_THRESHOLDS };
  private triggers: FailoverTriggers = { ...DEFAULT_TRIGGERS };
  private strategy: FailoverStrategy = DEFAULT_STRATEGY;
  private accountOrder: string[] = [];
  private workspaceRoutes: WorkspaceRoute[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly registry: AccountRegistry,
    private readonly binding: WindowBinding,
    private readonly wizard: SetupWizard,
    getConfigDir: () => string | undefined
  ) {
    this.watcher = new TurnWatcher(getConfigDir);
    this.watcher.onBusy = () => {
      this.busy = true;
    };
    this.watcher.onIdle = () => {
      this.busy = false;
      void this.onBecameIdle();
    };
  }

  configure(opts: {
    panelMode?: PanelCutoverMode;
    thresholds?: FailoverThresholds;
    triggers?: FailoverTriggers;
    strategy?: FailoverStrategy;
    accountOrder?: string[];
    workspaceRoutes?: WorkspaceRoute[];
  }): void {
    if (opts.panelMode !== undefined) this.panelMode = opts.panelMode;
    if (opts.thresholds) this.thresholds = opts.thresholds;
    if (opts.triggers) this.triggers = opts.triggers;
    if (opts.strategy) this.strategy = opts.strategy;
    if (opts.accountOrder !== undefined) this.accountOrder = opts.accountOrder;
    if (opts.workspaceRoutes) this.workspaceRoutes = opts.workspaceRoutes;
  }

  start(): void {
    this.pending = Boolean(this.context.workspaceState.get(PENDING_KEY));
    this.watcher.start();
    // If we restored pending and already idle, evaluate (no busy→idle edge)
    this.startupTimer = setTimeout(() => {
      this.startupTimer = undefined;
      if (this.pending && this.watcher.getPhase() === 'idle' && !this.busy) {
        void this.evaluateAndMaybeCutover(['startup-pending']);
      }
    }, 2_000);
    if (typeof this.startupTimer.unref === 'function') this.startupTimer.unref();
  }

  /** Call when usage sees failover pressure — independent of failover.mode. */
  notePressure(snap: UsageSnapshot, reasons: string[]): void {
    if (this.panelMode === 'off') return;
    if (!needsFailover(snap, this.thresholds, this.triggers)) return;

    if (this.busy || this.watcher.getPhase() === 'in_turn') {
      this.pending = true;
      void this.context.workspaceState.update(PENDING_KEY, true);
      log(`cutover: pressure during turn — deferred (${reasons.join(', ')})`);
      return;
    }
    void this.evaluateAndMaybeCutover(reasons);
  }

  private async onBecameIdle(): Promise<void> {
    if (this.panelMode === 'off') return;
    if (!this.pending) return;
    await this.evaluateAndMaybeCutover(['post-turn recheck']);
  }

  private async evaluateAndMaybeCutover(hint: string[]): Promise<void> {
    if (this.evaluating) return;
    if (this.panelMode === 'off') return;
    this.evaluating = true;
    try {
      const currentDir = this.binding.getEnvDir() ?? defaultSourceDir();
      const currentSnap = await fetchUsage(currentDir);
      if (!currentSnap || !needsFailover(currentSnap, this.thresholds, this.triggers)) {
        this.pending = false;
        await this.context.workspaceState.update(PENDING_KEY, false);
        log('cutover: no longer needs failover — cleared pending');
        return;
      }
      const reasons = [currentSnap.email ?? '', ...hint].filter(Boolean);

      const next = await this.pickNextAccount(currentSnap.email ?? undefined);
      if (!next) {
        log('cutover: no cool alternate account');
        this.pending = false;
        await this.context.workspaceState.update(PENDING_KEY, false);
        void vscode.window.showWarningMessage(
          `Claude Accounts: usage high (${reasons.join(', ')}) but no cooler account is available. Staying put.`
        );
        return;
      }

      const currentName = this.binding.getActiveName();
      if (next.name === currentName) {
        this.pending = false;
        await this.context.workspaceState.update(PENDING_KEY, false);
        return;
      }

      const nextEmail = this.registry.emailOf(next) ?? next.name;
      const msg = `Turn finished — switch to ${nextEmail}? (${reasons.join('; ')})`;

      if (this.panelMode === 'notify') {
        this.pending = false;
        await this.context.workspaceState.update(PENDING_KEY, false);
        const pick = await vscode.window.showWarningMessage(
          `Claude Accounts: ${msg}`,
          'Switch now',
          'Dismiss'
        );
        if (pick === 'Switch now') {
          // A new turn may have started while the dialog was open.
          if (this.busy || this.watcher.getPhase() === 'in_turn') {
            this.pending = true;
            await this.context.workspaceState.update(PENDING_KEY, true);
            log('cutover: turn resumed before switch — defer');
            return;
          }
          await this.wizard.switchTo(next);
        }
        return;
      }

      // idleReload: cooldown + cool target only
      const last = this.context.workspaceState.get<number>(AUTO_COOLDOWN_KEY, 0);
      const now = Date.now();
      if (now - last < AUTO_COOLDOWN_MS) {
        log(
          `cutover: auto-reload cooldown (${Math.round((AUTO_COOLDOWN_MS - (now - last)) / 1000)}s left)`
        );
        void vscode.window
          .showWarningMessage(
            `Claude Accounts: ${msg} (auto-switch on cooldown)`,
            'Switch now',
            'Dismiss'
          )
          .then((pick) => {
            if (pick === 'Switch now') {
              if (this.busy || this.watcher.getPhase() === 'in_turn') {
                this.pending = true;
                void this.context.workspaceState.update(PENDING_KEY, true);
                log('cutover: turn resumed before switch — defer');
                return;
              }
              void this.wizard.switchTo(next);
            }
          });
        this.pending = false;
        await this.context.workspaceState.update(PENDING_KEY, false);
        return;
      }

      // Async fetch/pick may have raced a new turn — never cut over mid-stream.
      if (this.busy || this.watcher.getPhase() === 'in_turn') {
        this.pending = true;
        await this.context.workspaceState.update(PENDING_KEY, true);
        log('cutover: turn resumed before switch — defer');
        return;
      }

      this.pending = false;
      await this.context.workspaceState.update(PENDING_KEY, false);
      await this.context.workspaceState.update(AUTO_COOLDOWN_KEY, now);
      log(`cutover: idleReload → ${nextEmail}`);
      void vscode.window.setStatusBarMessage(
        `Claude Accounts: switching to ${nextEmail} after idle turn…`,
        8_000
      );
      await this.wizard.switchTo(next);
    } catch (err) {
      log(`cutover error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.evaluating = false;
    }
  }

  private async pickNextAccount(currentEmail?: string) {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (folder) {
      const route = matchWorkspaceRoute(folder, this.workspaceRoutes);
      if (route) {
        log(`cutover: workspace pin ${route.email} — skip auto account change`);
        return null;
      }
    }

    const accounts = this.registry.listUniqueByEmail();
    const rows: (SelectableAccount & { fetchOk: boolean })[] = [];
    for (const a of accounts) {
      const email = this.registry.emailOf(a);
      if (!email || !a.dir || !fs.existsSync(a.dir)) continue;
      const snap = await fetchUsage(a.dir);
      if (!snap) {
        // Fetch failed — unknown, not 100%. Exclude from auto selection.
        log(`cutover: skip ${email} (usage fetch failed)`);
        continue;
      }
      rows.push({
        id: email,
        email,
        name: a.name,
        dir: a.dir,
        sessionPercent: snap.sessionPercent,
        weeklyPercent: snap.weeklyPercent,
        fablePercent: snap.modelLimits.find((m) => /fable/i.test(m.name))?.percent ?? null,
        fetchOk: true,
      });
    }

    // Only cool targets for auto cutover (no least-bad hot fallback)
    const coolOnly = rows.filter((r) => accountIsCool(r, this.thresholds, this.triggers));
    if (!coolOnly.length) return null;

    const others = currentEmail ? coolOnly.filter((r) => r.email !== currentEmail) : coolOnly;
    const pool = others.length ? others : coolOnly;

    const picked = selectFailoverAccount(pool, {
      strategy: this.strategy,
      order: this.accountOrder,
      thresholds: this.thresholds,
      triggers: this.triggers,
    });
    if (!picked?.email) return null;
    if (currentEmail && picked.email === currentEmail) return null;
    return accounts.find((a) => this.registry.emailOf(a) === picked.email) ?? null;
  }

  dispose(): void {
    if (this.startupTimer !== undefined) {
      clearTimeout(this.startupTimer);
      this.startupTimer = undefined;
    }
    this.watcher.dispose();
  }
}
