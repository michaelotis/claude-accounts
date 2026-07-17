/**
 * OAuth usage for the *active* CLAUDE_CONFIG_DIR (this window's account).
 * Workspace extension only (WSL/Linux) — never Windows UI host.
 */

import * as crypto from 'crypto';
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
  formatAccountsTable,
  type AccountUsageRow,
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
export type { AccountUsageRow };
export {
  formatUsageBar,
  formatUsageTooltip,
  formatAccountsTable,
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
 * Freshness tier for accounts not active in this window. An account active in ANY
 * window gets 60s freshness machine-wide from that window's cycle; accounts open
 * nowhere still refresh every 5 min so the tooltip table stays meaningful. Total
 * machine-wide budget: ~1 call/min per active account + ~1 per 5 min per idle one.
 */
export const BACKGROUND_TTL_MS = 300_000;
/** Two manual refreshes within this window coalesce into one network call. */
const FORCE_COALESCE_MS = 5_000;
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

/** Cross-window policy / last-known-usage cache (JSON). */
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

/**
 * Stable machine-wide cache/lock key for an account. Email-keyed whenever the
 * email is known — the registry hint wins over the dir's identity file, so a
 * store with an unreadable identity still shares one key with its windows —
 * else falls back to the dir path (window-private, no sharing possible anyway).
 */
export function usageCacheKey(configDir: string, emailHint?: string | null): string {
  const email = (emailHint ?? readIdentity(configDir)?.email)?.trim().toLowerCase();
  if (email) return `email:${email}`;
  return `dir:${path.normalize(configDir)}`;
}

function cacheKeyForDir(configDir: string): string {
  return usageCacheKey(configDir);
}

/**
 * Machine-wide fetch lock for one account. Whichever window acquires it re-checks
 * the shared cache under the lock and only then fetches — the TTL-recheck-under-
 * lock IS the single-fetcher discipline; there is no standing leader to elect,
 * crash-recover, or hand over. A dead holder's lock is reclaimed by PID liveness.
 */
function fetchLockFor(key: string): string {
  const locks = path.join(policyDir(), 'locks');
  try {
    fs.mkdirSync(locks, { recursive: true, mode: 0o700 });
  } catch {
    /* creation races are fine; withLockAsync fails soft below */
  }
  // dir:-keyed accounts embed a whole path; cap the name well under NAME_MAX
  // and keep it collision-safe with a content hash suffix.
  const enc = encodeURIComponent(key);
  const name =
    enc.length > 120
      ? `${enc.slice(0, 80)}-${crypto.createHash('sha1').update(key).digest('hex').slice(0, 16)}`
      : enc;
  return path.join(locks, `usage-fetch-${name}.lock`);
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

/**
 * One log line per backoff episode per process, latched on the 429 stamp itself —
 * every caller that lands in the backoff branch used to log, which is how a
 * single rate-limit turned into a wall of identical lines across windows.
 */
const backoffLoggedFor = new Map<string, number>();
function logBackoffOnce(key: string): void {
  const at = readMeta().rateLimitAt?.[key] || 0;
  if (!at) return; // not actually in backoff (e.g. the lock-busy fallback path)
  if (backoffLoggedFor.get(key) === at) return;
  backoffLoggedFor.set(key, at);
  log(`usage: rate-limit backoff active — serving best-effort for ${key}`);
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

/** Read-only view of one account's last cached snapshot (no network, no locks). */
export function getUsageFromCache(key: string, maxAgeMs: number): UsageSnapshot | null {
  return getCachedSnap(key, maxAgeMs);
}

/** All cached entries (read-only; for the tooltip table / cutover / watcher). */
export function readUsageCacheEntries(): Record<
  string,
  { fetchedAt: number; key: string; snap: UsageSnapshot }
> {
  return readUsageCache().entries;
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
      // Served silently: this is the overwhelmingly common path, and a log line per
      // cache read buries the real events. Network fetches still log below.
      return { ok: true, snap: { ...fresh, configDir: dir } };
    }
  }

  // (2) Backoff after poll 429 — skip re-poll until window expires
  if (inRateLimitBackoff(key) && !opts.forceNetwork) {
    const snap = bestEffortSnap(dir, key);
    logBackoffOnce(key);
    return { ok: true, snap: { ...snap, configDir: dir } };
  }

  return fetchUsageNetwork(dir, key);
}

/**
 * Steps 3–7 of the poll sequence: token, GET /usage, 401-retry, 429 stamp, parse
 * + cache. No pre-checks — callers (fetchUsageDetailed legacy path and the
 * coordinator) decide when a network call is warranted.
 */
async function fetchUsageNetwork(dir: string, key: string): Promise<UsageFetchResult> {
  // The one permanent line at the network moment — with the coordinator, the
  // union of every window's log shows ~one of these per account per TTL,
  // machine-wide. Cache hits stay silent by design.
  log(`usage: FETCH ${key} pid=${process.pid}`);
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

export interface CoordinatedResult {
  result: UsageFetchResult;
  /** True only when THIS call performed the network fetch (drives policy writes). */
  fromNetwork: boolean;
}

/**
 * The central-repository fetch: at most one network call per account per TTL,
 * machine-wide, no matter how many windows poll. Every window keeps its own
 * jittered timer; whoever finds the shared cache stale takes the per-account
 * fetch lock, RE-CHECKS the cache under it (another window may have fetched in
 * between), and only then hits the network + writes the shared cache. Everyone
 * else serves the cache; the cache-file watcher repaints them when it advances.
 *
 * Poll path skips if the lock stays busy for 5s (winner is already fetching;
 * serve stale and let the watcher deliver). Manual path (forceNetwork) waits up
 * to 15s, coalesces refreshes landing within FORCE_COALESCE_MS into one call,
 * and past that ALSO skips — it never runs the network unlocked.
 */
export async function fetchUsageCoordinated(
  target: { dir: string; email?: string | null },
  opts: {
    forceNetwork?: boolean;
    freshForMs?: number;
    /** Test seam: replaces the network step. */
    _network?: (dir: string, key: string) => Promise<UsageFetchResult>;
  } = {}
): Promise<CoordinatedResult> {
  const dir = resolveConfigDir(target.dir);
  if (isWindowsPath(dir)) {
    return {
      result: failure(
        'windows_path',
        'Usage cannot use a Windows Claude path. Open this folder in a WSL/Linux window.'
      ),
      fromNetwork: false,
    };
  }
  const key = usageCacheKey(dir, target.email);
  const freshForMs = opts.freshForMs ?? USAGE_CACHE_TTL_MS;
  const network = opts._network ?? fetchUsageNetwork;

  const fromCache = (maxAgeMs: number): CoordinatedResult | null => {
    const fresh = getCachedSnap(key, maxAgeMs);
    return fresh
      ? { result: { ok: true, snap: { ...fresh, configDir: dir } }, fromNetwork: false }
      : null;
  };
  const bestEffort = (): CoordinatedResult => {
    logBackoffOnce(key);
    return {
      result: { ok: true, snap: { ...bestEffortSnap(dir, key), configDir: dir } },
      fromNetwork: false,
    };
  };

  if (!opts.forceNetwork) {
    const hit = fromCache(freshForMs);
    if (hit) return hit;
    if (inRateLimitBackoff(key)) return bestEffort();
  }

  // BOTH paths skip when the lock stays busy past capMs: without skipIfUnacquired,
  // withLockAsync falls back to running the section UNLOCKED — a manual refresh
  // during another window's slow fetch would run a second concurrent network call,
  // the exact double-fetch this coordinator exists to prevent. A skipped caller
  // serves the holder's result via the cache re-check below or the cache watcher.
  // The manual path just waits longer before giving up. staleMs > worst-case hold
  // (~50s: token refresh + usage + 401-retry) so a LIVE slow fetch is never
  // reclaimed mid-flight; a dead holder is PID-reclaimed instantly.
  const lockOpts = opts.forceNetwork
    ? { capMs: 15_000, stepMs: 250, staleMs: 120_000, skipIfUnacquired: true }
    : { capMs: 5_000, stepMs: 250, staleMs: 120_000, skipIfUnacquired: true };

  const { locked, result } = await withLockAsync(
    fetchLockFor(key),
    async (): Promise<CoordinatedResult> => {
      // Double-checked under the lock: the winner of the race we just lost may
      // have already written a fresh entry. Forced refreshes coalesce within
      // FORCE_COALESCE_MS (two humans clicking refresh in two windows = 1 call).
      const recheck = fromCache(opts.forceNetwork ? FORCE_COALESCE_MS : freshForMs);
      if (recheck) return recheck;
      if (!opts.forceNetwork && inRateLimitBackoff(key)) return bestEffort();
      const r = await network(dir, key);
      return { result: r, fromNetwork: true };
    },
    lockOpts
  );

  if (locked && result) return result as CoordinatedResult;
  // Lock stayed busy past capMs (poll or manual): the fetching window very likely
  // finished while we waited — serve its result; else last-known, and the cache
  // watcher repaints when the holder's write lands.
  return fromCache(freshForMs) ?? bestEffort();
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

export interface PolicyCache {
  version: 3;
  updatedAt: number;
  mode: 'off' | 'notify';
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
   * Longest prefix wins. Used for VS Code auto-bind.
   */
  workspaceRoutes: WorkspaceRoutePolicy[];
  accounts: PolicyAccount[];
}

/** Merge usage snapshots + workspace routes into the on-disk cross-window policy cache. */
export function writePolicyCache(opts: {
  mode: 'off' | 'notify';
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
      let prev: Partial<PolicyCache> = {};
      if (fs.existsSync(policyPath())) {
        try {
          prev = JSON.parse(fs.readFileSync(policyPath(), 'utf-8')) as PolicyCache;
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
      const policy: PolicyCache = {
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
      const prev = JSON.parse(fs.readFileSync(policyPath(), 'utf-8')) as PolicyCache;
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
  /**
   * In-memory snapshots keyed by usageCacheKey (email:… / dir:…) — the SAME
   * keying as the shared disk cache, so a snap fetched via the account store
   * resolves for a status bar asking about the window's workdir, and the disk
   * watcher can feed every account's entry into one map.
   */
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
  private mode: 'off' | 'notify' = 'notify';
  private workspaceRoutes: WorkspaceRoutePolicy[] = [];
  private nameByEmail: Record<string, string> = {};
  /** Map email → durable account store dir (not window workdir). */
  private storeDirForEmail?: (email: string) => string | undefined;
  private lastNotifyKey = '';
  /** Cache-file watcher state (readers see other windows' fetches within ~2.4s). */
  private cacheWatchTimer: NodeJS.Timeout | null = null;
  private watchingCache = false;
  private lastSeenFetchedAt = new Map<string, number>();

  /**
   * Carries this window's workdir grant into the account store when the workdir
   * holds the NEWER one (idempotent newest-wins; wired to refreshStore by the
   * extension). MANDATORY store-lag guard: usage fetches run against the STORE
   * token, and the CLI rotates the WORKDIR copy first — polling the store inside
   * that ~2.4s lag would POST an already-rotated-away refresh token and raise a
   * false "sign in again".
   */
  preSyncStore?: (email: string, workdir: string) => Promise<void>;

  /** Default poll cadence — matches USAGE_CACHE_TTL_MS. */
  constructor(private readonly intervalMs = USAGE_CACHE_TTL_MS) {}

  configure(opts: {
    thresholds?: FailoverThresholds;
    triggers?: FailoverTriggers;
    strategy?: FailoverStrategy;
    accountOrder?: string[];
    mode?: 'off' | 'notify';
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
  /** Optional pressure hook (extension gates on mode). */
  onHot?: (snap: UsageSnapshot, reasons: string[]) => void;

  /** Resolve all account stores to poll (email + durable dir). */
  listAccountsToPoll?: () => { email: string; dir: string; name?: string }[];

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  getCached(dir?: string): UsageSnapshot | null | undefined {
    return this.cache.get(usageCacheKey(resolveConfigDir(dir)));
  }

  /** Last-known snapshot per email (watcher-fed) — the tooltip table's rows. */
  getAllCachedByEmail(): Map<string, UsageSnapshot> {
    const out = new Map<string, UsageSnapshot>();
    for (const [key, snap] of this.cache) {
      if (snap && key.startsWith('email:')) out.set(key.slice('email:'.length), snap);
    }
    return out;
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
    // Fetch via the account STORE whenever one exists: one credentials file, one
    // lock, one extension-driven rotation source per account. The workdir copy
    // converges through the store-watch → restock chain; it is never the token
    // the poll refreshes. Unbound/unsaved windows keep the workdir path.
    const email = readIdentity(d)?.email ?? null;
    const store = email ? this.storeDirForEmail?.(email) : undefined;
    const fetchDir = store && path.normalize(store) !== path.normalize(d) ? store : d;
    const key = usageCacheKey(fetchDir, email);
    const inflightKey = forceNetwork ? `${key}#force` : key;
    const existing = this.inflight.get(inflightKey);
    if (existing) return existing;
    const p = (async (): Promise<UsageSnapshot | null> => {
      if (fetchDir !== d && email && hasCredentials(d)) {
        // Store-lag guard: never poll a store the CLI's rotation left behind.
        try {
          await this.preSyncStore?.(email, d);
        } catch (err) {
          log(`usage: pre-sync failed — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      let { result, fromNetwork } = await fetchUsageCoordinated(
        { dir: fetchDir, email },
        { forceNetwork }
      );
      if (
        !result.ok &&
        result.failure.kind === 'token_rejected' &&
        fetchDir !== d &&
        email &&
        hasCredentials(d)
      ) {
        // Store-lag race: the CLI can rotate the WORKDIR grant between our
        // pre-sync and the store POST, making the store's refresh token look
        // revoked. Carry the newer grant over and retry ONCE before surfacing —
        // a genuinely revoked account fails the retry too and still escalates.
        try {
          await this.preSyncStore?.(email, d);
        } catch (err) {
          log(`usage: retry pre-sync failed — ${err instanceof Error ? err.message : String(err)}`);
        }
        ({ result, fromNetwork } = await fetchUsageCoordinated(
          { dir: fetchDir, email },
          { forceNetwork }
        ));
      }
      if (!result.ok) {
        this.lastFailure = result.failure;
        // Keep last good in-memory gauge if any (do not blank on 429).
        if (!this.cache.get(key)) this.cache.set(key, null);
        this.emit();
        return null;
      }
      this.lastFailure = null;
      const snap = result.snap;
      // The disk-cache watcher owns lastSeenFetchedAt — deliberately NOT stamped
      // here: a wall-clock stamp taken after a racing window's write could mark
      // that GENUINELY NEWER entry as already-seen and freeze this window on
      // stale data for a whole tier. One redundant repaint per own fetch is the
      // cheap alternative.
      this.cache.set(key, snap);
      if (fromNetwork) {
        const forPolicy = store ? { ...snap, configDir: store } : snap;
        this.policyWrite([forPolicy]);
      }
      this.emitPressure(snap);
      this.emit();
      return snap;
    })().finally(() => {
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
    // Active account first — refresh() resolves the store, runs the pre-sync
    // guard, feeds the gauge, writes policy on a real fetch, and emits pressure.
    let activeEmail = '';
    if (this.currentDir) {
      activeEmail = (readIdentity(this.currentDir)?.email || '').trim().toLowerCase();
      await this.refresh(this.currentDir);
    }

    // Then every other saved account at the background tier. The shared fetch
    // lock + TTL-recheck make this ~one network call per account per tier
    // MACHINE-WIDE, no matter how many windows run this same loop.
    const listed = this.listAccountsToPoll?.() ?? [];
    const byEmail = new Map<string, { email: string; dir: string }>();
    for (const a of listed) {
      const em = (a.email || '').trim().toLowerCase();
      if (!em || em === activeEmail) continue;
      if (!a.dir || !fs.existsSync(a.dir) || !hasCredentials(a.dir)) continue;
      if (!byEmail.has(em)) byEmail.set(em, { email: a.email, dir: a.dir });
    }
    const netSnaps: UsageSnapshot[] = [];
    let changed = false;
    for (const a of byEmail.values()) {
      const { result, fromNetwork } = await fetchUsageCoordinated(
        { dir: a.dir, email: a.email },
        { freshForMs: BACKGROUND_TTL_MS }
      );
      if (!result.ok) {
        // Soft-fail: a background account must never raise the sign-in UI — its
        // store heals via reconcile and the next cycle retries. Only the active
        // account (refresh() above) escalates failures to lastFailure.
        log(`usage: background poll ${a.email}: ${result.failure.kind} — skipped`);
        continue;
      }
      const snap = { ...result.snap, email: result.snap.email || a.email };
      const key = usageCacheKey(a.dir, a.email);
      this.cache.set(key, snap); // watcher owns lastSeenFetchedAt (see refresh())
      changed = true;
      if (fromNetwork) netSnaps.push(snap);
    }
    if (netSnaps.length) this.policyWrite(netSnaps);
    if (changed) this.emit();
  }

  /**
   * Seed the in-memory map from the shared disk cache so the first paint after
   * activation shows last-known figures for EVERY account before any fetch runs.
   */
  private hydrateFromDisk(): void {
    for (const [key, entry] of Object.entries(readUsageCacheEntries())) {
      if (!entry?.snap || typeof entry.fetchedAt !== 'number') continue;
      this.lastSeenFetchedAt.set(key, entry.fetchedAt);
      if (!this.cache.get(key)) this.cache.set(key, entry.snap);
    }
  }

  /**
   * Readers' half of the central repository: watch the shared cache file and fold
   * advanced entries into memory, so a fetch by ANY window repaints every window
   * within ~2.4s (2s poll + debounce). Advance-only (fetchedAt must move); the
   * fetching window accepts one redundant repaint of its own write — the watcher
   * alone owns the latch, so a racing window's newer entry can never be missed.
   */
  private startCacheWatcher(): void {
    this.watchingCache = true;
    fs.watchFile(usageCachePath(), { interval: 2000 }, () => this.scheduleCacheRead());
  }

  private scheduleCacheRead(): void {
    if (this.cacheWatchTimer) clearTimeout(this.cacheWatchTimer);
    this.cacheWatchTimer = setTimeout(() => {
      this.cacheWatchTimer = null;
      if (!this.watchingCache) return;
      const advanced = diffCacheAdvances(readUsageCacheEntries(), this.lastSeenFetchedAt);
      if (!advanced.length) return;
      for (const { key, fetchedAt, snap } of advanced) {
        this.lastSeenFetchedAt.set(key, fetchedAt);
        this.cache.set(key, snap);
      }
      this.emit();
    }, 400);
  }

  private stopCacheWatcher(): void {
    this.watchingCache = false;
    if (this.cacheWatchTimer) {
      clearTimeout(this.cacheWatchTimer);
      this.cacheWatchTimer = null;
    }
    fs.unwatchFile(usageCachePath());
  }

  start(getDir: () => string | undefined): void {
    this.stop();
    this.hydrateFromDisk();
    this.startCacheWatcher();
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
          // that started together — e.g. a batch of windows reloaded at once — don't all
          // poll at the 60s cache boundary and stampede /api/oauth/usage into a 429.
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
    this.stopCacheWatcher();
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

/**
 * Pure diff of the shared cache against what a window has already seen — the
 * watcher folds in only entries whose fetchedAt ADVANCED, so identical rewrites
 * and a window's own just-recorded fetches never cause an extra repaint.
 */
export function diffCacheAdvances(
  entries: Record<string, { fetchedAt: number; snap: UsageSnapshot }>,
  lastSeen: ReadonlyMap<string, number>
): { key: string; fetchedAt: number; snap: UsageSnapshot }[] {
  const out: { key: string; fetchedAt: number; snap: UsageSnapshot }[] = [];
  for (const [key, entry] of Object.entries(entries)) {
    if (!entry?.snap || typeof entry.fetchedAt !== 'number') continue;
    if (entry.fetchedAt > (lastSeen.get(key) ?? 0)) {
      out.push({ key, fetchedAt: entry.fetchedAt, snap: entry.snap });
    }
  }
  return out;
}
