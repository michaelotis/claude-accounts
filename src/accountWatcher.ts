import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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

  constructor(
    private readonly binding: WindowBinding,
    /** Called on any identity-file change so the status bar can repaint live. */
    private readonly onIdentityChange: () => void
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
    const dir = this.binding.getEnvDir() ?? defaultSourceDir();
    const files = new Set<string>([
      path.join(dir, '.claude.json'),
      path.join(os.homedir(), '.claude.json'),
      path.join(dir, '.credentials.json'),
    ]);
    for (const f of files) {
      fs.watchFile(f, { interval: 2000 }, () => this.schedule());
      this.watched.push(f);
    }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.onIdentityChange(), 400);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const f of this.watched) fs.unwatchFile(f);
  }
}
