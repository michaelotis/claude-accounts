const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');

/**
 * turnWatcher.ts → log.ts imports vscode, so bundle with the same minimal stub
 * the other unit suites use.
 */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `turn-watch-${process.pid}-`));
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
const bundleOut = path.join(tmpRoot, 'turnWatcher.bundle.cjs');
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/turnWatcher.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundleOut,
  alias: { vscode: vscodeStub },
});
const { TurnWatcher, projectSlug } = require(bundleOut);

let n = 0;
function freshDir() {
  const dir = path.join(tmpRoot, `dir-${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeUnder(configDir, cwd, rel, body = '{"x":1}\n') {
  const file = path.join(configDir, 'projects', projectSlug(cwd), rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

function ageFile(file, msAgo = 60_000) {
  const t = new Date(Date.now() - msAgo);
  fs.utimesSync(file, t, t);
}

function makeWatcher(configDir, cwds, fallback = [], opts = {}) {
  const counts = { busy: 0, idle: 0 };
  const { start = true, ...rest } = opts;
  const w = new TurnWatcher(() => configDir, {
    settleMs: 0,
    activityWindowMs: 50,
    pollMs: 100_000,
    getCwds: () => cwds,
    getFallbackCwds: () => fallback,
    ...rest,
  });
  w.onBusy = () => {
    counts.busy++;
  };
  w.onIdle = () => {
    counts.idle++;
  };
  if (start) w.start();
  return { w, counts };
}

describe('projectSlug', () => {
  it("maps /a/b.c_d to '-a-b-c-d'", () => {
    assert.equal(projectSlug('/a/b.c_d'), '-a-b-c-d');
  });
});

describe('TurnWatcher scoping', () => {
  it('a fresh write under the injected cwd slug is in_turn and onBusy fires once', () => {
    const configDir = freshDir();
    const cwdA = path.join(tmpRoot, 'win-a');
    const { w, counts } = makeWatcher(configDir, [cwdA]);
    writeUnder(configDir, cwdA, 's.jsonl');
    w.poke();
    w.poke();
    assert.equal(w.getPhase(), 'in_turn');
    assert.equal(counts.busy, 1);
    assert.equal(counts.idle, 0);
  });

  it('a fresh write only under another slug stays idle', () => {
    const configDir = freshDir();
    const cwdA = path.join(tmpRoot, 'win-a2');
    const cwdB = path.join(tmpRoot, 'win-b');
    const { w, counts } = makeWatcher(configDir, [cwdA]);
    writeUnder(configDir, cwdB, 's.jsonl');
    w.poke();
    assert.equal(w.getPhase(), 'idle');
    assert.equal(counts.busy, 0);
  });

  it('a fresh write under <sid>/subagents is in_turn', () => {
    const configDir = freshDir();
    const cwdA = path.join(tmpRoot, 'win-a3');
    const { w, counts } = makeWatcher(configDir, [cwdA]);
    writeUnder(configDir, cwdA, path.join('sid123', 'subagents', 'agent.jsonl'));
    w.poke();
    assert.equal(w.getPhase(), 'in_turn');
    assert.equal(counts.busy, 1);
  });

  it('aging the file stays in_turn until settleMs elapses', async () => {
    const configDir = freshDir();
    const cwdA = path.join(tmpRoot, 'win-a4');
    const { w, counts } = makeWatcher(configDir, [cwdA], [], {
      settleMs: 200,
      activityWindowMs: 50,
    });
    const file = writeUnder(configDir, cwdA, 's.jsonl');
    w.poke();
    assert.equal(w.getPhase(), 'in_turn');
    ageFile(file);
    w.poke();
    assert.equal(w.getPhase(), 'in_turn');
    assert.equal(counts.idle, 0);
    await new Promise((r) => setTimeout(r, 250));
    w.poke();
    assert.equal(w.getPhase(), 'idle');
    assert.equal(counts.idle, 1);
  });

  it("stop() while in_turn resets getPhase() to 'idle'", () => {
    const configDir = freshDir();
    const cwdA = path.join(tmpRoot, 'win-a5');
    const { w } = makeWatcher(configDir, [cwdA]);
    writeUnder(configDir, cwdA, 's.jsonl');
    w.poke();
    assert.equal(w.getPhase(), 'in_turn');
    w.stop();
    assert.equal(w.getPhase(), 'idle');
  });

  it('uses getFallbackCwds when getCwds returns []', () => {
    const configDir = freshDir();
    const cwdA = path.join(tmpRoot, 'win-fallback');
    const { w, counts } = makeWatcher(configDir, [], [cwdA]);
    writeUnder(configDir, cwdA, 's.jsonl');
    w.poke();
    assert.equal(w.getPhase(), 'in_turn');
    assert.equal(counts.busy, 1);
  });

  it('a foreign slug write while in_turn neither idles nor extends the turn', async () => {
    const configDir = freshDir();
    const cwdA = path.join(tmpRoot, 'win-for-a');
    const cwdB = path.join(tmpRoot, 'win-for-b');
    const { w, counts } = makeWatcher(configDir, [cwdA], [], { settleMs: 200 });
    const own = writeUnder(configDir, cwdA, 's.jsonl');
    w.poke();
    assert.equal(w.getPhase(), 'in_turn');
    // Own file past the activity window but inside settle: still in_turn.
    ageFile(own);
    w.poke();
    assert.equal(w.getPhase(), 'in_turn');
    // A fresh write under another window's slug must not count as activity.
    writeUnder(configDir, cwdB, 's.jsonl');
    w.poke();
    assert.equal(w.getPhase(), 'in_turn');
    assert.equal(counts.idle, 0);
    // ...nor may it have refreshed lastActivityAt: settle still expires on time.
    await new Promise((r) => setTimeout(r, 250));
    writeUnder(configDir, cwdB, 't.jsonl');
    w.poke();
    assert.equal(w.getPhase(), 'idle');
    assert.equal(counts.idle, 1);
  });

  it('ignores shared sessions/ and history.jsonl', () => {
    const configDir = freshDir();
    const cwdA = path.join(tmpRoot, 'win-shared');
    const { w, counts } = makeWatcher(configDir, [cwdA]);
    fs.mkdirSync(path.join(configDir, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(configDir, 'sessions', 's.jsonl'), '{"x":1}\n');
    fs.writeFileSync(path.join(configDir, 'history.jsonl'), '{"x":1}\n');
    w.poke();
    assert.equal(w.getPhase(), 'idle');
    assert.equal(counts.busy, 0);
    assert.equal(counts.idle, 0);
  });

  it('stop() while in_turn does not call onIdle; poke is a no-op when not started', () => {
    const configDir = freshDir();
    const cwdA = path.join(tmpRoot, 'win-stop-idle');
    const { w, counts } = makeWatcher(configDir, [cwdA]);
    writeUnder(configDir, cwdA, 's.jsonl');
    w.poke();
    assert.equal(w.getPhase(), 'in_turn');
    w.stop();
    assert.equal(w.getPhase(), 'idle');
    assert.equal(counts.idle, 0);
    w.poke();
    assert.equal(w.getPhase(), 'idle');
    assert.equal(counts.idle, 0);
    assert.equal(counts.busy, 1);

    const { w: neverStarted, counts: c2 } = makeWatcher(configDir, [cwdA], [], {
      start: false,
    });
    writeUnder(configDir, cwdA, 'never.jsonl');
    neverStarted.poke();
    assert.equal(neverStarted.getPhase(), 'idle');
    assert.equal(c2.busy, 0);
    assert.equal(c2.idle, 0);
  });

  it('unions getCwds and getFallbackCwds', () => {
    const configDir = freshDir();
    const cwdA = path.join(tmpRoot, 'win-union-a');
    const cwdB = path.join(tmpRoot, 'win-union-b');
    const { w, counts } = makeWatcher(configDir, [cwdA], [cwdB]);
    writeUnder(configDir, cwdB, 's.jsonl');
    w.poke();
    assert.equal(w.getPhase(), 'in_turn');
    assert.equal(counts.busy, 1);
  });

  it('restart keeps settle across stop/start', () => {
    const configDir = freshDir();
    const cwdA = path.join(tmpRoot, 'win-restart');
    const { w } = makeWatcher(configDir, [cwdA], [], {
      settleMs: 200,
      pollMs: 100_000,
    });
    const file = writeUnder(configDir, cwdA, 's.jsonl');
    w.poke();
    assert.equal(w.getPhase(), 'in_turn');
    ageFile(file);
    w.stop();
    w.start();
    assert.equal(w.getPhase(), 'in_turn');
    w.stop();
  });

  it('caches an empty cwd scan for cwdRescanMs', () => {
    const configDir = freshDir();
    let calls = 0;
    const w = new TurnWatcher(() => configDir, {
      settleMs: 0,
      activityWindowMs: 50,
      cwdRescanMs: 10_000,
      pollMs: 100_000,
      getCwds: () => {
        calls++;
        return [];
      },
      getFallbackCwds: () => [],
    });
    w.start();
    w.poke();
    w.poke();
    w.poke();
    assert.equal(calls, 1);
    w.stop();
  });
});
