import * as vscode from 'vscode';

/**
 * Output channel "Claude Accounts" — the answer to "I clicked and nothing
 * happened". Every user-facing flow logs its decisions here, and command
 * errors are surfaced as toasts pointing at this channel instead of dying
 * silently in the extension host log.
 */
let channel: vscode.OutputChannel | undefined;

export function log(msg: string): void {
  if (!channel) channel = vscode.window.createOutputChannel('Claude Accounts');
  channel.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

export function showLog(): void {
  if (!channel) channel = vscode.window.createOutputChannel('Claude Accounts');
  channel.show(true);
}
