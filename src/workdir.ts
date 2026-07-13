import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { Account, readIdentity, hasCredentials } from './accounts';
import { log } from './log';

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
    vscode.workspace.workspaceFile?.toString() ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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
  if (hasCredentials(workingDir) && readIdentity(workingDir)?.email === account.email) return false;
  try {
    fs.mkdirSync(workingDir, { recursive: true, mode: 0o700 });
    copyFile(path.join(account.dir, '.credentials.json'), path.join(workingDir, '.credentials.json'));
    // The config carries the account's identity AND its per-project state (folder
    // trust, allowed tools, MCP servers), so an account keeps those wherever it runs.
    copyFile(path.join(account.dir, '.claude.json'), path.join(workingDir, '.claude.json'));
    log(`workdir: ${workingDir} now runs ${account.email ?? account.name}`);
    return true;
  } catch (err) {
    log(`workdir: could not stock ${workingDir} with ${account.name}: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Copies a working dir's (possibly refreshed) token back into the account's
 * store, so the store never falls far behind the credential actually in use.
 * Only the token: the store's config is the account's own and shouldn't be
 * churned by every window that runs it.
 */
export function refreshStore(account: Account, workingDir: string): void {
  const src = path.join(workingDir, '.credentials.json');
  const dst = path.join(account.dir, '.credentials.json');
  try {
    if (!fs.existsSync(src)) return;
    const incoming = fs.readFileSync(src);
    if (fs.existsSync(dst) && fs.readFileSync(dst).equals(incoming)) return;
    fs.mkdirSync(account.dir, { recursive: true, mode: 0o700 });
    const tmp = `${dst}.tmp`;
    fs.writeFileSync(tmp, incoming, { mode: 0o600 });
    fs.renameSync(tmp, dst); // atomic: a half-written store is worse than a stale one
    log(`workdir: refreshed store of ${account.email ?? account.name}`);
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
  if (!fs.existsSync(src)) return;
  const tmp = `${dst}.tmp`;
  fs.copyFileSync(src, tmp);
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, dst);
}
