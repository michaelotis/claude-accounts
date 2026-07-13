import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Shared conversation history across accounts.
 *
 * Claude Code keeps conversations INSIDE the account's data dir:
 *   <dir>/projects/<workspace-path>/<session>.jsonl  → transcripts
 *   <dir>/sessions, session-env, shell-snapshots, …  → session state
 * so switching CLAUDE_CONFIG_DIR resets the visible history. To let a chat
 * continue across an account switch we move these entries to one shared store
 * (~/.claude-shared) and symlink them from every account dir. Only history is
 * shared — .credentials.json / .claude.json (identity + billing) stay
 * per-account, and transcripts remain keyed by workspace path inside
 * projects/, so nothing leaks between repos.
 */

/** Directory entries moved to the shared store and symlinked back. */
const SHARED_DIRS = [
  'projects',
  'sessions',
  'session-env',
  'shell-snapshots',
  'file-history',
  'plans',
  'todos',
];
/** File entries: contents are appended into the shared file, then symlinked. */
const SHARED_FILES = ['history.jsonl'];

export function sharedStoreDir(): string {
  return path.join(os.homedir(), '.claude-shared');
}

/**
 * Ensures every given account dir sees the shared history store. Idempotent
 * and best-effort: each entry is migrated independently and a failure is
 * reported as a warning instead of aborting the rest (a partial migration
 * simply converges on the next activation). Returns human-readable warnings.
 */
export function ensureSharedHistory(accountDirs: string[]): string[] {
  const warnings: string[] = [];
  const store = sharedStoreDir();
  try {
    fs.mkdirSync(store, { recursive: true, mode: 0o700 });
  } catch (err) {
    return [`Could not create ${store}: ${(err as Error).message}`];
  }

  const seen = new Set<string>();
  for (const rawDir of accountDirs) {
    const dir = path.normalize(rawDir);
    if (seen.has(dir)) continue;
    seen.add(dir);
    if (dir === path.normalize(store)) continue;
    if (!fs.existsSync(dir)) continue;

    for (const name of SHARED_DIRS) {
      try {
        linkDirEntry(dir, store, name);
      } catch (err) {
        warnings.push(`${path.join(dir, name)}: ${(err as Error).message}`);
      }
    }
    for (const name of SHARED_FILES) {
      try {
        linkFileEntry(dir, store, name);
      } catch (err) {
        warnings.push(`${path.join(dir, name)}: ${(err as Error).message}`);
      }
    }
  }
  return warnings;
}

/** Migrates one directory entry of an account dir into the store + symlinks it. */
function linkDirEntry(accountDir: string, store: string, name: string): void {
  const src = path.join(accountDir, name);
  const dst = path.join(store, name);

  const st = fs.lstatSync(src, { throwIfNoEntry: false });
  if (st?.isSymbolicLink()) {
    if (path.normalize(fs.readlinkSync(src)) === path.normalize(dst)) return; // already ours
    fs.unlinkSync(src); // foreign/stale link — replace
  } else if (st?.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
    mergeDirInto(src, dst, store);
    fs.rmSync(src, { recursive: true, force: true });
  } else if (st) {
    return; // unexpected non-dir entry — leave it alone
  }

  fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
  fs.symlinkSync(dst, src);
}

/**
 * Moves everything from src into dst. On a name collision the newer file wins
 * and the older one is preserved under <store>/.merge-backup rather than
 * deleted (transcripts are user data — never destroy them) — unless the two are
 * byte-identical, in which case there is nothing to preserve and the duplicate
 * is simply dropped.
 *
 * That exception is what keeps the store from exploding. Un-sharing gives EVERY
 * account and working dir a full copy of the history; re-sharing then merges
 * them all back, so every file collides with an identical twin once per dir. A
 * blanket "back up the loser" turned each off/on cycle (including an
 * uninstall/reinstall) into another full duplicate of the history in
 * .merge-backup — 1.3 GB of real history had grown 12 GB of backups of itself.
 */
function mergeDirInto(src: string, dst: string, store: string): void {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    const dstStat = fs.lstatSync(d, { throwIfNoEntry: false });

    if (!dstStat) {
      fs.renameSync(s, d);
      continue;
    }
    if (entry.isDirectory() && dstStat.isDirectory()) {
      mergeDirInto(s, d, store);
      continue;
    }
    // Collision between files: an identical copy is not history, just a duplicate.
    const srcStat = fs.statSync(s);
    if (sameContent(s, d, srcStat.size, dstStat.size)) {
      fs.rmSync(s, { force: true });
      continue;
    }
    // Genuinely different: keep the newer, back up the older.
    const loser = srcStat.mtimeMs > dstStat.mtimeMs ? d : s;
    const backup = path.join(store, '.merge-backup', path.relative(store, dst), `${entry.name}.${Date.now()}`);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.renameSync(loser, backup);
    if (loser === d) fs.renameSync(s, d);
  }
}

/** Byte equality, size-gated so the common "differs" case never reads a file. */
function sameContent(a: string, b: string, sizeA: number, sizeB: number): boolean {
  if (sizeA !== sizeB) return false;
  try {
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false; // unreadable → treat as different and take the safe (backup) path
  }
}

/**
 * Merges an account's line-based file (history.jsonl) into the store + symlinks it.
 *
 * Only lines the store doesn't already have are appended. Un-sharing hands every
 * account dir a full copy of this file, so a blind append re-added the entire
 * history on every re-share: 4 real entries had become 84 identical lines, and
 * each off/on cycle multiplied them again.
 */
function linkFileEntry(accountDir: string, store: string, name: string): void {
  const src = path.join(accountDir, name);
  const dst = path.join(store, name);

  const st = fs.lstatSync(src, { throwIfNoEntry: false });
  if (st?.isSymbolicLink()) {
    if (path.normalize(fs.readlinkSync(src)) === path.normalize(dst)) return;
    fs.unlinkSync(src);
  } else if (st?.isFile()) {
    const existing = fs.existsSync(dst) ? fs.readFileSync(dst, 'utf-8') : '';
    const known = new Set(existing.split('\n').filter(Boolean));
    const incoming = fs
      .readFileSync(src, 'utf-8')
      .split('\n')
      .filter((line) => line && !known.has(line));
    if (incoming.length > 0) {
      const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
      fs.appendFileSync(dst, `${prefix}${incoming.join('\n')}\n`, { mode: 0o600 });
    }
    fs.unlinkSync(src);
  } else if (st) {
    return; // unexpected entry type
  }

  if (!fs.existsSync(dst)) fs.writeFileSync(dst, '', { mode: 0o600 });
  fs.symlinkSync(dst, src);
}
