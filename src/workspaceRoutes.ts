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

/** Case-fold + trim emails so settings and OAuth identity compare reliably. */
export function normalizeEmail(email: string | undefined | null): string {
  return (email ?? '').trim().toLowerCase();
}

export function emailsEqual(a: string | undefined | null, b: string | undefined | null): boolean {
  const na = normalizeEmail(a);
  const nb = normalizeEmail(b);
  return Boolean(na && nb && na === nb);
}

/**
 * Pure preference order for which account name activation should bind.
 * preferred (route) > active/repo memory > last-used only when no working dir.
 */
export function pickStoredAccountName(opts: {
  preferredName?: string;
  activeName?: string;
  lastName?: string;
  hasWorkingDir: boolean;
}): string | undefined {
  if (opts.preferredName) return opts.preferredName;
  if (opts.activeName) return opts.activeName;
  if (!opts.hasWorkingDir && opts.lastName) return opts.lastName;
  return undefined;
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
        best = { pathPrefix: prefix, email: normalizeEmail(r.email) };
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
    byPrefix.set(p, { pathPrefix: p, email: normalizeEmail(r.email) });
  }
  for (const r of settingsRoutes) {
    if (!r.pathPrefix || !r.email) continue;
    const p = normalizePrefix(r.pathPrefix);
    byPrefix.set(p, { pathPrefix: p, email: normalizeEmail(r.email) });
  }
  return [...byPrefix.values()].sort((a, b) => b.pathPrefix.length - a.pathPrefix.length);
}
