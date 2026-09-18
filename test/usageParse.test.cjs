const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');

const out = path.join(os.tmpdir(), `usageParse-${process.pid}.cjs`);

esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/usageParse.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: out,
});

const {
  buildSnapshot,
  parseModelLimits,
  isHot,
  needsFailover,
  failoverReasons,
  pressureReasons,
  formatUsageBar,
  formatAccountsTable,
  headroomEvents,
  describeHeadroom,
  DEFAULT_THRESHOLDS,
  DEFAULT_TRIGGERS,
} = require(out);

describe('parseModelLimits', () => {
  it('extracts Fable from weekly_scoped limits', () => {
    const limits = parseModelLimits([
      { kind: 'session', percent: 4, is_active: true },
      {
        kind: 'weekly_scoped',
        percent: 96,
        is_active: true,
        resets_at: '2026-07-17T06:00:00Z',
        scope: { model: { display_name: 'Fable' } },
      },
    ]);
    assert.equal(limits.length, 1);
    assert.equal(limits[0].name, 'Fable');
    assert.equal(limits[0].percent, 96);
  });
});

describe('buildSnapshot + triggers', () => {
  const baseUsage = {
    five_hour: { utilization: 4, resets_at: null },
    seven_day: { utilization: 89, resets_at: '2026-07-17T06:00:00Z' },
    seven_day_opus: null,
    seven_day_sonnet: null,
    limits: [
      {
        kind: 'weekly_scoped',
        percent: 96,
        is_active: true,
        scope: { model: { display_name: 'Fable' } },
      },
    ],
    extra_usage: { is_enabled: false },
  };
  const profile = {
    account: { email: 'a@b.com', has_claude_max: true },
    organization: { name: 'Org', rate_limit_tier: 'default_claude_max_20x' },
  };

  it('maps five_hour / seven_day and fable', () => {
    const snap = buildSnapshot(baseUsage, profile, '/tmp/fake');
    assert.equal(snap.sessionPercent, 4);
    assert.equal(snap.weeklyPercent, 89);
    assert.equal(snap.email, 'a@b.com');
    assert.equal(snap.planLabel, 'Max 20x');
    assert.match(formatUsageBar(snap), /Fable 96%/);
    // Meter pressure includes Fable
    assert.equal(isHot(snap, DEFAULT_THRESHOLDS), true);
    assert.ok(pressureReasons(snap).some((r) => /Fable/.test(r)));
  });

  it('default triggers: Fable-only does NOT need account failover', () => {
    const snap = buildSnapshot(baseUsage, profile, '/tmp/fake');
    // session 4, weekly 89, fable 96 — with defaults only fable is "hot" for meter
    // weekly 89 < 90 so not weekly; fable trigger false → no failover
    assert.equal(needsFailover(snap, DEFAULT_THRESHOLDS, DEFAULT_TRIGGERS), false);
    assert.deepEqual(failoverReasons(snap, DEFAULT_THRESHOLDS, DEFAULT_TRIGGERS), []);
  });

  it('onFable true: Fable pressure triggers failover', () => {
    const snap = buildSnapshot(baseUsage, profile, '/tmp/fake');
    const trig = { session: true, weekly: true, fable: true };
    assert.equal(needsFailover(snap, DEFAULT_THRESHOLDS, trig), true);
    assert.ok(failoverReasons(snap, DEFAULT_THRESHOLDS, trig).some((r) => /Fable/.test(r)));
  });

  it('session trigger alone when 5h is high', () => {
    const snap = buildSnapshot(
      { ...baseUsage, five_hour: { utilization: 95, resets_at: null }, limits: [] },
      profile,
      '/tmp/fake'
    );
    assert.equal(needsFailover(snap, DEFAULT_THRESHOLDS, DEFAULT_TRIGGERS), true);
    assert.ok(
      failoverReasons(snap, DEFAULT_THRESHOLDS, DEFAULT_TRIGGERS).some((r) => /5h/.test(r))
    );
  });

  it('weekly trigger when 7d is high', () => {
    const snap = buildSnapshot(
      {
        ...baseUsage,
        five_hour: { utilization: 10, resets_at: null },
        seven_day: { utilization: 95, resets_at: null },
        limits: [],
      },
      profile,
      '/tmp/fake'
    );
    assert.equal(
      needsFailover(snap, DEFAULT_THRESHOLDS, { session: false, weekly: true, fable: false }),
      true
    );
    assert.equal(
      needsFailover(snap, DEFAULT_THRESHOLDS, { session: true, weekly: false, fable: false }),
      false
    );
  });
});

/**
 * Every fixture is stamped a minute after the one before it: `headroomEvents`
 * only compares a genuinely newer reading against an older one, so snapshots
 * sharing a single fetch time would pin nothing. Tests that care about the
 * stamp pass their own.
 */
let fixtureClock = 1_700_000_000_000;

function usageSnap(overrides = {}) {
  fixtureClock += 60_000;
  return {
    sessionPercent: 40,
    sessionResetsAt: null,
    weeklyPercent: 50,
    weeklyResetsAt: null,
    opusPercent: null,
    opusResetsAt: null,
    sonnetPercent: null,
    sonnetResetsAt: null,
    modelLimits: [{ name: 'Fable', percent: 100, resetsAt: null, kind: 'weekly_scoped' }],
    overagePercent: null,
    email: 'a@x.com',
    orgName: null,
    planLabel: null,
    fetchedAt: fixtureClock,
    configDir: '/tmp/x',
    ...overrides,
  };
}

function withFable(percent, extra = {}) {
  return usageSnap({
    modelLimits: [{ name: 'Fable', percent, resetsAt: null, kind: 'weekly_scoped' }],
    ...extra,
  });
}

describe('headroomEvents', () => {
  it('a partial Fable drop is a raise, not a reset', () => {
    const events = headroomEvents(withFable(100), withFable(70));
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], { label: 'Fable', from: 100, to: 70, kind: 'raise' });
  });

  it('a drop to zero is a reset', () => {
    const events = headroomEvents(withFable(100), withFable(0));
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'reset');
  });

  it('a 2-point drop is rounding noise, not headroom', () => {
    assert.deepEqual(headroomEvents(withFable(100), withFable(98)), []);
  });

  it('the drop threshold is inclusive: 3 points count, 2 do not', () => {
    const counted = headroomEvents(withFable(100), withFable(97));
    assert.equal(counted.length, 1, 'a 3-point drop is the smallest that counts');
    assert.deepEqual(counted[0], { label: 'Fable', from: 100, to: 97, kind: 'raise' });
    assert.deepEqual(headroomEvents(withFable(100), withFable(98)), []);
  });

  it('a newer all-zero reading is a real reset — an idle account reads that way', () => {
    const prev = usageSnap({ sessionPercent: 90, weeklyPercent: 50, fetchedAt: 1_000 });
    const next = usageSnap({
      sessionPercent: 0,
      weeklyPercent: 0,
      modelLimits: [],
      fetchedAt: 2_000,
    });
    assert.deepEqual(
      headroomEvents(prev, next).map((e) => [e.label, e.kind]),
      [
        ['5h', 'reset'],
        ['7d', 'reset'],
      ]
    );
  });

  it('a reading no newer than the last says nothing, however far the figures fell', () => {
    const prev = usageSnap({ sessionPercent: 95, weeklyPercent: 92, fetchedAt: 2_000 });
    // A best-effort snapshot served during a backoff is the last good reading
    // replayed, carrying the fetch time it was stored with.
    const older = usageSnap({ sessionPercent: 0, weeklyPercent: 0, fetchedAt: 1_000 });
    const same = usageSnap({ sessionPercent: 0, weeklyPercent: 0, fetchedAt: 2_000 });
    assert.deepEqual(headroomEvents(prev, older), []);
    assert.deepEqual(headroomEvents(prev, same), []);
    // The identical figures one second later are headroom, so it is the stamp
    // doing the work above, not the numbers.
    const newer = usageSnap({ sessionPercent: 0, weeklyPercent: 0, fetchedAt: 2_001 });
    assert.equal(headroomEvents(prev, newer).length, 2);
  });

  it('a bucket named in two cases is one bucket, reported once', () => {
    const prev = usageSnap({
      modelLimits: [{ name: 'Fable', percent: 100, resetsAt: null, kind: 'weekly_scoped' }],
    });
    const next = usageSnap({
      modelLimits: [
        { name: 'Fable', percent: 70, resetsAt: null, kind: 'weekly_scoped' },
        { name: 'fable', percent: 70, resetsAt: null, kind: 'weekly_scoped' },
      ],
    });
    const events = headroomEvents(prev, next);
    assert.equal(events.length, 1);
    assert.equal(events[0].label, 'Fable');
  });

  it('a rise is not headroom', () => {
    assert.deepEqual(headroomEvents(withFable(40), withFable(90)), []);
  });

  it('no previous snapshot says nothing', () => {
    assert.deepEqual(headroomEvents(null, withFable(0)), []);
    assert.deepEqual(headroomEvents(undefined, withFable(0)), []);
  });

  it('a never-fetched snapshot on either side says nothing', () => {
    assert.deepEqual(headroomEvents(withFable(100, { fetchedAt: 0 }), withFable(0)), []);
    assert.deepEqual(headroomEvents(withFable(100), withFable(0, { fetchedAt: 0 })), []);
  });

  it('a model bucket only present in the new snapshot is not a drop', () => {
    const prev = usageSnap({ modelLimits: [] });
    const next = withFable(10);
    assert.deepEqual(headroomEvents(prev, next), []);
  });

  it('does not throw on malformed modelLimits', () => {
    // Explicit stamps: each call must get past the newer-reading test and
    // actually walk the malformed lists, in both directions.
    const bad = usageSnap({ modelLimits: [null, { percent: 4 }, { name: 'Fable' }, 'nope'] });
    assert.deepEqual(
      headroomEvents(usageSnap({ modelLimits: null, fetchedAt: 1_000 }), {
        ...bad,
        fetchedAt: 2_000,
      }),
      []
    );
    assert.deepEqual(
      headroomEvents(
        { ...bad, fetchedAt: 1_000 },
        usageSnap({ modelLimits: null, fetchedAt: 2_000 })
      ),
      []
    );
  });

  it('a percentage that is not a finite number is not a reading', () => {
    // NaN passes every comparison below it — `NaN - 40 < 3` is false — so without
    // the guard this fabricates an event whose figures are NaN.
    assert.deepEqual(headroomEvents(usageSnap({ sessionPercent: NaN }), usageSnap()), []);
    assert.deepEqual(headroomEvents(usageSnap(), usageSnap({ sessionPercent: NaN })), []);
    assert.deepEqual(headroomEvents(usageSnap({ sessionPercent: Infinity }), usageSnap()), []);
  });

  it('a negative percentage is not a reading', () => {
    const prev = usageSnap({ sessionPercent: 50, weeklyPercent: 50 });
    assert.deepEqual(
      headroomEvents(prev, usageSnap({ sessionPercent: -10, weeklyPercent: 50 })),
      []
    );
    assert.deepEqual(
      headroomEvents(usageSnap({ sessionPercent: -5 }), usageSnap({ sessionPercent: -20 })),
      []
    );
  });

  it('a percentage above 100 is not a reading', () => {
    // 150% → 90% would otherwise read as 60 points of headroom returning.
    assert.deepEqual(
      headroomEvents(usageSnap({ sessionPercent: 150 }), usageSnap({ sessionPercent: 90 })),
      []
    );
    assert.deepEqual(
      headroomEvents(withFable(100), withFable(70)),
      [{ label: 'Fable', from: 100, to: 70, kind: 'raise' }],
      'an in-range drop still reports — the guard is a range test, not a blanket'
    );
  });

  it('reports the 5h and 7d buckets by their own labels', () => {
    const prev = usageSnap({ sessionPercent: 95, weeklyPercent: 92 });
    const next = usageSnap({ sessionPercent: 0, weeklyPercent: 71 });
    const events = headroomEvents(prev, next);
    assert.deepEqual(
      events.map((e) => [e.label, e.kind]),
      [
        ['5h', 'reset'],
        ['7d', 'raise'],
      ]
    );
  });
});

describe('describeHeadroom', () => {
  it('words a reset and a raise differently', () => {
    const reset = describeHeadroom([{ label: 'Fable', from: 100, to: 0, kind: 'reset' }], 'motis');
    const raise = describeHeadroom([{ label: 'Fable', from: 100, to: 70, kind: 'raise' }], 'motis');
    assert.equal(reset, 'Fable reset for motis — 0% used');
    assert.equal(raise, 'Fable allowance went up for motis — 100% → 70%');
    assert.notEqual(reset, raise);
  });

  it('collapses several buckets for one account into one line naming it once', () => {
    const line = describeHeadroom(
      [
        { label: '5h', from: 90, to: 0, kind: 'reset' },
        { label: 'Fable', from: 100, to: 70, kind: 'raise' },
      ],
      'motis'
    );
    assert.equal(line.split('\n').length, 1);
    assert.equal(line.match(/motis/g).length, 1);
    assert.match(line, /5h/);
    assert.match(line, /Fable/);
  });

  it('says nothing for no events and escapes markdown in the account name', () => {
    assert.equal(describeHeadroom([], 'motis'), '');
    assert.match(
      describeHeadroom([{ label: '5h', from: 90, to: 0, kind: 'reset' }], 'em_pha*sis'),
      /em\\_pha\\\*sis/
    );
  });

  it('escapes markdown in the bucket name too — it comes from the API', () => {
    const one = describeHeadroom([{ label: 'Fa*b_le', from: 100, to: 0, kind: 'reset' }], 'motis');
    assert.match(one, /Fa\\\*b\\_le reset for motis/);
    const many = describeHeadroom(
      [
        { label: 'Fa*b_le', from: 100, to: 0, kind: 'reset' },
        { label: '5h|x', from: 90, to: 40, kind: 'raise' },
      ],
      'motis'
    );
    assert.match(many, /Fa\\\*b\\_le reset/);
    assert.match(many, /5h\\\|x allowance went up/);
  });
});

describe('formatAccountsTable exhausted buckets', () => {
  const dueIn = (ms) => new Date(Date.now() + ms).toISOString();
  const row = (snap) =>
    formatAccountsTable([{ label: 'motis', active: false, snap }]).split('\n')[2];

  it('an exhausted bucket carries a compact countdown', () => {
    const line = row(
      usageSnap({
        sessionPercent: 12,
        modelLimits: [
          { name: 'Fable', percent: 100, resetsAt: dueIn(8.8 * 3_600_000 + 5_000), kind: 'x' },
        ],
      })
    );
    assert.match(line, /\*\*100%\*\* · 8\.8h/);
  });

  it('leaves a bucket below the exhausted mark in the long form', () => {
    const line = row(
      usageSnap({
        sessionPercent: 12,
        sessionResetsAt: dueIn(3_600_000 + 5_000),
        modelLimits: [],
      })
    );
    assert.match(line, /\*\*12%\*\* 1h \d+m/);
    assert.doesNotMatch(line, /·/);
  });

  it('an exhausted bucket with no reset time still renders its percent', () => {
    const line = row(withFable(100, { sessionPercent: 5, weeklyPercent: 5 }));
    assert.match(line, /\*\*100%\*\*/);
    assert.doesNotMatch(line, /·/);
  });

  /** The 5h cell of the account's row. */
  const sessionCell = (snap) => row(snap).split('|')[2].trim();

  it('the exhausted mark is inclusive: 80 gets the countdown, 79 does not', () => {
    const due = dueIn(2 * 3_600_000 + 5_000);
    assert.equal(
      sessionCell(usageSnap({ sessionPercent: 80, sessionResetsAt: due })),
      '**80%** · 2h'
    );
    const below = sessionCell(usageSnap({ sessionPercent: 79, sessionResetsAt: due }));
    assert.match(below, /^\*\*79%\*\* \dh \d+m$/);
    assert.doesNotMatch(below, /·/);
  });

  it('a malformed reset time renders the percent alone, never NaN', () => {
    for (const bad of ['not-a-date', '2026-13-45T99:99:99Z', 'soon-ish']) {
      assert.equal(
        sessionCell(usageSnap({ sessionPercent: 100, sessionResetsAt: bad })),
        '**100%**'
      );
      assert.equal(sessionCell(usageSnap({ sessionPercent: 12, sessionResetsAt: bad })), '**12%**');
    }
  });

  it('a reset time already past renders no hint at all', () => {
    assert.equal(
      sessionCell(usageSnap({ sessionPercent: 100, sessionResetsAt: dueIn(-3_600_000) })),
      '**100%**'
    );
    assert.equal(
      sessionCell(usageSnap({ sessionPercent: 12, sessionResetsAt: dueIn(-60_000) })),
      '**12%**'
    );
  });
});

describe('sidecars', () => {
  it('flags extension reserved names', () => {
    const out2 = path.join(os.tmpdir(), `sidecars-${process.pid}.cjs`);
    esbuild.buildSync({
      entryPoints: [path.join(__dirname, '../src/sidecars.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: out2,
    });
    const { isReservedClaudeDirName, isSidecarConfigDir } = require(out2);
    assert.equal(isReservedClaudeDirName('.claude-windows'), true);
    assert.equal(isReservedClaudeDirName('.claude-shared'), true);
    assert.equal(isReservedClaudeDirName('.claude-vault'), true);
    assert.equal(isReservedClaudeDirName('.claude-work'), false);
    assert.equal(isSidecarConfigDir('/mnt/c/Users/x/.claude'), true);
    fs.unlinkSync(out2);
  });
});

// cleanup
process.on('exit', () => {
  try {
    fs.unlinkSync(out);
  } catch {
    /* ignore */
  }
});
