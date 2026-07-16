const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');

/** workdir.ts imports vscode via log — bundle with the minimal stub, like the others. */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `link-assets-${process.pid}-`));
const vscodeStub = path.join(tmpRoot, 'vscode-stub.js');
fs.writeFileSync(
  vscodeStub,
  `module.exports = {
     window: { createOutputChannel: () => ({ appendLine() {}, show() {} }) },
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
const { linkUserAssets } = require(bundleOut);

/** Fresh isolated HOME per test (os.homedir() follows $HOME at call time). */
function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-assets-home-'));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn(home);
  } finally {
    process.env.HOME = prev;
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function mkSource(home, name, marker) {
  const dir = path.join(home, '.claude', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, marker), 'x');
  return dir;
}

describe('linkUserAssets', () => {
  it('links existing source dirs and skips missing ones', () => {
    withHome((home) => {
      mkSource(home, 'skills', 'SKILL.md');
      mkSource(home, 'agents', 'a.md');
      // no ~/.claude/commands
      const wd = path.join(home, '.claude-windows', 'w1');
      fs.mkdirSync(wd, { recursive: true });
      linkUserAssets(wd);
      assert.ok(fs.lstatSync(path.join(wd, 'skills')).isSymbolicLink());
      assert.ok(fs.lstatSync(path.join(wd, 'agents')).isSymbolicLink());
      assert.equal(fs.existsSync(path.join(wd, 'commands')), false);
      // The link resolves into the shared source
      assert.ok(fs.existsSync(path.join(wd, 'skills', 'SKILL.md')));
    });
  });

  it('never links the default ~/.claude dir to itself', () => {
    withHome((home) => {
      mkSource(home, 'skills', 'SKILL.md');
      const dflt = path.join(home, '.claude');
      linkUserAssets(dflt);
      assert.ok(
        fs.lstatSync(path.join(dflt, 'skills')).isDirectory(),
        'source dir untouched, no self-link'
      );
    });
  });

  it('renames a real local dir to .bak exactly once, then links', () => {
    withHome((home) => {
      mkSource(home, 'skills', 'SKILL.md');
      const wd = path.join(home, '.claude-windows', 'w1');
      const local = path.join(wd, 'skills');
      fs.mkdirSync(local, { recursive: true });
      fs.writeFileSync(path.join(local, 'mine.md'), 'local');
      linkUserAssets(wd);
      assert.ok(fs.lstatSync(local).isSymbolicLink());
      assert.ok(
        fs.existsSync(path.join(`${local}.bak`, 'mine.md')),
        'original content preserved in .bak'
      );
      // Second pass: the .bak is not re-taken or disturbed, the link stands.
      linkUserAssets(wd);
      assert.ok(fs.lstatSync(local).isSymbolicLink());
      assert.ok(fs.existsSync(path.join(`${local}.bak`, 'mine.md')));
    });
  });

  it('never links plugins/ (Claude Code manages live state there)', () => {
    withHome((home) => {
      mkSource(home, 'skills', 'SKILL.md');
      mkSource(home, 'plugins', 'marketplace.json');
      const wd = path.join(home, '.claude-windows', 'w1');
      fs.mkdirSync(wd, { recursive: true });
      linkUserAssets(wd);
      assert.ok(fs.lstatSync(path.join(wd, 'skills')).isSymbolicLink());
      assert.equal(fs.existsSync(path.join(wd, 'plugins')), false, 'plugins stays per-window');
    });
  });

  it('leaves a real dir alone when its .bak already exists (never deletes)', () => {
    withHome((home) => {
      mkSource(home, 'skills', 'SKILL.md');
      const wd = path.join(home, '.claude-windows', 'w1');
      const local = path.join(wd, 'skills');
      fs.mkdirSync(`${local}.bak`, { recursive: true });
      fs.mkdirSync(local, { recursive: true });
      fs.writeFileSync(path.join(local, 'mine.md'), 'local');
      linkUserAssets(wd);
      assert.ok(fs.lstatSync(local).isDirectory(), 'real dir left in place');
      assert.ok(fs.existsSync(path.join(local, 'mine.md')), 'nothing deleted');
    });
  });

  it('is idempotent and replaces a stale link pointing elsewhere', () => {
    withHome((home) => {
      const src = mkSource(home, 'skills', 'SKILL.md');
      const other = mkSource(home, 'elsewhere', 'other.md');
      const wd = path.join(home, '.claude-windows', 'w1');
      fs.mkdirSync(wd, { recursive: true });
      const local = path.join(wd, 'skills');
      fs.symlinkSync(other, local);
      linkUserAssets(wd);
      assert.equal(path.normalize(fs.readlinkSync(local)), path.normalize(src));
      const inoAfterFirst = fs.lstatSync(local).ino;
      linkUserAssets(wd); // second run: a true no-op, not an unlink+relink churn
      assert.equal(path.normalize(fs.readlinkSync(local)), path.normalize(src));
      assert.equal(
        fs.lstatSync(local).ino,
        inoAfterFirst,
        'second run must not recreate the link (same inode)'
      );
    });
  });
});
