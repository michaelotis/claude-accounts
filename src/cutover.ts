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
import {
  BACKGROUND_TTL_MS,
  fetchUsageCoordinated,
  getUsageFromCache,
  usageCacheKey,
  type UsageSnapshot,
} from './usage';
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
/**
 * How stale a cached snapshot may be for a cutover decision — tied to the
 * central poll's background tier: that is the freshness the poll actually
 * guarantees for every saved account. Anything older is "unknown", which
 * excludes the account rather than treating it as cool or hot.
 */
const CUTOVER_SNAP_MAX_AGE_MS = BACKGROUND_TTL_MS;
/** Repeat the idle "usage high" log line at most this often while pressure persists. */
const HIGH_LOG_THROTTLE_MS = 10 * 60_000;

export class IdleCutoverController {
  private watcher: TurnWatcher;
  private pending = false;
  private busy = false;
  private evaluating = false;
  private lastHighLogAt = 0;
  private startupTimer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private watching = false;
  private disposed = false;

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
    this.watcher = new TurnWatcher(getConfigDir, {
      getFallbackCwds: () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    });
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
    if (this.started) {
      if (this.panelMode === 'idleReload' && !this.watching) this.startWatcher();
      else if (this.panelMode !== 'idleReload' && this.watching) this.stopWatcher();
    }
  }

  start(): void {
    this.started = true;
    this.pending = Boolean(this.context.workspaceState.get(PENDING_KEY));
    if (this.panelMode === 'idleReload') this.startWatcher();
    // If we restored pending and already idle, evaluate (no busy→idle edge).
    // Watcher is stopped (phase idle) unless panelMode is idleReload.
    this.startupTimer = setTimeout(() => {
      this.startupTimer = undefined;
      if (this.pending && this.watcher.getPhase() === 'idle' && !this.busy) {
        void this.evaluateAndMaybeCutover(['startup-pending']);
      }
    }, 2_000);
    if (typeof this.startupTimer.unref === 'function') this.startupTimer.unref();
  }

  private startWatcher(): void {
    if (this.watching) return;
    this.watcher.start();
    this.watching = true;
  }

  private stopWatcher(): void {
    this.watcher.stop();
    this.busy = false;
    this.watching = false;
  }

  /** Call when usage sees failover pressure — independent of failover.mode. */
  notePressure(snap: UsageSnapshot, reasons: string[]): void {
    if (this.panelMode === 'off') return;
    if (!needsFailover(snap, this.thresholds, this.triggers)) return;

    if (this.busy || this.watcher.getPhase() === 'in_turn') {
      // Pressure re-fires on every usage refresh while the account is hot; defer
      // (and say so) once per turn — pending is already set after the first one.
      if (!this.pending) {
        this.pending = true;
        void this.context.workspaceState.update(PENDING_KEY, true);
        log(`cutover: pressure during turn — deferred (${reasons.join(', ')})`);
      }
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
      // Cache-only: a threshold decision tolerates minutes-old figures, and this
      // path fires on every turn-transition while hot — it must never hit the
      // network or the backoff log. The central poll owns freshness.
      const currentSnap = getUsageFromCache(usageCacheKey(currentDir), CUTOVER_SNAP_MAX_AGE_MS);
      if (!currentSnap) {
        // No cached data yet (fresh activation / long 429) — keep pending and wait
        // for the poll to land; the next pressure or idle edge re-evaluates.
        log('cutover: no fresh usage snapshot yet — keeping pending');
        return;
      }
      if (!needsFailover(currentSnap, this.thresholds, this.triggers)) {
        this.pending = false;
        await this.context.workspaceState.update(PENDING_KEY, false);
        log('cutover: no longer needs failover — cleared pending');
        return;
      }
      const reasons = [currentSnap.email ?? '', ...hint].filter(Boolean);

      // Meter-only: there's nothing to switch to compute, so skip picking a cooler
      // account entirely (it's cache reads now, but still pointless work on every
      // pressure event). The status-bar meter already shows the pressure; the user
      // switches manually. Only idleReload needs the pick.
      if (this.panelMode !== 'idleReload') {
        this.pending = false;
        await this.context.workspaceState.update(PENDING_KEY, false);
        // While the account stays hot this re-evaluates every poll; one line every
        // ten minutes is plenty — the meter is the live signal, not the log.
        const now = Date.now();
        if (now - this.lastHighLogAt >= HIGH_LOG_THROTTLE_MS) {
          this.lastHighLogAt = now;
          log(`cutover: usage high (${reasons.join('; ')}) — meter shows it`);
        }
        return;
      }

      const next = await this.pickNextAccount(currentSnap.email ?? undefined);
      if (!next) {
        // No popup — the status-bar meter already shows the pressure, and switching
        // needs a reload anyway, so a "staying put" toast is pure noise.
        log(`cutover: usage high (${reasons.join(', ')}) but no cooler account — meter shows it`);
        this.pending = false;
        await this.context.workspaceState.update(PENDING_KEY, false);
        return;
      }

      const currentName = this.binding.getActiveName();
      if (next.name === currentName) {
        this.pending = false;
        await this.context.workspaceState.update(PENDING_KEY, false);
        return;
      }

      const nextEmail = this.registry.emailOf(next) ?? next.name;

      // Re-check the mode in case the user turned off idleReload mid-evaluation
      // (mirrors the busy re-check below, which guards the same async gap).
      if (this.panelMode !== 'idleReload') {
        this.pending = false;
        await this.context.workspaceState.update(PENDING_KEY, false);
        return;
      }

      // The pick came from the shared cache, which may be minutes old for an idle
      // account — an auto-switch (a window RELOAD) must not land on an account
      // that heated up since. Re-validate the target with ONE coordinated fetch
      // (cache-fresh within a minute, else a single locked network call).
      const fresh = await fetchUsageCoordinated(
        { dir: next.dir, email: nextEmail },
        { freshForMs: 60_000 }
      );
      if (this.disposed) return; // keep pending persisted so a reload can resume it
      if (!this.watching || this.panelMode !== 'idleReload') {
        this.pending = false;
        await this.context.workspaceState.update(PENDING_KEY, false);
        log('cutover: idleReload turned off during evaluation — staying put');
        return;
      }
      const freshSnap = fresh.result.ok ? fresh.result.snap : null;
      // FAIL CLOSED on recency: a lock-skip or backoff serves best-effort, which
      // can be an old snap or literal zeros — and zeros read as maximally cool.
      // Only a snapshot demonstrably from the last ~90s may authorize a switch.
      const isRecent = Boolean(freshSnap && Date.now() - freshSnap.fetchedAt <= 90_000);
      const stillCool =
        isRecent &&
        freshSnap &&
        accountIsCool(
          {
            id: nextEmail,
            email: nextEmail,
            dir: next.dir,
            sessionPercent: freshSnap.sessionPercent,
            weeklyPercent: freshSnap.weeklyPercent,
            fablePercent: freshSnap.modelLimits.find((m) => /fable/i.test(m.name))?.percent ?? null,
          },
          this.thresholds,
          this.triggers
        );
      if (!stillCool) {
        log(`cutover: target ${nextEmail} is no longer cool on a live check — staying put`);
        this.pending = false;
        await this.context.workspaceState.update(PENDING_KEY, false);
        return;
      }

      // idleReload: cooldown + cool target only
      const last = this.context.workspaceState.get<number>(AUTO_COOLDOWN_KEY, 0);
      const now = Date.now();
      if (now - last < AUTO_COOLDOWN_MS) {
        // On cooldown: skip silently (no popup). The next post-turn evaluation will
        // auto-switch once the cooldown clears.
        log(
          `cutover: auto-reload cooldown (${Math.round((AUTO_COOLDOWN_MS - (now - last)) / 1000)}s left) — skipping`
        );
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
      // The two state writes above yield to the event loop: a mode change or
      // dispose that landed meanwhile has already stopped the watcher, so this
      // is the last gate before the reload.
      if (this.disposed || !this.watching || this.panelMode !== 'idleReload') {
        log('cutover: idleReload turned off before switch — staying put');
        return;
      }
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
      // Cache-only (the central poll keeps every saved account ≤5 min fresh):
      // no data / too stale = unknown, not 100% — exclude from auto selection,
      // exactly like the old fetch-failed rule. Never fan out network calls here.
      const snap = getUsageFromCache(usageCacheKey(a.dir, email), CUTOVER_SNAP_MAX_AGE_MS);
      if (!snap) {
        log(`cutover: skip ${email} (no fresh cached usage)`);
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
    this.disposed = true;
    this.started = false;
    if (this.startupTimer !== undefined) {
      clearTimeout(this.startupTimer);
      this.startupTimer = undefined;
    }
    this.stopWatcher();
  }
}
