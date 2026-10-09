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
 * pass logged. One entry re-exports the wizard, the watcher and workdir so they
 * share one module instance (the sign-in observation is module state).
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
     commands: { executeCommand: () => Promise.resolve(undefined) },
   };`
);
const entry = path.join(tmpRoot, 'entry.ts');
const src = (f) => JSON.stringify(path.join(__dirname, '..', 'src', f));
fs.writeFileSync(
  entry,
  `export { SetupWizard } from ${src('setupWizard')};
   export { AccountWatcher } from ${src('accountWatcher')};
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
const { SetupWizard, AccountWatcher, workdir } = require(out);

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
const L = grant('rt-L', LIVE + 5 * MIN);
const S2 = grant('rt-S2', LIVE + 10 * MIN);
const L2 = grant('rt-L2', LIVE + 20 * MIN);
const K = grant('rt-K', LIVE + 40 * MIN);
const U = grant('rt-U');
// A sign-in whose lifetime is under the 7 h the old "minted at write" rule wanted.
const N = grant('rt-N', T + 6 * 60 * MIN);
const OLD = (T - 10 * MIN) / 1000;
const hash = (buf) =>
  crypto.createHash('sha256').update(workdir.credentialFingerprint(buf)).digest('hex');

const EMAIL = 'a@x.com';
let home, prevHome, account, keepalive;

const creds = (dir) => path.join(dir, '.credentials.json');
const read = (dir) => fs.readFileSync(creds(dir));
const record = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.grant-origin.json'), 'utf-8'));
function put(dir, buf, mtimeSec) {
  fs.writeFileSync(creds(dir), buf);
  if (mtimeSec !== undefined) fs.utimesSync(creds(dir), mtimeSec, mtimeSec);
}
function identity(dir) {
  fs.writeFileSync(
    path.join(dir, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: EMAIL, displayName: 'A' } })
  );
}
function windowDir(id) {
  const dir = path.join(home, '.claude-windows', id);
  fs.mkdirSync(dir, { recursive: true });
  identity(dir);
  return dir;
}
function defaultCreds() {
  try {
    return read(path.join(home, '.claude'));
  } catch {
    return null;
  }
}
const logged = (re) => (globalThis.__healLog ?? []).some((l) => re.test(l));

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
});

afterEach(() => {
  clearInterval(keepalive);
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('reconcile self-heal through SetupWizard', () => {
  it('restocks a known copy and leaves held on the grant the process still has', async () => {
    put(account.dir, K);
    const b = windowDir('b');
    put(b, K, OLD);
    const wb = wizardFor(b);
    await wb.reconcile();
    assert.equal(record(b).held, hash(K));

    put(account.dir, S); // another window moved the store on
    await wb.reconcile();
    assert.ok(read(b).equals(S));
    const r = record(b);
    assert.equal(r.by, 'ext');
    assert.equal(r.h, hash(S));
    assert.equal(r.held, hash(K));
    assert.deepEqual(wb.restocked, [EMAIL]);
    assert.ok(logged(/heal verdict=restock reason=known/));
  });

  it('M-1: a sign-in is never restocked over by a dead lineage refreshed elsewhere', async () => {
    put(account.dir, S);
    const a = windowDir('a');
    const b = windowDir('b');
    put(a, S, OLD);
    put(b, S, OLD);
    const wa = wizardFor(a);
    const wb = wizardFor(b);
    await wa.reconcile();
    await wb.reconcile();

    // A signs in: Claude Code writes L while A's process held the store's grant.
    put(a, L, OLD);
    await wa.reconcile();
    assert.ok(read(account.dir).equals(L), 'the store adopts the continuation');

    // B still holds S, a copy the store moved past: reconcile restocks it.
    await wb.reconcile();
    assert.ok(read(b).equals(L));

    // B's process still has S in memory and refreshes it to S'.
    put(b, S2);
    const before = defaultCreds();
    await wb.reconcile();
    assert.ok(read(account.dir).equals(L), 'the store keeps the sign-in');
    assert.ok(read(b).equals(S2), "B's file is left on its fork");
    assert.deepEqual(defaultCreds(), before, 'the mirror is skipped');
    assert.equal(record(b).held, hash(S2));
    assert.ok(logged(/heal verdict=adopt reason=continues/));
    assert.ok(logged(/heal verdict=keep reason=unrelated/));

    // A was never restocked, and its own refresh still reaches the store.
    assert.ok(read(a).equals(L));
    put(a, L2, OLD);
    await wa.reconcile();
    assert.ok(read(account.dir).equals(L2));
    assert.ok(read(a).equals(L2));

    await wb.reconcile();
    assert.ok(read(account.dir).equals(L2));
    assert.ok(read(b).equals(S2));
  });

  it('keeps both on a dead-lineage refresh and skips the mirror', async () => {
    put(account.dir, S);
    const b = windowDir('b');
    put(b, S, OLD);
    const wb = wizardFor(b);
    await wb.reconcile();
    put(account.dir, L);
    await wb.reconcile();
    assert.ok(read(b).equals(L), 'restocked by reconcile');

    // An unnamed ~/.claude on an earlier grant takes any later one it is
    // offered, so a mirror call here would show on disk.
    const early = grant('rt-E', T + MIN);
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    put(path.join(home, '.claude'), early);
    fs.writeFileSync(path.join(home, '.claude.json'), '{}');
    put(b, S2);
    await wb.reconcile();
    assert.ok(read(account.dir).equals(L));
    assert.ok(read(b).equals(S2));
    assert.ok(defaultCreds().equals(early), 'the mirror is skipped');
    assert.ok(logged(/kept store/));
    assert.ok(logged(/heal verdict=keep reason=unrelated/));
  });

  it('selfHeal=false leaves a known copy alone, yet a watched sign-in reaches the store', async () => {
    put(account.dir, K);
    const b = windowDir('b');
    put(b, K, OLD);
    const wb = wizardFor(b, { selfHeal: false });
    await wb.reconcile();
    put(account.dir, S);
    await wb.reconcile();
    assert.ok(read(b).equals(K), 'the known copy is left byte-identical');
    assert.ok(logged(/heal verdict=keep reason=selfHeal-off/));
    assert.deepEqual(wb.restocked, []);

    // /login deletes the token first; the watcher sees the gap.
    fs.rmSync(creds(b));
    const watcher = new AccountWatcher({ getEnvDir: () => b }, () => {});
    watcher.start();
    try {
      watcher.schedule();
      await new Promise((r) => setTimeout(r, 500));
    } finally {
      watcher.dispose();
    }
    assert.notEqual(workdir.signInObservedAt(b), null);

    put(b, N);
    await wb.reconcile();
    assert.ok(read(account.dir).equals(N), 'the store adopts the sign-in');
    assert.ok(read(b).equals(N), 'the window file is untouched');
  });

  it('a token-less pass followed by a new grant adopts it; without the pass it is kept', async () => {
    put(account.dir, S);
    const b = windowDir('b');
    const c = windowDir('c');
    const wb = wizardFor(b);
    const wc = wizardFor(c);

    await wb.reconcile(); // no token yet: the gap is noted
    put(b, N);
    put(c, N);
    await wc.reconcile();
    assert.ok(read(account.dir).equals(S), 'unobserved: kept');
    await wb.reconcile();
    assert.ok(read(account.dir).equals(N), 'observed: adopted');
    assert.ok(read(b).equals(N));
    assert.equal(workdir.signInObservedAt(b), null, 'the observation is consumed');
  });

  it('a manual save keeps both for a grant the store never held; the fresh-grant capture adopts', async () => {
    put(account.dir, S);
    const d = windowDir('d');
    put(d, U);
    const wd = wizardFor(d);
    await wd.captureCurrentAccount({ quiet: true, silent: true, sourceDir: d });
    assert.ok(read(account.dir).equals(S));
    assert.ok(read(d).equals(U));
    assert.deepEqual(wd.binds, ['acct']);
    assert.ok(logged(/unrelated to the store's .* kept store/));

    await wd.captureCurrentAccount({ quiet: true, silent: true, sourceDir: d, trusted: true });
    assert.ok(read(account.dir).equals(U));
  });

  it('the fresh-grant capture on a sign-in as another account is trusted', async () => {
    put(account.dir, S);
    const otherDir = path.join(home, '.claude-other');
    fs.mkdirSync(otherDir, { recursive: true });
    fs.writeFileSync(
      path.join(otherDir, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'o@x.com', displayName: 'O' } })
    );
    put(otherDir, K);
    const other = { name: 'other', dir: otherDir, email: 'o@x.com' };
    // The window ran `other`; /login as a@x.com wrote U, which no store holds.
    const d = windowDir('d');
    put(d, U);
    const wd = wizardFor(d, { bound: other, others: [other] });
    await wd.reconcile();
    assert.ok(logged(/in-window sign-in as a@x.com \(fresh grant\)/));
    assert.ok(read(account.dir).equals(U));
    assert.ok(read(otherDir).equals(K));
    assert.deepEqual(wd.binds, ['acct']);
  });

  it('keeps a known copy whose mtime cannot be read', async () => {
    put(account.dir, K);
    const b = windowDir('b');
    put(b, K, OLD);
    const wb = wizardFor(b);
    await wb.reconcile();
    put(account.dir, S);
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

  it('re-runs once after a burst keep, and the re-run restocks', async () => {
    put(account.dir, K);
    const b = windowDir('b');
    put(b, K, OLD);
    const wb = wizardFor(b);
    await wb.reconcile();
    put(account.dir, S);
    put(b, K); // fresh mtime: inside the write burst

    const realSetTimeout = global.setTimeout;
    const armed = [];
    global.setTimeout = (fn, ms, ...rest) => {
      if (ms === workdir.LOGIN_BURST_MS + 500) {
        armed.push(fn);
        return { unref() {}, ref() {} };
      }
      return realSetTimeout(fn, ms, ...rest);
    };
    try {
      await wb.reconcile();
    } finally {
      global.setTimeout = realSetTimeout;
    }
    assert.ok(logged(/heal verdict=keep reason=burst/));
    assert.ok(read(b).equals(K));
    assert.equal(armed.length, 1);

    fs.utimesSync(creds(b), OLD, OLD);
    armed[0]();
    await wb.reconcile();
    assert.ok(read(b).equals(S));
    assert.deepEqual(wb.restocked, [EMAIL]);
  });

  it('re-runs after a deferred judgment without judging the relation', async () => {
    put(account.dir, K);
    const b = windowDir('b');
    put(b, K, OLD);
    const wb = wizardFor(b);
    await wb.reconcile();
    put(account.dir, S);

    const lock = `${creds(account.dir)}.lock`;
    fs.mkdirSync(lock);
    const realSetTimeout = global.setTimeout;
    const armed = [];
    global.setTimeout = (fn, ms, ...rest) => {
      if (ms === workdir.LOGIN_BURST_MS + 500) {
        armed.push(fn);
        return { unref() {}, ref() {} };
      }
      return realSetTimeout(fn, ms, ...rest);
    };
    try {
      await wb.reconcile();
    } finally {
      global.setTimeout = realSetTimeout;
      fs.rmSync(lock, { recursive: true, force: true });
    }
    assert.ok(logged(/heal verdict=keep reason=deferred/));
    assert.ok(read(b).equals(K));
    assert.equal(armed.length, 1);

    armed[0]();
    await wb.reconcile();
    assert.ok(read(b).equals(S));
  });
});
