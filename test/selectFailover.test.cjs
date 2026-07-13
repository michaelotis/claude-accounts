const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');

const out = path.join(os.tmpdir(), `select-${process.pid}.cjs`);
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/usageParse.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: out,
});
const {
  selectFailoverAccount,
  usageScore,
  DEFAULT_THRESHOLDS,
  DEFAULT_TRIGGERS,
} = require(out);

const thr = DEFAULT_THRESHOLDS;
const trig = DEFAULT_TRIGGERS; // session+weekly, not fable

function acc(id, session, weekly, fable = null) {
  return {
    id,
    email: id,
    dir: `/tmp/${id}`,
    sessionPercent: session,
    weeklyPercent: weekly,
    fablePercent: fable,
  };
}

describe('selectFailoverAccount lowestUsage', () => {
  it('picks cool account with lowest score among many', () => {
    const chosen = selectFailoverAccount(
      [
        acc('a@x.com', 95, 10), // hot session
        acc('b@x.com', 20, 30),
        acc('c@x.com', 10, 15),
        acc('d@x.com', 40, 5),
      ],
      { strategy: 'lowestUsage', thresholds: thr, triggers: trig }
    );
    assert.equal(chosen.email, 'c@x.com'); // score max(10,15)=15 lowest among cool
  });

  it('ignores Fable in score when onFable false', () => {
    const chosen = selectFailoverAccount(
      [acc('hi-fable@x.com', 5, 5, 99), acc('mid@x.com', 20, 20, 0)],
      { strategy: 'lowestUsage', thresholds: thr, triggers: trig }
    );
    // hi-fable score = max(5,5)=5 < mid 20
    assert.equal(chosen.email, 'hi-fable@x.com');
  });

  it('respects accountOrder as pool', () => {
    const chosen = selectFailoverAccount(
      [acc('a@x.com', 5, 5), acc('b@x.com', 1, 1), acc('c@x.com', 2, 2)],
      {
        strategy: 'lowestUsage',
        order: ['c@x.com', 'a@x.com'],
        thresholds: thr,
        triggers: trig,
      }
    );
    assert.equal(chosen.email, 'c@x.com'); // b excluded from pool
  });

  it('when all hot, picks least bad', () => {
    const chosen = selectFailoverAccount(
      [acc('a@x.com', 99, 99), acc('b@x.com', 91, 95)],
      { strategy: 'lowestUsage', thresholds: thr, triggers: trig }
    );
    assert.equal(chosen.email, 'b@x.com');
  });
});

describe('selectFailoverAccount ordered', () => {
  it('walks preference list for first cool', () => {
    const chosen = selectFailoverAccount(
      [acc('a@x.com', 99, 10), acc('b@x.com', 20, 20), acc('c@x.com', 5, 5)],
      {
        strategy: 'ordered',
        order: ['a@x.com', 'b@x.com', 'c@x.com'],
        thresholds: thr,
        triggers: trig,
      }
    );
    assert.equal(chosen.email, 'b@x.com'); // a hot, b first cool
  });

  it('falls back to first in order if all hot', () => {
    const chosen = selectFailoverAccount(
      [acc('a@x.com', 99, 99), acc('b@x.com', 98, 98)],
      {
        strategy: 'ordered',
        order: ['a@x.com', 'b@x.com'],
        thresholds: thr,
        triggers: trig,
      }
    );
    assert.equal(chosen.email, 'a@x.com');
  });
});

describe('usageScore', () => {
  it('max of enabled dimensions', () => {
    const a = acc('x', 10, 80, 99);
    assert.equal(usageScore(a, { session: true, weekly: true, fable: false }), 80);
    assert.equal(usageScore(a, { session: true, weekly: true, fable: true }), 99);
  });
});

process.on('exit', () => {
  try {
    fs.unlinkSync(out);
  } catch {
    /* ignore */
  }
});
