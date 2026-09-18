/**
 * Read-only view of the usage the extension has already collected.
 *
 * The usage helpers live inside the extension bundle and reach `vscode` through
 * the logger, so with every window closed nothing on the machine can read what
 * was collected — the cache file itself is plain JSON and readable, but there
 * was no reader. This entry point is that reader, and nothing more: it opens
 * the cache file and prints it. It never writes, never takes the lock and never
 * fetches, because fetching is one call per account machine-wide and the
 * extension owns it; a second fetcher would spend an account's rate limit
 * behind its back.
 *
 * It must therefore stay free of `vscode`: node built-ins and types only. The
 * build deliberately marks nothing external, so an import that reaches `vscode`
 * from anywhere in this file's graph fails the build rather than the run.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ModelLimit, UsageSnapshot } from './usageParse';
import { readWindows, type WindowInfo } from './windowPresence';

const SCHEMA = 'claude-accounts/usage@1';
const CACHE_FILE = 'usage-cache.json';
const DEFAULT_MAX_AGE_MS = 600_000;
/** The writer's own tolerance, from `CLOCK_SKEW_TOLERANCE_MS` in src/usage.ts. */
const CLOCK_SKEW_TOLERANCE_MS = 60_000;
const CREDENTIALS_FILE = '.credentials.json';

interface ModelReport {
  name: string;
  percent: number | null;
  resetsAt: string | null;
}

/** One live VS Code window running an account. */
interface WindowReport {
  /** Workspace name, or '' for a window with no folder open. */
  workspace: string;
  configDir: string;
  pid: number;
  lastSeen: number;
}

/** A live window this cache has no account for — its email, if any, is its own. */
interface OtherWindowReport extends WindowReport {
  email: string | null;
}

interface AccountReport {
  email: string | null;
  planLabel: string | null;
  orgName: string | null;
  /** Whether this account still has credentials on the machine. */
  present: boolean;
  sessionPercent: number | null;
  sessionResetsAt: string | null;
  weeklyPercent: number | null;
  weeklyResetsAt: string | null;
  models: ModelReport[];
  /** Epoch ms of the reading, or null when the account has never been fetched. */
  fetchedAt: number | null;
  /** How old the reading is, or null when there is no reading to age. */
  ageMs: number | null;
  stale: boolean;
  /** Live windows running this account — always an array, empty when none. */
  windows: WindowReport[];
}

interface Report {
  schema: string;
  generatedAt: number;
  stale: boolean;
  accounts: AccountReport[];
  /** Live windows no listed account claims: unknown email, or none cached. */
  otherWindows: OtherWindowReport[];
  warnings: string[];
}

interface CliOptions {
  format: 'json' | 'text';
  account: string | null;
  maxAgeMs: number;
  help: boolean;
  version: boolean;
}

/** A flag the caller got wrong: reported on stderr, exit 3, no payload. */
class UsageError extends Error {}

/**
 * The same path usage.ts writes, resolved the same way — `os.homedir()` reads
 * `$HOME` on every call, so a caller that overrides it gets the cache it means.
 * A test pins this against usage.ts's own helper so the two cannot drift.
 */
function cachePath(): string {
  return path.join(os.homedir(), '.config', 'claude-accounts', CACHE_FILE);
}

const HELP = `claude-usage — read the usage the Claude Accounts extension has already collected

Usage: claude-usage [--json | --text] [--account <email>] [--max-age <n>[s|m]]
       claude-usage --version
       claude-usage --help

Reads ~/.config/claude-accounts/usage-cache.json, which the extension writes
after a successful fetch, and ~/.config/claude-accounts/windows/, where each open
window records the workspace it has open and the config dir it runs. This command
only reads them: it never writes, locks or fetches, so it never spends an
account's rate limit.

Options:
  --json              JSON on stdout (default)
  --text              compact table instead of JSON
  --account <email>   only this account (case-insensitive)
  --max-age <n>[s|m]  how old a reading may be and still count as fresh
                      (default 10m; a bare number is seconds)
  --version           print the extension version
  --help              print this text

Exit codes:
  0  data printed, all of it fresh
  1  data printed, some of it stale (older than --max-age, or never fetched)
  2  no data (no cache yet, unreadable, nothing matched --account, or every
     account listed is gone from this machine)
  3  usage error or an unexpected failure, message on stderr`;

function parseMaxAge(raw: string): number {
  const m = /^(\d+(?:\.\d+)?)(s|m)?$/.exec(raw.trim());
  if (!m)
    throw new UsageError(`--max-age wants a number with an optional s or m suffix, got "${raw}"`);
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new UsageError(`--max-age must be greater than zero, got "${raw}"`);
  }
  return value * (m[2] === 'm' ? 60_000 : 1_000);
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    format: 'json',
    account: null,
    maxAgeMs: DEFAULT_MAX_AGE_MS,
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const name = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg;
    const inline = arg.startsWith('--') && eq > 0 ? arg.slice(eq + 1) : null;
    const takeValue = (): string => {
      const value = inline ?? argv[++i];
      // `--account --json` would otherwise take the next flag as the value and
      // report "nothing matched" — a wrong answer to a wrong command line. No
      // account or duration starts with --, so this can only be a slip.
      if (value === undefined || value === '' || value.startsWith('--')) {
        throw new UsageError(`${name} needs a value`);
      }
      return value;
    };
    switch (name) {
      case '--json':
        opts.format = 'json';
        break;
      case '--text':
        opts.format = 'text';
        break;
      case '--account':
        opts.account = takeValue().trim().toLowerCase();
        break;
      case '--max-age':
        opts.maxAgeMs = parseMaxAge(takeValue());
        break;
      case '--help':
        opts.help = true;
        break;
      case '--version':
        opts.version = true;
        break;
      default:
        throw new UsageError(`unknown argument "${arg}"`);
    }
  }
  return opts;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * A percentage the API's own contract allows, or nothing. A figure outside
 * 0–100, or one JSON turned into Infinity, is not a reading — passing it
 * through would put a number in front of an agent that no bucket ever held.
 */
function percent(value: unknown, label: string, warnings: string[]): number | null {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    warnings.push(`${label}: dropped an unusable percentage`);
    return null;
  }
  return value;
}

function models(value: unknown, label: string, warnings: string[]): ModelReport[] {
  if (!Array.isArray(value)) return [];
  const out: ModelReport[] = [];
  for (const item of value) {
    const m = record(item) as Partial<ModelLimit> | null;
    const name = text(m?.name);
    if (!name) continue;
    out.push({
      name,
      percent: percent(m?.percent, `${label} ${name}`, warnings),
      resetsAt: text(m?.resetsAt),
    });
  }
  return out;
}

/** `email:a@example.com` / `dir:/path` — a dir-keyed entry simply has no email. */
function emailFromKey(key: string): string | null {
  return key.startsWith('email:') ? key.slice('email:'.length) || null : null;
}

/**
 * What warnings are allowed to call an entry. A dir-keyed entry's key is the
 * full path of a directory holding credentials, and stdout is read by scripts,
 * pasted into issues and scraped into logs — the basename says which account is
 * meant without putting that path anywhere.
 */
function keyLabel(key: string): string {
  const email = emailFromKey(key);
  if (email) return email;
  if (key.startsWith('dir:')) return path.basename(key.slice('dir:'.length)) || '(unknown)';
  return key;
}

/**
 * One label per entry, telling the dir-keyed ones apart. Profiles under
 * different parents share a basename all the time (`work/.claude`,
 * `personal/.claude`), and two warnings both naming `.claude` say nothing about
 * which account each meant. The parent's own basename separates them without
 * putting the path itself on stdout.
 */
function labelsByKey(keys: string[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const key of keys) {
    const base = keyLabel(key);
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  const labels = new Map<string, string>();
  for (const key of keys) {
    const base = keyLabel(key);
    if (!key.startsWith('dir:') || (counts.get(base) ?? 0) < 2) {
      labels.set(key, base);
      continue;
    }
    const parent = path.basename(path.dirname(key.slice('dir:'.length)));
    labels.set(key, parent ? `${parent}/${base}` : base);
  }
  return labels;
}

/** What an entry is, and what to say when the machine cannot tell. */
interface Presence {
  present: boolean;
  warning: string | null;
}

/**
 * Whether the account still exists here. Nothing prunes the usage cache, so an
 * account signed out of months ago stays in it, and its staleness would hold the
 * exit code at 1 for good. Existence of the credentials file is the test — it is
 * never opened, and its directory never reaches the output.
 *
 * Only a credentials file that is genuinely gone means gone. A directory this
 * process cannot look into says nothing about the account, and calling it signed
 * out would quietly drop a live account out of the exit code; such an entry is
 * present, and the warning says the check did not happen.
 */
function presence(snap: Partial<UsageSnapshot>, label: string): Presence {
  const dir = text(snap.configDir);
  if (dir === null) return { present: true, warning: null };
  // CLAUDE_CONFIG_DIR is stored exactly as it was set, so `~/claude` and plain
  // relative values occur. Neither names a directory from here — this process
  // has its own cwd and its own home — and expanding one would be a guess.
  if (!path.isAbsolute(dir)) {
    return {
      present: true,
      warning: `${label}: its config directory is not an absolute path, so its credentials could not be checked — counted as present`,
    };
  }
  try {
    fs.statSync(path.join(dir, CREDENTIALS_FILE));
    return { present: true, warning: null };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { present: false, warning: null };
    return {
      present: true,
      warning: `${label}: could not check its credentials (${code ?? 'unknown error'}) — counted as present`,
    };
  }
}

/** The presence record as this report carries it — no id, and the email is the row's. */
function toWindowReport(w: WindowInfo): WindowReport {
  return { workspace: w.workspace, configDir: w.configDir, pid: w.pid, lastSeen: w.lastSeen };
}

/**
 * The live windows running one account. A dir-keyed entry has no email to match
 * on, so it gets none — never every unattributable window by default.
 */
function windowsForEmail(windows: WindowInfo[], email: string | null): WindowReport[] {
  if (!email) return [];
  const want = email.toLowerCase();
  return windows.filter((w) => (w.email ?? '').toLowerCase() === want).map(toWindowReport);
}

/** The reading fields of an account nothing usable is known about. */
function noReading() {
  return {
    sessionPercent: null,
    sessionResetsAt: null,
    weeklyPercent: null,
    weeklyResetsAt: null,
    models: [] as ModelReport[],
  };
}

function toAccount(
  key: string,
  keyName: string,
  entry: Record<string, unknown>,
  now: number,
  maxAgeMs: number,
  warnings: string[],
  windows: WindowInfo[]
): AccountReport {
  const snap = (record(entry.snap) ?? {}) as Partial<UsageSnapshot>;
  const stamps = [entry.fetchedAt, snap.fetchedAt];
  const fetched = stamps.find((v) => typeof v === 'number' && Number.isFinite(v) && v > 0);
  const fetchedAt = typeof fetched === 'number' ? fetched : null;
  const label = text(snap.email) ?? keyName;
  const here = presence(snap, label);
  if (here.warning) warnings.push(here.warning);
  // An account that is gone counts towards neither the top-level stale flag nor
  // the exit code, so exit 0 means less than it did with it in. A caller reading
  // the exit code alone would never learn what was taken out of it.
  if (!here.present) {
    warnings.push(`${label}: no credentials in its config directory — left out of the exit code`);
  }
  const email = text(snap.email) ?? emailFromKey(key);
  const identity = {
    email,
    planLabel: text(snap.planLabel),
    orgName: text(snap.orgName),
    present: here.present,
    // A window is running it or it is not — that has nothing to do with whether
    // its usage was ever fetched, or whether the reading can be aged.
    windows: windowsForEmail(windows, email),
  };
  // Never fetched: the snapshot's zeros are placeholders the extension writes to
  // have a shape at all, so reporting them as 0% would read as an idle account
  // with a full allowance. Nothing is known here, and null is how that is said.
  if (fetchedAt === null) {
    return { ...identity, ...noReading(), fetchedAt: null, ageMs: null, stale: true };
  }
  const drift = now - fetchedAt;
  // A stamp from the future ages backwards, so a plain age test calls it fresh
  // for as long as it is ahead. Inside the writer's own tolerance it is clock
  // jitter and counts as brand new; past that the reading cannot be aged at all,
  // and an age nobody knows is reported as one nobody knows.
  if (drift < -CLOCK_SKEW_TOLERANCE_MS) {
    warnings.push(`${label}: reading is stamped in the future, so its age is unknown`);
    return { ...identity, ...noReading(), fetchedAt, ageMs: null, stale: true };
  }
  const ageMs = Math.max(0, drift);
  // A fetch can come back carrying no bucket at all, and the writer stores a
  // missing bucket as 0 to keep the snapshot's shape. Those zeros read as an
  // account with its whole allowance intact at the very moment nothing about it
  // is known, and the percentages alone cannot tell the two apart — the count of
  // buckets the response really carried can.
  if (snap.bucketsSeen === 0) {
    warnings.push(`${label}: the last fetch carried no usage buckets`);
    return { ...identity, ...noReading(), fetchedAt, ageMs, stale: true };
  }
  const sessionPercent = percent(snap.sessionPercent, `${label} 5h`, warnings);
  const weeklyPercent = percent(snap.weeklyPercent, `${label} 7d`, warnings);
  const modelReports = models(snap.modelLimits, label, warnings);
  // A fetch that recovered no percentage at all carries no reading, whatever its
  // timestamp says. Calling that fresh would certify numbers the cache has not
  // got, and a script reading the exit code would never learn otherwise.
  const unusable =
    sessionPercent === null &&
    weeklyPercent === null &&
    modelReports.every((m) => m.percent === null);
  if (unusable) warnings.push(`${label}: no usable reading`);
  return {
    ...identity,
    sessionPercent,
    sessionResetsAt: text(snap.sessionResetsAt),
    weeklyPercent,
    weeklyResetsAt: text(snap.weeklyResetsAt),
    models: modelReports,
    fetchedAt,
    ageMs,
    stale: unusable || ageMs > maxAgeMs,
  };
}

/** Every failure to read the cache is "no data" with a reason, never a throw. */
function readEntries(file: string, warnings: string[]): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    warnings.push(
      code === 'ENOENT'
        ? `no usage cache at ${file} — it is written after a successful fetch`
        : `could not read ${file} (${code ?? 'unknown error'})`
    );
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warnings.push(`${file} is not valid JSON`);
    return {};
  }
  const entries = record(record(parsed)?.entries);
  if (!entries) {
    warnings.push(`${file} has no entries object`);
    return {};
  }
  return entries;
}

function buildReport(opts: CliOptions, now: number): Report {
  const warnings: string[] = [];
  const file = cachePath();
  // Presence is read, never written or swept here: this command's contract is
  // that it changes nothing. A missing or unreadable directory is simply no
  // windows — not worth a warning, since a machine with every window closed is
  // exactly when this command is most useful.
  const windows = readWindows(now);
  const accounts: AccountReport[] = [];
  // Attribution is decided against the whole cache, before --account narrows the
  // listing: a window belonging to an account the caller filtered out has been
  // accounted for, and must not resurface as an unattributed one.
  const cached = new Set<string>();
  const entries = Object.entries(readEntries(file, warnings));
  const labels = labelsByKey(entries.map(([key]) => key));
  for (const [key, value] of entries) {
    const keyName = labels.get(key) ?? keyLabel(key);
    const entry = record(value);
    if (!entry) {
      warnings.push(`${keyName}: skipped an entry that is not an object`);
      continue;
    }
    // What an entry drew belongs to that entry: --account asks about one
    // account, and a line about another one is both noise and an address the
    // caller never asked this command for. Cache-level lines stay above.
    const mine: string[] = [];
    const account = toAccount(key, keyName, entry, now, opts.maxAgeMs, mine, windows);
    if (account.email) cached.add(account.email.toLowerCase());
    if (opts.account && (account.email ?? '').toLowerCase() !== opts.account) continue;
    accounts.push(account);
    warnings.push(...mine);
  }
  accounts.sort((a, b) => {
    // An entry keyed by directory has no email to sort on; those go last rather
    // than sorting as an empty string above every real account.
    if (a.email === b.email) return 0;
    if (a.email === null) return 1;
    if (b.email === null) return -1;
    return a.email < b.email ? -1 : 1;
  });
  // Why the filter came back empty is the answer the caller asked for, and a
  // warning about some other account is not it.
  if (opts.account && accounts.length === 0) {
    warnings.push(`no cached usage for ${opts.account}`);
  }
  const otherWindows: OtherWindowReport[] = windows
    .filter((w) => !w.email || !cached.has(w.email.toLowerCase()))
    .map((w) => ({ ...toWindowReport(w), email: w.email }));
  const here = accounts.filter((a) => a.present);
  return {
    schema: SCHEMA,
    generatedAt: now,
    stale: here.length === 0 || here.some((a) => a.stale),
    accounts,
    otherWindows,
    warnings,
  };
}

/** Exit 2 covers "nothing to report", which includes every account being gone. */
function exitCode(report: Report): number {
  const here = report.accounts.filter((a) => a.present);
  if (here.length === 0) return 2;
  return here.some((a) => a.stale) ? 1 : 0;
}

function formatAge(account: AccountReport): string {
  // Two different unknowns: never fetched at all, or fetched at a time this
  // machine cannot age. Neither is a duration, and neither is 0s.
  if (account.ageMs === null) return account.fetchedAt === null ? 'never' : '?';
  const ageMs = account.ageMs;
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1_000)}s`;
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m`;
  return `${(ageMs / 3_600_000).toFixed(1)}h`;
}

function formatPercent(value: number | null): string {
  return value === null ? '—' : `${value}%`;
}

function renderText(report: Report): string {
  const lines: string[] = [];
  if (report.accounts.length) {
    const rows = [
      ['ACCOUNT', 'PLAN', '5H', '7D', 'MODELS', 'WIN', 'AGE', 'STATE'],
      ...report.accounts.map((a) => [
        a.email ?? '(no email)',
        a.planLabel ?? '—',
        formatPercent(a.sessionPercent),
        formatPercent(a.weeklyPercent),
        a.models.map((m) => `${m.name} ${formatPercent(m.percent)}`).join(' · ') || '—',
        String(a.windows.length),
        formatAge(a),
        a.present ? (a.stale ? 'stale' : 'fresh') : 'gone',
      ]),
    ];
    const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
    for (const row of rows) {
      lines.push(
        row
          .map((cell, i) => cell.padEnd(widths[i]))
          .join('  ')
          .trimEnd()
      );
    }
  } else {
    lines.push('no usage data');
  }
  // The table can only count windows against a row, so windows belonging to no
  // cached account would vanish from this format entirely. The count says they
  // are there; --json is where each one's workspace and dir live.
  if (report.otherWindows.length) {
    lines.push(`other windows: ${report.otherWindows.length} (no cached usage for their account)`);
  }
  for (const warning of report.warnings) lines.push(`! ${warning}`);
  return lines.join('\n');
}

/** The manifest sits beside dist/ once installed; run from elsewhere it may not. */
function extensionVersion(): string {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8');
    const value = (JSON.parse(raw) as { version?: unknown }).version;
    if (typeof value === 'string' && value) return value;
  } catch {
    /* fall through to "unknown" */
  }
  return 'unknown';
}

function run(argv: string[]): number {
  let opts: CliOptions;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    process.stderr.write(`claude-usage: ${err.message}\n`);
    return 3;
  }
  if (opts.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (opts.version) {
    process.stdout.write(`${extensionVersion()}\n`);
    return 0;
  }
  const report = buildReport(opts, Date.now());
  const payload = opts.format === 'json' ? JSON.stringify(report, null, 2) : renderText(report);
  process.stdout.write(`${payload}\n`);
  return exitCode(report);
}

/**
 * Exit 1 is part of the contract — "data printed, some of it stale" — so a crash
 * must never reach it. Anything unforeseen is a usage-side failure: one line on
 * stderr and exit 3, which no caller can mistake for a reading.
 */
function main(argv: string[]): number {
  try {
    return run(argv);
  } catch (err) {
    process.stderr.write(`claude-usage: ${err instanceof Error ? err.message : String(err)}\n`);
    return 3;
  }
}

// A consumer closing the pipe (`claude-usage | head`) fails the write after main
// has returned; nothing is wrong with the command or the data, so the exit code
// it already decided stands rather than an unhandled 'error' event killing it.
// That kill exits 1 — a reading, on a run that printed none — so stderr needs the
// same handling as stdout: a caller reading only the message can close it too.
function onStreamError(err: NodeJS.ErrnoException): void {
  if (err.code === 'EPIPE') {
    process.exit(typeof process.exitCode === 'number' ? process.exitCode : 0);
  }
  process.stderr.write(`claude-usage: ${err.message}\n`);
  process.exit(3);
}

process.stdout.on('error', onStreamError);
process.stderr.on('error', onStreamError);

// exitCode rather than exit(): a piped stdout is still being flushed here.
process.exitCode = main(process.argv.slice(2));
