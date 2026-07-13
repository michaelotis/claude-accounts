import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { isReservedClaudeDirName } from './sidecars';

/**
 * An account = a Claude Code data directory (CLAUDE_CONFIG_DIR) that has been
 * logged in. Everything Claude Code needs lives inside it:
 *   <dir>/.claude.json        → config + oauthAccount identity
 *   <dir>/.credentials.json   → OAuth tokens (file-based on Linux/WSL)
 *
 * We NEVER touch ~/.claude.json (the global default) — isolation is achieved
 * purely by pointing each window's process.env.CLAUDE_CONFIG_DIR at a dir.
 */
export interface Account {
  /** Short, user-facing name (e.g. "work", "personal"). */
  name: string;
  /** Absolute CLAUDE_CONFIG_DIR path. */
  dir: string;
  /** Last known account email (cached for display; source of truth is the CLI). */
  email?: string;
}

/** Identity read live from <dir>/.claude.json. */
export interface AccountIdentity {
  email: string;
  displayName: string;
  organizationName?: string;
}

const REGISTRY_KEY = 'claudeProfiles.accounts';
/**
 * Accounts the user explicitly forgot. Their dirs stay on disk untouched (this
 * extension performs no destructive operations), so discovery must remember
 * NOT to re-add them — and a later save of the same email restores the entry
 * instead of snapshotting a duplicate of the same OAuth token.
 */
const FORGOTTEN_KEY = 'claudeProfiles.forgottenAccounts';

/** Parses oauthAccount identity out of a single .claude.json file. */
function readIdentityFile(file: string): AccountIdentity | null {
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
      oauthAccount?: {
        emailAddress?: string;
        displayName?: string;
        organizationName?: string;
      };
    };
    const o = raw.oauthAccount;
    if (!o?.emailAddress) return null;
    return {
      email: o.emailAddress,
      displayName: o.displayName ?? o.emailAddress,
      organizationName: o.organizationName,
    };
  } catch {
    return null;
  }
}

/**
 * Reads oauthAccount identity for a config dir. Named accounts keep it in
 * <dir>/.claude.json. The default ~/.claude is special: its config dir's
 * .claude.json has no oauthAccount — that identity lives in ~/.claude.json at
 * the home root — so we fall back to it. Without this fallback an unbound
 * window has no identity to paint and the status bar hangs on its spinner.
 */
export function readIdentity(dir: string): AccountIdentity | null {
  const own = readIdentityFile(path.join(dir, '.claude.json'));
  if (own) return own;
  if (path.normalize(dir) === path.normalize(path.join(os.homedir(), '.claude'))) {
    return readIdentityFile(path.join(os.homedir(), '.claude.json'));
  }
  return null;
}

/** True if the dir looks like a logged-in Claude Code config dir. */
export function hasCredentials(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.credentials.json'));
}

/** Expands a leading ~ to the home directory. */
export function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * Mirror of the registry's directories, on disk.
 *
 * The uninstall hook runs as a bare `node` script with no vscode API, so
 * globalState — where the registry actually lives — is unreadable to it. Without
 * this list it could only guess which `~/.claude-*` dirs are ours, and the one
 * thing it must never do is delete a directory a user made for themselves. So
 * the registry writes down exactly what it manages, and uninstall deletes
 * nothing else.
 */
function manifestPath(): string {
  return path.join(os.homedir(), '.claude-windows', '.manifest.json');
}

/**
 * The account registry is stored in globalState so every window (and every
 * VSCode profile) on this machine sees the same set of accounts.
 */
export class AccountRegistry {
  constructor(private readonly context: vscode.ExtensionContext) {}

  list(): Account[] {
    return this.context.globalState.get<Account[]>(REGISTRY_KEY, []);
  }

  /**
   * Records the dirs this extension manages, for the uninstall hook to clean up.
   * Forgotten accounts are included: their dirs are ours too and stay on disk.
   * Best-effort — a missing manifest only means uninstall leaves the stores be.
   */
  writeManifest(): void {
    try {
      const stores = [...this.list(), ...this.listForgotten()].map((a) => path.normalize(a.dir));
      const file = manifestPath();
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify({ stores: [...new Set(stores)] }, null, 2), {
        mode: 0o600,
      });
    } catch {
      /* best-effort */
    }
  }

  get(name: string): Account | undefined {
    return this.list().find((a) => a.name === name);
  }

  getByDir(dir: string): Account | undefined {
    const norm = path.normalize(dir);
    return this.list().find((a) => path.normalize(a.dir) === norm);
  }

  /** The email an account resolves to (cached, else read live from its dir). */
  emailOf(a: Account): string | undefined {
    return a.email ?? readIdentity(a.dir)?.email;
  }

  /** A saved account whose identity matches this email, if any. */
  savedForEmail(email: string): Account | undefined {
    return this.list().find((a) => this.emailOf(a) === email);
  }

  /**
   * The accounts collapsed to one per email — the old paradigm could snapshot
   * the same account into several dirs, so the raw list may hold duplicates.
   * The canonical copy (name equal to the email's local-part slug) wins; entries
   * with no resolvable email can't be deduped and are kept as-is.
   */
  listUniqueByEmail(): Account[] {
    const slug = (email: string) =>
      (email.split('@')[0] || '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
    const chosen = new Map<string, Account>();
    const noEmail: Account[] = [];
    for (const a of this.list()) {
      const email = this.emailOf(a);
      if (!email) {
        noEmail.push(a);
        continue;
      }
      const current = chosen.get(email);
      if (!current || (a.name === slug(email) && current.name !== slug(email))) {
        chosen.set(email, a);
      }
    }
    return [...chosen.values(), ...noEmail].sort((a, b) => a.name.localeCompare(b.name));
  }

  async add(account: Account): Promise<void> {
    const list = this.list().filter((a) => a.name !== account.name);
    list.push(account);
    list.sort((a, b) => a.name.localeCompare(b.name));
    await this.context.globalState.update(REGISTRY_KEY, list);
    this.writeManifest();
  }

  async remove(name: string): Promise<void> {
    const list = this.list().filter((a) => a.name !== name);
    await this.context.globalState.update(REGISTRY_KEY, list);
    this.writeManifest();
  }

  /**
   * Drops entries whose store has been signed out — the account no longer exists.
   *
   * This is what makes the account list agree across windows. `globalState` does
   * NOT propagate between them: each extension host holds its own copy, so an
   * account saved (or forgotten) in one window is invisible to the others until
   * they restart. The DISK is the only shared truth — an account IS its store —
   * so pairing this with discoverAndMerge() lets every window converge on it:
   * new accounts appear, and signed-out ones disappear.
   */
  async pruneSignedOut(): Promise<Account[]> {
    const gone = this.list().filter((a) => !hasCredentials(a.dir));
    for (const a of gone) await this.remove(a.name);
    return gone;
  }

  listForgotten(): Account[] {
    return this.context.globalState.get<Account[]>(FORGOTTEN_KEY, []);
  }


  /** Moves an account from the registry to the forgotten list. Dir stays on disk. */
  async forget(account: Account): Promise<void> {
    await this.remove(account.name);
    const norm = path.normalize(account.dir);
    const rest = this.listForgotten().filter((a) => path.normalize(a.dir) !== norm);
    rest.push(account);
    await this.context.globalState.update(FORGOTTEN_KEY, rest);
    this.writeManifest();
  }

  /** Restores a previously forgotten account matching this email, if any. */
  async restoreForgotten(email: string): Promise<Account | undefined> {
    const list = this.listForgotten();
    const found = list.find((a) => (a.email ?? readIdentity(a.dir)?.email) === email);
    if (!found) return undefined;
    await this.context.globalState.update(
      FORGOTTEN_KEY,
      list.filter((a) => a !== found)
    );
    found.email = email;
    await this.add(found);
    return found;
  }

  /**
   * Discovers logged-in config dirs on disk (~/.claude-* and ~/.claude) and
   * merges any that aren't in the registry yet. Non-destructive.
   */
  async discoverAndMerge(): Promise<Account[]> {
    const home = os.homedir();
    const found: Account[] = [];
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(home, { withFileTypes: true });
    } catch {
      return this.list();
    }
    const forgotten = new Set(this.listForgotten().map((a) => path.normalize(a.dir)));
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      // Only manage explicit .claude-<name> dirs. The bare ~/.claude default is
      // skipped: its identity lives in ~/.claude.json (home), not in the dir,
      // so it isn't a self-contained account.
      const m = /^\.claude[-_](.+)$/.exec(e.name);
      if (!m) continue;
      // Skip extension internals and Docker/tool sidecars (not multi-login accounts).
      if (isReservedClaudeDirName(e.name)) continue;
      const dir = path.join(home, e.name);
      if (!hasCredentials(dir)) continue;
      // Explicitly forgotten dirs stay on disk — do not resurrect them.
      if (forgotten.has(path.normalize(dir))) continue;
      const name = m[1];
      if (this.getByDir(dir)) continue;
      found.push({ name, dir });
    }
    for (const acc of found) {
      // Avoid name collisions with existing registry entries.
      if (this.get(acc.name)) continue;
      await this.add(acc);
    }
    // Runs on every activation, so an install that predates the manifest gets one
    // even if nothing was discovered — otherwise uninstall would find no list and
    // conservatively leave every store behind.
    this.writeManifest();
    return this.list();
  }
}
