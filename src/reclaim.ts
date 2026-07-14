import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { log } from './log';
import { readIdentity, hasCredentials } from './accounts';
import { writeFileAtomic } from './fsSafe';

/**
 * Reclaiming sensitive data from a forgotten account.
 *
 * An account directory holds exactly ONE credential: `<dir>/.credentials.json`
 * (the OAuth access + refresh token). Everything else in the dir is either
 * identity/config (`.claude.json` — email/org, no token), rotating backups of
 * that config, or symlinks into the shared-history store. So "reclaim the
 * sensitive data" reduces to deleting that one file — which is exactly what
 * Claude Code's own `/logout` does (verified in its bundle: the credential
 * store's `delete()` unlinks `<CLAUDE_CONFIG_DIR>/.credentials.json`).
 *
 * A forceful forget deletes that token unconditionally, then interrupts any
 * live `claude` session still pointing at the dir so nothing keeps running on a
 * credential that no longer exists.
 */

/** The one sensitive file inside an account dir: the OAuth token. */
export function tokenPath(dir: string): string {
  return path.join(dir, '.credentials.json');
}

/**
 * The fingerprint a real `/logout` leaves in a dir: the token is gone and the
 * identity has been cleared from the config, but the config file itself is still
 * there. Distinguishes a genuine logout from a never-stocked dir (no config at
 * all) and from an interrupted copy (identity still present). Only decisive at
 * activation, where an in-flight OAuth sign-in — which also leaves the dir
 * tokenless — cannot be mistaken for it, because a sign-in cannot survive the
 * window reload. Restocking a dir in this state would resurrect a token the
 * server has already revoked.
 */
export function looksLikeLogout(dir: string): boolean {
  return (
    !hasCredentials(dir) && !readIdentity(dir) && fs.existsSync(path.join(dir, '.claude.json'))
  );
}

/**
 * Account state Claude Code's own `/logout` clears out of `.claude.json`,
 * alongside deleting the token. Deleting the token but LEAVING these behind
 * produces a half-signed-out dir that Claude Code never creates itself: it
 * still finds `oauthAccount`, believes it is signed in, renders "signed in" —
 * and never starts the OAuth flow, so login hangs. Mirroring the real logout
 * is what keeps the dir in a state Claude Code understands.
 *
 * Taken from the logout routine in Claude Code's bundle. `hasCompletedOnboarding`
 * / `seenNotifications` are deliberately NOT reset (the real logout does reset
 * them): they are onboarding UI state, not auth, and clearing them on the shared
 * default dir would throw every window back into the onboarding wizard.
 */
const CLEARED_ON_LOGOUT = [
  'oauthAccount',
  'additionalModelOptionsCache',
  'additionalModelCostsCache',
  'modelAccessCache',
  'orgModelDefaultCache',
  'lastSeenOrgDefaultUpdatedAt',
  'clientDataCache',
  'clientDataCacheSlots',
  'autoCompactWindowsCache',
] as const;

/**
 * The config file(s) holding a dir's account state. Named dirs keep it in
 * `<dir>/.claude.json`; the default `~/.claude` keeps its identity in the
 * home-root `~/.claude.json` instead — both must be cleared.
 */
function configFilesFor(dir: string): string[] {
  const files = [path.join(dir, '.claude.json')];
  if (path.normalize(dir) === path.normalize(path.join(os.homedir(), '.claude'))) {
    files.push(path.join(os.homedir(), '.claude.json'));
  }
  return files.filter((f) => fs.existsSync(f));
}

/**
 * Signs an account dir out the way Claude Code's `/logout` does: deletes the
 * OAuth token AND clears the account identity + its derived caches from the
 * config. Settings, backups and (shared) history are untouched — the dir stays,
 * it just no longer holds an account. Returns true if a token was removed.
 */
export function signOut(dir: string): boolean {
  let removed = false;
  const file = tokenPath(dir);
  try {
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
      removed = true;
    }
  } catch (err) {
    log(`signOut: could not delete token in ${dir}: ${(err as Error).message}`);
  }

  for (const cfg of configFilesFor(dir)) {
    try {
      const obj = JSON.parse(fs.readFileSync(cfg, 'utf-8')) as Record<string, unknown>;
      let touched = false;
      for (const key of CLEARED_ON_LOGOUT) {
        if (key in obj) {
          delete obj[key];
          touched = true;
        }
      }
      if (obj.hasAvailableSubscription !== undefined) {
        obj.hasAvailableSubscription = false;
        touched = true;
      }
      if (obj.subscriptionNoticeCount !== undefined) {
        obj.subscriptionNoticeCount = 0;
        touched = true;
      }
      if (!touched) continue;
      // Unique-temp atomic write: never leave a half-written config.
      writeFileAtomic(cfg, JSON.stringify(obj, null, 2), { mode: 0o600 });
      log(`signOut: cleared account state in ${cfg}`);
    } catch (err) {
      log(`signOut: could not clear ${cfg}: ${(err as Error).message}`);
    }
  }
  return removed;
}

const CLAUDE_CONFIG_DIR_PREFIX = 'CLAUDE_CONFIG_DIR=';

/** Normalized config dir a live process is running against, or null if not claude. */
function configDirForPid(pid: number | string): string | null {
  const defaultDir = path.normalize(path.join(os.homedir(), '.claude'));
  let comm: string;
  try {
    comm = fs.readFileSync(path.join('/proc', String(pid), 'comm'), 'utf-8').trim();
  } catch {
    return null; // process gone or not readable
  }
  if (comm !== 'claude') return null;
  let environ: string;
  try {
    environ = fs.readFileSync(path.join('/proc', String(pid), 'environ'), 'utf-8');
  } catch {
    return null;
  }
  const entry = environ.split('\0').find((e) => e.startsWith(CLAUDE_CONFIG_DIR_PREFIX));
  return entry ? path.normalize(entry.slice(CLAUDE_CONFIG_DIR_PREFIX.length)) : defaultDir;
}

/**
 * True when `/proc/<pid>` still looks like a `claude` process bound to `dir`.
 * Used right before SIGKILL so a recycled PID is not killed by mistake.
 */
function pidStillMapsToDir(pid: number, dir: string): boolean {
  const mapped = configDirForPid(pid);
  return mapped !== null && mapped === path.normalize(dir);
}

/**
 * Live `claude` processes grouped by the CLAUDE_CONFIG_DIR they run against,
 * read from /proc on Linux/WSL. A process with no CLAUDE_CONFIG_DIR uses the
 * default `~/.claude`. Returns an EMPTY map where /proc is unavailable (e.g.
 * native Windows/macOS). Keys are normalized for direct comparison.
 */
export function claudeSessionsByDir(): Map<string, number[]> {
  const byDir = new Map<string, number[]>();
  let pids: string[];
  try {
    pids = fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p));
  } catch {
    return byDir; // no /proc on this platform
  }
  for (const pid of pids) {
    const dir = configDirForPid(pid);
    if (!dir) continue;
    const list = byDir.get(dir) ?? [];
    list.push(Number(pid));
    byDir.set(dir, list);
  }
  return byDir;
}

/**
 * Interrupts every live `claude` session running against any of the given dirs,
 * so a forceful forget leaves no process alive on a just-deleted token. Uses
 * SIGKILL on purpose: on a graceful SIGTERM shutdown Claude Code flushes its
 * in-memory token back to `.credentials.json`, which would resurrect the very
 * file we're about to delete. Callers MUST call this BEFORE removeToken.
 * Returns the number of processes signalled. No-op where /proc is unavailable.
 */
export function interruptSessions(dirs: string[]): number {
  const targets = new Set(dirs.map((d) => path.normalize(d)));
  const byDir = claudeSessionsByDir();
  let killed = 0;
  for (const [dir, pids] of byDir) {
    if (!targets.has(dir)) continue;
    for (const pid of pids) {
      // Between scan and kill a PID can be recycled onto an unrelated process.
      if (!pidStillMapsToDir(pid, dir)) {
        log(`skipped pid=${pid} on ${dir}: recycled or no longer maps`);
        continue;
      }
      try {
        process.kill(pid, 'SIGKILL');
        killed++;
        log(`interrupted claude pid=${pid} on ${dir}`);
      } catch (err) {
        log(`could not signal pid=${pid}: ${(err as Error).message}`);
      }
    }
  }
  return killed;
}

/**
 * Every on-disk Claude data dir currently holding this account's token — the
 * default `~/.claude` (its identity lives in `~/.claude.json`) AND every named
 * `~/.claude-*` copy. Capturing an account snapshots its token into a named
 * dir but leaves the original in the source (often the default) dir, so the
 * SAME token can sit in several places. To truly sign an account out, forget
 * must clear the token from ALL of them, not just the registry copy.
 */
export function dirsHoldingToken(email: string): string[] {
  const home = os.homedir();
  const candidates = [path.join(home, '.claude')];
  try {
    for (const e of fs.readdirSync(home, { withFileTypes: true })) {
      if (e.isDirectory() && /^\.claude[-_]/.test(e.name)) {
        candidates.push(path.join(home, e.name));
      }
    }
  } catch {
    /* home unreadable — fall back to whatever we have */
  }
  return candidates.filter((d) => fs.existsSync(tokenPath(d)) && readIdentity(d)?.email === email);
}
