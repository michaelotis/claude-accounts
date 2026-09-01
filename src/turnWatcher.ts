/**
 * Approximate "Claude turn" activity for the current window.
 *
 * Transcript appends under this window's project slug are the only signal:
 *   <configDir>/projects/<slug(cwd)> for each live claude process bound to
 *   this CLAUDE_CONFIG_DIR (cwd from /proc/<pid>/cwd), unioned with
 *   workspace-folder fallbacks. Shared session dirs are never walked.
 *   A tool call silent for longer than settleMs therefore reads as idle.
 */

import * as fs from 'fs';
import * as path from 'path';
import { log } from './log';
import { claudeCwdsForDir } from './reclaim';

export type TurnPhase = 'idle' | 'in_turn';

/** Claude Code keys transcripts as projects/<cwd with non-alnum → '-'>/. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export class TurnWatcher {
  private timer: NodeJS.Timeout | null = null;
  private phase: TurnPhase = 'idle';
  private lastActivityAt = 0;
  private getConfigDir: () => string | undefined;
  private settleMs: number;
  private pollMs: number;
  private activityWindowMs: number;
  private cwdRescanMs: number;
  private getCwds: (configDir: string) => string[];
  private getFallbackCwds: () => string[];
  private cachedCwds: string[] = [];
  private lastCwdScanAt = 0;
  private cachedForDir: string | undefined;
  private blind = false;

  onBusy?: () => void;
  onIdle?: () => void;

  constructor(
    getConfigDir: () => string | undefined,
    opts: {
      settleMs?: number;
      pollMs?: number;
      activityWindowMs?: number;
      cwdRescanMs?: number;
      getCwds?: (configDir: string) => string[];
      getFallbackCwds?: () => string[];
    } = {}
  ) {
    this.getConfigDir = getConfigDir;
    // Transcript appends are now the only signal, so a silent tool call needs
    // more headroom before idle is declared.
    this.settleMs = opts.settleMs ?? 30_000;
    this.pollMs = opts.pollMs ?? 2_000;
    this.activityWindowMs = opts.activityWindowMs ?? 8_000;
    this.cwdRescanMs = opts.cwdRescanMs ?? 10_000;
    this.getCwds = opts.getCwds ?? claudeCwdsForDir;
    this.getFallbackCwds = opts.getFallbackCwds ?? (() => []);
  }

  getPhase(): TurnPhase {
    return this.phase;
  }

  /** Force re-check after restore (e.g. pending cutover on already-idle window). */
  poke(): void {
    if (!this.timer) return;
    this.tick();
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => this.tick(), this.pollMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    // The first tick restores in_turn from the preserved lastActivityAt when a
    // turn was still settling at stop() (see tick), so no widened window is needed.
    this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // A watcher stopped mid-turn must not keep reporting a frozen in_turn —
    // idleReload is the only consumer, and it is off while we are stopped.
    // Keep lastActivityAt so a restart can restore a still-settling turn.
    this.phase = 'idle';
    this.cachedCwds = [];
    this.lastCwdScanAt = 0;
    this.cachedForDir = undefined;
    this.blind = false;
  }

  dispose(): void {
    this.stop();
  }

  private tick(): void {
    const now = Date.now();
    if (this.detectFileActivity(now, this.activityWindowMs)) {
      this.lastActivityAt = now;
      if (this.phase !== 'in_turn') {
        this.phase = 'in_turn';
        log('turn: IN_TURN (config-dir file activity)');
        this.onBusy?.();
      }
      return;
    }
    // stop() resets phase to idle but keeps lastActivityAt; restore in_turn
    // if the previous turn is still inside the settle window.
    if (
      this.phase !== 'in_turn' &&
      this.lastActivityAt > 0 &&
      now - this.lastActivityAt < this.settleMs
    ) {
      this.phase = 'in_turn';
      log('turn: IN_TURN (still inside the settle window)');
      this.onBusy?.();
      return;
    }
    if (this.phase === 'in_turn' && now - this.lastActivityAt >= this.settleMs) {
      this.phase = 'idle';
      log('turn: IDLE (settled)');
      this.onIdle?.();
    }
  }

  private refreshCwds(configDir: string, now: number): void {
    if (this.cachedForDir === configDir && now - this.lastCwdScanAt < this.cwdRescanMs) return;
    const found = this.getCwds(configDir);
    const fallback = this.getFallbackCwds().map((cwd) => {
      try {
        return fs.realpathSync(cwd);
      } catch {
        return cwd;
      }
    });
    this.cachedCwds = [...new Set([...found, ...fallback])];
    this.cachedForDir = configDir;
    this.lastCwdScanAt = now;
  }

  private noteBlind(cwdCount: number): void {
    if (this.blind) return;
    this.blind = true;
    log(`turn: no transcript dir to watch (cwds=${cwdCount}) — idle signal is blind`);
  }

  private noteBlindRecovered(cwdCount: number): void {
    if (!this.blind) return;
    this.blind = false;
    log(`turn: transcript dir recovered (cwds=${cwdCount})`);
  }

  private detectFileActivity(now: number, windowMs: number): boolean {
    const dir = this.getConfigDir();
    if (!dir) {
      this.noteBlind(0);
      return false;
    }
    this.refreshCwds(dir, now);
    if (!this.cachedCwds.length) {
      this.noteBlind(0);
      return false;
    }
    let anySlug = false;
    for (const cwd of this.cachedCwds) {
      const slugRoot = path.join(dir, 'projects', projectSlug(cwd));
      if (!fs.existsSync(slugRoot)) continue;
      anySlug = true;
      // maxDepth 2: slug files, <sid>/ files, <sid>/subagents/ files.
      if (this.walkRecent(slugRoot, now, windowMs, 0, 2)) {
        this.noteBlindRecovered(this.cachedCwds.length);
        return true;
      }
    }
    if (!anySlug) this.noteBlind(this.cachedCwds.length);
    else this.noteBlindRecovered(this.cachedCwds.length);
    return false;
  }

  private walkRecent(
    dir: string,
    now: number,
    windowMs: number,
    depth: number,
    maxDepth: number
  ): boolean {
    if (depth > maxDepth) return false;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      try {
        if (e.isDirectory()) {
          if (this.walkRecent(p, now, windowMs, depth + 1, maxDepth)) return true;
        } else if (e.isFile()) {
          if (!/\.(jsonl|json)$/i.test(e.name)) continue;
          const st = fs.statSync(p);
          if (now - st.mtimeMs < windowMs) return true;
        }
      } catch {
        /* ignore */
      }
    }
    return false;
  }
}
