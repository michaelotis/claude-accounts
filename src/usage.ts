/**
 * OAuth usage for the *active* CLAUDE_CONFIG_DIR (this window's account).
 * Workspace extension only (WSL/Linux) — never Windows UI host.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { log } from './log';
import {
  buildSnapshot,
  formatUsageBar,
  formatUsageTooltip,
  type FailoverThresholds,
  type FailoverTriggers,
  type FailoverStrategy,
  type UsageSnapshot,
  DEFAULT_THRESHOLDS,
  DEFAULT_TRIGGERS,
  DEFAULT_STRATEGY,
  isHot,
  needsFailover,
  failoverReasons,
  pressureReasons,
  hotReasons,
  selectFailoverAccount,
  usageScore,
} from './usageParse';

export type { UsageSnapshot, FailoverThresholds, FailoverTriggers, FailoverStrategy };
export {
  formatUsageBar,
  formatUsageTooltip,
  DEFAULT_THRESHOLDS,
  DEFAULT_TRIGGERS,
  DEFAULT_STRATEGY,
  isHot,
  needsFailover,
  failoverReasons,
  pressureReasons,
  hotReasons,
  selectFailoverAccount,
  usageScore,
};

const API_BASE = 'https://api.anthropic.com';
const USAGE_URL = `${API_BASE}/api/oauth/usage`;
const PROFILE_URL = `${API_BASE}/api/oauth/profile`;
const FETCH_TIMEOUT_MS = 15_000;

const OAUTH_HEADERS: Record<string, string> = {
  'anthropic-beta': 'oauth-2025-04-20',
  'anthropic-version': '2023-06-01',
  Accept: 'application/json',
  'User-Agent': 'claude-accounts (oauth-usage)',
};

/** Policy cache for the CLI orchestrator (JSON). */
export function policyDir(): string {
  return path.join(os.homedir(), '.config', 'claude-accounts');
}

export function policyPath(): string {
  return path.join(policyDir(), 'policy.json');
}

function readAccessToken(configDir: string): string | null {
  const file = path.join(configDir, '.credentials.json');
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
      claudeAiOauth?: { accessToken?: string };
      accessToken?: string;
    };
    return raw.claudeAiOauth?.accessToken ?? raw.accessToken ?? null;
  } catch {
    return null;
  }
}

function resolveConfigDir(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.CLAUDE_CONFIG_DIR) return process.env.CLAUDE_CONFIG_DIR;
  return path.join(os.homedir(), '.claude');
}

async function getJson(url: string, token: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { ...OAUTH_HEADERS, Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      const err = new Error('TOKEN_REJECTED');
      (err as Error & { status: number }).status = res.status;
      throw err;
    }
    if (!res.ok) throw new Error(`API_ERROR_${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchUsage(configDir?: string): Promise<UsageSnapshot | null> {
  const dir = resolveConfigDir(configDir);
  if (dir.startsWith('/mnt/c/') || dir.startsWith('C:') || dir.startsWith('c:')) {
    log(`usage: refusing Windows path ${dir}`);
    return null;
  }
  const token = readAccessToken(dir);
  if (!token) {
    log(`usage: no access token in ${dir}`);
    return null;
  }

  try {
    const [usageR, profileR] = await Promise.allSettled([
      getJson(USAGE_URL, token),
      getJson(PROFILE_URL, token),
    ]);
    if (usageR.status === 'rejected') {
      log(`usage: fetch failed: ${usageR.reason}`);
      return null;
    }
    const usage = usageR.value as Record<string, unknown>;
    const profile = profileR.status === 'fulfilled' ? profileR.value : null;
    const snap = buildSnapshot(usage, profile, dir);
    log(
      `usage(${dir}): 5h=${snap.sessionPercent}% 7d=${snap.weeklyPercent}% models=${
        snap.modelLimits.map((m) => `${m.name}:${m.percent}%`).join(',') || 'none'
      }`
    );
    return snap;
  } catch (err) {
    log(`usage: error ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export interface PolicyAccount {
  /** Stable id for ordered strategy (email). */
  id: string;
  email: string;
  /** Optional short name (e.g. registry account name). */
  name?: string;
  dir: string;
  sessionPercent: number;
  weeklyPercent: number;
  fablePercent: number | null;
  /** True if needsFailover under current triggers. */
  hot: boolean;
  reasons: string[];
  planLabel: string | null;
  fetchedAt: number;
}

export interface WorkspaceRoutePolicy {
  pathPrefix: string;
  email: string;
}

export interface OrchPolicy {
  version: 3;
  updatedAt: number;
  mode: 'off' | 'notify' | 'cli';
  thresholds: FailoverThresholds;
  /** Which dimensions trigger account failover (vs meter-only). */
  triggers: FailoverTriggers;
  /** lowestUsage (default) | ordered */
  strategy: FailoverStrategy;
  /**
   * Account pool / preference list: emails or registry names.
   * - lowestUsage: if non-empty, only these ids compete; empty = all known accounts
   * - ordered: try each id in order, first cool wins
   */
  accountOrder: string[];
  /**
   * Hard path pins: under pathPrefix, always use this email (no cross-account failover).
   * Longest prefix wins. Used by CLI orch and for VS Code auto-bind.
   */
  workspaceRoutes: WorkspaceRoutePolicy[];
  accounts: PolicyAccount[];
}

/** Merge usage snapshots + workspace routes into the on-disk policy for the CLI shim. */
export function writePolicyCache(opts: {
  mode: 'off' | 'notify' | 'cli';
  thresholds: FailoverThresholds;
  triggers: FailoverTriggers;
  strategy?: FailoverStrategy;
  accountOrder?: string[];
  workspaceRoutes?: WorkspaceRoutePolicy[];
  /** Optional name map email → registry name */
  nameByEmail?: Record<string, string>;
  snapshots: UsageSnapshot[];
  /** Drop these emails entirely (e.g. after Forget). */
  removeEmails?: string[];
  /**
   * If set, policy.accounts becomes exactly this set of emails after merge
   * (plus any successful snapshots). Drops forgotten / unknown entries.
   */
  retainEmails?: string[];
}): void {
  try {
    fs.mkdirSync(policyDir(), { recursive: true, mode: 0o700 });
    let prev: Partial<OrchPolicy> = {};
    if (fs.existsSync(policyPath())) {
      try {
        prev = JSON.parse(fs.readFileSync(policyPath(), 'utf-8')) as OrchPolicy;
      } catch {
        prev = {};
      }
    }
    const byEmail = new Map<string, PolicyAccount>();
    for (const a of prev.accounts || []) {
      if (a.email) byEmail.set(a.email, a);
    }
    for (const e of opts.removeEmails || []) {
      byEmail.delete(e);
    }
    for (const s of opts.snapshots) {
      if (!s.email) continue;
      const fable = s.modelLimits.find((m) => /fable/i.test(m.name))?.percent ?? null;
      const prevDir = byEmail.get(s.email)?.dir;
      let dir = s.configDir;
      // Prefer durable account store over per-window workdir
      if (dir.includes(`${path.sep}.claude-windows${path.sep}`)) {
        if (prevDir && !prevDir.includes(`${path.sep}.claude-windows${path.sep}`)) {
          dir = prevDir;
        }
      }
      const name = opts.nameByEmail?.[s.email] || byEmail.get(s.email)?.name;
      byEmail.set(s.email, {
        id: s.email,
        email: s.email,
        name,
        dir,
        sessionPercent: s.sessionPercent,
        weeklyPercent: s.weeklyPercent,
        fablePercent: fable,
        hot: needsFailover(s, opts.thresholds, opts.triggers),
        reasons: failoverReasons(s, opts.thresholds, opts.triggers),
        planLabel: s.planLabel,
        fetchedAt: s.fetchedAt,
      });
    }
    if (opts.retainEmails) {
      const keep = new Set(opts.retainEmails);
      for (const em of [...byEmail.keys()]) {
        if (!keep.has(em)) byEmail.delete(em);
      }
    }
    let accountOrder =
      opts.accountOrder !== undefined ? opts.accountOrder : prev.accountOrder || [];
    if (!accountOrder.length) {
      const legacy: string[] = [];
      const prevAny = prev as { primaryEmail?: string; secondaryEmail?: string };
      if (prevAny.primaryEmail) legacy.push(prevAny.primaryEmail);
      if (prevAny.secondaryEmail) legacy.push(prevAny.secondaryEmail);
      accountOrder = legacy;
    }
    const policy: OrchPolicy = {
      version: 3,
      updatedAt: Date.now(),
      mode: opts.mode,
      thresholds: opts.thresholds,
      triggers: opts.triggers,
      strategy: opts.strategy || prev.strategy || DEFAULT_STRATEGY,
      accountOrder,
      workspaceRoutes:
        opts.workspaceRoutes !== undefined
          ? opts.workspaceRoutes
          : prev.workspaceRoutes || [],
      accounts: [...byEmail.values()],
    };
    const tmp = policyPath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(policy, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, policyPath());
  } catch (err) {
    log(`policy write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Remove one or more emails from the policy cache (Forget). */
export function prunePolicyEmails(emails: string[]): void {
  if (!emails.length || !fs.existsSync(policyPath())) return;
  try {
    const prev = JSON.parse(fs.readFileSync(policyPath(), 'utf-8')) as OrchPolicy;
    const drop = new Set(emails);
    prev.accounts = (prev.accounts || []).filter((a) => !drop.has(a.email));
    prev.accountOrder = (prev.accountOrder || []).filter((id) => !drop.has(id));
    prev.updatedAt = Date.now();
    const tmp = policyPath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(prev, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, policyPath());
    log(`policy: pruned ${emails.join(', ')}`);
  } catch (err) {
    log(`policy prune failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export class UsageMonitor {
  private cache = new Map<string, UsageSnapshot | null>();
  private inflight = new Map<string, Promise<UsageSnapshot | null>>();
  private timer: NodeJS.Timeout | null = null;
  private listeners = new Set<() => void>();
  private currentDir: string | undefined;
  private thresholds: FailoverThresholds = { ...DEFAULT_THRESHOLDS };
  private triggers: FailoverTriggers = { ...DEFAULT_TRIGGERS };
  private strategy: FailoverStrategy = DEFAULT_STRATEGY;
  private accountOrder: string[] = [];
  private mode: 'off' | 'notify' | 'cli' = 'notify';
  private workspaceRoutes: WorkspaceRoutePolicy[] = [];
  private nameByEmail: Record<string, string> = {};
  /** Map email → durable account store dir (not window workdir). */
  private storeDirForEmail?: (email: string) => string | undefined;
  private lastNotifyKey = '';

  constructor(private readonly intervalMs = 180_000) {}

  configure(opts: {
    thresholds?: FailoverThresholds;
    triggers?: FailoverTriggers;
    strategy?: FailoverStrategy;
    accountOrder?: string[];
    mode?: 'off' | 'notify' | 'cli';
    workspaceRoutes?: WorkspaceRoutePolicy[];
    nameByEmail?: Record<string, string>;
    storeDirForEmail?: (email: string) => string | undefined;
  }): void {
    if (opts.thresholds) this.thresholds = opts.thresholds;
    if (opts.triggers) this.triggers = opts.triggers;
    if (opts.strategy) this.strategy = opts.strategy;
    if (opts.accountOrder !== undefined) this.accountOrder = opts.accountOrder;
    if (opts.mode) this.mode = opts.mode;
    if (opts.workspaceRoutes !== undefined) this.workspaceRoutes = opts.workspaceRoutes;
    if (opts.nameByEmail) this.nameByEmail = opts.nameByEmail;
    if (opts.storeDirForEmail) this.storeDirForEmail = opts.storeDirForEmail;
  }

  getThresholds(): FailoverThresholds {
    return this.thresholds;
  }

  getTriggers(): FailoverTriggers {
    return this.triggers;
  }

  getMode(): 'off' | 'notify' | 'cli' {
    return this.mode;
  }

  onChange(fn: () => void): { dispose: () => void } {
    this.listeners.add(fn);
    return {
      dispose: () => {
        this.listeners.delete(fn);
      },
    };
  }

  /**
   * Fired when the *active* account needs failover — independent of mode.
   * Extension uses this for panel cutover; gate toasts separately.
   */
  onPressure?: (snap: UsageSnapshot, reasons: string[]) => void;
  /** Optional CLI/notify toast hook (extension gates on mode). */
  onHot?: (snap: UsageSnapshot, reasons: string[]) => void;

  /** Resolve all account stores to poll (email + durable dir). */
  listAccountsToPoll?: () => { email: string; dir: string; name?: string }[];

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  getCached(dir?: string): UsageSnapshot | null | undefined {
    const d = resolveConfigDir(dir);
    return this.cache.get(d);
  }

  setActiveDir(dir: string | undefined): void {
    this.currentDir = dir;
  }

  private policyWrite(snapshots: UsageSnapshot[]): void {
    const listed = this.listAccountsToPoll?.() ?? [];
    writePolicyCache({
      mode: this.mode,
      thresholds: this.thresholds,
      triggers: this.triggers,
      strategy: this.strategy,
      accountOrder: this.accountOrder,
      workspaceRoutes: this.workspaceRoutes,
      nameByEmail: this.nameByEmail,
      snapshots,
      retainEmails: listed.length ? listed.map((a) => a.email) : undefined,
    });
  }

  private emitPressure(snap: UsageSnapshot): void {
    if (!needsFailover(snap, this.thresholds, this.triggers)) {
      if (snap.email && this.lastNotifyKey.startsWith(`${snap.email}:`)) {
        this.lastNotifyKey = '';
      }
      return;
    }
    const reasons = failoverReasons(snap, this.thresholds, this.triggers);
    const key = `${snap.email}:${reasons.join(',')}`;
    // Always notify cutover path
    this.onPressure?.(snap, reasons);
    if (key !== this.lastNotifyKey) {
      this.lastNotifyKey = key;
      this.onHot?.(snap, reasons);
    }
  }

  async refresh(dir?: string): Promise<UsageSnapshot | null> {
    const d = resolveConfigDir(dir ?? this.currentDir);
    const existing = this.inflight.get(d);
    if (existing) return existing;
    const p = fetchUsage(d)
      .then((snap) => {
        this.cache.set(d, snap);
        if (snap) {
          const store = snap.email ? this.storeDirForEmail?.(snap.email) : undefined;
          const forPolicy = store ? { ...snap, configDir: store } : snap;
          this.policyWrite([forPolicy]);
          this.emitPressure(snap);
        }
        this.emit();
        return snap;
      })
      .finally(() => {
        this.inflight.delete(d);
      });
    this.inflight.set(d, p);
    return p;
  }

  /** Poll every registered account store and refresh policy (for lowestUsage). */
  async refreshAllAccounts(): Promise<void> {
    const listed = this.listAccountsToPoll?.() ?? [];
    if (!listed.length) {
      await this.refresh(this.currentDir);
      return;
    }
    const snaps: UsageSnapshot[] = [];
    let activeSnap: UsageSnapshot | null = null;
    const activeDir = this.currentDir ? path.normalize(this.currentDir) : '';
    for (const a of listed) {
      if (!a.dir || !fs.existsSync(a.dir)) continue;
      const snap = await fetchUsage(a.dir);
      if (!snap) continue;
      const forPolicy = { ...snap, configDir: a.dir, email: snap.email || a.email };
      if (!forPolicy.email) forPolicy.email = a.email;
      snaps.push(forPolicy);
      if (path.normalize(a.dir) === activeDir || forPolicy.configDir === this.currentDir) {
        activeSnap = forPolicy;
      }
    }
    // Also poll active window dir if different (workdir)
    if (this.currentDir) {
      const cur = await fetchUsage(this.currentDir);
      if (cur) {
        const store = cur.email ? this.storeDirForEmail?.(cur.email) : undefined;
        activeSnap = store ? { ...cur, configDir: store } : cur;
        if (activeSnap.email && !snaps.some((s) => s.email === activeSnap!.email)) {
          snaps.push(activeSnap);
        }
      }
    }
    if (snaps.length) this.policyWrite(snaps);
    if (activeSnap) this.emitPressure(activeSnap);
    this.emit();
  }

  start(getDir: () => string | undefined): void {
    this.stop();
    const tick = () => {
      const d = getDir();
      this.currentDir = d;
      void this.refreshAllAccounts();
    };
    tick();
    this.timer = setInterval(tick, this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  dispose(): void {
    this.stop();
    this.listeners.clear();
    this.cache.clear();
  }
}
