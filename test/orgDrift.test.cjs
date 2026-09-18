const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');

/** capture.ts / usage.ts / setupWizard.ts import vscode — bundle with a stub. */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `org-drift-${process.pid}-`));
const vscodeStub = path.join(tmpRoot, 'vscode-stub.js');
fs.writeFileSync(
  vscodeStub,
  `module.exports = {
     window: {
       createOutputChannel: () => ({ appendLine() {}, show() {} }),
       showWarningMessage: () => Promise.resolve(undefined),
       showInformationMessage: () => Promise.resolve(undefined),
       showErrorMessage: () => Promise.resolve(undefined),
       withProgress: (_opts, fn) => fn(),
     },
     ProgressLocation: { Notification: 15 },
     commands: { executeCommand: () => Promise.resolve(undefined) },
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

const { ensureIdentity, mirrorToDefault, observedDisplayName } = bundle(
  '../src/capture.ts',
  'capture.bundle.cjs'
);
const { SetupWizard } = bundle('../src/setupWizard.ts', 'wizard.bundle.cjs');
const { UsageMonitor, __ageInProcessStateForTests } = bundle('../src/usage.ts', 'usage.bundle.cjs');

function writeIdentity(dir, oauthAccount, rest = {}) {
  fs.writeFileSync(
    path.join(dir, '.claude.json'),
    JSON.stringify({ ...rest, oauthAccount }, null, 2)
  );
}

/** A non-expiring grant so ensureFreshToken takes its fast path (no OAuth POST). */
function credentials() {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: 'at-test',
      refreshToken: 'rt-test',
      expiresAt: Date.now() + 3_600_000,
    },
  });
}

function writeCreds(dir) {
  fs.writeFileSync(path.join(dir, '.credentials.json'), credentials());
}

/** Body of a 200 /api/oauth/usage response. */
function usageBody(session = 7, weekly = 8) {
  return JSON.stringify({
    five_hour: { utilization: session, resets_at: null },
    seven_day: { utilization: weekly, resets_at: null },
    limits: [],
    extra_usage: { is_enabled: false },
  });
}

function stubFetch(responses) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const r = responses.shift() ?? { status: 200, body: usageBody() };
    return {
      status: r.status,
      headers: { get: () => null },
      text: async () => r.body ?? '',
    };
  };
  calls.restore = () => {
    globalThis.fetch = real;
  };
  return calls;
}

/**
 * A window dir bound to an account store, under a fresh isolated HOME (the shared
 * usage cache and locks live there). The keepalive interval is the same guard the
 * other usage suites need: withLockAsync waits on unref'd timers, which under
 * node:test would let the event loop drain mid-await.
 */
async function withPair(storeOauth, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-org-home-'));
  const prev = process.env.HOME;
  process.env.HOME = home;
  // A fresh HOME is a fresh machine: the in-process attempt clock is keyed by
  // account, so without this one test's call gap would gate the next.
  __ageInProcessStateForTests(3_600_000);
  const keepalive = setInterval(() => {}, 50);
  try {
    const windowDir = path.join(home, '.claude-windows', 'w1');
    const storeDir = path.join(home, '.claude-acct');
    fs.mkdirSync(windowDir, { recursive: true });
    fs.mkdirSync(storeDir, { recursive: true });
    writeIdentity(
      windowDir,
      { emailAddress: 'a@x.com', displayName: 'A', organizationName: 'New Org' },
      { theme: 'dark' }
    );
    writeIdentity(storeDir, storeOauth, { theme: 'dark', mcpServers: { a: 1 } });
    writeCreds(windowDir);
    writeCreds(storeDir);
    return await fn({ home, windowDir, storeDir });
  } finally {
    clearInterval(keepalive);
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

async function pollOnce(windowDir, storeDir, responses = [{ status: 200, body: usageBody(5, 6) }]) {
  const calls = stubFetch(responses);
  const monitor = new UsageMonitor(60_000);
  monitor.configure({ storeDirForEmail: () => storeDir });
  try {
    const snap = await monitor.refresh(windowDir);
    return { snap, calls: calls.length };
  } finally {
    monitor.dispose();
    calls.restore();
  }
}

/**
 * Drives the real save path: `captureCurrentAccount` on an account the registry
 * already knows, which is what both "Save current account" and a detected
 * sign-in end up calling. Only the VS Code-side collaborators are stubbed.
 */
async function captureInto(account, sourceDir) {
  const registry = {
    savedForEmail: () => account,
    add: async () => {},
    restoreForgotten: async () => undefined,
    get: () => undefined,
    emailOf: () => account.email,
  };
  const binding = { getEnvDir: () => sourceDir, bind: async () => {} };
  const context = {
    workspaceState: { get: () => undefined, update: async () => {} },
    globalState: { get: () => undefined, update: async () => {} },
    subscriptions: [],
  };
  const wizard = new SetupWizard(registry, binding, context);
  return wizard.captureCurrentAccount({ quiet: true, silent: true, sourceDir });
}

describe('ensureIdentity (organization drift on a matching email)', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-org-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('rewrites an organization-only drift and leaves every other key untouched', () => {
    const file = path.join(dir, '.claude.json');
    const before = {
      theme: 'dark',
      mcpServers: { a: 1 },
      projects: { '/p': { allowedTools: ['x'] } },
      oauthAccount: {
        emailAddress: 'a@x.com',
        displayName: 'A',
        organizationName: 'Old Org',
        uuid: 'keep-me',
      },
    };
    fs.writeFileSync(file, JSON.stringify(before, null, 2));

    assert.equal(
      ensureIdentity(dir, {
        loggedIn: true,
        email: 'a@x.com',
        orgName: 'New Org',
        displayName: 'A',
      }),
      true
    );

    const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.equal(after.oauthAccount.organizationName, 'New Org');
    assert.equal(after.oauthAccount.emailAddress, 'a@x.com');
    assert.equal(after.oauthAccount.displayName, 'A');
    assert.equal(after.oauthAccount.uuid, 'keep-me', 'other oauthAccount fields survive');
    const strip = (o) => {
      const rest = { ...o };
      delete rest.oauthAccount;
      return JSON.stringify(rest, null, 2);
    };
    assert.equal(strip(after), strip(before), 'every other key byte-identical');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  it('writes nothing when email, organization and display name all match', () => {
    const file = path.join(dir, '.claude.json');
    // Written UNindented on purpose: any rewrite re-serializes at 2 spaces, so
    // the bytes are a real detector and not a same-content coincidence.
    fs.writeFileSync(
      file,
      JSON.stringify({
        theme: 'dark',
        oauthAccount: { emailAddress: 'a@x.com', displayName: 'A', organizationName: 'Org' },
      })
    );
    const bytes = fs.readFileSync(file);
    const mtimeMs = fs.statSync(file).mtimeMs;

    assert.equal(
      ensureIdentity(dir, { loggedIn: true, email: 'a@x.com', orgName: 'Org', displayName: 'A' }),
      true
    );

    assert.deepEqual(fs.readFileSync(file), bytes, 'bytes unchanged');
    assert.equal(fs.statSync(file).mtimeMs, mtimeMs, 'mtime unchanged');
  });

  it('refuses an invalid-JSON and a non-object config without writing', () => {
    const file = path.join(dir, '.claude.json');
    for (const raw of ['{not json', '[1,2,3]', 'null', '42']) {
      fs.writeFileSync(file, raw);
      const bytes = fs.readFileSync(file);
      assert.equal(
        ensureIdentity(dir, { loggedIn: true, email: 'a@x.com', orgName: 'New Org' }),
        false,
        raw
      );
      assert.deepEqual(fs.readFileSync(file), bytes, raw);
    }
  });

  it('refuses a config it cannot read without writing', () => {
    // A directory where the config should be: read fails with something other
    // than ENOENT, which is the case that must never be mistaken for "no file
    // yet, start from {}". Unlike a chmod fixture this holds for any user.
    const file = path.join(dir, '.claude.json');
    fs.mkdirSync(file);

    assert.equal(
      ensureIdentity(dir, { loggedIn: true, email: 'a@x.com', orgName: 'New Org' }),
      false
    );

    assert.equal(fs.statSync(file).isDirectory(), true, 'nothing was written over it');
    assert.deepEqual(fs.readdirSync(file), [], 'and nothing was written inside it');
  });

  it('does not rewrite when the incoming organization is empty or absent', () => {
    const file = path.join(dir, '.claude.json');
    for (const orgName of [undefined, '']) {
      fs.writeFileSync(
        file,
        JSON.stringify({
          oauthAccount: { emailAddress: 'a@x.com', displayName: 'A', organizationName: 'Old Org' },
        })
      );
      const bytes = fs.readFileSync(file);
      const mtimeMs = fs.statSync(file).mtimeMs;
      assert.equal(ensureIdentity(dir, { loggedIn: true, email: 'a@x.com', orgName }), true);
      assert.deepEqual(fs.readFileSync(file), bytes, `orgName=${JSON.stringify(orgName)}`);
      assert.equal(
        fs.statSync(file).mtimeMs,
        mtimeMs,
        `mtime unchanged for orgName=${JSON.stringify(orgName)}`
      );
      const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
      assert.equal(after.oauthAccount.organizationName, 'Old Org', 'nothing was blanked');
    }
  });

  it('repairs a display-name-only drift and leaves the organization alone', () => {
    const file = path.join(dir, '.claude.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        theme: 'dark',
        oauthAccount: { emailAddress: 'a@x.com', displayName: 'Old Name', organizationName: 'Org' },
      })
    );

    assert.equal(
      ensureIdentity(dir, {
        loggedIn: true,
        email: 'a@x.com',
        orgName: 'Org',
        displayName: 'New Name',
      }),
      true
    );

    const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.equal(after.oauthAccount.displayName, 'New Name');
    assert.equal(after.oauthAccount.organizationName, 'Org', 'the organization did not move');
    assert.equal(after.theme, 'dark');
  });

  it('drops the previous account fields when the email changes', () => {
    const file = path.join(dir, '.claude.json');
    const previous = {
      theme: 'dark',
      projects: { '/p': { allowedTools: ['x'] } },
      oauthAccount: {
        emailAddress: 'old@ex.com',
        displayName: 'Old Person',
        organizationName: 'Old Org',
        organizationUuid: 'org-1',
        organizationRole: 'admin',
        workspaceRole: 'member',
        accountUuid: 'acct-1',
      },
    };
    fs.writeFileSync(file, JSON.stringify(previous));

    assert.equal(ensureIdentity(dir, { loggedIn: true, email: 'new@ex.com' }), true);

    const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.equal(after.oauthAccount.emailAddress, 'new@ex.com');
    for (const key of [
      'organizationName',
      'displayName',
      'organizationUuid',
      'organizationRole',
      'workspaceRole',
      'accountUuid',
    ]) {
      assert.equal(after.oauthAccount[key], undefined, `${key} is not carried across accounts`);
    }
    assert.equal(after.theme, 'dark', 'the config around the identity is untouched');
    assert.deepEqual(after.projects, previous.projects);

    // The incoming account's OWN names are written, not the ones just dropped.
    fs.writeFileSync(file, JSON.stringify(previous));
    assert.equal(
      ensureIdentity(dir, {
        loggedIn: true,
        email: 'new@ex.com',
        orgName: 'New Org',
        displayName: 'New Person',
      }),
      true
    );
    const replaced = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.equal(replaced.oauthAccount.organizationName, 'New Org');
    assert.equal(replaced.oauthAccount.displayName, 'New Person');
    assert.equal(replaced.oauthAccount.accountUuid, undefined);
  });

  it('treats a casing-only email difference as the same account', () => {
    const file = path.join(dir, '.claude.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        oauthAccount: {
          emailAddress: 'A@X.com',
          displayName: 'A',
          organizationName: 'Org',
          accountUuid: 'acct-1',
        },
      })
    );
    const bytes = fs.readFileSync(file);
    const mtimeMs = fs.statSync(file).mtimeMs;

    assert.equal(
      ensureIdentity(dir, { loggedIn: true, email: 'a@x.com', orgName: 'Org', displayName: 'A' }),
      true
    );
    assert.deepEqual(fs.readFileSync(file), bytes, 'a casing-only difference is not a drift');
    assert.equal(fs.statSync(file).mtimeMs, mtimeMs, 'mtime unchanged');

    assert.equal(
      ensureIdentity(dir, {
        loggedIn: true,
        email: 'a@x.com',
        orgName: 'New Org',
        displayName: 'A',
      }),
      true
    );
    const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.equal(after.oauthAccount.organizationName, 'New Org');
    assert.equal(after.oauthAccount.accountUuid, 'acct-1', 'the same account keeps its own ids');
  });

  it('does not spread a truthy non-object oauthAccount', () => {
    const file = path.join(dir, '.claude.json');
    for (const bogus of ['nope', ['a', 'b']]) {
      fs.writeFileSync(file, JSON.stringify({ theme: 'dark', oauthAccount: bogus }));
      assert.equal(
        ensureIdentity(dir, { loggedIn: true, email: 'a@x.com', orgName: 'Org', displayName: 'A' }),
        true
      );
      const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
      assert.deepEqual(
        after.oauthAccount,
        { emailAddress: 'a@x.com', organizationName: 'Org', displayName: 'A' },
        `oauthAccount=${JSON.stringify(bogus)}`
      );
      assert.equal(after.theme, 'dark');
    }
  });
});

describe('stampHomeIdentity (~/.claude.json, via mirrorToDefault)', () => {
  let home;
  let prevHome;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-org-stamp-'));
    process.env.HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('carries no organization, display name or account-scoped id across an email change', () => {
    const sourceDir = path.join(home, '.claude-new');
    fs.mkdirSync(sourceDir, { recursive: true });
    writeCreds(sourceDir);
    writeIdentity(sourceDir, { emailAddress: 'new@ex.com', displayName: 'New Person' });
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({
        theme: 'dark',
        projects: { '/p': { allowedTools: ['x'] } },
        oauthAccount: {
          emailAddress: 'old@ex.com',
          displayName: 'Old Person',
          organizationName: 'Old Org',
          organizationUuid: 'org-1',
          organizationRole: 'admin',
          workspaceRole: 'member',
          accountUuid: 'acct-1',
          uuid: 'keep-me',
        },
      })
    );

    assert.equal(mirrorToDefault(sourceDir, { takeover: true }), true);

    const cfg = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf-8'));
    assert.equal(cfg.oauthAccount.emailAddress, 'new@ex.com');
    assert.equal(cfg.oauthAccount.displayName, 'New Person');
    assert.equal(cfg.oauthAccount.organizationName, undefined, 'the old organization is dropped');
    for (const key of ['organizationUuid', 'organizationRole', 'workspaceRole', 'accountUuid']) {
      assert.equal(cfg.oauthAccount[key], undefined, `${key} is not carried across accounts`);
    }
    assert.equal(cfg.oauthAccount.uuid, 'keep-me', 'config-scoped fields still survive');
    assert.equal(cfg.theme, 'dark', 'the config around the identity is untouched');
    assert.deepEqual(cfg.projects, { '/p': { allowedTools: ['x'] } });
  });
});

describe('capture: saving an account corrects a store that fell behind', () => {
  it("writes the window's organization into the store it just saved", async () => {
    await withPair(
      {
        emailAddress: 'a@x.com',
        displayName: 'A',
        organizationName: 'Old Org',
        uuid: 'keep-me',
      },
      async ({ windowDir, storeDir }) => {
        const saved = await captureInto(
          { name: 'acct', dir: storeDir, email: 'a@x.com' },
          windowDir
        );
        assert.equal(saved?.name, 'acct');

        const cfg = JSON.parse(fs.readFileSync(path.join(storeDir, '.claude.json'), 'utf-8'));
        assert.equal(cfg.oauthAccount.organizationName, 'New Org', 'store repaired on capture');
        assert.equal(cfg.oauthAccount.emailAddress, 'a@x.com');
        assert.equal(cfg.oauthAccount.uuid, 'keep-me');
        assert.equal(cfg.theme, 'dark', 'the rest of the store config survives');
        assert.deepEqual(cfg.mcpServers, { a: 1 });
      }
    );
  });

  it('leaves a store that already agrees byte-identical', async () => {
    await withPair(
      { emailAddress: 'a@x.com', displayName: 'A', organizationName: 'New Org' },
      async ({ windowDir, storeDir }) => {
        const file = path.join(storeDir, '.claude.json');
        const bytes = fs.readFileSync(file);
        const mtimeMs = fs.statSync(file).mtimeMs;

        await captureInto({ name: 'acct', dir: storeDir, email: 'a@x.com' }, windowDir);

        assert.deepEqual(fs.readFileSync(file), bytes, 'nothing to correct, nothing written');
        assert.equal(fs.statSync(file).mtimeMs, mtimeMs, 'mtime unchanged');
      }
    );
  });
});

describe('poll: a usage poll never rewrites an account store', () => {
  it('leaves the store alone and reports the organization the store carries', async () => {
    // Whichever window polls, the store is left exactly as it is: the poll has no
    // way to tell whether its window's copy is fresher than the store's (Claude
    // Code rewrites a window's .claude.json constantly, so its timestamp says
    // nothing), and two windows disagreeing would flip the shared file forever.
    await withPair(
      { emailAddress: 'a@x.com', displayName: 'A', organizationName: 'Old Org' },
      async ({ windowDir, storeDir }) => {
        const file = path.join(storeDir, '.claude.json');
        // Stamp the window's copy as the newer of the two: a poll that decided
        // freshness from a timestamp would take that as licence to write, and
        // the point is that nothing does.
        const base = Math.floor(Date.now() / 1000);
        fs.utimesSync(file, base, base);
        fs.utimesSync(path.join(windowDir, '.claude.json'), base + 10, base + 10);
        const bytes = fs.readFileSync(file);
        const mtimeMs = fs.statSync(file).mtimeMs;

        const { snap, calls } = await pollOnce(windowDir, storeDir);

        assert.equal(calls, 1, 'the poll still ran');
        assert.deepEqual(fs.readFileSync(file), bytes, 'the store was not rewritten');
        assert.equal(fs.statSync(file).mtimeMs, mtimeMs, 'the store was not even re-stamped');
        assert.equal(snap.sessionPercent, 5);
        assert.equal(snap.orgName, 'Old Org', "the snapshot names the store's own organization");
      }
    );
  });
});

describe('observedDisplayName', () => {
  it('drops the email fallback so it cannot overwrite a real display name', () => {
    // readIdentity substitutes the email when the file carries no name.
    assert.equal(observedDisplayName({ email: 'a@x.com', displayName: 'a@x.com' }), undefined);
    assert.equal(observedDisplayName({ email: 'a@x.com', displayName: 'A@X.com' }), undefined);
  });

  it('passes a genuinely observed name through', () => {
    assert.equal(observedDisplayName({ email: 'a@x.com', displayName: 'Ada' }), 'Ada');
  });

  it('is undefined for a missing identity or name', () => {
    assert.equal(observedDisplayName(null), undefined);
    assert.equal(observedDisplayName({ email: 'a@x.com' }), undefined);
  });
});
