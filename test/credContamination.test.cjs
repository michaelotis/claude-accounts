const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');

/**
 * workdir.ts / capture.ts import vscode via log. Bundle each with a minimal vscode
 * stub (alias — buildSync cannot use plugins), like the other unit bundles here.
 */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `cred-contam-${process.pid}-`));
const vscodeStub = path.join(tmpRoot, 'vscode-stub.js');
fs.writeFileSync(
  vscodeStub,
  `module.exports = { window: { createOutputChannel: () => ({ appendLine() {}, show() {} }) } };`
);
function bundle(entry, name) {
  const out = path.join(tmpRoot, name);
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, entry)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: out,
    alias: { vscode: vscodeStub },
  });
  return require(out);
}
const { refreshStore, foreignTokenConflict, sameCredential, credentialFingerprint, materialize } =
  bundle('../src/workdir.ts', 'workdir.bundle.cjs');
const { snapshotAccount } = bundle('../src/capture.ts', 'capture.bundle.cjs');

// Two DIFFERENT accounts (distinct refresh tokens). Fingerprinting keys on the
// refresh token — the stable account secret — NOT the access token, which rotates.
const grantA = { accessToken: 'ACCESS_A', refreshToken: 'REFRESH_A', expiresAt: 1 };
const grantB = { accessToken: 'ACCESS_B', refreshToken: 'REFRESH_B', expiresAt: 1 };
const TOKEN_A = JSON.stringify({ claudeAiOauth: grantA });
const TOKEN_B = JSON.stringify({ claudeAiOauth: grantB });
// Same account A, reordered keys + different expiresAt/whitespace.
const TOKEN_A_RESERIALIZED = JSON.stringify({
  claudeAiOauth: { expiresAt: 999999, refreshToken: 'REFRESH_A', accessToken: 'ACCESS_A' },
});
// Same account A after an ACCESS-token refresh (new access token, same refresh
// token) — the routine case that must still read as the SAME account, or a
// refreshed copy would slip past the contamination guard (round-2 finding).
const TOKEN_A_ACCESS_ROTATED = JSON.stringify({
  claudeAiOauth: { accessToken: 'ACCESS_A_v2', refreshToken: 'REFRESH_A', expiresAt: 5 },
});

/** Fresh isolated HOME per test — no shared fixture, so no order-coupling. */
function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-contam-home-'));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn(home, (dirName, email, token) => {
      const dir = path.join(home, dirName);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(dir, '.credentials.json'), token, { mode: 0o600 });
      if (email !== null) {
        fs.writeFileSync(
          path.join(dir, '.claude.json'),
          JSON.stringify({ oauthAccount: { emailAddress: email } }),
          { mode: 0o600 }
        );
      }
      return dir;
    });
  } finally {
    process.env.HOME = prev;
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

describe('credentialFingerprint / sameCredential', () => {
  it('is stable across re-serialization AND access-token rotation; differs by account', () => {
    const fp = (t) => credentialFingerprint(Buffer.from(t));
    // Keys on the refresh token: re-serialized OR access-rotated same account → equal.
    assert.equal(fp(TOKEN_A), fp(TOKEN_A_RESERIALIZED));
    assert.equal(fp(TOKEN_A), fp(TOKEN_A_ACCESS_ROTATED)); // access rotated, refresh same
    assert.notEqual(fp(TOKEN_A), fp(TOKEN_B)); // different account
    assert.ok(fp(TOKEN_A).startsWith('rt:')); // fingerprint is the refresh token
    // sameCredential is the thin wrapper used throughout the fix.
    assert.ok(sameCredential(Buffer.from(TOKEN_A), Buffer.from(TOKEN_A_ACCESS_ROTATED)));
    assert.ok(!sameCredential(Buffer.from(TOKEN_A), Buffer.from(TOKEN_B)));
  });
});

describe('foreignTokenConflict', () => {
  it('flags a grant that already belongs to a different-email account', () => {
    withHome((home, mk) => {
      const a = mk('.claude-a', 'a@example.com', TOKEN_A);
      const b = mk('.claude-b', 'b@example.com', TOKEN_B);
      const conflict = foreignTokenConflict(b, Buffer.from(TOKEN_A));
      assert.equal(conflict && path.normalize(conflict), path.normalize(a));
    });
  });

  it('flags a re-serialized copy of another account grant (value, not bytes)', () => {
    withHome((home, mk) => {
      const a = mk('.claude-a', 'a@example.com', TOKEN_A);
      const b = mk('.claude-b', 'b@example.com', TOKEN_B);
      // Byte-different but same underlying A grant, written toward B's store.
      const conflict = foreignTokenConflict(b, Buffer.from(TOKEN_A_RESERIALIZED));
      assert.equal(conflict && path.normalize(conflict), path.normalize(a));
    });
  });

  it("does not flag an account's own grant, a new grant, or a same-email duplicate", () => {
    withHome((home, mk) => {
      mk('.claude-a', 'a@example.com', TOKEN_A);
      const b = mk('.claude-b', 'b@example.com', TOKEN_B);
      mk('.claude-b2', 'b@example.com', TOKEN_B); // same email + grant — legitimate dup
      assert.equal(foreignTokenConflict(b, Buffer.from(TOKEN_B)), null);
      assert.equal(
        foreignTokenConflict(
          b,
          Buffer.from(JSON.stringify({ claudeAiOauth: { accessToken: 'NEW' } }))
        ),
        null
      );
    });
  });

  it('fails CLOSED when the target store identity is unreadable (uses email hint)', () => {
    withHome((home, mk) => {
      const a = mk('.claude-a', 'a@example.com', TOKEN_A);
      const x = mk('.claude-x', null, TOKEN_A); // token but NO identity file
      // Even with no readable identity, a sibling owning this grant under a known
      // different email is a conflict — the mix must not slip through.
      assert.equal(
        foreignTokenConflict(x, Buffer.from(TOKEN_A))?.replace(/\/+$/, ''),
        path.normalize(a)
      );
      // The email hint (account.email) resolves the target identity the same way.
      assert.ok(foreignTokenConflict(x, Buffer.from(TOKEN_A), 'x@example.com'));
    });
  });

  it('ignores reserved sidecar dirs (.claude-vault etc.)', () => {
    withHome((home, mk) => {
      mk('.claude-a', 'a@example.com', TOKEN_A);
      const b = mk('.claude-b', 'b@example.com', TOKEN_B);
      mk('.claude-vault', 'vault@example.com', TOKEN_B); // reserved — must be skipped
      assert.equal(foreignTokenConflict(b, Buffer.from(TOKEN_B)), null);
    });
  });
});

describe('refreshStore contamination guard', () => {
  it("REFUSES to write another account's grant into a store", () => {
    withHome((home, mk) => {
      mk('.claude-a', 'a@example.com', TOKEN_A);
      const b = mk('.claude-b', 'b@example.com', TOKEN_B);
      // Working dir with a's token under b's identity (drift/mix).
      const wd = mk('wd', 'b@example.com', TOKEN_A);
      refreshStore({ name: 'b', dir: b, email: 'b@example.com' }, wd);
      assert.equal(
        fs.readFileSync(path.join(b, '.credentials.json'), 'utf8'),
        TOKEN_B,
        'b store must be unchanged — the foreign grant was refused'
      );
    });
  });

  it("REFUSES an ACCESS-ROTATED copy of another account's grant (round-2 finding)", () => {
    withHome((home, mk) => {
      mk('.claude-a', 'a@example.com', TOKEN_A);
      const b = mk('.claude-b', 'b@example.com', TOKEN_B);
      // A's grant with a freshly rotated access token, wearing b's identity. Keying
      // on the access token would miss this; keying on the refresh token catches it.
      const wd = mk('wd', 'b@example.com', TOKEN_A_ACCESS_ROTATED);
      refreshStore({ name: 'b', dir: b, email: 'b@example.com' }, wd);
      assert.equal(
        fs.readFileSync(path.join(b, '.credentials.json'), 'utf8'),
        TOKEN_B,
        'refused despite the access-token rotation — refresh token still identifies account A'
      );
    });
  });

  it('writes a legitimately refreshed same-account grant through', () => {
    withHome((home, mk) => {
      // b's own access-token refresh (same refresh token) must write through.
      const b = mk('.claude-b', 'b@example.com', TOKEN_B);
      const refreshed = JSON.stringify({
        claudeAiOauth: { accessToken: 'ACCESS_B2', refreshToken: 'REFRESH_B' },
      });
      const wd = mk('wd', 'b@example.com', refreshed);
      refreshStore({ name: 'b', dir: b, email: 'b@example.com' }, wd);
      assert.equal(fs.readFileSync(path.join(b, '.credentials.json'), 'utf8'), refreshed);
    });
  });
});

describe('materialize (force overwrites a foreign token under a matching identity)', () => {
  it('force-restocks a dir that wears the account identity but holds a foreign grant', () => {
    withHome((home, mk) => {
      const bStore = mk('.claude-b', 'b@example.com', TOKEN_B);
      // Working dir labeled b@ but holding A's grant (a mix that a re-assert must fix).
      const wd = mk('wd', 'b@example.com', TOKEN_A);
      const wrote = materialize({ name: 'b', dir: bStore, email: 'b@example.com' }, wd, true);
      assert.ok(wrote);
      assert.equal(fs.readFileSync(path.join(wd, '.credentials.json'), 'utf8'), TOKEN_B);
    });
  });

  it('does NOT churn a dir already holding the same account grant (even access-rotated)', () => {
    withHome((home, mk) => {
      const bStore = mk('.claude-b', 'b@example.com', TOKEN_B);
      const rotated = JSON.stringify({
        claudeAiOauth: { accessToken: 'ACCESS_B_v2', refreshToken: 'REFRESH_B' },
      });
      const wd = mk('wd', 'b@example.com', rotated);
      const wrote = materialize({ name: 'b', dir: bStore, email: 'b@example.com' }, wd, true);
      assert.equal(wrote, false, 'same grant → skip');
      assert.equal(
        fs.readFileSync(path.join(wd, '.credentials.json'), 'utf8'),
        rotated,
        "the dir's newer access token is preserved"
      );
    });
  });

  it('without force, never overwrites a dir already running the account', () => {
    withHome((home, mk) => {
      const bStore = mk('.claude-b', 'b@example.com', TOKEN_B);
      const wd = mk('wd', 'b@example.com', TOKEN_A);
      const wrote = materialize({ name: 'b', dir: bStore, email: 'b@example.com' }, wd, false);
      assert.equal(wrote, false);
      assert.equal(fs.readFileSync(path.join(wd, '.credentials.json'), 'utf8'), TOKEN_A);
    });
  });
});

describe('snapshotAccount contamination guard (capture path)', () => {
  it("THROWS rather than minting a store from another account's grant", () => {
    withHome((home, mk) => {
      mk('.claude-a', 'a@example.com', TOKEN_A);
      // Source dir carries a's grant but we're trying to save it as c@.
      const src = mk('wd', 'c@example.com', TOKEN_A);
      const targetC = path.join(home, '.claude-c');
      assert.throws(
        () =>
          snapshotAccount(src, targetC, {
            loggedIn: true,
            email: 'c@example.com',
            orgName: null,
          }),
        /already belongs to/i
      );
      assert.ok(!fs.existsSync(path.join(targetC, '.credentials.json')));
    });
  });

  it('snapshots a genuinely new grant into a fresh store', () => {
    withHome((home, mk) => {
      mk('.claude-a', 'a@example.com', TOKEN_A);
      const fresh = JSON.stringify({ claudeAiOauth: { accessToken: 'NEW', refreshToken: 'NEWR' } });
      const src = mk('wd', 'c@example.com', fresh);
      const targetC = path.join(home, '.claude-c');
      snapshotAccount(src, targetC, { loggedIn: true, email: 'c@example.com', orgName: null });
      assert.equal(fs.readFileSync(path.join(targetC, '.credentials.json'), 'utf8'), fresh);
    });
  });
});
