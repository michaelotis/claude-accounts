/**
 * Approximate "Claude turn" activity for the current window.
 *
 * Heuristic (deliberately conservative about declaring idle):
 *   • IN_TURN requires recent writes under THIS window's config dir
 *     (projects / sessions / history). Live process alone is NOT enough —
 *     the Claude Code panel keeps a process alive between turns.
 *   • We do NOT watch ~/.claude-shared (other windows would keep us "busy").
 *   • settleMs defaults high enough that a silent multi-minute tool run with
 *     occasional flushes still usually looks busy; pure CPU without flushes
 *     can still false-idle (inherent limit without Claude Code events).
 */

import * as fs from 'fs';
import * as path from 'path';
import { log } from './log';

export type TurnPhase = 'idle' | 'in_turn';

export class TurnWatcher {
  private timer: NodeJS.Timeout | null = null;
  private phase: TurnPhase = 'idle';
  private lastActivityAt = 0;
  private getConfigDir: () => string | undefined;
  private settleMs: number;
  private pollMs: number;
  private activityWindowMs: number;

  onBusy?: () => void;
  onIdle?: () => void;

  constructor(
    getConfigDir: () => string | undefined,
    opts: { settleMs?: number; pollMs?: number; activityWindowMs?: number } = {}
  ) {
    this.getConfigDir = getConfigDir;
    // Long tools can go silent for a while; 12s settle reduces mid-turn reloads.
    this.settleMs = opts.settleMs ?? 12_000;
    this.pollMs = opts.pollMs ?? 2_000;
    this.activityWindowMs = opts.activityWindowMs ?? 8_000;
  }

  getPhase(): TurnPhase {
    return this.phase;
  }

  /** Force re-check after restore (e.g. pending cutover on already-idle window). */
  poke(): void {
    this.tick();
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => this.tick(), this.pollMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  dispose(): void {
    this.stop();
  }

  private tick(): void {
    const now = Date.now();
    if (this.detectFileActivity(now)) {
      this.lastActivityAt = now;
      if (this.phase !== 'in_turn') {
        this.phase = 'in_turn';
        log('turn: IN_TURN (config-dir file activity)');
        this.onBusy?.();
      }
      return;
    }
    if (this.phase === 'in_turn' && now - this.lastActivityAt >= this.settleMs) {
      this.phase = 'idle';
      log('turn: IDLE (settled)');
      this.onIdle?.();
    }
  }

  private detectFileActivity(now: number): boolean {
    const dir = this.getConfigDir();
    if (!dir) return false;
    // Only this window's CLAUDE_CONFIG_DIR — never shared store (cross-window).
    return this.recentWriteUnder(dir, now, this.activityWindowMs);
  }

  private recentWriteUnder(root: string, now: number, windowMs: number): boolean {
    const candidates = [
      path.join(root, 'sessions'),
      path.join(root, 'projects'),
      path.join(root, 'session-env'),
      path.join(root, 'file-history'),
      path.join(root, 'shell-snapshots'),
    ];
    for (const c of candidates) {
      if (!fs.existsSync(c)) continue;
      if (this.walkRecent(c, now, windowMs, 0, 3)) return true;
    }
    try {
      const h = path.join(root, 'history.jsonl');
      if (fs.existsSync(h)) {
        const st = fs.statSync(h);
        if (now - st.mtimeMs < windowMs) return true;
      }
    } catch {
      /* ignore */
    }
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
