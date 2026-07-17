const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');

/** usage.ts imports vscode via log — bundle with the minimal stub, like the others. */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `central-usage-${process.pid}-`));
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
  fetchUsageCoordinated,
  getUsageFromCache,
  usageCacheKey,
  diffCacheAdvances,
  policyDir,
} = require(bundleOut);

function snapFor(email, session = 10) {
  return {
    sessionPercent: session,
    sessionResetsAt: null,
    weeklyPercent: 20,
    weeklyResetsAt: null,
    opusPercent: null,
    opusResetsAt: null,
    sonnetPercent: null,
    sonnetResetsAt: null,
    modelLimits: [],
    overagePercent: null,
    email,
    orgName: null,
    planLabel: null,
    fetchedAt: Date.now(),
    configDir: '/tmp/x',
  };
}

/** Fresh isolated HOME per test (policyDir/usage-cache live under it). */
async function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-central-home-'));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    const dir = path.join(home, 'wd');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'a@x.com' } })
    );
    return await fn({ home, dir });
  } finally {
    process.env.HOME = prev;
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function writeCacheEntry(key, snap, fetchedAt = Date.now()) {
  const file = path.join(policyDir(), 'usage-cache.json');
  fs.mkdirSync(policyDir(), { recursive: true });
  let cache = { entries: {} };
  try {
    cache = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    /* fresh */
  }
  cache.entries[key] = { key, fetchedAt, snap };
  fs.writeFileSync(file, JSON.stringify(cache));
}

describe('fetchUsageCoordinated (single fetcher per account, machine-wide)', () => {
  it('serves a fresh cache without calling the network', async () => {
    await withHome(async ({ dir }) => {
      const key = usageCacheKey(dir);
      writeCacheEntry(key, snapFor('a@x.com', 33));
      let calls = 0;
      const out = await fetchUsageCoordinated(
        { dir },
        {
          _network: async () => {
            calls++;
            return { ok: true, snap: snapFor('a@x.com', 99) };
          },
        }
      );
      assert.equal(calls, 0);
      assert.equal(out.fromNetwork, false);
      assert.equal(out.result.ok, true);
      assert.equal(out.result.snap.sessionPercent, 33);
    });
  });

  it('two concurrent stale calls produce exactly one network fetch', async () => {
    await withHome(async ({ dir }) => {
      const key = usageCacheKey(dir);
      let calls = 0;
      const network = async () => {
        calls++;
        // The real network step writes the shared cache; the stub mimics that so
        // the under-lock re-check (and late losers) see the winner's result.
        await new Promise((r) => setTimeout(r, 150));
        const snap = snapFor('a@x.com', 55);
        writeCacheEntry(key, snap);
        return { ok: true, snap };
      };
      const [x, y] = await Promise.all([
        fetchUsageCoordinated({ dir }, { _network: network }),
        fetchUsageCoordinated({ dir }, { _network: network }),
      ]);
      assert.equal(calls, 1, 'exactly one network call');
      const winners = [x, y].filter((r) => r.fromNetwork).length;
      assert.equal(winners, 1, 'exactly one caller reports fromNetwork');
      assert.equal(x.result.ok, true);
      assert.equal(y.result.ok, true);
      assert.equal(x.result.snap.sessionPercent, 55);
      assert.equal(y.result.snap.sessionPercent, 55);
    });
  });

  it('reclaims a dead-PID lock and fetches', async () => {
    await withHome(async ({ dir }) => {
      const key = usageCacheKey(dir);
      const lockDir = path.join(
        policyDir(),
        'locks',
        `usage-fetch-${encodeURIComponent(key)}.lock`
      );
      fs.mkdirSync(lockDir, { recursive: true });
      // A same-host holder whose pid is dead is reclaimed immediately.
      fs.writeFileSync(
        path.join(lockDir, 'owner.json'),
        JSON.stringify({ pid: 999999999, host: os.hostname(), at: Date.now() - 60_000 })
      );
      let calls = 0;
      const out = await fetchUsageCoordinated(
        { dir },
        {
          _network: async () => {
            calls++;
            const snap = snapFor('a@x.com', 42);
            writeCacheEntry(key, snap);
            return { ok: true, snap };
          },
        }
      );
      assert.equal(calls, 1);
      assert.equal(out.fromNetwork, true);
    });
  });

  it('force refresh coalesces onto a seconds-old fetch (one call for two humans)', async () => {
    await withHome(async ({ dir }) => {
      const key = usageCacheKey(dir);
      writeCacheEntry(key, snapFor('a@x.com', 77), Date.now() - 2_000); // 2s old
      let calls = 0;
      const out = await fetchUsageCoordinated(
        { dir },
        {
          forceNetwork: true,
          _network: async () => {
            calls++;
            return { ok: true, snap: snapFor('a@x.com', 1) };
          },
        }
      );
      assert.equal(calls, 0, 'coalesced into the just-fetched entry');
      assert.equal(out.result.snap.sessionPercent, 77);
    });
  });

  it('force refresh past the coalesce window really fetches', async () => {
    await withHome(async ({ dir }) => {
      const key = usageCacheKey(dir);
      writeCacheEntry(key, snapFor('a@x.com', 77), Date.now() - 20_000); // 20s old
      let calls = 0;
      const out = await fetchUsageCoordinated(
        { dir },
        {
          forceNetwork: true,
          _network: async () => {
            calls++;
            const snap = snapFor('a@x.com', 3);
            writeCacheEntry(key, snap);
            return { ok: true, snap };
          },
        }
      );
      assert.equal(calls, 1, 'entry older than the coalesce window → network');
      assert.equal(out.fromNetwork, true);
      assert.equal(out.result.snap.sessionPercent, 3);
    });
  });

  it('email hint keys the cache even when the dir identity is unreadable', async () => {
    await withHome(async ({ home }) => {
      const bare = path.join(home, 'bare-store');
      fs.mkdirSync(bare, { recursive: true });
      assert.equal(usageCacheKey(bare, 'B@X.com'), 'email:b@x.com');
      assert.ok(usageCacheKey(bare).startsWith('dir:'));
    });
  });
});

describe('getUsageFromCache (cutover freshness horizon)', () => {
  it('serves fresh entries and excludes stale ones', async () => {
    await withHome(async ({ dir }) => {
      const key = usageCacheKey(dir);
      writeCacheEntry(key, snapFor('a@x.com', 12), Date.now() - 60_000); // 1 min old
      assert.equal(getUsageFromCache(key, 5 * 60_000).sessionPercent, 12);
      assert.equal(getUsageFromCache(key, 30_000), null, 'older than horizon → unknown');
    });
  });
});

describe('diffCacheAdvances (cache-watcher suppression)', () => {
  it('returns only entries whose fetchedAt advanced', () => {
    const snapA = snapFor('a@x.com');
    const snapB = snapFor('b@y.com');
    const entries = {
      'email:a@x.com': { key: 'email:a@x.com', fetchedAt: 1000, snap: snapA },
      'email:b@y.com': { key: 'email:b@y.com', fetchedAt: 2000, snap: snapB },
    };
    const seen = new Map([
      ['email:a@x.com', 1000], // unchanged → suppressed
      ['email:b@y.com', 1500], // advanced → reported
    ]);
    const advanced = diffCacheAdvances(entries, seen);
    assert.equal(advanced.length, 1);
    assert.equal(advanced[0].key, 'email:b@y.com');
    assert.equal(advanced[0].fetchedAt, 2000);
  });

  it('reports brand-new keys and skips malformed entries', () => {
    const entries = {
      'email:new@x.com': { key: 'email:new@x.com', fetchedAt: 5, snap: snapFor('new@x.com') },
      'email:bad@x.com': { key: 'email:bad@x.com', fetchedAt: 5 }, // no snap
    };
    const advanced = diffCacheAdvances(entries, new Map());
    assert.equal(advanced.length, 1);
    assert.equal(advanced[0].key, 'email:new@x.com');
  });
});
