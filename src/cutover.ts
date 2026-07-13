/**
 * Post-turn failover: never cut over mid-turn; only after TurnWatcher → idle.
 *
 * Panel cutover uses SetupWizard.switchTo (bind + reload). That is still a
 * window reload, but only when settled — not during an active agent turn.
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
  type FailoverThresholds,
  type FailoverTriggers,
  type FailoverStrategy,
  DEFAULT_THRESHOLDS,
  DEFAULT_TRIGGERS,
  DEFAULT_STRATEGY,
} from './usageParse';
import { matchWorkspaceRoute, type WorkspaceRoute } from './workspaceRoutes';
import { defaultSourceDir } from './capture';

export type PanelCutoverMode = 'off' | 'notify' | 'idleReload';

const PENDING_KEY = 'claudeAccounts.pendingIdleCutover';

export class IdleCutoverController {
  private watcher: TurnWatcher;
  private pending = false;
  private busy = false;
  private evaluating = false;

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
    this.watcher = new TurnWatcher(getConfigDir, { settleMs: 4_000, pollMs: 1_500 });
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
    if (opts.accountOrder) this.accountOrder = opts.accountOrder;
    if (opts.workspaceRoutes) this.workspaceRoutes = opts.workspaceRoutes;
  }

  start(): void {
    this.pending = Boolean(this.context.workspaceState.get(PENDING_KEY));
    this.watcher.start();
  }

  /** Call when usage monitor sees failover pressure on the current account. */
  notePressure(snap: UsageSnapshot, reasons: string[]): void {
    if (this.panelMode === 'off') return;
    if (!needsFailover(snap, this.thresholds, this.triggers)) return;

    if (this.busy || this.watcher.getPhase() === 'in_turn') {
      this.pending = true;
      void this.context.workspaceState.update(PENDING_KEY, true);
      log(`cutover: pressure during turn — deferred (${reasons.join(', ')})`);
      return;
    }
    // Already idle: evaluate immediately
    void this.evaluateAndMaybeCutover(reasons);
  }

  private async onBecameIdle(): Promise<void> {
    if (this.panelMode === 'off') return;
    if (!this.pending) {
      // Still re-check usage in case pressure appeared without notePressure
      // (e.g. settings changed). Light path: only if pending was set.
      return;
    }
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
      const reasons = currentSnap.email
        ? [`${currentSnap.email}`, ...hint]
        : hint;

      const next = await this.pickNextAccount(currentSnap.email ?? undefined);
      if (!next) {
        log('cutover: no alternate account available');
        this.pending = false;
        await this.context.workspaceState.update(PENDING_KEY, false);
        void vscode.window.showWarningMessage(
          `Claude Accounts: usage high (${reasons.join(', ')}) but no cooler account is available.`
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
      const msg = `Turn finished — switching to ${nextEmail} (${reasons.filter(Boolean).join('; ')})`;

      if (this.panelMode === 'notify') {
        this.pending = false;
        await this.context.workspaceState.update(PENDING_KEY, false);
        const pick = await vscode.window.showWarningMessage(
          `Claude Accounts: ${msg}`,
          'Switch now',
          'Dismiss'
        );
        if (pick === 'Switch now') {
          await this.wizard.switchTo(next);
        }
        return;
      }

      // idleReload: clear pending BEFORE reload so we don't loop
      this.pending = false;
      await this.context.workspaceState.update(PENDING_KEY, false);
      log(`cutover: idleReload → ${nextEmail}`);
      void vscode.window.setStatusBarMessage(`Claude Accounts: ${msg}`, 8_000);
      await this.wizard.switchTo(next);
    } catch (err) {
      log(`cutover error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.evaluating = false;
    }
  }

  private async pickNextAccount(currentEmail?: string) {
    // Workspace pin: never leave the mapped account via auto cutover
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (folder) {
      const route = matchWorkspaceRoute(folder, this.workspaceRoutes);
      if (route) {
        log(`cutover: workspace pin ${route.email} — skip auto account change`);
        return null;
      }
    }

    const accounts = this.registry.listUniqueByEmail();
    const rows = [];
    for (const a of accounts) {
      const email = this.registry.emailOf(a);
      if (!email || !a.dir || !fs.existsSync(a.dir)) continue;
      const snap = await fetchUsage(a.dir);
      rows.push({
        id: email,
        email,
        name: a.name,
        dir: a.dir,
        sessionPercent: snap?.sessionPercent ?? 100,
        weeklyPercent: snap?.weeklyPercent ?? 100,
        fablePercent: snap?.modelLimits.find((m) => /fable/i.test(m.name))?.percent ?? null,
      });
    }

    const picked = selectFailoverAccount(rows, {
      strategy: this.strategy,
      order: this.accountOrder,
      thresholds: this.thresholds,
      triggers: this.triggers,
    });
    if (!picked?.email) return null;
    if (currentEmail && picked.email === currentEmail) {
      // Need a different account
      const others = rows.filter((r) => r.email !== currentEmail);
      const alt = selectFailoverAccount(others, {
        strategy: this.strategy,
        order: this.accountOrder,
        thresholds: this.thresholds,
        triggers: this.triggers,
      });
      if (!alt?.email) return null;
      return accounts.find((a) => this.registry.emailOf(a) === alt.email) ?? null;
    }
    return accounts.find((a) => this.registry.emailOf(a) === picked.email) ?? null;
  }

  dispose(): void {
    this.watcher.dispose();
  }
}
