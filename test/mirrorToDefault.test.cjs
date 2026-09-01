const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');

/**
 * capture.ts pulls workdir/cli/log (vscode at method-call time). Bundle with the
 * same vscode stub alias used in accountFingerprint.test.cjs.
 */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `mirror-def-${process.pid}-`));
const vscodeStub = path.join(tmpRoot, 'vscode-stub.js');
fs.writeFileSync(
  vscodeStub,
  `global.__caLog = global.__caLog || [];
   module.exports = {
     window: {
       createOutputChannel: () => ({
         appendLine(s) { global.__caLog.push(s); },
         show() {},
       }),
       showWarningMessage: () => Promise.resolve(undefined),
       showInformationMessage: () => Promise.resolve(undefined),
       showErrorMessage: () => Promise.resolve(undefined),
     },
     commands: { executeCommand: () => Promise.resolve(undefined) },
   };`
);
const bundleOut = path.join(tmpRoot, 'capture.bundle.cjs');
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/capture.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundleOut,
  alias: { vscode: vscodeStub },
});
const {
  mirrorToDefault,
  _setMidOauthAbandonMs,
  _setBeforeIdentityWrite,
  _setBeforeTokenWrite,
  disposeMirrorTimers,
} = require(bundleOut);

function logText() {
  return (global.__caLog || []).join('\n');
}

const DEFAULT_MID_OAUTH_MS = 5 * 60 * 1000;

function modeOf(file) {
  return fs.statSync(file).mode & 0o777;
}

/** Production-shaped grant: stable refreshToken per account, distinct accessToken per grant. */
function grant(expiresAt, email, accessToken) {
  return JSON.stringify({
    claudeAiOauth: { accessToken, refreshToken: `RT_${email}`, expiresAt },
  });
}

function writeJson(file, obj, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj), { mode });
}

describe('mirrorToDefault', () => {
  let tmpHome;
  let prevHome;

  beforeEach(() => {
    prevHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-mirror-home-'));
    process.env.HOME = tmpHome;
    global.__caLog = [];
    _setMidOauthAbandonMs(DEFAULT_MID_OAUTH_MS);
    _setBeforeIdentityWrite(undefined);
    _setBeforeTokenWrite(undefined);
  });

  afterEach(() => {
    _setBeforeIdentityWrite(undefined);
    _setBeforeTokenWrite(undefined);
    disposeMirrorTimers();
    _setMidOauthAbandonMs(DEFAULT_MID_OAUTH_MS);
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function defaultDir() {
    return path.join(tmpHome, '.claude');
  }
  function defaultToken() {
    return path.join(defaultDir(), '.credentials.json');
  }
  function homeCfg() {
    return path.join(tmpHome, '.claude.json');
  }
  function makeSource(email, grantJson, name = 'src') {
    const dir = path.join(tmpHome, name);
    writeJson(path.join(dir, '.credentials.json'), grantJson);
    writeJson(path.join(dir, '.claude.json'), {
      oauthAccount: { emailAddress: email, displayName: email },
    });
    return dir;
  }

  it('source is the default dir returns false and touches nothing', () => {
    const incoming = grant(9_000, 'x@ex.com', 'X');
    writeJson(defaultToken(), incoming);
    const cfg = JSON.stringify({ oauthAccount: { emailAddress: 'x@ex.com' } });
    writeJson(homeCfg(), cfg);
    const tokenBefore = fs.readFileSync(defaultToken());
    const cfgBefore = fs.readFileSync(homeCfg());
    assert.equal(mirrorToDefault(defaultDir()), false);
    assert.deepEqual(fs.readFileSync(defaultToken()), tokenBefore);
    assert.deepEqual(fs.readFileSync(homeCfg()), cfgBefore);
  });

  it('source has no token returns false and touches nothing', () => {
    const dir = path.join(tmpHome, 'src');
    writeJson(path.join(dir, '.claude.json'), {
      oauthAccount: { emailAddress: 'x@ex.com', displayName: 'x@ex.com' },
    });
    assert.equal(mirrorToDefault(dir), false);
    assert.equal(fs.existsSync(defaultToken()), false);
    assert.equal(fs.existsSync(homeCfg()), false);
  });

  it('passive never flips a default holding another email', () => {
    const yGrant = grant(1_000, 'y@ex.com', 'Y');
    const yCfg = JSON.stringify({
      oauthAccount: { emailAddress: 'y@ex.com', displayName: 'y@ex.com' },
      keep: true,
    });
    writeJson(defaultToken(), yGrant);
    writeJson(homeCfg(), yCfg);
    const tokenBefore = fs.readFileSync(defaultToken());
    const cfgBefore = fs.readFileSync(homeCfg());

    const src = makeSource('x@ex.com', grant(9_000, 'x@ex.com', 'X'));
    assert.equal(mirrorToDefault(src), false);

    assert.deepEqual(fs.readFileSync(defaultToken()), tokenBefore);
    assert.deepEqual(fs.readFileSync(homeCfg()), cfgBefore);
  });

  it('passive fills an empty default', () => {
    const incoming = grant(2_000, 'x@ex.com', 'X');
    const src = makeSource('x@ex.com', incoming);
    assert.equal(mirrorToDefault(src), true);

    assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), incoming);
    assert.equal(modeOf(defaultToken()), 0o600);
    const cfg = JSON.parse(fs.readFileSync(homeCfg(), 'utf-8'));
    assert.equal(cfg.oauthAccount.emailAddress, 'x@ex.com');
    assert.equal(modeOf(homeCfg()), 0o600);
  });

  it('passive refreshes a same-email default only with a strictly newer expiresAt', () => {
    const email = 'x@ex.com';
    const current = grant(2_000, email, 'CUR');
    writeJson(defaultToken(), current);
    writeJson(homeCfg(), {
      oauthAccount: { emailAddress: email, displayName: email },
    });
    const cfgBefore = fs.readFileSync(homeCfg());

    const olderSrc = makeSource(email, grant(1_000, email, 'OLD'), 'older');
    assert.equal(mirrorToDefault(olderSrc), false);
    assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), current);

    const equalSrc = makeSource(email, grant(2_000, email, 'EQ'), 'equal');
    assert.equal(mirrorToDefault(equalSrc), false);
    assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), current);

    const newer = grant(3_000, email, 'NEW');
    const newerSrc = makeSource(email, newer, 'newer');
    assert.equal(mirrorToDefault(newerSrc), true);
    assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), newer);
    // Same email — identity step is a no-op.
    assert.deepEqual(fs.readFileSync(homeCfg()), cfgBefore);
  });

  it('passive leaves a token-less default that still has oauthAccount alone', () => {
    const cfg = JSON.stringify({
      oauthAccount: { emailAddress: 'y@ex.com', displayName: 'y@ex.com' },
    });
    writeJson(homeCfg(), cfg);
    const cfgBefore = fs.readFileSync(homeCfg());

    const src = makeSource('x@ex.com', grant(9_000, 'x@ex.com', 'X'));
    assert.equal(mirrorToDefault(src), false);

    assert.equal(fs.existsSync(defaultToken()), false);
    assert.deepEqual(fs.readFileSync(homeCfg()), cfgBefore);
  });

  it('takeover flips a default holding another email', () => {
    writeJson(defaultToken(), grant(1_000, 'y@ex.com', 'Y'));
    writeJson(homeCfg(), {
      oauthAccount: { emailAddress: 'y@ex.com', displayName: 'y@ex.com' },
    });

    const incoming = grant(9_000, 'x@ex.com', 'X');
    const src = makeSource('x@ex.com', incoming);
    assert.equal(mirrorToDefault(src, { takeover: true }), true);

    assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), incoming);
    const cfg = JSON.parse(fs.readFileSync(homeCfg(), 'utf-8'));
    assert.equal(cfg.oauthAccount.emailAddress, 'x@ex.com');
  });

  it('takeover fills an empty default whose ~/.claude.json still names another account', () => {
    writeJson(homeCfg(), {
      oauthAccount: { emailAddress: 'y@ex.com', displayName: 'y@ex.com' },
      keep: true,
    });
    const incoming = grant(9_000, 'x@ex.com', 'X');
    const src = makeSource('x@ex.com', incoming);
    assert.equal(mirrorToDefault(src, { takeover: true }), true);
    assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), incoming);
    const cfg = JSON.parse(fs.readFileSync(homeCfg(), 'utf-8'));
    assert.equal(cfg.oauthAccount.emailAddress, 'x@ex.com');
    assert.equal(cfg.keep, true);
  });

  it('takeover preserves unrelated top-level keys and unmanaged oauthAccount sub-fields', () => {
    writeJson(defaultToken(), grant(1_000, 'y@ex.com', 'Y'));
    writeJson(homeCfg(), {
      theme: 'dark',
      oauthAccount: { emailAddress: 'y@ex.com', uuid: 'keep-me', extra: 1 },
    });
    const src = makeSource('x@ex.com', grant(9_000, 'x@ex.com', 'X'));
    assert.equal(mirrorToDefault(src, { takeover: true }), true);
    const cfg = JSON.parse(fs.readFileSync(homeCfg(), 'utf-8'));
    assert.equal(cfg.theme, 'dark');
    assert.equal(cfg.oauthAccount.uuid, 'keep-me');
    assert.equal(cfg.oauthAccount.extra, 1);
    assert.equal(cfg.oauthAccount.emailAddress, 'x@ex.com');
  });

  it('takeover with a token-and-no-identity source into an occupied default writes nothing', () => {
    const current = grant(1_000, 'y@ex.com', 'Y');
    writeJson(defaultToken(), current);
    writeJson(homeCfg(), {
      oauthAccount: { emailAddress: 'y@ex.com', displayName: 'y@ex.com' },
    });
    const tokenBefore = fs.readFileSync(defaultToken());
    const cfgBefore = fs.readFileSync(homeCfg());
    const dir = path.join(tmpHome, 'src');
    writeJson(path.join(dir, '.credentials.json'), grant(9_000, 'x@ex.com', 'X'));
    assert.equal(mirrorToDefault(dir, { takeover: true }), false);
    assert.deepEqual(fs.readFileSync(defaultToken()), tokenBefore);
    assert.deepEqual(fs.readFileSync(homeCfg()), cfgBefore);
  });

  it('takeover with a same-email newer grant replaces the token', () => {
    const email = 'x@ex.com';
    writeJson(defaultToken(), grant(1_000, email, 'OLD'));
    writeJson(homeCfg(), { oauthAccount: { emailAddress: email, displayName: email } });
    const incoming = grant(9_000, email, 'NEW');
    const src = makeSource(email, incoming);
    assert.equal(mirrorToDefault(src, { takeover: true }), true);
    assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), incoming);
  });

  it('takeover with a same-email older grant keeps the default token but still passes', () => {
    const email = 'x@ex.com';
    const current = grant(9_000, email, 'NEW');
    writeJson(defaultToken(), current);
    writeJson(homeCfg(), {
      oauthAccount: { emailAddress: email, displayName: email },
    });
    const src = makeSource(email, grant(1_000, email, 'OLD'));
    assert.equal(mirrorToDefault(src, { takeover: true }), true);
    assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), current);
  });

  it('takeover with a different email flips even when the incoming expiry is older', () => {
    writeJson(defaultToken(), grant(9_000, 'y@ex.com', 'Y'));
    writeJson(homeCfg(), {
      oauthAccount: { emailAddress: 'y@ex.com', displayName: 'y@ex.com' },
    });
    const incoming = grant(1_000, 'x@ex.com', 'X');
    const src = makeSource('x@ex.com', incoming);
    assert.equal(mirrorToDefault(src, { takeover: true }), true);
    assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), incoming);
    const cfg = JSON.parse(fs.readFileSync(homeCfg(), 'utf-8'));
    assert.equal(cfg.oauthAccount.emailAddress, 'x@ex.com');
  });

  it('source with a token but no identity writes nothing and returns false', () => {
    const dir = path.join(tmpHome, 'src');
    writeJson(path.join(dir, '.credentials.json'), grant(9_000, 'x@ex.com', 'X'));
    assert.equal(mirrorToDefault(dir), false);
    assert.equal(fs.existsSync(defaultToken()), false);
    assert.equal(fs.existsSync(homeCfg()), false);
  });

  it('passive same-email with unparseable incoming expiry is untouched', () => {
    const email = 'x@ex.com';
    const current = grant(2_000, email, 'CUR');
    writeJson(defaultToken(), current);
    writeJson(homeCfg(), {
      oauthAccount: { emailAddress: email, displayName: email },
    });
    const cfgBefore = fs.readFileSync(homeCfg());
    const src = makeSource(
      email,
      JSON.stringify({ claudeAiOauth: { accessToken: 'NOEXP', refreshToken: `RT_${email}` } })
    );
    assert.equal(mirrorToDefault(src), false);
    assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), current);
    assert.deepEqual(fs.readFileSync(homeCfg()), cfgBefore);
  });

  it('passive unparseable incoming expiry with an unparseable current is untouched', () => {
    const email = 'x@ex.com';
    const current = JSON.stringify({
      claudeAiOauth: { accessToken: 'CUR_NOEXP', refreshToken: `RT_${email}` },
    });
    writeJson(defaultToken(), current);
    writeJson(homeCfg(), {
      oauthAccount: { emailAddress: email, displayName: email },
    });
    const cfgBefore = fs.readFileSync(homeCfg());
    const src = makeSource(
      email,
      JSON.stringify({ claudeAiOauth: { accessToken: 'IN_NOEXP', refreshToken: `RT_${email}` } })
    );
    assert.equal(mirrorToDefault(src), false);
    assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), current);
    assert.deepEqual(fs.readFileSync(homeCfg()), cfgBefore);
  });

  it('passive with current token unparseable is written', () => {
    const email = 'x@ex.com';
    writeJson(
      defaultToken(),
      JSON.stringify({ claudeAiOauth: { accessToken: 'NOEXP', refreshToken: `RT_${email}` } })
    );
    writeJson(homeCfg(), {
      oauthAccount: { emailAddress: email, displayName: email },
    });
    const incoming = grant(2_000, email, 'X');
    const src = makeSource(email, incoming);
    assert.equal(mirrorToDefault(src), true);
    assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), incoming);
  });

  it('passive same-lineage rotation (same refreshToken, new accessToken) replaces the default token', () => {
    const email = 'x@ex.com';
    const current = grant(2_000, email, 'AT_OLD');
    writeJson(defaultToken(), current);
    writeJson(homeCfg(), {
      oauthAccount: { emailAddress: email, displayName: email },
    });
    const incoming = grant(3_000, email, 'AT_NEW');
    const src = makeSource(email, incoming);
    assert.equal(mirrorToDefault(src), true);
    assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), incoming);
  });

  it('passive bytes-equal but stale home email restamps identity', () => {
    const incoming = grant(2_000, 'x@ex.com', 'X');
    writeJson(defaultToken(), incoming);
    writeJson(homeCfg(), {
      oauthAccount: { emailAddress: 'old@ex.com', displayName: 'old@ex.com' },
    });
    const src = makeSource('x@ex.com', incoming);
    assert.equal(mirrorToDefault(src), true);
    assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), incoming);
    const cfg = JSON.parse(fs.readFileSync(homeCfg(), 'utf-8'));
    assert.equal(cfg.oauthAccount.emailAddress, 'x@ex.com');
  });

  it('passive occupied unnamed default is adopted when the incoming grant is newer', () => {
    writeJson(defaultToken(), grant(1_000, 'other@ex.com', 'OTHER'));
    const incoming = grant(2_000, 'x@ex.com', 'X');
    const src = makeSource('x@ex.com', incoming);
    assert.equal(mirrorToDefault(src), true);
    assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), incoming);
    const cfg = JSON.parse(fs.readFileSync(homeCfg(), 'utf-8'));
    assert.equal(cfg.oauthAccount.emailAddress, 'x@ex.com');
  });

  it('passive unnamed default that exists as valid JSON with a token is adopted and theme is preserved', () => {
    writeJson(defaultToken(), grant(1_000, 'other@ex.com', 'OTHER'));
    writeJson(homeCfg(), { theme: 'dark' });
    const incoming = grant(2_000, 'x@ex.com', 'X');
    const src = makeSource('x@ex.com', incoming);
    assert.equal(mirrorToDefault(src), true);
    assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), incoming);
    const cfg = JSON.parse(fs.readFileSync(homeCfg(), 'utf-8'));
    assert.equal(cfg.theme, 'dark');
    assert.equal(cfg.oauthAccount.emailAddress, 'x@ex.com');
  });

  it('passive unnamed default with an older incoming grant is untouched', () => {
    const current = grant(9_000, 'other@ex.com', 'OTHER');
    writeJson(defaultToken(), current);
    writeJson(homeCfg(), { theme: 'dark' });
    const cfgBefore = fs.readFileSync(homeCfg());
    const src = makeSource('x@ex.com', grant(1_000, 'x@ex.com', 'X'));
    assert.equal(mirrorToDefault(src), false);
    assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), current);
    assert.deepEqual(fs.readFileSync(homeCfg()), cfgBefore);
  });

  it('passive with unreadable ~/.claude.json writes nothing in empty and occupied cases', () => {
    const bad = '{not json';
    writeJson(homeCfg(), bad);
    const cfgBefore = fs.readFileSync(homeCfg());
    const src = makeSource('x@ex.com', grant(9_000, 'x@ex.com', 'X'));

    assert.equal(mirrorToDefault(src), false);
    assert.equal(fs.existsSync(defaultToken()), false);
    assert.deepEqual(fs.readFileSync(homeCfg()), cfgBefore);

    writeJson(defaultToken(), grant(1_000, 'y@ex.com', 'Y'));
    const tokenBefore = fs.readFileSync(defaultToken());
    assert.equal(mirrorToDefault(src), false);
    assert.deepEqual(fs.readFileSync(defaultToken()), tokenBefore);
    assert.deepEqual(fs.readFileSync(homeCfg()), cfgBefore);
  });

  it('takeover into an unreadable ~/.claude.json with an occupied default writes nothing', () => {
    const bad = '{not json';
    writeJson(homeCfg(), bad);
    const current = grant(1_000, 'y@ex.com', 'Y');
    writeJson(defaultToken(), current);
    const cfgBefore = fs.readFileSync(homeCfg());
    const tokenBefore = fs.readFileSync(defaultToken());
    const src = makeSource('x@ex.com', grant(9_000, 'x@ex.com', 'X'));
    assert.equal(mirrorToDefault(src, { takeover: true }), false);
    assert.deepEqual(fs.readFileSync(defaultToken()), tokenBefore);
    assert.deepEqual(fs.readFileSync(homeCfg()), cfgBefore);
  });

  it('takeover into an unreadable ~/.claude.json with an empty default writes nothing', () => {
    const bad = '{not json';
    writeJson(homeCfg(), bad);
    const cfgBefore = fs.readFileSync(homeCfg());
    const src = makeSource('x@ex.com', grant(9_000, 'x@ex.com', 'X'));
    assert.equal(mirrorToDefault(src, { takeover: true }), false);
    assert.equal(fs.existsSync(defaultToken()), false);
    assert.deepEqual(fs.readFileSync(homeCfg()), cfgBefore);
  });

  it('passive named token-less default, different account, is untouched', () => {
    const cfg = JSON.stringify({
      oauthAccount: { emailAddress: 'y@ex.com', displayName: 'y@ex.com' },
    });
    writeJson(homeCfg(), cfg);
    const cfgBefore = fs.readFileSync(homeCfg());
    const src = makeSource('x@ex.com', grant(9_000, 'x@ex.com', 'X'));
    assert.equal(mirrorToDefault(src), false);
    assert.equal(fs.existsSync(defaultToken()), false);
    assert.deepEqual(fs.readFileSync(homeCfg()), cfgBefore);
  });

  it('passive named token-less default, same account, first observation is untouched', () => {
    const email = 'x@ex.com';
    const cfg = JSON.stringify({
      oauthAccount: { emailAddress: email, displayName: email },
    });
    writeJson(homeCfg(), cfg);
    const cfgBefore = fs.readFileSync(homeCfg());
    // Age the config well past the abandon window: the clock is first-observed
    // absence, never the file's mtime, so an old ~/.claude.json must not refill.
    const old = (Date.now() - 10 * 60_000) / 1000;
    fs.utimesSync(homeCfg(), old, old);
    const src = makeSource(email, grant(9_000, email, 'X'));
    assert.equal(mirrorToDefault(src), false);
    assert.equal(fs.existsSync(defaultToken()), false);
    assert.deepEqual(fs.readFileSync(homeCfg()), cfgBefore);
  });

  it('a present default token seen on the source-has-no-token path ends the absence episode', async () => {
    _setMidOauthAbandonMs(50);
    const email = 'x@ex.com';
    writeJson(homeCfg(), {
      oauthAccount: { emailAddress: email, displayName: email },
    });
    const incoming = grant(9_000, email, 'X');
    const src = makeSource(email, incoming);
    assert.equal(mirrorToDefault(src), false);
    await new Promise((resolve) => setTimeout(resolve, 80));
    // The login completes (default token present) while a token-less source
    // reconciles: nothing to mirror, but the episode must close here.
    writeJson(defaultToken(), grant(8_000, email, 'D'));
    const bare = makeSource(email, incoming, 'bare');
    fs.rmSync(path.join(bare, '.credentials.json'));
    assert.equal(mirrorToDefault(bare), false);
    // A later sign-out starts a NEW episode: its first observation is untouched
    // even though the old `since` is long past the window.
    fs.rmSync(defaultToken());
    assert.equal(mirrorToDefault(src), false);
    assert.equal(fs.existsSync(defaultToken()), false);
  });

  it('passive named token-less default, same account, is refilled after the abandon window', async () => {
    _setMidOauthAbandonMs(50);
    const email = 'x@ex.com';
    writeJson(homeCfg(), {
      oauthAccount: { emailAddress: email, displayName: email },
    });
    const incoming = grant(9_000, email, 'X');
    const src = makeSource(email, incoming);
    assert.equal(mirrorToDefault(src), false);
    assert.equal(fs.existsSync(defaultToken()), false);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(mirrorToDefault(src), true);
    assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), incoming);
    const cfg = JSON.parse(fs.readFileSync(homeCfg(), 'utf-8'));
    assert.equal(cfg.oauthAccount.emailAddress, email);
  });

  it('lock held by a live pid skips the write; removing it lets the same call write', () => {
    const incoming = grant(9_000, 'x@ex.com', 'X');
    const src = makeSource('x@ex.com', incoming);
    const lockDir = path.join(defaultDir(), '.credentials.json.lock');
    fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(lockDir, 'owner.json'),
      JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() })
    );
    assert.equal(mirrorToDefault(src), false);
    assert.equal(fs.existsSync(defaultToken()), false);
    assert.equal(fs.existsSync(homeCfg()), false);
    fs.rmSync(lockDir, { recursive: true, force: true });
    assert.equal(mirrorToDefault(src), true);
    assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), incoming);
    const cfg = JSON.parse(fs.readFileSync(homeCfg(), 'utf-8'));
    assert.equal(cfg.oauthAccount.emailAddress, 'x@ex.com');
  });

  it('case-different emails are the same account on a passive refresh', () => {
    const current = grant(2_000, 'x@ex.com', 'CUR');
    writeJson(defaultToken(), current);
    writeJson(homeCfg(), {
      oauthAccount: { emailAddress: 'X@Ex.com', displayName: 'X@Ex.com' },
    });
    const incoming = grant(3_000, 'x@ex.com', 'NEW');
    const src = makeSource('x@ex.com', incoming);
    assert.equal(mirrorToDefault(src), true);
    assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), incoming);
  });

  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  it(
    'identity write failure after a token write removes the token',
    { skip: isRoot ? 'running as root — chmod 500 does not deny writes' : false },
    () => {
      const incoming = grant(9_000, 'x@ex.com', 'X');
      const src = makeSource('x@ex.com', incoming);
      fs.mkdirSync(defaultDir(), { recursive: true, mode: 0o700 });
      writeJson(homeCfg(), { theme: 'dark' });
      const homeMode = fs.statSync(tmpHome).mode;
      fs.chmodSync(tmpHome, 0o500);
      try {
        assert.equal(mirrorToDefault(src), false);
        assert.equal(fs.existsSync(defaultToken()), false);
      } finally {
        fs.chmodSync(tmpHome, homeMode & 0o777);
      }
    }
  );

  it('identity write merges onto a fresh re-read, not the classification snapshot', () => {
    writeJson(homeCfg(), {
      oauthAccount: { emailAddress: 'old@x.com' },
      keep: true,
    });
    _setBeforeIdentityWrite(() => {
      writeJson(homeCfg(), {
        oauthAccount: { emailAddress: 'old@x.com' },
        late: 1,
      });
    });
    const incoming = grant(9_000, 'x@ex.com', 'X');
    const src = makeSource('x@ex.com', incoming);
    assert.equal(mirrorToDefault(src, { takeover: true }), true);
    const cfg = JSON.parse(fs.readFileSync(homeCfg(), 'utf-8'));
    assert.equal(cfg.late, 1);
    assert.equal(cfg.keep, undefined);
    assert.equal(cfg.oauthAccount.emailAddress, 'x@ex.com');
  });

  it('takeover waits past 500 ms for a busy lock; passive does not', () => {
    const incoming = grant(9_000, 'x@ex.com', 'X');
    const src = makeSource('x@ex.com', incoming);
    const lockDir = path.join(defaultDir(), '.credentials.json.lock');
    fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(lockDir, 'owner.json'),
      JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() })
    );
    // withLock waits with Atomics.wait, which blocks this event loop, so the
    // 800 ms release has to run in another process.
    const { spawn } = require('child_process');
    const child = spawn(
      process.execPath,
      [
        '-e',
        `setTimeout(() => { try { require('fs').rmSync(${JSON.stringify(lockDir)}, { recursive: true, force: true }); } catch {} }, 800);`,
      ],
      { detached: true, stdio: 'ignore' }
    );
    child.unref();

    assert.equal(mirrorToDefault(src), false);
    assert.equal(fs.existsSync(defaultToken()), false);

    assert.equal(mirrorToDefault(src, { takeover: true }), true);
    assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), incoming);
  });

  it('re-check timer re-arms after a failed attempt and refills', async () => {
    _setMidOauthAbandonMs(200);
    const email = 'x@ex.com';
    writeJson(homeCfg(), {
      oauthAccount: { emailAddress: email, displayName: email },
    });
    const incoming = grant(9_000, email, 'X');
    const src = makeSource(email, incoming);
    assert.equal(mirrorToDefault(src), false);
    assert.equal(fs.existsSync(defaultToken()), false);

    const lockDir = path.join(defaultDir(), '.credentials.json.lock');
    fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(lockDir, 'owner.json'),
      JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() })
    );

    // First re-check: delay 200+1000=1200 ms, then lock wait 500 ms → ~1700 ms.
    await new Promise((resolve) => setTimeout(resolve, 1850));
    assert.equal(fs.existsSync(defaultToken()), false);
    assert.equal(logText().includes('will try once more'), true);

    fs.rmSync(lockDir, { recursive: true, force: true });

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !fs.existsSync(defaultToken())) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(fs.existsSync(defaultToken()), true);
    assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), incoming);
  });

  it('does not log a success line when the token write throws', () => {
    const src = makeSource('x@ex.com', grant(9_000, 'x@ex.com', 'X'));
    _setBeforeTokenWrite(() => {
      throw new Error('injected write failure');
    });
    assert.equal(mirrorToDefault(src), false);
    assert.equal(logText().includes('filled with'), false);
    assert.equal(fs.existsSync(defaultToken()), false);
  });
});
