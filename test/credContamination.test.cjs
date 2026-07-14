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
  `globalThis.__vscodeCalls = globalThis.__vscodeCalls || { commands: [], reloadCount: 0 };
   const noopMsg = () => Promise.resolve(undefined);
   module.exports = {
     window: {
       createOutputChannel: () => ({ appendLine() {}, show() {} }),
       showWarningMessage: noopMsg,
       showInformationMessage: noopMsg,
       showErrorMessage: noopMsg,
     },
     commands: {
       executeCommand: (cmd) => {
         globalThis.__vscodeCalls.commands.push(cmd);
         if (cmd === 'workbench.action.reloadWindow') globalThis.__vscodeCalls.reloadCount++;
         return Promise.resolve(undefined);
       },
     },
   };`
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
const {
  refreshStore,
  foreignTokenConflict,
  sameCredential,
  credentialFingerprint,
  materialize,
  tokenExpiry,
  isStaleAgainstStore,
} = bundle('../src/workdir.ts', 'workdir.bundle.cjs');
const { snapshotAccount } = bundle('../src/capture.ts', 'capture.bundle.cjs');
const { SetupWizard } = bundle('../src/setupWizard.ts', 'setupWizard.bundle.cjs');

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

// Self-heal fixtures: one account, but the refresh token ROTATED (a new grant
// lineage) with a newer expiry — the shape of a token after Anthropic rotates it.
// GRANT_OLD is the stale copy a second window keeps; GRANT_NEW is what the window
// that refreshed (and the store) now holds. GRANT_NEW_SAMELINEAGE shares GRANT_OLD's
// refresh token (an access-token refresh in place) so it is NOT a different grant.
const GRANT_OLD = JSON.stringify({
  claudeAiOauth: { accessToken: 'AC1', refreshToken: 'ROT_1', expiresAt: 1000 },
});
const GRANT_NEW = JSON.stringify({
  claudeAiOauth: { accessToken: 'AC2', refreshToken: 'ROT_2', expiresAt: 2000 },
});
const GRANT_NEW_SAMELINEAGE = JSON.stringify({
  claudeAiOauth: { accessToken: 'AC1b', refreshToken: 'ROT_1', expiresAt: 2000 },
});
const GRANT_NOEXP = JSON.stringify({
  claudeAiOauth: { accessToken: 'AC3', refreshToken: 'ROT_3' },
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
  it("REFUSES to write another account's grant into a store", async () => {
    await withHomeAsync(async (home, mk) => {
      mk('.claude-a', 'a@example.com', TOKEN_A);
      const b = mk('.claude-b', 'b@example.com', TOKEN_B);
      // Working dir with a's token under b's identity (drift/mix).
      const wd = mk('wd', 'b@example.com', TOKEN_A);
      await refreshStore({ name: 'b', dir: b, email: 'b@example.com' }, wd);
      assert.equal(
        fs.readFileSync(path.join(b, '.credentials.json'), 'utf8'),
        TOKEN_B,
        'b store must be unchanged — the foreign grant was refused'
      );
    });
  });

  it("REFUSES an ACCESS-ROTATED copy of another account's grant (round-2 finding)", async () => {
    await withHomeAsync(async (home, mk) => {
      mk('.claude-a', 'a@example.com', TOKEN_A);
      const b = mk('.claude-b', 'b@example.com', TOKEN_B);
      // A's grant with a freshly rotated access token, wearing b's identity. Keying
      // on the access token would miss this; keying on the refresh token catches it.
      const wd = mk('wd', 'b@example.com', TOKEN_A_ACCESS_ROTATED);
      await refreshStore({ name: 'b', dir: b, email: 'b@example.com' }, wd);
      assert.equal(
        fs.readFileSync(path.join(b, '.credentials.json'), 'utf8'),
        TOKEN_B,
        'refused despite the access-token rotation — refresh token still identifies account A'
      );
    });
  });

  it('writes a legitimately refreshed same-account grant through', async () => {
    await withHomeAsync(async (home, mk) => {
      // b's own access-token refresh (same refresh token) must write through.
      const b = mk('.claude-b', 'b@example.com', TOKEN_B);
      const refreshed = JSON.stringify({
        claudeAiOauth: { accessToken: 'ACCESS_B2', refreshToken: 'REFRESH_B' },
      });
      const wd = mk('wd', 'b@example.com', refreshed);
      await refreshStore({ name: 'b', dir: b, email: 'b@example.com' }, wd);
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

describe('tokenExpiry / isStaleAgainstStore (self-heal staleness)', () => {
  it('reads expiresAt and returns null when absent/unparseable', () => {
    assert.equal(tokenExpiry(Buffer.from(GRANT_OLD)), 1000);
    assert.equal(tokenExpiry(Buffer.from(GRANT_NOEXP)), null);
    assert.equal(tokenExpiry(Buffer.from('not json')), null);
  });

  it('flags a strictly-older, DIFFERENT grant as stale', () => {
    // The second window's old copy vs the store's freshly-rotated grant.
    assert.equal(isStaleAgainstStore(Buffer.from(GRANT_OLD), Buffer.from(GRANT_NEW)), true);
  });

  it('does NOT flag the newer grant, the same lineage, equal expiry, or a missing expiry', () => {
    // The window that just refreshed is newer — not stale (must not be pulled back).
    assert.equal(isStaleAgainstStore(Buffer.from(GRANT_NEW), Buffer.from(GRANT_OLD)), false);
    // Same refresh token (access-token refresh in place) — same lineage, not stale.
    assert.equal(
      isStaleAgainstStore(Buffer.from(GRANT_OLD), Buffer.from(GRANT_NEW_SAMELINEAGE)),
      false
    );
    // Equal expiry, different grants — ambiguous, so never deemed stale (no flap).
    const eqA = JSON.stringify({ claudeAiOauth: { refreshToken: 'RX', expiresAt: 1000 } });
    const eqB = JSON.stringify({ claudeAiOauth: { refreshToken: 'RY', expiresAt: 1000 } });
    assert.equal(isStaleAgainstStore(Buffer.from(eqA), Buffer.from(eqB)), false);
    // A missing expiry can't be compared — never stale.
    assert.equal(isStaleAgainstStore(Buffer.from(GRANT_NOEXP), Buffer.from(GRANT_NEW)), false);
  });
});

describe('refreshStore newest-wins (self-heal: never regress the store)', () => {
  it("does NOT let a window's OLDER grant overwrite the store's newer one", async () => {
    await withHomeAsync(async (home, mk) => {
      // Store already holds the freshly-rotated grant; a second window still carries
      // the old copy. Its refreshStore must not drag the store backwards (the flap).
      const store = mk('.claude-b', 'b@example.com', GRANT_NEW);
      const wd = mk('wd', 'b@example.com', GRANT_OLD);
      await refreshStore({ name: 'b', dir: store, email: 'b@example.com' }, wd);
      assert.equal(
        fs.readFileSync(path.join(store, '.credentials.json'), 'utf8'),
        GRANT_NEW,
        'older window grant must not regress the newer store grant'
      );
    });
  });

  it('DOES adopt a strictly-newer grant from the window (the one that refreshed)', async () => {
    await withHomeAsync(async (home, mk) => {
      const store = mk('.claude-b', 'b@example.com', GRANT_OLD);
      const wd = mk('wd', 'b@example.com', GRANT_NEW);
      await refreshStore({ name: 'b', dir: store, email: 'b@example.com' }, wd);
      assert.equal(fs.readFileSync(path.join(store, '.credentials.json'), 'utf8'), GRANT_NEW);
    });
  });

  it('keeps the store when the incoming DIFFERENT grant has no parseable expiry (fail-closed)', async () => {
    await withHomeAsync(async (home, mk) => {
      const store = mk('.claude-b', 'b@example.com', GRANT_NEW); // valid, exp 2000
      const wd = mk('wd', 'b@example.com', GRANT_NOEXP); // different grant, no expiry
      await refreshStore({ name: 'b', dir: store, email: 'b@example.com' }, wd);
      assert.equal(
        fs.readFileSync(path.join(store, '.credentials.json'), 'utf8'),
        GRANT_NEW,
        'a grant that cannot be confirmed newer must not overwrite the store'
      );
    });
  });

  it('keeps the store against a foreign AND older grant (never regressed, either guard)', async () => {
    await withHomeAsync(async (home, mk) => {
      mk('.claude-a', 'a@example.com', TOKEN_A); // A's grant (foreign to b), expiresAt 1
      const store = mk('.claude-b', 'b@example.com', GRANT_NEW); // expiresAt 2000
      const wd = mk('wd', 'b@example.com', TOKEN_A); // foreign + older than the store
      await refreshStore({ name: 'b', dir: store, email: 'b@example.com' }, wd);
      assert.equal(fs.readFileSync(path.join(store, '.credentials.json'), 'utf8'), GRANT_NEW);
    });
  });

  it('repairs an UNPARSEABLE store with a valid incoming grant', async () => {
    await withHomeAsync(async (home, mk) => {
      const store = mk('.claude-b', 'b@example.com', 'not json at all'); // corrupt store token
      const wd = mk('wd', 'b@example.com', GRANT_NEW);
      await refreshStore({ name: 'b', dir: store, email: 'b@example.com' }, wd);
      assert.equal(
        fs.readFileSync(path.join(store, '.credentials.json'), 'utf8'),
        GRANT_NEW,
        'a valid grant may replace a corrupt/unparseable store'
      );
    });
  });
});

describe('tokenExpiry / isStaleAgainstStore edges', () => {
  it('tokenExpiry reads a flat (non-nested) expiresAt and rejects a non-number', () => {
    assert.equal(tokenExpiry(Buffer.from(JSON.stringify({ expiresAt: 4242 }))), 4242);
    assert.equal(
      tokenExpiry(Buffer.from(JSON.stringify({ claudeAiOauth: { expiresAt: 'soon' } }))),
      null
    );
  });

  it('isStaleAgainstStore is null-safe on the REFERENCE side too', () => {
    // reference (store) has no expiry → cannot prove the candidate older → not stale.
    assert.equal(isStaleAgainstStore(Buffer.from(GRANT_OLD), Buffer.from(GRANT_NOEXP)), false);
  });
});

// ─── healStaleTokenIfNeeded integration (the account-safety + loop-safety path) ───

/** Directory factory bound to a given HOME (shared by the async home helper). */
function mkInto(home) {
  return (dirName, email, token) => {
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
  };
}

/** Async-safe variant of withHome — awaits fn before tearing down HOME. */
async function withHomeAsync(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-heal-home-'));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn(home, mkInto(home));
  } finally {
    process.env.HOME = prev;
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/** SetupWizard over tiny fakes; resets the shared vscode-call recorder. */
function makeWizard({ envDir, activeName, account, stamp = 0 }) {
  globalThis.__vscodeCalls = { commands: [], reloadCount: 0 };
  const state = { stamp };
  const context = {
    workspaceState: {
      get: (k, d) => (k === 'claudeProfiles.lastAutoReload' ? state.stamp : d),
      update: (k, v) => {
        if (k === 'claudeProfiles.lastAutoReload') state.stamp = v;
        return Promise.resolve();
      },
    },
    globalState: { get: () => undefined, update: () => Promise.resolve() },
  };
  const binding = { getEnvDir: () => envDir, getActiveName: () => activeName };
  const registry = {
    get: (name) => (account && name === account.name ? account : undefined),
    emailOf: (a) => a && a.email,
  };
  return new SetupWizard(registry, binding, context);
}

// One account "a@", grant rotated old→new (different refresh tokens, newer expiry);
// FGN is a foreign grant with the highest expiry.
const A_OLD = JSON.stringify({
  claudeAiOauth: { accessToken: 'a1', refreshToken: 'RT_A_OLD', expiresAt: 1000 },
});
const A_NEW = JSON.stringify({
  claudeAiOauth: { accessToken: 'a2', refreshToken: 'RT_A_NEW', expiresAt: 2000 },
});
const FGN = JSON.stringify({
  claudeAiOauth: { accessToken: 'f', refreshToken: 'RT_FGN', expiresAt: 3000 },
});
const acc = (dir) => ({ name: 'a', dir, email: 'a@example.com' });

describe('healStaleTokenIfNeeded', () => {
  it('heals a stale window once (re-stocks token + reloads), then is a no-op (loop guard)', async () => {
    await withHomeAsync(async (home, mk) => {
      const store = mk('.claude-a', 'a@example.com', A_NEW);
      const wd = mk(path.join('.claude-windows', 'w1'), 'a@example.com', A_OLD);
      const wiz = makeWizard({ envDir: wd, activeName: 'a', account: acc(store) });

      const healed = await wiz.healStaleTokenIfNeeded();
      assert.equal(healed, true);
      assert.equal(globalThis.__vscodeCalls.reloadCount, 1);
      assert.equal(
        fs.readFileSync(path.join(wd, '.credentials.json'), 'utf8'),
        A_NEW,
        'window token re-stocked from the store BEFORE the reload (loop guard)'
      );
      // .claude.json (identity/project state) must be left as the window's own.
      assert.ok(fs.existsSync(path.join(wd, '.claude.json')));

      // Second call: dir now equals the store → not stale → no second reload.
      const again = await wiz.healStaleTokenIfNeeded();
      assert.equal(again, false);
      assert.equal(globalThis.__vscodeCalls.reloadCount, 1);
    });
  });

  it('does NOT heal when the store grant belongs to a different account (contamination guard)', async () => {
    await withHomeAsync(async (home, mk) => {
      // a@'s store holds a FOREIGN grant that also lives under b@ (dual-homed → caught).
      const store = mk('.claude-a', 'a@example.com', FGN);
      mk('.claude-b', 'b@example.com', FGN);
      const wd = mk(path.join('.claude-windows', 'w1'), 'a@example.com', A_OLD);
      const wiz = makeWizard({ envDir: wd, activeName: 'a', account: acc(store) });

      const healed = await wiz.healStaleTokenIfNeeded();
      assert.equal(healed, false);
      assert.equal(globalThis.__vscodeCalls.reloadCount, 0);
      assert.equal(
        fs.readFileSync(path.join(wd, '.credentials.json'), 'utf8'),
        A_OLD,
        'window must not be re-stocked from a foreign-token store'
      );
    });
  });

  it('does NOT heal across identity drift (reconcile owns that)', async () => {
    await withHomeAsync(async (home, mk) => {
      const store = mk('.claude-a', 'a@example.com', A_NEW);
      // Window identity says b@ but it is bound to a@ — drift.
      const wd = mk(path.join('.claude-windows', 'w1'), 'b@example.com', A_OLD);
      const wiz = makeWizard({ envDir: wd, activeName: 'a', account: acc(store) });

      assert.equal(await wiz.healStaleTokenIfNeeded(), false);
      assert.equal(globalThis.__vscodeCalls.reloadCount, 0);
    });
  });

  it('skips (no partial heal) when it reloaded within the cooldown', async () => {
    await withHomeAsync(async (home, mk) => {
      const store = mk('.claude-a', 'a@example.com', A_NEW);
      const wd = mk(path.join('.claude-windows', 'w1'), 'a@example.com', A_OLD);
      const wiz = makeWizard({ envDir: wd, activeName: 'a', account: acc(store), stamp: Date.now() });

      assert.equal(await wiz.healStaleTokenIfNeeded(), false);
      assert.equal(globalThis.__vscodeCalls.reloadCount, 0);
      assert.equal(
        fs.readFileSync(path.join(wd, '.credentials.json'), 'utf8'),
        A_OLD,
        'metered skip must leave the dir untouched'
      );
    });
  });

  it('defers (does not reload) when a turn resumed since the idle edge (isBusy)', async () => {
    await withHomeAsync(async (home, mk) => {
      const store = mk('.claude-a', 'a@example.com', A_NEW);
      const wd = mk(path.join('.claude-windows', 'w1'), 'a@example.com', A_OLD);
      const wiz = makeWizard({ envDir: wd, activeName: 'a', account: acc(store) });

      assert.equal(await wiz.healStaleTokenIfNeeded(() => true), false);
      assert.equal(globalThis.__vscodeCalls.reloadCount, 0);
      assert.equal(
        fs.readFileSync(path.join(wd, '.credentials.json'), 'utf8'),
        A_OLD,
        'no destructive step before the final turn re-check'
      );
    });
  });

  it('does not heal when the store has no credentials', async () => {
    await withHomeAsync(async (home, mk) => {
      const store = path.join(home, '.claude-a');
      fs.mkdirSync(store, { recursive: true });
      fs.writeFileSync(
        path.join(store, '.claude.json'),
        JSON.stringify({ oauthAccount: { emailAddress: 'a@example.com' } })
      );
      const wd = mk(path.join('.claude-windows', 'w1'), 'a@example.com', A_OLD);
      const wiz = makeWizard({ envDir: wd, activeName: 'a', account: acc(store) });

      assert.equal(await wiz.healStaleTokenIfNeeded(), false);
      assert.equal(globalThis.__vscodeCalls.reloadCount, 0);
    });
  });
});
