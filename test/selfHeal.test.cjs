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
function bundle(entry, name) {
  const out = path.join(tmpRoot, name);
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, entry)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: out,
    alias: { vscode: vscodeStub },
  });
  return require(out);
}
const {
  relateToStore,
  healVerdict,
  healAtActivation,
  refreshStore,
  restockTokenOnly,
  materialize,
  readGrantHistory,
  recordGrantHistory,
  grantHistoryPath,
  grantOriginPath,
  readDirRecord,
  observeDirGrant,
  recordExtWrite,
  noteTokenless,
  signInObservedAt,
  credentialFingerprint,
} = bundle('../src/workdir.ts', 'workdir.bundle.cjs');
const { fetchUsageCoordinated, __ageInProcessStateForTests } = bundle(
  '../src/usage.ts',
  'usage.bundle.cjs'
);

// Every fixture hangs off one clock read. Expiries sit just inside the 8 h token
// lifetime, so a grant is live for the whole run; refresh tokens rotate, so each
// refresh below is a new fingerprint.
const T = Date.now();
const MIN = 60_000;
const LIVE = T + 479 * MIN;
const grant = (rt, exp = LIVE) =>
  Buffer.from(
    JSON.stringify({
      claudeAiOauth: { accessToken: `at-${rt.slice(3)}`, refreshToken: rt, expiresAt: exp },
    })
  );
const S = grant('rt-S');
const L = grant('rt-L', LIVE - 30 * MIN);
const A = grant('rt-A', LIVE + 30 * MIN);
const E = grant('rt-E', T - 10 * MIN);
const NOEXP = Buffer.from(
  JSON.stringify({ claudeAiOauth: { accessToken: 'at-N', refreshToken: 'rt-N' } })
);
const hash = (buf) => crypto.createHash('sha256').update(credentialFingerprint(buf)).digest('hex');
const OLD_MTIME = T - 10 * MIN;
const rec = (h, held, by = 'cc') => ({ h, held, by, at: T });
const opts = (o = {}) => ({
  dirChanged: false,
  signInObserved: false,
  trusted: false,
  nowMs: T,
  ...o,
});

describe('relateToStore', () => {
  it('same for the store grant itself', () => {
    assert.equal(relateToStore(S, S, [hash(S)], null, opts()), 'same');
  });

  it('known for a grant the store held, whatever its expiry (R1-M1)', () => {
    assert.equal(relateToStore(A, S, [hash(A), hash(S)], null, opts()), 'known');
    assert.equal(relateToStore(E, S, [hash(E), hash(S)], null, opts()), 'known');
    // A process-held predecessor does not turn a known copy into a continuation.
    const r = rec(hash(L), hash(S));
    assert.equal(relateToStore(A, S, [hash(A), hash(S)], r, opts({ dirChanged: true })), 'known');
  });

  it('continues when the process held the store grant before Claude Code wrote', () => {
    const r = rec(hash(S), hash(S));
    assert.equal(relateToStore(L, S, [hash(S)], r, opts({ dirChanged: true })), 'continues');
  });

  it('unrelated when the extension, not Claude Code, last moved the disk', () => {
    const r = rec(hash(S), hash(S));
    assert.equal(relateToStore(L, S, [hash(S)], r, opts({ dirChanged: false })), 'unrelated');
  });

  it('unrelated when the process held some other grant', () => {
    const r = rec(hash(A), hash(A));
    assert.equal(relateToStore(L, S, [hash(S)], r, opts({ dirChanged: true })), 'unrelated');
  });

  it('unrelated with no record, no observed gap and no trust', () => {
    assert.equal(relateToStore(L, S, [hash(S)], null, opts({ dirChanged: true })), 'unrelated');
  });

  it('unrelated for an expired unknown grant, even with held = the store grant', () => {
    const r = rec(hash(S), hash(S));
    for (const o of [{ dirChanged: true }, { signInObserved: true }, { trusted: true }]) {
      assert.equal(relateToStore(E, S, [hash(S)], r, opts(o)), 'unrelated');
    }
  });

  it('continues on an observed sign-in or a trusted capture', () => {
    assert.equal(relateToStore(L, S, [hash(S)], null, opts({ signInObserved: true })), 'continues');
    assert.equal(relateToStore(L, S, [hash(S)], null, opts({ trusted: true })), 'continues');
  });

  it('null expiry: an unparseable dir grant is unrelated, an unparseable store is repaired (R1-m5)', () => {
    const r = rec(hash(S), hash(S));
    assert.equal(relateToStore(NOEXP, S, [hash(S)], r, opts({ dirChanged: true })), 'unrelated');
    assert.equal(relateToStore(L, NOEXP, [], null, opts()), 'continues');
    assert.equal(relateToStore(L, Buffer.from('not json'), [], null, opts()), 'continues');
  });
});

describe('healVerdict', () => {
  const v = (relation, selfHeal = true, mtime = OLD_MTIME) =>
    healVerdict(relation, selfHeal, mtime, T);

  it('keeps the same grant, adopts a continuation, keeps an unrelated grant', () => {
    assert.deepEqual(v('same'), { verdict: 'keep', reason: 'same' });
    assert.deepEqual(v('continues'), { verdict: 'adopt', reason: 'continues' });
    assert.deepEqual(v('unrelated'), { verdict: 'keep', reason: 'unrelated' });
  });

  it('restocks a known copy', () => {
    assert.deepEqual(v('known'), { verdict: 'restock', reason: 'known' });
  });

  it('keeps a known copy when selfHeal is off', () => {
    assert.deepEqual(v('known', false), { verdict: 'keep', reason: 'selfHeal-off' });
  });

  it('keeps a known copy whose mtime could not be read', () => {
    assert.deepEqual(v('known', true, null), { verdict: 'keep', reason: 'unreadable-mtime' });
  });

  it('keeps a known copy written in the last 10 s', () => {
    assert.deepEqual(v('known', true, T - 3_000), { verdict: 'keep', reason: 'burst' });
    assert.deepEqual(v('known', true, T - 10_000), { verdict: 'restock', reason: 'known' });
  });
});

describe('refreshStore, the dir record and the activation heal', () => {
  let home;
  let prevHome;
  let keepalive;

  before(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-self-heal-home-'));
    prevHome = process.env.HOME;
    process.env.HOME = home;
    // withLockAsync waits on unref'd timers; a ref'd interval keeps node:test from
    // draining the loop while a lock-skip case waits out its cap.
    keepalive = setInterval(() => {}, 50);
  });

  after(() => {
    clearInterval(keepalive);
    process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  let n = 0;
  const mkDir = (prefix, token) => {
    const dir = path.join(home, `${prefix}${++n}`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(dir, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'b@example.com' } }),
      {
        mode: 0o600,
      }
    );
    if (token) put(dir, token);
    return dir;
  };
  const account = (dir) => ({ name: path.basename(dir), dir, email: 'b@example.com' });
  const cred = (dir) => fs.readFileSync(path.join(dir, '.credentials.json'));
  // A write by the window's Claude Code: a sign-in or a refresh, mtime pinned.
  const put = (dir, token, ms = OLD_MTIME) => {
    const f = path.join(dir, '.credentials.json');
    fs.writeFileSync(f, token, { mode: 0o600 });
    fs.utimesSync(f, ms / 1000, ms / 1000);
  };
  const record = (dir) => readDirRecord(dir);
  const writeRecord = (dir, r) =>
    fs.writeFileSync(grantOriginPath(dir), JSON.stringify(r), { mode: 0o600 });

  it('M-1: a fork refreshed after a restock never reaches the store, and A is never restocked', async () => {
    const S1 = grant('rt-S1');
    const L1 = grant('rt-L1', LIVE - 60 * MIN);
    const S2 = grant('rt-S2'); // B's process refreshes the S1 it holds in memory
    const L2 = grant('rt-L2', LIVE - 50 * MIN);
    const store = mkDir('.claude-b', S1);
    const acct = account(store);
    const wa = mkDir('wd', S1);
    const wb = mkDir('wd', S1);
    const storeNeverFork = () =>
      assert.ok(!cred(store).equals(S2), 'the store never holds the fork');

    // 0: both activated.
    healAtActivation(acct, wa, { selfHeal: true });
    healAtActivation(acct, wb, { selfHeal: true });
    assert.deepEqual((await refreshStore(acct, wa)).relation, 'same');
    assert.equal(record(wa).held, hash(S1));
    assert.equal(record(wb).held, hash(S1));

    // 1: A signs in.
    put(wa, L1);
    const r1 = await refreshStore(acct, wa);
    assert.equal(r1.relation, 'continues');
    assert.ok(r1.wrote && cred(store).equals(L1));
    assert.ok(cred(wa).equals(L1));
    assert.deepEqual([record(wa).h, record(wa).held, record(wa).by], [hash(L1), hash(L1), 'cc']);

    // 2: B holds S1, which the store has moved past.
    const r2 = await refreshStore(acct, wb);
    assert.equal(r2.relation, 'known');
    assert.ok(cred(store).equals(L1));
    assert.equal(healVerdict(r2.relation, true, OLD_MTIME, Date.now()).verdict, 'restock');
    assert.ok(restockTokenOnly(cred(store), wb, S1));
    assert.ok(cred(wb).equals(L1));
    assert.deepEqual([record(wb).h, record(wb).held, record(wb).by], [hash(L1), hash(S1), 'ext']);

    // 3: B's process refreshes the S1 it still holds.
    put(wb, S2);
    const r3 = await refreshStore(acct, wb);
    assert.equal(r3.relation, 'unrelated');
    assert.equal(r3.wrote, false);
    assert.equal(
      relateToStore(
        S2,
        cred(store),
        readGrantHistory(store),
        rec(hash(L1), hash(S1)),
        opts({ dirChanged: true, nowMs: Date.now() })
      ),
      'unrelated'
    );
    storeNeverFork();
    assert.ok(cred(store).equals(L1));
    assert.ok(cred(wb).equals(S2), "B's file is left alone");
    assert.deepEqual([record(wb).h, record(wb).held, record(wb).by], [hash(S2), hash(S2), 'cc']);

    // 4: A's process refreshes L1.
    put(wa, L2);
    const r4 = await refreshStore(acct, wa);
    assert.equal(r4.relation, 'continues');
    assert.ok(cred(store).equals(L2));
    assert.ok(cred(wa).equals(L2));

    // 5: B reconciles again.
    const r5 = await refreshStore(acct, wb);
    assert.equal(r5.relation, 'unrelated');
    storeNeverFork();
    assert.ok(cred(store).equals(L2));
    assert.ok(cred(wb).equals(S2));
    assert.notEqual(record(wa).by, 'ext', "A's file was never written by the extension");
  });

  it('M-1: a window reloaded after its restock continues the store on its next refresh', async () => {
    const S1 = grant('rt-S1r');
    const L1 = grant('rt-L1r', LIVE - 60 * MIN);
    const L3 = grant('rt-L3r', LIVE - 40 * MIN);
    const store = mkDir('.claude-b', S1);
    const acct = account(store);
    const wb = mkDir('wd', S1);
    healAtActivation(acct, wb, { selfHeal: true });
    await refreshStore(acct, wb);
    fs.writeFileSync(path.join(store, '.credentials.json'), L1); // A's sign-in, carried in
    assert.equal((await refreshStore(acct, wb)).relation, 'known');
    assert.ok(restockTokenOnly(cred(store), wb, S1));
    assert.equal(record(wb).held, hash(S1));
    // Reload: the activation step runs before Claude Code reads the dir.
    healAtActivation(acct, wb, { selfHeal: true });
    assert.deepEqual([record(wb).h, record(wb).held], [hash(L1), hash(L1)]);
    put(wb, L3);
    const r = await refreshStore(acct, wb);
    assert.equal(r.relation, 'continues');
    assert.ok(cred(store).equals(L3));
  });

  it('byte-equal: records the dir once and returns same; a second pass rewrites nothing', async () => {
    const store = mkDir('.claude-b', S);
    const wd = mkDir('wd', S);
    const r = await refreshStore(account(store), wd);
    assert.deepEqual(r, { relation: 'same', wrote: false, deferred: false });
    const got = JSON.parse(fs.readFileSync(grantOriginPath(wd), 'utf8'));
    assert.deepEqual([got.h, got.held, got.by], [hash(S), hash(S), 'cc']);
    assert.equal(fs.statSync(grantOriginPath(wd)).mode & 0o777, 0o600);
    fs.utimesSync(grantOriginPath(wd), OLD_MTIME / 1000, OLD_MTIME / 1000);
    const pinned = fs.statSync(grantOriginPath(wd)).mtimeMs;
    await refreshStore(account(store), wd);
    assert.equal(fs.statSync(grantOriginPath(wd)).mtimeMs, pinned);
  });

  it('R1-M3: records the store grant before the byte-equal return', async () => {
    const store = mkDir('.claude-b', S);
    const wd = mkDir('wd', S);
    await refreshStore(account(store), wd);
    assert.deepEqual(readGrantHistory(store), [hash(S)]);
  });

  it('R1-M3: a known copy held by a process that held the store grant is not adopted', async () => {
    const store = mkDir('.claude-b', S);
    recordGrantHistory(store, A);
    const wd = mkDir('wd', A);
    writeRecord(wd, rec(hash(L), hash(S)));
    const r = await refreshStore(account(store), wd);
    assert.equal(r.relation, 'known');
    assert.ok(cred(store).equals(S), 'a later expiry does not put a known copy back');
    assert.ok(cred(wd).equals(A));
  });

  it('held stays put on an extension restock and follows the activation restock', () => {
    const store = mkDir('.claude-b', S);
    const wd = mkDir('wd', A);
    observeDirGrant(wd, A);
    assert.ok(restockTokenOnly(store, wd));
    assert.deepEqual([record(wd).h, record(wd).held, record(wd).by], [hash(S), hash(A), 'ext']);

    const S2 = grant('rt-S2h');
    const store2 = mkDir('.claude-b', S2);
    recordGrantHistory(store2, A);
    const wd2 = mkDir('wd', A);
    observeDirGrant(wd2, A);
    healAtActivation(account(store2), wd2, { selfHeal: true });
    assert.ok(cred(wd2).equals(S2), 'a known copy is restocked at activation');
    assert.deepEqual(
      [record(wd2).h, record(wd2).held, record(wd2).by],
      [hash(S2), hash(S2), 'ext']
    );
  });

  it('activation heal leaves a known copy when selfHeal is off and an unknown grant always', () => {
    const store = mkDir('.claude-b', S);
    recordGrantHistory(store, A);
    const wd = mkDir('wd', A);
    healAtActivation(account(store), wd, { selfHeal: false });
    assert.ok(cred(wd).equals(A));
    const wd2 = mkDir('wd', L);
    healAtActivation(account(store), wd2, { selfHeal: true });
    assert.ok(cred(wd2).equals(L));
    assert.deepEqual([record(wd2).h, record(wd2).held], [hash(L), hash(L)]);
  });

  it('no record: an unknown live grant is unrelated — store and dir unchanged', async () => {
    const store = mkDir('.claude-b', S);
    const wd = mkDir('wd', L);
    const r = await refreshStore(account(store), wd);
    assert.equal(r.relation, 'unrelated');
    assert.ok(cred(store).equals(S));
    assert.ok(cred(wd).equals(L));
    assert.ok(!readGrantHistory(store).includes(hash(L)));
  });

  it('expired: an unknown grant past its expiry is unrelated even when held = the store grant', async () => {
    const store = mkDir('.claude-b', S);
    const wd = mkDir('wd', E);
    writeRecord(wd, rec(hash(S), hash(S)));
    const r = await refreshStore(account(store), wd);
    assert.equal(r.relation, 'unrelated');
    assert.ok(cred(store).equals(S));
  });

  it('a continuation is adopted only once Claude Code moved the disk', async () => {
    const store = mkDir('.claude-b', S);
    const wd = mkDir('wd', L);
    writeRecord(wd, rec(hash(L), hash(S), 'ext'));
    assert.equal((await refreshStore(account(store), wd)).relation, 'unrelated');
    assert.ok(cred(store).equals(S));
  });

  it("adopts the store grant's own in-place refresh with a later expiry", async () => {
    const store = mkDir('.claude-b', S);
    const refreshed = Buffer.from(
      JSON.stringify({
        claudeAiOauth: { accessToken: 'at-S2', refreshToken: 'rt-S', expiresAt: LIVE + MIN },
      })
    );
    const wd = mkDir('wd', refreshed);
    const r = await refreshStore(account(store), wd);
    assert.deepEqual([r.relation, r.wrote], ['same', true]);
    assert.ok(cred(store).equals(refreshed));
  });

  it('observed sign-in: a grant after a token-less observation is adopted and the observation spent', async () => {
    const store = mkDir('.claude-b', S);
    const wd = mkDir('wd', A);
    observeDirGrant(wd, A);
    fs.rmSync(path.join(wd, '.credentials.json'));
    noteTokenless(wd);
    const at = signInObservedAt(wd);
    assert.ok(at != null);
    put(wd, L, at);
    const r = await refreshStore(account(store), wd);
    assert.equal(r.relation, 'continues');
    assert.notEqual(record(wd).held, hash(S));
    assert.ok(cred(store).equals(L));
    assert.equal(signInObservedAt(wd), null);
  });

  it('an observation older than the grant file does not count', async () => {
    const store = mkDir('.claude-b', S);
    const wd = mkDir('wd', L);
    noteTokenless(wd);
    put(wd, L, signInObservedAt(wd) - 5_000);
    assert.equal((await refreshStore(account(store), wd)).relation, 'unrelated');
    assert.ok(cred(store).equals(S));
  });

  it('a lock skip judges nothing, consumes nothing and leaves the record; the retry adopts', async () => {
    const store = mkDir('.claude-b', S);
    const wd = mkDir('wd', S);
    observeDirGrant(wd, S);
    put(wd, L, Date.now());
    noteTokenless(wd);
    const before = fs.readFileSync(grantOriginPath(wd), 'utf8');
    const lock = path.join(store, '.credentials.json.lock');
    fs.mkdirSync(lock);
    fs.writeFileSync(
      path.join(lock, 'owner.json'),
      JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() })
    );
    const r = await refreshStore(account(store), wd);
    assert.deepEqual(r, { relation: null, wrote: false, deferred: true });
    assert.ok(signInObservedAt(wd) != null, 'the observation survives the skip');
    assert.equal(fs.readFileSync(grantOriginPath(wd), 'utf8'), before);
    assert.ok(cred(store).equals(S));
    fs.rmSync(lock, { recursive: true, force: true });
    const again = await refreshStore(account(store), wd);
    assert.equal(again.relation, 'continues');
    assert.ok(cred(store).equals(L));
  });

  it('trusted: the fresh-grant capture adopts with no record and no gap', async () => {
    const store = mkDir('.claude-b', S);
    const wd = mkDir('wd', L);
    const r = await refreshStore(account(store), wd, { trusted: true });
    assert.deepEqual([r.relation, r.wrote], ['continues', true]);
    assert.ok(cred(store).equals(L));
  });

  it('store repair: an unparseable store takes a live incoming grant', async () => {
    const store = mkDir('.claude-b', NOEXP);
    const wd = mkDir('wd', L);
    assert.equal((await refreshStore(account(store), wd)).relation, 'continues');
    assert.ok(cred(store).equals(L));
  });

  it('default dir: no record function writes into ~/.claude', () => {
    const def = path.join(home, '.claude');
    fs.mkdirSync(def, { recursive: true });
    observeDirGrant(def, S);
    recordExtWrite(def, S, { processReads: true });
    assert.ok(!fs.existsSync(grantOriginPath(def)));
    assert.equal(readDirRecord(def), null);
  });

  it('the record holds sha256 hashes, a source word and a time only', () => {
    const wd = mkDir('wd', S);
    observeDirGrant(wd, S);
    recordExtWrite(wd, L, { processReads: false });
    const raw = fs.readFileSync(grantOriginPath(wd), 'utf8');
    assert.ok(!raw.includes('rt-') && !raw.includes('at-'));
    const got = JSON.parse(raw);
    assert.deepEqual(Object.keys(got).sort(), ['at', 'by', 'h', 'held']);
    assert.ok(/^[0-9a-f]{64}$/.test(got.h) && /^[0-9a-f]{64}$/.test(got.held));
  });

  it('materialize guard: a forced bind leaves a live grant the store never held', () => {
    const store = mkDir('.claude-b', S);
    const wd = mkDir('wd', L);
    assert.equal(materialize(account(store), wd, true), false);
    assert.ok(cred(wd).equals(L));
  });

  it('materialize: a forced bind over a known copy writes, and moves h only', () => {
    const store = mkDir('.claude-b', S);
    recordGrantHistory(store, A);
    const wd = mkDir('wd', A);
    observeDirGrant(wd, A);
    assert.equal(materialize(account(store), wd, true), true);
    assert.ok(cred(wd).equals(S));
    assert.deepEqual([record(wd).h, record(wd).held, record(wd).by], [hash(S), hash(A), 'ext']);
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

  describe('R1-M6: the poller rotating a store token', () => {
    let realFetch;
    before(() => {
      realFetch = globalThis.fetch;
      let i = 0;
      globalThis.fetch = async (url) => {
        const body = String(url).includes('/oauth/token')
          ? JSON.stringify({
              access_token: `at-P${++i}`,
              refresh_token: `rt-P${i}`,
              expires_in: 28_800,
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

    it('records the displaced store grant, so a window copy of it restocks', async () => {
      __ageInProcessStateForTests(3_600_000);
      const stale = grant('rt-OLDP', T - MIN);
      const store = mkDir('.claude-b', stale);
      await fetchUsageCoordinated(
        { dir: store, email: 'm6a@example.com', isStore: true },
        { forceNetwork: true }
      );
      const now = cred(store);
      assert.ok(!now.equals(stale), 'the poller rotated the store token');
      assert.ok(readGrantHistory(store).includes(hash(stale)));
      assert.ok(readGrantHistory(store).includes(hash(now)));
      const wd = mkDir('wd', stale);
      const r = await refreshStore(account(store), wd);
      assert.equal(r.relation, 'known');
      assert.equal(healVerdict(r.relation, true, OLD_MTIME, Date.now()).verdict, 'restock');
    });

    it('records nothing for a window dir the poller refreshes', async () => {
      __ageInProcessStateForTests(3_600_000);
      const wd = mkDir('wd', grant('rt-OLDW', T - MIN));
      await fetchUsageCoordinated({ dir: wd, email: 'm6b@example.com' }, { forceNetwork: true });
      assert.ok(!cred(wd).equals(grant('rt-OLDW', T - MIN)), 'the poller rotated the window token');
      assert.ok(!fs.existsSync(grantHistoryPath(wd)));
    });
  });
});
