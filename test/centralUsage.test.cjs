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
  fetchUsageDetailed,
  getUsageFromCache,
  usageCacheKey,
  diffCacheAdvances,
  policyDir,
  UsageMonitor,
  USAGE_CACHE_TTL_MS,
  BACKGROUND_TTL_MS,
  RATE_LIMIT_BACKOFF_MS,
  __ageInProcessStateForTests,
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

/**
 * Fresh isolated HOME per test (policyDir/usage-cache live under it). Also holds
 * a REF'D keepalive interval for the test's duration: withLockAsync's wait
 * sleeps on unref'd timers (correct in the extension — never hold the host
 * open), but under node:test an unref'd timer lets the event loop drain
 * mid-await and cancels the whole file ("promise still pending").
 */
async function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-central-home-'));
  const prev = process.env.HOME;
  process.env.HOME = home;
  // A fresh HOME is a fresh machine: the module's in-process attempt clock is
  // keyed by account, so without this a 429 in one test would gate the next.
  __ageInProcessStateForTests(3_600_000);
  const keepalive = setInterval(() => {}, 50);
  try {
    const dir = path.join(home, 'wd');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'a@x.com' } })
    );
    return await fn({ home, dir });
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

/** A non-expiring grant so ensureFreshToken takes its fast path (no OAuth POST). */
function writeCreds(dir) {
  fs.writeFileSync(
    path.join(dir, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'at-test',
        refreshToken: 'rt-test',
        expiresAt: Date.now() + 3_600_000,
      },
    })
  );
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

/**
 * Replace global fetch with a scripted queue of usage responses and record the
 * calls — the only way to drive the real 429 path (stamp, streak, retry-after)
 * rather than the _network seam, which bypasses it.
 */
function stubFetch(responses) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const r = responses.shift() ?? { status: 200, body: usageBody() };
    return {
      status: r.status,
      headers: {
        get: (h) => (h.toLowerCase() === 'retry-after' ? (r.retryAfter ?? null) : null),
      },
      text: async () => r.body ?? '',
    };
  };
  calls.restore = () => {
    globalThis.fetch = real;
  };
  return calls;
}

function metaFile() {
  return path.join(policyDir(), 'usage-meta.json');
}

function readMetaFile() {
  return JSON.parse(fs.readFileSync(metaFile(), 'utf-8'));
}

/** Write usage-meta.json verbatim (raw text so invalid JSON can be exercised). */
function writeMetaRaw(text) {
  fs.mkdirSync(policyDir(), { recursive: true });
  fs.writeFileSync(metaFile(), text);
  __ageInProcessStateForTests(0); // drop the in-process readMeta memo
}

/** Install one backoff record as another window would have left it. */
function writeBackoff(key, rec, rest = {}) {
  let m = {};
  try {
    m = readMetaFile();
  } catch {
    /* fresh */
  }
  writeMetaRaw(JSON.stringify({ ...m, ...rest, backoff: { ...m.backoff, [key]: rec } }));
}

/**
 * Travel forward: age this key's backoff deadline AND the in-process clocks (the
 * readMeta memo and the per-key attempt times behind the minimum call gap) by the
 * same amount, so the whole process behaves as if `ms` had really passed.
 */
function ageStamp(key, ms) {
  const m = readMetaFile();
  m.backoff[key].at -= ms;
  m.backoff[key].until -= ms;
  fs.writeFileSync(metaFile(), JSON.stringify(m));
  __ageInProcessStateForTests(ms);
}

/** The wait this process would actually enforce for `dir`, in ms (null = go). */
function waitFor(dir) {
  const monitor = new UsageMonitor(60_000);
  try {
    return monitor.rateLimitWaitMs(dir);
  } finally {
    monitor.dispose();
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

describe('poll cadence (schedule-from-last-success clock)', () => {
  it('the measured constants are the ones in force', () => {
    assert.equal(USAGE_CACHE_TTL_MS, 150_000);
    assert.equal(BACKGROUND_TTL_MS, 600_000);
  });

  it('serves a 100s-old entry and fetches a 160s-old one', async () => {
    await withHome(async ({ dir }) => {
      const key = usageCacheKey(dir);
      writeCacheEntry(key, snapFor('a@x.com', 33), Date.now() - 100_000);
      let calls = 0;
      const network = async () => {
        calls++;
        const snap = snapFor('a@x.com', 66);
        writeCacheEntry(key, snap);
        return { ok: true, snap };
      };
      const hit = await fetchUsageCoordinated({ dir }, { _network: network });
      assert.equal(calls, 0, '100s is inside the 150s clock');
      assert.equal(hit.result.snap.sessionPercent, 33);

      writeCacheEntry(key, snapFor('a@x.com', 33), Date.now() - 160_000);
      const miss = await fetchUsageCoordinated({ dir }, { _network: network });
      assert.equal(calls, 1, '160s is past the clock → one network call');
      assert.equal(miss.fromNetwork, true);
      assert.equal(miss.result.snap.sessionPercent, 66);
    });
  });

  it('background tier serves at 400s and fetches at 700s', async () => {
    await withHome(async ({ dir }) => {
      const key = usageCacheKey(dir);
      let calls = 0;
      const network = async () => {
        calls++;
        const snap = snapFor('a@x.com', 51);
        writeCacheEntry(key, snap);
        return { ok: true, snap };
      };
      writeCacheEntry(key, snapFor('a@x.com', 12), Date.now() - 400_000);
      const hit = await fetchUsageCoordinated(
        { dir },
        { freshForMs: BACKGROUND_TTL_MS, _network: network }
      );
      assert.equal(calls, 0, '400s is inside the 600s background tier');
      assert.equal(hit.result.snap.sessionPercent, 12);

      writeCacheEntry(key, snapFor('a@x.com', 12), Date.now() - 700_000);
      const miss = await fetchUsageCoordinated(
        { dir },
        { freshForMs: BACKGROUND_TTL_MS, _network: network }
      );
      assert.equal(calls, 1, '700s is past the background tier → network');
      assert.equal(miss.result.snap.sessionPercent, 51);
    });
  });
});

describe('429 backoff (one flat rung, hard cap, fails toward calling)', () => {
  it('the rung is the measured allowance', () => {
    assert.equal(RATE_LIMIT_BACKOFF_MS, 150_000);
    assert.equal(RATE_LIMIT_BACKOFF_MS, USAGE_CACHE_TTL_MS);
  });

  it('an older build’s rateLimitAt neither gates us nor gets touched', async () => {
    await withHome(async ({ dir }) => {
      writeCreds(dir);
      const key = usageCacheKey(dir);
      // Exactly what 0.9.12 leaves behind: its own stamp, mid-backoff, plus the
      // reviewed build's streak map. None of it is ours to read or to clear.
      writeMetaRaw(
        JSON.stringify({
          rateLimitAt: { [key]: Date.now() },
          rateLimitStreak: { [key]: 3 },
          rateLimitRetryAfterMs: { [key]: 900_000 },
          lastRateLimitAt: Date.now(),
        })
      );
      const calls = stubFetch([{ status: 200, body: usageBody(7, 8) }]);
      try {
        assert.equal(waitFor(dir), null, 'a foreign stamp is not our backoff');
        const out = await fetchUsageDetailed(dir);
        assert.equal(calls.length, 1, 'the foreign stamp did not stop the call');
        assert.equal(out.snap.sessionPercent, 7);
        const m = readMetaFile();
        assert.ok(m.rateLimitAt[key] > 0, 'their stamp survives our 200');
        assert.equal(m.rateLimitStreak[key], 3, 'their streak survives our 200');
        assert.equal(m.rateLimitRetryAfterMs[key], 900_000);
        assert.ok(m.lastRateLimitAt > 0, 'the legacy stamp is left to expire');
      } finally {
        calls.restore();
      }
    });
  });

  it('an old window rewriting rateLimitAt leaves our wait unchanged', async () => {
    await withHome(async ({ dir }) => {
      writeCreds(dir);
      const key = usageCacheKey(dir);
      const calls = stubFetch([
        { status: 429, body: 'rate limited' },
        { status: 200, body: usageBody(7, 8) },
      ]);
      try {
        await fetchUsageDetailed(dir);
        assert.equal(calls.length, 1);
        const rec = readMetaFile().backoff[key];
        assert.equal(rec.until - rec.at, 150_000, 'one flat rung');
        const before = waitFor(dir);

        // Two rewrites by a 0.9.12 window, 60s apart on its own clock.
        for (let i = 0; i < 2; i++) {
          const m = readMetaFile();
          m.rateLimitAt = { [key]: Date.now() };
          m.rateLimitStreak = { [key]: (m.rateLimitStreak?.[key] ?? 0) + 1 };
          writeMetaRaw(JSON.stringify(m));
        }
        assert.ok(Math.abs(waitFor(dir) - before) < 1_000, 'foreign writes changed nothing');

        ageStamp(key, 140_000);
        await fetchUsageDetailed(dir);
        assert.equal(calls.length, 1, '140s is inside the rung');

        ageStamp(key, 20_000); // 160s since the 429
        const out = await fetchUsageDetailed(dir);
        assert.equal(calls.length, 2, 'past the rung → retry, on schedule');
        assert.equal(out.snap.sessionPercent, 7);
      } finally {
        calls.restore();
      }
    });
  });

  it('five refusals in a row never wait more than the cap', async () => {
    await withHome(async ({ dir }) => {
      writeCreds(dir);
      const key = usageCacheKey(dir);
      const calls = stubFetch(
        Array.from({ length: 5 }, () => ({ status: 429, body: 'rate limited' }))
      );
      try {
        for (let n = 1; n <= 5; n++) {
          await fetchUsageDetailed(dir);
          assert.equal(calls.length, n, `refusal ${n} was re-attempted`);
          const rec = readMetaFile().backoff[key];
          assert.equal(rec.count, n, 'count is kept');
          assert.equal(rec.until - rec.at, 150_000, 'the wait stays flat');
          assert.ok(rec.until - rec.at <= 300_000, 'never past the cap');
          // A ladder would demand 300s here from the second refusal on.
          ageStamp(key, 160_000);
        }
      } finally {
        calls.restore();
      }
    });
  });

  it('retry-after can lengthen the wait to the cap but never shorten it', async () => {
    await withHome(async ({ dir }) => {
      writeCreds(dir);
      const key = usageCacheKey(dir);
      const calls = stubFetch([
        { status: 429, body: 'rate limited', retryAfter: '30' },
        { status: 200, body: usageBody(5, 6) },
      ]);
      try {
        await fetchUsageDetailed(dir);
        const rec = readMetaFile().backoff[key];
        assert.equal(rec.until - rec.at, 150_000, 'retry-after 30s is floored at the rung');

        ageStamp(key, 35_000);
        await fetchUsageDetailed(dir);
        assert.equal(calls.length, 1, 'no call at 35s — the server cannot shorten the rung');

        ageStamp(key, 125_000); // 160s since the 429
        await fetchUsageDetailed(dir);
        assert.equal(calls.length, 2, 'the rung expired on schedule');
      } finally {
        calls.restore();
      }
    });
  });

  it('retry-after 3600 is capped at 5 minutes', async () => {
    await withHome(async ({ dir }) => {
      writeCreds(dir);
      const key = usageCacheKey(dir);
      const calls = stubFetch([
        { status: 429, body: 'rate limited', retryAfter: '3600' },
        { status: 200, body: usageBody(5, 6) },
      ]);
      try {
        await fetchUsageDetailed(dir);
        const rec = readMetaFile().backoff[key];
        assert.equal(rec.until - rec.at, 300_000, 'an hour is clamped to the cap');

        ageStamp(key, 310_000);
        await fetchUsageDetailed(dir);
        assert.equal(calls.length, 2, 'calls at 310s — an hour-long freeze is impossible');
      } finally {
        calls.restore();
      }
    });
  });

  it('garbage on disk yields no backoff and a call', async () => {
    // NaN and Infinity cannot appear in JSON at all, so those rows also exercise
    // the unparseable-file path — which must fail the same way: toward calling.
    const untils = ['null', '"x"', '{}', 'NaN', '-1', 'Infinity'];
    for (const raw of untils) {
      await withHome(async ({ dir }) => {
        writeCreds(dir);
        const key = usageCacheKey(dir);
        writeMetaRaw(
          `{"backoff":{${JSON.stringify(key)}:{"at":${Date.now()},"until":${raw},"count":1}}}`
        );
        const calls = stubFetch([{ status: 200, body: usageBody(7, 8) }]);
        try {
          assert.equal(waitFor(dir), null, `until=${raw} must not be a backoff`);
          await fetchUsageDetailed(dir);
          assert.equal(calls.length, 1, `until=${raw} must still call`);
        } finally {
          calls.restore();
        }
      });
    }

    // Control: a well-formed deadline in the same slot DOES hold the call back,
    // so the rows above are the validation working, not the field being ignored.
    await withHome(async ({ dir }) => {
      writeCreds(dir);
      const key = usageCacheKey(dir);
      writeBackoff(key, { at: Date.now(), until: Date.now() + 100_000, count: 1 });
      const calls = stubFetch([{ status: 200, body: usageBody(7, 8) }]);
      try {
        assert.ok(waitFor(dir) > 90_000, 'a valid record is a backoff');
        await fetchUsageDetailed(dir);
        assert.equal(calls.length, 0, 'and it stops the call');
      } finally {
        calls.restore();
      }
    });
  });

  it('a far-future deadline cannot freeze us longer than the cap from when it was stamped', async () => {
    // The cap must bound the DEADLINE, not the remaining wait: capping
    // `until - now` hands back a fresh 300s wait on every read forever when
    // `until` sits far ahead, which is an unbounded freeze, not a bounded one.
    await withHome(async ({ dir }) => {
      writeCreds(dir);
      const key = usageCacheKey(dir);
      const at = Date.now() - 301_000; // one tick past the cap, measured from the stamp
      writeBackoff(key, { at, until: at + 30 * 60_000, count: 1 });
      const calls = stubFetch([{ status: 200, body: usageBody(7, 8) }]);
      try {
        assert.equal(waitFor(dir), null, 'the refusal is spent 300s after it was stamped');
        await fetchUsageDetailed(dir);
        assert.equal(calls.length, 1, 'and the call goes out');
      } finally {
        calls.restore();
      }
    });

    // Control: the same oversized deadline still holds while inside the cap.
    await withHome(async ({ dir }) => {
      writeCreds(dir);
      const key = usageCacheKey(dir);
      const at = Date.now() - 10_000;
      writeBackoff(key, { at, until: at + 30 * 60_000, count: 1 });
      const wait = waitFor(dir);
      assert.ok(wait > 0 && wait <= 300_000, `capped to the ceiling, got ${wait}`);
    });
  });

  it('a record with no usable stamp is not a backoff at all', async () => {
    // `at` bounds the deadline and feeds the success check. Substituting `now`
    // when it is missing re-arms the cap on every read: a far-future `until`
    // would then return a fresh MAX_BACKOFF_MS forever — an unbounded freeze
    // wearing a bounded number's clothes.
    for (const atField of ['', '"at":null,', '"at":"x",', '"at":{},']) {
      await withHome(async ({ dir }) => {
        writeCreds(dir);
        const key = usageCacheKey(dir);
        const until = Date.now() + 30 * 60_000;
        writeMetaRaw(`{"backoff":{${JSON.stringify(key)}:{${atField}"until":${until},"count":1}}}`);
        const calls = stubFetch([{ status: 200, body: usageBody(7, 8) }]);
        try {
          assert.equal(waitFor(dir), null, `at=${atField || 'absent'} must not be a backoff`);
          await fetchUsageDetailed(dir);
          assert.equal(calls.length, 1, `at=${atField || 'absent'} must still call`);
        } finally {
          calls.restore();
        }
      });
    }
  });

  it('an accepted small skew still cannot push the wait past the cap', async () => {
    await withHome(async ({ dir }) => {
      const key = usageCacheKey(dir);
      // Inside CLOCK_SKEW_TOLERANCE_MS, so the record is honoured — but the
      // deadline must be measured from no later than our own clock.
      const at = Date.now() + 59_000;
      writeBackoff(key, { at, until: at + 30 * 60_000, count: 1 });
      const wait = waitFor(dir);
      assert.ok(wait > 0, 'a small skew is still a real refusal');
      assert.ok(wait <= 300_000, `must not exceed the cap, got ${wait}`);
    });
  });

  it('a stamp from a clock ahead of ours is ignored, not honoured', async () => {
    // A future `at` would also defeat the success check — no cache entry can be
    // newer than it — so it must fail toward calling like any other impossible value.
    await withHome(async ({ dir }) => {
      writeCreds(dir);
      const key = usageCacheKey(dir);
      const at = Date.now() + 30 * 60_000;
      writeBackoff(key, { at, until: at + 150_000, count: 1 });
      const calls = stubFetch([{ status: 200, body: usageBody(7, 8) }]);
      try {
        assert.equal(waitFor(dir), null, 'a future stamp is a skewed clock');
        await fetchUsageDetailed(dir);
        assert.equal(calls.length, 1, 'and it must not stop the call');
      } finally {
        calls.restore();
      }
    });

    // Control: the same record inside the skew tolerance is honoured.
    await withHome(async ({ dir }) => {
      writeCreds(dir);
      const key = usageCacheKey(dir);
      const at = Date.now() + 5_000;
      writeBackoff(key, { at, until: at + 150_000, count: 1 });
      assert.ok(waitFor(dir) > 0, 'a small skew is still a real refusal');
    });
  });

  it('a record whose shape is not an object is ignored', async () => {
    await withHome(async ({ dir }) => {
      const key = usageCacheKey(dir);
      writeMetaRaw(`{"backoff":{${JSON.stringify(key)}:"soon"}}`);
      assert.equal(waitFor(dir), null);
    });
  });

  it('any window’s 200 ends our backoff; an older one does not', async () => {
    await withHome(async ({ dir }) => {
      writeCreds(dir);
      const key = usageCacheKey(dir);
      const at = Date.now() - 200_000;
      const rec = { at, until: Date.now() + 100_000, count: 1 };

      // Control: the last success predates our refusal — the wait stands.
      writeBackoff(key, rec);
      writeCacheEntry(key, snapFor('a@x.com', 21), at - 1);
      assert.ok(waitFor(dir) > 90_000, 'still in backoff');

      // Another window (any version) succeeded after our 429: the record is dead.
      writeCacheEntry(key, snapFor('a@x.com', 21), at + 1);
      __ageInProcessStateForTests(0);
      assert.equal(waitFor(dir), null, 'someone else’s success ends it');

      const calls = stubFetch([{ status: 200, body: usageBody(7, 8) }]);
      try {
        await fetchUsageDetailed(dir);
        assert.equal(calls.length, 1, 'and a call is allowed');
      } finally {
        calls.restore();
      }
    });
  });

  it('a future-dated cache entry is refetched, not served forever', async () => {
    await withHome(async ({ dir }) => {
      writeCreds(dir);
      const key = usageCacheKey(dir);
      // A WSL2 host suspend/resume leaves another window's fetchedAt in our future.
      writeCacheEntry(key, snapFor('a@x.com', 21), Date.now() + 600_000);
      const calls = stubFetch([{ status: 200, body: usageBody(7, 8) }]);
      try {
        assert.equal(getUsageFromCache(key, USAGE_CACHE_TTL_MS), null, 'not fresh');
        const out = await fetchUsageDetailed(dir);
        assert.equal(calls.length, 1, 'refetched');
        assert.equal(out.snap.sessionPercent, 7);
      } finally {
        calls.restore();
      }
    });
  });

  it('a forceNetwork racing a stamp makes zero calls', async () => {
    await withHome(async ({ dir }) => {
      const key = usageCacheKey(dir);
      let pollCalls = 0;
      let forceCalls = 0;
      // The poll path takes the fetch lock synchronously, so the forced refresh
      // is behind it and only reaches the re-check under the lock.
      const poll = fetchUsageCoordinated(
        { dir },
        {
          _network: async (d, k) => {
            pollCalls++;
            writeBackoff(k, { at: Date.now(), until: Date.now() + 150_000, count: 1 });
            await new Promise((r) => setTimeout(r, 150));
            return { ok: true, snap: snapFor('a@x.com', 9) };
          },
        }
      );
      const forced = fetchUsageCoordinated(
        { dir },
        {
          forceNetwork: true,
          _network: async () => {
            forceCalls++;
            return { ok: true, snap: snapFor('a@x.com', 1) };
          },
        }
      );
      const [, force] = await Promise.all([poll, forced]);
      assert.equal(pollCalls, 1);
      assert.equal(forceCalls, 0, 'the stamp written under the lock stopped it');
      assert.equal(force.fromNetwork, false);
      assert.ok(readMetaFile().backoff[key].until > Date.now());
    });
  });

  it('corrupt meta still cannot produce two calls inside the in-process gap', async () => {
    await withHome(async ({ dir }) => {
      writeCreds(dir);
      const calls = stubFetch([
        { status: 429, body: 'rate limited' },
        { status: 200, body: usageBody(7, 8) },
      ]);
      try {
        await fetchUsageDetailed(dir);
        assert.equal(calls.length, 1);

        // Every shared gate is gone: the file no longer parses, so the record we
        // just wrote is unreadable and the meter is free to call again.
        writeMetaRaw('{');
        assert.equal(waitFor(dir), null, 'shared state says go');

        await fetchUsageDetailed(dir);
        assert.equal(calls.length, 1, 'the in-process gap held the line');

        __ageInProcessStateForTests(130_000);
        await fetchUsageDetailed(dir);
        assert.equal(calls.length, 2, 'and releases it after the gap');
      } finally {
        calls.restore();
      }
    });
  });
});

describe('forced refresh does not burn the allowance on fresh figures', () => {
  it('30s after a success makes no network call and says how old it is', async () => {
    await withHome(async ({ dir }) => {
      writeCreds(dir);
      writeCacheEntry(usageCacheKey(dir), snapFor('a@x.com', 44), Date.now() - 30_000);
      const calls = stubFetch([{ status: 200, body: usageBody(1, 2) }]);
      const monitor = new UsageMonitor(60_000);
      try {
        const snap = await monitor.refresh(dir, true);
        assert.equal(calls.length, 0, 'no call inside the 2 min allowance');
        assert.equal(snap.sessionPercent, 44, 'served the cached figures');
        assert.equal(monitor.lastFailure, null);
        assert.ok(
          monitor.lastServedFromCacheAgeMs >= 29_000,
          `age reported: ${monitor.lastServedFromCacheAgeMs}`
        );
      } finally {
        monitor.dispose();
        calls.restore();
      }
    });
  });

  it('200s after a success really fetches', async () => {
    await withHome(async ({ dir }) => {
      writeCreds(dir);
      writeCacheEntry(usageCacheKey(dir), snapFor('a@x.com', 44), Date.now() - 200_000);
      const calls = stubFetch([{ status: 200, body: usageBody(1, 2) }]);
      const monitor = new UsageMonitor(60_000);
      try {
        const snap = await monitor.refresh(dir, true);
        assert.equal(calls.length, 1, 'past the allowance → one call');
        assert.equal(snap.sessionPercent, 1, 'served the network figures');
        assert.equal(monitor.lastServedFromCacheAgeMs, null);
      } finally {
        monitor.dispose();
        calls.restore();
      }
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

/**
 * The cutover re-validation gate is the one place where raising the fetch's
 * freshness without raising the authorization horizon silently switches auto
 * cutover off — the failure logs "no longer cool", which reads like correct
 * operation. So it gets its own bundle and its own end-to-end pin.
 */
const cutoverVscodeStub = path.join(tmpRoot, 'vscode-stub-cutover.js');
fs.writeFileSync(
  cutoverVscodeStub,
  `class Disposable { constructor(fn) { this.dispose = fn || (() => {}); } }
   class EventEmitter { constructor() { this.event = () => new Disposable(); } fire() {} dispose() {} }
   module.exports = {
     window: {
       createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
       showWarningMessage: () => Promise.resolve(undefined),
       showInformationMessage: () => Promise.resolve(undefined),
       showErrorMessage: () => Promise.resolve(undefined),
       showQuickPick: () => Promise.resolve(undefined),
       showInputBox: () => Promise.resolve(undefined),
       withProgress: (_o, fn) => fn({ report() {} }),
       setStatusBarMessage: () => new Disposable(),
       createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
       onDidChangeWindowState: () => new Disposable(),
     },
     workspace: {
       workspaceFolders: undefined,
       getConfiguration: () => ({ get: () => undefined, inspect: () => undefined, update: () => Promise.resolve() }),
       onDidChangeConfiguration: () => new Disposable(),
     },
     commands: { executeCommand: () => Promise.resolve(undefined), registerCommand: () => new Disposable() },
     env: { openExternal: () => Promise.resolve(true) },
     Uri: { file: (p) => ({ fsPath: p }), parse: (s) => ({ toString: () => s }) },
     StatusBarAlignment: { Left: 1, Right: 2 },
     ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
     ProgressLocation: { Notification: 15, Window: 10 },
     ThemeColor: class { constructor(id) { this.id = id; } },
     MarkdownString: class { constructor(v) { this.value = v; } appendMarkdown(v) { this.value += v; return this; } },
     Disposable,
     EventEmitter,
   };`
);
const cutoverBundle = path.join(tmpRoot, 'cutover.bundle.cjs');
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/cutover.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: cutoverBundle,
  alias: { vscode: cutoverVscodeStub },
});
const { IdleCutoverController } = require(cutoverBundle);

/** Wait until `fn()` is truthy, or give up — the cutover chain is void-async. */
async function until(fn, ms = 3_000) {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

describe('auto-cutover still authorizes on a cache-served snapshot', () => {
  it('a 140s-old target switches over with zero network calls', async () => {
    await withHome(async ({ home, dir }) => {
      const target = path.join(home, 'store-b');
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(
        path.join(target, '.claude.json'),
        JSON.stringify({ oauthAccount: { emailAddress: 'b@y.com' } })
      );
      // Active account is over the session threshold; the target is cool and its
      // shared entry is 140s old — inside the 150s the re-validation fetch may
      // serve from cache, and inside the 180s horizon that authorizes a switch.
      writeCacheEntry(usageCacheKey(dir), snapFor('a@x.com', 95));
      writeCacheEntry(
        usageCacheKey(target, 'b@y.com'),
        snapFor('b@y.com', 5),
        Date.now() - 140_000
      );

      const account = { name: 'b', dir: target, email: 'b@y.com' };
      const registry = {
        listUniqueByEmail: () => [account],
        emailOf: (a) => a.email,
        savedForEmail: () => account,
        getByDir: () => account,
      };
      const binding = { getEnvDir: () => dir, getActiveName: () => 'a' };
      const switched = [];
      const wizard = {
        switchTo: async (a) => {
          switched.push(a.name);
        },
      };
      const state = {};
      const context = {
        workspaceState: {
          get: (k, d) => (k in state ? state[k] : d),
          update: async (k, v) => {
            state[k] = v;
          },
        },
      };
      const calls = stubFetch([{ status: 200, body: usageBody(1, 2) }]);
      const ctrl = new IdleCutoverController(context, registry, binding, wizard, () => dir);
      try {
        ctrl.configure({ panelMode: 'idleReload' });
        ctrl.start();
        ctrl.notePressure(snapFor('a@x.com', 95), ['5h 95%']);
        assert.ok(await until(() => switched.length > 0), 'switchTo was never reached');
        assert.deepEqual(switched, ['b']);
        assert.equal(calls.length, 0, 'authorized straight off the shared cache');
      } finally {
        ctrl.dispose();
        calls.restore();
      }
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
