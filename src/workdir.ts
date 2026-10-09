import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { isDeepStrictEqual } from 'util';
import { Account, readIdentity, hasCredentials } from './accounts';
import { isReservedClaudeDirName } from './sidecars';
import { log } from './log';
import { emailsEqual } from './workspaceRoutes';
import { writeFileAtomic, copyFileAtomic, withLockAsync } from './fsSafe';

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
 * The duplicated credentials this implies are safe for ACCESS: copies of a token
 * authenticate independently (verified against the live API). But they are not
 * safe forever — Anthropic ROTATES the refresh token on refresh, so the first
 * copy to refresh strands every other copy of that grant (0.9.3's store
 * newest-wins and 0.9.9's silent stale restock exist to manage exactly that).
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
  if (hasCredentials(workingDir) && readIdentity(workingDir)?.email === account.email) {
    // Same account already. Without force, never churn (the dir's copy may hold a
    // newer refreshed token). WITH force, still skip when the GRANT matches, and
    // leave a grant of a family the store has never replaced: a later sign-in, a
    // later refresh of the current family, or a grant with no family anchor. A
    // forced restock repairs a dir that wears this identity but holds another
    // account's grant, a grant of a family another account's chain knows, or a
    // copy this store has moved past.
    if (!force) return false;
    try {
      const dirTok = fs.readFileSync(path.join(workingDir, '.credentials.json'));
      const storeTok = fs.readFileSync(path.join(account.dir, '.credentials.json'));
      if (sameCredential(dirTok, storeTok)) return false;
      const relation = relateToStore(dirTok, storeTok, readGrantChain(account.dir));
      if (
        (relation === 'continuation' ||
          relation === 'sign-in' ||
          relation === 'legacy' ||
          relation === 'behind') &&
        tokenExpiry(dirTok) != null &&
        foreignTokenConflict(account.dir, dirTok, account.email) == null &&
        foreignAnchorConflict(account.dir, anchorOf(dirTok), account.email) == null
      ) {
        log(
          `workdir: ${workingDir} holds a grant ${account.name}'s store has never held — left in place`
        );
        return false;
      }
    } catch {
      return false; // can't compare — leave the dir as-is rather than risk churn
    }
  }
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
 * A stable fingerprint identifying which ACCOUNT a `.credentials.json` belongs to,
 * independent of JSON key order, whitespace, or volatile fields like `expiresAt`
 * and the rotating access token. Two files carrying the same account's grant
 * fingerprint equal even after an access-token refresh; different accounts differ.
 * Falls back to the raw bytes when the buffer isn't the expected token JSON.
 */
export function credentialFingerprint(buf: Buffer): string {
  try {
    const d = JSON.parse(buf.toString('utf-8')) as {
      claudeAiOauth?: { refreshToken?: string; accessToken?: string };
      refreshToken?: string;
      accessToken?: string;
    };
    const o = d.claudeAiOauth ?? d;
    // Fingerprint on the REFRESH token: it is the stable, account-identifying
    // secret shared by every copy of a grant, and the one a /logout revokes. The
    // ACCESS token rotates in place on every refresh (per-dir, and by Claude Code
    // itself), so keying on it would make two copies of the SAME account's grant
    // look like different accounts the moment either refreshed — letting a
    // refreshed copy slip past the contamination guard.
    const rt = o?.refreshToken ?? d.refreshToken;
    if (rt) return `rt:${rt}`;
    const at = o?.accessToken ?? d.accessToken;
    if (at) return `at:${at}`;
  } catch {
    /* not token JSON — fall through to raw bytes */
  }
  return `raw:${buf.toString('base64')}`;
}

/** True when two credential buffers carry the same underlying OAuth grant. */
export function sameCredential(a: Buffer, b: Buffer): boolean {
  return credentialFingerprint(a) === credentialFingerprint(b);
}

/**
 * The access-token expiry (ms since epoch) recorded in a `.credentials.json`, or
 * null when it is absent/unparseable. Used to decide which of two grants for the
 * SAME account is the freshest — a refresh mints a new expiry, so the higher one
 * is the more recently refreshed grant.
 */
export function tokenExpiry(buf: Buffer): number | null {
  try {
    const d = JSON.parse(buf.toString('utf-8')) as {
      claudeAiOauth?: { expiresAt?: number };
      expiresAt?: number;
    };
    const e = d.claudeAiOauth?.expiresAt ?? d.expiresAt;
    return typeof e === 'number' ? e : null;
  } catch {
    return null;
  }
}

/** How many grant hashes a store remembers; older ones fall off the front. */
const GRANT_HISTORY_MAX = 4096;

/** How many displaced family anchors a store remembers, one per sign-in it replaced. */
const DISPLACED_MAX = 256;

/**
 * Two anchors this close belong to one token family. A refresh keeps the anchor
 * within about a second; two sign-ins have landed hours apart on every probe, so
 * ten minutes absorbs a clock step without merging two sign-ins.
 */
export const ANCHOR_WINDOW_MS = 10 * 60_000;

/** A credential file written this recently may be a sign-in still in progress. */
export const LOGIN_BURST_MS = 10_000;

/** The r1 hash list. Read for its hashes; only windows on an older version write it. */
export function grantHistoryPath(storeDir: string): string {
  return path.join(storeDir, '.grant-history.json');
}

/**
 * The store's chain: the anchor of the family it currently holds, the anchors
 * of families it moved past, and the hashes of every grant it has held. Its own
 * file, so an older window rewriting the r1 list as an array cannot erase it.
 */
export function grantChainPath(storeDir: string): string {
  return path.join(storeDir, '.grant-chain.json');
}

export interface GrantChain {
  current: number | null;
  displaced: number[];
  hashes: string[];
}

/** sha256 of a grant's fingerprint — what the history stores, never the secret. */
export function grantHash(buf: Buffer): string {
  return crypto.createHash('sha256').update(credentialFingerprint(buf)).digest('hex');
}

/**
 * The grant's family anchor: `refreshTokenExpiresAt`, which every refresh of one
 * sign-in carries unchanged and each new sign-in sets later. Null when absent.
 */
export function anchorOf(buf: Buffer): number | null {
  try {
    const d = JSON.parse(buf.toString('utf-8')) as {
      claudeAiOauth?: { refreshTokenExpiresAt?: unknown };
    };
    const a = d.claudeAiOauth?.refreshTokenExpiresAt;
    return typeof a === 'number' && Number.isFinite(a) ? a : null;
  } catch {
    return null;
  }
}

/** True when two anchors name one family; a missing anchor matches nothing. */
export function sameAnchor(a: number | null, b: number | null): boolean {
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= ANCHOR_WINDOW_MS;
}

const isFiniteNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** The store's chain, with any r1 hash list merged in; empty when neither exists. */
export function readGrantChain(storeDir: string): GrantChain {
  let current: number | null = null;
  let displaced: number[] = [];
  let hashes: string[] = [];
  try {
    const d = JSON.parse(fs.readFileSync(grantChainPath(storeDir), 'utf-8')) as {
      current?: unknown;
      displaced?: unknown;
      hashes?: unknown;
    };
    if (d && typeof d === 'object') {
      if (isFiniteNumber(d.current)) current = d.current;
      if (Array.isArray(d.displaced)) displaced = d.displaced.filter(isFiniteNumber);
      if (Array.isArray(d.hashes)) {
        hashes = d.hashes.filter((h): h is string => typeof h === 'string');
      }
    }
  } catch {
    /* no chain yet */
  }
  try {
    const legacy = JSON.parse(fs.readFileSync(grantHistoryPath(storeDir), 'utf-8')) as unknown;
    if (Array.isArray(legacy)) {
      const seen = new Set(hashes);
      for (const h of legacy) {
        if (typeof h === 'string' && !seen.has(h)) {
          seen.add(h);
          hashes.push(h);
        }
      }
    }
  } catch {
    /* no r1 list */
  }
  return { current, displaced, hashes };
}

/** The hashes of every grant this store has held (newest last); [] when unknown. */
export function readGrantHistory(storeDir: string): string[] {
  return readGrantChain(storeDir).hashes;
}

/** Stores whose regression has been logged, keyed with the anchor they moved back to. */
const regressionLogged = new Set<string>();

/**
 * Notes the grant the store holds. Its hash joins the list; its family becomes
 * current when it is later than the current one, which moves to the displaced
 * list. `current` never moves back: an earlier family in the store's file means
 * a window on an older version wrote it, and the store is left behind its chain
 * until a sign-in of a later family. Hashes and anchors only, and nothing is
 * written when nothing changed.
 */
export function observeStoreGrant(storeDir: string, buf: Buffer): void {
  try {
    const chain = readGrantChain(storeDir);
    let changed = false;
    const hash = grantHash(buf);
    if (!chain.hashes.includes(hash)) {
      chain.hashes.push(hash);
      changed = true;
    }
    const a = anchorOf(buf);
    if (a != null) {
      if (chain.current == null) {
        chain.current = a;
        changed = true;
      } else if (a > chain.current + ANCHOR_WINDOW_MS) {
        const prev = chain.current;
        chain.displaced = chain.displaced.filter((d) => d !== prev);
        chain.displaced.push(prev);
        chain.current = a;
        changed = true;
      } else if (a < chain.current - ANCHOR_WINDOW_MS) {
        const key = `${path.normalize(storeDir)}\0${a}`;
        if (!regressionLogged.has(key)) {
          regressionLogged.add(key);
          log(
            `workdir: store of ${path.basename(storeDir)} moved back to an earlier family — ` +
              `not recorded as current`
          );
        }
      }
    }
    if (!changed) return;
    writeFileAtomic(
      grantChainPath(storeDir),
      JSON.stringify({
        v: 2,
        current: chain.current,
        displaced: chain.displaced.slice(-DISPLACED_MAX),
        hashes: chain.hashes.slice(-GRANT_HISTORY_MAX),
      }),
      { mode: 0o600 }
    );
  } catch (err) {
    log(`workdir: could not record grant chain in ${storeDir}: ${(err as Error).message}`);
  }
}

/** Stores whose foreign grant has been logged as kept out of their chain. */
const foreignObservationLogged = new Set<string>();

/**
 * Logs, once per store, that its file holds another account's grant and so was
 * not observed: recording that family would make the other account's own grants
 * read as foreign here until it signs in again.
 */
export function noteForeignStoreGrant(storeDir: string): void {
  const key = path.normalize(storeDir);
  if (foreignObservationLogged.has(key)) return;
  foreignObservationLogged.add(key);
  log(
    `workdir: store of ${path.basename(storeDir)} holds another account's grant — ` +
      `not recorded in its chain`
  );
}

export type StoreRelation =
  'same' | 'known' | 'continuation' | 'fork' | 'sign-in' | 'behind' | 'legacy' | 'unrelated';

/**
 * How a window's grant relates to its store's, by family order.
 *
 * A refreshed dead lineage is file-identical to a sign-in except for its family
 * anchor, which a refresh keeps and a sign-in sets later. So the window's anchor
 * is compared with the store's reference family (the later of the chain's
 * current family and the store file's): a later family is a sign-in, an earlier
 * one a fork of a family the store moved past. Within the reference family, a
 * hash the store has held or an older refresh is `known`, a later refresh a
 * `continuation`. A store file that has fallen behind its chain (an older
 * version wrote an earlier family back) is left for a sign-in: every grant that
 * is not of a later family than the chain is `behind`, since the file cannot
 * tell a live grant of the current family from a consumed one. A grant without
 * an anchor is `legacy` and matches nothing; an unreadable store takes a grant
 * that has an anchor and an expiry.
 * Pure: no clock, no mtime. `unrelated` is only ever set by a caller whose
 * tripwire refused the grant.
 */
export function relateToStore(dirTok: Buffer, storeTok: Buffer, chain: GrantChain): StoreRelation {
  if (sameCredential(dirTok, storeTok)) return 'same';
  const a = anchorOf(dirTok);
  const dirExp = tokenExpiry(dirTok);
  const storeExp = tokenExpiry(storeTok);
  if (storeExp == null) return dirExp != null && a != null ? 'sign-in' : 'legacy';
  const s = anchorOf(storeTok);
  if (a == null || s == null) return 'legacy';
  if (chain.current != null && s < chain.current - ANCHOR_WINDOW_MS) {
    return a > chain.current + ANCHOR_WINDOW_MS ? 'sign-in' : 'behind';
  }
  const ref = chain.current != null ? Math.max(chain.current, s) : s;
  if (a > ref + ANCHOR_WINDOW_MS) return 'sign-in';
  if (a < ref - ANCHOR_WINDOW_MS) return 'fork';
  if (chain.hashes.includes(grantHash(dirTok))) return 'known';
  if (dirExp != null && dirExp > storeExp) return 'continuation';
  return 'known';
}

export type HealVerdict = 'adopt' | 'restock' | 'keep';

export interface HealDecision {
  verdict: HealVerdict;
  reason: string;
}

/**
 * What reconcile does with a window grant once it is related to the store. A
 * sign-in or a continuation is adopted; a known copy or a fork is restocked,
 * whatever its expiry; anything else is kept, a grant of a store behind its
 * chain included (that store is left for a sign-in). A file written in the last
 * few seconds is left alone: a sign-in is a burst of writes, and judging its
 * middle would undo it.
 */
export function healVerdict(
  relation: StoreRelation | null,
  selfHeal: boolean,
  dirMtimeMs: number | null,
  nowMs: number
): HealDecision {
  switch (relation) {
    case 'same':
    case 'legacy':
    case 'unrelated':
    case 'behind':
      return { verdict: 'keep', reason: relation };
    case 'continuation':
    case 'sign-in':
      return { verdict: 'adopt', reason: relation };
    case 'known':
    case 'fork':
      if (!selfHeal) return { verdict: 'keep', reason: 'selfHeal-off' };
      if (dirMtimeMs == null) return { verdict: 'keep', reason: 'unreadable-mtime' };
      if (nowMs - dirMtimeMs < LOGIN_BURST_MS) return { verdict: 'keep', reason: 'burst' };
      return { verdict: 'restock', reason: relation };
    default:
      return { verdict: 'keep', reason: 'unjudged' };
  }
}

/**
 * The activation step's half of the self-heal. It runs synchronously before
 * Claude Code reads the env (see windowWorkingDir), so a copy the store has moved
 * past is replaced before the process can refresh it into a fork. It reads the
 * chain and never writes it: chain writes happen under the store lock only.
 */
export function healAtActivation(account: Account, dir: string, opts: { selfHeal: boolean }): void {
  try {
    const file = path.join(dir, '.credentials.json');
    if (!fs.existsSync(file)) return;
    if (!opts.selfHeal) return;
    if (!hasCredentials(dir) || !emailsEqual(readIdentity(dir)?.email, account.email)) return;
    const dirTok = fs.readFileSync(file);
    const storeTok = fs.readFileSync(path.join(account.dir, '.credentials.json'));
    const relation = relateToStore(dirTok, storeTok, readGrantChain(account.dir));
    if (relation !== 'known' && relation !== 'fork') return;
    const storeForeign = foreignTokenConflict(account.dir, storeTok, account.email);
    if (storeForeign) {
      log(`workdir: store grant of ${account.name} also lives in ${storeForeign} — not restocked`);
      return;
    }
    const familyForeign = foreignAnchorConflict(account.dir, anchorOf(storeTok), account.email);
    if (familyForeign) {
      log(
        `workdir: store grant of ${account.name} is of a family ${familyForeign} also holds — ` +
          `not restocked`
      );
      return;
    }
    if (restockTokenOnly(storeTok, dir, dirTok)) {
      log(`workdir: ${dir} restocked at activation (${relation})`);
    }
  } catch (err) {
    log(`workdir: activation heal of ${dir} failed: ${(err as Error).message}`);
  }
}

/**
 * Copies ONLY the credential file from an account store into a working dir —
 * never the store's frozen `.claude.json`, which would revert the window's live
 * per-project state. Used to quietly bring a window whose grant another window
 * rotated past back onto the live token: file only, no process kill, no reload
 * (the running Claude Code may keep its in-memory copy until restart — the
 * status bar carries the "reload if it errors" note). Returns true only when the
 * dir actually holds credentials afterwards.
 *
 * `expected` is a compare-and-swap guard on the DIR file: the caller's staleness
 * verdict was made from a snapshot taken before awaits (store-lock contention can
 * stall the reconcile for seconds). If the dir changed underneath — a /login
 * rotated it to another account, or a /logout emptied it — overwriting would
 * clobber the fresh sign-in or resurrect a revoked token, so bail; the account
 * watcher re-fires reconcile on the new state and it is judged afresh.
 *
 * `source` as a Buffer writes exactly those bytes — callers that tripwire-check
 * the store grant first pass the checked buffer, so the write can never pick up
 * a store rewrite the check didn't see. A string is a store dir to read from.
 */
export function restockTokenOnly(
  source: string | Buffer,
  workingDir: string,
  expected?: Buffer
): boolean {
  try {
    // Hold the grant bytes in memory and write exactly them: an exists-then-copy
    // pair could no-op on a store deleted in between while the old file still made
    // the dir "look" credentialed — a false success that would fire the healed note
    // for a window still on the dead grant.
    const src = Buffer.isBuffer(source)
      ? source
      : fs.readFileSync(path.join(source, '.credentials.json'));
    const dst = path.join(workingDir, '.credentials.json');
    if (expected) {
      let cur: Buffer;
      try {
        cur = fs.readFileSync(dst);
      } catch {
        return false; // emptied since the verdict (logout) — never resurrect
      }
      if (!cur.equals(expected)) return false; // rotated since the verdict (new login)
    }
    fs.mkdirSync(workingDir, { recursive: true, mode: 0o700 });
    writeFileAtomic(dst, src, { mode: 0o600 });
    return true;
  } catch (err) {
    log(`workdir: could not restock token into ${workingDir}: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Cross-account contamination tripwire. Returns the path of another account
 * store that already holds this exact OAuth grant under a DIFFERENT identity, or
 * null.
 *
 * Two accounts can never legitimately share one OAuth grant, so a token about to
 * be written into account A's store that already lives in account B's store is
 * the signature of the credential mix that once left every account sharing a
 * single token (one account's `/logout` then killing them all). Same-email
 * duplicate stores DO legitimately share a grant, so an identity match never
 * conflicts.
 *
 * Fails CLOSED: if the target store's own identity can't be read (corrupt/absent
 * `.claude.json`), the caller passes the account's known email as `targetEmail`;
 * and when another store owns the grant under a known email while the target's is
 * unknown, that is still treated as a conflict — the mix must not slip through an
 * unreadable identity file.
 */
export function foreignTokenConflict(
  targetStoreDir: string,
  token: Buffer,
  targetEmail?: string
): string | null {
  const home = os.homedir();
  const wantEmail = (readIdentity(targetStoreDir)?.email ?? targetEmail)?.trim().toLowerCase();
  const wantFp = credentialFingerprint(token);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(home, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory() || !/^\.claude[-_]/.test(e.name)) continue;
    // Skip extension internals and Docker/tool sidecars — they are not managed
    // accounts, and one legitimately holding a copied token must not read as a mix.
    if (isReservedClaudeDirName(e.name)) continue;
    const dir = path.join(home, e.name);
    if (path.normalize(dir) === path.normalize(targetStoreDir)) continue;
    let buf: Buffer;
    try {
      buf = fs.readFileSync(path.join(dir, '.credentials.json'));
    } catch {
      continue; // no token here
    }
    if (credentialFingerprint(buf) !== wantFp) continue;
    const otherEmail = readIdentity(dir)?.email?.trim().toLowerCase();
    // A shared grant is legitimate ONLY between two copies of the SAME account —
    // both identities readable AND equal. Every other case (different emails, or
    // EITHER identity unreadable) cannot be proven same-account, so refuse: a
    // shared grant we cannot attribute to one account is the contamination
    // signature, and failing closed never wrongly writes a foreign token.
    if (!(wantEmail && otherEmail && wantEmail === otherEmail)) return dir;
  }
  return null;
}

/**
 * The family form of the tripwire: the path of another account store whose
 * chain (current or displaced) or credential file carries a family within the
 * anchor window of `anchor` under a different or unreadable identity, or null.
 * A family belongs to one sign-in of one account, so finding it under another
 * name is the contamination signature even when no grant matches byte-wise.
 * Same-email stores never conflict; a missing anchor matches nothing.
 */
export function foreignAnchorConflict(
  targetStoreDir: string,
  anchor: number | null,
  targetEmail?: string
): string | null {
  if (anchor == null) return null;
  const home = os.homedir();
  const wantEmail = (readIdentity(targetStoreDir)?.email ?? targetEmail)?.trim().toLowerCase();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(home, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory() || !/^\.claude[-_]/.test(e.name)) continue;
    if (isReservedClaudeDirName(e.name)) continue;
    const dir = path.join(home, e.name);
    if (path.normalize(dir) === path.normalize(targetStoreDir)) continue;
    const otherEmail = readIdentity(dir)?.email?.trim().toLowerCase();
    if (wantEmail && otherEmail && wantEmail === otherEmail) continue;
    const chain = readGrantChain(dir);
    const anchors = [chain.current, ...chain.displaced];
    try {
      anchors.push(anchorOf(fs.readFileSync(path.join(dir, '.credentials.json'))));
    } catch {
      /* no token here */
    }
    if (anchors.some((x) => sameAnchor(x, anchor))) return dir;
  }
  return null;
}

/** What one refreshStore pass concluded; `deferred` when the store lock was busy. */
export interface StoreRefresh {
  relation: StoreRelation | null;
  wrote: boolean;
  deferred: boolean;
}

/**
 * Copies a working dir's (possibly refreshed) token back into the account's
 * store, so the store never falls far behind the credential actually in use.
 * Only the token: the store's config is the account's own and shouldn't be
 * churned by every window that runs it.
 *
 * Refuses when the incoming token already belongs to a DIFFERENT account (the
 * contamination tripwire), by grant or by family: a working dir whose identity
 * has drifted from its token would otherwise write one account's credential
 * into another's store.
 */
export async function refreshStore(account: Account, workingDir: string): Promise<StoreRefresh> {
  const src = path.join(workingDir, '.credentials.json');
  const dst = path.join(account.dir, '.credentials.json');
  const out: StoreRefresh = { relation: null, wrote: false, deferred: false };
  try {
    if (!fs.existsSync(src)) return out;
    // Serialize the read-compare-write on the store's credentials — the SAME lock
    // ensureFreshToken (usage.ts) takes when it rotates a store token — so the
    // judgment is a real compare-and-set, not a lock-free RMW that could publish
    // an older grant over a concurrently-written newer one. Async lock: it awaits
    // between attempts (never a synchronous Atomics.wait), so it can't freeze the
    // extension host even while ensureFreshToken holds this lock across a
    // multi-second OAuth refresh. skipIfUnacquired: never write unlocked on a stale
    // read — skip and let a later reconcile retry (the holder is publishing a grant
    // anyway). The callers (reconcile, captureCurrentAccount) are already async.
    const { locked } = await withLockAsync(
      `${dst}.lock`,
      () => {
        let incoming: Buffer;
        try {
          incoming = fs.readFileSync(src);
        } catch {
          return; // emptied since the check — a logout, nothing to carry
        }
        let cur = Buffer.alloc(0);
        if (fs.existsSync(dst)) {
          cur = fs.readFileSync(dst);
          // The store's grant goes into its chain before anything replaces it, so
          // a copy of it left in another dir is recognised later as one the store
          // has moved past, and a family the store's file moved to becomes current.
          if (foreignTokenConflict(account.dir, cur, account.email) == null) {
            observeStoreGrant(account.dir, cur);
          } else {
            noteForeignStoreGrant(account.dir);
          }
          if (cur.equals(incoming)) {
            out.relation = 'same';
            return;
          }
        }
        const conflict =
          foreignTokenConflict(account.dir, incoming, account.email) ??
          foreignAnchorConflict(account.dir, anchorOf(incoming), account.email);
        if (conflict) {
          out.relation = 'unrelated';
          log(
            `workdir: REFUSED store refresh of ${account.name} — that token already belongs to ` +
              `${conflict} (cross-account contamination guard)`
          );
          return;
        }
        // Never regress the store, and never take in a grant only because it looks
        // newer: a refreshed dead lineage looks exactly like a sign-in except for
        // its family. A later family is a sign-in and is taken in; an earlier one,
        // or a copy of the current one the store has held or moved past, stays out
        // (with every window watching the store, write-through of older copies
        // would flap it). The store's own grant refreshed in place is written
        // through when its expiry is later.
        const chain = readGrantChain(account.dir);
        const relation = relateToStore(incoming, cur, chain);
        out.relation = relation;
        const inExp = tokenExpiry(incoming);
        const curExp = tokenExpiry(cur);
        const write =
          relation === 'continuation' ||
          relation === 'sign-in' ||
          (relation === 'same' && inExp != null && (curExp == null || inExp > curExp));
        const who = account.email ?? account.name;
        if (!write) {
          log(
            relation === 'known'
              ? `workdir: ${who}: incoming grant is a known older copy — kept store`
              : relation === 'same'
                ? `workdir: ${who}: incoming grant is not newer than the store's — kept store`
                : relation === 'fork'
                  ? `workdir: ${who}: incoming grant is a refresh of a family a later sign-in ` +
                    `replaced — kept store`
                  : relation === 'behind'
                    ? `workdir: ${who}: store file is behind its chain — kept both; ` +
                      `a sign-in restores it`
                    : `workdir: ${who}: incoming grant has no family anchor — kept both`
          );
          return;
        }
        fs.mkdirSync(account.dir, { recursive: true, mode: 0o700 });
        // Unique-temp atomic write: a half-written store is worse than a stale one.
        writeFileAtomic(dst, incoming, { mode: 0o600 });
        observeStoreGrant(account.dir, incoming);
        out.wrote = true;
        log(`workdir: refreshed store of ${who} (${relation})`);
      },
      { capMs: 3_000, skipIfUnacquired: true }
    );
    if (!locked) {
      out.deferred = true;
      log(`workdir: store of ${account.email ?? account.name} is busy — deferred refresh`);
    }
  } catch (err) {
    log(`workdir: could not refresh store of ${account.name}: ${(err as Error).message}`);
  }
  return out;
}

/** Every working dir on disk — used to sign an account out of all of them. */
export function allWorkingDirs(): string[] {
  try {
    return fs
      .readdirSync(workingRoot(), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.endsWith('.lock'))
      .map((e) => path.join(workingRoot(), e.name));
  } catch {
    return []; // nothing created yet
  }
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

/** Mirror of fsSafe's owner-write gap — a missing owner.json is only stale after this. */
const LOCK_OWNER_WRITE_GRACE_MS = 5_000;
/** Cross-host liveness is unknowable; treat as live unless older than this. */
const FOREIGN_HOST_STALE_MS = 15 * 60_000;

/**
 * Whether a leftover working-dir lock may be removed. Mirrors fsSafe.isLockStale:
 * a same-host live pid is never stale; a foreign-host owner is stale only after
 * 15 minutes; a missing/unreadable owner.json is stale only once the dir is older
 * than the owner-write grace (a live acquirer has a brief gap before writing it).
 * A parseable owner that lacks a string host or a numeric at is treated like a
 * missing owner (mtime grace) rather than stuck on the foreign-host branch.
 * A vanished dir is not stale — nothing to remove.
 */
function isWorkingLockStale(dir: string): boolean {
  let owner: { pid?: unknown; host?: unknown; at?: unknown } | null = null;
  try {
    owner = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf-8')) as {
      pid?: unknown;
      host?: unknown;
      at?: unknown;
    };
  } catch {
    /* missing/unreadable owner.json */
  }
  if (owner) {
    if (owner.host === os.hostname()) {
      return typeof owner.pid !== 'number' || !processAlive(owner.pid);
    }
    if (typeof owner.host === 'string' && typeof owner.at === 'number') {
      return Date.now() - owner.at > FOREIGN_HOST_STALE_MS;
    }
    // Malformed owner (no string host, or no numeric at) — same as missing.
  }
  try {
    return Date.now() - fs.statSync(dir).mtimeMs > LOCK_OWNER_WRITE_GRACE_MS;
  } catch {
    return false;
  }
}

/**
 * Remove leftover `<id>.lock` dirs under ~/.claude-windows from an older lock
 * scheme. Those names used to be picked up as windows and got shared-history
 * symlinks planted in them. Only dirs that are stale (see isWorkingLockStale)
 * AND whose entries are exclusively symlinks and/or owner.json are removed —
 * anything holding real files is left and logged, so the "contents are only
 * symlinks" claim stays honest. A failed rmSync is logged and the sweep continues.
 */
export function sweepStaleWorkingLocks(): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(workingRoot(), { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.endsWith('.lock')) continue;
    const dir = path.join(workingRoot(), e.name);
    try {
      if (!isWorkingLockStale(dir)) continue;
      const kids = fs.readdirSync(dir, { withFileTypes: true });
      if (!kids.every((k) => k.isSymbolicLink() || k.name === 'owner.json')) {
        log(`workdir: leaving ${dir} — holds real files`);
        continue;
      }
      fs.rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch (err) {
      log(`workdir: could not remove ${dir}: ${(err as Error).message}`);
    }
  }
  if (removed > 0) log(`workdir: swept ${removed} stale .lock dir(s)`);
  return removed;
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
/**
 * User-scope Claude Code asset dirs shared into every managed window. Claude Code
 * looks these up under CLAUDE_CONFIG_DIR, so without the links a user's personal
 * skills/agents/commands exist only in ~/.claude and silently vanish in managed
 * windows. Deliberately NOT plugins/: Claude Code writes live state there
 * (marketplaces, caches) and sharing it would race across windows; plugin assets
 * materialize per-window on their own. hooks/ needs no link — the shared
 * settings.json references hooks by absolute path.
 */
const USER_ASSET_DIRS = ['skills', 'agents', 'commands'];

/**
 * Symlinks ~/.claude/{skills,agents,commands} into a managed working dir, same
 * pattern as linkUserSettings: link when the source exists, never when the
 * working dir IS ~/.claude, one-time .bak rename for a real local dir. Unlike
 * settings.json (where the shared file is authoritative and a superseded local
 * copy is deleted), a real local DIR that reappears after its .bak was taken is
 * left alone and logged — these are user-authored files; the LINKING path never
 * deletes a directory of them. (Uninstall still removes working dirs wholesale,
 * .bak included — per-window leftovers, never the ~/.claude sources.)
 */
export function linkUserAssets(workingDir: string): void {
  let home: string;
  try {
    home = path.join(os.homedir(), '.claude');
    if (path.normalize(workingDir) === path.normalize(home)) return; // source itself
  } catch {
    return;
  }
  for (const name of USER_ASSET_DIRS) {
    try {
      const src = path.join(home, name);
      if (!fs.existsSync(src)) continue; // nothing to share (yet)
      const dst = path.join(workingDir, name);
      const st = fs.lstatSync(dst, { throwIfNoEntry: false });
      if (st?.isSymbolicLink()) {
        if (path.normalize(fs.readlinkSync(dst)) === path.normalize(src)) continue;
        fs.unlinkSync(dst); // stale link elsewhere — replace with ours
      } else if (st) {
        const bak = `${dst}.bak`;
        if (fs.existsSync(bak)) {
          log(`workdir: ${dst} exists alongside its .bak — leaving both, not linking ${name}`);
          continue;
        }
        fs.renameSync(dst, bak);
      }
      fs.symlinkSync(src, dst);
    } catch (err) {
      log(`workdir: could not link ${name} into ${workingDir}: ${(err as Error).message}`);
    }
  }
}

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
      if (!st.isSymbolicLink()) {
        // Preserve the ORIGINAL per-window settings.json exactly once (never
        // overwrite an existing backup — a later real file is a superseded
        // in-window change, and the shared settings are authoritative). If we
        // cannot make that first backup, leave the file in place rather than
        // delete the only copy; the next reconcile retries.
        const bak = `${dst}.bak`;
        if (!fs.existsSync(bak)) {
          try {
            fs.copyFileSync(dst, bak);
          } catch {
            return;
          }
        }
      }
      fs.unlinkSync(dst);
    }
    fs.symlinkSync(src, dst);
  } catch (err) {
    log(`workdir: could not link user settings into ${workingDir}: ${(err as Error).message}`);
  }
}
