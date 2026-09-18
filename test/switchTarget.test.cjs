const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');

/**
 * setupWizard.ts imports vscode, so bundle it with the same minimal stub the
 * other unit suites use. Only the pure resolver is exercised here.
 */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `switch-target-${process.pid}-`));
const vscodeStub = path.join(tmpRoot, 'vscode-stub.js');
fs.writeFileSync(
  vscodeStub,
  `module.exports = {
     window: {
       createOutputChannel: () => ({ appendLine() {}, show() {} }),
       showWarningMessage: () => Promise.resolve(undefined),
       showInformationMessage: () => Promise.resolve(undefined),
       showErrorMessage: () => Promise.resolve(undefined),
       showQuickPick: () => Promise.resolve(undefined),
     },
     workspace: { workspaceFolders: undefined, getConfiguration: () => ({ get: (_k, d) => d }) },
     commands: { executeCommand: () => Promise.resolve(undefined) },
   };`
);
const bundleOut = path.join(tmpRoot, 'setupWizard.bundle.cjs');
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/setupWizard.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundleOut,
  alias: { vscode: vscodeStub },
});
const { resolveSwitchTarget } = require(bundleOut);

const alice = { name: 'alice' };
const bob = { name: 'bob' };
const candidates = [
  { account: alice, email: 'Alice@Example.com' },
  { account: bob, email: 'bob@example.com' },
  { account: { name: 'nameless' }, email: undefined },
];

describe('resolveSwitchTarget', () => {
  it('resolves an exact email to its account', () => {
    assert.equal(resolveSwitchTarget('bob@example.com', candidates), bob);
  });

  it('resolves case-insensitively, either way round', () => {
    assert.equal(resolveSwitchTarget('alice@example.com', candidates), alice);
    assert.equal(resolveSwitchTarget('BOB@EXAMPLE.COM', candidates), bob);
  });

  it('returns null for an email no saved account holds', () => {
    assert.equal(resolveSwitchTarget('nobody@example.com', candidates), null);
  });

  it('returns null for anything that is not a string', () => {
    for (const bad of [undefined, null, 42, {}, ['bob@example.com'], true]) {
      assert.equal(resolveSwitchTarget(bad, candidates), null, `rejects ${JSON.stringify(bad)}`);
    }
  });

  it('returns null for an empty or blank target, and never for a missing email', () => {
    assert.equal(resolveSwitchTarget('', candidates), null);
    assert.equal(resolveSwitchTarget('   ', candidates), null);
    assert.equal(resolveSwitchTarget('', [{ account: alice, email: undefined }]), null);
  });
});
