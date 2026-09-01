const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');

/**
 * writePolicyCache lives in usage.ts which imports vscode via log/accounts.
 * Bundle with a minimal vscode stub (alias — buildSync cannot use plugins).
 */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `policy-mem-${process.pid}-`));
const vscodeStub = path.join(tmpRoot, 'vscode-stub.js');
fs.writeFileSync(
  vscodeStub,
  `
module.exports = {
  window: {
    createOutputChannel: () => ({ appendLine() {}, show() {} }),
  },
};
`
);
const out = path.join(tmpRoot, 'usage.bundle.cjs');
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/usage.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: out,
  alias: {
    vscode: vscodeStub,
  },
});

const { writePolicyCache, policyPath } = require(out);

describe('writePolicyCache membership (credentials on disk)', () => {
  let tmpHome;
  let prevHome;
  let keepDir;
  let dropDir;
  let keepalive;

  before(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-policy-'));
    prevHome = process.env.HOME;
    process.env.HOME = tmpHome;
    // REF'D keepalive: withLockAsync waits on unref'd timers (correct in the
    // extension — never hold the host open), but under node:test an unref'd
    // timer lets the event loop drain mid-await ("promise still pending").
    keepalive = setInterval(() => {}, 50);
    // Intentionally do NOT pre-create ~/.config/claude-accounts: the first write
    // must create it through the lock path, guarding the fresh-machine case.
    keepDir = path.join(tmpHome, '.claude-keep');
    dropDir = path.join(tmpHome, '.claude-drop');
    fs.mkdirSync(keepDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(dropDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(keepDir, '.credentials.json'), '{}', { mode: 0o600 });
    // dropDir has no .credentials.json
  });

  after(() => {
    clearInterval(keepalive);
    process.env.HOME = prevHome;
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('keeps account with credentials and drops one without', async () => {
    const now = Date.now();
    await writePolicyCache({
      mode: 'notify',
      thresholds: { session: 90, weekly: 90, fable: 90 },
      triggers: { session: true, weekly: true, fable: false },
      strategy: 'lowestUsage',
      accountOrder: [],
      workspaceRoutes: [],
      snapshots: [
        {
          sessionPercent: 10,
          sessionResetsAt: null,
          weeklyPercent: 20,
          weeklyResetsAt: null,
          opusPercent: null,
          opusResetsAt: null,
          sonnetPercent: null,
          sonnetResetsAt: null,
          modelLimits: [],
          overagePercent: null,
          email: 'keep@example.com',
          orgName: null,
          planLabel: null,
          fetchedAt: now,
          configDir: keepDir,
        },
        {
          sessionPercent: 10,
          sessionResetsAt: null,
          weeklyPercent: 20,
          weeklyResetsAt: null,
          opusPercent: null,
          opusResetsAt: null,
          sonnetPercent: null,
          sonnetResetsAt: null,
          modelLimits: [],
          overagePercent: null,
          email: 'drop@example.com',
          orgName: null,
          planLabel: null,
          fetchedAt: now,
          configDir: dropDir,
        },
      ],
    });

    const pol = JSON.parse(fs.readFileSync(policyPath(), 'utf8'));
    const emails = (pol.accounts || []).map((a) => a.email).sort();
    assert.deepEqual(emails, ['keep@example.com']);
  });
});
