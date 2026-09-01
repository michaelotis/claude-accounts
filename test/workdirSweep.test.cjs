const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');

/**
 * workdir.ts imports vscode (via log/accounts) — bundle with the same minimal
 * vscode stub the other unit bundles use.
 */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `workdir-sweep-${process.pid}-`));
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
const { sweepStaleWorkingLocks, allWorkingDirs, workingRoot } = require(bundleOut);

describe('sweepStaleWorkingLocks', () => {
  let tmpHome;
  let prevHome;
  let root;

  before(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-workdir-sweep-'));
    prevHome = process.env.HOME;
    process.env.HOME = tmpHome;
    root = workingRoot();
  });

  after(() => {
    process.env.HOME = prevHome;
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  beforeEach(() => {
    assert.ok(root.startsWith(tmpHome));
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
  });

  it('removes a .lock dir with no owner.json and an old mtime', () => {
    const dir = path.join(root, 'deadbeefcafe.lock');
    fs.mkdirSync(dir);
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(dir, past, past);
    const n = sweepStaleWorkingLocks();
    assert.equal(n, 1);
    assert.equal(fs.existsSync(dir), false);
  });

  it('keeps a .lock dir whose owner.json pid is this process', () => {
    const dir = path.join(root, 'liveowner0001.lock');
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, 'owner.json'),
      JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() })
    );
    const n = sweepStaleWorkingLocks();
    assert.equal(n, 0);
    assert.equal(fs.existsSync(dir), true);
  });

  it('keeps a .lock dir that holds a regular file', () => {
    const dir = path.join(root, 'hasrealfile01.lock');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'x.txt'), 'nope');
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(dir, past, past);
    const n = sweepStaleWorkingLocks();
    assert.equal(n, 0);
    assert.equal(fs.existsSync(dir), true);
  });

  it('never touches a plain 12-hex working dir', () => {
    const dir = path.join(root, 'aabbccddeeff');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'x.txt'), 'window');
    const n = sweepStaleWorkingLocks();
    assert.equal(n, 0);
    assert.equal(fs.existsSync(dir), true);
    assert.ok(allWorkingDirs().includes(dir));
  });

  it('allWorkingDirs excludes *.lock names', () => {
    const lock = path.join(root, 'stillalive000.lock');
    const window = path.join(root, 'aabbccddeeff');
    fs.mkdirSync(lock);
    fs.writeFileSync(
      path.join(lock, 'owner.json'),
      JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() })
    );
    fs.mkdirSync(window);
    const dirs = allWorkingDirs();
    assert.ok(dirs.every((d) => !path.basename(d).endsWith('.lock')));
    assert.ok(!dirs.includes(lock));
    assert.ok(dirs.includes(window));
  });

  it('keeps a .lock dir with no owner.json created just now', () => {
    const dir = path.join(root, 'freshnowner00.lock');
    fs.mkdirSync(dir);
    const n = sweepStaleWorkingLocks();
    assert.equal(n, 0);
    assert.equal(fs.existsSync(dir), true);
  });

  it('keeps a live foreign-host owner and removes one older than 15 minutes', () => {
    const live = path.join(root, 'liveforeign00.lock');
    fs.mkdirSync(live);
    fs.writeFileSync(
      path.join(live, 'owner.json'),
      JSON.stringify({ pid: 999999, host: 'other-host', at: Date.now() })
    );
    const stale = path.join(root, 'staleforeign0.lock');
    fs.mkdirSync(stale);
    fs.writeFileSync(
      path.join(stale, 'owner.json'),
      JSON.stringify({ pid: 999999, host: 'other-host', at: Date.now() - 20 * 60_000 })
    );
    const n = sweepStaleWorkingLocks();
    assert.equal(n, 1);
    assert.equal(fs.existsSync(live), true);
    assert.equal(fs.existsSync(stale), false);
  });

  it('removes a dead same-host lock of only symlinks without deleting their targets', () => {
    const targetA = path.join(tmpHome, 'sweep-target-a');
    const targetB = path.join(tmpHome, 'sweep-target-b');
    fs.writeFileSync(targetA, 'keep-a');
    fs.writeFileSync(targetB, 'keep-b');
    const dir = path.join(root, 'deadsamehost0.lock');
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, 'owner.json'),
      JSON.stringify({ pid: 999999, host: os.hostname(), at: Date.now() })
    );
    fs.symlinkSync(targetA, path.join(dir, 'a'));
    fs.symlinkSync(targetB, path.join(dir, 'b'));
    const n = sweepStaleWorkingLocks();
    assert.equal(n, 1);
    assert.equal(fs.existsSync(dir), false);
    assert.equal(fs.existsSync(targetA), true);
    assert.equal(fs.existsSync(targetB), true);
    assert.equal(fs.readFileSync(targetA, 'utf8'), 'keep-a');
    assert.equal(fs.readFileSync(targetB, 'utf8'), 'keep-b');
  });

  it('treats an owner.json with no host or at like a missing owner', () => {
    const old = path.join(root, 'malformedold00.lock');
    fs.mkdirSync(old);
    fs.writeFileSync(path.join(old, 'owner.json'), JSON.stringify({ pid: 999999 }));
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(old, past, past);
    const fresh = path.join(root, 'malformednew00.lock');
    fs.mkdirSync(fresh);
    fs.writeFileSync(path.join(fresh, 'owner.json'), JSON.stringify({ pid: 999999 }));
    const n = sweepStaleWorkingLocks();
    assert.equal(n, 1);
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(fresh), true);
  });

  it('never touches an empty aged 12-hex working dir', () => {
    const dir = path.join(root, 'cafebabeface');
    fs.mkdirSync(dir);
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(dir, past, past);
    const n = sweepStaleWorkingLocks();
    assert.equal(n, 0);
    assert.equal(fs.existsSync(dir), true);
    assert.ok(allWorkingDirs().includes(dir));
  });
});
