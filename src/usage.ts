/**
 * OAuth usage for the *active* CLAUDE_CONFIG_DIR (this window's account).
 * Workspace extension only (WSL/Linux) — never Windows UI host.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { log } from './log';
import { readIdentity, hasCredentials } from './accounts';
import { writeFileAtomic, withLock, withLockAsync } from './fsSafe';
import { isWindowsPath } from './sidecars';
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
  selectFailoverAccount,
  usageScore,
};

const API_BASE = 'https://api.anthropic.com';
const USAGE_PATH = '/api/oauth/usage';
const USAGE_URL = `${API_BASE}${USAGE_PATH}`;
const FETCH_TIMEOUT_MS = 15_000;
/** Same public Claude Code OAuth client id the claude-code CLI uses. */
const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_OAUTH_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
/**
 * Disk cache TTL for /api/oauth/usage. Shared on-disk across windows, so the poll
 * fetches at most once per TTL per account no matter how many windows are open
 * (a window whose poll finds a fresh cache serves it without a network hit). 1 min
 * keeps the meter responsive; the API tolerates this — the old 5 min was a
 * self-imposed guess, not a measured limit, and a real 429 still backs off below.
 */
export const USAGE_CACHE_TTL_MS = 60_000;
/**
 * After a poll 429, serve the last cache and don't re-poll for this long. Kept to a
 * single poll cycle: a longer freeze (this was 5 min) is exactly what left the meter
 * stuck at an old percent and missing the climb to 100%. One cycle lets it recover on
 * the next (jittered) poll, which — de-aligned across windows — usually isn't limited.
 */
const RATE_LIMIT_BACKOFF_MS = 60_000;
/** Refresh access token this long before expiresAt. */
const TOKEN_HEADROOM_MS = 60_000;

/**
 * Headers for GET /api/oauth/usage.
 * (Does not send anthropic-version on the usage poll.)
 */
const USAGE_HEADERS: Record<string, string> = {
  'anthropic-beta': 'oauth-2025-04-20',
  Accept: 'application/json',
  'User-Agent': 'claude-accounts',
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

/**
 * Advisory lock for a machine-wide file this extension fully owns. Every window
 * read-modify-writes these, so the lock serializes those critical sections
 * (unique temp names alone stop torn writes, not lost updates).
 */
function lockFor(file: string): string {
  return `${file}.lock`;
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
  writeFileAtomic(file, JSON.stringify(creds, null, 2), { mode: 0o600 });
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
    writeFileAtomic(usageCachePath(), JSON.stringify(cache, null, 2), { mode: 0o600 });
  } catch (err) {
    log(`usage-cache write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

interface UsageMeta {
  /**
   * Per-account network backoff: cache-key (email:… / dir:…) → wall clock of its
   * last poll HTTP 429. Per-account so one account's 429 does not freeze every
   * other account's meter on stale data for the backoff window.
   */
  rateLimitAt?: Record<string, number>;
  /** Legacy machine-wide stamp (pre per-account); ignored now, left to expire. */
  lastRateLimitAt?: number;
}

function metaPath(): string {
  return path.join(policyDir(), 'usage-meta.json');
}

function readMeta(): UsageMeta {
  try {
    return JSON.parse(fs.readFileSync(metaPath(), 'utf-8')) as UsageMeta;
  } catch {
    return {};
  }
}

function writeMeta(m: UsageMeta): void {
  try {
    fs.mkdirSync(policyDir(), { recursive: true, mode: 0o700 });
    writeFileAtomic(metaPath(), JSON.stringify(m, null, 2), { mode: 0o600 });
  } catch (err) {
    log(`usage-meta write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function inRateLimitBackoff(key: string): boolean {
  const at = readMeta().rateLimitAt?.[key] || 0;
  return at > 0 && Date.now() - at < RATE_LIMIT_BACKOFF_MS;
}

function stampRateLimitBackoff(key: string): void {
  withLock(lockFor(metaPath()), () => {
    const m = readMeta();
    const map = m.rateLimitAt ?? {};
    map[key] = Date.now();
    writeMeta({ ...m, rateLimitAt: map });
  });
}

function clearRateLimitBackoff(key: string): void {
  withLock(lockFor(metaPath()), () => {
    const m = readMeta();
    if (!m.rateLimitAt?.[key] && m.lastRateLimitAt === undefined) return;
    if (m.rateLimitAt) delete m.rateLimitAt[key];
    delete m.lastRateLimitAt;
    writeMeta(m);
  });
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
  // Lock the read-modify-write: another window caching a different key must not
  // drop this entry (unique temp names stop torn writes, not lost updates).
  withLock(lockFor(usageCachePath()), () => {
    const cache = readUsageCache();
    cache.entries[key] = { key, fetchedAt: Date.now(), snap };
    writeUsageCache(cache);
  });
}

/** Fall back to policy.json account rows (last successful poll from any version). */
function snapFromPolicy(dir: string, key: string): UsageSnapshot | null {
  try {
    if (!fs.existsSync(policyPath())) return null;
    const pol = JSON.parse(fs.readFileSync(policyPath(), 'utf-8')) as {
      accounts?: Array<{
        email?: string;
        sessionPercent?: number;
        weeklyPercent?: number;
        fablePercent?: number | null;
        planLabel?: string | null;
        fetchedAt?: number;
      }>;
    };
    const email = key.startsWith('email:')
      ? key.slice('email:'.length)
      : readIdentity(dir)?.email?.toLowerCase();
    if (!email || !pol.accounts?.length) return null;
    const row = pol.accounts.find((a) => (a.email || '').toLowerCase() === email);
    if (!row) return null;
    const modelLimits =
      row.fablePercent != null
        ? [{ name: 'Fable', percent: row.fablePercent, resetsAt: null, kind: 'fable' }]
        : [];
    return {
      sessionPercent: row.sessionPercent ?? 0,
      sessionResetsAt: null,
      weeklyPercent: row.weeklyPercent ?? 0,
      weeklyResetsAt: null,
      opusPercent: null,
      opusResetsAt: null,
      sonnetPercent: null,
      sonnetResetsAt: null,
      modelLimits,
      overagePercent: null,
      email: row.email ?? email,
      orgName: null,
      planLabel: row.planLabel ?? null,
      fetchedAt: row.fetchedAt ?? 0,
      configDir: dir,
    };
  } catch {
    return null;
  }
}

/** Default when no prior sample: { session: 0, weekly: 0 }. */
function emptySnap(dir: string, email?: string | null): UsageSnapshot {
  return {
    sessionPercent: 0,
    sessionResetsAt: null,
    weeklyPercent: 0,
    weeklyResetsAt: null,
    opusPercent: null,
    opusResetsAt: null,
    sonnetPercent: null,
    sonnetResetsAt: null,
    modelLimits: [],
    overagePercent: null,
    email: email ?? readIdentity(dir)?.email ?? null,
    orgName: null,
    planLabel: null,
    fetchedAt: 0,
    configDir: dir,
  };
}

/**
 * Best available meter without network — on 429 serve the last good meter
 * (or zeros), never a hard sign-in error.
 */
function bestEffortSnap(dir: string, key: string): UsageSnapshot {
  return (
    getStaleSnap(key) ||
    snapFromPolicy(dir, key) ||
    emptySnap(dir, key.startsWith('email:') ? key.slice(6) : undefined)
  );
}

/** In-flight token refresh coalesced per config dir. */
const inflightTokenRefresh = new Map<string, Promise<string>>();

/**
 * Ensure access token is usable before calling usage API.
 * Refreshes when expiresAt is missing/past or within TOKEN_HEADROOM_MS.
 * Writes the new pair back into this config dir only.
 */
async function ensureFreshToken(configDir: string, force = false): Promise<string> {
  // Key by force: a forced refresh (the 401-retry path) must NOT join an
  // in-flight non-force refresh, which can resolve to the still-valid-looking
  // OLD access token via the `!force` short-circuit below and defeat the retry.
  const inflightKey = force ? `${configDir}#force` : configDir;
  const existing = inflightTokenRefresh.get(inflightKey);
  if (existing) return existing;

  const run = (async () => {
    const cur = readCreds(configDir);
    const curOauth = cur?.claudeAiOauth;
    const curAccess = curOauth?.accessToken || cur?.accessToken;
    const curExpiry = Number(curOauth?.expiresAt) || 0;
    if (!curAccess) {
      throw Object.assign(new Error('NO_TOKEN'), { kind: 'no_token' as const });
    }
    // Fast path: token still good — no refresh, no lock.
    if (!force && curExpiry && Date.now() < curExpiry - TOKEN_HEADROOM_MS) {
      return curAccess;
    }

    // A refresh is due. Serialize it across windows on this store's credentials
    // file: two windows refreshing the same account would each POST a refresh
    // and, if the server rotates the refresh token, invalidate the other's. The
    // waiter re-reads under the lock and reuses a token another window just wrote.
    const credsLock = lockFor(path.join(configDir, '.credentials.json'));
    const { result } = await withLockAsync(
      credsLock,
      async (): Promise<string> => {
        const creds = readCreds(configDir);
        const oauth = creds?.claudeAiOauth;
        const accessToken = oauth?.accessToken || creds?.accessToken;
        const refreshToken = oauth?.refreshToken;
        const expiresAt = Number(oauth?.expiresAt) || 0;

        if (!accessToken) {
          throw Object.assign(new Error('NO_TOKEN'), { kind: 'no_token' as const });
        }
        // Re-check under the lock: another window may have refreshed while we waited.
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
            scopes: typeof parsed.scope === 'string' ? parsed.scope.split(' ') : oauth?.scopes,
            subscriptionType: parsed.subscription_type || oauth?.subscriptionType,
          };
          writeCredsAtomic(configDir, { ...(creds || {}), claudeAiOauth: nextOauth });
          log(`usage: token refreshed, expiry ${new Date(nextOauth.expiresAt).toISOString()}`);
          return parsed.access_token;
        } finally {
          clearTimeout(timer);
        }
      },
      { capMs: 15_000, staleMs: 30_000 }
    );
    return result as string;
  })().finally(() => {
    inflightTokenRefresh.delete(inflightKey);
  });

  inflightTokenRefresh.set(inflightKey, run);
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
  { ok: true; snap: UsageSnapshot } | { ok: false; failure: UsageFetchFailure };

function failure(kind: UsageFetchKind, message: string, status?: number): UsageFetchResult {
  return { ok: false, failure: { kind, message, status } };
}

/**
 * Usage poll: returns { status, data } for both success and HTTP errors
 * (does not throw on 429). Throws only on network/timeout.
 */
async function callUsageApi(token: string): Promise<{ status: number; data: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(USAGE_URL, {
      method: 'GET',
      headers: { ...USAGE_HEADERS, Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: controller.signal,
    });
    const text = await res.text();
    const status = res.status;
    if (status === 200) {
      try {
        return { status, data: JSON.parse(text) };
      } catch {
        throw new Error('Invalid JSON from usage API');
      }
    }
    return { status, data: text.slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Usage poll sequence:
 *  1. If cache younger than 5 min → return it (no network)
 *  2. If recent poll 429 backoff → return best-effort (no network)
 *  3. PRELIMINARY: ensureFreshToken() — may POST console.anthropic.com/v1/oauth/token
 *  4. GET api.anthropic.com/api/oauth/usage
 *  5. 401/403 → force token refresh once, retry usage
 *  6. 429 → stamp backoff, return previous cache / policy / zeros (never hard-fail)
 *  7. 200 → cache + return
 *
 * Profile is NOT called on this path (only /usage for the meter).
 */
export async function fetchUsageDetailed(
  configDir?: string,
  opts: { forceNetwork?: boolean } = {}
): Promise<UsageFetchResult> {
  const dir = resolveConfigDir(configDir);
  if (isWindowsPath(dir)) {
    log(`usage: refusing Windows path ${dir}`);
    return failure(
      'windows_path',
      'Usage cannot use a Windows Claude path. Open this folder in a WSL/Linux window.'
    );
  }

  const key = cacheKeyForDir(dir);

  // (1) Fresh cache
  if (!opts.forceNetwork) {
    const fresh = getCachedSnap(key, USAGE_CACHE_TTL_MS);
    if (fresh) {
      log(`usage: cache hit ${key}`);
      return { ok: true, snap: { ...fresh, configDir: dir } };
    }
  }

  // (2) Backoff after poll 429 — skip re-poll until window expires
  if (inRateLimitBackoff(key) && !opts.forceNetwork) {
    const snap = bestEffortSnap(dir, key);
    log(`usage: rate-limit backoff active — serving best-effort for ${key}`);
    return { ok: true, snap: { ...snap, configDir: dir } };
  }

  // (3) PRELIMINARY call path: ensureFreshToken (OAuth refresh when near expiry)
  let token: string;
  try {
    token = await ensureFreshToken(dir, false);
  } catch (err) {
    const kind =
      typeof err === 'object' && err && 'kind' in err
        ? (err as { kind: UsageFetchKind }).kind
        : 'unknown';
    if (kind === 'no_token') {
      return failure(
        'no_token',
        'No OAuth token in this window’s config dir. Sign in with Claude Code first (/login).'
      );
    }
    if (kind === 'token_rejected') {
      return failure(
        'token_rejected',
        'Claude rejected this window’s refresh token. Sign in again with Claude Code (/login).'
      );
    }
    log(`usage: ensureFreshToken failed — ${err instanceof Error ? err.message : String(err)}`);
    return { ok: true, snap: { ...bestEffortSnap(dir, key), configDir: dir } };
  }

  try {
    // (4) Usage poll
    let { status, data } = await callUsageApi(token);

    // (5) 401/403 → force refresh + one retry
    if (status === 401 || status === 403) {
      log(`usage: HTTP ${status} after ensureFreshToken — forcing refresh + retry`);
      try {
        // Force a refresh (bypasses the expiry check and re-reads creds under the
        // per-store lock) then retry once. No unlocked pre-write of expiresAt — it
        // was redundant with force=true and could clobber another window's refresh.
        token = await ensureFreshToken(dir, true);
        ({ status, data } = await callUsageApi(token));
      } catch (retryErr) {
        log(
          `usage: forced refresh failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`
        );
        return {
          ok: false,
          failure: {
            kind: 'token_rejected',
            message:
              'Claude rejected this window’s token after refresh. Sign in again with Claude Code (/login).',
            status,
          },
        };
      }
      if (status === 401 || status === 403) {
        return {
          ok: false,
          failure: {
            kind: 'token_rejected',
            message:
              'Claude rejected this window’s token after refresh. Sign in again with Claude Code (/login).',
            status,
          },
        };
      }
    }

    // (6) 429 poll rate-limit — keep previous usage, stamp backoff
    if (status === 429) {
      stampRateLimitBackoff(key);
      const snap = bestEffortSnap(dir, key);
      log(
        `usage: HTTP 429 (poll rate-limit) — serving best-effort (5h ${snap.sessionPercent}% 7d ${snap.weeklyPercent}%), NOT treating as sign-out`
      );
      return { ok: true, snap: { ...snap, configDir: dir } };
    }

    if (status !== 200) {
      log(`usage: HTTP ${status} — serving best-effort`);
      return { ok: true, snap: { ...bestEffortSnap(dir, key), configDir: dir } };
    }

    // (7) Success
    clearRateLimitBackoff(key);
    const usage = data as Record<string, unknown>;
    // Identity from dir (no second profile HTTP call — avoids extra 429s)
    const identity = readIdentity(dir);
    const profile = identity
      ? {
          account: { email: identity.email, display_name: identity.displayName },
          organization: identity.organizationName ? { name: identity.organizationName } : undefined,
        }
      : null;
    const snap = buildSnapshot(usage, profile, dir);
    putCachedSnap(key, snap);
    log(
      `usage(${dir}): 5h=${snap.sessionPercent}% 7d=${snap.weeklyPercent}% models=${
        snap.modelLimits.map((m) => `${m.name}:${m.percent}%`).join(',') || 'none'
      }`
    );
    return { ok: true, snap };
  } catch (err) {
    // Network / timeout — keep last good cache
    log(`usage: network error — ${err instanceof Error ? err.message : String(err)}`);
    return { ok: true, snap: { ...bestEffortSnap(dir, key), configDir: dir } };
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
}): void {
  try {
    // Lock the whole read-modify-write: policy.json is one machine-wide file
    // every window rewrites, so an unlocked RMW loses a concurrent window's
    // update (and unique temp names only stop torn writes, not lost updates).
    withLock(lockFor(policyPath()), () => {
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
      // Membership is decided by disk, not by this window's globalState view of
      // the account list (which does not propagate between windows): keep a row
      // only while its store still holds a credential. A window that has not yet
      // discovered an account — or forgot it locally — must not delete it out
      // from under another window that is legitimately still polling it. Explicit
      // Forget removes rows through removeEmails / prunePolicyEmails.
      for (const [em, acc] of [...byEmail.entries()]) {
        if (!acc.dir || !hasCredentials(acc.dir)) byEmail.delete(em);
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
          opts.workspaceRoutes !== undefined ? opts.workspaceRoutes : prev.workspaceRoutes || [],
        accounts: [...byEmail.values()],
      };
      writeFileAtomic(policyPath(), JSON.stringify(policy, null, 2), { mode: 0o600 });
    });
  } catch (err) {
    log(`policy write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Remove one or more emails from the policy cache (Forget). */
export function prunePolicyEmails(emails: string[]): void {
  if (!emails.length || !fs.existsSync(policyPath())) return;
  try {
    withLock(lockFor(policyPath()), () => {
      const prev = JSON.parse(fs.readFileSync(policyPath(), 'utf-8')) as OrchPolicy;
      const drop = new Set(emails);
      prev.accounts = (prev.accounts || []).filter((a) => !drop.has(a.email));
      prev.accountOrder = (prev.accountOrder || []).filter((id) => !drop.has(id));
      prev.updatedAt = Date.now();
      writeFileAtomic(policyPath(), JSON.stringify(prev, null, 2), { mode: 0o600 });
    });
    log(`policy: pruned ${emails.join(', ')}`);
  } catch (err) {
    log(`policy prune failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export class UsageMonitor {
  private cache = new Map<string, UsageSnapshot | null>();
  private inflight = new Map<string, Promise<UsageSnapshot | null>>();
  /** Guards refreshAllAccounts against the interval re-entering a live run. */
  private refreshingAll = false;
  private timer: NodeJS.Timeout | null = null;
  /** False once stopped/disposed — stops an in-flight poll from re-arming the timer. */
  private polling = false;
  /** Bumped on every start(); an older poll chain whose gen no longer matches stops. */
  private pollGen = 0;
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
  /**
   * Poll every registered account (not just this window's) each cycle. Only the
   * cross-account failover paths consume that data, so it's off unless an
   * auto-cutover strategy needs it (panelCutover=idleReload or failover.mode=cli).
   * In meter-only mode every window polling every account just multiplied
   * /api/oauth/usage calls and tripped 429 with nothing reading the result.
   */
  private pollAllAccounts = false;

  /** Default poll cadence — matches USAGE_CACHE_TTL_MS. */
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
    pollAllAccounts?: boolean;
  }): void {
    if (opts.thresholds) this.thresholds = opts.thresholds;
    if (opts.triggers) this.triggers = opts.triggers;
    if (opts.strategy) this.strategy = opts.strategy;
    if (opts.accountOrder !== undefined) this.accountOrder = opts.accountOrder;
    if (opts.mode) this.mode = opts.mode;
    if (opts.workspaceRoutes !== undefined) this.workspaceRoutes = opts.workspaceRoutes;
    if (opts.nameByEmail) this.nameByEmail = opts.nameByEmail;
    if (opts.storeDirForEmail) this.storeDirForEmail = opts.storeDirForEmail;
    if (opts.pollAllAccounts !== undefined) this.pollAllAccounts = opts.pollAllAccounts;
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

  /**
   * True when this dir's account is inside the post-429 backoff window (a real
   * signal — a 429 returns ok:true with a best-effort snap and never sets
   * lastFailure, so the meter is serving last-known figures right now).
   */
  isRateLimited(dir?: string): boolean {
    return inRateLimitBackoff(cacheKeyForDir(resolveConfigDir(dir)));
  }

  setActiveDir(dir: string | undefined): void {
    this.currentDir = dir;
  }

  private policyWrite(snapshots: UsageSnapshot[]): void {
    writePolicyCache({
      mode: this.mode,
      thresholds: this.thresholds,
      triggers: this.triggers,
      strategy: this.strategy,
      accountOrder: this.accountOrder,
      workspaceRoutes: this.workspaceRoutes,
      nameByEmail: this.nameByEmail,
      snapshots,
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
    // The 5-min interval must not re-enter a run still in flight: sequential
    // per-account fetches on a slow/429 network can exceed 5 min, and two runs
    // would interleave policy.json read-modify-writes.
    if (this.refreshingAll) return;
    this.refreshingAll = true;
    try {
      await this.refreshAllAccountsOnce();
    } finally {
      this.refreshingAll = false;
    }
  }

  private async refreshAllAccountsOnce(): Promise<void> {
    // Meter-only mode: poll just this window's bound account. refresh() feeds the
    // in-memory gauge, writes policy, and emits pressure for the active account —
    // everything the meter needs — without touching the other accounts' APIs.
    const listed = this.pollAllAccounts ? (this.listAccountsToPoll?.() ?? []) : [];
    if (!listed.length) {
      await this.refresh(this.currentDir);
      return;
    }
    // One network path per email — duplicate dirs with the same token were
    // hammering /api/oauth/usage and tripping 429.
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
        // Feed the IN-MEMORY cache the status bar reads (getCached) — not just disk +
        // policy. Without this a background poll fetched fresh figures and emit()'d,
        // but the re-render read a stale in-memory snap, so the meter only ever moved
        // on focus/manual refresh and could sit at an old percent for minutes.
        this.cache.set(resolveConfigDir(this.currentDir), cur);
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
    this.polling = true;
    const gen = ++this.pollGen;
    const runAndReschedule = () => {
      const d = getDir();
      this.currentDir = d;
      void this.refreshAllAccounts()
        .catch((e) => log(`usage: poll error — ${e instanceof Error ? e.message : String(e)}`))
        .finally(() => {
          // Don't re-arm if stopped/disposed, or if a newer start() superseded this
          // chain (a re-start while a poll was in flight would otherwise double-arm).
          if (!this.polling || gen !== this.pollGen) return;
          // Reschedule AFTER the run (never overlap two polls) with jitter, so windows
          // that started together — e.g. a batch of self-heal reloads — don't all poll
          // at the 60s cache boundary and stampede /api/oauth/usage into a 429.
          const delay = this.intervalMs + Math.floor(Math.random() * this.intervalMs * 0.5);
          this.timer = setTimeout(runAndReschedule, delay);
          this.timer.unref?.();
        });
    };
    // Initial poll jittered 0–3s so a batch of simultaneously-activated windows
    // spreads out; the first to fetch populates the shared disk cache for the rest.
    this.timer = setTimeout(runAndReschedule, Math.floor(Math.random() * 3_000));
    this.timer.unref?.();
  }

  stop(): void {
    this.polling = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  dispose(): void {
    this.stop();
    this.listeners.clear();
    this.cache.clear();
  }
}
