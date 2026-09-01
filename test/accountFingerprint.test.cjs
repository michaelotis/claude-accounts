const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');

/**
 * accounts.ts imports vscode (used only inside AccountRegistry methods, never at
 * module load) — bundle with the same minimal vscode stub the other unit bundles use.
 * accountWatcher.ts implements vscode.Disposable (type-only) and pulls binding/capture;
 * the same stub is enough to load watchTargets.
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

const watcherOut = path.join(tmpRoot, 'accountWatcher.bundle.cjs');
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/accountWatcher.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: watcherOut,
  alias: { vscode: vscodeStub },
});
const { watchTargets } = require(watcherOut);

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

function withTempHome(fn) {
  const prevHome = process.env.HOME;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-fp-home-'));
  process.env.HOME = tmpHome;
  try {
    return fn(tmpHome);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

describe('accountFingerprint', () => {
  it('is stable across routine .claude.json rewrites (the turn-churn case)', () => {
    withTempHome(() => {
      const dir = freshDir();
      writeIdentity(dir, 'a@x.com', { projects: { p1: 1 } });
      fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ t: 'GRANT_A' }));
      const before = accountFingerprint(dir);
      assert.equal(before.split('|').length, 5);
      // Claude Code rewrites the file constantly with non-identity content
      writeIdentity(dir, 'a@x.com', { projects: { p1: 2, p2: 'new' }, history: ['x'] });
      assert.equal(accountFingerprint(dir), before);
    });
  });

  it('changes when the identity email changes (login as another account)', () => {
    withTempHome(() => {
      const dir = freshDir();
      writeIdentity(dir, 'a@x.com');
      fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ t: 'GRANT_A' }));
      const before = accountFingerprint(dir);
      writeIdentity(dir, 'b@y.com');
      assert.notEqual(accountFingerprint(dir), before);
    });
  });

  it('changes when credentials are deleted (logout / forget)', () => {
    withTempHome(() => {
      const dir = freshDir();
      writeIdentity(dir, 'a@x.com');
      fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ t: 'GRANT_A' }));
      const before = accountFingerprint(dir);
      fs.rmSync(path.join(dir, '.credentials.json'));
      assert.notEqual(accountFingerprint(dir), before);
    });
  });

  it('changes when the credential bytes change (token rotation)', () => {
    withTempHome(() => {
      const dir = freshDir();
      writeIdentity(dir, 'a@x.com');
      fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ t: 'GRANT_A' }));
      const before = accountFingerprint(dir);
      fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ t: 'GRANT_B' }));
      assert.notEqual(accountFingerprint(dir), before);
    });
  });

  it('ignores the home-root identity for a bound dir', () => {
    withTempHome((tmpHome) => {
      const dir = freshDir();
      writeIdentity(dir, 'a@x.com');
      fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ t: 'GRANT_A' }));
      const before = accountFingerprint(dir);
      fs.writeFileSync(
        path.join(tmpHome, '.claude.json'),
        JSON.stringify({ oauthAccount: { emailAddress: 'c@z.com', displayName: 'c' } })
      );
      assert.equal(accountFingerprint(dir), before);
    });
  });

  it('follows the home-root identity for the default dir', () => {
    withTempHome((tmpHome) => {
      const dir = path.join(tmpHome, '.claude');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ t: 'GRANT_A' }));
      fs.writeFileSync(
        path.join(tmpHome, '.claude.json'),
        JSON.stringify({ oauthAccount: { emailAddress: 'a@x.com', displayName: 'a' } })
      );
      const before = accountFingerprint(dir);
      fs.writeFileSync(
        path.join(tmpHome, '.claude.json'),
        JSON.stringify({ oauthAccount: { emailAddress: 'c@z.com', displayName: 'c' } })
      );
      assert.notEqual(accountFingerprint(dir), before);
    });
  });

  it('default dir still follows the home-root identity when ~/.claude/.claude.json names another email', () => {
    withTempHome((tmpHome) => {
      const dir = path.join(tmpHome, '.claude');
      fs.mkdirSync(dir, { recursive: true });
      writeIdentity(dir, 'inside@ex.com');
      fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ t: 'GRANT_A' }));
      fs.writeFileSync(
        path.join(tmpHome, '.claude.json'),
        JSON.stringify({ oauthAccount: { emailAddress: 'home@ex.com', displayName: 'home' } })
      );
      const before = accountFingerprint(dir);
      fs.writeFileSync(
        path.join(tmpHome, '.claude.json'),
        JSON.stringify({ oauthAccount: { emailAddress: 'other@ex.com', displayName: 'other' } })
      );
      assert.notEqual(accountFingerprint(dir), before);
    });
  });

  it('deleting the default token changes a bound dir fingerprint; rewriting its bytes does not', () => {
    withTempHome((tmpHome) => {
      const dir = freshDir();
      writeIdentity(dir, 'a@x.com');
      fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ t: 'GRANT_A' }));
      const defaultCreds = path.join(tmpHome, '.claude', '.credentials.json');
      fs.mkdirSync(path.dirname(defaultCreds), { recursive: true });
      fs.writeFileSync(defaultCreds, JSON.stringify({ t: 'GRANT_DEFAULT' }));
      const before = accountFingerprint(dir);
      fs.writeFileSync(defaultCreds, JSON.stringify({ t: 'GRANT_DEFAULT_OTHER' }));
      assert.equal(accountFingerprint(dir), before);
      fs.rmSync(defaultCreds);
      assert.notEqual(accountFingerprint(dir), before);
    });
  });

  it('tolerates a missing dir (signed-out window) and notices the first sign-in', () => {
    withTempHome(() => {
      const dir = freshDir();
      const before = accountFingerprint(dir);
      assert.equal(typeof before, 'string');
      writeIdentity(dir, 'a@x.com');
      fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ t: 'GRANT_A' }));
      assert.notEqual(accountFingerprint(dir), before);
    });
  });

  it('email casing does not change the fingerprint', () => {
    withTempHome(() => {
      const dir = freshDir();
      writeIdentity(dir, 'A@X.com');
      fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ t: 'GRANT_A' }));
      const before = accountFingerprint(dir);
      writeIdentity(dir, 'a@x.COM');
      assert.equal(accountFingerprint(dir), before);
    });
  });

  it('changes when the account STORE grant rotates (another window refreshed)', () => {
    withTempHome(() => {
      const dir = freshDir();
      const storeCreds = path.join(freshDir(), '.credentials.json');
      writeIdentity(dir, 'a@x.com');
      fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ t: 'GRANT_A' }));
      fs.writeFileSync(storeCreds, JSON.stringify({ t: 'GRANT_A' }));
      const before = accountFingerprint(dir, storeCreds);
      const beforeWithoutStore = accountFingerprint(dir);
      // Another window rotates the store grant; this dir's own files are untouched.
      fs.writeFileSync(storeCreds, JSON.stringify({ t: 'GRANT_A_ROTATED' }));
      assert.notEqual(accountFingerprint(dir, storeCreds), before);
      // Without the store component the rotation is invisible — the watch matters.
      assert.equal(accountFingerprint(dir), beforeWithoutStore);
    });
  });

  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  it(
    'unreadable bound-dir credentials yield ? not absent',
    { skip: isRoot ? 'running as root — chmod 000 does not deny access' : false },
    () => {
      withTempHome(() => {
        const dir = freshDir();
        writeIdentity(dir, 'a@x.com');
        const creds = path.join(dir, '.credentials.json');
        fs.writeFileSync(creds, JSON.stringify({ t: 'GRANT_A' }));
        fs.chmodSync(creds, 0o000);
        try {
          const fp = accountFingerprint(dir);
          assert.equal(fp.split('|')[2], '?');
          const absentDir = freshDir();
          writeIdentity(absentDir, 'a@x.com');
          const absent = accountFingerprint(absentDir);
          assert.equal(absent.split('|')[2], '');
          assert.notEqual(fp.split('|')[2], absent.split('|')[2]);
        } finally {
          fs.chmodSync(creds, 0o600);
        }
      });
    }
  );

  it(
    'defaultToken is ? when stat throws (permissions)',
    { skip: isRoot ? 'running as root — chmod 000 does not deny access' : false },
    () => {
      withTempHome((tmpHome) => {
        const dir = freshDir();
        writeIdentity(dir, 'a@x.com');
        fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ t: 'GRANT_A' }));
        const claudeDir = path.join(tmpHome, '.claude');
        fs.mkdirSync(claudeDir, { recursive: true });
        fs.writeFileSync(path.join(claudeDir, '.credentials.json'), 'secret');
        fs.chmodSync(claudeDir, 0o000);
        try {
          const fp = accountFingerprint(dir);
          assert.equal(fp.split('|')[4], '?');
        } finally {
          fs.chmodSync(claudeDir, 0o700);
        }
      });
    }
  );
});

describe('watchTargets', () => {
  it('bound dir contains default creds and not ~/.claude.json', () => {
    withTempHome((tmpHome) => {
      const bound = path.join(tmpHome, 'window-1');
      const storeCreds = path.join(tmpHome, '.claude-work', '.credentials.json');
      const targets = watchTargets(bound, storeCreds);
      assert.ok(targets.includes(path.join(bound, '.claude.json')));
      assert.ok(targets.includes(path.join(bound, '.credentials.json')));
      assert.ok(targets.includes(path.join(tmpHome, '.claude', '.credentials.json')));
      assert.ok(targets.includes(storeCreds));
      assert.ok(!targets.includes(path.join(tmpHome, '.claude.json')));
    });
  });

  it('watchTargets(bound) with no store excludes ~/.claude.json and includes the default token', () => {
    withTempHome((tmpHome) => {
      const bound = path.join(tmpHome, 'window-1');
      const targets = watchTargets(bound);
      assert.ok(targets.includes(path.join(tmpHome, '.claude', '.credentials.json')));
      assert.ok(!targets.includes(path.join(tmpHome, '.claude.json')));
    });
  });

  it('default dir contains both ~/.claude/.credentials.json and ~/.claude.json', () => {
    withTempHome((tmpHome) => {
      const defaultDir = path.join(tmpHome, '.claude');
      const targets = watchTargets(defaultDir);
      assert.ok(targets.includes(path.join(defaultDir, '.claude.json')));
      assert.ok(targets.includes(path.join(defaultDir, '.credentials.json')));
      assert.ok(targets.includes(path.join(tmpHome, '.claude.json')));
    });
  });

  it('watchTargets(defaultDir, storeCreds) includes ~/.claude.json and the store file', () => {
    withTempHome((tmpHome) => {
      const defaultDir = path.join(tmpHome, '.claude');
      const storeCreds = path.join(tmpHome, '.claude-work', '.credentials.json');
      const targets = watchTargets(defaultDir, storeCreds);
      assert.ok(targets.includes(path.join(tmpHome, '.claude.json')));
      assert.ok(targets.includes(storeCreds));
    });
  });
});
