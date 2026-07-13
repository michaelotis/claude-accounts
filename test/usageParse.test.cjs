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
    assert.ok(failoverReasons(snap, DEFAULT_THRESHOLDS, DEFAULT_TRIGGERS).some((r) => /5h/.test(r)));
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
    assert.equal(needsFailover(snap, DEFAULT_THRESHOLDS, { session: false, weekly: true, fable: false }), true);
    assert.equal(needsFailover(snap, DEFAULT_THRESHOLDS, { session: true, weekly: false, fable: false }), false);
  });
});

describe('sidecars', () => {
  it('flags camwatch and reserved names', () => {
    const out2 = path.join(os.tmpdir(), `sidecars-${process.pid}.cjs`);
    esbuild.buildSync({
      entryPoints: [path.join(__dirname, '../src/sidecars.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: out2,
    });
    const { isReservedClaudeDirName, isSidecarConfigDir } = require(out2);
    assert.equal(isReservedClaudeDirName('.claude-camwatch'), true);
    assert.equal(isReservedClaudeDirName('.claude-windows'), true);
    assert.equal(isReservedClaudeDirName('.claude-shared'), true);
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
