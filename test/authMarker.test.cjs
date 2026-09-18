const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');

/** usage.ts imports vscode via log — bundle with the minimal stub, like the others. */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `auth-marker-${process.pid}-`));
const vscodeStub = path.join(tmpRoot, 'vscode-stub.js');
fs.writeFileSync(
  vscodeStub,
  `global.__caLog = global.__caLog || [];
   module.exports = {
     window: {
       createOutputChannel: () => ({
         appendLine(s) { global.__caLog.push(s); },
         show() {},
       }),
       showWarningMessage: () => Promise.resolve(undefined),
       showInformationMessage: () => Promise.resolve(undefined),
       showErrorMessage: () => Promise.resolve(undefined),
     },
     commands: { executeCommand: () => Promise.resolve(undefined) },
   };`
);
const bundleOut = path.join(tmpRoot, 'usage.bundle.cjs');
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/usage.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundleOut,
  alias: { vscode: vscodeStub },
});
const {
  UsageMonitor,
  AUTH_REJECT_WINDOW_MS,
  BACKGROUND_TTL_MS,
  RATE_LIMIT_BACKOFF_MS,
  usageCacheKey,
  policyDir,
  policyPath,
  __ageInProcessStateForTests,
} = require(bundleOut);

const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';

const REFUSED_AFTER_REFRESH =
  'Claude rejected this window’s token after refresh. Sign in again with Claude Code (/login).';

/**
 * Fresh isolated HOME per test, with the ref'd keepalive the lock waits need
 * under node:test (see centralUsage.test.cjs for why an unref'd timer cancels
 * the file). Two saved accounts: `b` is polled in the background, `a` is the
 * one a window would be signed in as. `account()` makes any further one a test
 * needs (a broken store, an email with stray spaces).
 */
async function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-auth-marker-home-'));
  const prev = process.env.HOME;
  process.env.HOME = home;
  __ageInProcessStateForTests(3_600_000);
  const keepalive = setInterval(() => {}, 50);
  try {
    const a = makeAccount(home, 'a', 'a@x.com');
    const b = makeAccount(home, 'b', 'b@y.com');
    const account = (name, email, opts) => makeAccount(home, name, email, opts);
    return await fn({ home, a, b, account });
  } finally {
    clearInterval(keepalive);
    process.env.HOME = prev;
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function makeAccount(home, name, email, opts = {}) {
  const dir = path.join(home, `store-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: email } })
  );
  writeCreds(dir, opts);
  // `opts` rides along so poll()'s restock keeps the store the test asked for.
  return { dir, email, opts };
}

/**
 * An expired grant, so every poll goes through the OAuth refresh POST.
 * `noToken` writes the other kind of broken store: a credentials file that is
 * there (so the account is still polled) with nothing in it to authenticate
 * with. `token` names the grant — a different one is what a `/login` leaves
 * behind, and the only thing that gets a marked account polled again.
 */
function writeCreds(dir, { noToken = false, token = 'rt-test' } = {}) {
  fs.writeFileSync(
    path.join(dir, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: noToken
        ? {}
        : { accessToken: 'at-test', refreshToken: token, expiresAt: Date.now() - 60_000 },
    })
  );
}

function usageBody(session = 7, weekly = 8) {
  return JSON.stringify({
    five_hour: { utilization: session, resets_at: null },
    seven_day: { utilization: weekly, resets_at: null },
    limits: [],
    extra_usage: { is_enabled: false },
  });
}

function res(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => body,
  };
}

/**
 * Replace global fetch with a handler keyed on the URL, so a test can answer the
 * OAuth refresh and the usage poll independently and drive the REAL rejection
 * path (a 401 on the refresh) rather than a seam that skips it.
 */
function stubFetch(handler) {
  const calls = [];
  const real = globalThis.fetch;
  // The request, not just the URL: the refresh POST carries the account's
  // refresh token and the usage GET the bearer minted from it, which is the
  // only way to say WHOSE call a call on a shared endpoint was.
  calls.requests = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    calls.requests.push({
      url: String(url),
      body: String(init?.body ?? ''),
      auth: String(init?.headers?.Authorization ?? ''),
    });
    return handler(String(url), init);
  };
  calls.restore = () => {
    globalThis.fetch = real;
  };
  return calls;
}

/** Every call made on behalf of the account whose grant is `token`. */
function callsFor(calls, token) {
  return calls.requests.filter((r) => r.body.includes(token) || r.auth.includes(token));
}

/**
 * The scripted network for one test: `mode` decides what the next poll meets.
 * `reject` = Claude refuses the refresh token (invalid_grant), `ok` = a normal
 * refresh + 200 usage, `rate_limited` = HTTP 429 on the poll, `network` = the
 * request itself fails. `usage_401` / `usage_403` hand out a perfectly good
 * token and then refuse the usage call with it — the two answers that look alike
 * on the wire and mean opposite things about the grant.
 */
function scriptedNetwork(state) {
  return stubFetch((url) => {
    if (state.mode === 'network') throw new Error('ECONNRESET');
    if (url === TOKEN_URL) {
      if (state.mode === 'reject') return res(401, JSON.stringify({ error: 'invalid_grant' }));
      return res(
        200,
        JSON.stringify({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600 })
      );
    }
    if (state.mode === 'rate_limited') return res(429, 'rate limited');
    if (state.mode === 'usage_401') return res(401, 'unauthorized');
    if (state.mode === 'usage_403') return res(403, 'forbidden');
    return res(200, usageBody());
  });
}

/**
 * Like scriptedNetwork, but it tells the accounts apart: an account is refused
 * when `state.reject` holds its refresh token, and the access token minted for
 * it is `at-<its refresh token>`, so the usage GET's bearer names the account
 * too. That makes "zero network calls for THIS account" a countable thing while
 * another account is being polled on the very same cycles.
 */
function perAccountNetwork(state) {
  return stubFetch((url, init) => {
    if (url === TOKEN_URL) {
      const rt = JSON.parse(String(init.body)).refresh_token;
      if (state.reject.has(rt)) return res(401, JSON.stringify({ error: 'invalid_grant' }));
      return res(
        200,
        JSON.stringify({ access_token: `at-${rt}`, refresh_token: rt, expires_in: 3600 })
      );
    }
    return res(200, usageBody());
  });
}

function monitorFor(accounts) {
  const monitor = new UsageMonitor(60_000);
  monitor.listAccountsToPoll = () => accounts.map((x) => ({ email: x.email, dir: x.dir }));
  return monitor;
}

/**
 * One background poll cycle, then travel past the in-process minimum call gap so
 * the next cycle really reaches the network (the extension's own timer is longer
 * than the gap; the test would otherwise be served best-effort figures).
 */
async function poll(monitor, account) {
  await monitor.refreshAllAccounts();
  if (account) writeCreds(account.dir, account.opts); // the refresh POST may have restocked it
  __ageInProcessStateForTests(130_000);
}

/**
 * The same cycle for several accounts at once, each restocked and each pushed
 * past the background tier — so an account that IS being polled really reaches
 * the network on every cycle, and an account that is not can be told apart from
 * one merely served out of the shared cache.
 */
async function pollAll(monitor, accounts) {
  await monitor.refreshAllAccounts();
  for (const acc of accounts) {
    writeCreds(acc.dir, acc.opts);
    stalePolledEntry(acc, false);
  }
  __ageInProcessStateForTests(130_000);
}

/**
 * Run fn with this process's wall clock moved forward. The rejection window is
 * measured against Date.now on an in-memory stamp, which
 * __ageInProcessStateForTests does not reach — it rewinds the recorded call
 * times and the meta memo, and poll() still calls it inside here.
 */
async function afterMs(ms, fn) {
  const real = Date.now;
  Date.now = () => real.call(Date) + ms;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

function cachePath() {
  return path.join(policyDir(), 'usage-cache.json');
}

/**
 * Push this account's shared cache entry past the background tier. `required`
 * off is for the accounts a test expects to have no entry at all (nothing was
 * ever read from them) alongside ones that do.
 */
function stalePolledEntry(account, required = true) {
  let cache;
  try {
    cache = JSON.parse(fs.readFileSync(cachePath(), 'utf-8'));
  } catch {
    assert.ok(!required, 'the poll should have cached a reading');
    return;
  }
  const entry = cache.entries[usageCacheKey(account.dir, account.email)];
  if (!entry && !required) return;
  assert.ok(entry, 'the poll should have cached a reading');
  entry.fetchedAt -= BACKGROUND_TTL_MS + 100_000;
  entry.snap.fetchedAt -= BACKGROUND_TTL_MS + 100_000;
  fs.writeFileSync(cachePath(), JSON.stringify(cache));
}

/** A reading another window made `ageMs` ago, straight into the shared cache. */
function cacheReading(account, ageMs) {
  let cache = { entries: {} };
  try {
    cache = JSON.parse(fs.readFileSync(cachePath(), 'utf-8'));
  } catch {
    /* nothing cached yet */
  }
  const key = usageCacheKey(account.dir, account.email);
  const fetchedAt = Date.now() - ageMs;
  cache.entries[key] = { key, fetchedAt, snap: { ...snapFor(account, fetchedAt) } };
  fs.mkdirSync(policyDir(), { recursive: true });
  fs.writeFileSync(cachePath(), JSON.stringify(cache));
}

function snapFor(account, fetchedAt) {
  return {
    sessionPercent: 11,
    sessionResetsAt: null,
    weeklyPercent: 12,
    weeklyResetsAt: null,
    opusPercent: null,
    opusResetsAt: null,
    sonnetPercent: null,
    sonnetResetsAt: null,
    modelLimits: [],
    overagePercent: null,
    email: account.email.trim(),
    orgName: null,
    planLabel: null,
    fetchedAt,
    configDir: account.dir,
  };
}

/**
 * The cross-window policy file, carrying a row for this account stamped `ageMs`
 * ago. bestEffortSnap falls through to it when nothing is cached, and the row's
 * fetchedAt is whichever window last wrote the file — not a reading of ours.
 */
function policyRow(account, ageMs) {
  fs.mkdirSync(policyDir(), { recursive: true });
  fs.writeFileSync(
    policyPath(),
    JSON.stringify({
      version: 3,
      updatedAt: Date.now(),
      accounts: [
        {
          id: account.email.trim(),
          email: account.email.trim(),
          dir: account.dir,
          sessionPercent: 21,
          weeklyPercent: 22,
          fablePercent: null,
          hot: false,
          reasons: [],
          planLabel: null,
          fetchedAt: Date.now() - ageMs,
        },
      ],
    })
  );
}

/** Spend this account's 429 record, so the next refresh really reaches the network. */
function endRateLimitBackoff(account) {
  const file = path.join(policyDir(), 'usage-meta.json');
  const meta = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const rec = meta.backoff?.[usageCacheKey(account.dir, account.email)];
  assert.ok(rec, 'the 429 should have stamped a backoff');
  rec.at -= RATE_LIMIT_BACKOFF_MS + 10_000;
  rec.until -= RATE_LIMIT_BACKOFF_MS + 10_000;
  fs.writeFileSync(file, JSON.stringify(meta));
  __ageInProcessStateForTests(0); // drop the meta memo so the rewind is seen
}

describe('background sign-in rejection marker', () => {
  it('one refusal marks nothing; a second one marks the email', async () => {
    await withHome(async ({ b }) => {
      const state = { mode: 'reject' };
      const calls = scriptedNetwork(state);
      const monitor = monitorFor([b]);
      try {
        await poll(monitor, b);
        assert.deepEqual([...monitor.getRejectedEmails()], [], 'one refusal is not a sign-out');

        await poll(monitor, b);
        assert.deepEqual(
          [...monitor.getRejectedEmails()],
          ['b@y.com'],
          'two in a row is the account, not the race'
        );
        assert.equal(calls.length, 2, 'both polls really asked');
      } finally {
        monitor.dispose();
        calls.restore();
      }
    });
  });

  it('a 403 after a good refresh never marks, and still reads the same to the active window', async () => {
    await withHome(async ({ a, b }) => {
      // The refresh POST succeeds — Claude hands out a new token and then refuses
      // the usage call made with it. Org policy, a plan that has no meter, or the
      // endpoint being switched off all answer exactly this way, and no amount of
      // signing in again would move any of them.
      const state = { mode: 'usage_403' };
      const calls = scriptedNetwork(state);
      const monitor = monitorFor([a, b]);
      monitor.setActiveDir(a.dir);
      try {
        for (let i = 0; i < 2; i++) {
          await poll(monitor);
          writeCreds(a.dir);
          writeCreds(b.dir);
        }
        assert.deepEqual(
          [...monitor.getRejectedEmails()],
          [],
          'a 403 says nothing about the grant, however often it comes'
        );
        // Unchanged where it does belong: the window whose own account this is
        // still gets the same refusal, in the same words, with the same status.
        assert.equal(monitor.lastFailure?.kind, 'token_rejected');
        assert.equal(monitor.lastFailure?.status, 403);
        assert.equal(monitor.lastFailure?.message, REFUSED_AFTER_REFRESH);
      } finally {
        monitor.dispose();
        calls.restore();
      }
    });
  });

  it('a 401 on the usage call after a fresh token is the grant, and marks', async () => {
    await withHome(async ({ b }) => {
      const state = { mode: 'usage_401' };
      const calls = scriptedNetwork(state);
      const monitor = monitorFor([b]);
      try {
        await poll(monitor, b);
        assert.deepEqual([...monitor.getRejectedEmails()], []);

        await poll(monitor, b);
        assert.deepEqual(
          [...monitor.getRejectedEmails()],
          ['b@y.com'],
          'a token minted seconds ago and refused is the account, not the endpoint'
        );
      } finally {
        monitor.dispose();
        calls.restore();
      }
    });
  });

  it('a store with no access token is broken, not refused', async () => {
    await withHome(async ({ account }) => {
      const d = account('d', 'd@w.com', { noToken: true });
      const state = { mode: 'ok' };
      const calls = scriptedNetwork(state);
      const monitor = monitorFor([d]);
      try {
        await poll(monitor, d);
        await poll(monitor, d);
        assert.deepEqual(
          [...monitor.getRejectedEmails()],
          [],
          'nothing was refused — there was nothing to be refused with'
        );
        assert.equal(calls.length, 0, 'and nothing was ever asked');
      } finally {
        monitor.dispose();
        calls.restore();
      }
    });
  });

  it('a success between two refusals resets the count', async () => {
    await withHome(async ({ b }) => {
      const state = { mode: 'reject' };
      const calls = scriptedNetwork(state);
      const monitor = monitorFor([b]);
      try {
        await poll(monitor, b);

        state.mode = 'ok';
        await poll(monitor, b);
        assert.deepEqual([...monitor.getRejectedEmails()], []);
        stalePolledEntry(b); // else the next poll is served from the cache

        state.mode = 'reject';
        await poll(monitor, b);
        assert.deepEqual([...monitor.getRejectedEmails()], [], 'the refusals were not consecutive');

        await poll(monitor, b);
        assert.deepEqual([...monitor.getRejectedEmails()], ['b@y.com'], 'these two were');
      } finally {
        monitor.dispose();
        calls.restore();
      }
    });
  });

  it('two refusals far enough apart are two incidents, not a pair', async () => {
    await withHome(async ({ b }) => {
      const state = { mode: 'reject' };
      const calls = scriptedNetwork(state);
      const monitor = monitorFor([b]);
      try {
        await poll(monitor, b);

        await afterMs(AUTH_REJECT_WINDOW_MS + 5 * 60_000, async () => {
          await poll(monitor, b);
          assert.deepEqual(
            [...monitor.getRejectedEmails()],
            [],
            'a refusal that old is its own incident, not the first of a pair'
          );

          // It does start a new pair, though: the one that follows it promptly
          // confirms it. The rule is two refusals running, not two refusals ever.
          await poll(monitor, b);
          assert.deepEqual(
            [...monitor.getRejectedEmails()],
            ['b@y.com'],
            'two inside the window are the account'
          );
        });
      } finally {
        monitor.dispose();
        calls.restore();
      }
    });
  });

  it('a long gap before the next refusal does not take a confirmed marker off', async () => {
    await withHome(async ({ b }) => {
      const state = { mode: 'reject' };
      const calls = scriptedNetwork(state);
      const monitor = monitorFor([b]);
      try {
        await poll(monitor, b);
        await poll(monitor, b);
        assert.deepEqual([...monitor.getRejectedEmails()], ['b@y.com']);

        // The machine slept: the next refusal lands well outside the window. It is
        // still a refusal, and nothing has said the grant is good again.
        const gap = AUTH_REJECT_WINDOW_MS + 60 * 60_000;
        await afterMs(gap, async () => {
          await poll(monitor, b);
          assert.deepEqual([...monitor.getRejectedEmails()], ['b@y.com']);
        });
        // The call times recorded under the shifted clock are module state keyed
        // by email; left in the future they would gap-block the next case's polls.
        __ageInProcessStateForTests(gap);
      } finally {
        monitor.dispose();
        calls.restore();
      }
    });
  });

  it('the first success after marking clears the row', async () => {
    await withHome(async ({ b }) => {
      const state = { mode: 'reject' };
      const calls = scriptedNetwork(state);
      const monitor = monitorFor([b]);
      try {
        await poll(monitor, b);
        await poll(monitor, b);
        assert.deepEqual([...monitor.getRejectedEmails()], ['b@y.com']);

        // What a recovery actually looks like: the user signs in, so a different
        // grant is on disk and the background loop asks again. (On the refused
        // grant it no longer asks at all — a refused refresh token never starts
        // answering, and the row already says to sign in.)
        state.mode = 'ok';
        b.opts = { token: 'rt-after-login' };
        writeCreds(b.dir, b.opts);
        await poll(monitor, b);
        assert.deepEqual([...monitor.getRejectedEmails()], [], 'one success is enough to clear');
      } finally {
        monitor.dispose();
        calls.restore();
      }
    });
  });

  it('a 429 or a network error neither marks nor clears', async () => {
    await withHome(async ({ b }) => {
      // Poll it properly once first, then age the entry past the tier: what a 429
      // or an unreachable API serves is this account's own last real figures, so
      // the test turns on where they came from, not on their being zeros.
      const state = { mode: 'ok' };
      const calls = scriptedNetwork(state);
      const monitor = monitorFor([b]);
      try {
        await poll(monitor, b);
        stalePolledEntry(b);

        state.mode = 'network';
        await poll(monitor, b);
        await poll(monitor, b);
        assert.deepEqual(
          [...monitor.getRejectedEmails()],
          [],
          'an unreachable API is not a refused sign-in'
        );

        state.mode = 'reject';
        await poll(monitor, b);
        await poll(monitor, b);
        assert.deepEqual([...monitor.getRejectedEmails()], ['b@y.com']);

        state.mode = 'network';
        await poll(monitor, b);
        assert.deepEqual(
          [...monitor.getRejectedEmails()],
          ['b@y.com'],
          'an old reading handed back after a network error is not a new one'
        );

        state.mode = 'rate_limited';
        await poll(monitor, b);
        assert.deepEqual(
          [...monitor.getRejectedEmails()],
          ['b@y.com'],
          'a 429 hands back that same old reading, and it clears nothing'
        );
      } finally {
        monitor.dispose();
        calls.restore();
      }
    });
  });

  it('a best-effort snap built from the policy file does not clear a marker', async () => {
    await withHome(async ({ b }) => {
      const state = { mode: 'reject' };
      const calls = scriptedNetwork(state);
      const monitor = monitorFor([b]);
      try {
        await poll(monitor, b);
        await poll(monitor, b);
        assert.deepEqual([...monitor.getRejectedEmails()], ['b@y.com']);

        // Nothing is cached for a refused account, so the next best-effort snap
        // comes from policy.json — whose fetchedAt is whichever window last wrote
        // the file. Recent, and no reading of this account by anyone here.
        policyRow(b, 5_000);

        state.mode = 'network';
        await poll(monitor, b);
        assert.deepEqual(
          [...monitor.getRejectedEmails()],
          ['b@y.com'],
          'a recent timestamp on a row we did not fetch is not a reading'
        );
      } finally {
        monitor.dispose();
        calls.restore();
      }
    });
  });

  it('the active account is never marked, however often it is refused', async () => {
    await withHome(async ({ a, b }) => {
      const state = { mode: 'reject' };
      const calls = scriptedNetwork(state);
      const monitor = monitorFor([a, b]);
      monitor.setActiveDir(a.dir);
      try {
        for (let i = 0; i < 3; i++) {
          await poll(monitor);
          writeCreds(a.dir);
          writeCreds(b.dir);
        }
        assert.equal(monitor.lastFailure?.kind, 'token_rejected', 'the active path did escalate');
        // Control: the same refusals on the same cycles DID mark the background
        // account, so the exclusion is the active row's own path, not a dead test.
        assert.deepEqual([...monitor.getRejectedEmails()], ['b@y.com']);
      } finally {
        monitor.dispose();
        calls.restore();
      }
    });
  });

  it('a success as the active account clears a marker earned in the background', async () => {
    await withHome(async ({ a, b }) => {
      const state = { mode: 'reject' };
      const calls = scriptedNetwork(state);
      const monitor = monitorFor([a, b]);
      monitor.setActiveDir(a.dir);
      try {
        for (let i = 0; i < 2; i++) {
          await poll(monitor);
          writeCreds(a.dir);
          writeCreds(b.dir);
        }
        assert.deepEqual([...monitor.getRejectedEmails()], ['b@y.com']);

        // The user switches to it and signs in: the active path polls it now, and
        // the background loop — the only other thing that clears a marker — skips it.
        state.mode = 'ok';
        monitor.setActiveDir(b.dir);
        assert.ok(await monitor.refresh(b.dir, true), 'the active poll succeeded');
        assert.deepEqual([...monitor.getRejectedEmails()], []);
      } finally {
        monitor.dispose();
        calls.restore();
      }
    });
  });

  it('a marker survives a 429 and an unreachable API on the active path', async () => {
    await withHome(async ({ b }) => {
      const state = { mode: 'reject' };
      const calls = scriptedNetwork(state);
      const monitor = monitorFor([b]);
      try {
        await poll(monitor, b);
        await poll(monitor, b);
        assert.deepEqual([...monitor.getRejectedEmails()], ['b@y.com']);

        // Switched to, and Refresh Usage pressed — but every answer below still
        // hands back last-known figures, which is what the user was already
        // looking at and no evidence the account can be polled again.
        monitor.setActiveDir(b.dir);

        state.mode = 'rate_limited';
        await monitor.refresh(b.dir, true);
        assert.deepEqual(
          [...monitor.getRejectedEmails()],
          ['b@y.com'],
          'a 429 is the poll budget, not the grant'
        );
        endRateLimitBackoff(b);
        __ageInProcessStateForTests(130_000);

        state.mode = 'network';
        await monitor.refresh(b.dir, true);
        assert.deepEqual(
          [...monitor.getRejectedEmails()],
          ['b@y.com'],
          'nor does an unreachable API say anything about it'
        );
        __ageInProcessStateForTests(130_000);

        state.mode = 'ok';
        writeCreds(b.dir);
        assert.ok(await monitor.refresh(b.dir, true), 'the account really answered this time');
        assert.deepEqual(
          [...monitor.getRejectedEmails()],
          [],
          'and a real reading is what takes the marker off'
        );
      } finally {
        monitor.dispose();
        calls.restore();
      }
    });
  });

  it('a forced refresh answered from the cache clears a marker when that reading is live', async () => {
    await withHome(async ({ b }) => {
      const state = { mode: 'reject' };
      const calls = scriptedNetwork(state);
      const monitor = monitorFor([b]);
      try {
        await poll(monitor, b);
        await poll(monitor, b);
        assert.deepEqual([...monitor.getRejectedEmails()], ['b@y.com']);

        // Switch → /login → Refresh Usage, seconds after another window polled
        // the account: the forced refresh is answered from the shared cache
        // without a call of its own, and that entry is the only evidence there
        // will be until this window's own next poll comes due.
        cacheReading(b, 10_000);
        monitor.setActiveDir(b.dir);
        const before = calls.length;
        assert.ok(await monitor.refresh(b.dir, true), 'the cached reading was served');
        assert.equal(calls.length, before, 'and it cost no call of its own');
        assert.equal(
          typeof monitor.lastServedFromCacheAgeMs,
          'number',
          'the already-fresh branch is the one that ran'
        );
        assert.deepEqual([...monitor.getRejectedEmails()], []);
      } finally {
        monitor.dispose();
        calls.restore();
      }
    });
  });

  it('an email stored with stray spaces is the same row to both paths', async () => {
    await withHome(async ({ account }) => {
      const c = account('c', '  c@z.com  ');
      const state = { mode: 'reject' };
      const calls = scriptedNetwork(state);
      const monitor = monitorFor([c]);
      try {
        await poll(monitor, c);
        await poll(monitor, c);
        assert.deepEqual(
          [...monitor.getRejectedEmails()],
          ['c@z.com'],
          'the map is keyed on the trimmed email, like every other key'
        );

        state.mode = 'ok';
        monitor.setActiveDir(c.dir);
        assert.ok(await monitor.refresh(c.dir, true), 'the active poll succeeded');
        assert.deepEqual(
          [...monitor.getRejectedEmails()],
          [],
          'and the active path looked up that same key'
        );
      } finally {
        monitor.dispose();
        calls.restore();
      }
    });
  });

  it('repaints only when the marked set changes', async () => {
    await withHome(async ({ b }) => {
      const state = { mode: 'reject' };
      const calls = scriptedNetwork(state);
      const monitor = monitorFor([b]);
      let emits = 0;
      const sub = monitor.onChange(() => emits++);
      try {
        await poll(monitor, b);
        assert.equal(emits, 0, 'a first refusal changes nothing on screen');

        await poll(monitor, b);
        assert.equal(emits, 1, 'the row gained its marker');

        await poll(monitor, b);
        assert.equal(emits, 1, 'a third refusal says nothing new');

        // Signed in again: a different grant, so the account is polled once more.
        state.mode = 'ok';
        b.opts = { token: 'rt-after-login' };
        writeCreds(b.dir, b.opts);
        await poll(monitor, b);
        assert.equal(emits, 2, 'the marker came off');
      } finally {
        sub.dispose();
        monitor.dispose();
        calls.restore();
      }
    });
  });
});

describe('holding off a refused account', () => {
  it('a confirmed refusal costs nothing per cycle, and only that account stops', async () => {
    await withHome(async ({ account }) => {
      const dead = account('dead', 'dead@x.com', { token: 'rt-dead' });
      const live = account('live', 'live@x.com', { token: 'rt-live' });
      const state = { reject: new Set(['rt-dead']) };
      const calls = perAccountNetwork(state);
      const monitor = monitorFor([dead, live]);
      try {
        for (let i = 0; i < 2; i++) await pollAll(monitor, [dead, live]);
        assert.deepEqual([...monitor.getRejectedEmails()], ['dead@x.com']);
        const asked = callsFor(calls, 'rt-dead').length;
        assert.ok(asked >= 2, 'it really was asked on the way to being marked');

        for (let i = 0; i < 3; i++) {
          const liveBefore = callsFor(calls, 'rt-live').length;
          await pollAll(monitor, [dead, live]);
          assert.ok(
            callsFor(calls, 'rt-live').length > liveBefore,
            'the healthy account was polled on this same cycle'
          );
        }
        assert.equal(
          callsFor(calls, 'rt-dead').length,
          asked,
          'and the refused one cost no call at all — not the token POST either'
        );
        assert.deepEqual(
          [...monitor.getRejectedEmails()],
          ['dead@x.com'],
          'it stays marked the whole time it is left alone'
        );
      } finally {
        monitor.dispose();
        calls.restore();
      }
    });
  });

  it('new credentials on disk are what start the calls again', async () => {
    await withHome(async ({ b }) => {
      const state = { mode: 'reject' };
      const calls = scriptedNetwork(state);
      const monitor = monitorFor([b]);
      try {
        await poll(monitor, b);
        await poll(monitor, b);
        assert.deepEqual([...monitor.getRejectedEmails()], ['b@y.com']);

        const held = calls.length;
        await poll(monitor, b);
        assert.equal(calls.length, held, 'the same grant is not worth asking about again');

        // The user signs in: a different refresh token is sitting in the store,
        // and that is the one thing that can change the answer.
        state.mode = 'ok';
        b.opts = { token: 'rt-after-login' };
        writeCreds(b.dir, b.opts);
        await poll(monitor, b);
        assert.ok(calls.length > held, 'a different grant is');
        assert.deepEqual(
          [...monitor.getRejectedEmails()],
          [],
          'and it answered, so the marker came off'
        );
      } finally {
        monitor.dispose();
        calls.restore();
      }
    });
  });

  it('a new grant that is refused too keeps the marker on and re-forms the hold', async () => {
    await withHome(async ({ b }) => {
      const state = { mode: 'reject' };
      const calls = scriptedNetwork(state);
      const monitor = monitorFor([b]);
      try {
        await poll(monitor, b);
        await poll(monitor, b);
        assert.deepEqual([...monitor.getRejectedEmails()], ['b@y.com']);

        b.opts = { token: 'rt-second-try' };
        writeCreds(b.dir, b.opts);
        const before = calls.length;
        await poll(monitor, b);
        assert.ok(calls.length > before, 'the new grant was tried');
        assert.deepEqual(
          [...monitor.getRejectedEmails()],
          ['b@y.com'],
          'refused again — the marker never flickered off to find that out'
        );

        const after = calls.length;
        await poll(monitor, b);
        await poll(monitor, b);
        assert.equal(calls.length, after, 'and the hold re-formed, on the new grant');
        assert.deepEqual([...monitor.getRejectedEmails()], ['b@y.com']);
      } finally {
        monitor.dispose();
        calls.restore();
      }
    });
  });

  it('Refresh Usage buys exactly one more attempt and changes no marker', async () => {
    await withHome(async ({ b }) => {
      const state = { mode: 'reject' };
      const calls = scriptedNetwork(state);
      const monitor = monitorFor([b]);
      try {
        await poll(monitor, b);
        await poll(monitor, b);
        await poll(monitor, b);
        assert.deepEqual([...monitor.getRejectedEmails()], ['b@y.com']);
        const held = calls.length;

        monitor.retryRejected();
        assert.deepEqual(
          [...monitor.getRejectedEmails()],
          ['b@y.com'],
          'asking us to look again is not evidence that anything changed'
        );

        await poll(monitor, b);
        const asked = calls.length;
        assert.ok(asked > held, 'the click bought an attempt');
        assert.deepEqual([...monitor.getRejectedEmails()], ['b@y.com'], 'refused again');

        await poll(monitor, b);
        await poll(monitor, b);
        assert.equal(calls.length, asked, 'exactly one attempt, then the hold again');

        // A reading is still the only thing that takes the marker off.
        state.mode = 'ok';
        monitor.retryRejected();
        await poll(monitor, b);
        assert.deepEqual([...monitor.getRejectedEmails()], []);
      } finally {
        monitor.dispose();
        calls.restore();
      }
    });
  });

  it('a sign-in that lands while the refusal is in flight is never the grant that gets held', async () => {
    await withHome(async ({ b }) => {
      // The /login the marker asked for reaches the store while the doomed refresh
      // is still out. Holding whatever is on disk once the refusal returns would
      // hold the NEW grant, and a signed-in account would never be polled again.
      let loggedIn = false;
      const calls = stubFetch((url, init) => {
        if (url === TOKEN_URL) {
          const sent = String(init?.body ?? '');
          if (sent.includes('rt-after-login')) {
            return res(
              200,
              JSON.stringify({
                access_token: 'at-good',
                refresh_token: 'rt-rotated',
                expires_in: 3600,
              })
            );
          }
          if (loggedIn === 'next') {
            writeCreds(b.dir, { token: 'rt-after-login' });
            loggedIn = true;
          }
          return res(401, JSON.stringify({ error: 'invalid_grant' }));
        }
        return res(200, usageBody());
      });
      const monitor = monitorFor([b]);
      try {
        await poll(monitor);
        writeCreds(b.dir);
        __ageInProcessStateForTests(130_000);
        loggedIn = 'next';
        await poll(monitor); // second refusal; the new grant lands mid-flight
        assert.equal(loggedIn, true, 'the sign-in did land during the refusal');
        assert.deepEqual([...monitor.getRejectedEmails()], ['b@y.com']);

        __ageInProcessStateForTests(130_000);
        await poll(monitor);
        assert.deepEqual(
          [...monitor.getRejectedEmails()],
          [],
          'the new grant was tried, and worked'
        );
      } finally {
        monitor.dispose();
        calls.restore();
      }
    });
  });

  it("another window's real reading releases a hold without a call", async () => {
    await withHome(async ({ b }) => {
      const state = { mode: 'ok' };
      const calls = scriptedNetwork(state);
      const monitor = monitorFor([b]);
      try {
        await poll(monitor, b); // a real reading exists in the shared cache
        stalePolledEntry(b);
        state.mode = 'reject';
        for (let i = 0; i < 2; i++) {
          await poll(monitor, b);
          writeCreds(b.dir);
        }
        assert.deepEqual([...monitor.getRejectedEmails()], ['b@y.com']);
        const held = calls.length;
        await poll(monitor);
        assert.equal(calls.length, held, 'held: nothing asked');

        // Some other window polls the same account successfully and writes the
        // shared cache. Same credentials on disk here, so nothing else would ever
        // tell this window its marker was wrong.
        const file = cachePath();
        const cache = JSON.parse(fs.readFileSync(file, 'utf-8'));
        const entry = cache.entries[usageCacheKey(b.dir, b.email)];
        entry.fetchedAt = Date.now();
        entry.snap.fetchedAt = Date.now();
        fs.writeFileSync(file, JSON.stringify(cache));
        __ageInProcessStateForTests(130_000);

        await poll(monitor);
        assert.equal(calls.length, held, 'released from the cache, not from the network');
        assert.deepEqual([...monitor.getRejectedEmails()], []);
      } finally {
        monitor.dispose();
        calls.restore();
      }
    });
  });

  it('switching to a held account polls it regardless', async () => {
    await withHome(async ({ b }) => {
      const state = { mode: 'reject' };
      const calls = scriptedNetwork(state);
      const monitor = monitorFor([b]);
      try {
        await poll(monitor, b);
        await poll(monitor, b);
        await poll(monitor, b);
        assert.deepEqual([...monitor.getRejectedEmails()], ['b@y.com']);
        const held = calls.length;

        // The hold belongs to the background loop. Switching to the account and
        // signing in is exactly the case it must not get in the way of.
        state.mode = 'ok';
        monitor.setActiveDir(b.dir);
        assert.ok(await monitor.refresh(b.dir, true), 'the active poll ran');
        assert.ok(calls.length > held, 'and really went to the network');
        assert.deepEqual([...monitor.getRejectedEmails()], []);
      } finally {
        monitor.dispose();
        calls.restore();
      }
    });
  });

  it('says so once and then goes quiet, and never logs a token', async () => {
    await withHome(async ({ b }) => {
      const state = { mode: 'reject' };
      const calls = scriptedNetwork(state);
      const monitor = monitorFor([b]);
      global.__caLog.length = 0;
      try {
        await poll(monitor, b);
        await poll(monitor, b);
        assert.deepEqual([...monitor.getRejectedEmails()], ['b@y.com']);

        await poll(monitor, b);
        assert.equal(
          global.__caLog.filter((l) => l.includes('not retrying until its credentials change'))
            .length,
          1,
          'the hold announces itself once'
        );

        const quiet = global.__caLog.length;
        for (let i = 0; i < 3; i++) await poll(monitor, b);
        assert.equal(global.__caLog.length, quiet, 'and then says nothing per tick');

        monitor.retryRejected();
        assert.equal(
          global.__caLog.filter((l) => l.includes('polling it again')).length,
          1,
          'ending it is the other single line'
        );
        assert.ok(
          !global.__caLog.some((l) =>
            ['rt-test', 'rt-after-login', 'rt-second-try'].some((t) => l.includes(t))
          ),
          'no refresh token is ever written to the log'
        );
      } finally {
        monitor.dispose();
        calls.restore();
      }
    });
  });
});
