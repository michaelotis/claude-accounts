/**
 * Approximate "Claude turn" activity for the current window.
 *
 * We cannot subscribe to Claude Code's internal stream events, so we infer
 * IN_TURN from:
 *   • recent writes under the active config dir / shared history (sessions, projects)
 *   • live `claude` processes whose CLAUDE_CONFIG_DIR matches this window
 *
 * After activity stops for `settleMs`, we fire onIdle. While activity is
 * recent we fire onBusy (edge-triggered once).
 */

import * as fs from 'fs';
import * as path from 'path';
import { log } from './log';
import { sharedStoreDir } from './sharedHistory';

export type TurnPhase = 'idle' | 'in_turn';

export class TurnWatcher {
  private timer: NodeJS.Timeout | null = null;
  private phase: TurnPhase = 'idle';
  private lastActivityAt = 0;
  private getConfigDir: () => string | undefined;
  private settleMs: number;
  private pollMs: number;

  onBusy?: () => void;
  onIdle?: () => void;

  constructor(
    getConfigDir: () => string | undefined,
    opts: { settleMs?: number; pollMs?: number } = {}
  ) {
    this.getConfigDir = getConfigDir;
    this.settleMs = opts.settleMs ?? 4_000;
    this.pollMs = opts.pollMs ?? 1_500;
  }

  getPhase(): TurnPhase {
    return this.phase;
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
    if (this.detectActivity(now)) {
      this.lastActivityAt = now;
      if (this.phase !== 'in_turn') {
        this.phase = 'in_turn';
        log('turn: IN_TURN (activity detected)');
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

  private detectActivity(now: number): boolean {
    const dir = this.getConfigDir();
    const roots = [dir, sharedStoreDir()].filter(Boolean) as string[];
    const windowMs = Math.max(this.settleMs, 3_000);
    for (const root of roots) {
      if (this.recentWriteUnder(root, now, windowMs)) return true;
    }
    if (dir && this.claudeProcessOnDir(dir)) return true;
    return false;
  }

  /** Shallow-ish walk: projects + sessions under a config/shared root. */
  private recentWriteUnder(root: string, now: number, windowMs: number): boolean {
    const candidates = [
      path.join(root, 'sessions'),
      path.join(root, 'projects'),
      path.join(root, 'session-env'),
      path.join(root, 'file-history'),
    ];
    for (const c of candidates) {
      if (!fs.existsSync(c)) continue;
      if (this.walkRecent(c, now, windowMs, 0, 4)) return true;
    }
    // history.jsonl at root
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
          // transcripts and agent state
          if (!/\.(jsonl|json|txt|md)$/i.test(e.name) && !e.name.includes('session')) {
            continue;
          }
          const st = fs.statSync(p);
          if (now - st.mtimeMs < windowMs) return true;
        }
      } catch {
        /* ignore */
      }
    }
    return false;
  }

  /** Linux/WSL: any `claude` process with CLAUDE_CONFIG_DIR=dir. */
  private claudeProcessOnDir(dir: string): boolean {
    if (process.platform !== 'linux') return false;
    const target = path.normalize(dir);
    let proc: string[];
    try {
      proc = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n));
    } catch {
      return false;
    }
    for (const pid of proc) {
      try {
        const comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf-8').trim();
        if (comm !== 'claude' && comm !== 'node') continue;
        const env = fs.readFileSync(`/proc/${pid}/environ`, 'utf-8');
        const match = env.split('\0').find((x) => x.startsWith('CLAUDE_CONFIG_DIR='));
        if (!match) {
          // default dir processes: only count if our dir is ~/.claude
          if (comm === 'claude' && target === path.normalize(path.join(require('os').homedir(), '.claude'))) {
            // ambiguous — don't treat as busy solely on default
            continue;
          }
          continue;
        }
        const d = path.normalize(match.slice('CLAUDE_CONFIG_DIR='.length));
        if (d === target) {
          // Prefer actual claude binary; node may be extension host
          if (comm === 'claude') return true;
          // node with CLAUDE_CONFIG_DIR might be claude's runtime
          const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
          if (cmdline.includes('claude')) return true;
        }
      } catch {
        /* permission / raced exit */
      }
    }
    return false;
  }
}
