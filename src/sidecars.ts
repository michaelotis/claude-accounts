import * as path from 'path';
import * as os from 'os';

/**
 * Config-dir names / paths that must never be treated as multi-login accounts
 * or pulled into shared-history migration (Docker sidecars, extension internals).
 */
const RESERVED_SUFFIXES = new Set(['windows', 'shared', 'vault', 'camwatch']);

/** True if a home-directory basename like `.claude-camwatch` is a sidecar. */
export function isReservedClaudeDirName(dirName: string): boolean {
  const m = /^\.claude[-_](.+)$/.exec(dirName);
  if (!m) return false;
  const suffix = m[1].toLowerCase();
  if (RESERVED_SUFFIXES.has(suffix)) return true;
  if (suffix.includes('camwatch')) return true;
  return false;
}

/** True if this absolute path should never be managed as an account store. */
export function isSidecarConfigDir(dir: string): boolean {
  const norm = path.normalize(dir);
  const base = path.basename(norm);
  if (isReservedClaudeDirName(base)) return true;
  // Explicit non-.claude-* sidecars we know about
  const home = os.homedir();
  if (norm === path.normalize(path.join(home, '.camwatch', 'claude'))) return true;
  if (norm.startsWith(path.normalize(path.join(home, '.camwatch')) + path.sep)) return true;
  // Never migrate Windows-mounted paths
  if (norm.startsWith('/mnt/c/') || /^[A-Za-z]:/.test(norm)) return true;
  return false;
}
