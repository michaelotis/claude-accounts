import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { accountFingerprint } from './accounts';
import { WindowBinding } from './binding';
import { defaultSourceDir } from './capture';

/**
 * Keeps the status bar honest by repainting it the moment this window's account
 * identity changes on disk — e.g. the user runs `/login` inside this window,
 * which (because our binding wins the activation race) rewrites the bound dir's
 * identity. Without this the bar would lag until the next focus/TTL tick.
 *
 * It deliberately does NOT compare against the default `~/.claude` account:
 * once Claude Code reads `CLAUDE_CONFIG_DIR` at activation, the account this
 * window uses IS the bound dir, not the ambient default — so the default file
 * is irrelevant here and comparing to it only produces false "diverged" alarms.
 */
export class AccountWatcher implements vscode.Disposable {
  private readonly watched: string[] = [];
  private timer?: NodeJS.Timeout;
  private dir = '';
  private storeCredsFile?: string;
  private lastFingerprint = '';

  constructor(
    private readonly binding: WindowBinding,
    /**
     * Called when the account state actually changed (identity or credentials).
     * May return its work as a promise: the watcher re-reads the fingerprint after
     * it settles, so the latch reflects the state reconcile LEFT on disk (a repair
     * that restamps the identity must not leave the pre-repair value latched, or a
     * repeat of the same bad write would compare equal and be ignored).
     */
    private readonly onIdentityChange: () => void | Promise<unknown>,
    /**
     * Durable store dir of the account this window is bound to, if any. Watching
     * the STORE's credential file is what lets this window notice that another
     * window rotated the shared grant (the trigger for the silent stale-token
     * restock) within a poll tick, instead of waiting for the next focus edge.
     */
    private readonly storeDir?: () => string | undefined
  ) {}

  start(): void {
    // Watch the identity file backing this window's account: the bound dir's
    // .claude.json, or — for an unbound window — the home-root ~/.claude.json
    // where the default account keeps its identity. watchFile (poll-based)
    // survives the atomic temp+rename writes that break fs.watch, and fires on
    // deletion too.
    //
    // The TOKEN file is watched as well, and it's the one that actually decides
    // whether this window is signed in: a `/logout`, or a forget performed in
    // ANOTHER window, deletes `.credentials.json` while the identity file stays
    // behind. Without this the bar would keep showing the account as live.
    // Captured once: the env dir is stable for the life of the extension host —
    // every account switch reloads the window (a known pre-existing edge: a bind
    // whose reload the circuit breaker suppressed keeps watching the old dir
    // until the next reload; focus reconcile covers the gap).
    const dir = this.binding.getEnvDir() ?? defaultSourceDir();
    this.dir = dir;
    // Resolved once, like the env dir: an account switch reloads the window, so a
    // fresh start() re-resolves it (same known edge as above for suppressed reloads).
    const store = this.storeDir?.();
    this.storeCredsFile =
      store && path.normalize(store) !== path.normalize(dir)
        ? path.join(store, '.credentials.json')
        : undefined;
    this.lastFingerprint = this.fingerprint();
    const files = new Set<string>([
      path.join(dir, '.claude.json'),
      path.join(os.homedir(), '.claude.json'),
      path.join(dir, '.credentials.json'),
    ]);
    if (this.storeCredsFile) files.add(this.storeCredsFile);
    for (const f of files) {
      fs.watchFile(f, { interval: 2000 }, () => this.schedule());
      this.watched.push(f);
    }
  }

  private fingerprint(): string {
    return accountFingerprint(this.dir, undefined, this.storeCredsFile);
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      // mtime ticked, but Claude Code rewrites .claude.json every few seconds
      // during a turn — only fire when the ACCOUNT state (identity email or
      // credential bytes) actually changed, or every write cascades into a
      // reconcile + usage refresh + policy write.
      const fp = this.fingerprint();
      if (fp === this.lastFingerprint) return;
      this.lastFingerprint = fp;
      // A synchronous throw would escape the timer callback before Promise.resolve
      // could wrap it (unreachable with the current async handler; guarded anyway).
      let settled: void | Promise<unknown>;
      try {
        settled = this.onIdentityChange();
      } catch {
        settled = undefined;
      }
      void Promise.resolve(settled).finally(() => {
        // Latch what the handler LEFT on disk, not what triggered it: reconcile may
        // have repaired a drifted identity in place, and latching the pre-repair
        // value would make a repeat of the same bad write look like "no change".
        this.lastFingerprint = this.fingerprint();
      });
    }, 400);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const f of this.watched) fs.unwatchFile(f);
  }
}
