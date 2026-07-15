import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { isDeepStrictEqual } from 'util';
import { Account, readIdentity, hasCredentials } from './accounts';
import { isReservedClaudeDirName } from './sidecars';
import { log } from './log';
import { writeFileAtomic, copyFileAtomic, withLockAsync } from './fsSafe';

/**
 * Per-window working directories.
 *
 * Why windows must never share a directory
 * ───────────────────────────────────────
 * Claude Code writes a `/login` straight into the window's CLAUDE_CONFIG_DIR,
 * deleting whatever account was there first. If two windows point at the SAME
 * dir, a sign-in in one silently rewrites the other window's account — and worse,
 * nothing on disk records WHICH window did it, so no logic can tell them apart.
 * Every heuristic for "which window signed in" (window focus, timing) is a guess,
 * and during OAuth the focus is on the browser anyway.
 *
 * So: each window gets a working dir of its own, and an account's dir becomes
 * purely a store to copy from. Two consequences fall out for free:
 *
 *   • a sign-in can only ever affect the window it happened in;
 *   • "which window signed in?" is answered by construction — the one whose
 *     working dir changed hands. No heuristics, no shared state, no races.
 *
 * The duplicated credentials this implies are safe, and that is not an
 * assumption: verified against the live API that copies of a token authenticate
 * independently, and that refreshing one does not invalidate the other.
 */

/** workspaceState key holding this window's working-dir id (folderless windows). */
const WINDOW_ID_KEY = 'claudeProfiles.windowId';

/** Parent of all working dirs. Holds no account of its own, so discovery skips it. */
export function workingRoot(): string {
  return path.join(os.homedir(), '.claude-windows');
}

/**
 * This window's working dir. Derived from the window's WORKSPACE IDENTITY, so
 * reopening a project lands on the same dir (and keeps its Claude Code project
 * settings); a folderless window falls back to an id minted once and kept in
 * workspaceState.
 *
 * Identity is the `.code-workspace` file when there is one, and the first folder
 * otherwise — deliberately, because that is precisely what VSCode refuses to open
 * twice: ask for a folder or a workspace that is already open and it focuses the
 * existing window instead of making a second one. Keying on it therefore hands
 * every window a dir of its own, which is the invariant this whole file exists to
 * uphold.
 *
 * Keying on the first FOLDER alone (as before) broke that: a folder opened
 * directly and a `.code-workspace` containing that same folder are two windows
 * with one first-folder path — so they shared a working dir, and binding one to
 * a second account overwrote the other's token. That is the very failure this
 * design was built to make impossible, sneaking back in through the key.
 *
 * Read synchronously — it runs during activation, before Claude Code reads the
 * env, and that race is the whole reason this extension works at all.
 */
export function windowWorkingDir(context: vscode.ExtensionContext): string {
  const identity =
    vscode.workspace.workspaceFile?.toString() ??
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (identity) {
    const id = crypto.createHash('sha1').update(identity).digest('hex').slice(0, 12);
    return path.join(workingRoot(), id);
  }
  let id = context.workspaceState.get<string>(WINDOW_ID_KEY);
  if (!id) {
    id = crypto.randomBytes(6).toString('hex');
    void context.workspaceState.update(WINDOW_ID_KEY, id); // async is fine: the id is stable
  }
  return path.join(workingRoot(), id);
}

/**
 * Makes `workingDir` run `account`, copying the credentials and config out of the
 * account's store.
 *
 * Two things it must NOT do:
 *
 *   • Re-stock a dir that already runs this account. Its working copy may have
 *     refreshed its token since, and overwriting it with the older stored one
 *     would throw that away for nothing.
 *   • Re-stock a dir that EXISTS but has no token, unless explicitly forced. That
 *     is the fingerprint of a `/logout` in this window, and refilling it would
 *     resurrect the window as signed-in — on a token the logout just had REVOKED
 *     server-side. The window would look fine and fail on its first request, and
 *     the logout would never be noticed at all. `force` is for an explicit switch,
 *     where stocking an empty dir is exactly what the user asked for.
 */
export function materialize(account: Account, workingDir: string, force = false): boolean {
  const exists = fs.existsSync(workingDir);
  if (exists && !hasCredentials(workingDir) && !force) return false; // emptied by a logout
  if (hasCredentials(workingDir) && readIdentity(workingDir)?.email === account.email) {
    // Same account already. Without force, never churn (the dir's copy may hold a
    // newer refreshed token). WITH force, still skip only when the GRANT also
    // matches — a forced restock must overwrite a dir that wears this account's
    // identity but holds a DIFFERENT (foreign/mismatched) token, or a re-assert
    // could never repair such a mix.
    if (!force) return false;
    try {
      const dirTok = fs.readFileSync(path.join(workingDir, '.credentials.json'));
      const storeTok = fs.readFileSync(path.join(account.dir, '.credentials.json'));
      if (sameCredential(dirTok, storeTok)) return false;
    } catch {
      return false; // can't compare — leave the dir as-is rather than risk churn
    }
  }
  try {
    fs.mkdirSync(workingDir, { recursive: true, mode: 0o700 });
    copyFile(
      path.join(account.dir, '.credentials.json'),
      path.join(workingDir, '.credentials.json')
    );
    // The config carries the account's identity AND its per-project state (folder
    // trust, allowed tools, MCP servers), so an account keeps those wherever it runs.
    copyFile(path.join(account.dir, '.claude.json'), path.join(workingDir, '.claude.json'));
    // Contract: true only when the dir actually runs this account (has a token).
    // copyFileAtomic no-ops when the store lacks credentials, so check afterward.
    if (!hasCredentials(workingDir)) {
      log(`workdir: ${workingDir} has no credentials after stock from ${account.name}`);
      return false;
    }
    log(`workdir: ${workingDir} now runs ${account.email ?? account.name}`);
    return true;
  } catch (err) {
    log(`workdir: could not stock ${workingDir} with ${account.name}: ${(err as Error).message}`);
    return false;
  }
}

/**
 * A stable fingerprint identifying which ACCOUNT a `.credentials.json` belongs to,
 * independent of JSON key order, whitespace, or volatile fields like `expiresAt`
 * and the rotating access token. Two files carrying the same account's grant
 * fingerprint equal even after an access-token refresh; different accounts differ.
 * Falls back to the raw bytes when the buffer isn't the expected token JSON.
 */
export function credentialFingerprint(buf: Buffer): string {
  try {
    const d = JSON.parse(buf.toString('utf-8')) as {
      claudeAiOauth?: { refreshToken?: string; accessToken?: string };
      refreshToken?: string;
      accessToken?: string;
    };
    const o = d.claudeAiOauth ?? d;
    // Fingerprint on the REFRESH token: it is the stable, account-identifying
    // secret shared by every copy of a grant, and the one a /logout revokes. The
    // ACCESS token rotates in place on every refresh (per-dir, and by Claude Code
    // itself), so keying on it would make two copies of the SAME account's grant
    // look like different accounts the moment either refreshed — letting a
    // refreshed copy slip past the contamination guard.
    const rt = o?.refreshToken ?? d.refreshToken;
    if (rt) return `rt:${rt}`;
    const at = o?.accessToken ?? d.accessToken;
    if (at) return `at:${at}`;
  } catch {
    /* not token JSON — fall through to raw bytes */
  }
  return `raw:${buf.toString('base64')}`;
}

/** True when two credential buffers carry the same underlying OAuth grant. */
export function sameCredential(a: Buffer, b: Buffer): boolean {
  return credentialFingerprint(a) === credentialFingerprint(b);
}

/**
 * The access-token expiry (ms since epoch) recorded in a `.credentials.json`, or
 * null when it is absent/unparseable. Used to decide which of two grants for the
 * SAME account is the freshest — a refresh mints a new expiry, so the higher one
 * is the more recently refreshed grant.
 */
export function tokenExpiry(buf: Buffer): number | null {
  try {
    const d = JSON.parse(buf.toString('utf-8')) as {
      claudeAiOauth?: { expiresAt?: number };
      expiresAt?: number;
    };
    const e = d.claudeAiOauth?.expiresAt ?? d.expiresAt;
    return typeof e === 'number' ? e : null;
  } catch {
    return null;
  }
}

/**
 * True when `candidate` is a STRICTLY-OLDER, DIFFERENT grant than `reference` —
 * i.e. `reference` is the fresher of two grants for one account.
 *
 * Used by reconcile to refuse propagating a stale grant: when two windows run the
 * same account, each holds a copy of the store's grant; when either refreshes,
 * Anthropic rotates the refresh token, so the copies diverge into a newer grant
 * (the one that refreshed) and one or more older, now-dead ones. "Same account,
 * different refresh token, older expiry" is exactly that stale copy — and never a
 * legitimate state to mirror into ~/.claude. The same-lineage case (`sameCredential`,
 * e.g. an access-token refresh in place) is NOT stale; nor is an equal/newer expiry.
 */
export function isStaleAgainstStore(candidate: Buffer, reference: Buffer): boolean {
  if (sameCredential(candidate, reference)) return false;
  const c = tokenExpiry(candidate);
  const r = tokenExpiry(reference);
  return c != null && r != null && r > c;
}

/**
 * Cross-account contamination tripwire. Returns the path of another account
 * store that already holds this exact OAuth grant under a DIFFERENT identity, or
 * null.
 *
 * Two accounts can never legitimately share one OAuth grant, so a token about to
 * be written into account A's store that already lives in account B's store is
 * the signature of the credential mix that once left every account sharing a
 * single token (one account's `/logout` then killing them all). Same-email
 * duplicate stores DO legitimately share a grant, so an identity match never
 * conflicts.
 *
 * Fails CLOSED: if the target store's own identity can't be read (corrupt/absent
 * `.claude.json`), the caller passes the account's known email as `targetEmail`;
 * and when another store owns the grant under a known email while the target's is
 * unknown, that is still treated as a conflict — the mix must not slip through an
 * unreadable identity file.
 */
export function foreignTokenConflict(
  targetStoreDir: string,
  token: Buffer,
  targetEmail?: string
): string | null {
  const home = os.homedir();
  const wantEmail = (readIdentity(targetStoreDir)?.email ?? targetEmail)?.trim().toLowerCase();
  const wantFp = credentialFingerprint(token);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(home, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory() || !/^\.claude[-_]/.test(e.name)) continue;
    // Skip extension internals and Docker/tool sidecars — they are not managed
    // accounts, and one legitimately holding a copied token must not read as a mix.
    if (isReservedClaudeDirName(e.name)) continue;
    const dir = path.join(home, e.name);
    if (path.normalize(dir) === path.normalize(targetStoreDir)) continue;
    let buf: Buffer;
    try {
      buf = fs.readFileSync(path.join(dir, '.credentials.json'));
    } catch {
      continue; // no token here
    }
    if (credentialFingerprint(buf) !== wantFp) continue;
    const otherEmail = readIdentity(dir)?.email?.trim().toLowerCase();
    // A shared grant is legitimate ONLY between two copies of the SAME account —
    // both identities readable AND equal. Every other case (different emails, or
    // EITHER identity unreadable) cannot be proven same-account, so refuse: a
    // shared grant we cannot attribute to one account is the contamination
    // signature, and failing closed never wrongly writes a foreign token.
    if (!(wantEmail && otherEmail && wantEmail === otherEmail)) return dir;
  }
  return null;
}

/**
 * Copies a working dir's (possibly refreshed) token back into the account's
 * store, so the store never falls far behind the credential actually in use.
 * Only the token: the store's config is the account's own and shouldn't be
 * churned by every window that runs it.
 *
 * Refuses when the incoming token already belongs to a DIFFERENT account (the
 * contamination tripwire): a working dir whose identity has drifted from its
 * token would otherwise write one account's credential into another's store.
 */
export async function refreshStore(account: Account, workingDir: string): Promise<void> {
  const src = path.join(workingDir, '.credentials.json');
  const dst = path.join(account.dir, '.credentials.json');
  try {
    if (!fs.existsSync(src)) return;
    const incoming = fs.readFileSync(src);
    // Serialize the read-compare-write on the store's credentials — the SAME lock
    // ensureFreshToken (usage.ts) takes when it rotates a store token — so newest-
    // wins is a real compare-and-set, not a lock-free RMW that could publish an
    // older grant over a concurrently-written newer one. Async lock: it awaits
    // between attempts (never a synchronous Atomics.wait), so it can't freeze the
    // extension host even while ensureFreshToken holds this lock across a
    // multi-second OAuth refresh. skipIfUnacquired: never write unlocked on a stale
    // read — skip and let a later reconcile retry (the holder is publishing a grant
    // anyway). The callers (reconcile, captureCurrentAccount) are already async.
    const { locked } = await withLockAsync(
      `${dst}.lock`,
      () => {
        if (fs.existsSync(dst)) {
          const cur = fs.readFileSync(dst);
          if (cur.equals(incoming)) return;
          // Never regress the store. A same-lineage refresh (same refresh token)
          // always writes through. A DIFFERENT grant is adopted only when it is a
          // VALID grant (parseable expiry) AND either the store's current grant is
          // unparseable/invalid or the incoming is strictly newer. This stops the
          // multi-window flap (two windows writing divergent copies every reconcile)
          // and refuses a corrupt/older/equal copy — while still letting a valid
          // grant repair an unparseable store.
          if (!sameCredential(incoming, cur)) {
            const inExp = tokenExpiry(incoming);
            const curExp = tokenExpiry(cur);
            const adopt = inExp != null && (curExp == null || inExp > curExp);
            if (!adopt) {
              log(
                `workdir: kept store of ${account.email ?? account.name} — incoming grant is not confirmably newer`
              );
              return;
            }
          }
        }
        const conflict = foreignTokenConflict(account.dir, incoming, account.email);
        if (conflict) {
          log(
            `workdir: REFUSED store refresh of ${account.name} — that token already belongs to ` +
              `${conflict} (cross-account contamination guard)`
          );
          return;
        }
        fs.mkdirSync(account.dir, { recursive: true, mode: 0o700 });
        // Unique-temp atomic write: a half-written store is worse than a stale one.
        writeFileAtomic(dst, incoming, { mode: 0o600 });
        log(`workdir: refreshed store of ${account.email ?? account.name}`);
      },
      { capMs: 3_000, skipIfUnacquired: true }
    );
    if (!locked) {
      log(`workdir: store of ${account.email ?? account.name} is busy — deferred refresh`);
    }
  } catch (err) {
    log(`workdir: could not refresh store of ${account.name}: ${(err as Error).message}`);
  }
}

/** Every working dir on disk — used to sign an account out of all of them. */
export function allWorkingDirs(): string[] {
  try {
    return fs
      .readdirSync(workingRoot(), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(workingRoot(), e.name));
  } catch {
    return []; // nothing created yet
  }
}

function copyFile(src: string, dst: string): void {
  copyFileAtomic(src, dst, 0o600);
}

/**
 * Merges user-scope MCP servers from `~/.claude.json` into a window working dir's
 * `.claude.json`. Claude Code reads `mcpServers` from `$CLAUDE_CONFIG_DIR/.claude.json`,
 * not from the home config, so servers configured only at user scope never reach
 * managed windows unless we copy them in. Home is the source of truth on name clash;
 * servers present only in the window are preserved. Local/project-scope servers
 * (`projects[cwd].mcpServers`) are out of scope.
 */
export function syncMcpServers(workingDir: string): void {
  try {
    // Default dir already uses ~/.claude.json as its runtime config — merging into
    // itself would be a no-op at best and a self-clobber risk at worst.
    if (path.normalize(workingDir) === path.normalize(path.join(os.homedir(), '.claude'))) {
      return;
    }

    const homeCfg = path.join(os.homedir(), '.claude.json');
    let homeMcp: Record<string, unknown>;
    try {
      const home = JSON.parse(fs.readFileSync(homeCfg, 'utf-8')) as Record<string, unknown>;
      const m = home.mcpServers;
      // Only top-level user-scope servers — not projects[cwd].mcpServers.
      if (!m || typeof m !== 'object' || Array.isArray(m) || Object.keys(m).length === 0) {
        return;
      }
      homeMcp = m as Record<string, unknown>;
    } catch {
      return; // absent or unreadable home config — nothing to propagate
    }

    const file = path.join(workingDir, '.claude.json');
    if (!fs.existsSync(file)) return;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
    } catch {
      return; // unparseable — dir isn't stocked
    }

    const existing =
      obj.mcpServers && typeof obj.mcpServers === 'object' && !Array.isArray(obj.mcpServers)
        ? (obj.mcpServers as Record<string, unknown>)
        : {};
    const merged = { ...existing, ...homeMcp };
    // Skip the write when nothing changed — Claude Code watches this file.
    if (isDeepStrictEqual(merged, existing)) return;

    obj.mcpServers = merged;
    writeFileAtomic(file, JSON.stringify(obj, null, 2), { mode: 0o600 });
  } catch (err) {
    log(`workdir: could not sync mcpServers into ${workingDir}: ${(err as Error).message}`);
  }
}

/**
 * Points a window's settings.json at the user's own ~/.claude/settings.json, so a
 * managed window uses the same Claude Code settings (auto-compact threshold and
 * message, model, hooks, permissions, …) as the default account. Without it,
 * CLAUDE_CONFIG_DIR makes Claude Code read a settings.json that isn't in the window
 * dir and fall back to defaults — the reported "my auto-compact settings aren't
 * applied". A symlink (not a copy) keeps every window on one shared settings file,
 * so a change made anywhere applies everywhere. A real per-window settings.json is
 * backed up to `settings.json.bak` before we take over, so nothing is lost.
 */
export function linkUserSettings(workingDir: string): void {
  try {
    const src = path.join(os.homedir(), '.claude', 'settings.json');
    if (!fs.existsSync(src)) return; // no user settings to propagate
    // The default dir IS the source — never link it to itself.
    if (path.normalize(workingDir) === path.normalize(path.join(os.homedir(), '.claude'))) return;
    const dst = path.join(workingDir, 'settings.json');
    const st = fs.lstatSync(dst, { throwIfNoEntry: false });
    if (st?.isSymbolicLink() && path.normalize(fs.readlinkSync(dst)) === path.normalize(src)) {
      return; // already our link
    }
    if (st) {
      if (!st.isSymbolicLink()) {
        // Preserve the ORIGINAL per-window settings.json exactly once (never
        // overwrite an existing backup — a later real file is a superseded
        // in-window change, and the shared settings are authoritative). If we
        // cannot make that first backup, leave the file in place rather than
        // delete the only copy; the next reconcile retries.
        const bak = `${dst}.bak`;
        if (!fs.existsSync(bak)) {
          try {
            fs.copyFileSync(dst, bak);
          } catch {
            return;
          }
        }
      }
      fs.unlinkSync(dst);
    }
    fs.symlinkSync(src, dst);
  } catch (err) {
    log(`workdir: could not link user settings into ${workingDir}: ${(err as Error).message}`);
  }
}
