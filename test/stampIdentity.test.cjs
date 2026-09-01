const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `stamp-id-${process.pid}-`));
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
const bundleOut = path.join(tmpRoot, 'capture.bundle.cjs');
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/capture.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundleOut,
  alias: { vscode: vscodeStub },
});
const { stampIdentity, ensureIdentity } = require(bundleOut);

describe('stampIdentity / ensureIdentity', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-stamp-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('leaves an invalid-JSON .claude.json byte-identical', () => {
    const file = path.join(dir, '.claude.json');
    const bad = '{not json';
    fs.writeFileSync(file, bad);
    const before = fs.readFileSync(file);

    assert.equal(stampIdentity(dir, { email: 'new@ex.com', displayName: 'New' }), false);
    assert.deepEqual(fs.readFileSync(file), before);

    assert.equal(
      ensureIdentity(dir, { loggedIn: true, email: 'new@ex.com', orgName: 'Org' }),
      false
    );
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(fs.readFileSync(file, 'utf-8'), bad);
  });

  it('leaves array and number JSON files byte-identical and returns false', () => {
    for (const raw of ['[1,2,3]', '42', 'null']) {
      const file = path.join(dir, '.claude.json');
      fs.writeFileSync(file, raw);
      const before = fs.readFileSync(file);

      assert.equal(stampIdentity(dir, { email: 'new@ex.com', displayName: 'New' }), false);
      assert.deepEqual(fs.readFileSync(file), before);

      assert.equal(
        ensureIdentity(dir, { loggedIn: true, email: 'new@ex.com', orgName: 'Org' }),
        false
      );
      assert.deepEqual(fs.readFileSync(file), before);
      assert.equal(fs.readFileSync(file, 'utf-8'), raw);
    }
  });

  it('changes only oauthAccount on a valid .claude.json and returns true', () => {
    const file = path.join(dir, '.claude.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        theme: 'dark',
        mcpServers: { a: 1 },
        oauthAccount: { emailAddress: 'old@ex.com', uuid: 'keep-me', extra: 1 },
      })
    );

    assert.equal(
      stampIdentity(dir, { email: 'new@ex.com', displayName: 'New', organizationName: 'Org' }),
      true
    );
    let cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.equal(cfg.theme, 'dark');
    assert.deepEqual(cfg.mcpServers, { a: 1 });
    assert.equal(cfg.oauthAccount.emailAddress, 'new@ex.com');
    assert.equal(cfg.oauthAccount.displayName, 'New');
    assert.equal(cfg.oauthAccount.organizationName, 'Org');
    // stampIdentity replaces oauthAccount wholesale (a bled uuid must not linger).
    assert.equal(cfg.oauthAccount.uuid, undefined);
    assert.equal(cfg.oauthAccount.extra, undefined);

    fs.writeFileSync(
      file,
      JSON.stringify({
        theme: 'dark',
        mcpServers: { a: 1 },
        oauthAccount: { emailAddress: 'old@ex.com', uuid: 'keep-me', extra: 1 },
      })
    );
    assert.equal(
      ensureIdentity(dir, { loggedIn: true, email: 'new@ex.com', orgName: 'Org' }),
      true
    );
    cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.equal(cfg.theme, 'dark');
    assert.deepEqual(cfg.mcpServers, { a: 1 });
    assert.equal(cfg.oauthAccount.emailAddress, 'new@ex.com');
    assert.equal(cfg.oauthAccount.organizationName, 'Org');
    assert.equal(cfg.oauthAccount.uuid, 'keep-me');
    assert.equal(cfg.oauthAccount.extra, 1);
  });
});
