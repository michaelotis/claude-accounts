const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

/**
 * setupWizard.ts imports vscode — bundle with the stub the other suites use. The
 * stub's output channel keeps every log line so a test can read the verdict a
 * pass logged, and executeCommand keeps every command so a test can see a
 * reload. One entry re-exports the wizard and workdir so they share one module
 * instance.
 */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `reconcile-heal-${process.pid}-`));
const vscodeStub = path.join(tmpRoot, 'vscode-stub.js');
fs.writeFileSync(
  vscodeStub,
  `module.exports = {
     window: {
       createOutputChannel: () => ({
         appendLine(l) { (globalThis.__healLog ??= []).push(l); },
         show() {},
       }),
       showWarningMessage: () => Promise.resolve(undefined),
       showInformationMessage: () => Promise.resolve(undefined),
       showErrorMessage: () => Promise.resolve(undefined),
       withProgress: (_opts, fn) => fn(),
     },
     ProgressLocation: { Notification: 15 },
     commands: {
       executeCommand: (c) => {
         (globalThis.__commands ??= []).push(c);
         return Promise.resolve(undefined);
       },
     },
   };`
);
const entry = path.join(tmpRoot, 'entry.ts');
const src = (f) => JSON.stringify(path.join(__dirname, '..', 'src', f));
fs.writeFileSync(
  entry,
  `export { SetupWizard } from ${src('setupWizard')};
   export * as workdir from ${src('workdir')};`
);
const out = path.join(tmpRoot, 'reconcile.bundle.cjs');
esbuild.buildSync({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: out,
  alias: { vscode: vscodeStub },
});
const { SetupWizard, workdir } = require(out);

// One clock read. Expiries sit just inside the 8 h token lifetime; family
// anchors sit 30 days out, an hour apart per family, so two families are far
// outside the anchor window and a refresh drift of a few seconds is far inside.
const T = Date.now();
const SEC = 1_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const LIVE = T + 479 * MIN;
const F = (k) => T + 30 * 24 * HOUR + k * HOUR;
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
// Past the 10 s write burst (workdir.LOGIN_BURST_MS).
const OLD = (T - 10 * MIN) / 1000;
const RETRY_MS = workdir.LOGIN_BURST_MS + 500;
const hash = (buf) =>
  crypto.createHash('sha256').update(workdir.credentialFingerprint(buf)).digest('hex');

const EMAIL = 'a@x.com';
const OTHER = 'o@x.com';
let home, prevHome, account, keepalive, realSetTimeout, armed, fastLocks;

const creds = (dir) => path.join(dir, '.credentials.json');
const read = (dir) => fs.readFileSync(creds(dir));
const chainOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.grant-chain.json'), 'utf-8'));
function put(dir, buf, mtimeSec) {
  fs.writeFileSync(creds(dir), buf);
  if (mtimeSec !== undefined) fs.utimesSync(creds(dir), mtimeSec, mtimeSec);
}
/** A store's credential file and its chain, as the extension writes it. */
function putStore(dir, buf, chain) {
  put(dir, buf);
  fs.writeFileSync(
    path.join(dir, '.grant-chain.json'),
    JSON.stringify({ v: 2, displaced: [], hashes: [], ...chain })
  );
}
function identity(dir, email = EMAIL) {
  fs.writeFileSync(
    path.join(dir, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: email, displayName: email } })
  );
}
const emailIn = (dir) =>
  JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf-8')).oauthAccount.emailAddress;
function windowDir(id, email = EMAIL) {
  const dir = path.join(home, '.claude-windows', id);
  fs.mkdirSync(dir, { recursive: true });
  identity(dir, email);
  return dir;
}
function otherAccount() {
  const dir = path.join(home, '.claude-other');
  fs.mkdirSync(dir, { recursive: true });
  identity(dir, OTHER);
  return { name: 'other', dir, email: OTHER };
}
function defaultCreds() {
  try {
    return read(path.join(home, '.claude'));
  } catch {
    return null;
  }
}
const logged = (re) => (globalThis.__healLog ?? []).some((l) => re.test(l));
const count = (re) => (globalThis.__healLog ?? []).filter((l) => re.test(l)).length;
const reloads = () =>
  (globalThis.__commands ?? []).filter((c) => c === 'workbench.action.reloadWindow').length;

/**
 * A wizard for the window whose working dir is `dir`, bound to `opts.bound`
 * (the one account by default); `opts.others` are further saved accounts.
 */
function wizardFor(dir, opts = {}) {
  const binds = [];
  const bound = opts.bound ?? account;
  const all = () => [account, ...(opts.others ?? [])];
  const registry = {
    savedForEmail: (e) => all().find((a) => a.email.toLowerCase() === String(e).toLowerCase()),
    add: async () => {},
    restoreForgotten: async () => undefined,
    get: (name) => all().find((a) => a.name === name),
    emailOf: (a) => a.email,
    getActiveName: () => bound.name,
    list: all,
    discoverAndMerge: async () => {},
    pruneSignedOut: async () => {},
  };
  const binding = {
    getEnvDir: () => dir,
    getActiveName: () => bound.name,
    bind: async (a) => {
      binds.push(a.name);
    },
  };
  const context = {
    workspaceState: { get: () => undefined, update: async () => {} },
    globalState: { get: () => undefined, update: async () => {} },
    subscriptions: [],
  };
  const wizard = new SetupWizard(registry, binding, context);
  wizard.restocked = [];
  wizard.onStaleRestock = (email) => wizard.restocked.push(email);
  if (opts.selfHeal === false) wizard.selfHealEnabled = () => false;
  wizard.binds = binds;
  return wizard;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-heal-home-'));
  prevHome = process.env.HOME;
  process.env.HOME = home;
  // withLockAsync waits on unref'd timers; keep the loop alive across them.
  keepalive = setInterval(() => {}, 50);
  const store = path.join(home, '.claude-acct');
  fs.mkdirSync(store, { recursive: true });
  identity(store);
  account = { name: 'acct', dir: store, email: EMAIL };
  globalThis.__healLog = [];
  globalThis.__commands = [];
  // The heal re-run is captured, never left to fire into a later case; with
  // fastLocks the store lock's 250 ms steps (src/fsSafe.ts:266) run at once, so
  // a deferred pass gives up its 3 s cap without the wall-clock wait.
  armed = [];
  fastLocks = false;
  realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...rest) => {
    if (ms === RETRY_MS) {
      armed.push(fn);
      return { unref() {}, ref() {} };
    }
    if (fastLocks && ms === 250) return realSetTimeout(fn, 0, ...rest);
    return realSetTimeout(fn, ms, ...rest);
  };
});

afterEach(() => {
  global.setTimeout = realSetTimeout;
  clearInterval(keepalive);
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('reconcile self-heal through SetupWizard', () => {
  it('restocks a copy of the current family the store has moved past', async () => {
    const K = grant('rt-K', F(0));
    const S = grant('rt-S', F(0), LIVE + 10 * MIN);
    putStore(account.dir, K, { current: F(0), hashes: [hash(K)] });
    const b = windowDir('b');
    put(b, K, OLD);
    const wb = wizardFor(b);
    await wb.reconcile();

    put(account.dir, S); // another window moved the store on within the family
    await wb.reconcile();
    assert.ok(read(b).equals(S));
    assert.deepEqual(wb.restocked, [EMAIL]);
    assert.ok(logged(/heal verdict=restock reason=known/));
  });

  it('M-1: a sign-in is never restocked over by a dead lineage refreshed elsewhere', async () => {
    const S = grant('rt-S', F(0));
    const S1 = grant('rt-S1', F(0) + 3 * SEC, LIVE + 10 * MIN);
    const L = grant('rt-L', F(1));
    const L1 = grant('rt-L1', F(1) + SEC, LIVE + 20 * MIN);
    putStore(account.dir, S, { current: F(0), hashes: [hash(S)] });
    const a = windowDir('a');
    const b = windowDir('b');
    put(a, S, OLD);
    put(b, S, OLD);
    const wa = wizardFor(a);
    const wb = wizardFor(b);
    const neverS1 = () => assert.ok(!read(account.dir).equals(S1), 'the store never holds S′');
    await wa.reconcile();
    await wb.reconcile();

    // 1: A signs in; L is a later family than the store's.
    put(a, L);
    await wa.reconcile();
    assert.ok(read(account.dir).equals(L), 'the store adopts the sign-in');
    assert.ok(logged(/heal verdict=adopt reason=sign-in for a@x.com/));
    assert.equal(chainOf(account.dir).current, F(1));
    assert.deepEqual(chainOf(account.dir).displaced, [F(0)]);

    // 2: B still holds S, an earlier family: a fork, restocked with L.
    await wb.reconcile();
    assert.ok(read(b).equals(L));
    assert.ok(read(account.dir).equals(L));
    assert.ok(logged(/heal verdict=restock reason=fork/));

    // 3: B's process still has S in memory and refreshes it to S′, 3 s of drift
    //    on its anchor. Inside the burst it is kept, then restocked once aged.
    put(b, S1);
    await wb.reconcile();
    neverS1();
    assert.ok(read(b).equals(S1));
    assert.ok(logged(/heal verdict=keep reason=burst/));
    fs.utimesSync(creds(b), OLD, OLD);
    await wb.reconcile();
    neverS1();
    assert.ok(read(b).equals(L), 'B is restocked with the sign-in');
    assert.ok(read(account.dir).equals(L), 'the store keeps L');
    assert.ok(logged(/refresh of a family a later sign-in replaced — kept store/));

    // 5: B on the restocked L matches the store.
    await wb.reconcile();
    assert.ok(logged(/heal verdict=keep reason=same/));

    // 4: A's process refreshes L to L′: a continuation, adopted.
    put(a, L1);
    await wa.reconcile();
    assert.ok(read(account.dir).equals(L1));
    assert.ok(logged(/heal verdict=adopt reason=continuation/));
    assert.ok(read(a).equals(L1), "A's file is never written by the extension");
    assert.deepEqual(wa.restocked, []);

    // B's L is now an older refresh of the current family.
    fs.utimesSync(creds(b), OLD, OLD);
    await wb.reconcile();
    neverS1();
    assert.ok(read(b).equals(L1));
    assert.deepEqual(wb.restocked, [EMAIL, EMAIL, EMAIL]);
  });

  it('N1: a poller rotation restocks the window, and its refresh of that family is adopted', async () => {
    const C = grant('rt-C', F(0));
    const C2 = grant('rt-C2', F(0), LIVE + 10 * MIN);
    const C3 = grant('rt-C3', F(0), LIVE + 20 * MIN);
    putStore(account.dir, C, { current: F(0), hashes: [hash(C)] });
    const b = windowDir('b');
    put(b, C, OLD);
    const wb = wizardFor(b);
    await wb.reconcile();

    // The poller rotates the store in place: the spread keeps the anchor and
    // the store lock records both grants (src/usage.ts:684-697).
    workdir.observeStoreGrant(account.dir, C);
    put(account.dir, C2);
    workdir.observeStoreGrant(account.dir, C2);
    await wb.reconcile();
    assert.ok(read(b).equals(C2), 'B is restocked with the rotated grant');
    assert.equal(chainOf(account.dir).current, F(0));
    assert.deepEqual(chainOf(account.dir).displaced, []);

    // A process spawned after the restock reads C2 and refreshes it.
    put(b, C3);
    await wb.reconcile();
    assert.ok(read(account.dir).equals(C3), 'the store adopts the continuation');
    assert.ok(read(b).equals(C3));
  });

  it('P1-M9: a sign-in in the window reaches a named ~/.claude on an earlier family', async () => {
    const S = grant('rt-S', F(0));
    const L = grant('rt-L', F(1));
    putStore(account.dir, S, { current: F(0), hashes: [hash(S)] });
    const def = path.join(home, '.claude');
    fs.mkdirSync(def, { recursive: true });
    put(def, S);
    identity(home);
    const b = windowDir('b');
    put(b, S, OLD);
    const wb = wizardFor(b);
    await wb.reconcile();

    put(b, L); // /login in the window
    await wb.reconcile();
    assert.ok(read(account.dir).equals(L));
    assert.ok(defaultCreds().equals(L), '~/.claude follows the store onto the sign-in');
  });

  it('a fork kept inside its burst never reaches ~/.claude', async () => {
    const S = grant('rt-S', F(0));
    const L = grant('rt-L', F(1));
    const S1 = grant('rt-S1', F(0), LIVE + 10 * MIN);
    putStore(account.dir, L, { current: F(1), displaced: [F(0)], hashes: [hash(S), hash(L)] });
    const b = windowDir('b');
    put(b, L, OLD);
    const wb = wizardFor(b);
    await wb.reconcile();

    // An unnamed ~/.claude on an earlier grant takes any later one it is
    // offered, so a mirror call here would show on disk.
    const early = grant('rt-E', F(0), T + MIN);
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    put(path.join(home, '.claude'), early);
    fs.writeFileSync(path.join(home, '.claude.json'), '{}');
    put(b, S1);
    await wb.reconcile();
    assert.ok(read(account.dir).equals(L));
    assert.ok(read(b).equals(S1));
    assert.ok(defaultCreds().equals(early), 'the mirror is skipped');
    assert.ok(logged(/kept store/));
    assert.ok(logged(/heal verdict=keep reason=burst/));
  });

  it('refuses to restock a store grant of a family another account holds', async () => {
    const S = grant('rt-S', F(0));
    const E = grant('rt-E', F(-5));
    putStore(account.dir, S, { current: F(0), displaced: [F(-5)], hashes: [hash(E), hash(S)] });
    const other = otherAccount();
    putStore(other.dir, grant('rt-O', F(-20)), { current: F(-20), displaced: [F(0)] });
    const b = windowDir('b');
    put(b, E, OLD);
    const wb = wizardFor(b, { others: [other] });
    await wb.reconcile();
    assert.ok(logged(/heal verdict=restock reason=fork/));
    assert.ok(
      logged(/store grant for a@x.com belongs to a family .*\.claude-other also holds — refusing/)
    );
    assert.ok(read(b).equals(E), 'the window keeps its file');
    assert.deepEqual(wb.restocked, []);
  });

  it('selfHeal=false leaves a known copy alone, yet a sign-in reaches the store by order', async () => {
    const K = grant('rt-K', F(0));
    const S = grant('rt-S', F(0), LIVE + 10 * MIN);
    putStore(account.dir, K, { current: F(0), hashes: [hash(K)] });
    const b = windowDir('b');
    put(b, K, OLD);
    const wb = wizardFor(b, { selfHeal: false });
    await wb.reconcile();
    put(account.dir, S);
    await wb.reconcile();
    assert.ok(read(b).equals(K), 'the known copy is left byte-identical');
    assert.ok(logged(/heal verdict=keep reason=selfHeal-off/));
    assert.deepEqual(wb.restocked, []);

    // A /login writes a later family; no token-less pass came before it.
    const N = grant('rt-N', F(1), T + 6 * HOUR);
    put(b, N);
    await wb.reconcile();
    assert.ok(read(account.dir).equals(N), 'the store adopts the sign-in');
    assert.ok(read(b).equals(N), 'the window file is untouched');
  });

  it('a manual save keeps the store over a fork and takes a later family; both bind', async () => {
    const S = grant('rt-S', F(0));
    putStore(account.dir, S, { current: F(0), hashes: [hash(S)] });
    const d = windowDir('d');
    const E = grant('rt-E', F(-5));
    put(d, E);
    const wd = wizardFor(d);
    await wd.captureCurrentAccount({ quiet: true, silent: true, sourceDir: d });
    assert.ok(read(account.dir).equals(S));
    assert.ok(read(d).equals(E));
    assert.deepEqual(wd.binds, ['acct']);
    assert.ok(logged(/refresh of a family a later sign-in replaced — kept store/));

    const U = grant('rt-U', F(5));
    put(d, U);
    await wd.captureCurrentAccount({ quiet: true, silent: true, sourceDir: d });
    assert.ok(read(account.dir).equals(U));
    assert.deepEqual(wd.binds, ['acct', 'acct']);
  });

  it('the fresh-grant capture on a sign-in as another account adopts a later family', async () => {
    putStore(account.dir, grant('rt-S', F(0)), { current: F(0) });
    const other = otherAccount();
    const K = grant('rt-K', F(-5));
    putStore(other.dir, K, { current: F(-5), hashes: [hash(K)] });
    // The window ran `other`; /login as a@x.com wrote U, which no store holds.
    const d = windowDir('d');
    const U = grant('rt-U', F(5));
    put(d, U);
    const wd = wizardFor(d, { bound: other, others: [other] });
    await wd.reconcile();
    assert.ok(logged(/in-window sign-in as a@x.com \(fresh grant\)/));
    assert.ok(read(account.dir).equals(U));
    assert.ok(read(other.dir).equals(K));
    assert.deepEqual(wd.binds, ['acct']);
    assert.equal(reloads(), 1);
  });

  it('keeps a known copy whose mtime cannot be read', async () => {
    const K = grant('rt-K', F(0));
    putStore(account.dir, K, { current: F(0), hashes: [hash(K)] });
    const b = windowDir('b');
    put(b, K, OLD);
    const wb = wizardFor(b);
    await wb.reconcile();
    put(account.dir, grant('rt-S', F(0), LIVE + 10 * MIN));
    const file = creds(b);
    const realStat = fs.statSync;
    fs.statSync = (p, ...rest) => {
      if (path.normalize(String(p)) === path.normalize(file)) throw new Error('EACCES');
      return realStat(p, ...rest);
    };
    try {
      await wb.reconcile();
    } finally {
      fs.statSync = realStat;
    }
    assert.ok(read(b).equals(K));
    assert.ok(logged(/heal verdict=keep reason=unreadable-mtime/));
  });
});

describe('identity drift over a grant no store holds byte-wise (P1-M4, M-2, M-6)', () => {
  /** X (`account`) moved from S's family F(0) to L's F(1); Y (`other`) is on F(-5). */
  function bleedFixture() {
    const S = grant('rt-S', F(0));
    const L = grant('rt-L', F(1));
    putStore(account.dir, L, { current: F(1), displaced: [F(0)], hashes: [hash(S), hash(L)] });
    const other = otherAccount();
    const K = grant('rt-K', F(-5));
    putStore(other.dir, K, { current: F(-5), hashes: [hash(K)] });
    return { S, L, K, other };
  }

  it("a fork of the bound account's displaced family is kept both, not captured", async () => {
    const { L, K, other } = bleedFixture();
    const d = windowDir('d', OTHER);
    const S1 = grant('rt-S1', F(0) + 3 * SEC, LIVE + 10 * MIN);
    put(d, S1);
    const wd = wizardFor(d, { others: [other] });
    await wd.reconcile();
    assert.ok(
      logged(
        /identity drift a@x.com → o@x.com over a grant of a@x.com's own family — kept both, not captured/
      )
    );
    assert.ok(read(other.dir).equals(K), "the other account's store is byte-unchanged");
    assert.ok(read(account.dir).equals(L));
    assert.ok(read(d).equals(S1));
    assert.equal(emailIn(d), OTHER, "the window's identity is left as it is");
    assert.deepEqual(wd.binds, []);
    assert.equal(reloads(), 0);
  });

  it('a copy the bound store has held is restamped in place', async () => {
    const { S, K, other } = bleedFixture();
    const d = windowDir('d', OTHER);
    put(d, S);
    const wd = wizardFor(d, { others: [other] });
    await wd.reconcile();
    assert.ok(
      logged(
        /identity drift a@x.com → o@x.com over a grant a@x.com's store has held — restamped in place, no capture/
      )
    );
    assert.equal(emailIn(d), EMAIL);
    assert.ok(read(d).equals(S));
    assert.ok(read(other.dir).equals(K));
    assert.deepEqual(wd.binds, []);
    assert.equal(reloads(), 0);
  });

  it('a fork no chain knows is captured and judged by order against the other store (R-7)', async () => {
    const { K, other } = bleedFixture();
    // Earlier than the other store's family: a fork, kept out of it.
    const d1 = windowDir('d1', OTHER);
    put(d1, grant('rt-U', F(-10)));
    await wizardFor(d1, { others: [other] }).reconcile();
    assert.ok(read(other.dir).equals(K), 'that store is byte-unchanged');
    assert.ok(logged(/o@x.com: incoming grant is a refresh of a family a later sign-in replaced/));

    // Later than it: adopted. R-7 documents this as the residue the order allows.
    const d2 = windowDir('d2', OTHER);
    const V = grant('rt-V', F(5));
    put(d2, V);
    const w2 = wizardFor(d2, { others: [other] });
    await w2.reconcile();
    assert.ok(read(other.dir).equals(V));
    assert.ok(logged(/refreshed store of o@x.com \(sign-in\)/));
    assert.deepEqual(w2.binds, ['other']);
  });

  it('two grants with no anchor are captured as legacy and both stores keep theirs', async () => {
    const X0 = grant('rt-X0', null);
    putStore(account.dir, X0, { current: null, hashes: [hash(X0)] });
    const other = otherAccount();
    const K0 = grant('rt-K0', null);
    put(other.dir, K0);
    const d = windowDir('d', OTHER);
    put(d, grant('rt-W0', null));
    const wd = wizardFor(d, { others: [other] });
    await wd.reconcile();
    assert.ok(logged(/o@x.com: incoming grant has no family anchor — kept both/));
    assert.ok(read(account.dir).equals(X0));
    assert.ok(read(other.dir).equals(K0));
    assert.deepEqual(wd.binds, ['other']);
  });
});

describe('the heal re-run (P1-M8, R1-m1)', () => {
  /** A window on a known copy, judged once on the store's original grant. */
  async function knownCopy() {
    const K = grant('rt-K', F(0));
    const S = grant('rt-S', F(0), LIVE + 10 * MIN);
    putStore(account.dir, K, { current: F(0), hashes: [hash(K)] });
    const b = windowDir('b');
    put(b, K, OLD);
    const wb = wizardFor(b);
    await wb.reconcile();
    put(account.dir, S);
    return { K, S, b, wb };
  }

  it('re-runs once after a burst keep, and the re-run itself restocks', async () => {
    const { K, S, b, wb } = await knownCopy();
    put(b, K); // fresh mtime: inside the write burst
    await wb.reconcile();
    assert.ok(logged(/heal verdict=keep reason=burst/));
    assert.ok(read(b).equals(K));
    assert.equal(armed.length, 1);

    fs.utimesSync(creds(b), OLD, OLD);
    await armed[0]();
    assert.ok(read(b).equals(S));
    assert.deepEqual(wb.restocked, [EMAIL]);
  });

  it('re-runs after a deferred judgment without judging the relation', async () => {
    const { K, S, b, wb } = await knownCopy();
    const lock = `${creds(account.dir)}.lock`;
    fs.mkdirSync(lock);
    fastLocks = true;
    try {
      await wb.reconcile();
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }
    assert.ok(logged(/heal verdict=keep reason=deferred/));
    assert.ok(read(b).equals(K));
    assert.equal(armed.length, 1);

    await armed[0]();
    assert.ok(read(b).equals(S));
  });

  it('stops re-arming after six tries, and a conclusive pass resets the count', async () => {
    const { S, b, wb } = await knownCopy();
    const lock = `${creds(account.dir)}.lock`;
    fs.mkdirSync(lock);
    fastLocks = true;
    try {
      for (let i = 0; i < 7; i++) await wb.reconcile();
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }
    assert.equal(count(/heal verdict=keep reason=deferred/), 7);
    assert.equal(armed.length, 6, 'seven deferred passes arm six timers');
    assert.equal(count(/heal re-run limit reached — waiting for the watcher or the next focus/), 1);

    await wb.reconcile(); // the lock is free and the file is old: restocked
    assert.ok(read(b).equals(S));
    assert.ok(logged(/heal verdict=restock reason=known/));

    // The restock left a fresh mtime, so the next pass on a moved store is a
    // burst: armed again, because the restock reset the count.
    put(account.dir, grant('rt-S2', F(0), LIVE + 20 * MIN));
    await wb.reconcile();
    assert.ok(logged(/heal verdict=keep reason=burst/));
    assert.equal(armed.length, 7);
  });
});
