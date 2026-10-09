const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
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
  snapshotAccount,
  _setMidOauthAbandonMs,
  _setBeforeIdentityWrite,
  _setBeforeMirrorLock,
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

/**
 * Production-shaped grant: stable refreshToken per account unless `rt` names a
 * lineage, and the family anchor (`refreshTokenExpiresAt`) when one is given.
 */
function grant(expiresAt, email, accessToken, rt = `RT_${email}`, anchor) {
  const oauth = { accessToken, refreshToken: rt, expiresAt };
  if (anchor !== undefined) oauth.refreshTokenExpiresAt = anchor;
  return JSON.stringify({ claudeAiOauth: oauth });
}

// Family anchors sit 30 days out and an hour apart per family, like the 24-30
// day lifetimes sign-ins mint; a refresh keeps its family's anchor within a
// second, far inside ANCHOR_WINDOW_MS in src/workdir.ts.
const T = Date.now();
const SEC = 1_000;
const HOUR = 60 * 60_000;
const F = (k) => T + 30 * 24 * HOUR + k * HOUR;

/** The store history's entry for a lineage: sha256 of its fingerprint, as workdir writes it. */
function rtHash(rt) {
  return require('crypto').createHash('sha256').update(`rt:${rt}`).digest('hex');
}

function writeJson(file, obj, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj), { mode });
}

describe('mirrorToDefault', () => {
  let tmpHome;
  let prevHome;

  // The lock wait sleeps on an unref'd timer — right for an extension host, which
  // never drains, but here it is often the only thing pending, and a drained loop
  // cancels the awaiting test and every test after it.
  let keepAlive;
  before(() => {
    keepAlive = setInterval(() => {}, 1_000);
  });
  after(() => clearInterval(keepAlive));

  beforeEach(() => {
    prevHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-mirror-home-'));
    process.env.HOME = tmpHome;
    global.__caLog = [];
    _setMidOauthAbandonMs(DEFAULT_MID_OAUTH_MS);
    _setBeforeIdentityWrite(undefined);
    _setBeforeMirrorLock(undefined);
    _setBeforeTokenWrite(undefined);
  });

  afterEach(() => {
    _setBeforeIdentityWrite(undefined);
    _setBeforeMirrorLock(undefined);
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

  it('source is the default dir returns false and touches nothing', async () => {
    const incoming = grant(9_000, 'x@ex.com', 'X');
    writeJson(defaultToken(), incoming);
    const cfg = JSON.stringify({ oauthAccount: { emailAddress: 'x@ex.com' } });
    writeJson(homeCfg(), cfg);
    const tokenBefore = fs.readFileSync(defaultToken());
    const cfgBefore = fs.readFileSync(homeCfg());
    assert.equal(await mirrorToDefault(defaultDir()), false);
    assert.deepEqual(fs.readFileSync(defaultToken()), tokenBefore);
    assert.deepEqual(fs.readFileSync(homeCfg()), cfgBefore);
  });

  it('source has no token returns false and touches nothing', async () => {
    const dir = path.join(tmpHome, 'src');
    writeJson(path.join(dir, '.claude.json'), {
      oauthAccount: { emailAddress: 'x@ex.com', displayName: 'x@ex.com' },
    });
    assert.equal(await mirrorToDefault(dir), false);
    assert.equal(fs.existsSync(defaultToken()), false);
    assert.equal(fs.existsSync(homeCfg()), false);
  });

  it('passive never flips a default holding another email', async () => {
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
    assert.equal(await mirrorToDefault(src), false);

    assert.deepEqual(fs.readFileSync(defaultToken()), tokenBefore);
    assert.deepEqual(fs.readFileSync(homeCfg()), cfgBefore);
  });

  it('passive fills an empty default', async () => {
    const incoming = grant(2_000, 'x@ex.com', 'X');
    const src = makeSource('x@ex.com', incoming);
    assert.equal(await mirrorToDefault(src), true);

    assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), incoming);
    assert.equal(modeOf(defaultToken()), 0o600);
    const cfg = JSON.parse(fs.readFileSync(homeCfg(), 'utf-8'));
    assert.equal(cfg.oauthAccount.emailAddress, 'x@ex.com');
    assert.equal(modeOf(homeCfg()), 0o600);
  });

  it('passive refreshes a same-email default only with a strictly newer expiresAt', async () => {
    const email = 'x@ex.com';
    const current = grant(2_000, email, 'CUR');
    writeJson(defaultToken(), current);
    writeJson(homeCfg(), {
      oauthAccount: { emailAddress: email, displayName: email },
    });
    const cfgBefore = fs.readFileSync(homeCfg());

    const olderSrc = makeSource(email, grant(1_000, email, 'OLD'), 'older');
    assert.equal(await mirrorToDefault(olderSrc), false);
    assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), current);

    const equalSrc = makeSource(email, grant(2_000, email, 'EQ'), 'equal');
    assert.equal(await mirrorToDefault(equalSrc), false);
    assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), current);

    const newer = grant(3_000, email, 'NEW');
    const newerSrc = makeSource(email, newer, 'newer');
    assert.equal(await mirrorToDefault(newerSrc), true);
    assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), newer);
    // Same email — identity step is a no-op.
    assert.deepEqual(fs.readFileSync(homeCfg()), cfgBefore);
  });

  it('passive leaves a token-less default that still has oauthAccount alone', async () => {
    const cfg = JSON.stringify({
      oauthAccount: { emailAddress: 'y@ex.com', displayName: 'y@ex.com' },
    });
    writeJson(homeCfg(), cfg);
    const cfgBefore = fs.readFileSync(homeCfg());

    const src = makeSource('x@ex.com', grant(9_000, 'x@ex.com', 'X'));
    assert.equal(await mirrorToDefault(src), false);

    assert.equal(fs.existsSync(defaultToken()), false);
    assert.deepEqual(fs.readFileSync(homeCfg()), cfgBefore);
  });

  it('takeover flips a default holding another email', async () => {
    writeJson(defaultToken(), grant(1_000, 'y@ex.com', 'Y'));
    writeJson(homeCfg(), {
      oauthAccount: { emailAddress: 'y@ex.com', displayName: 'y@ex.com' },
    });

    const incoming = grant(9_000, 'x@ex.com', 'X');
    const src = makeSource('x@ex.com', incoming);
    assert.equal(await mirrorToDefault(src, { takeover: true }), true);

    assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), incoming);
    const cfg = JSON.parse(fs.readFileSync(homeCfg(), 'utf-8'));
    assert.equal(cfg.oauthAccount.emailAddress, 'x@ex.com');
  });

  it('takeover fills an empty default whose ~/.claude.json still names another account', async () => {
    writeJson(homeCfg(), {
      oauthAccount: { emailAddress: 'y@ex.com', displayName: 'y@ex.com' },
      keep: true,
    });
    const incoming = grant(9_000, 'x@ex.com', 'X');
    const src = makeSource('x@ex.com', incoming);
    assert.equal(await mirrorToDefault(src, { takeover: true }), true);
    assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), incoming);
    const cfg = JSON.parse(fs.readFileSync(homeCfg(), 'utf-8'));
    assert.equal(cfg.oauthAccount.emailAddress, 'x@ex.com');
    assert.equal(cfg.keep, true);
  });

  it('takeover preserves unrelated top-level keys and unmanaged oauthAccount sub-fields', async () => {
    writeJson(defaultToken(), grant(1_000, 'y@ex.com', 'Y'));
    writeJson(homeCfg(), {
      theme: 'dark',
      oauthAccount: { emailAddress: 'y@ex.com', uuid: 'keep-me', extra: 1 },
    });
    const src = makeSource('x@ex.com', grant(9_000, 'x@ex.com', 'X'));
    assert.equal(await mirrorToDefault(src, { takeover: true }), true);
    const cfg = JSON.parse(fs.readFileSync(homeCfg(), 'utf-8'));
    assert.equal(cfg.theme, 'dark');
    assert.equal(cfg.oauthAccount.uuid, 'keep-me');
    assert.equal(cfg.oauthAccount.extra, 1);
    assert.equal(cfg.oauthAccount.emailAddress, 'x@ex.com');
  });

  it('takeover with a token-and-no-identity source into an occupied default writes nothing', async () => {
    const current = grant(1_000, 'y@ex.com', 'Y');
    writeJson(defaultToken(), current);
    writeJson(homeCfg(), {
      oauthAccount: { emailAddress: 'y@ex.com', displayName: 'y@ex.com' },
    });
    const tokenBefore = fs.readFileSync(defaultToken());
    const cfgBefore = fs.readFileSync(homeCfg());
    const dir = path.join(tmpHome, 'src');
    writeJson(path.join(dir, '.credentials.json'), grant(9_000, 'x@ex.com', 'X'));
    assert.equal(await mirrorToDefault(dir, { takeover: true }), false);
    assert.deepEqual(fs.readFileSync(defaultToken()), tokenBefore);
    assert.deepEqual(fs.readFileSync(homeCfg()), cfgBefore);
  });

  it('takeover with a same-email newer grant replaces the token', async () => {
    const email = 'x@ex.com';
    writeJson(defaultToken(), grant(1_000, email, 'OLD'));
    writeJson(homeCfg(), { oauthAccount: { emailAddress: email, displayName: email } });
    const incoming = grant(9_000, email, 'NEW');
    const src = makeSource(email, incoming);
    assert.equal(await mirrorToDefault(src, { takeover: true }), true);
    assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), incoming);
  });

  it('takeover with a same-email older grant keeps the default token but still passes', async () => {
    const email = 'x@ex.com';
    const current = grant(9_000, email, 'NEW');
    writeJson(defaultToken(), current);
    writeJson(homeCfg(), {
      oauthAccount: { emailAddress: email, displayName: email },
    });
    const src = makeSource(email, grant(1_000, email, 'OLD'));
    assert.equal(await mirrorToDefault(src, { takeover: true }), true);
    assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), current);
  });

  it('takeover with a different email flips even when the incoming expiry is older', async () => {
    writeJson(defaultToken(), grant(9_000, 'y@ex.com', 'Y'));
    writeJson(homeCfg(), {
      oauthAccount: { emailAddress: 'y@ex.com', displayName: 'y@ex.com' },
    });
    const incoming = grant(1_000, 'x@ex.com', 'X');
    const src = makeSource('x@ex.com', incoming);
    assert.equal(await mirrorToDefault(src, { takeover: true }), true);
    assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), incoming);
    const cfg = JSON.parse(fs.readFileSync(homeCfg(), 'utf-8'));
    assert.equal(cfg.oauthAccount.emailAddress, 'x@ex.com');
  });

  it('source with a token but no identity writes nothing and returns false', async () => {
    const dir = path.join(tmpHome, 'src');
    writeJson(path.join(dir, '.credentials.json'), grant(9_000, 'x@ex.com', 'X'));
    assert.equal(await mirrorToDefault(dir), false);
    assert.equal(fs.existsSync(defaultToken()), false);
    assert.equal(fs.existsSync(homeCfg()), false);
  });

  it('passive same-email with unparseable incoming expiry is untouched', async () => {
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
    assert.equal(await mirrorToDefault(src), false);
    assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), current);
    assert.deepEqual(fs.readFileSync(homeCfg()), cfgBefore);
  });

  it('passive unparseable incoming expiry with an unparseable current is untouched', async () => {
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
    assert.equal(await mirrorToDefault(src), false);
    assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), current);
    assert.deepEqual(fs.readFileSync(homeCfg()), cfgBefore);
  });

  it('passive with current token unparseable is written', async () => {
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
    assert.equal(await mirrorToDefault(src), true);
    assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), incoming);
  });

  it('passive same-lineage rotation (same refreshToken, new accessToken) replaces the default token', async () => {
    const email = 'x@ex.com';
    const current = grant(2_000, email, 'AT_OLD');
    writeJson(defaultToken(), current);
    writeJson(homeCfg(), {
      oauthAccount: { emailAddress: email, displayName: email },
    });
    const incoming = grant(3_000, email, 'AT_NEW');
    const src = makeSource(email, incoming);
    assert.equal(await mirrorToDefault(src), true);
    assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), incoming);
  });

  it('passive bytes-equal but stale home email restamps identity', async () => {
    const incoming = grant(2_000, 'x@ex.com', 'X');
    writeJson(defaultToken(), incoming);
    writeJson(homeCfg(), {
      oauthAccount: { emailAddress: 'old@ex.com', displayName: 'old@ex.com' },
    });
    const src = makeSource('x@ex.com', incoming);
    assert.equal(await mirrorToDefault(src), true);
    assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), incoming);
    const cfg = JSON.parse(fs.readFileSync(homeCfg(), 'utf-8'));
    assert.equal(cfg.oauthAccount.emailAddress, 'x@ex.com');
  });

  it('passive occupied unnamed default is adopted when the incoming grant is newer', async () => {
    writeJson(defaultToken(), grant(1_000, 'other@ex.com', 'OTHER'));
    const incoming = grant(2_000, 'x@ex.com', 'X');
    const src = makeSource('x@ex.com', incoming);
    assert.equal(await mirrorToDefault(src), true);
    assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), incoming);
    const cfg = JSON.parse(fs.readFileSync(homeCfg(), 'utf-8'));
    assert.equal(cfg.oauthAccount.emailAddress, 'x@ex.com');
  });

  it('passive unnamed default that exists as valid JSON with a token is adopted and theme is preserved', async () => {
    writeJson(defaultToken(), grant(1_000, 'other@ex.com', 'OTHER'));
    writeJson(homeCfg(), { theme: 'dark' });
    const incoming = grant(2_000, 'x@ex.com', 'X');
    const src = makeSource('x@ex.com', incoming);
    assert.equal(await mirrorToDefault(src), true);
    assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), incoming);
    const cfg = JSON.parse(fs.readFileSync(homeCfg(), 'utf-8'));
    assert.equal(cfg.theme, 'dark');
    assert.equal(cfg.oauthAccount.emailAddress, 'x@ex.com');
  });

  it('passive unnamed default with an older incoming grant is untouched', async () => {
    const current = grant(9_000, 'other@ex.com', 'OTHER');
    writeJson(defaultToken(), current);
    writeJson(homeCfg(), { theme: 'dark' });
    const cfgBefore = fs.readFileSync(homeCfg());
    const src = makeSource('x@ex.com', grant(1_000, 'x@ex.com', 'X'));
    assert.equal(await mirrorToDefault(src), false);
    assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), current);
    assert.deepEqual(fs.readFileSync(homeCfg()), cfgBefore);
  });

  it('passive with unreadable ~/.claude.json writes nothing in empty and occupied cases', async () => {
    const bad = '{not json';
    writeJson(homeCfg(), bad);
    const cfgBefore = fs.readFileSync(homeCfg());
    const src = makeSource('x@ex.com', grant(9_000, 'x@ex.com', 'X'));

    assert.equal(await mirrorToDefault(src), false);
    assert.equal(fs.existsSync(defaultToken()), false);
    assert.deepEqual(fs.readFileSync(homeCfg()), cfgBefore);

    writeJson(defaultToken(), grant(1_000, 'y@ex.com', 'Y'));
    const tokenBefore = fs.readFileSync(defaultToken());
    assert.equal(await mirrorToDefault(src), false);
    assert.deepEqual(fs.readFileSync(defaultToken()), tokenBefore);
    assert.deepEqual(fs.readFileSync(homeCfg()), cfgBefore);
  });

  it('takeover into an unreadable ~/.claude.json with an occupied default writes nothing', async () => {
    const bad = '{not json';
    writeJson(homeCfg(), bad);
    const current = grant(1_000, 'y@ex.com', 'Y');
    writeJson(defaultToken(), current);
    const cfgBefore = fs.readFileSync(homeCfg());
    const tokenBefore = fs.readFileSync(defaultToken());
    const src = makeSource('x@ex.com', grant(9_000, 'x@ex.com', 'X'));
    assert.equal(await mirrorToDefault(src, { takeover: true }), false);
    assert.deepEqual(fs.readFileSync(defaultToken()), tokenBefore);
    assert.deepEqual(fs.readFileSync(homeCfg()), cfgBefore);
  });

  it('takeover into an unreadable ~/.claude.json with an empty default writes nothing', async () => {
    const bad = '{not json';
    writeJson(homeCfg(), bad);
    const cfgBefore = fs.readFileSync(homeCfg());
    const src = makeSource('x@ex.com', grant(9_000, 'x@ex.com', 'X'));
    assert.equal(await mirrorToDefault(src, { takeover: true }), false);
    assert.equal(fs.existsSync(defaultToken()), false);
    assert.deepEqual(fs.readFileSync(homeCfg()), cfgBefore);
  });

  it('passive named token-less default, different account, is untouched', async () => {
    const cfg = JSON.stringify({
      oauthAccount: { emailAddress: 'y@ex.com', displayName: 'y@ex.com' },
    });
    writeJson(homeCfg(), cfg);
    const cfgBefore = fs.readFileSync(homeCfg());
    const src = makeSource('x@ex.com', grant(9_000, 'x@ex.com', 'X'));
    assert.equal(await mirrorToDefault(src), false);
    assert.equal(fs.existsSync(defaultToken()), false);
    assert.deepEqual(fs.readFileSync(homeCfg()), cfgBefore);
  });

  it('passive named token-less default, same account, first observation is untouched', async () => {
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
    assert.equal(await mirrorToDefault(src), false);
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
    assert.equal(await mirrorToDefault(src), false);
    await new Promise((resolve) => setTimeout(resolve, 80));
    // The login completes (default token present) while a token-less source
    // reconciles: nothing to mirror, but the episode must close here.
    writeJson(defaultToken(), grant(8_000, email, 'D'));
    const bare = makeSource(email, incoming, 'bare');
    fs.rmSync(path.join(bare, '.credentials.json'));
    assert.equal(await mirrorToDefault(bare), false);
    // A later sign-out starts a NEW episode: its first observation is untouched
    // even though the old `since` is long past the window.
    fs.rmSync(defaultToken());
    assert.equal(await mirrorToDefault(src), false);
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
    assert.equal(await mirrorToDefault(src), false);
    assert.equal(fs.existsSync(defaultToken()), false);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(await mirrorToDefault(src), true);
    assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), incoming);
    const cfg = JSON.parse(fs.readFileSync(homeCfg(), 'utf-8'));
    assert.equal(cfg.oauthAccount.emailAddress, email);
  });

  it('lock held by a live pid skips the write; removing it lets the same call write', async () => {
    const incoming = grant(9_000, 'x@ex.com', 'X');
    const src = makeSource('x@ex.com', incoming);
    const lockDir = path.join(defaultDir(), '.credentials.json.lock');
    fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(lockDir, 'owner.json'),
      JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() })
    );
    assert.equal(await mirrorToDefault(src), false);
    assert.equal(fs.existsSync(defaultToken()), false);
    assert.equal(fs.existsSync(homeCfg()), false);
    fs.rmSync(lockDir, { recursive: true, force: true });
    assert.equal(await mirrorToDefault(src), true);
    assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), incoming);
    const cfg = JSON.parse(fs.readFileSync(homeCfg(), 'utf-8'));
    assert.equal(cfg.oauthAccount.emailAddress, 'x@ex.com');
  });

  it('case-different emails are the same account on a passive refresh', async () => {
    const current = grant(2_000, 'x@ex.com', 'CUR');
    writeJson(defaultToken(), current);
    writeJson(homeCfg(), {
      oauthAccount: { emailAddress: 'X@Ex.com', displayName: 'X@Ex.com' },
    });
    const incoming = grant(3_000, 'x@ex.com', 'NEW');
    const src = makeSource('x@ex.com', incoming);
    assert.equal(await mirrorToDefault(src), true);
    assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), incoming);
  });

  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  it(
    'identity write failure after a token write removes the token',
    { skip: isRoot ? 'running as root — chmod 500 does not deny writes' : false },
    async () => {
      const incoming = grant(9_000, 'x@ex.com', 'X');
      const src = makeSource('x@ex.com', incoming);
      fs.mkdirSync(defaultDir(), { recursive: true, mode: 0o700 });
      writeJson(homeCfg(), { theme: 'dark' });
      const homeMode = fs.statSync(tmpHome).mode;
      fs.chmodSync(tmpHome, 0o500);
      try {
        assert.equal(await mirrorToDefault(src), false);
        assert.equal(fs.existsSync(defaultToken()), false);
      } finally {
        fs.chmodSync(tmpHome, homeMode & 0o777);
      }
    }
  );

  it('identity write merges onto a fresh re-read, not the classification snapshot', async () => {
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
    assert.equal(await mirrorToDefault(src, { takeover: true }), true);
    const cfg = JSON.parse(fs.readFileSync(homeCfg(), 'utf-8'));
    assert.equal(cfg.late, 1);
    assert.equal(cfg.keep, undefined);
    assert.equal(cfg.oauthAccount.emailAddress, 'x@ex.com');
  });

  it('takeover waits past 500 ms for a busy lock; passive does not', async () => {
    const incoming = grant(9_000, 'x@ex.com', 'X');
    const src = makeSource('x@ex.com', incoming);
    const lockDir = path.join(defaultDir(), '.credentials.json.lock');
    fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(lockDir, 'owner.json'),
      JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() })
    );
    // The release runs in another process: a real cross-window contention, and
    // the caps are then measured against a holder this event loop cannot hurry.
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

    assert.equal(await mirrorToDefault(src), false);
    assert.equal(fs.existsSync(defaultToken()), false);

    assert.equal(await mirrorToDefault(src, { takeover: true }), true);
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
    assert.equal(await mirrorToDefault(src), false);
    assert.equal(fs.existsSync(defaultToken()), false);

    const lockDir = path.join(defaultDir(), '.credentials.json.lock');
    fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(lockDir, 'owner.json'),
      JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() })
    );

    // First re-check: delay 200+1000=1200 ms, then a lock wait of 500 ms in
    // 15 ms steps — timer steps, so ~1750 ms wall clock, and longer on a loaded
    // machine. Wait past that but well inside the three-attempt chain, whose
    // last acquisition attempt lands around 3300 ms.
    await new Promise((resolve) => setTimeout(resolve, 2200));
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

  it('a re-check that wins the lock after a dispose neither writes nor re-arms', async () => {
    _setMidOauthAbandonMs(200);
    const email = 'x@ex.com';
    writeJson(homeCfg(), {
      oauthAccount: { emailAddress: email, displayName: email },
    });
    const src = makeSource(email, grant(9_000, email, 'X'));
    assert.equal(await mirrorToDefault(src), false);

    // Hold the lock so the first re-check (fires ~1200 ms in) is inside its
    // 500 ms lock wait when the dispose lands, then let go so that same awaited
    // mirror ACQUIRES the lock. Reaching the locked section is the point: that is
    // where a token-less default re-seeds the clock and arms the next timer.
    const lockDir = path.join(defaultDir(), '.credentials.json.lock');
    fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(lockDir, 'owner.json'),
      JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() })
    );
    // Dispose the moment the re-check starts waiting for the lock — off the seam,
    // not the clock, so a slow runner cannot move the dispose outside the wait.
    let waiting = 0;
    _setBeforeMirrorLock(() => waiting++);
    const armedBy = Date.now() + 10_000;
    while (waiting === 0 && Date.now() < armedBy) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(waiting, 1, 'the re-check reached its lock wait');
    disposeMirrorTimers();
    fs.rmSync(lockDir, { recursive: true, force: true });

    // A timer armed from inside the lock would fire 1200 ms on, find the abandon
    // window long past, and refill. Wait well beyond that.
    await new Promise((resolve) => setTimeout(resolve, 2200));
    assert.equal(fs.existsSync(defaultToken()), false, 'a disposed window must not refill');
    assert.equal(logText().includes('default dir busy'), false, 'the re-check acquired the lock');
    assert.equal(waiting, 1, 'nothing ran after the disposed re-check');
  });

  it('a refill rolled back by a failed identity write still gets its retry', async () => {
    _setMidOauthAbandonMs(200);
    const email = 'x@ex.com';
    const named = { oauthAccount: { emailAddress: email, displayName: email } };
    writeJson(homeCfg(), named);
    const incoming = grant(9_000, email, 'X');
    const src = makeSource(email, incoming);
    assert.equal(await mirrorToDefault(src), false);

    // The refill ends the absence episode before the identity stamp is known to
    // have landed. Here ~/.claude.json stops being an object between the token
    // write and the stamp, so the token is taken back out again — and the re-check
    // must carry on rather than read the ended episode as its cue to stop.
    let refills = 0;
    _setBeforeIdentityWrite(() => {
      if (refills++ === 0) fs.writeFileSync(homeCfg(), '[]');
    });
    const deadline = Date.now() + 10_000;
    let restored = false;
    while (Date.now() < deadline && refills < 2) {
      if (!restored && logText().includes('removed the token again')) {
        assert.equal(fs.existsSync(defaultToken()), false, 'the rollback took the token out');
        writeJson(homeCfg(), named);
        restored = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(restored, true, 'the rollback ran');
    assert.ok(refills > 1, 'the refill was attempted again after the rollback');
    assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), incoming);
  });

  it('a lock held by a live owner does not block the event loop', async () => {
    const incoming = grant(9_000, 'x@ex.com', 'X');
    const src = makeSource('x@ex.com', incoming);
    const lockDir = path.join(defaultDir(), '.credentials.json.lock');
    fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(lockDir, 'owner.json'),
      JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() })
    );

    // Scheduled BEFORE the call and due well inside the 500 ms passive wait. A
    // wait that sleeps the thread cannot let it run; a wait that yields must.
    let ticked = false;
    const timer = setTimeout(() => {
      ticked = true;
    }, 50);
    const outcome = await mirrorToDefault(src);
    clearTimeout(timer);

    assert.equal(ticked, true, 'the event loop kept running while the mirror waited for the lock');
    assert.equal(outcome, false);
    assert.equal(fs.existsSync(defaultToken()), false);
  });

  it('two overlapping mirrors run one at a time, not side by side', async () => {
    const email = 'x@ex.com';
    const first = grant(2_000, email, 'FIRST');
    const second = grant(3_000, email, 'SECOND');
    const srcA = makeSource(email, first, 'a');
    const srcB = path.join(tmpHome, 'b');

    // Hold the lock so the first call is still waiting when the second is made:
    // that overlap is exactly what a wait yielding the event loop makes possible.
    const lockDir = path.join(defaultDir(), '.credentials.json.lock');
    fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(lockDir, 'owner.json'),
      JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() })
    );
    const release = setTimeout(() => {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }, 100);

    // Runs INSIDE the locked section. It stocks the second call's source dir, so
    // that call can only classify anything at all if it read its source after
    // this section — i.e. if the two ran one after the other, not side by side.
    const seen = [];
    _setBeforeTokenWrite(() => {
      seen.push(fs.existsSync(defaultToken()) ? fs.readFileSync(defaultToken(), 'utf-8') : null);
      writeJson(path.join(srcB, '.credentials.json'), second);
      writeJson(path.join(srcB, '.claude.json'), {
        oauthAccount: { emailAddress: email, displayName: email },
      });
    });

    const a = mirrorToDefault(srcA, { takeover: true });
    const b = mirrorToDefault(srcB, { takeover: true });
    assert.deepEqual(await Promise.all([a, b]), [true, true]);
    clearTimeout(release);

    // Second section saw the first one's token already on disk.
    assert.deepEqual(seen, [null, first]);
    assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), second);
    // Neither call contended with the other for the default dir's lock.
    assert.equal(logText().includes('default dir busy'), false);
  });

  const E = 'x@ex.com';
  /**
   * An account store holding `storeGrant`. A chain object `{current, displaced,
   * hashes}` (hashes named by refresh token) is written to `.grant-chain.json`;
   * an array is the r1 `.grant-history.json` list, which u1 still reads.
   */
  function makeStore(storeGrant, chain) {
    const dir = path.join(tmpHome, 'store');
    fs.rmSync(dir, { recursive: true, force: true });
    writeJson(path.join(dir, '.credentials.json'), storeGrant);
    if (Array.isArray(chain)) {
      writeJson(path.join(dir, '.grant-history.json'), chain.map(rtHash));
    } else {
      writeJson(path.join(dir, '.grant-chain.json'), {
        v: 2,
        current: chain.current,
        displaced: chain.displaced,
        hashes: chain.hashes.map(rtHash),
      });
    }
    return dir;
  }
  function namedDefault(tok, email = E) {
    if (tok) writeJson(defaultToken(), tok);
    writeJson(homeCfg(), { oauthAccount: { emailAddress: email, displayName: email } });
  }

  it("the store's current grant replaces an older refresh of its family or a refresh of an earlier one", async () => {
    const S = grant(5_000, E, 'S', 'RT_S', F(0));
    const cases = [
      // An older refresh of the store's family: same anchor, earlier expiry,
      // a hash the chain never recorded.
      ['older refresh', grant(1_000, E, 'S0', 'RT_S0', F(0))],
      // A refresh of a family a later sign-in replaced: its expiry is later than
      // the store's, which must not decide.
      ['earlier family', grant(9_000, E, 'E1', 'RT_E1', F(-20))],
    ];
    for (const [label, cur] of cases) {
      for (const takeover of [false, true]) {
        global.__caLog = [];
        namedDefault(cur);
        const storeDir = makeStore(S, { current: F(0), displaced: [F(-20)], hashes: ['RT_S'] });
        assert.equal(await mirrorToDefault(makeSource(E, S), { takeover, storeDir }), true);
        assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), S, `${label} takeover=${takeover}`);
        assert.ok(!fs.existsSync(path.join(defaultDir(), '.grant-chain.json')));
      }
    }
  });

  it('a later family or a later refresh of the store family in the default is kept', async () => {
    // Its own email: the passive decline line is throttled per message across
    // the module, and an earlier case must not be able to swallow it.
    const K = 'kept@ex.com';
    const S = grant(5_000, K, 'S', 'RT_S', F(0));
    const cases = [
      // A terminal login into ~/.claude: a later family, an earlier expiry.
      [
        grant(1_000, K, 'LOGIN', 'RT_LOGIN', F(20)),
        'default holds a grant the store has never replaced',
      ],
      // Claude Code refreshed ~/.claude in place: the store's family, later expiry.
      [
        grant(9_000, K, 'S2', 'RT_S2', F(0) + SEC),
        'default holds a newer refresh of the store family',
      ],
    ];
    for (const [cur, reason] of cases) {
      for (const takeover of [false, true]) {
        global.__caLog = [];
        namedDefault(cur, K);
        const storeDir = makeStore(S, { current: F(0), displaced: [], hashes: ['RT_S'] });
        const chainBefore = fs.readFileSync(path.join(storeDir, '.grant-chain.json'));
        assert.equal(await mirrorToDefault(makeSource(K, S), { takeover, storeDir }), takeover);
        assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), cur, `takeover=${takeover}`);
        assert.ok(logText().includes(reason), `${reason} takeover=${takeover}`);
        // The mirror reads the chain and never writes it.
        assert.deepEqual(fs.readFileSync(path.join(storeDir, '.grant-chain.json')), chainBefore);
      }
    }
  });

  it("a source that is not the store's, or no store to ask, keeps the default", async () => {
    const S = grant(5_000, E, 'S', 'RT_S', F(0));
    const cur = grant(1_000, E, 'OLD', 'RT_OLD', F(-20));
    const fork = grant(9_000, E, 'FORK', 'RT_FORK', F(0));
    for (const [takeover, withStore] of [
      [false, true],
      [true, true],
      [false, false],
      [true, false],
    ]) {
      namedDefault(cur);
      const storeDir = withStore
        ? makeStore(S, { current: F(0), displaced: [F(-20)], hashes: ['RT_OLD', 'RT_S'] })
        : undefined;
      assert.equal(await mirrorToDefault(makeSource(E, fork), { takeover, storeDir }), takeover);
      assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), cur, `${takeover} ${withStore}`);
    }
    assert.ok(logText().includes("source grant is not the store's"));
    assert.ok(logText().includes('default holds a grant of another lineage'));
  });

  it('an r1 history array is still read: a default grant it lists is replaced', async () => {
    // Same family, and a later expiry than the store's: only the hash the r1
    // list holds makes it a copy the store has moved past.
    const S = grant(5_000, E, 'S', 'RT_S', F(0));
    const old = grant(9_000, E, 'OLD', 'RT_OLD', F(0));
    for (const takeover of [false, true]) {
      namedDefault(old);
      const storeDir = makeStore(S, ['RT_OLD', 'RT_S']);
      assert.equal(await mirrorToDefault(makeSource(E, S), { takeover, storeDir }), true);
      assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), S, `takeover=${takeover}`);
    }
  });

  it('a terminal login into ~/.claude survives the mid-OAuth re-check', async () => {
    const storeGrant = grant(9_000, E, 'S', 'RT_S', F(0));
    for (const withStore of [true, false]) {
      disposeMirrorTimers();
      _setMidOauthAbandonMs(50);
      global.__caLog = [];
      fs.rmSync(defaultToken(), { force: true });
      namedDefault(null);
      const storeDir = withStore
        ? makeStore(storeGrant, { current: F(0), displaced: [], hashes: ['RT_S'] })
        : undefined;
      assert.equal(await mirrorToDefault(makeSource(E, storeGrant), { storeDir }), false);
      const login = grant(1_000, E, 'LOGIN', 'RT_LOGIN', F(20));
      writeJson(defaultToken(), login);
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !logText().includes('re-check for')) {
        if (fs.readFileSync(defaultToken(), 'utf-8') !== login) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(fs.readFileSync(defaultToken(), 'utf-8'), login, `withStore=${withStore}`);
    }
  });

  describe('snapshotAccount', () => {
    const OTHER = 'other@ex.com';
    function otherStore({ current, displaced = [], fileAnchor }) {
      const dir = path.join(tmpHome, '.claude-other');
      writeJson(path.join(dir, '.claude.json'), {
        oauthAccount: { emailAddress: OTHER, displayName: OTHER },
      });
      writeJson(path.join(dir, '.credentials.json'), grant(5_000, OTHER, 'O', 'RT_O', fileAnchor));
      writeJson(path.join(dir, '.grant-chain.json'), { v: 2, current, displaced, hashes: [] });
      return dir;
    }
    const target = () => path.join(tmpHome, '.claude-x');

    it("refuses a grant whose family another account's chain or file knows", () => {
      const other = otherStore({ current: F(0), displaced: [F(-20)], fileAnchor: F(-40) });
      // Within the window of the other chain's current, a displaced family, and
      // its credential file's family; no grant matches byte-wise.
      for (const a of [F(0) + SEC, F(-20) - 2 * SEC, F(-40) + 5 * 60_000]) {
        const src = makeSource(E, grant(9_000, E, 'N', `RT_N${a}`, a));
        assert.throws(
          () => snapshotAccount(src, target(), { email: E }),
          (err) => err.message.includes('Refusing to save') && err.message.includes(other),
          `anchor ${a}`
        );
        assert.equal(fs.existsSync(path.join(target(), '.credentials.json')), false);
      }
    });

    it('mints a store from a grant of a family no other account knows', () => {
      otherStore({ current: F(0), displaced: [F(-20)], fileAnchor: F(-40) });
      const tok = grant(9_000, E, 'N', 'RT_N', F(20));
      const src = makeSource(E, tok);
      snapshotAccount(src, target(), { email: E });
      assert.equal(fs.readFileSync(path.join(target(), '.credentials.json'), 'utf-8'), tok);
    });
  });

  it('does not log a success line when the token write throws', async () => {
    const src = makeSource('x@ex.com', grant(9_000, 'x@ex.com', 'X'));
    _setBeforeTokenWrite(() => {
      throw new Error('injected write failure');
    });
    assert.equal(await mirrorToDefault(src), false);
    assert.equal(logText().includes('filled with'), false);
    assert.equal(fs.existsSync(defaultToken()), false);
  });
});
