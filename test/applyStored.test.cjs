const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

/**
 * binding.ts imports vscode — bundle with the minimal stub the other unit
 * bundles use, plus the workspace folder that keys the window's working dir and
 * the event emitter WindowBinding constructs.
 */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `apply-stored-${process.pid}-`));
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
     workspace: { workspaceFolders: [{ uri: { fsPath: '/work/project' } }] },
     EventEmitter: class { fire() {} event() {} dispose() {} },
   };`
);
const entry = path.join(tmpRoot, 'entry.ts');
const src = (f) => JSON.stringify(path.join(__dirname, '..', 'src', f));
fs.writeFileSync(
  entry,
  `export { WindowBinding } from ${src('binding')};
   export { credentialFingerprint } from ${src('workdir')};`
);
const out = path.join(tmpRoot, 'binding.bundle.cjs');
esbuild.buildSync({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: out,
  alias: { vscode: vscodeStub },
});
const { WindowBinding, credentialFingerprint } = require(out);

const T = Date.now();
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
        refreshTokenExpiresAt: anchor,
      },
    })
  );
const hash = (buf) => crypto.createHash('sha256').update(credentialFingerprint(buf)).digest('hex');

const EMAIL = 'a@x.com';
const ACTIVE_KEY = 'claudeProfiles.activeAccount';
let home, prevHome, prevEnv, account, env;

const creds = (dir) => path.join(dir, '.credentials.json');
const read = (dir) => fs.readFileSync(creds(dir));
function identity(dir) {
  fs.writeFileSync(
    path.join(dir, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: EMAIL, displayName: 'A' } })
  );
}

/** A binding for a window whose workspace remembers `acct`, and its working dir. */
function windowBinding() {
  env = { replaced: [], deleted: [] };
  const context = {
    workspaceState: { get: (k) => (k === ACTIVE_KEY ? 'acct' : undefined), update: async () => {} },
    globalState: { get: (_k, d) => d, update: async () => {} },
    environmentVariableCollection: {
      description: '',
      replace: (k, v) => env.replaced.push([k, v]),
      delete: (k) => env.deleted.push(k),
    },
  };
  const binding = new WindowBinding(context);
  const dir = binding.workingDir();
  fs.mkdirSync(dir, { recursive: true });
  return { binding, dir };
}
const resolve = (name) => (name === 'acct' ? account : undefined);

/** The window dir holds `dirTok`; the store holds `storeTok` with its chain. */
function stock(dir, dirTok, storeTok, chain) {
  fs.writeFileSync(creds(account.dir), storeTok);
  fs.writeFileSync(
    path.join(account.dir, '.grant-chain.json'),
    JSON.stringify({ v: 2, displaced: [], hashes: [], ...chain })
  );
  identity(dir);
  fs.writeFileSync(creds(dir), dirTok);
}

function assertEnv(dir) {
  assert.equal(process.env.CLAUDE_CONFIG_DIR, dir);
  assert.deepEqual(env.replaced, [['CLAUDE_CONFIG_DIR', dir]]);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-apply-home-'));
  prevHome = process.env.HOME;
  prevEnv = process.env.CLAUDE_CONFIG_DIR;
  process.env.HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR;
  const store = path.join(home, '.claude-acct');
  fs.mkdirSync(store, { recursive: true });
  identity(store);
  account = { name: 'acct', dir: store, email: EMAIL };
  globalThis.__logLines = [];
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevEnv;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('applyStored heals the window before Claude Code reads it (P1-M1)', () => {
  it('restocks a copy of the current family the store has moved past', () => {
    const { binding, dir } = windowBinding();
    const K = grant('rt-K', F(0));
    const S = grant('rt-S', F(0), LIVE + 10 * MIN);
    stock(dir, K, S, { current: F(0), hashes: [hash(K), hash(S)] });
    const r = binding.applyStored(resolve, undefined, { selfHeal: true });
    assert.equal(r.account, account);
    assert.equal(r.stocked, true);
    assert.ok(read(dir).equals(S));
    assert.ok(globalThis.__logLines.some((l) => /restocked at activation \(known\)/.test(l)));
    assertEnv(dir);
  });

  it('restocks a refresh of a family a later sign-in replaced', () => {
    const { binding, dir } = windowBinding();
    const E = grant('rt-E', F(-5), LIVE + 30 * MIN);
    const L = grant('rt-L', F(0));
    stock(dir, E, L, { current: F(0), displaced: [F(-5)], hashes: [hash(L)] });
    binding.applyStored(resolve, undefined, { selfHeal: true });
    assert.ok(read(dir).equals(L));
    assert.ok(globalThis.__logLines.some((l) => /restocked at activation \(fork\)/.test(l)));
    assertEnv(dir);
  });

  it('leaves a grant of a later family', () => {
    const { binding, dir } = windowBinding();
    const U = grant('rt-U', F(5));
    stock(dir, U, grant('rt-S', F(0)), { current: F(0) });
    binding.applyStored(resolve, undefined, { selfHeal: true });
    assert.ok(read(dir).equals(U));
    assertEnv(dir);
  });

  it('selfHeal: false leaves a known copy byte-identical and still sets env', () => {
    const { binding, dir } = windowBinding();
    const K = grant('rt-K', F(0));
    const S = grant('rt-S', F(0), LIVE + 10 * MIN);
    stock(dir, K, S, { current: F(0), hashes: [hash(K), hash(S)] });
    const r = binding.applyStored(resolve, undefined, { selfHeal: false });
    assert.equal(r.stocked, true);
    assert.ok(read(dir).equals(K));
    assertEnv(dir);
  });

  it('a logout-shaped dir is not restocked, even by a folder route, and env still points at it', () => {
    const { binding, dir } = windowBinding();
    fs.writeFileSync(creds(account.dir), grant('rt-S', F(0)));
    // What Claude Code's /logout leaves: a config without the account, no token.
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ numStartups: 3 }));
    const r = binding.applyStored(resolve, 'acct', { selfHeal: true });
    assert.equal(r.stocked, false);
    assert.equal(fs.existsSync(creds(dir)), false);
    assertEnv(dir);
  });
});

describe('applyStored judges a window whose identity drifted before stocking it (P5-C1)', () => {
  const OTHER = 'b@x.com';
  const config = (dir) => fs.readFileSync(path.join(dir, '.claude.json'));
  const emailOf = (dir) => JSON.parse(config(dir)).oauthAccount.emailAddress;
  /** What Claude Code leaves when it restamps the dir from the shared home file. */
  function bleed(dir) {
    fs.writeFileSync(
      path.join(dir, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: OTHER, displayName: 'B' } })
    );
  }
  /** A store behind its chain, and a window holding the chain's live grant. */
  function behindStore(dir) {
    const L1 = grant('rt-L1', F(0));
    const L2 = grant('rt-L2', F(0), LIVE + 10 * MIN);
    stock(dir, L2, grant('rt-Sb', F(-20)), { current: F(0), hashes: [hash(L1), hash(L2)] });
    bleed(dir);
    return L2;
  }

  it('leaves a live grant of the chain family under a drifted identity', () => {
    const { binding, dir } = windowBinding();
    const L2 = behindStore(dir);
    const before = config(dir);
    binding.applyStored(resolve, undefined, { selfHeal: true });
    assert.ok(read(dir).equals(L2));
    assert.ok(config(dir).equals(before));
    assert.ok(globalThis.__logLines.some((l) => /cannot place — left for reconcile/.test(l)));
  });

  it('leaves it on a forced stock too', () => {
    const { binding, dir } = windowBinding();
    const L2 = behindStore(dir);
    const before = config(dir);
    binding.applyStored(resolve, 'acct', { selfHeal: true });
    assert.ok(read(dir).equals(L2));
    assert.ok(config(dir).equals(before));
  });

  it("restamps the identity over the store's own grant and keeps the token", () => {
    const { binding, dir } = windowBinding();
    const S = grant('rt-S', F(0));
    // The window's copy of the store's grant, carrying a field the store's lacks.
    const W = Buffer.from(JSON.stringify({ ...JSON.parse(S), window: 'own' }));
    stock(dir, W, S, { current: F(0), hashes: [hash(S)] });
    bleed(dir);
    const r = binding.applyStored(resolve, undefined, { selfHeal: true });
    assert.equal(r.stocked, true);
    assert.ok(read(dir).equals(W));
    assert.equal(emailOf(dir), EMAIL);
    assert.ok(globalThis.__logLines.some((l) => /restamped, token kept/.test(l)));
    assertEnv(dir);
  });

  it("replaces a grant another account's store holds", () => {
    const { binding, dir } = windowBinding();
    const other = path.join(home, '.claude-other');
    fs.mkdirSync(other, { recursive: true });
    const O = grant('rt-O', F(-100));
    fs.writeFileSync(creds(other), O);
    bleed(other);
    const S = grant('rt-S', F(0));
    stock(dir, O, S, { current: F(0), hashes: [hash(S)] });
    bleed(dir);
    const r = binding.applyStored(resolve, undefined, { selfHeal: true });
    assert.equal(r.stocked, true);
    assert.ok(read(dir).equals(S));
    assert.equal(emailOf(dir), EMAIL);
    assertEnv(dir);
  });
});
