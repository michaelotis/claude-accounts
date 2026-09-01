import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AuthStatus } from './cli';
import { AccountIdentity, readIdentity } from './accounts';
import { writeFileAtomic, copyFileAtomic, withLock } from './fsSafe';
import { foreignTokenConflict, tokenExpiry } from './workdir';
import { emailsEqual } from './workspaceRoutes';
import { log } from './log';

/**
 * Snapshots the account currently signed in inside `sourceDir` into a dedicated
 * account directory `targetDir`, copying auth token and identity TOGETHER from
 * the same source so they can never drift apart (the drift between
 * .credentials.json and .claude.json's oauthAccount is exactly what made the
 * old version show one account while billing another).
 *
 * Returns the paths written. Throws if the source has no credentials.
 */
export function snapshotAccount(sourceDir: string, targetDir: string, status: AuthStatus): void {
  const srcCreds = path.join(sourceDir, '.credentials.json');
  if (!fs.existsSync(srcCreds)) {
    throw new Error(`No credentials found in ${sourceDir} — sign in first.`);
  }

  // Contamination tripwire: never mint/refill a store from a token that already
  // belongs to a DIFFERENT account. Without this, a working dir whose identity
  // drifted from its token (or a restore-forgotten of an email whose dir holds a
  // foreign token) would snapshot one account's credential under another's name.
  const conflict = foreignTokenConflict(targetDir, fs.readFileSync(srcCreds), status.email);
  if (conflict) {
    throw new Error(
      `Refusing to save ${status.email ?? 'this account'} from ${sourceDir}: that token already ` +
        `belongs to ${conflict}. Sign in as ${status.email ?? 'the intended account'} first.`
    );
  }

  if (path.normalize(sourceDir) === path.normalize(targetDir)) {
    // Already the account's own directory; nothing to copy.
    ensureIdentity(targetDir, status);
    return;
  }

  // 0700: the dir holds an OAuth token. The token file itself is 0600, but a
  // world-listable directory still leaks which accounts exist on the machine.
  fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });

  // 1) Credentials — unique-temp atomic copy (safe across windows).
  const dstCreds = path.join(targetDir, '.credentials.json');
  copyFileAtomic(srcCreds, dstCreds, 0o600);

  // 2) Identity (.claude.json). Prefer the real source file; the default
  //    ~/.claude keeps its identity in ~/.claude.json (home) instead.
  const srcIdentity = firstExisting([
    path.join(sourceDir, '.claude.json'),
    isDefaultDir(sourceDir) ? path.join(os.homedir(), '.claude.json') : '',
  ]);
  const dstIdentity = path.join(targetDir, '.claude.json');
  if (srcIdentity) {
    copyFileAtomic(srcIdentity, dstIdentity, 0o600);
  } else {
    writeMinimalIdentity(dstIdentity, status);
  }
  ensureIdentity(targetDir, status);
}

/**
 * Rewrites a dir's `.claude.json` oauthAccount to `identity`, leaving the token
 * and every other key untouched. Returns false — and leaves the file
 * byte-identical — when the file cannot be read or is not a JSON object;
 * callers must not report the drift as repaired on false. Used to correct an identity-only bleed — a dir
 * that still HOLDS the right account's token but whose identity field was
 * re-stamped (e.g. by Claude Code from the shared home config) — without pulling
 * or pushing any credential.
 */
export function stampIdentity(dir: string, identity: AccountIdentity): boolean {
  const file = path.join(dir, '.claude.json');
  const obj = readDirIdentityJson(file);
  if (obj === null) return false;
  // REPLACE oauthAccount wholesale rather than merge: a bled identity may have left
  // a different account's uuid / displayName / org fields, and a merge would keep
  // them. The token is untouched.
  obj.oauthAccount = {
    emailAddress: identity.email,
    displayName: identity.displayName,
    organizationName: identity.organizationName,
  };
  writeFileAtomic(file, JSON.stringify(obj, null, 2), { mode: 0o600 });
  return true;
}

/** Makes sure oauthAccount in the target reflects `status` (best effort). */
export function ensureIdentity(dir: string, status: AuthStatus): boolean {
  if (!status.email) return false;
  const file = path.join(dir, '.claude.json');
  const obj = readDirIdentityJson(file);
  if (obj === null) return false;
  const existing = (obj.oauthAccount as Record<string, unknown>) ?? {};
  if (existing.emailAddress === status.email) return true; // already consistent
  obj.oauthAccount = {
    ...existing,
    emailAddress: status.email,
    organizationName: status.orgName ?? existing.organizationName,
  };
  writeFileAtomic(file, JSON.stringify(obj, null, 2), { mode: 0o600 });
  return true;
}

/**
 * Parse a window's `.claude.json`. ENOENT starts from `{}`; any other read/parse
 * error returns null so callers can refuse to write — a transient parse failure
 * must not replace a real config (project trust, MCP servers) with a stub.
 * A parsed null / array / non-object is the same refusal: JSON.parse accepts
 * them, but merging oauthAccount into one would rewrite a file we do not own.
 */
function readDirIdentityJson(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      log(`identity: ${file} is not a JSON object — not rewriting it`);
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    log(`identity: ${file} unreadable — not rewriting it`);
    return null;
  }
}

function writeMinimalIdentity(file: string, status: AuthStatus): void {
  const obj = {
    oauthAccount: {
      emailAddress: status.email,
      displayName: status.email,
      organizationName: status.orgName,
    },
  };
  writeFileAtomic(file, JSON.stringify(obj, null, 2), { mode: 0o600 });
}

function firstExisting(paths: string[]): string | null {
  for (const p of paths) if (p && fs.existsSync(p)) return p;
  return null;
}

function isDefaultDir(dir: string): boolean {
  return path.normalize(dir) === path.normalize(path.join(os.homedir(), '.claude'));
}

/** Default source dir when a window isn't bound to a named account yet. */
export function defaultSourceDir(): string {
  return path.join(os.homedir(), '.claude');
}

/**
 * Keeps Claude Code's OWN default account (`~/.claude`) signed in as the account
 * this machine last used.
 *
 * Why this exists: without it, the host is broken the moment we stop pointing at
 * it. `CLAUDE_CONFIG_DIR` disappears with the extension, Claude Code falls back to
 * `~/.claude` — and finds no token there, because every token lives in a directory
 * only this extension knows about. The user uninstalls a companion extension and
 * their Claude Code is signed out.
 *
 * The uninstall hook cannot fix that: VSCode defers it to the next SERVER start,
 * so between uninstalling and fully restarting VSCode there is a window — possibly
 * a long one — where Claude Code simply doesn't work. And the hook may never run at
 * all. A promise this important cannot rest on it.
 *
 * `~/.claude` follows the last explicitly chosen account (Switch Account, Save, a
 * real in-window /login). Passive reconcile only refills an empty default or
 * refreshes the same account with a newer grant — never flips between saved
 * accounts. A named token-less default is refilled only by that account, counting
 * five minutes from when this process first saw the token missing (so a live
 * `claude /login` that still names the account is not overwritten). The default
 * tracks the newest grant: any byte change is a candidate, and byte-identical is
 * the only skip. A token is
 * never stamped without the identity read from the same source dir (token first,
 * then identity). An unreadable ~/.claude.json is never overwritten. Remove the
 * extension at ANY instant, and Claude Code carries on as that last chosen
 * account.
 *
 * This is not "a token in one more place": `~/.claude/.credentials.json` is exactly
 * where Claude Code keeps its token with no extension installed at all — the
 * canonical location, not a new exposure. Forgetting an account still clears it
 * from here too (see dirsHoldingToken).
 *
 * Identity goes to `~/.claude.json` at the HOME ROOT, not into the dir: that is
 * where vanilla Claude Code reads it from (verified — a CLAUDE_CONFIG_DIR account
 * keeps it inside the dir instead, and writing it there would leave the default
 * account signed in with no name).
 */
export function mirrorToDefault(sourceDir: string, opts: { takeover?: boolean } = {}): boolean {
  const defaultDir = defaultSourceDir();
  if (isDefaultDir(sourceDir)) return false; // already is the default

  const takeover = !!opts.takeover;
  try {
    // Token first, then identity, both from sourceDir: the pair stamped into
    // ~/.claude must come from one place. Reading identity at the call site is
    // what let a takeover pair a new token with a stale (or null) name.
    const srcToken = path.join(sourceDir, '.credentials.json');
    let incoming: Buffer;
    try {
      incoming = fs.readFileSync(srcToken);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // Even with nothing to mirror, a default that holds a token ends any
        // open absence episode: the clock must only ever measure a token-less
        // stretch, or a stale `since` from an earlier gap would let a later
        // reconcile refill over a live same-account login early.
        if (fs.existsSync(path.join(defaultDir, '.credentials.json'))) clearAbsenceEpisode();
        lastMirrorSkipReason = 'source has no token';
        logDecision(`mirror: ${sourceDir} has no token — nothing to mirror`, takeover);
        return false;
      }
      throw err;
    }
    const identity = readIdentity(sourceDir);
    if (!identity?.email) {
      lastMirrorSkipReason = 'source has no identity';
      logDecision(`mirror: ${sourceDir} has a token but no identity — not mirroring`, takeover);
      return false;
    }

    // Fill of an empty default used to have no single writer: after Forget/logout
    // every bound window could wake and write, and token/identity are two files,
    // so two windows could leave token(A)+name(B).
    const outcome = withLock(
      path.join(defaultDir, '.credentials.json.lock'),
      () => mirrorUnderLock(defaultDir, incoming, identity, takeover, sourceDir),
      { capMs: takeover ? 2_000 : 500, stepMs: 15, skipIfUnacquired: true }
    );
    if (outcome === undefined) {
      lastMirrorSkipReason = 'default dir busy';
      logDecision('mirror: default dir busy (another window is mirroring) — skipped', takeover);
      return false;
    }
    return outcome;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    lastMirrorSkipReason = message;
    log(
      `mirror${takeover ? ' (takeover)' : ''}: could not update ~/.claude from ${sourceDir}: ${message}`
    );
    return false;
  }
}

function mirrorUnderLock(
  defaultDir: string,
  incoming: Buffer,
  identity: AccountIdentity,
  takeover: boolean,
  sourceDir: string
): boolean {
  const dstToken = path.join(defaultDir, '.credentials.json');
  let current: Buffer | undefined;
  try {
    current = fs.readFileSync(dstToken);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      const message = err instanceof Error ? err.message : String(err);
      lastMirrorSkipReason = 'could not read default token';
      logDecision(`mirror: could not read default token (${message}) — not mirroring`, takeover);
      return false;
    }
  }

  // A present token always ends the absence episode, even when we then refuse
  // to write because ~/.claude.json is unreadable.
  if (current) {
    clearAbsenceEpisode();
  }

  const h = homeRootIdentity();
  // Never write a token whose name cannot be verified/stamped — including takeover.
  if (h.unreadable) {
    lastMirrorSkipReason = '~/.claude.json unreadable';
    logDecision('mirror: ~/.claude.json unreadable — not mirroring', takeover);
    return false;
  }

  let tokenWritten = false;
  const writeToken = (successMsg: string): void => {
    beforeTokenWrite?.();
    fs.mkdirSync(defaultDir, { recursive: true, mode: 0o700 });
    // Unique-temp atomic write: a half-written token is worse than none.
    writeFileAtomic(dstToken, incoming, { mode: 0o600 });
    tokenWritten = true;
    loggedPassive.clear();
    clearAbsenceEpisode();
    logDecision(successMsg, takeover);
  };

  if (takeover) {
    const inExp = tokenExpiry(incoming);
    const curExp = current ? tokenExpiry(current) : null;
    if (current && current.equals(incoming)) {
      // Byte-identical is the only skip — a same-account access-token rotation
      // must still land; the default tracks the newest grant.
    } else if (
      current &&
      emailsEqual(h.email, identity.email) &&
      inExp != null &&
      curExp != null &&
      inExp < curExp
    ) {
      log(
        `mirror (takeover): default already holds a newer grant for ${identity.email} — keeping it`
      );
    } else {
      writeToken(`mirror (takeover): default now runs ${identity.email} from ${sourceDir}`);
    }
  } else if (!current) {
    if (!h.email) {
      writeToken(`mirror: default was empty — filled with ${identity.email}`);
    } else if (!emailsEqual(h.email, identity.email)) {
      lastMirrorSkipReason = 'only that account may refill it';
      logDecision(
        `mirror: default is token-less and names ${h.email} — only that account may refill it`,
        false
      );
      return false;
    } else {
      // Token-less + named is an external `claude /login` mid-OAuth (Claude
      // Code deletes the token first). Bounded at 5 minutes; any passive
      // caller whose account matches the name may refill. Clock starts when
      // THIS process first observed the token missing — ~/.claude.json's
      // mtime is typically hours old by then.
      const key = h.email.toLowerCase();
      const now = Date.now();
      let since = tokenlessSince.get(key);
      if (since === undefined) {
        since = now;
        tokenlessSince.set(key, since);
      }
      const elapsed = now - since;
      if (elapsed > MID_OAUTH_ABANDON_MS) {
        writeToken(
          `mirror: default has been token-less with identity ${h.email} for >${MID_OAUTH_ABANDON_MS / 1000}s — refilling`
        );
      } else {
        lastMirrorSkipReason = 'mid-OAuth';
        logDecision(
          `mirror: default is token-less but still names ${h.email} — not refilling (mid-OAuth)`,
          false
        );
        if (!tokenlessTimerArmed.has(key)) {
          scheduleReCheck(key, sourceDir, h.email, MID_OAUTH_ABANDON_MS - elapsed + 1000);
        }
        return false;
      }
    }
  } else if (current.equals(incoming)) {
    // Already the incoming bytes: identity step only.
  } else if (!h.email) {
    const inExp = tokenExpiry(incoming);
    const curExp = tokenExpiry(current);
    if (inExp != null && (curExp == null || inExp > curExp)) {
      writeToken(`mirror: default was unnamed — adopting ${identity.email}`);
    } else if (inExp == null) {
      lastMirrorSkipReason = 'incoming grant has no parseable expiry';
      logDecision(
        `mirror: incoming grant for ${identity.email} has no parseable expiry — not adopting unnamed default`,
        false
      );
      return false;
    } else {
      lastMirrorSkipReason = 'incoming grant is not newer';
      logDecision(
        `mirror: incoming grant for ${identity.email} is not newer than the unnamed default — keeping it`,
        false
      );
      return false;
    }
  } else if (!emailsEqual(h.email, identity.email)) {
    lastMirrorSkipReason = 'passive mirror declined';
    logDecision(
      `mirror: default holds ${h.email}, not ${identity.email} — passive mirror declined`,
      false
    );
    return false;
  } else {
    const inExp = tokenExpiry(incoming);
    const curExp = tokenExpiry(current);
    if (inExp == null) {
      lastMirrorSkipReason = 'incoming grant has no parseable expiry';
      logDecision(
        `mirror: incoming grant for ${identity.email} has no parseable expiry — not refreshing`,
        false
      );
      return false;
    }
    if (!(curExp == null || inExp > curExp)) {
      lastMirrorSkipReason = 'incoming grant is not newer';
      logDecision(
        `mirror: incoming grant for ${identity.email} is not newer — keeping default`,
        false
      );
      return false;
    }
    writeToken(`mirror: refreshed default grant for ${identity.email}`);
  }

  return stampHomeIdentity(identity, takeover, tokenWritten, dstToken);
}

/**
 * Stamp ~/.claude.json. Classification already used a single read (`h`); this
 * re-reads immediately before writing. Claude Code writes this file itself and
 * the extension takes no lock it honours, so the re-read keeps the lost-update
 * window to microseconds instead of spanning the whole token write.
 */
function stampHomeIdentity(
  identity: AccountIdentity,
  takeover: boolean,
  tokenWritten: boolean,
  dstToken: string
): boolean {
  const cfg = path.join(os.homedir(), '.claude.json');
  beforeIdentityWrite?.();

  let obj: Record<string, unknown>;
  try {
    const raw = fs.readFileSync(cfg, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return failIdentityWrite(identity, takeover, tokenWritten, dstToken, 'not a JSON object');
    }
    obj = parsed as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      obj = {};
    } else {
      const message = err instanceof Error ? err.message : String(err);
      return failIdentityWrite(identity, takeover, tokenWritten, dstToken, message);
    }
  }

  const existing = (obj.oauthAccount as Record<string, unknown>) ?? {};
  if (emailsEqual(existing.emailAddress as string | undefined, identity.email)) {
    return true;
  }
  const old =
    typeof existing.emailAddress === 'string' && existing.emailAddress
      ? existing.emailAddress
      : 'unnamed';
  obj.oauthAccount = {
    ...existing,
    emailAddress: identity.email,
    displayName: identity.displayName,
    organizationName: identity.organizationName,
  };
  try {
    writeFileAtomic(cfg, JSON.stringify(obj, null, 2), { mode: 0o600 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failIdentityWrite(identity, takeover, tokenWritten, dstToken, message);
  }
  loggedPassive.clear();
  logDecision(`mirror: ~/.claude.json now names ${identity.email} (was ${old})`, takeover);
  return true;
}

function failIdentityWrite(
  identity: AccountIdentity,
  takeover: boolean,
  tokenWritten: boolean,
  dstToken: string,
  message: string
): false {
  lastMirrorSkipReason = 'could not update ~/.claude.json';
  if (tokenWritten) {
    try {
      fs.rmSync(dstToken, { force: true });
    } catch {
      /* best effort — the log still reports the mixed pair was refused */
    }
    log(
      `mirror: wrote the token for ${identity.email} but could not update ~/.claude.json (${message}) — removed the token again so the default is not left under the wrong name`
    );
  } else {
    logDecision(`mirror: could not update ~/.claude.json (${message})`, takeover);
  }
  return false;
}

/** Claude Code deletes the token first during /login; after this the login is abandoned. */
const DEFAULT_MID_OAUTH_ABANDON_MS = 5 * 60 * 1000;
let MID_OAUTH_ABANDON_MS = DEFAULT_MID_OAUTH_ABANDON_MS;
const RECHECK_RETRY_MS = 250;
const RECHECK_ATTEMPTS_CAP = 3;

/** First time THIS process saw the default token missing for a named account. */
const tokenlessSince = new Map<string, number>();
const tokenlessTimerArmed = new Set<string>();
const tokenlessAttempts = new Map<string, number>();
const tokenlessTimers: ReturnType<typeof setTimeout>[] = [];
let lastMirrorSkipReason: string | undefined;
let beforeIdentityWrite: (() => void) | undefined;
let beforeTokenWrite: (() => void) | undefined;

/** Test seam: the abandon window is 5 min in production. */
export function _setMidOauthAbandonMs(ms: number): void {
  MID_OAUTH_ABANDON_MS = ms;
  clearAbsenceEpisode();
}

/** Test seam: run between classification and the identity re-read. */
export function _setBeforeIdentityWrite(fn: (() => void) | undefined): void {
  beforeIdentityWrite = fn;
}

/** Test seam: run immediately before the token write. */
export function _setBeforeTokenWrite(fn: (() => void) | undefined): void {
  beforeTokenWrite = fn;
}

function scheduleReCheck(key: string, sourceDir: string, email: string, delay: number): void {
  tokenlessTimerArmed.add(key);
  const t = setTimeout(() => {
    const idx = tokenlessTimers.indexOf(t);
    if (idx !== -1) tokenlessTimers.splice(idx, 1);
    tokenlessTimerArmed.delete(key);
    const ok = mirrorToDefault(sourceDir);
    if (ok) return;
    // The mid-OAuth path may have armed a fresh timer; don't stack another.
    if (tokenlessTimerArmed.has(key)) return;
    const n = (tokenlessAttempts.get(key) ?? 0) + 1;
    tokenlessAttempts.set(key, n);
    const reason = lastMirrorSkipReason ?? 'unknown';
    if (n < RECHECK_ATTEMPTS_CAP) {
      logDecision(
        `mirror: re-check for ${email} could not run (${reason}) — will try once more`,
        false
      );
      scheduleReCheck(key, sourceDir, email, RECHECK_RETRY_MS);
    } else {
      logDecision(
        `mirror: re-check for ${email} could not run (${reason}) — giving up until the next reconcile`,
        false
      );
    }
  }, delay);
  if (typeof t.unref === 'function') t.unref();
  tokenlessTimers.push(t);
}

export function disposeMirrorTimers(): void {
  clearAbsenceEpisode();
}

function clearAbsenceEpisode(): void {
  tokenlessSince.clear();
  tokenlessTimerArmed.clear();
  tokenlessAttempts.clear();
  for (const t of tokenlessTimers) clearTimeout(t);
  tokenlessTimers.length = 0;
}

const loggedPassive = new Map<string, number>();
const LOG_THROTTLE_MS = 10 * 60 * 1000;

function logDecision(msg: string, always: boolean): void {
  if (always) {
    log(msg);
    return;
  }
  const last = loggedPassive.get(msg);
  const now = Date.now();
  if (last !== undefined && now - last <= LOG_THROTTLE_MS) return;
  loggedPassive.set(msg, now);
  log(last !== undefined ? `${msg} (repeated)` : msg);
}

/**
 * oauthAccount from ~/.claude.json, parsed once. `unreadable` is true only when
 * the file exists but cannot be read/parsed or is not a JSON object (null,
 * array, scalar) — ENOENT is a clean empty default,
 * not an error, and must not be confused with a corrupt config (fail closed).
 * Classification uses this single read (email + unreadable); the identity write
 * re-reads so a concurrent Claude Code update is not clobbered.
 */
function homeRootIdentity(): {
  email?: string;
  unreadable: boolean;
} {
  const file = path.join(os.homedir(), '.claude.json');
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { unreadable: false };
    return { unreadable: true };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { unreadable: true };
    }
    const obj = parsed as Record<string, unknown>;
    const oauth = obj.oauthAccount as { emailAddress?: unknown } | undefined;
    const addr =
      oauth && typeof oauth === 'object' && !Array.isArray(oauth) ? oauth.emailAddress : undefined;
    const email = typeof addr === 'string' && addr ? addr : undefined;
    return { email, unreadable: false };
  } catch {
    return { unreadable: true };
  }
}
