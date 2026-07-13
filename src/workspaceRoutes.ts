import * as path from 'path';

/**
 * Map workspace / project trees to a Claude account email.
 * Longest matching pathPrefix wins (so /projects/work-client beats /projects).
 */
export interface WorkspaceRoute {
  /** Absolute path prefix (directory). Trailing slashes ignored. */
  pathPrefix: string;
  /** Account email that must be used under this tree. */
  email: string;
}

export function normalizePrefix(p: string): string {
  if (!p) return '';
  let n = path.resolve(p);
  // strip trailing separators
  while (n.length > 1 && (n.endsWith('/') || n.endsWith('\\'))) {
    n = n.slice(0, -1);
  }
  return n;
}

/**
 * Find the best route for a filesystem path (cwd or workspace folder).
 * Returns null if nothing matches.
 */
export function matchWorkspaceRoute(
  fsPath: string,
  routes: WorkspaceRoute[]
): WorkspaceRoute | null {
  if (!fsPath || !routes?.length) return null;
  const target = normalizePrefix(fsPath);
  let best: WorkspaceRoute | null = null;
  let bestLen = -1;
  for (const r of routes) {
    if (!r?.pathPrefix || !r?.email) continue;
    const prefix = normalizePrefix(r.pathPrefix);
    if (!prefix) continue;
    if (target === prefix || target.startsWith(prefix + path.sep)) {
      if (prefix.length > bestLen) {
        best = { pathPrefix: prefix, email: r.email.trim() };
        bestLen = prefix.length;
      }
    }
  }
  return best;
}

/** Merge settings routes + learned repo map (name→email resolved by caller). */
export function mergeRoutes(
  settingsRoutes: WorkspaceRoute[],
  learned: WorkspaceRoute[]
): WorkspaceRoute[] {
  // Settings win on equal prefix; otherwise keep both and let longest-match decide.
  const byPrefix = new Map<string, WorkspaceRoute>();
  for (const r of learned) {
    if (!r.pathPrefix || !r.email) continue;
    const p = normalizePrefix(r.pathPrefix);
    byPrefix.set(p, { pathPrefix: p, email: r.email });
  }
  for (const r of settingsRoutes) {
    if (!r.pathPrefix || !r.email) continue;
    const p = normalizePrefix(r.pathPrefix);
    byPrefix.set(p, { pathPrefix: p, email: r.email.trim() });
  }
  return [...byPrefix.values()].sort((a, b) => b.pathPrefix.length - a.pathPrefix.length);
}
