import { execFile } from 'child_process';
import * as fs from 'fs';
import { log } from './log';
import { readIdentity } from './accounts';

/**
 * Thin wrapper around the `claude` CLI's auth commands, scoped to a specific
 * CLAUDE_CONFIG_DIR. Prefer a Linux binary; never intentionally invoke a
 * Windows path under /mnt/c.
 */

export interface AuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
}

/** Resolve a Linux `claude` binary from PATH (login shell for nvm/fnm). */
function resolveClaudeBinary(): Promise<string> {
  const shell = process.env.SHELL || '/bin/bash';
  return new Promise((resolve, reject) => {
    execFile(
      shell,
      [
        '-lc',
        `type -a claude 2>/dev/null | sed -n 's/.* is //p; s/.* is hashed (\\(.*\\))/\\1/p' | while read -r p; do
  case "$p" in /mnt/c/*|*/Windows/*|*/System32/*) continue ;; esac
  [ -x "$p" ] && echo "$p" && exit 0
done
command -v claude 2>/dev/null | while read -r p; do
  case "$p" in /mnt/c/*) continue ;; esac
  [ -n "$p" ] && [ -x "$p" ] && echo "$p" && exit 0
done
exit 127`,
      ],
      { timeout: 8000, env: process.env },
      (err, stdout) => {
        const line = stdout?.toString().trim().split('\n').find(Boolean);
        if (line && !line.startsWith('/mnt/c/') && fs.existsSync(line)) {
          resolve(line);
          return;
        }
        // Fallbacks common on this machine
        for (const p of [
          `${process.env.HOME}/.npm-global/bin/claude`,
          `${process.env.HOME}/.local/bin/claude`,
          '/usr/local/bin/claude',
        ]) {
          if (p && fs.existsSync(p)) {
            resolve(p);
            return;
          }
        }
        reject(new Error(err?.message || 'no linux claude on PATH'));
      }
    );
  });
}

let cachedBinary: string | null = null;

async function claudeBinary(): Promise<string> {
  if (cachedBinary && fs.existsSync(cachedBinary)) return cachedBinary;
  cachedBinary = await resolveClaudeBinary();
  return cachedBinary;
}

function runClaude(args: string[], dir: string, timeoutMs: number): Promise<string> {
  return claudeBinary().then(
    (bin) =>
      new Promise((resolve, reject) => {
        const child = execFile(
          bin,
          args,
          {
            env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
            timeout: timeoutMs,
            killSignal: 'SIGKILL',
            maxBuffer: 2 * 1024 * 1024,
          },
          (err, stdout, stderr) => {
            clearTimeout(hardTimer);
            if (err) reject(new Error(stderr?.toString() || err.message));
            else resolve(stdout.toString());
          }
        );
        const hardTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
          reject(new Error(`claude ${args.join(' ')} timed out after ${timeoutMs}ms`));
        }, timeoutMs + 1000);
        if (typeof hardTimer.unref === 'function') hardTimer.unref();
      })
  );
}

/**
 * Returns the authenticated account for a config dir, or null if the CLI call
 * fails or the dir isn't logged in. Never throws.
 */
export async function getAuthStatus(dir: string, timeoutMs = 15000): Promise<AuthStatus | null> {
  try {
    const out = await runClaude(['auth', 'status', '--json'], dir, timeoutMs);
    const parsed = JSON.parse(out) as AuthStatus;
    if (parsed.loggedIn && !parsed.email) {
      const id = readIdentity(dir);
      if (id?.email) {
        parsed.email = id.email;
        if (!parsed.orgName && id.organizationName) parsed.orgName = id.organizationName;
      }
    }
    log(`auth status(${dir}): loggedIn=${parsed.loggedIn} email=${parsed.email ?? '(none)'}`);
    return parsed;
  } catch (err) {
    log(`auth status(${dir}) FAILED: ${(err as Error).message.split('\n')[0]}`);
    return null;
  }
}
