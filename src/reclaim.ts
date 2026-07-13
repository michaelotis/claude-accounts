import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { log } from './log';
import { readIdentity } from './accounts';

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
      const tmp = `${cfg}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, cfg); // atomic: never leave a half-written config
      log(`signOut: cleared account state in ${cfg}`);
    } catch (err) {
      log(`signOut: could not clear ${cfg}: ${(err as Error).message}`);
    }
  }
  return removed;
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
  const defaultDir = path.normalize(path.join(os.homedir(), '.claude'));
  const PREFIX = 'CLAUDE_CONFIG_DIR=';
  for (const pid of pids) {
    let comm: string;
    try {
      comm = fs.readFileSync(path.join('/proc', pid, 'comm'), 'utf-8').trim();
    } catch {
      continue; // process gone or not ours
    }
    if (comm !== 'claude') continue;
    let environ: string;
    try {
      environ = fs.readFileSync(path.join('/proc', pid, 'environ'), 'utf-8');
    } catch {
      continue;
    }
    const entry = environ.split('\0').find((e) => e.startsWith(PREFIX));
    const dir = entry ? path.normalize(entry.slice(PREFIX.length)) : defaultDir;
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
  return candidates.filter(
    (d) => fs.existsSync(tokenPath(d)) && readIdentity(d)?.email === email
  );
}
