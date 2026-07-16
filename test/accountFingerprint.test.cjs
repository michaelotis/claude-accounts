const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');

/**
 * accounts.ts imports vscode (used only inside AccountRegistry methods, never at
 * module load) — bundle with the same minimal vscode stub the other unit bundles use.
 */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `acct-fp-${process.pid}-`));
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
const bundleOut = path.join(tmpRoot, 'accounts.bundle.cjs');
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/accounts.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundleOut,
  alias: { vscode: vscodeStub },
});
const { accountFingerprint } = require(bundleOut);

let n = 0;
function freshDir() {
  const dir = path.join(tmpRoot, `dir-${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeIdentity(dir, email, extra = {}) {
  fs.writeFileSync(
    path.join(dir, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: email, displayName: email }, ...extra })
  );
}

describe('accountFingerprint', () => {
  it('is stable across routine .claude.json rewrites (the turn-churn case)', () => {
    const dir = freshDir();
    const home = path.join(dir, 'home.claude.json');
    writeIdentity(dir, 'a@x.com', { projects: { p1: 1 } });
    fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ t: 'GRANT_A' }));
    const before = accountFingerprint(dir, home);
    // Claude Code rewrites the file constantly with non-identity content
    writeIdentity(dir, 'a@x.com', { projects: { p1: 2, p2: 'new' }, history: ['x'] });
    assert.equal(accountFingerprint(dir, home), before);
  });

  it('changes when the identity email changes (login as another account)', () => {
    const dir = freshDir();
    const home = path.join(dir, 'home.claude.json');
    writeIdentity(dir, 'a@x.com');
    fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ t: 'GRANT_A' }));
    const before = accountFingerprint(dir, home);
    writeIdentity(dir, 'b@y.com');
    assert.notEqual(accountFingerprint(dir, home), before);
  });

  it('changes when credentials are deleted (logout / forget)', () => {
    const dir = freshDir();
    const home = path.join(dir, 'home.claude.json');
    writeIdentity(dir, 'a@x.com');
    fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ t: 'GRANT_A' }));
    const before = accountFingerprint(dir, home);
    fs.rmSync(path.join(dir, '.credentials.json'));
    assert.notEqual(accountFingerprint(dir, home), before);
  });

  it('changes when the credential bytes change (token rotation)', () => {
    const dir = freshDir();
    const home = path.join(dir, 'home.claude.json');
    writeIdentity(dir, 'a@x.com');
    fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ t: 'GRANT_A' }));
    const before = accountFingerprint(dir, home);
    fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ t: 'GRANT_B' }));
    assert.notEqual(accountFingerprint(dir, home), before);
  });

  it('changes when the home-root identity changes', () => {
    const dir = freshDir();
    const home = path.join(dir, 'home.claude.json');
    writeIdentity(dir, 'a@x.com');
    fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ t: 'GRANT_A' }));
    const before = accountFingerprint(dir, home);
    fs.writeFileSync(
      home,
      JSON.stringify({ oauthAccount: { emailAddress: 'c@z.com', displayName: 'c' } })
    );
    assert.notEqual(accountFingerprint(dir, home), before);
  });

  it('tolerates a missing dir (signed-out window) and notices the first sign-in', () => {
    const dir = freshDir();
    const home = path.join(dir, 'home.claude.json');
    const before = accountFingerprint(dir, home);
    assert.equal(typeof before, 'string');
    writeIdentity(dir, 'a@x.com');
    fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ t: 'GRANT_A' }));
    assert.notEqual(accountFingerprint(dir, home), before);
  });

  it('email casing does not change the fingerprint', () => {
    const dir = freshDir();
    const home = path.join(dir, 'home.claude.json');
    writeIdentity(dir, 'A@X.com');
    fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ t: 'GRANT_A' }));
    const before = accountFingerprint(dir, home);
    writeIdentity(dir, 'a@x.COM');
    assert.equal(accountFingerprint(dir, home), before);
  });

  it('changes when the account STORE grant rotates (another window refreshed)', () => {
    const dir = freshDir();
    const home = path.join(dir, 'home.claude.json');
    const storeCreds = path.join(freshDir(), '.credentials.json');
    writeIdentity(dir, 'a@x.com');
    fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ t: 'GRANT_A' }));
    fs.writeFileSync(storeCreds, JSON.stringify({ t: 'GRANT_A' }));
    const before = accountFingerprint(dir, home, storeCreds);
    const beforeWithoutStore = accountFingerprint(dir, home);
    // Another window rotates the store grant; this dir's own files are untouched.
    fs.writeFileSync(storeCreds, JSON.stringify({ t: 'GRANT_A_ROTATED' }));
    assert.notEqual(accountFingerprint(dir, home, storeCreds), before);
    // Without the store component the rotation is invisible — the watch matters.
    assert.equal(accountFingerprint(dir, home), beforeWithoutStore);
  });
});
