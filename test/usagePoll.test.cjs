const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

/**
 * The poller rotating a store token, end to end through UsageMonitor: the
 * active window's refresh and the background loop over saved accounts. The OAuth
 * and usage endpoints are stubbed; everything on disk is real, under a temp HOME.
 */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `usage-poll-${process.pid}-`));
const vscodeStub = path.join(tmpRoot, 'vscode-stub.js');
fs.writeFileSync(
  vscodeStub,
  `module.exports = {
     window: {
       createOutputChannel: () => ({ appendLine() {}, show() {} }),
       showWarningMessage: () => Promise.resolve(undefined),
       showInformationMessage: () => Promise.resolve(undefined),
       showErrorMessage: () => Promise.resolve(undefined),
     },
     commands: { executeCommand: () => Promise.resolve(undefined) },
   };`
);
const bundleOut = path.join(tmpRoot, 'usage.bundle.cjs');
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/usage.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundleOut,
  alias: { vscode: vscodeStub },
});
const { UsageMonitor, __ageInProcessStateForTests } = require(bundleOut);

// One clock read. A store grant that expired a minute ago is due for a refresh
// on any poll (ensureFreshToken's fast path and its re-check under the lock both
// refuse it); the family anchor sits 30 days out like the 24-30 day lifetimes a
// sign-in mints.
const T = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const STALE = T - MIN;
const ANCHOR = T + 30 * 24 * HOUR;

function grant(rt, anchor, exp = STALE) {
  const oauth = { accessToken: `at-${rt}`, refreshToken: rt, expiresAt: exp };
  if (anchor !== undefined) oauth.refreshTokenExpiresAt = anchor;
  return Buffer.from(JSON.stringify({ claudeAiOauth: oauth }));
}

/** sha256 of the grant's fingerprint (`rt:` + refresh token), as the chain stores it. */
function rtHash(rt) {
  return crypto.createHash('sha256').update(`rt:${rt}`).digest('hex');
}

function cred(dir) {
  return fs.readFileSync(path.join(dir, '.credentials.json'));
}

function chainFile(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, '.grant-chain.json'), 'utf-8'));
}

function mkAccountDir(dir, email, tok) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: email, displayName: email } })
  );
  fs.writeFileSync(path.join(dir, '.credentials.json'), tok, { mode: 0o600 });
  return dir;
}

describe('the poller rotating a store token', () => {
  let home;
  let prevHome;
  let realFetch;
  let keepalive;
  let tokenPosts;

  before(() => {
    realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      // The token response carries refresh_token_expires_in, as the real endpoint
      // does; the extension must not derive the anchor from it.
      const body = String(url).includes('/oauth/token')
        ? JSON.stringify({
            access_token: `at-P${++tokenPosts}`,
            refresh_token: `rt-P${tokenPosts}`,
            expires_in: 28_800,
            refresh_token_expires_in: 2_592_000,
          })
        : JSON.stringify({
            five_hour: { utilization: 1, resets_at: null },
            seven_day: { utilization: 1, resets_at: null },
          });
      return { status: 200, ok: true, headers: { get: () => null }, text: async () => body };
    };
  });
  after(() => {
    globalThis.fetch = realFetch;
  });

  beforeEach(() => {
    tokenPosts = 0;
    prevHome = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-usage-poll-home-'));
    process.env.HOME = home;
    // A fresh HOME is a fresh machine; the in-process call gap is keyed by
    // account and would otherwise gate one case's poll on the previous one's.
    __ageInProcessStateForTests(3_600_000);
    // withLockAsync waits on unref'd timers; keep the loop alive under node:test.
    keepalive = setInterval(() => {}, 50);
  });
  afterEach(() => {
    clearInterval(keepalive);
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  function assertRotatedInPlace(store, stale, staleRt, anchor) {
    const now = cred(store);
    assert.ok(!now.equals(stale), 'the poller rotated the store token');
    const oauth = JSON.parse(now.toString()).claudeAiOauth;
    assert.notEqual(oauth.refreshToken, staleRt);
    assert.equal(oauth.refreshTokenExpiresAt, anchor, 'anchor carried unchanged');
    assert.match(now.toString(), new RegExp(`"refreshTokenExpiresAt": ?${anchor}[,\\s}]`));
    const chain = chainFile(store);
    assert.ok(chain.hashes.includes(rtHash(staleRt)), 'displaced grant in the chain');
    assert.ok(chain.hashes.includes(rtHash(oauth.refreshToken)), 'new grant in the chain');
    assert.equal(chain.current, anchor, 'current unchanged by a refresh');
    assert.deepEqual(chain.displaced, []);
    const raw = fs.readFileSync(path.join(store, '.grant-chain.json'), 'utf-8');
    assert.ok(!raw.includes(staleRt) && !raw.includes(oauth.refreshToken), 'no token material');
    assert.equal(fs.statSync(path.join(store, '.grant-chain.json')).mode & 0o777, 0o600);
  }

  it("the active window's refresh rotates the store, feeds its chain and leaves the window alone", async () => {
    const stale = grant('rt-S0', ANCHOR);
    const store = mkAccountDir(path.join(home, '.claude-acct'), 'a@x.com', stale);
    const windowDir = mkAccountDir(path.join(home, '.claude-windows', 'w1'), 'a@x.com', stale);
    const monitor = new UsageMonitor(60_000);
    monitor.configure({ storeDirForEmail: () => store });
    try {
      assert.ok(await monitor.refresh(windowDir, true));
    } finally {
      monitor.dispose();
    }
    assert.equal(tokenPosts, 1);
    assertRotatedInPlace(store, stale, 'rt-S0', ANCHOR);
    assert.ok(cred(windowDir).equals(stale), 'window file byte-identical');
    assert.equal(fs.existsSync(path.join(windowDir, '.grant-chain.json')), false);
  });

  it('the background loop does the same for another saved account', async () => {
    const activeTok = grant('rt-A0', ANCHOR + 2 * HOUR, T + 479 * MIN);
    const active = mkAccountDir(path.join(home, '.claude-a'), 'a@x.com', activeTok);
    const windowDir = mkAccountDir(path.join(home, '.claude-windows', 'w1'), 'a@x.com', activeTok);
    const otherAnchor = ANCHOR + 5 * HOUR;
    const stale = grant('rt-B0', otherAnchor);
    const other = mkAccountDir(path.join(home, '.claude-b'), 'b@x.com', stale);
    const monitor = new UsageMonitor(60_000);
    monitor.configure({
      storeDirForEmail: (email) => (email === 'a@x.com' ? active : other),
    });
    monitor.listAccountsToPoll = () => [
      { email: 'a@x.com', dir: active },
      { email: 'b@x.com', dir: other },
    ];
    try {
      await monitor.refresh(windowDir);
      await monitor.refreshAllAccounts();
    } finally {
      monitor.dispose();
    }
    assertRotatedInPlace(other, stale, 'rt-B0', otherAnchor);
    assert.ok(cred(windowDir).equals(activeTok), 'window file byte-identical');
    assert.equal(fs.existsSync(path.join(windowDir, '.grant-chain.json')), false);
  });

  it('a store grant with no anchor rotates and still has none', async () => {
    const stale = grant('rt-N0', undefined);
    const store = mkAccountDir(path.join(home, '.claude-acct'), 'a@x.com', stale);
    const windowDir = mkAccountDir(path.join(home, '.claude-windows', 'w1'), 'a@x.com', stale);
    const monitor = new UsageMonitor(60_000);
    monitor.configure({ storeDirForEmail: () => store });
    try {
      await monitor.refresh(windowDir, true);
    } finally {
      monitor.dispose();
    }
    const now = cred(store);
    assert.ok(!now.equals(stale), 'the poller rotated the store token');
    assert.equal(now.toString().includes('refreshTokenExpiresAt'), false);
    const chain = chainFile(store);
    assert.equal(chain.current, null);
    assert.ok(chain.hashes.includes(rtHash('rt-N0')) && chain.hashes.includes(rtHash('rt-P1')));
  });
});
