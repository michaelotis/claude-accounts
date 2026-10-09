const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

/**
 * workdir.ts imports vscode (via log/accounts) — bundle with the same minimal
 * vscode stub the other unit bundles use. The output channel keeps its lines so a
 * case can count what was logged.
 */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `self-heal-${process.pid}-`));
const vscodeStub = path.join(tmpRoot, 'vscode-stub.js');
fs.writeFileSync(
  vscodeStub,
  `globalThis.__logLines = globalThis.__logLines || [];
   module.exports = {
     window: {
       createOutputChannel: () => ({ appendLine(l) { globalThis.__logLines.push(l); }, show() {} }),
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
const workdir = bundle('../src/workdir.ts', 'workdir.bundle.cjs');
const {
  ANCHOR_WINDOW_MS,
  anchorOf,
  sameAnchor,
  relateToStore,
  healVerdict,
  healAtActivation,
  refreshStore,
  restockTokenOnly,
  materialize,
  readGrantChain,
  readGrantHistory,
  observeStoreGrant,
  foreignAnchorConflict,
  grantChainPath,
  grantHistoryPath,
  credentialFingerprint,
} = workdir;
const { fetchUsageCoordinated, __ageInProcessStateForTests } = bundle(
  '../src/usage.ts',
  'usage.bundle.cjs'
);

// Every fixture hangs off one clock read. Expiries sit just inside the 8 h token
// lifetime, so a grant is live for the whole run; refresh tokens rotate, so each
// refresh below is a new fingerprint. Family anchors sit 30 days out, an hour
// apart per family, like the 24-30 day lifetimes sign-ins mint.
const T = Date.now();
const SEC = 1_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const LIVE = T + 479 * MIN;
const F = (k) => T + 30 * 24 * HOUR + k * HOUR;
const W = ANCHOR_WINDOW_MS;
const grant = (rt, anchor, exp = LIVE) =>
  Buffer.from(
    JSON.stringify({
      claudeAiOauth: {
        accessToken: `at-${rt.slice(3)}`,
        refreshToken: rt,
        expiresAt: exp,
        ...(anchor == null ? {} : { refreshTokenExpiresAt: anchor }),
      },
    })
  );
const NOEXP = Buffer.from(
  JSON.stringify({ claudeAiOauth: { accessToken: 'at-N', refreshToken: 'rt-N' } })
);
const hash = (buf) => crypto.createHash('sha256').update(credentialFingerprint(buf)).digest('hex');
const chainOf = (current, displaced = [], hashes = []) => ({ current, displaced, hashes });
const OLD_MTIME = T - 10 * MIN;
const logged = (re) => globalThis.__logLines.filter((l) => re.test(l));

describe('anchorOf and sameAnchor', () => {
  it('reads refreshTokenExpiresAt and nothing else', () => {
    assert.equal(anchorOf(grant('rt-a', F(0))), F(0));
    assert.equal(anchorOf(grant('rt-a', null)), null);
    assert.equal(anchorOf(Buffer.from('not json')), null);
    assert.equal(
      anchorOf(Buffer.from(JSON.stringify({ claudeAiOauth: { refreshTokenExpiresAt: 'x' } }))),
      null
    );
  });

  it('the window is 10 minutes: W - 1 s apart is one family, W + 1 s apart is not', () => {
    assert.equal(W, 10 * MIN);
    assert.ok(sameAnchor(F(0), F(0) + W - SEC));
    assert.ok(sameAnchor(F(0), F(0) - W + SEC));
    assert.ok(!sameAnchor(F(0), F(0) + W + SEC));
    assert.ok(!sameAnchor(F(0), F(0) - W - SEC));
    assert.ok(!sameAnchor(null, F(0)) && !sameAnchor(F(0), null) && !sameAnchor(null, null));
  });
});

describe('relateToStore', () => {
  const S = grant('rt-S', F(0));

  it('same for the store grant itself', () => {
    assert.equal(relateToStore(S, S, chainOf(F(0), [], [hash(S)])), 'same');
  });

  it('a later family is a sign-in, an earlier one a fork, past the window either way', () => {
    const c = chainOf(F(0), [], [hash(S)]);
    assert.equal(relateToStore(grant('rt-L', F(0) + W + SEC), S, c), 'sign-in');
    assert.equal(relateToStore(grant('rt-L', F(0) + W - SEC, LIVE + MIN), S, c), 'continuation');
    assert.equal(relateToStore(grant('rt-K', F(0) - W - SEC), S, c), 'fork');
    assert.equal(relateToStore(grant('rt-K', F(0) - W + SEC, LIVE + MIN), S, c), 'continuation');
  });

  it('within the family: known by hash whatever its expiry, known when older, else a continuation', () => {
    const E = grant('rt-E', F(0), T - 10 * MIN);
    assert.equal(relateToStore(E, S, chainOf(F(0), [], [hash(E), hash(S)])), 'known');
    const A = grant('rt-A', F(0), LIVE + 30 * MIN);
    assert.equal(relateToStore(A, S, chainOf(F(0), [], [hash(A), hash(S)])), 'known');
    assert.equal(relateToStore(grant('rt-O', F(0), LIVE - MIN), S, chainOf(F(0))), 'known');
    assert.equal(relateToStore(grant('rt-N', F(0), LIVE + MIN), S, chainOf(F(0))), 'continuation');
  });

  it('a null anchor matches nothing: dir, store or both → legacy (M-6)', () => {
    assert.equal(relateToStore(grant('rt-x', null, LIVE + MIN), S, chainOf(F(0))), 'legacy');
    assert.equal(relateToStore(grant('rt-x', F(9)), grant('rt-S', null), chainOf(null)), 'legacy');
    assert.equal(
      relateToStore(grant('rt-x', null, LIVE + MIN), grant('rt-S', null), chainOf(null)),
      'legacy'
    );
    assert.equal(relateToStore(NOEXP, S, chainOf(F(0))), 'legacy', 'null expiry on the dir');
  });

  it('an unreadable store takes a grant with an anchor and an expiry, nothing else', () => {
    assert.equal(relateToStore(grant('rt-x', F(0)), NOEXP, chainOf(null)), 'sign-in');
    assert.equal(relateToStore(grant('rt-x', F(0)), Buffer.from('nope'), chainOf(null)), 'sign-in');
    assert.equal(relateToStore(grant('rt-x', null), Buffer.from('nope'), chainOf(null)), 'legacy');
  });

  it("a file behind its chain is behind for every grant of neither the file's family nor a later one", () => {
    const x = F(20);
    const sBack = grant('rt-Sb', F(0));
    const c = chainOf(x, [F(0)], []);
    assert.equal(relateToStore(grant('rt-L', x), sBack, c), 'behind');
    assert.equal(relateToStore(grant('rt-Sbw', F(0) + W + SEC, LIVE + MIN), sBack, c), 'behind');
    assert.equal(relateToStore(grant('rt-Lw', x + W - SEC, LIVE + MIN), sBack, c), 'behind');
    assert.equal(relateToStore(grant('rt-Lx', x + W + SEC), sBack, c), 'sign-in');
  });

  it('a file behind its chain judges its own family within itself: known by hash or when older, else a continuation', () => {
    const x = F(20);
    const sBack = grant('rt-Sb', F(0));
    const held = grant('rt-Sbh', F(0) + SEC, LIVE + MIN);
    const c = chainOf(x, [F(0)], [hash(held)]);
    assert.equal(relateToStore(held, sBack, c), 'known');
    assert.equal(relateToStore(grant('rt-Sbo', F(0) - SEC, LIVE - MIN), sBack, c), 'known');
    assert.equal(relateToStore(grant('rt-Sbn', F(0) + SEC), sBack, c), 'known');
    assert.equal(relateToStore(grant('rt-Sbb', F(0) + SEC, LIVE + MIN), sBack, c), 'continuation');
    assert.equal(
      relateToStore(grant('rt-Sbe', F(0) + W - SEC, LIVE + MIN), sBack, c),
      'continuation'
    );
  });

  it('behind boundary: a store file W - 1 s before current is not behind, W + 1 s before is', () => {
    const c = F(0);
    const older = grant('rt-Ob', c, LIVE - MIN);
    assert.equal(relateToStore(older, grant('rt-Sb1', c - W + SEC), chainOf(c)), 'known');
    assert.equal(relateToStore(older, grant('rt-Sb2', c - W - SEC), chainOf(c)), 'behind');
  });

  it('is pure: the same inputs judge the same way at any time', () => {
    const c = chainOf(F(0));
    const d = grant('rt-N', F(0), LIVE + MIN);
    assert.equal(relateToStore(d, S, c), relateToStore(d, S, c));
  });
});

describe('healVerdict', () => {
  const v = (relation, selfHeal = true, mtime = OLD_MTIME) =>
    healVerdict(relation, selfHeal, mtime, T);

  it('keeps same, legacy and unrelated; adopts a continuation or a sign-in', () => {
    assert.deepEqual(v('same'), { verdict: 'keep', reason: 'same' });
    assert.deepEqual(v('legacy'), { verdict: 'keep', reason: 'legacy' });
    assert.deepEqual(v('unrelated'), { verdict: 'keep', reason: 'unrelated' });
    assert.deepEqual(v('continuation'), { verdict: 'adopt', reason: 'continuation' });
    assert.deepEqual(v('sign-in'), { verdict: 'adopt', reason: 'sign-in' });
    assert.deepEqual(v(null), { verdict: 'keep', reason: 'unjudged' });
  });

  for (const rel of ['known', 'fork']) {
    it(`restocks ${rel}, except selfHeal off, an unreadable mtime, or inside the burst`, () => {
      assert.deepEqual(v(rel), { verdict: 'restock', reason: rel });
      assert.deepEqual(v(rel, false), { verdict: 'keep', reason: 'selfHeal-off' });
      assert.deepEqual(v(rel, true, null), { verdict: 'keep', reason: 'unreadable-mtime' });
      assert.deepEqual(v(rel, true, T - 3_000), { verdict: 'keep', reason: 'burst' });
      assert.deepEqual(v(rel, true, T - 10_000), { verdict: 'restock', reason: rel });
    });
  }
});

describe('refreshStore, the chain and the activation heal', () => {
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
  const mkDir = (prefix, token, email = 'b@example.com') => {
    const dir = path.join(home, `${prefix}${++n}`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(dir, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: email } }),
      { mode: 0o600 }
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
  const mtime = (dir) => fs.statSync(path.join(dir, '.credentials.json')).mtimeMs;
  const chainFile = (store) => JSON.parse(fs.readFileSync(grantChainPath(store), 'utf8'));
  // A store that has moved from family `from` to `to`, as a sign-in carried in leaves it.
  const signedInStore = (from, to) => {
    const store = mkDir('.claude-b', from);
    observeStoreGrant(store, from);
    put(store, to);
    observeStoreGrant(store, to);
    return store;
  };
  // Another account's store, removed by the case that made it so no later case sees it.
  const foreignStore = (token, chain) => {
    const dir = mkDir('.claude-x', token, 'x@example.com');
    if (chain) fs.writeFileSync(grantChainPath(dir), JSON.stringify({ v: 2, ...chain }));
    return dir;
  };
  const drop = (dir) => fs.rmSync(dir, { recursive: true, force: true });

  it('M-1: a fork never reaches the store, B is restocked, A is never written', async () => {
    const s = F(0);
    const x = F(5);
    const S1 = grant('rt-S1', s);
    const L1 = grant('rt-L1', x, LIVE - 60 * MIN);
    const L2 = grant('rt-L2', x + SEC, LIVE - 50 * MIN);
    const store = mkDir('.claude-b', S1);
    const acct = account(store);
    const wa = mkDir('wd', S1);
    const wb = mkDir('wd', S1);
    let aHas = S1;
    const invariants = () => {
      assert.ok(cred(wa).equals(aHas), "A's file is only ever what its process wrote");
      for (const fork of forks) assert.ok(!cred(store).equals(fork), 'the store never holds S′');
    };
    const forks = [];

    // 0: both activated on S.
    healAtActivation(acct, wa, { selfHeal: true });
    healAtActivation(acct, wb, { selfHeal: true });
    assert.equal((await refreshStore(acct, wa)).relation, 'same');
    assert.equal(readGrantChain(store).current, s);
    invariants();

    // 1: A signs in.
    put(wa, L1);
    aHas = L1;
    const r1 = await refreshStore(acct, wa);
    assert.deepEqual([r1.relation, r1.wrote], ['sign-in', true]);
    assert.ok(cred(store).equals(L1));
    assert.deepEqual(chainFile(store).displaced, [s]);
    invariants();

    // 2: B still holds S, a family the sign-in replaced.
    const r2 = await refreshStore(acct, wb);
    assert.equal(r2.relation, 'fork');
    assert.deepEqual(healVerdict(r2.relation, true, mtime(wb), Date.now()), {
      verdict: 'restock',
      reason: 'fork',
    });
    assert.ok(restockTokenOnly(cred(store), wb, S1));
    assert.ok(cred(wb).equals(L1));
    invariants();

    // 3: B's process refreshes the S it holds in memory, drifting a few seconds.
    for (const drift of [3 * SEC, -3 * SEC]) {
      const S2 = grant(`rt-S2${drift}`, s + drift, LIVE + 60 * MIN);
      forks.push(S2);
      put(wb, S2);
      const r3 = await refreshStore(acct, wb);
      assert.deepEqual([r3.relation, r3.wrote], ['fork', false]);
      assert.ok(cred(store).equals(L1));
      assert.equal(healVerdict(r3.relation, true, mtime(wb), Date.now()).verdict, 'restock');
      assert.ok(restockTokenOnly(cred(store), wb, S2));
      assert.ok(cred(wb).equals(L1));
      invariants();
    }

    // 4: A's process refreshes L.
    put(wa, L2);
    aHas = L2;
    const r4 = await refreshStore(acct, wa);
    assert.deepEqual([r4.relation, r4.wrote], ['continuation', true]);
    assert.ok(cred(store).equals(L2));
    assert.equal(readGrantChain(store).current, x);
    invariants();

    // 5: B, restocked on L, now holds a copy the store has moved past; then same.
    const r5 = await refreshStore(acct, wb);
    assert.equal(r5.relation, 'known');
    assert.ok(restockTokenOnly(cred(store), wb, L1));
    assert.equal((await refreshStore(acct, wb)).relation, 'same');
    invariants();
  });

  it('dead-lineage drift: a refresh of a displaced family ±3 s is a fork, store unchanged', async () => {
    const s = F(0);
    const L = grant('rt-Ld', F(5));
    const store = signedInStore(grant('rt-Sd', s), L);
    for (const drift of [3 * SEC, -3 * SEC]) {
      const wd = mkDir('wd', grant(`rt-Sd${drift}`, s + drift, LIVE + HOUR));
      const r = await refreshStore(account(store), wd);
      assert.deepEqual([r.relation, r.wrote], ['fork', false]);
      assert.ok(cred(store).equals(L));
    }
  });

  it('N2: a terminal on a displaced family is restocked at activation and after each fork', async () => {
    const s = F(0);
    const L = grant('rt-Ln2', F(5));
    const store = signedInStore(grant('rt-Sn2', s), L);
    const wb = mkDir('wd', grant('rt-Sn2', s));
    healAtActivation(account(store), wb, { selfHeal: true });
    assert.ok(cred(wb).equals(L), 'restocked at activation');
    const S2 = grant('rt-Sn2b', s + SEC, LIVE + HOUR);
    put(wb, S2);
    assert.equal((await refreshStore(account(store), wb)).relation, 'fork');
    healAtActivation(account(store), wb, { selfHeal: true });
    assert.ok(cred(wb).equals(L), 'restocked again');
    assert.ok(cred(store).equals(L));
  });

  it('exit flush: a later refresh of the current family is left at activation, then adopted', async () => {
    const S1 = grant('rt-Sx', F(0));
    const store = mkDir('.claude-b', S1);
    observeStoreGrant(store, S1);
    const later = grant('rt-Sx2', F(0) + SEC, LIVE + HOUR);
    const wd = mkDir('wd', later);
    healAtActivation(account(store), wd, { selfHeal: true });
    assert.ok(cred(wd).equals(later), 'not restocked at activation');
    assert.equal(materialize(account(store), wd, true), false, 'the forced stock leaves it');
    assert.ok(cred(wd).equals(later));
    const r = await refreshStore(account(store), wd);
    assert.deepEqual([r.relation, r.wrote], ['continuation', true]);
    assert.ok(cred(store).equals(later));
  });

  it('two sign-ins: each adoption moves current, and the first window then holds a fork', async () => {
    const s = F(0);
    const S = grant('rt-S2s', s);
    const L1 = grant('rt-L1s', F(3));
    const L2 = grant('rt-L2s', F(6));
    const store = mkDir('.claude-b', S);
    const wa = mkDir('wd', L1);
    const wb = mkDir('wd', L2);
    assert.equal((await refreshStore(account(store), wa)).relation, 'sign-in');
    assert.deepEqual(readGrantChain(store).current, F(3));
    assert.equal((await refreshStore(account(store), wb)).relation, 'sign-in');
    assert.deepEqual([chainFile(store).current, chainFile(store).displaced], [F(6), [s, F(3)]]);
    assert.ok(cred(store).equals(L2));
    assert.equal((await refreshStore(account(store), wa)).relation, 'fork');
    assert.ok(cred(store).equals(L2));
  });

  it('upgrade day, no chain: an earlier unknown family is a fork, restocked after the burst', async () => {
    const s = F(10);
    const S = grant('rt-Su', s);
    const store = mkDir('.claude-b', S);
    const early = grant('rt-Eu', F(5), LIVE + HOUR);
    const wd = mkDir('wd');
    put(wd, early, Date.now());
    const r = await refreshStore(account(store), wd);
    assert.equal(r.relation, 'fork');
    assert.ok(cred(store).equals(S));
    assert.equal(healVerdict(r.relation, true, mtime(wd), Date.now()).reason, 'burst');
    fs.utimesSync(path.join(wd, '.credentials.json'), OLD_MTIME / 1000, OLD_MTIME / 1000);
    assert.equal(healVerdict(r.relation, true, mtime(wd), Date.now()).verdict, 'restock');
    assert.ok(restockTokenOnly(cred(store), wd, early));
    assert.ok(cred(wd).equals(S));
  });

  it('upgrade day, no chain: a later unknown family written 5 s ago is adopted', async () => {
    const s = F(10);
    const store = mkDir('.claude-b', grant('rt-Su2', s));
    assert.ok(!fs.existsSync(grantChainPath(store)));
    const later = grant('rt-Lu2', F(15), LIVE - HOUR);
    const wd = mkDir('wd');
    put(wd, later, Date.now() - 5 * SEC);
    const r = await refreshStore(account(store), wd);
    assert.deepEqual([r.relation, r.wrote], ['sign-in', true]);
    assert.ok(cred(store).equals(later));
    assert.deepEqual([chainFile(store).current, chainFile(store).displaced], [F(15), [s]]);
  });

  it('legacy array: its hashes are read and current is null until the first pass', async () => {
    const S = grant('rt-Sl', F(0));
    const store = mkDir('.claude-b', S);
    const old = grant('rt-Ol', F(0), T - HOUR);
    fs.writeFileSync(grantHistoryPath(store), JSON.stringify([hash(old), hash(S)]));
    assert.deepEqual(readGrantChain(store), {
      current: null,
      displaced: [],
      hashes: [hash(old), hash(S)],
    });
    assert.deepEqual(readGrantHistory(store), [hash(old), hash(S)]);
    const wd = mkDir('wd', old);
    assert.equal((await refreshStore(account(store), wd)).relation, 'known');
    assert.equal(readGrantChain(store).current, F(0));
  });

  it('an old writer cannot erase the chain: an r1 array beside it leaves current intact', () => {
    const S = grant('rt-So', F(0));
    const store = mkDir('.claude-b', S);
    observeStoreGrant(store, S);
    const other = 'e'.repeat(64);
    fs.writeFileSync(grantHistoryPath(store), JSON.stringify([other]));
    const c = readGrantChain(store);
    assert.equal(c.current, F(0));
    assert.deepEqual(c.hashes, [hash(S), other]);
  });

  // A store whose chain moved to family x (L1, then L2) and whose file an
  // old-version window wrote back to S1, 20 h before x.
  const behindStore = (tag) => {
    const x = F(20);
    const L1 = grant(`rt-L${tag}1`, x, LIVE - HOUR);
    const L2 = grant(`rt-L${tag}2`, x, LIVE);
    const store = signedInStore(L1, L2);
    const S1 = grant(`rt-S${tag}1`, x - 20 * HOUR);
    put(store, S1);
    return { x, L1, L2, S1, store };
  };

  it("behind: current never moves back, and no grant of the chain's family is adopted or restocked", async () => {
    const { x, L1, L2, S1, store } = behindStore('r');
    assert.deepEqual(chainFile(store), {
      v: 2,
      current: x,
      displaced: [],
      hashes: [hash(L1), hash(L2)],
    });
    const before = logged(/moved back to an earlier family/).length;
    observeStoreGrant(store, S1);
    observeStoreGrant(store, S1);
    assert.equal(readGrantChain(store).current, x);
    assert.equal(logged(/moved back to an earlier family/).length, before + 1, 'logged once');

    const keptLog =
      /b@example\.com: store file is behind its chain — kept both; a sign-in restores it/;
    const guardLog = new RegExp(
      `store file of ${path.basename(store)} is behind its chain — left in place`
    );
    const seen = logged(keptLog).length;
    const guarded = logged(guardLog).length;
    for (const tok of [L1, L2, L1]) {
      const wd = mkDir('wd', tok);
      const r = await refreshStore(account(store), wd);
      assert.deepEqual([r.relation, r.wrote], ['behind', false]);
      assert.ok(cred(store).equals(S1), 'the store is not moved');
      assert.deepEqual(healVerdict(r.relation, true, OLD_MTIME, Date.now()), {
        verdict: 'keep',
        reason: 'behind',
      });
      assert.equal(materialize(account(store), wd, true), false, 'the forced stock leaves it');
      healAtActivation(account(store), wd, { selfHeal: true });
      assert.ok(cred(wd).equals(tok), 'never restocked from the file behind the chain');
    }
    assert.equal(logged(keptLog).length, seen + 1, 'logged once per store and anchor');
    assert.equal(logged(guardLog).length, guarded + 3, 'the forced stock names behind');
    const S0 = grant('rt-Sr0', x - 30 * HOUR); // another write-back, another family
    put(store, S0);
    await refreshStore(account(store), mkDir('wd', L2));
    assert.equal(logged(keptLog).length, seen + 2, 'a different anchor logs again');
    assert.equal(readGrantChain(store).current, x);

    const L3 = grant('rt-Lr3', x + 20 * HOUR);
    const r3 = await refreshStore(account(store), mkDir('wd', L3));
    assert.deepEqual([r3.relation, r3.wrote], ['sign-in', true]);
    assert.ok(cred(store).equals(L3));
    assert.equal(readGrantChain(store).current, x + 20 * HOUR);
    assert.equal(logged(/restored store/).length, 0);
  });

  it("behind: a consumed copy of the file's own family is known and restocked from the file", async () => {
    const { x, store } = behindStore('k');
    // The poller rotated the file from S0 to S1: S0's hash is in the chain.
    const s = x - 20 * HOUR;
    const S0 = grant('rt-Sk0', s, LIVE + HOUR);
    put(store, S0);
    observeStoreGrant(store, S0);
    const S1 = grant('rt-Sk1', s);
    put(store, S1);
    observeStoreGrant(store, S1);
    assert.equal(readGrantChain(store).current, x);
    const older = grant('rt-Sko', s + SEC, LIVE - HOUR); // unknown hash, earlier expiry
    for (const tok of [S0, older]) {
      const wd = mkDir('wd', tok);
      put(wd, tok, Date.now());
      const r = await refreshStore(account(store), wd);
      assert.deepEqual([r.relation, r.wrote], ['known', false]);
      assert.ok(cred(store).equals(S1));
      assert.equal(healVerdict(r.relation, true, mtime(wd), Date.now()).reason, 'burst');
      assert.deepEqual(healVerdict(r.relation, true, OLD_MTIME, Date.now()), {
        verdict: 'restock',
        reason: 'known',
      });
      const wa = mkDir('wd', tok);
      healAtActivation(account(store), wa, { selfHeal: true });
      assert.ok(cred(wa).equals(S1), 'restocked at activation');
      const wm = mkDir('wd', tok);
      assert.equal(materialize(account(store), wm, true), true, 'the forced stock overwrites');
      assert.ok(cred(wm).equals(S1));
    }
    assert.equal(readGrantChain(store).current, x);
  });

  it("behind: a later refresh of the file's own family is carried in, and current stays", async () => {
    const { x, L1, L2, S1, store } = behindStore('c');
    observeStoreGrant(store, S1);
    const regressions = /moved back to an earlier family/;
    const S2 = grant('rt-Sc2', x - 20 * HOUR + SEC, LIVE + HOUR); // a refresh of S1
    const wd = mkDir('wd', S2);
    const r = await refreshStore(account(store), wd);
    assert.deepEqual([r.relation, r.wrote], ['continuation', true]);
    assert.ok(cred(store).equals(S2));
    assert.equal(readGrantChain(store).current, x, 'the backward move is not recorded');
    const seen = logged(regressions).length;
    const again = await refreshStore(account(store), wd);
    assert.deepEqual([again.relation, again.wrote], ['same', false]);
    assert.equal(logged(regressions).length, seen, 'no regression line repeats');
    assert.equal(readGrantChain(store).current, x);
    for (const tok of [L1, L2]) {
      const r2 = await refreshStore(account(store), mkDir('wd', tok));
      assert.deepEqual([r2.relation, r2.wrote], ['behind', false]);
    }
    const L3 = grant('rt-Lc3', x + 20 * HOUR);
    const r3 = await refreshStore(account(store), mkDir('wd', L3));
    assert.deepEqual([r3.relation, r3.wrote], ['sign-in', true]);
  });

  it('negative live drift: a store file 3 s before current is not behind', async () => {
    const c = F(1);
    const C = grant('rt-Cnd', c, LIVE - HOUR);
    const store = mkDir('.claude-b', C);
    observeStoreGrant(store, C);
    const D = grant('rt-Dnd', c - 3 * SEC, LIVE); // an adopted continuation, drifted
    put(store, D);
    observeStoreGrant(store, D);
    assert.equal(readGrantChain(store).current, c);
    const wd = mkDir('wd', C);
    const r = await refreshStore(account(store), wd);
    assert.deepEqual([r.relation, r.wrote], ['known', false]);
    healAtActivation(account(store), wd, { selfHeal: true });
    assert.ok(cred(wd).equals(D), 'the older copy is restocked');
    const E = grant('rt-End', c - 3 * SEC, LIVE + HOUR);
    put(wd, E);
    const r2 = await refreshStore(account(store), wd);
    assert.deepEqual([r2.relation, r2.wrote], ['continuation', true]);
    assert.ok(cred(store).equals(E));
  });

  // The owner's store holds either the very grant the contaminated store holds,
  // or a later refresh of it (the poller rotated the owner past the copy): the
  // bytes differ, the family does not.
  for (const [label, ownerTok] of [
    ['the same grant', (y) => grant('rt-Yg', y)],
    ['a later refresh of it', (y) => grant('rt-Yg1', y, LIVE + MIN)],
  ]) {
    it(`chain feed gated: a store holding another account's grant records none of it (owner holds ${label})`, async () => {
      const y = F(500);
      const Yg = grant('rt-Yg', y);
      const Yo = ownerTok(y);
      const other = foreignStore(Yo);
      const yAcct = { name: path.basename(other), dir: other, email: 'x@example.com' };
      try {
        observeStoreGrant(other, Yo);
        const store = mkDir('.claude-b', Yg);
        const wd = mkDir('wd', Yg);
        const refused = new RegExp(
          `store of ${path.basename(store)} holds another account's grant — not recorded in its chain`
        );
        await refreshStore(account(store), wd);
        await refreshStore(account(store), wd);
        assert.deepEqual(readGrantChain(store), { current: null, displaced: [], hashes: [] });
        assert.equal(logged(refused).length, 1, 'logged once');

        const Xl = grant('rt-Xl', F(510));
        put(wd, Xl);
        const r = await refreshStore(account(store), wd);
        assert.deepEqual([r.relation, r.wrote], ['sign-in', true]);
        assert.deepEqual(chainFile(store), {
          v: 2,
          current: F(510),
          displaced: [],
          hashes: [hash(Xl)],
        });
        assert.equal(foreignAnchorConflict(other, y, 'x@example.com'), null);

        const Yc = grant('rt-Yc', y + SEC, LIVE + HOUR);
        const wy = mkDir('wd', Yc, 'x@example.com');
        const ry = await refreshStore(yAcct, wy);
        assert.deepEqual([ry.relation, ry.wrote], ['continuation', true]);
        assert.ok(cred(other).equals(Yc));
      } finally {
        drop(other);
      }
    });
  }

  it('terminal login into the store: the previous family is displaced and its copies are forks', async () => {
    const s = F(0);
    const S = grant('rt-St', s);
    const store = mkDir('.claude-b', S);
    const wd = mkDir('wd', S);
    assert.equal((await refreshStore(account(store), wd)).relation, 'same');
    const L = grant('rt-Lt', F(4));
    put(store, L);
    const r = await refreshStore(account(store), wd);
    assert.equal(r.relation, 'fork');
    assert.deepEqual([chainFile(store).current, chainFile(store).displaced], [F(4), [s]]);
    assert.ok(cred(store).equals(L));
  });

  it('null anchor: legacy on the dir, the store or both — no adopt, no restock', async () => {
    const cases = [
      [grant('rt-Sn', F(0)), grant('rt-Dn', null, LIVE + HOUR)],
      [grant('rt-Sn2', null), grant('rt-Dn2', F(5), LIVE + HOUR)],
      [grant('rt-Sn3', null), grant('rt-Dn3', null, LIVE + HOUR)],
    ];
    for (const [storeTok, dirTok] of cases) {
      const store = mkDir('.claude-b', storeTok);
      const wd = mkDir('wd', dirTok);
      const r = await refreshStore(account(store), wd);
      assert.deepEqual([r.relation, r.wrote], ['legacy', false]);
      healAtActivation(account(store), wd, { selfHeal: true });
      assert.ok(cred(store).equals(storeTok));
      assert.ok(cred(wd).equals(dirTok));
    }
    assert.equal(foreignAnchorConflict(home, null, 'b@example.com'), null);
  });

  it('known regardless of expiry, and an older refresh of the family, are restocked at activation', async () => {
    const S = grant('rt-Sk', F(0));
    const E = grant('rt-Ek', F(0), T - 10 * MIN);
    const store = mkDir('.claude-b', E);
    observeStoreGrant(store, E);
    put(store, S);
    const wd = mkDir('wd', E);
    assert.equal((await refreshStore(account(store), wd)).relation, 'known');
    healAtActivation(account(store), wd, { selfHeal: true });
    assert.ok(cred(wd).equals(S));

    const older = grant('rt-Ok', F(0), LIVE - HOUR);
    const wd2 = mkDir('wd', older);
    assert.equal((await refreshStore(account(store), wd2)).relation, 'known');
    assert.ok(cred(store).equals(S));
    healAtActivation(account(store), wd2, { selfHeal: false });
    assert.ok(cred(wd2).equals(older), 'selfHeal off leaves it');
    healAtActivation(account(store), wd2, { selfHeal: true });
    assert.ok(cred(wd2).equals(S));
  });

  it('store repair: an unparseable store takes a grant with an anchor and an expiry', async () => {
    const store = mkDir('.claude-b', NOEXP);
    const L = grant('rt-Lp', F(0));
    const wd = mkDir('wd', L);
    const r = await refreshStore(account(store), wd);
    assert.deepEqual([r.relation, r.wrote], ['sign-in', true]);
    assert.ok(cred(store).equals(L));
  });

  it("adopts the store grant's own in-place refresh with a later expiry", async () => {
    const store = mkDir('.claude-b', grant('rt-Si', F(0)));
    const refreshed = Buffer.from(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'at-Si2',
          refreshToken: 'rt-Si',
          expiresAt: LIVE + MIN,
          refreshTokenExpiresAt: F(0),
        },
      })
    );
    const wd = mkDir('wd', refreshed);
    const r = await refreshStore(account(store), wd);
    assert.deepEqual([r.relation, r.wrote], ['same', true]);
    assert.ok(cred(store).equals(refreshed));
  });

  it('P1-M6: activation does not restock a store grant another email also holds', () => {
    const S = grant('rt-Sm6', F(0));
    const old = grant('rt-Om6', F(0), LIVE - HOUR);
    const store = mkDir('.claude-b', old);
    observeStoreGrant(store, old);
    put(store, S);
    // Same refresh token, no anchor: only the hash tripwire can see it.
    const x = foreignStore(grant('rt-Sm6', null));
    try {
      const wd = mkDir('wd', old);
      healAtActivation(account(store), wd, { selfHeal: true });
      assert.ok(cred(wd).equals(old));
    } finally {
      drop(x);
    }
  });

  it("anchor tripwire inbound: a family in another email's chain or file is refused", async () => {
    const s = F(0);
    const mine = grant('rt-Sti', s);
    const theirs = F(40);
    const shapes = [
      [grant('rt-Xc', F(41)), { current: theirs, displaced: [], hashes: [] }],
      [grant('rt-Xd', F(41)), { current: F(42), displaced: [theirs], hashes: [] }],
      [grant('rt-Xf', theirs + SEC), null],
    ];
    for (const [xTok, chain] of shapes) {
      const x = foreignStore(xTok, chain);
      try {
        const store = mkDir('.claude-b', mine);
        const wd = mkDir('wd', grant('rt-Win', theirs + 2 * SEC));
        const r = await refreshStore(account(store), wd);
        assert.deepEqual([r.relation, r.wrote], ['unrelated', false]);
        assert.ok(cred(store).equals(mine));
      } finally {
        drop(x);
      }
    }
    const store = mkDir('.claude-b', mine);
    const wd = mkDir('wd', grant('rt-Win', theirs + 2 * SEC));
    assert.equal((await refreshStore(account(store), wd)).relation, 'sign-in', 'adopted alone');
  });

  it("anchor tripwire outbound: activation does not restock a store family another email's chain knows", () => {
    const S = grant('rt-Sto', F(50));
    const old = grant('rt-Oto', F(50), LIVE - HOUR);
    const store = mkDir('.claude-b', old);
    observeStoreGrant(store, old);
    put(store, S);
    const x = foreignStore(grant('rt-Xo', F(52)), {
      current: F(52),
      displaced: [F(50)],
      hashes: [],
    });
    try {
      const wd = mkDir('wd', old);
      healAtActivation(account(store), wd, { selfHeal: true });
      assert.ok(cred(wd).equals(old));
    } finally {
      drop(x);
    }
    const wd = mkDir('wd', old);
    healAtActivation(account(store), wd, { selfHeal: true });
    assert.ok(cred(wd).equals(S), 'restocked once the other store is gone');
  });

  it('byte-equal: observes the store grant once and returns same; a second pass rewrites nothing', async () => {
    const S = grant('rt-Sb', F(0));
    const store = mkDir('.claude-b', S);
    const wd = mkDir('wd', S);
    const r = await refreshStore(account(store), wd);
    assert.deepEqual(r, { relation: 'same', wrote: false, deferred: false });
    assert.deepEqual(chainFile(store), { v: 2, current: F(0), displaced: [], hashes: [hash(S)] });
    fs.utimesSync(grantChainPath(store), OLD_MTIME / 1000, OLD_MTIME / 1000);
    const pinned = fs.statSync(grantChainPath(store)).mtimeMs;
    await refreshStore(account(store), wd);
    assert.equal(fs.statSync(grantChainPath(store)).mtimeMs, pinned);
    assert.ok(!fs.existsSync(path.join(wd, '.grant-chain.json')), 'no chain in a window dir');
  });

  it('a lock skip judges nothing and writes nothing; the retry adopts', async () => {
    const store = mkDir('.claude-b', grant('rt-Sls', F(0)));
    const L = grant('rt-Lls', F(5));
    const wd = mkDir('wd', L);
    const lock = path.join(store, '.credentials.json.lock');
    fs.mkdirSync(lock);
    fs.writeFileSync(
      path.join(lock, 'owner.json'),
      JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() })
    );
    const r = await refreshStore(account(store), wd);
    assert.deepEqual(r, { relation: null, wrote: false, deferred: true });
    assert.ok(!fs.existsSync(grantChainPath(store)), 'no chain written');
    assert.ok(cred(store).equals(grant('rt-Sls', F(0))));
    fs.rmSync(lock, { recursive: true, force: true });
    const again = await refreshStore(account(store), wd);
    assert.equal(again.relation, 'sign-in');
    assert.ok(cred(store).equals(L));
  });

  it('trusted is gone: an options argument adopts nothing more than none', async () => {
    const s = F(0);
    const store = signedInStore(grant('rt-Str', s), grant('rt-Ltr', F(5)));
    const wd = mkDir('wd', grant('rt-Ftr', s + SEC, LIVE + HOUR));
    const r = await refreshStore(account(store), wd, { trusted: true });
    assert.deepEqual([r.relation, r.wrote], ['fork', false]);
    assert.ok(cred(store).equals(grant('rt-Ltr', F(5))));
  });

  it('the chain holds sha256 hashes and millisecond anchors only, mode 0o600', () => {
    const store = mkDir('.claude-b', grant('rt-Sc', F(0)));
    observeStoreGrant(store, grant('rt-Sc', F(0)));
    observeStoreGrant(store, grant('rt-Lc', F(3)));
    const raw = fs.readFileSync(grantChainPath(store), 'utf8');
    assert.ok(!raw.includes('rt-') && !raw.includes('at-'));
    const got = JSON.parse(raw);
    assert.deepEqual(Object.keys(got).sort(), ['current', 'displaced', 'hashes', 'v']);
    assert.ok(got.hashes.every((h) => /^[0-9a-f]{64}$/.test(h)));
    assert.ok([got.current, ...got.displaced].every((a) => Number.isInteger(a)));
    assert.equal(fs.statSync(grantChainPath(store)).mode & 0o777, 0o600);
  });

  it('caps: 4100 hashes keep the newest 4096; 300 forward moves keep 256 displaced', () => {
    const store = mkDir('.claude-b', grant('rt-Scap', F(0)));
    const seeded = Array.from({ length: 4099 }, (_, i) =>
      crypto.createHash('sha256').update(`seed-${i}`).digest('hex')
    );
    fs.writeFileSync(
      grantChainPath(store),
      JSON.stringify({ v: 2, current: null, displaced: [], hashes: seeded })
    );
    const last = grant('rt-Last', null);
    observeStoreGrant(store, last);
    const got = chainFile(store);
    assert.equal(got.hashes.length, 4096);
    assert.deepEqual(got.hashes, [...seeded, hash(last)].slice(-4096));
    assert.equal(fs.statSync(grantChainPath(store)).mode & 0o777, 0o600);

    const store2 = mkDir('.claude-b', grant('rt-Scap2', F(0)));
    for (let k = 0; k <= 300; k++) observeStoreGrant(store2, grant(`rt-m${k}`, F(k)));
    const c = chainFile(store2);
    assert.equal(c.current, F(300));
    assert.equal(c.displaced.length, 256);
    assert.deepEqual(
      c.displaced,
      Array.from({ length: 256 }, (_, i) => F(300 - 256 + i))
    );
  });

  it('the r1 alias is gone: the bundle exports no recordGrantHistory', () => {
    assert.equal('recordGrantHistory' in workdir, false);
  });

  it('reads a missing or unparseable chain as empty', () => {
    const store = mkDir('.claude-b', grant('rt-Se', F(0)));
    assert.deepEqual(readGrantChain(store), { current: null, displaced: [], hashes: [] });
    fs.writeFileSync(grantChainPath(store), '{not json');
    fs.writeFileSync(grantHistoryPath(store), '{not json');
    assert.deepEqual(readGrantChain(store), { current: null, displaced: [], hashes: [] });
  });

  it('materialize guard: a forced bind leaves a later family the store never replaced', () => {
    const store = mkDir('.claude-b', grant('rt-Sg', F(0)));
    const L = grant('rt-Lg', F(5));
    const wd = mkDir('wd', L);
    assert.equal(materialize(account(store), wd, true), false);
    assert.ok(cred(wd).equals(L));
  });

  it('P1-C2: the guard leaves an expired later-family grant and overwrites a known expired copy', () => {
    const S = grant('rt-Sc2', F(0));
    const store = mkDir('.claude-b', S);
    const expiredLater = grant('rt-Lc2', F(5), T - HOUR);
    const wd = mkDir('wd', expiredLater);
    assert.equal(materialize(account(store), wd, true), false);
    assert.ok(cred(wd).equals(expiredLater));

    const E = grant('rt-Ec2', F(0), T - HOUR);
    observeStoreGrant(store, E);
    const wd2 = mkDir('wd', E);
    assert.equal(materialize(account(store), wd2, true), true);
    assert.ok(cred(wd2).equals(S));
  });

  it('materialize: a forced bind over a fork writes', () => {
    const L = grant('rt-Lmf', F(5));
    const store = signedInStore(grant('rt-Smf', F(0)), L);
    const wd = mkDir('wd', grant('rt-Fmf', F(0) + SEC, LIVE + HOUR));
    assert.equal(materialize(account(store), wd, true), true);
    assert.ok(cred(wd).equals(L));
  });

  describe('the poller rotating a store token', () => {
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

    const rotate = async (store, email) => {
      __ageInProcessStateForTests(3_600_000);
      await fetchUsageCoordinated({ dir: store, email, isStore: true }, { forceNetwork: true });
    };

    it('keeps the anchor byte-equal and records the displaced grant, so a window copy restocks', async () => {
      const c = F(0);
      const stale = grant('rt-OLDP', c, T - MIN);
      const store = mkDir('.claude-b', stale);
      await rotate(store, 'm6a@example.com');
      const now = cred(store);
      assert.ok(!now.equals(stale), 'the poller rotated the store token');
      assert.match(
        now.toString(),
        new RegExp(`"refreshTokenExpiresAt": ?${c}[,\\s}]`),
        'anchor byte-equal'
      );
      assert.equal(anchorOf(now), c);
      const chain = readGrantChain(store);
      assert.ok(chain.hashes.includes(hash(stale)) && chain.hashes.includes(hash(now)));
      assert.deepEqual([chain.current, chain.displaced], [c, []]);
      const wd = mkDir('wd', stale);
      const r = await refreshStore(account(store), wd);
      assert.equal(r.relation, 'known');
      assert.equal(healVerdict(r.relation, true, OLD_MTIME, Date.now()).verdict, 'restock');
    });

    it('poller drift: a Claude Code refresh moving the anchor 3 s displaces nothing', async () => {
      const c = F(1);
      const stale = grant('rt-OLDD', c, T - MIN);
      const store = mkDir('.claude-b', stale);
      await rotate(store, 'm6c@example.com');
      const drifted = grant('rt-CCd', c + 3 * SEC, LIVE + HOUR);
      put(store, drifted);
      observeStoreGrant(store, drifted);
      assert.deepEqual([chainFile(store).current, chainFile(store).displaced], [c, []]);
      const wd = mkDir('wd', stale);
      assert.equal((await refreshStore(account(store), wd)).relation, 'known');
      const next = grant('rt-CCd2', c + 3 * SEC, LIVE + 2 * HOUR);
      const wd2 = mkDir('wd', next);
      const r = await refreshStore(account(store), wd2);
      assert.deepEqual([r.relation, r.wrote], ['continuation', true]);
      assert.ok(cred(store).equals(next));
    });

    it('N1: a window restocked after the rotation continues the store on its next refresh', async () => {
      const c = F(2);
      const C = grant('rt-OLDN', c, T - MIN);
      const store = mkDir('.claude-b', C);
      const wb = mkDir('wd', C);
      await rotate(store, 'm6d@example.com');
      const r = await refreshStore(account(store), wb);
      assert.equal(r.relation, 'known');
      assert.ok(restockTokenOnly(cred(store), wb, C));
      const C2b = grant('rt-C2b', c, T + 600 * MIN);
      put(wb, C2b);
      const r2 = await refreshStore(account(store), wb);
      assert.deepEqual([r2.relation, r2.wrote], ['continuation', true]);
      assert.ok(cred(store).equals(C2b));
    });

    it('writes no chain into a window dir the poller refreshes', async () => {
      __ageInProcessStateForTests(3_600_000);
      const wd = mkDir('wd', grant('rt-OLDW', F(3), T - MIN));
      await fetchUsageCoordinated({ dir: wd, email: 'm6b@example.com' }, { forceNetwork: true });
      assert.ok(!cred(wd).equals(grant('rt-OLDW', F(3), T - MIN)), 'the poller rotated it');
      assert.ok(!fs.existsSync(grantChainPath(wd)));
      assert.ok(!fs.existsSync(grantHistoryPath(wd)));
    });
  });
});
