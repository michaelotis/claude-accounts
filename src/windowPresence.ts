import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeFileAtomic } from './fsSafe';
import { escapeTableCell } from './usageParse';

/**
 * Which windows are running which account.
 *
 * Almost all of that answer is already on disk: every bound window has a working
 * dir of its own, and that dir's `.claude.json` names the account it runs. Two
 * things are missing, and they are the only things this file records — which
 * workspace a window has open (a human label; nothing on disk carries it), and
 * whether the window is still there at all.
 *
 * So a presence record holds a workspace name, a config dir, a pid, the host
 * that wrote it and a heartbeat, and NOTHING else. In particular it holds no
 * email and no token: the account is derived from `configDir` at READ time, so a
 * switch shows up in the next read and a record left behind by a crashed window
 * can never name an account that dir no longer runs. The worst a stale record
 * can do is claim a window exists, and the liveness bound below is what stops
 * that.
 *
 * The records live under `~/.config/claude-accounts/windows/`, beside the shared
 * usage cache and deliberately OUTSIDE the working dirs: Claude Code owns those,
 * and the account watcher wakes every window on a write there (a per-minute
 * heartbeat inside one would fire a reconcile a minute, forever).
 *
 * vscode-free on purpose — the usage CLI bundles this file with nothing marked
 * external, so an import that reached `vscode` would fail that build.
 */

/** Presence directory: `~/.config/claude-accounts/windows`, created 0700. */
export function presenceDir(): string {
  // Same resolution usage.ts and usageCli.ts use for the shared cache dir —
  // os.homedir() reads $HOME on every call, so a caller that overrides it (the
  // tests, a sandbox) gets the directory it means.
  return path.join(os.homedir(), '.config', 'claude-accounts', 'windows');
}

/**
 * How long a record stays believable without a heartbeat. This is what defeats
 * pid reuse: a dead window's pid can be handed to an unrelated process, so "the
 * pid is alive" alone would keep attributing a window that closed. Five minutes
 * is the cost of that safety — a window that has just died can be listed until
 * its record ages out.
 */
export const PRESENCE_MAX_AGE_MS = 5 * 60_000;
/** Heartbeat interval. Comfortably inside PRESENCE_MAX_AGE_MS. */
export const PRESENCE_HEARTBEAT_MS = 60_000;
/** A dead record is only deleted once no reader would have believed it for a day. */
export const PRESENCE_SWEEP_AGE_MS = 24 * 60 * 60_000;
/** Record shape version — anything else is skipped rather than guessed at. */
const RECORD_VERSION = 1;
/** Workspace names shown on a card line before the rest collapse into `+N`. */
const MAX_NAMES = 2;
/** A window with no folder open still has an account; it just has no name. */
const NO_FOLDER = '(no folder)';
/** Windows whose `configDir` names no readable account are grouped under this. */
const UNKNOWN_LABEL = 'unknown account';

/** What a window writes about itself. No email, no token — see the file header. */
export interface PresenceRecord {
  /** Per WINDOW, not per dir or per machine — see presenceIdFor. */
  id: string;
  /** Basename of the workspace file or first folder; '' when folderless. */
  workspace: string;
  /** The CLAUDE_CONFIG_DIR this window's Claude Code runs. */
  configDir: string;
  pid: number;
  lastSeen: number;
  /** The machine that wrote it; writePresence stamps this one when omitted. */
  host?: string;
}

/** Filename-safe hostname, for the part of an id that separates two machines. */
function hostId(): string {
  return os.hostname().replace(/[^A-Za-z0-9._-]/g, '-') || 'host';
}

/** Whether a record was written somewhere this process cannot ask about pids. */
function isForeign(rec: PresenceRecord): boolean {
  // A record written before the host was recorded can only be a local one: the
  // directory is per home, and nothing else wrote into it.
  return Boolean(rec.host) && rec.host !== os.hostname();
}

/**
 * This window's record id — per WINDOW, which is what the map is about.
 *
 * The working dir is per WORKSPACE (two VS Code windows on one folder share it,
 * by design — they share the account), so its basename alone would give those
 * two windows one record: a second window would overwrite the first's, and
 * either one closing would delete it out from under the other. The pid tells
 * them apart, and the host keeps two machines writing into one synced home from
 * doing the same. `configDir` still carries the whole dir, so the account is
 * derived exactly as before.
 */
export function presenceIdFor(envDir: string | undefined, pid: number): string {
  const base = envDir ? path.basename(envDir) : 'default';
  return `${base}-${hostId()}-${pid}`;
}

/** A live window, with the account its `configDir` runs right now. */
export interface WindowInfo extends PresenceRecord {
  /** `oauthAccount.emailAddress` from the config dir, or null when unreadable. */
  email: string | null;
}

/** Same-host liveness. EPERM means alive-but-not-ours; only ESRCH means gone. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function recordFile(dir: string, id: string): string {
  return path.join(dir, `${id}.json`);
}

/**
 * Writes (or refreshes) this window's record. Atomic with a unique staging name,
 * like every other write this extension makes to a file other windows read.
 */
export function writePresence(rec: PresenceRecord, dir: string = presenceDir()): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamped = { v: RECORD_VERSION, ...rec, host: rec.host ?? os.hostname() };
  writeFileAtomic(recordFile(dir, rec.id), JSON.stringify(stamped), { mode: 0o600 });
}

/**
 * Writes this window's record and retires the one it replaces — a bind moves a
 * window to another dir, so its record moves with it.
 *
 * The order is the whole point. The new record lands FIRST, so no failure can
 * leave the window with no record at all; the removal is its own try, so a
 * failure there costs a phantom record rather than stranding the caller on an id
 * it no longer writes to. The phantom carries this window's own live pid, so the
 * liveness bound hides it after five minutes but no sweep collects it until the
 * process has exited — which is why the failure is handed back, not swallowed.
 */
export function moveRecord(
  prevId: string | undefined,
  rec: PresenceRecord,
  dir: string = presenceDir(),
  onRemoveError?: (err: Error) => void
): void {
  writePresence(rec, dir);
  if (!prevId || prevId === rec.id) return;
  try {
    removePresence(prevId, dir);
  } catch (err) {
    onRemoveError?.(err as Error);
  }
}

/** Removes a record — used on a clean shutdown, and by the sweep. */
export function removePresence(id: string, dir: string = presenceDir()): void {
  fs.rmSync(recordFile(dir, id), { force: true });
}

/**
 * One record, or null when the file is unreadable, is not JSON, is not an
 * object, carries another version, or is missing a field a reader would have to
 * invent. Nothing here throws: a hand-edited or half-known file must cost the
 * caller one window, never the whole listing.
 */
function readRecord(file: string): PresenceRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const r = parsed as Record<string, unknown>;
  if (r.v !== RECORD_VERSION) return null;
  if (typeof r.id !== 'string' || r.id === '') return null;
  if (typeof r.workspace !== 'string') return null;
  if (typeof r.configDir !== 'string' || r.configDir === '') return null;
  // Only a real process id. `process.kill(0, 0)` signals this very process and
  // a negative pid signals a process GROUP, so either would answer "alive" for
  // as long as the file sits there — a record that can never age out.
  if (typeof r.pid !== 'number' || !Number.isInteger(r.pid) || r.pid <= 0) return null;
  if (typeof r.lastSeen !== 'number' || !Number.isFinite(r.lastSeen)) return null;
  if (r.host !== undefined && typeof r.host !== 'string') return null;
  return {
    id: r.id,
    workspace: r.workspace,
    configDir: r.configDir,
    pid: r.pid,
    lastSeen: r.lastSeen,
    ...(typeof r.host === 'string' && r.host !== '' ? { host: r.host } : {}),
  };
}

/**
 * The account a config dir runs, read fresh. `null` is "not known", never a
 * guess: an absent, unreadable or unparseable config is exactly the state of a
 * dir mid-sign-in, and naming an account there would be worse than saying
 * nothing.
 *
 * The default dir is the one special case, and it is not a guess either: Claude
 * Code keeps `~/.claude`'s identity in `~/.claude.json` at the home root rather
 * than inside the dir, so an unbound window's account lives there. Same fallback
 * accounts.ts's readIdentity applies, and applied only for that one path.
 */
function emailFor(configDir: string): string | null {
  const own = emailInConfig(path.join(configDir, '.claude.json'));
  if (own) return own;
  if (path.normalize(configDir) === path.normalize(path.join(os.homedir(), '.claude'))) {
    return emailInConfig(path.join(os.homedir(), '.claude.json'));
  }
  return null;
}

function emailInConfig(file: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
      oauthAccount?: { emailAddress?: unknown };
    };
    const email = parsed?.oauthAccount?.emailAddress;
    return typeof email === 'string' && email !== '' ? email : null;
  } catch {
    return null;
  }
}

/**
 * How long ago a record beat, or null when its stamp cannot be dated at all.
 *
 * A stamp slightly ahead of now is the ordinary result of a clock stepping back
 * between the write and the read, and blanking the whole map over a second of
 * drift costs far more than it protects: anything within one heartbeat counts as
 * "just now". Further ahead than a window could plausibly have written, the
 * record cannot be placed in time, and an age nobody knows is not an age.
 */
function ageOf(rec: PresenceRecord, now: number): number | null {
  const age = now - rec.lastSeen;
  if (age < 0) return age >= -PRESENCE_HEARTBEAT_MS ? 0 : null;
  return age;
}

/**
 * Live means BOTH: the pid answers, and the record has been refreshed inside
 * PRESENCE_MAX_AGE_MS. Either alone is not enough — a pid outlives its window by
 * reuse, and a heartbeat inside the bound proves nothing on its own.
 *
 * Another host's record is the exception, and not a weakening: its pid is a
 * number about a machine this one cannot ask, so probing it here would answer
 * about an unrelated local process. The heartbeat is all there is, and it is
 * exactly what a window that has gone stops writing.
 */
function isLive(rec: PresenceRecord, now: number, alive: (pid: number) => boolean): boolean {
  const age = ageOf(rec, now);
  if (age === null || age > PRESENCE_MAX_AGE_MS) return false;
  return isForeign(rec) ? true : alive(rec.pid);
}

/**
 * Every live window, each with the account its config dir runs now.
 *
 * Read-only, deliberately: the usage CLI calls this, and that command's whole
 * contract is that it writes nothing anywhere. Retiring dead records is
 * `sweepPresence`, which only the extension runs.
 */
export function readWindows(
  now: number,
  opts: { dir?: string; isAlive?: (pid: number) => boolean } = {}
): WindowInfo[] {
  const dir = opts.dir ?? presenceDir();
  const alive = opts.isAlive ?? processAlive;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return []; // no window has ever written one — not an error, just no windows
  }
  const out: WindowInfo[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const rec = readRecord(path.join(dir, name));
    if (!rec || !isLive(rec, now, alive)) continue;
    out.push({ ...rec, email: emailFor(rec.configDir) });
  }
  // Stable order so a card line and a CLI listing do not reshuffle between reads.
  out.sort((a, b) => a.workspace.localeCompare(b.workspace) || a.id.localeCompare(b.id));
  return out;
}

/**
 * Deletes records whose window is definitely gone: the pid is dead AND the
 * record is a day past its last heartbeat. The pid check alone would delete a
 * record whose window is merely paused; the age alone would delete one whose pid
 * is still serving it. Waiting a day past a five-minute liveness bound costs
 * nothing (a stale record is already invisible to readers) and means a clock
 * skew or a suspended machine never throws away a live window's record.
 *
 * A record from another host is judged on its age alone, for the same reason it
 * is read that way: its pid says nothing here. Staging files go too — an atomic
 * write that died between creating `<file>.<pid>.<n>.tmp` and renaming it leaves
 * one behind, and nothing else would ever collect it.
 *
 * Returns how many files were removed. Extension-only — see readWindows.
 */
export function sweepPresence(
  now: number,
  opts: { dir?: string; isAlive?: (pid: number) => boolean } = {}
): number {
  const dir = opts.dir ?? presenceDir();
  const alive = opts.isAlive ?? processAlive;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  const drop = (file: string): void => {
    try {
      fs.rmSync(file, { force: true });
      removed++;
    } catch {
      /* a later sweep retries — a leftover file is invisible to readers */
    }
  };
  for (const name of names) {
    const file = path.join(dir, name);
    if (name.endsWith('.tmp')) {
      // Mtime, not a record: a staging file may hold nothing but a half-written
      // line. The same day's grace, so one in flight is never taken from under
      // the window writing it.
      try {
        if (now - fs.statSync(file).mtimeMs > PRESENCE_SWEEP_AGE_MS) drop(file);
      } catch {
        /* gone, or unreadable — either way not this sweep's problem */
      }
      continue;
    }
    if (!name.endsWith('.json')) continue;
    const rec = readRecord(file);
    // A record we cannot read is left alone: its age is unknown, so "a day dead"
    // cannot be established, and no reader believes it anyway.
    if (!rec) continue;
    if (!isForeign(rec) && alive(rec.pid)) continue;
    const age = ageOf(rec, now);
    if (age === null || age <= PRESENCE_SWEEP_AGE_MS) continue;
    drop(file);
  }
  return removed;
}

/**
 * The hover-card lines: one per account that has at least one live window, as
 * `**label** — 3 windows: my-project, other-repo, +1`. Pure, so the card can
 * build it at render time from whatever the last read returned.
 *
 * Workspace names come from folders the user named, land in markdown the card
 * trusts, and are escaped exactly as the accounts table escapes its cells — a
 * folder called `](command:…)` must read as a folder name, not run as a link.
 * See inertCell for the two things that escaping alone does not cover.
 */
/**
 * One cell of the card, as text and nothing else.
 *
 * escapeTableCell handles markdown's own actives. Two more reach this card and
 * it does not touch either. The card renders theme icons, so a folder called
 * `$(sync~spin)` would come out as a spinning icon rather than a name — and a
 * backslash cannot stop it, because escapeTableCell would escape the backslash
 * and leave `$(` intact; separating the two characters is what makes it text.
 * And a name carrying a newline or a tab would break the line it sits on, so any
 * run of those collapses to a single space.
 */
function inertCell(s: string): string {
  return escapeTableCell(s.replace(/(?:\r?\n|\t)+/g, ' ').replace(/\$(?=\()/g, '$ '));
}

export function describeWindows(
  windows: WindowInfo[],
  labelFor: (email: string) => string
): string {
  if (windows.length === 0) return '';
  const groups = new Map<string, { label: string; names: string[] }>();
  for (const w of windows) {
    // Keyed lowercase, the same identity the usage cache and the card's own
    // label lookup use — one account writing its email in another case is not a
    // second account.
    const key = w.email ? w.email.toLowerCase() : '';
    let group = groups.get(key);
    if (!group) {
      group = { label: key ? labelFor(key) : UNKNOWN_LABEL, names: [] };
      groups.set(key, group);
    }
    group.names.push(w.workspace || NO_FOLDER);
  }
  // Windows with no readable account go last: their line explains the least, and
  // a named account's line is the actual answer to "who is using what".
  const ordered = [...groups.entries()].sort(([ka, a], [kb, b]) =>
    ka === '' ? 1 : kb === '' ? -1 : a.label.localeCompare(b.label)
  );
  const lines = ordered.map(([, group]) => {
    const count = group.names.length;
    const shown = group.names.slice(0, MAX_NAMES).map(inertCell);
    if (count > shown.length) shown.push(`+${count - shown.length}`);
    const unit = count === 1 ? 'window' : 'windows';
    return `**${inertCell(group.label)}** — ${count} ${unit}: ${shown.join(', ')}`;
  });
  return lines.join('\n\n');
}
