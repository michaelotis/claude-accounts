import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AuthStatus } from './cli';
import { AccountIdentity } from './accounts';

/**
 * Snapshots the account currently signed in inside `sourceDir` into a dedicated
 * account directory `targetDir`, copying auth token and identity TOGETHER from
 * the same source so they can never drift apart (the drift between
 * .credentials.json and .claude.json's oauthAccount is exactly what made the
 * old version show one account while billing another).
 *
 * Returns the paths written. Throws if the source has no credentials.
 */
export function snapshotAccount(
  sourceDir: string,
  targetDir: string,
  status: AuthStatus
): void {
  const srcCreds = path.join(sourceDir, '.credentials.json');
  if (!fs.existsSync(srcCreds)) {
    throw new Error(`No credentials found in ${sourceDir} — sign in first.`);
  }

  if (path.normalize(sourceDir) === path.normalize(targetDir)) {
    // Already the account's own directory; nothing to copy.
    ensureIdentity(targetDir, status);
    return;
  }

  // 0700: the dir holds an OAuth token. The token file itself is 0600, but a
  // world-listable directory still leaks which accounts exist on the machine.
  fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });

  // 1) Credentials — copy atomically (temp + rename).
  const dstCreds = path.join(targetDir, '.credentials.json');
  const tmpCreds = `${dstCreds}.tmp`;
  fs.copyFileSync(srcCreds, tmpCreds);
  fs.chmodSync(tmpCreds, 0o600);
  fs.renameSync(tmpCreds, dstCreds);

  // 2) Identity (.claude.json). Prefer the real source file; the default
  //    ~/.claude keeps its identity in ~/.claude.json (home) instead.
  const srcIdentity = firstExisting([
    path.join(sourceDir, '.claude.json'),
    isDefaultDir(sourceDir) ? path.join(os.homedir(), '.claude.json') : '',
  ]);
  const dstIdentity = path.join(targetDir, '.claude.json');
  if (srcIdentity) {
    const tmp = `${dstIdentity}.tmp`;
    fs.copyFileSync(srcIdentity, tmp);
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, dstIdentity);
  } else {
    writeMinimalIdentity(dstIdentity, status);
  }
  ensureIdentity(targetDir, status);
}

/** Makes sure oauthAccount in the target reflects `status` (best effort). */
function ensureIdentity(dir: string, status: AuthStatus): void {
  if (!status.email) return;
  const file = path.join(dir, '.claude.json');
  let obj: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try {
      obj = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      obj = {};
    }
  }
  const existing = (obj.oauthAccount as Record<string, unknown>) ?? {};
  if (existing.emailAddress === status.email) return; // already consistent
  obj.oauthAccount = {
    ...existing,
    emailAddress: status.email,
    organizationName: status.orgName ?? existing.organizationName,
  };
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), { mode: 0o600 });
}

function writeMinimalIdentity(file: string, status: AuthStatus): void {
  const obj = {
    oauthAccount: {
      emailAddress: status.email,
      displayName: status.email,
      organizationName: status.orgName,
    },
  };
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), { mode: 0o600 });
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
 * So the invariant is maintained continuously instead: at every reconcile, the
 * account in use is mirrored into the default dir. Remove the extension at ANY
 * instant, and Claude Code carries on as if it had never been there.
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
export function mirrorToDefault(sourceDir: string, identity: AccountIdentity | null): void {
  const defaultDir = defaultSourceDir();
  if (isDefaultDir(sourceDir)) return; // already is the default
  const srcToken = path.join(sourceDir, '.credentials.json');
  if (!fs.existsSync(srcToken)) return; // signed out — nothing to mirror

  try {
    const incoming = fs.readFileSync(srcToken);
    const dstToken = path.join(defaultDir, '.credentials.json');
    // Compare before writing: this runs on every focus change, and rewriting an
    // identical token would churn the file Claude Code watches.
    if (!fs.existsSync(dstToken) || !fs.readFileSync(dstToken).equals(incoming)) {
      fs.mkdirSync(defaultDir, { recursive: true, mode: 0o700 });
      const tmp = `${dstToken}.tmp`;
      fs.writeFileSync(tmp, incoming, { mode: 0o600 });
      fs.renameSync(tmp, dstToken); // atomic: a half-written token is worse than none
    }
    if (!identity) return;

    const cfg = path.join(os.homedir(), '.claude.json');
    let obj: Record<string, unknown> = {};
    try {
      obj = JSON.parse(fs.readFileSync(cfg, 'utf-8')) as Record<string, unknown>;
    } catch {
      obj = {}; // absent or unreadable — a fresh config with just the identity is fine
    }
    const current = obj.oauthAccount as { emailAddress?: string } | undefined;
    if (current?.emailAddress === identity.email) return; // already consistent
    obj.oauthAccount = {
      ...(current ?? {}),
      emailAddress: identity.email,
      displayName: identity.displayName,
      organizationName: identity.organizationName,
    };
    const tmp = `${cfg}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, cfg);
  } catch {
    // Best-effort: a failed mirror only means the default dir lags behind. The
    // extension itself keeps working — this is insurance for its absence.
  }
}
