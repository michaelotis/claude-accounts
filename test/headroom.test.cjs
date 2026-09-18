const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');

/**
 * statusBar.ts pulls in vscode through the whole extension; bundle it against
 * the same minimal stub the other unit suites use, with the status-bar items it
 * creates captured so a render can be read back.
 */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `headroom-${process.pid}-`));
const vscodeStub = path.join(tmpRoot, 'vscode-stub.js');
fs.writeFileSync(
  vscodeStub,
  // esbuild inlines this stub into the bundle, so the created-items list is
  // shared with the test through globalThis rather than the module object.
  `const created = (globalThis.__claudeStatusItems = globalThis.__claudeStatusItems || []);
   class MarkdownString {
     constructor(value) { this.value = value; }
   }
   module.exports = {
     MarkdownString,
     ThemeColor: class { constructor(id) { this.id = id; } },
     StatusBarAlignment: { Right: 2, Left: 1 },
     EventEmitter: class {
       constructor() { this.listeners = []; this.event = (fn) => { this.listeners.push(fn); return { dispose() {} }; }; }
       fire(v) { this.listeners.forEach((fn) => fn(v)); }
       dispose() {}
     },
     window: {
       createOutputChannel: () => ({ appendLine() {}, show() {} }),
       createStatusBarItem: (id) => {
         const item = { id, text: '', tooltip: undefined, visible: false,
           show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} };
         created.push(item);
         return item;
       },
       onDidChangeWindowState: () => ({ dispose() {} }),
       showWarningMessage: () => Promise.resolve(undefined),
       showInformationMessage: () => Promise.resolve(undefined),
       showErrorMessage: () => Promise.resolve(undefined),
     },
     workspace: {
       workspaceFolders: undefined,
       getConfiguration: () => ({ get: () => undefined, update: () => Promise.resolve(undefined), inspect: () => undefined }),
     },
     commands: { executeCommand: () => Promise.resolve(undefined) },
   };`
);
const bundleOut = path.join(tmpRoot, 'statusBar.bundle.cjs');
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/statusBar.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundleOut,
  alias: { vscode: vscodeStub },
});
const { StatusBarManager } = require(bundleOut);
const createdItems = globalThis.__claudeStatusItems || [];

const ACTIVE = 'a@example.com';
const OTHER = 'b@example.com';

let n = 0;
/** A config dir that readIdentity/hasCredentials accept as the signed-in account. */
function signedInDir(email) {
  const dir = path.join(tmpRoot, `cfg-${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), '{}');
  fs.writeFileSync(
    path.join(dir, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: email, displayName: email } })
  );
  return dir;
}

/**
 * Every fixture is stamped a minute after the one before it: a cue is only
 * raised by a genuinely newer reading, so a suite of snapshots sharing one fetch
 * time would never produce one. Tests about the stamp pass their own.
 */
let fixtureClock = 1_700_000_000_000;

function snap(overrides = {}) {
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
    email: ACTIVE,
    orgName: null,
    planLabel: null,
    fetchedAt: fixtureClock,
    configDir: '/tmp/x',
    ...overrides,
  };
}

function fable(percent, email) {
  return snap({
    email,
    modelLimits: [{ name: 'Fable', percent, resetsAt: null, kind: 'weekly_scoped' }],
  });
}

function makeBar() {
  const dir = signedInDir(ACTIVE);
  const accounts = [
    { name: 'motis', dir, email: ACTIVE },
    { name: 'michaelotis', dir: `${dir}-other`, email: OTHER },
  ];
  const registry = {
    getByDir: (d) => accounts.find((a) => a.dir === d),
    savedForEmail: (email) => accounts.find((a) => a.email === email),
    listUniqueByEmail: () => accounts,
    emailOf: (a) => a.email,
  };
  const binding = {
    onDidChange: { event: () => ({ dispose() {} }) },
    getEnvDir: () => dir,
    getActiveName: () => 'motis',
    rememberedForFolder: () => false,
  };
  const cache = new Map();
  const usage = {
    onChange: () => ({ dispose() {} }),
    getCached: () => cache.get(ACTIVE) ?? null,
    getAllCachedByEmail: () => cache,
    isRateLimited: () => false,
    rateLimitWaitMs: () => null,
    setActiveDir() {},
    start() {},
    refresh: () => Promise.resolve(undefined),
    dispose() {},
  };
  const before = createdItems.length;
  const bar = new StatusBarManager(registry, binding, usage);
  const items = {};
  for (const item of createdItems.slice(before)) items[item.id] = item;
  return {
    bar,
    reconfirm: () => bar.reconfirm(),
    cache,
    account: items['claudeAccounts.status'],
    session: items['claudeAccounts.usage.session'],
    weekly: items['claudeAccounts.usage.weekly'],
    fableItem: items['claudeAccounts.usage.fable'],
    card: () => items['claudeAccounts.status'].tooltip.value,
  };
}

/** Run fn with Date.now shifted forward, as the TTL sees it. */
function atOffset(ms, fn) {
  const real = Date.now;
  Date.now = () => real.call(Date) + ms;
  try {
    return fn();
  } finally {
    Date.now = real;
  }
}

describe('status bar headroom cue', () => {
  it('says nothing on the first render, but seeds the baseline the next one uses', () => {
    const bar = makeBar();
    bar.cache.set(ACTIVE, fable(100, ACTIVE));
    bar.reconfirm();
    assert.equal(bar.fableItem.text, 'Fable 100%');
    assert.doesNotMatch(bar.card(), /allowance went up|reset for/);
    // Silent, not blind: the first pass stored 100% as what this window had
    // seen, so the drop below has something to be a drop from.
    bar.cache.set(ACTIVE, fable(70, ACTIVE));
    bar.reconfirm();
    assert.equal(bar.fableItem.text, '$(sparkle) Fable 70%');
    assert.match(bar.card(), /Fable allowance went up for motis/);
    bar.bar.dispose();
  });

  it('drops the cue as soon as the bucket fills again', () => {
    const bar = makeBar();
    bar.cache.set(ACTIVE, snap({ sessionPercent: 96 }));
    bar.reconfirm();
    bar.cache.set(ACTIVE, snap({ sessionPercent: 0 }));
    bar.reconfirm();
    assert.equal(bar.session.text, '$(sparkle) 5h 0%');

    // A point or two of climb is the same jitter that would not have made a drop.
    bar.cache.set(ACTIVE, snap({ sessionPercent: 2 }));
    bar.reconfirm();
    assert.equal(bar.session.text, '$(sparkle) 5h 2%');
    assert.match(bar.card(), /5h reset for motis/);

    // Spent again: the cue would now contradict the number it sits beside.
    bar.cache.set(ACTIVE, snap({ sessionPercent: 94 }));
    bar.reconfirm();
    assert.equal(bar.session.text, '5h 94%');
    assert.doesNotMatch(bar.card(), /5h reset/);
    bar.bar.dispose();
  });

  it('keeps the first bucket when a second one comes back', () => {
    const bar = makeBar();
    bar.cache.set(ACTIVE, snap({ sessionPercent: 96 }));
    bar.reconfirm();
    bar.cache.set(ACTIVE, snap({ sessionPercent: 0 }));
    bar.reconfirm();
    bar.cache.set(
      ACTIVE,
      snap({
        sessionPercent: 0,
        modelLimits: [{ name: 'Fable', percent: 70, resetsAt: null, kind: 'weekly_scoped' }],
      })
    );
    bar.reconfirm();
    const card = bar.card();
    assert.match(card, /5h reset — 0% used/);
    assert.match(card, /Fable allowance went up — 100% → 70%/);
    assert.equal(bar.session.text, '$(sparkle) 5h 0%');
    assert.equal(bar.fableItem.text, '$(sparkle) Fable 70%');
    bar.bar.dispose();
  });

  it("sparkles the active account's pill after a drop, and drops it at the TTL", () => {
    const bar = makeBar();
    bar.cache.set(ACTIVE, fable(100, ACTIVE));
    bar.reconfirm();
    bar.cache.set(ACTIVE, fable(70, ACTIVE));
    bar.reconfirm();
    assert.equal(bar.fableItem.text, '$(sparkle) Fable 70%');
    assert.match(bar.card(), /Fable allowance went up for motis — 100% → 70%/);
    // Untouched buckets keep their plain pills.
    assert.equal(bar.session.text, '5h 40%');
    assert.equal(bar.weekly.text, '7d 50%');

    atOffset(31 * 60_000, () => bar.reconfirm());
    assert.equal(bar.fableItem.text, 'Fable 70%');
    assert.doesNotMatch(bar.card(), /allowance went up/);
    bar.bar.dispose();
  });

  it('marks a 5h reset on its own pill and words it as a reset', () => {
    const bar = makeBar();
    bar.cache.set(ACTIVE, snap({ sessionPercent: 96 }));
    bar.reconfirm();
    bar.cache.set(ACTIVE, snap({ sessionPercent: 0 }));
    bar.reconfirm();
    assert.equal(bar.session.text, '$(sparkle) 5h 0%');
    assert.equal(bar.fableItem.text, 'Fable 100%');
    assert.match(bar.card(), /5h reset for motis — 0% used/);
    bar.bar.dispose();
  });

  it('shows another account’s headroom in the card only — no pill', () => {
    const bar = makeBar();
    bar.cache.set(ACTIVE, fable(100, ACTIVE));
    bar.cache.set(OTHER, fable(100, OTHER));
    bar.reconfirm();
    bar.cache.set(OTHER, fable(70, OTHER));
    bar.reconfirm();
    assert.match(bar.card(), /Fable allowance went up for michaelotis — 100% → 70%/);
    for (const item of [bar.session, bar.weekly, bar.fableItem]) {
      assert.doesNotMatch(item.text, /sparkle/, `${item.id} must not sparkle for another account`);
    }
    bar.bar.dispose();
  });

  it('says a fleet-wide move once, not once per account', () => {
    const bar = makeBar();
    bar.cache.set(ACTIVE, fable(100, ACTIVE));
    bar.cache.set(OTHER, fable(100, OTHER));
    bar.reconfirm();
    bar.cache.set(ACTIVE, fable(70, ACTIVE));
    bar.cache.set(OTHER, fable(72, OTHER));
    bar.reconfirm();
    const card = bar.card();
    assert.match(card, /Fable allowance went up across 2 accounts/);
    assert.equal((card.match(/allowance went up/g) || []).length, 1);
    assert.doesNotMatch(card, /went up for motis/);
    assert.doesNotMatch(card, /went up for michaelotis/);
    // The active account's own pill still carries the cue.
    assert.equal(bar.fableItem.text, '$(sparkle) Fable 70%');
    bar.bar.dispose();
  });

  it('two buckets moving across the fleet get a line each', () => {
    const bar = makeBar();
    const both = (sessionPercent, fablePercent) =>
      snap({
        sessionPercent,
        modelLimits: [
          { name: 'Fable', percent: fablePercent, resetsAt: null, kind: 'weekly_scoped' },
        ],
      });
    bar.cache.set(ACTIVE, both(96, 100));
    bar.cache.set(OTHER, both(95, 100));
    bar.reconfirm();
    bar.cache.set(ACTIVE, both(0, 70));
    bar.cache.set(OTHER, both(0, 72));
    bar.reconfirm();
    const card = bar.card();
    assert.match(card, /5h reset across 2 accounts/);
    assert.match(card, /Fable allowance went up across 2 accounts/);
    // Two buckets, two lines — and nothing repeated per account.
    assert.doesNotMatch(card, /for motis|for michaelotis|motis:|michaelotis:/);
    bar.bar.dispose();
  });

  it('a fleet-wide line only says "reset" when every account reset', () => {
    const bar = makeBar();
    bar.cache.set(ACTIVE, fable(100, ACTIVE));
    bar.cache.set(OTHER, fable(100, OTHER));
    bar.reconfirm();
    // One window rolled over, the other's allowance moved: the weaker word is
    // the only one true of both, so the collapse takes all-or-nothing.
    bar.cache.set(ACTIVE, fable(0, ACTIVE));
    bar.cache.set(OTHER, fable(70, OTHER));
    bar.reconfirm();
    const card = bar.card();
    assert.match(card, /Fable allowance went up across 2 accounts/);
    assert.doesNotMatch(card, /Fable reset across/);
    bar.bar.dispose();
  });

  it('a model bucket’s cue clears when that bucket fills again, not just 5h', () => {
    const bar = makeBar();
    bar.cache.set(ACTIVE, fable(100, ACTIVE));
    bar.reconfirm();
    bar.cache.set(ACTIVE, fable(70, ACTIVE));
    bar.reconfirm();
    assert.equal(bar.fableItem.text, '$(sparkle) Fable 70%');
    assert.match(bar.card(), /Fable allowance went up for motis/);

    // Spent back past the same margin that made the drop worth reporting.
    bar.cache.set(ACTIVE, fable(74, ACTIVE));
    bar.reconfirm();
    assert.equal(bar.fableItem.text, 'Fable 74%');
    assert.doesNotMatch(bar.card(), /Fable allowance went up/);
    bar.bar.dispose();
  });

  it('a live cue keeps its pill when the API renames the bucket in another case', () => {
    const bar = makeBar();
    bar.cache.set(ACTIVE, fable(100, ACTIVE));
    bar.reconfirm();
    bar.cache.set(ACTIVE, fable(70, ACTIVE));
    bar.reconfirm();
    assert.equal(bar.fableItem.text, '$(sparkle) Fable 70%');

    // The cue was raised against `Fable`; the bucket has not moved, only its
    // name's case has. The pill is what explains the card line, so it must not
    // quietly stop matching.
    bar.cache.set(
      ACTIVE,
      snap({ modelLimits: [{ name: 'fable', percent: 70, resetsAt: null, kind: 'weekly_scoped' }] })
    );
    bar.reconfirm();
    assert.equal(bar.fableItem.text, '$(sparkle) Fable 70%');
    bar.bar.dispose();
  });

  it('a best-effort snapshot replayed during a backoff raises no cue', () => {
    const bar = makeBar();
    const spent = snap({ sessionPercent: 96 });
    bar.cache.set(ACTIVE, spent);
    bar.reconfirm();
    // A 429 serves the last good meter carrying the fetch time it was stored
    // with — older than what this window has already seen, so its lower figures
    // are a replay, not headroom.
    bar.cache.set(ACTIVE, snap({ sessionPercent: 0, fetchedAt: spent.fetchedAt - 1 }));
    bar.reconfirm();
    assert.equal(bar.session.text, '5h 0%');
    assert.doesNotMatch(bar.card(), /5h reset/);
    bar.bar.dispose();
  });
});

process.on('exit', () => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
