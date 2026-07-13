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

/**
 * One acquisition attempt. Returns true if this call now holds `lockDir`.
 * Reclaims a lock whose owner is a dead same-host PID, or (fallback) one older
 * than `staleMs` when liveness can't be proven (owner on another host / unknown).
 */
function tryAcquire(lockDir: string, staleMs: number): boolean {
  // Ensure the parent exists first: the exclusive create below is NON-recursive
  // (recursive mkdir does not throw on an existing dir, which would break mutual
  // exclusion), so on a fresh machine the lock's parent may not exist yet.
  try {
    fs.mkdirSync(path.dirname(lockDir), { recursive: true, mode: 0o700 });
  } catch {
    /* parent already exists or cannot be created — the mkdir below reports it */
  }
  try {
    fs.mkdirSync(lockDir); // atomic exclusive create
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const owner = readOwner(lockDir);
    let stale: boolean;
    if (!owner) {
      stale = true; // missing / garbled metadata — reclaimable
    } else if (owner.host === os.hostname()) {
      // Same host: trust PID liveness and ignore age, so a live holder is never
      // robbed mid-operation (a first-time history merge can run for minutes).
      stale = !processAlive(owner.pid);
    } else {
      // A holder on another host over a shared $HOME: liveness is unknowable, so
      // fall back to age.
      stale = Date.now() - owner.at > staleMs;
    }
    if (!stale) return false; // held by a live owner — wait
    // Reclaim: remove then re-create. The loser of a concurrent reclaim gets
    // EEXIST on the mkdir below and simply keeps waiting.
    try {
      fs.rmSync(lockDir, { recursive: true, force: true });
      fs.mkdirSync(lockDir);
    } catch {
      return false;
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
 * lock can't be taken within the cap it runs `fn` anyway (best-effort: these
 * writes already degrade gracefully, and blocking a poll forever is worse).
 */
export function withLock<T>(
  lockDir: string,
  fn: () => T,
  opts: { staleMs?: number; capMs?: number; stepMs?: number } = {}
): T {
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
 * never freezes the extension host. Waits up to `capMs` for a live holder, then
 * — because the guarded operation is idempotent and a waiter that never runs
 * would be worse than a rare overlap — proceeds. Returns whether the lock was
 * actually held, so callers can log a best-effort fallback.
 */
export async function withLockAsync<T>(
  lockDir: string,
  fn: () => T | Promise<T>,
  opts: { staleMs?: number; capMs?: number; stepMs?: number } = {}
): Promise<{ result: T; locked: boolean }> {
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
  try {
    return { result: await fn(), locked: held };
  } finally {
    if (held) release(lockDir);
  }
}
