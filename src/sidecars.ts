import * as path from 'path';
import * as os from 'os';

/**
 * Config-dir names / paths that must never be treated as multi-login accounts
 * or pulled into shared-history migration (Docker sidecars, extension internals).
 */
const RESERVED_SUFFIXES = new Set(['windows', 'shared', 'vault']);

/** True if a home-directory basename like `.claude-windows` is a sidecar. */
export function isReservedClaudeDirName(dirName: string): boolean {
  const m = /^\.claude[-_](.+)$/.exec(dirName);
  if (!m) return false;
  const suffix = m[1].toLowerCase();
  if (RESERVED_SUFFIXES.has(suffix)) return true;
  return false;
}

/**
 * True for Windows or Windows-mounted paths that must never be treated as a
 * Linux/WSL Claude account store (any drive letter under /mnt, drive: prefix,
 * or Windows system path segments).
 */
export function isWindowsPath(p: string): boolean {
  if (!p) return false;
  if (/^\/mnt\/[A-Za-z]\//.test(p)) return true;
  if (/^[A-Za-z]:/.test(p)) return true;
  if (p.includes('/Windows/') || p.includes('/System32/')) return true;
  return false;
}

/** True if this absolute path should never be managed as an account store. */
export function isSidecarConfigDir(dir: string): boolean {
  const norm = path.normalize(dir);
  const base = path.basename(norm);
  if (isReservedClaudeDirName(base)) return true;
  // Never migrate Windows-mounted paths
  if (isWindowsPath(norm)) return true;
  return false;
}
