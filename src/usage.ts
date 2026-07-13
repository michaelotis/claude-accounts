/**
 * OAuth usage for the *active* CLAUDE_CONFIG_DIR (this window's account).
 * Workspace extension only (WSL/Linux) — never Windows UI host.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { log } from './log';
import { readIdentity } from './accounts';
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
/** Same public Claude Code OAuth client id camwatch / claude-code CLI use. */
const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_OAUTH_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
/** CamWatch-style usage cache TTL — avoid hammering /api/oauth/usage (429). */
export const USAGE_CACHE_TTL_MS = 5 * 60_000;
/** Refresh access token this long before expiresAt (camwatch). */
const TOKEN_HEADROOM_MS = 60_000;

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

function usageCachePath(): string {
  return path.join(policyDir(), 'usage-cache.json');
}

interface CredsFile {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: string[];
    subscriptionType?: string;
    [k: string]: unknown;
  };
  accessToken?: string;
  [k: string]: unknown;
}

interface CachedUsageEntry {
  fetchedAt: number;
  /** Stable cache key (email preferred). */
  key: string;
  snap: UsageSnapshot;
}

interface UsageCacheFile {
  entries: Record<string, CachedUsageEntry>;
}

function resolveConfigDir(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.CLAUDE_CONFIG_DIR) return process.env.CLAUDE_CONFIG_DIR;
  return path.join(os.homedir(), '.claude');
}

function readCreds(configDir: string): CredsFile | null {
  const file = path.join(configDir, '.credentials.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as CredsFile;
  } catch {
    return null;
  }
}

function writeCredsAtomic(configDir: string, creds: CredsFile): void {
  const file = path.join(configDir, '.credentials.json');
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(creds, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function cacheKeyForDir(configDir: string): string {
  const email = readIdentity(configDir)?.email?.trim().toLowerCase();
  if (email) return `email:${email}`;
  return `dir:${path.normalize(configDir)}`;
}

function readUsageCache(): UsageCacheFile {
  try {
    const raw = JSON.parse(fs.readFileSync(usageCachePath(), 'utf-8')) as UsageCacheFile;
    if (raw && typeof raw === 'object' && raw.entries && typeof raw.entries === 'object') {
      return raw;
    }
  } catch {
    /* missing / corrupt */
  }
  return { entries: {} };
}

function writeUsageCache(cache: UsageCacheFile): void {
  try {
    fs.mkdirSync(policyDir(), { recursive: true, mode: 0o700 });
    const tmp = `${usageCachePath()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, usageCachePath());
  } catch (err) {
    log(`usage-cache write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function getCachedSnap(key: string, maxAgeMs: number): UsageSnapshot | null {
  const entry = readUsageCache().entries[key];
  if (!entry?.snap || typeof entry.fetchedAt !== 'number') return null;
  if (Date.now() - entry.fetchedAt > maxAgeMs) return null;
  return entry.snap;
}

function getStaleSnap(key: string): UsageSnapshot | null {
  const entry = readUsageCache().entries[key];
  return entry?.snap ?? null;
}

function putCachedSnap(key: string, snap: UsageSnapshot): void {
  const cache = readUsageCache();
  cache.entries[key] = { key, fetchedAt: Date.now(), snap };
  writeUsageCache(cache);
}

/** In-flight token refresh coalesced per config dir (camwatch). */
const inflightTokenRefresh = new Map<string, Promise<string>>();

/**
 * Ensure access token is usable before calling usage API — camwatch pattern.
 * Refreshes when expiresAt is missing/past or within TOKEN_HEADROOM_MS.
 * Writes the new pair back into this config dir only.
 */
async function ensureFreshToken(configDir: string, force = false): Promise<string> {
  const existing = inflightTokenRefresh.get(configDir);
  if (existing) return existing;

  const run = (async () => {
    const creds = readCreds(configDir);
    const oauth = creds?.claudeAiOauth;
    const accessToken = oauth?.accessToken || creds?.accessToken;
    const refreshToken = oauth?.refreshToken;
    const expiresAt = Number(oauth?.expiresAt) || 0;

    if (!accessToken) {
      throw Object.assign(new Error('NO_TOKEN'), { kind: 'no_token' as const });
    }

    if (!force && expiresAt && Date.now() < expiresAt - TOKEN_HEADROOM_MS) {
      return accessToken;
    }

    if (!refreshToken) {
      // Still try the access token if present (server may accept it).
      if (accessToken && (!expiresAt || Date.now() < expiresAt)) return accessToken;
      throw Object.assign(new Error('NO_REFRESH'), { kind: 'no_token' as const });
    }

    log(`usage: refreshing OAuth token for ${configDir} (force=${force})`);
    const body = JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLAUDE_OAUTH_CLIENT_ID,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(CLAUDE_OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'claude-accounts (oauth-refresh)',
        },
        body,
        redirect: 'error',
        signal: controller.signal,
      });
      const text = await res.text();
      if (res.status === 400 || res.status === 401) {
        let errType = '';
        try {
          errType = (JSON.parse(text) as { error?: string }).error || '';
        } catch {
          /* ignore */
        }
        if (errType === 'invalid_grant' || res.status === 401) {
          throw Object.assign(new Error('TOKEN_REJECTED'), {
            kind: 'token_rejected' as const,
            status: res.status,
          });
        }
      }
      if (!res.ok) {
        throw Object.assign(new Error(`REFRESH_HTTP_${res.status}`), {
          kind: 'network' as const,
          status: res.status,
        });
      }
      const parsed = JSON.parse(text) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        scope?: string;
        subscription_type?: string;
      };
      if (!parsed.access_token) {
        throw Object.assign(new Error('REFRESH_NO_TOKEN'), { kind: 'unknown' as const });
      }
      const nextOauth = {
        ...(oauth || {}),
        accessToken: parsed.access_token,
        refreshToken: parsed.refresh_token || refreshToken,
        expiresAt: Date.now() + (parsed.expires_in || 3600) * 1000,
        scopes:
          typeof parsed.scope === 'string' ? parsed.scope.split(' ') : oauth?.scopes,
        subscriptionType: parsed.subscription_type || oauth?.subscriptionType,
      };
      writeCredsAtomic(configDir, { ...(creds || {}), claudeAiOauth: nextOauth });
      log(`usage: token refreshed, expiry ${new Date(nextOauth.expiresAt).toISOString()}`);
      return parsed.access_token;
    } finally {
      clearTimeout(timer);
    }
  })().finally(() => {
    inflightTokenRefresh.delete(configDir);
  });

  inflightTokenRefresh.set(configDir, run);
  return run;
}

export type UsageFetchKind =
  | 'no_token'
  | 'windows_path'
  | 'token_rejected'
  | 'rate_limited'
  | 'network'
  | 'api_error'
  | 'unknown';

export interface UsageFetchFailure {
  kind: UsageFetchKind;
  /** Short user-facing sentence (no secrets). */
  message: string;
  status?: number;
}

export type UsageFetchResult =
  | { ok: true; snap: UsageSnapshot }
  | { ok: false; failure: UsageFetchFailure };

function failure(kind: UsageFetchKind, message: string, status?: number): UsageFetchResult {
  return { ok: false, failure: { kind, message, status } };
}

function classifyHttpError(err: unknown): UsageFetchFailure {
  const status =
    typeof err === 'object' && err && 'status' in err
      ? Number((err as { status: number }).status)
      : undefined;
  const msg = err instanceof Error ? err.message : String(err);
  if (msg === 'TOKEN_REJECTED' || status === 401 || status === 403) {
    return {
      kind: 'token_rejected',
      message: 'Claude rejected this window’s token. Sign in again with Claude Code (/login).',
      status: status ?? 401,
    };
  }
  if (msg === 'RATE_LIMITED' || status === 429) {
    return {
      kind: 'rate_limited',
      message:
        'Anthropic usage API rate-limited this request (not a sign-in problem). Wait a minute and try again.',
      status: 429,
    };
  }
  if (msg.includes('abort') || msg.includes('AbortError') || msg.includes('fetch failed')) {
    return {
      kind: 'network',
      message: 'Could not reach api.anthropic.com (network or timeout). Check connectivity and retry.',
    };
  }
  const m = /^API_ERROR_(\d+)$/.exec(msg);
  if (m) {
    return {
      kind: 'api_error',
      message: `Usage API returned HTTP ${m[1]}. Try again shortly.`,
      status: Number(m[1]),
    };
  }
  return { kind: 'unknown', message: `Usage fetch failed: ${msg}`, status };
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
    if (res.status === 429) {
      const err = new Error('RATE_LIMITED');
      (err as Error & { status: number }).status = 429;
      throw err;
    }
    if (!res.ok) throw new Error(`API_ERROR_${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch usage the camwatch/claudemeter way:
 *  1. Serve disk cache if younger than USAGE_CACHE_TTL_MS (no network)
 *  2. ensureFreshToken (refresh when near expiry — camwatch)
 *  3. GET /api/oauth/usage (profile is secondary; failure does not sink usage)
 *  4. On 401, force-refresh once and retry
 *  5. On 429/network, return previous cached usage (not “signed out”)
 */
export async function fetchUsageDetailed(
  configDir?: string,
  opts: { forceNetwork?: boolean } = {}
): Promise<UsageFetchResult> {
  const dir = resolveConfigDir(configDir);
  if (dir.startsWith('/mnt/c/') || dir.startsWith('C:') || dir.startsWith('c:')) {
    log(`usage: refusing Windows path ${dir}`);
    return failure(
      'windows_path',
      'Usage cannot use a Windows Claude path. Open this folder in a WSL/Linux window.'
    );
  }

  const key = cacheKeyForDir(dir);
  if (!opts.forceNetwork) {
    const fresh = getCachedSnap(key, USAGE_CACHE_TTL_MS);
    if (fresh) {
      log(`usage: cache hit ${key} (age ok)`);
      return { ok: true, snap: { ...fresh, configDir: dir } };
    }
  }

  let token: string;
  try {
    token = await ensureFreshToken(dir, false);
  } catch (err) {
    const f = classifyHttpError(err);
    const kind =
      typeof err === 'object' && err && 'kind' in err
        ? (err as { kind: UsageFetchKind }).kind
        : f.kind;
    // Prefer stale meter over blank gauges (camwatch / claudemeter).
    const stale = getStaleSnap(key);
    if (stale && kind !== 'token_rejected' && kind !== 'no_token') {
      log(`usage: token ensure failed (${kind}) — serving stale cache for ${key}`);
      return { ok: true, snap: { ...stale, configDir: dir } };
    }
    if (kind === 'no_token') {
      return failure(
        'no_token',
        'No OAuth token in this window’s config dir. Sign in with Claude Code first (/login).'
      );
    }
    if (kind === 'token_rejected') {
      return failure(
        'token_rejected',
        'Claude rejected this window’s token. Sign in again with Claude Code (/login).'
      );
    }
    log(`usage: ensureFreshToken failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, failure: f };
  }

  /** Usage first only (camwatch) — do not double-hit the quota with parallel profile. */
  const callUsageOnly = async (tok: string) => {
    try {
      return { ok: true as const, usage: await getJson(USAGE_URL, tok) };
    } catch (reason) {
      return { ok: false as const, reason };
    }
  };

  try {
    let usageCall = await callUsageOnly(token);

    if (!usageCall.ok) {
      const f = classifyHttpError(usageCall.reason);
      if (f.kind === 'token_rejected') {
        // Camwatch: force refresh once, then retry.
        log(`usage: ${f.status} — forcing token refresh and retry`);
        try {
          const creds = readCreds(dir);
          if (creds?.claudeAiOauth) {
            creds.claudeAiOauth.expiresAt = 0;
            writeCredsAtomic(dir, creds);
          }
          token = await ensureFreshToken(dir, true);
          usageCall = await callUsageOnly(token);
        } catch (retryErr) {
          const rf = classifyHttpError(retryErr);
          const stale = getStaleSnap(key);
          if (stale && rf.kind !== 'token_rejected') {
            return { ok: true, snap: { ...stale, configDir: dir } };
          }
          return {
            ok: false,
            failure:
              rf.kind === 'token_rejected'
                ? {
                    kind: 'token_rejected',
                    message:
                      'Claude rejected this window’s token after refresh. Sign in again with Claude Code (/login).',
                    status: rf.status,
                  }
                : rf,
          };
        }
      }
    }

    if (!usageCall.ok) {
      const f = classifyHttpError(usageCall.reason);
      log(`usage: fetch failed (${f.kind}): ${f.message}`);
      // 429 / timeout / network → keep previous meter (camwatch).
      if (f.kind === 'rate_limited' || f.kind === 'network' || f.kind === 'api_error') {
        const stale = getStaleSnap(key);
        if (stale) {
          log(`usage: ${f.kind} — serving stale cache for ${key}`);
          return { ok: true, snap: { ...stale, configDir: dir } };
        }
      }
      return { ok: false, failure: f };
    }

    const usage = usageCall.usage as Record<string, unknown>;
    // Profile is secondary (claudemeter): only after usage succeeds; never sink gauges.
    let profile: unknown = null;
    try {
      profile = await getJson(PROFILE_URL, token);
    } catch {
      /* optional */
    }
    const snap = buildSnapshot(usage, profile, dir);
    putCachedSnap(key, snap);
    log(
      `usage(${dir}): 5h=${snap.sessionPercent}% 7d=${snap.weeklyPercent}% models=${
        snap.modelLimits.map((m) => `${m.name}:${m.percent}%`).join(',') || 'none'
      }`
    );
    return { ok: true, snap };
  } catch (err) {
    const f = classifyHttpError(err);
    log(`usage: error (${f.kind}): ${f.message}`);
    const stale = getStaleSnap(key);
    if (stale && f.kind !== 'token_rejected' && f.kind !== 'no_token') {
      return { ok: true, snap: { ...stale, configDir: dir } };
    }
    return { ok: false, failure: f };
  }
}

export async function fetchUsage(configDir?: string): Promise<UsageSnapshot | null> {
  const r = await fetchUsageDetailed(configDir);
  return r.ok ? r.snap : null;
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

  /** Default 5 min — matches USAGE_CACHE_TTL and camwatch background refresh. */
  constructor(private readonly intervalMs = USAGE_CACHE_TTL_MS) {}

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

  /** Last failure for the active dir (user-facing; no secrets). */
  lastFailure: UsageFetchFailure | null = null;

  async refresh(dir?: string, forceNetwork = false): Promise<UsageSnapshot | null> {
    const d = resolveConfigDir(dir ?? this.currentDir);
    const inflightKey = forceNetwork ? `${d}#force` : d;
    const existing = this.inflight.get(inflightKey);
    if (existing) return existing;
    const p = fetchUsageDetailed(d, { forceNetwork })
      .then((result) => {
        if (!result.ok) {
          this.lastFailure = result.failure;
          // Keep last good in-memory gauge if any (do not blank on 429).
          if (!this.cache.get(d)) this.cache.set(d, null);
          this.emit();
          return null;
        }
        this.lastFailure = null;
        const snap = result.snap;
        this.cache.set(d, snap);
        const store = snap.email ? this.storeDirForEmail?.(snap.email) : undefined;
        const forPolicy = store ? { ...snap, configDir: store } : snap;
        this.policyWrite([forPolicy]);
        this.emitPressure(snap);
        this.emit();
        return snap;
      })
      .finally(() => {
        this.inflight.delete(inflightKey);
      });
    this.inflight.set(inflightKey, p);
    return p;
  }

  /** Poll every registered account store and refresh policy (for lowestUsage). */
  async refreshAllAccounts(): Promise<void> {
    const listed = this.listAccountsToPoll?.() ?? [];
    if (!listed.length) {
      await this.refresh(this.currentDir);
      return;
    }
    // One network path per email — duplicate dirs with the same token were
    // hammering /api/oauth/usage and tripping 429 (camwatch: single check + cache).
    const byEmail = new Map<string, { email: string; dir: string; name?: string }>();
    for (const a of listed) {
      if (!a.dir || !fs.existsSync(a.dir)) continue;
      const em = (a.email || '').trim().toLowerCase();
      if (!em) continue;
      if (!byEmail.has(em)) byEmail.set(em, { email: a.email, dir: a.dir, name: a.name });
    }
    const snaps: UsageSnapshot[] = [];
    let activeSnap: UsageSnapshot | null = null;
    const activeDir = this.currentDir ? path.normalize(this.currentDir) : '';
    let activeEmail = '';
    if (this.currentDir) {
      activeEmail = (readIdentity(this.currentDir)?.email || '').trim().toLowerCase();
    }

    for (const a of byEmail.values()) {
      const result = await fetchUsageDetailed(a.dir);
      if (!result.ok) {
        if (result.failure.kind === 'rate_limited') {
          this.lastFailure = result.failure;
          log(`usage: rate limited while polling — using cache only for remaining`);
        }
        // Still try cache-only for this email via fetchUsageDetailed (stale inside).
        continue;
      }
      const snap = result.snap;
      const forPolicy = { ...snap, configDir: a.dir, email: snap.email || a.email };
      if (!forPolicy.email) forPolicy.email = a.email;
      snaps.push(forPolicy);
      const em = (forPolicy.email || '').trim().toLowerCase();
      if (em && em === activeEmail) activeSnap = forPolicy;
      if (path.normalize(a.dir) === activeDir) activeSnap = forPolicy;
    }

    // Active workdir may differ from store path — cache-first, no extra burst.
    if (this.currentDir) {
      const curResult = await fetchUsageDetailed(this.currentDir);
      if (curResult.ok) {
        const cur = curResult.snap;
        const store = cur.email ? this.storeDirForEmail?.(cur.email) : undefined;
        activeSnap = store ? { ...cur, configDir: store } : cur;
        if (activeSnap.email && !snaps.some((s) => s.email === activeSnap!.email)) {
          snaps.push(activeSnap);
        }
        this.lastFailure = null;
      } else if (curResult.failure.kind === 'rate_limited') {
        this.lastFailure = curResult.failure;
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
