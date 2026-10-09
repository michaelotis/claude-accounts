const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

/**
 * workdir.ts imports vscode (via log/accounts) — bundle with the same minimal
 * vscode stub the other unit bundles use.
 */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `self-heal-${process.pid}-`));
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
const bundleOut = path.join(tmpRoot, 'workdir.bundle.cjs');
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/workdir.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundleOut,
  alias: { vscode: vscodeStub },
});
const {
  healVerdict,
  refreshStore,
  readGrantHistory,
  recordGrantHistory,
  grantHistoryPath,
  credentialFingerprint,
  MINTED_WINDOW_MS,
} = require(bundleOut);

// The 2026-10-09 shapes. S: the store's grant (revoked at the API, but with the
// later expiry). L: the sign-in a window wrote at T, the moment it was minted,
// never held by the store, with an EARLIER expiry than S. A: an older copy the
// store held and rotated past. R: a copy re-seeded into a window at T long after
// it was minted, so little of its lifetime is left.
const T = Date.parse('2026-10-09T13:32:44Z');
const H = 3_600_000;
const grant = (rt, exp) =>
  Buffer.from(
    JSON.stringify({
      claudeAiOauth: { accessToken: `at-${rt.slice(3)}`, refreshToken: rt, expiresAt: exp },
    })
  );
const S = grant('rt-S', T + 8.5 * H);
const L = grant('rt-L', T + 8 * H);
const A = grant('rt-A', T - 1 * H);
const R = grant('rt-R', T + 1 * H);
const hash = (buf) => crypto.createHash('sha256').update(credentialFingerprint(buf)).digest('hex');
const OLD_MTIME = T - 60_000;
const writtenAt = (dir, ms) =>
  fs.utimesSync(path.join(dir, '.credentials.json'), ms / 1000, ms / 1000);

it('fixtures: L is minted at T, R is not', () => {
  assert.ok(T + 8 * H - T >= MINTED_WINDOW_MS);
  assert.ok(T + 1 * H - T < MINTED_WINDOW_MS);
});
describe('healVerdict', () => {
  it('(i) adopts a grant the store has never held, even with an earlier expiry', () => {
    assert.equal(healVerdict(L, S, [hash(S)], T, T, true), 'adopt');
  });

  it('(viii) adopts an unknown grant written at mint time, judged by write time not now', () => {
    assert.equal(healVerdict(L, S, [hash(S)], T, T + 2 * H, true), 'adopt');
  });

  it('(ix) keeps an unknown grant written long after it was minted', () => {
    assert.equal(healVerdict(R, S, [], T, T + 60_000, true), 'keep');
    assert.equal(healVerdict(R, S, [hash(S)], T, T + 60_000, true), 'keep');
  });

  it('(x) adopts a grant minted at write time with no history yet (upgrade bootstrap)', () => {
    assert.equal(healVerdict(L, S, [], T, T + 60_000, true), 'adopt');
  });

  it('(ii) restocks a known older copy from the store', () => {
    assert.equal(healVerdict(A, S, [hash(S), hash(A)], OLD_MTIME, T, true), 'restock');
  });

  it('(iii) keeps a known older copy when selfHeal is off', () => {
    assert.equal(healVerdict(A, S, [hash(S), hash(A)], OLD_MTIME, T, false), 'keep');
  });

  it('(iv) keeps a credential file written in the last 10 s', () => {
    assert.equal(healVerdict(A, S, [hash(S), hash(A)], T - 3_000, T, true), 'keep');
  });

  it('(v) keeps the store grant itself', () => {
    assert.equal(healVerdict(S, S, [hash(S)], OLD_MTIME, T, true), 'keep');
  });

  it('keeps a known copy whose expiry is not earlier than the store', () => {
    assert.equal(healVerdict(S, L, [hash(S), hash(L)], OLD_MTIME, T, true), 'keep');
  });
});

describe('refreshStore + grant history', () => {
  let home;
  let prevHome;

  before(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-self-heal-home-'));
    prevHome = process.env.HOME;
    process.env.HOME = home;
  });

  after(() => {
    process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  let n = 0;
  const mkDir = (prefix, token) => {
    const dir = path.join(home, `${prefix}${++n}`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, '.credentials.json'), token, { mode: 0o600 });
    fs.writeFileSync(
      path.join(dir, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'b@example.com' } }),
      { mode: 0o600 }
    );
    return dir;
  };
  const account = (dir) => ({ name: path.basename(dir), dir, email: 'b@example.com' });
  const cred = (dir) => fs.readFileSync(path.join(dir, '.credentials.json'));

  it('(i) writes a never-held sign-in into the store although its expiry is earlier', async () => {
    const store = mkDir('.claude-b', S);
    recordGrantHistory(store, S);
    const wd = mkDir('wd', L);
    writtenAt(wd, T);
    await refreshStore(account(store), wd);
    assert.ok(cred(store).equals(L), 'the sign-in must replace the store grant');
    const history = readGrantHistory(store);
    assert.ok(history.includes(hash(S)) && history.includes(hash(L)));
  });

  it('keeps the sign-in when another dir still holds the replaced store grant', async () => {
    const store = mkDir('.claude-b', S);
    recordGrantHistory(store, S);
    const w1 = mkDir('wd', L);
    writtenAt(w1, T);
    const w2 = mkDir('wd', S);
    await refreshStore(account(store), w1);
    await refreshStore(account(store), w2);
    assert.ok(cred(store).equals(L), 'a later expiry must not put the replaced grant back');
    const history = readGrantHistory(store);
    assert.equal(healVerdict(L, cred(store), history, OLD_MTIME, T, true), 'keep');
    assert.equal(healVerdict(S, cred(store), history, OLD_MTIME, T, true), 'keep');
  });

  it("adopts the store grant's own in-place refresh", async () => {
    const store = mkDir('.claude-b', S);
    recordGrantHistory(store, S);
    const refreshed = Buffer.from(
      JSON.stringify({
        claudeAiOauth: { accessToken: 'at-S2', refreshToken: 'rt-S', expiresAt: T + 9 * H },
      })
    );
    const wd = mkDir('wd', refreshed);
    await refreshStore(account(store), wd);
    assert.ok(cred(store).equals(refreshed));
  });

  it('(vii) records the store grant on a refused adopt, so a lagging copy of it restocks', async () => {
    const store = mkDir('.claude-b', S);
    recordGrantHistory(store, A);
    const wd = mkDir('wd', A);
    await refreshStore(account(store), wd);
    assert.ok(cred(store).equals(S), 'a known older copy must not replace the store grant');
    assert.ok(readGrantHistory(store).includes(hash(S)));
    // The store then rotates past S outside reconcile (the usage poll's refresh).
    const S2 = grant('rt-S2', T + 9 * H);
    fs.writeFileSync(path.join(store, '.credentials.json'), S2);
    assert.equal(healVerdict(S, S2, readGrantHistory(store), OLD_MTIME, T, true), 'restock');
  });

  it('(ix) leaves the store untouched for an unknown grant not written at mint time', async () => {
    const store = mkDir('.claude-b', S);
    const wd = mkDir('wd', R);
    writtenAt(wd, T);
    await refreshStore(account(store), wd);
    assert.ok(cred(store).equals(S), 'a re-seeded old copy must not replace the store grant');
    assert.ok(cred(wd).equals(R), 'the window file is not touched');
    assert.ok(!readGrantHistory(store).includes(hash(R)));
  });

  it('(x) adopts a grant minted at write time into a store with no history', async () => {
    const store = mkDir('.claude-b', S);
    const wd = mkDir('wd', L);
    writtenAt(wd, T);
    await refreshStore(account(store), wd);
    assert.ok(cred(store).equals(L), 'a fresh sign-in is adopted before any history exists');
  });

  it('(vi) the history holds sha256 hashes only, capped at 32', () => {
    const store = mkDir('.claude-b', S);
    const grants = Array.from({ length: 40 }, (_, i) => grant(`rt-${i}`, T + i));
    for (const g of grants) recordGrantHistory(store, g);
    recordGrantHistory(store, grants[39]);
    const raw = fs.readFileSync(grantHistoryPath(store), 'utf8');
    assert.ok(!raw.includes('rt-'), 'no refresh token in the history file');
    assert.ok(!raw.includes('at-'), 'no access token in the history file');
    const history = JSON.parse(raw);
    assert.equal(history.length, 32);
    assert.ok(history.every((h) => /^[0-9a-f]{64}$/.test(h)));
    assert.deepEqual(history, grants.slice(-32).map(hash));
    assert.equal(fs.statSync(grantHistoryPath(store)).mode & 0o777, 0o600);
  });

  it('reads a missing or unparseable history as empty', () => {
    const store = mkDir('.claude-b', S);
    assert.deepEqual(readGrantHistory(store), []);
    fs.writeFileSync(grantHistoryPath(store), '{not json');
    assert.deepEqual(readGrantHistory(store), []);
  });
});
