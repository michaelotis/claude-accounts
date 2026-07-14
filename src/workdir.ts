import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { isDeepStrictEqual } from 'util';
import { Account, readIdentity, hasCredentials } from './accounts';
import { log } from './log';
import { writeFileAtomic, copyFileAtomic } from './fsSafe';

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
  if (hasCredentials(workingDir) && readIdentity(workingDir)?.email === account.email) return false;
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
    // Unique-temp atomic write: a half-written store is worse than a stale one.
    writeFileAtomic(dst, incoming, { mode: 0o600 });
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
      // A real per-window settings.json (or a foreign link): back it up once, then
      // take over so this window uses the shared user settings.
      if (!st.isSymbolicLink()) {
        try {
          fs.copyFileSync(dst, `${dst}.bak`);
        } catch {
          /* best effort */
        }
      }
      fs.unlinkSync(dst);
    }
    fs.symlinkSync(src, dst);
  } catch (err) {
    log(`workdir: could not link user settings into ${workingDir}: ${(err as Error).message}`);
  }
}
