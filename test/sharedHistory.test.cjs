const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');

const SHARED_DIRS = [
  'projects',
  'sessions',
  'session-env',
  'shell-snapshots',
  'file-history',
  'plans',
  'todos',
];

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `shared-hist-${process.pid}-`));
const out = path.join(tmpRoot, 'sharedHistory.bundle.cjs');
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/sharedHistory.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: out,
});
const { ensureSharedHistory, sharedStoreDir } = require(out);

function isLinkTo(from, to) {
  const st = fs.lstatSync(from);
  return st.isSymbolicLink() && path.normalize(fs.readlinkSync(from)) === path.normalize(to);
}

describe('ensureSharedHistory', () => {
  let tmpHome;
  let prevHome;
  let keepalive;
  let store;
  let dir1;
  let dir2;
  let dir3;
  let dir4;
  const originalJsonl = '{"id":"a","text":"hello"}\n';
  const olderJsonl = '{"id":"a","text":"OLDER-DIFFERENT"}\n';
  const hist1 = '{"display":"one"}';
  const hist2 = '{"display":"two"}';
  const hist3 = '{"display":"three"}';

  before(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-shared-hist-'));
    prevHome = process.env.HOME;
    process.env.HOME = tmpHome;
    keepalive = setInterval(() => {}, 50);
    store = sharedStoreDir();
    dir1 = path.join(tmpHome, 'acct1');
    dir2 = path.join(tmpHome, 'acct2');
    dir3 = path.join(tmpHome, 'acct3');
    dir4 = path.join(tmpHome, 'acct4');
  });

  after(() => {
    clearInterval(keepalive);
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

  it('moves a fresh account dir into the store and links every shared entry', async () => {
    fs.mkdirSync(path.join(dir1, 'projects', 'p'), { recursive: true });
    fs.writeFileSync(path.join(dir1, 'projects', 'p', 'a.jsonl'), originalJsonl);
    fs.mkdirSync(path.join(dir1, 'todos'), { recursive: true });
    fs.writeFileSync(path.join(dir1, 'todos', 't.json'), '{"t":1}');
    fs.writeFileSync(path.join(dir1, 'history.jsonl'), `${hist1}\n${hist2}\n`);

    const warnings = await ensureSharedHistory([dir1]);
    assert.deepEqual(warnings, []);

    for (const name of SHARED_DIRS) {
      assert.ok(isLinkTo(path.join(dir1, name), path.join(store, name)), `${name} should symlink`);
    }
    assert.ok(isLinkTo(path.join(dir1, 'history.jsonl'), path.join(store, 'history.jsonl')));

    const storedJsonl = path.join(store, 'projects', 'p', 'a.jsonl');
    assert.ok(fs.existsSync(storedJsonl));
    assert.equal(fs.lstatSync(storedJsonl).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(storedJsonl, 'utf8'), originalJsonl);
    const storedTodo = path.join(store, 'todos', 't.json');
    assert.ok(fs.existsSync(storedTodo));
    assert.equal(fs.lstatSync(storedTodo).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(storedTodo, 'utf8'), '{"t":1}');

    const histLines = fs
      .readFileSync(path.join(store, 'history.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean);
    assert.deepEqual(histLines, [hist1, hist2]);
  });

  it('merges a byte-identical file without creating .merge-backup', async () => {
    fs.mkdirSync(path.join(dir2, 'projects', 'p'), { recursive: true });
    fs.writeFileSync(path.join(dir2, 'projects', 'p', 'a.jsonl'), originalJsonl);

    const warnings = await ensureSharedHistory([dir2]);
    assert.deepEqual(warnings, []);
    assert.equal(fs.existsSync(path.join(store, '.merge-backup')), false);
    assert.equal(
      fs.readFileSync(path.join(store, 'projects', 'p', 'a.jsonl'), 'utf8'),
      originalJsonl
    );
    assert.ok(isLinkTo(path.join(dir2, 'projects'), path.join(store, 'projects')));
  });

  it('backs up an older differing file under .merge-backup and keeps the newer store copy', async () => {
    fs.mkdirSync(path.join(dir3, 'projects', 'p'), { recursive: true });
    const loserPath = path.join(dir3, 'projects', 'p', 'a.jsonl');
    fs.writeFileSync(loserPath, olderJsonl);
    const storeFile = path.join(store, 'projects', 'p', 'a.jsonl');
    const now = new Date();
    const old = new Date(now.getTime() - 120_000);
    fs.utimesSync(storeFile, now, now);
    fs.utimesSync(loserPath, old, old);

    const warnings = await ensureSharedHistory([dir3]);
    assert.deepEqual(warnings, []);
    assert.equal(fs.readFileSync(storeFile, 'utf8'), originalJsonl);

    const backupDir = path.join(store, '.merge-backup', 'projects', 'p');
    assert.ok(fs.existsSync(backupDir), '.merge-backup/projects/p should exist');
    const backups = fs.readdirSync(backupDir).filter((n) => n.startsWith('a.jsonl.'));
    assert.ok(backups.length >= 1, 'loser should be under .merge-backup/projects/p/');
    assert.equal(fs.readFileSync(path.join(backupDir, backups[0]), 'utf8'), olderJsonl);
  });

  it('appends only unseen history.jsonl lines', async () => {
    fs.mkdirSync(dir4, { recursive: true });
    fs.writeFileSync(path.join(dir4, 'history.jsonl'), `${hist1}\n${hist3}\n`);

    const warnings = await ensureSharedHistory([dir4]);
    assert.deepEqual(warnings, []);
    const histLines = fs
      .readFileSync(path.join(store, 'history.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean);
    assert.deepEqual(histLines, [hist1, hist2, hist3]);
  });

  it('returns [] when every dir is already linked', async () => {
    const warnings = await ensureSharedHistory([dir1, dir2, dir3, dir4]);
    assert.deepEqual(warnings, []);
  });
});
