import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Cross-process-safe filesystem primitives.
 *
 * This extension runs as one process per VS Code window, and every window
 * reads/writes the same files under $HOME (the account stores, the machine-wide
 * `~/.config/claude-accounts/*.json`, `~/.claude`, `~/.claude-shared`). Node has
 * no file locking, so the two hazards are:
 *
 *   1. Torn writes — two processes staging to the SAME temp path interleave their
 *      bytes into one inode; the rename then publishes garbage. `writeFileAtomic`
 *      gives every write a UNIQUE staging name so a rename only ever publishes a
 *      fully-written file. This is necessary AND sufficient for tear-freedom.
 *
 *   2. Lost updates — a read-modify-write of a shared file (read JSON, patch,
 *      write back) where a concurrent writer's change is clobbered. Unique temps
 *      do NOT fix this; the critical section must be serialized. `withLock` /
 *      `withLockAsync` give a best-effort advisory lock for the files this
 *      extension fully owns (no other program writes them).
 *
 * Locks are a `mkdir` sentinel (atomic exclusive create, more portable than
 * `O_EXCL` on a networked $HOME). A crashed holder is reclaimed by PID liveness
 * first (windows share a host) and a generous age fallback second — never age
 * alone, so a long-running holder is not robbed mid-operation.
 */

let tmpCounter = 0;

/**
 * Atomically writes `data` to `target`: stage to a unique temp in the same
 * directory, then rename over the target. `mode` is applied at create time (so a
 * secret is never briefly world-readable). The parent directory must exist.
 */
export function writeFileAtomic(
  target: string,
  data: string | Buffer,
  opts: { mode?: number } = {}
): void {
  const tmp = `${target}.${process.pid}.${tmpCounter++}.tmp`;
  try {
    fs.writeFileSync(tmp, data, opts.mode !== undefined ? { mode: opts.mode } : {});
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort — leave no half-written staging file behind */
    }
    throw err;
  }
}

/**
 * Copies `src` to `dst` atomically by reading it into memory and writing with an
 * explicit mode. Preferred over copyFile+chmod for secrets: the destination is
 * created at `mode` instead of inheriting the source's (possibly looser) mode and
 * being narrowed a moment later. No-op if `src` is missing.
 */
export function copyFileAtomic(src: string, dst: string, mode = 0o600): void {
  if (!fs.existsSync(src)) return;
  writeFileAtomic(dst, fs.readFileSync(src), { mode });
}

interface LockOwner {
  pid: number;
  host: string;
  at: number;
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

function readOwner(lockDir: string): LockOwner | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf-8')) as LockOwner;
  } catch {
    return null;
  }
}

/** A fresh lock dir has no owner.json for a moment; don't reclaim within this. */
const OWNER_WRITE_GRACE_MS = 5_000;
/** A reclaim token from a crashed reclaimer is itself reclaimable after this. */
const RECLAIM_TOKEN_STALE_MS = 5_000;

/**
 * Whether an existing lock may be reclaimed. A same-host live PID is never stale
 * (a first-time history merge can hold the lock for minutes); a dead same-host
 * PID is. A cross-host holder's liveness is unknowable, so fall back to age. A
 * missing owner.json is ALSO the momentary state of a live acquirer between
 * creating the dir and writing its owner — so treat that as stale only once the
 * dir is older than that write gap (i.e. the acquirer crashed). A vanished dir is
 * NOT stale: the holder released it, so it is free — retry the plain mkdir rather
 * than reclaim (reclaiming a since-freed path is what raced a fresh acquirer).
 */
function isLockStale(lockDir: string, staleMs: number): boolean {
  const owner = readOwner(lockDir);
  if (owner) {
    if (owner.host === os.hostname()) return !processAlive(owner.pid);
    return Date.now() - owner.at > staleMs;
  }
  try {
    return Date.now() - fs.statSync(lockDir).mtimeMs > OWNER_WRITE_GRACE_MS;
  } catch {
    return false; // vanished → free, not stale; the next mkdir will take it cleanly
  }
}

/**
 * One acquisition attempt. Returns true if this call now holds `lockDir`. The
 * exclusive `mkdir` is the ONLY gate — at most one process ever holds the dir.
 *
 * Reclaiming a crashed holder's lock is serialized behind an exclusive `O_EXCL`
 * token so two reclaimers can never both rm+recreate it, and the reclaimer
 * re-checks staleness under the token so it cannot delete a lock that turned
 * live since the first check. A fresh acquirer would itself hit the still-present
 * dir (and, if it judged it stale, need the token), so the rm+mkdir under the
 * token cannot steal a live lock; the final mkdir stays exclusive regardless.
 */
function tryAcquire(lockDir: string, staleMs: number): boolean {
  // Parent must exist: the exclusive create below is NON-recursive (recursive
  // mkdir would not throw on an existing dir, which would break mutual exclusion).
  try {
    fs.mkdirSync(path.dirname(lockDir), { recursive: true, mode: 0o700 });
  } catch {
    /* parent already exists or cannot be created — the mkdir below reports it */
  }
  try {
    fs.mkdirSync(lockDir, { mode: 0o700 }); // atomic exclusive create — the one real gate
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    if (!isLockStale(lockDir, staleMs)) return false; // live holder — wait
    // Exclusive mkdir sentinel — same primitive as the lock itself, so it is
    // exclusive on the same filesystems (incl. a networked $HOME, where O_EXCL
    // can be weaker). One reclaimer at a time.
    const token = `${lockDir}.reclaim`;
    try {
      fs.mkdirSync(token, { mode: 0o700 });
    } catch {
      // Token busy — another reclaimer holds it, or one crashed. Clear a stale
      // token and let a later round retry; never reclaim without the token.
      try {
        if (Date.now() - fs.statSync(token).mtimeMs > RECLAIM_TOKEN_STALE_MS) {
          fs.rmSync(token, { recursive: true, force: true });
        }
      } catch {
        /* ignore */
      }
      return false;
    }
    try {
      if (!isLockStale(lockDir, staleMs)) return false; // turned live since — abort
      try {
        fs.rmSync(lockDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      try {
        fs.mkdirSync(lockDir, { mode: 0o700 });
      } catch {
        return false; // a fresh holder took it between the rm and here — wait
      }
    } finally {
      try {
        fs.rmSync(token, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
  try {
    const owner: LockOwner = { pid: process.pid, host: os.hostname(), at: Date.now() };
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify(owner));
  } catch {
    /* metadata is advisory only */
  }
  return true;
}

function release(lockDir: string): void {
  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
  } catch {
    /* a reclaimer will clean up a leaked lock later */
  }
}

/** Blocks the thread for `ms` without a busy spin (used only for short lock waits). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Runs `fn` holding an advisory lock on `<lockDir>`, synchronously. Intended for
 * SHORT read-modify-write critical sections on files this extension owns. If the
 * lock can't be taken within the cap it runs `fn` anyway (best-effort: these writes
 * already degrade gracefully, and blocking a poll forever is worse) — UNLESS
 * `skipIfUnacquired` is set, in which case `fn` is NOT run and `undefined` is
 * returned. Use that when running `fn` unlocked would be unsafe (a compare-and-set
 * on a credential store that another process may be rotating): skipping and retrying
 * is correct; a stale-read unlocked write is not. Keep the cap SHORT there — the wait
 * is a synchronous main-thread block.
 */
export function withLock<T>(
  lockDir: string,
  fn: () => T,
  opts: { staleMs?: number; capMs?: number; stepMs?: number; skipIfUnacquired?: boolean } = {}
): T | undefined {
  const staleMs = opts.staleMs ?? 15_000;
  const capMs = opts.capMs ?? 2_000;
  const stepMs = opts.stepMs ?? 15;
  let waited = 0;
  let held = false;
  while (waited <= capMs) {
    if (tryAcquire(lockDir, staleMs)) {
      held = true;
      break;
    }
    sleepSync(stepMs);
    waited += stepMs;
  }
  if (!held && opts.skipIfUnacquired) return undefined;
  try {
    return fn();
  } finally {
    if (held) release(lockDir);
  }
}

/** Non-blocking async delay for the async lock waiter. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}

/**
 * Runs `fn` holding an advisory lock on `<lockDir>`, awaiting the event loop
 * between attempts so a long critical section (e.g. a first-time history merge)
 * never freezes the extension host. Waits up to `capMs` for a live holder.
 *
 * If the lock is still not acquired after `capMs`: with `skipIfUnacquired` the
 * function is NOT run and `{ locked: false }` is returned (use this when running
 * `fn` concurrently with the real holder would be unsafe, e.g. a filesystem
 * migration); otherwise `fn` runs unlocked as a best-effort fallback. Returns
 * whether the lock was actually held.
 */
export async function withLockAsync<T>(
  lockDir: string,
  fn: () => T | Promise<T>,
  opts: { staleMs?: number; capMs?: number; stepMs?: number; skipIfUnacquired?: boolean } = {}
): Promise<{ result: T | undefined; locked: boolean }> {
  const staleMs = opts.staleMs ?? 5 * 60_000;
  const capMs = opts.capMs ?? 60_000;
  const stepMs = opts.stepMs ?? 250;
  let waited = 0;
  let held = false;
  while (waited <= capMs) {
    if (tryAcquire(lockDir, staleMs)) {
      held = true;
      break;
    }
    await delay(stepMs);
    waited += stepMs;
  }
  if (!held && opts.skipIfUnacquired) {
    return { result: undefined, locked: false };
  }
  try {
    return { result: await fn(), locked: held };
  } finally {
    if (held) release(lockDir);
  }
}
