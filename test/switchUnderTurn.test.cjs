const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');

/**
 * setupWizard.ts is the whole user-facing surface, so the vscode stub here
 * records what it was asked to show and lets each test decide what the user
 * clicked. Everything the switch path touches on disk is a temp dir.
 */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `switch-turn-${process.pid}-`));
const vscodeStub = path.join(tmpRoot, 'vscode-stub.js');
fs.writeFileSync(
  vscodeStub,
  `global.__caWarnings = [];
   global.__caInfos = [];
   global.__caCommands = [];
   global.__caWarnReply = undefined;
   module.exports = {
     window: {
       createOutputChannel: () => ({ appendLine() {}, show() {} }),
       showWarningMessage: (message, ...rest) => {
         global.__caWarnings.push({ message, rest });
         return Promise.resolve(global.__caWarnReply);
       },
       showInformationMessage: (message) => {
         global.__caInfos.push(message);
         return Promise.resolve(undefined);
       },
       showErrorMessage: () => Promise.resolve(undefined),
       showQuickPick: () => Promise.resolve(undefined),
       withProgress: (_opts, task) => task(),
     },
     commands: {
       executeCommand: (id) => {
         global.__caCommands.push(id);
         return Promise.resolve(undefined);
       },
     },
     workspace: {
       workspaceFolders: [],
       getConfiguration: () => ({ get: (_key, fallback) => fallback }),
     },
     ProgressLocation: { Notification: 15 },
   };`
);
const bundleOut = path.join(tmpRoot, 'setupWizard.bundle.cjs');
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/setupWizard.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundleOut,
  alias: { vscode: vscodeStub },
});
const {
  SetupWizard,
  confirmSwitchDuringTurn,
  midTurnSwitchWarning,
  SWITCH_ANYWAY,
  NOTICE_KEY,
} = require(bundleOut);

const REASON_KEY = 'claudeProfiles.lastAutoReloadReason';
const STAMP_KEY = 'claudeProfiles.lastAutoReload';

let n = 0;
/** An empty working dir: no token, so the mirror step is a no-op on disk. */
function freshDir() {
  const dir = path.join(tmpRoot, `wd-${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeWizard(phase) {
  const wd = freshDir();
  const bound = [];
  const probes = [];
  const workspaceState = new Map();
  const globalState = new Map();
  const registry = {
    emailOf: () => undefined,
    list: () => [],
    listUniqueByEmail: () => [],
    get: () => undefined,
  };
  const binding = {
    bind: async (a) => {
      bound.push(a.name);
    },
    workingDir: () => wd,
    getEnvDir: () => wd,
    getActiveName: () => 'previous',
  };
  const stateApi = (map) => ({
    get: (key, fallback) => (map.has(key) ? map.get(key) : fallback),
    update: async (key, value) => {
      map.set(key, value);
    },
  });
  const wizard = new SetupWizard(registry, binding, {
    workspaceState: stateApi(workspaceState),
    globalState: stateApi(globalState),
  });
  wizard.probeTurn = () => {
    probes.push(1);
    return phase;
  };
  return { wizard, bound, probes, workspaceState, globalState, wd };
}

const ACCOUNT = { name: 'work', dir: '/nonexistent/store' };

describe('confirmSwitchDuringTurn', () => {
  it('only an explicit switch probes at all', async () => {
    let probed = 0;
    const ok = await confirmSwitchDuringTurn({
      userInitiated: false,
      target: 'a@b.c',
      probe: () => {
        probed++;
        return 'in_turn';
      },
      warn: () => assert.fail('an automatic switch must never warn'),
    });
    assert.equal(ok, true);
    assert.equal(probed, 0);
  });

  it('idle and unknown proceed without warning', async () => {
    for (const phase of ['idle', 'unknown']) {
      const ok = await confirmSwitchDuringTurn({
        userInitiated: true,
        target: 'a@b.c',
        probe: () => phase,
        warn: () => assert.fail(`${phase} must not warn`),
      });
      assert.equal(ok, true);
    }
  });

  it('in_turn asks, and only the confirm button proceeds', async () => {
    const seen = [];
    const ask = (reply) =>
      confirmSwitchDuringTurn({
        userInitiated: true,
        target: 'a@b.c',
        probe: () => 'in_turn',
        warn: (message, ...actions) => {
          seen.push({ message, actions });
          return Promise.resolve(reply);
        },
      });
    assert.equal(await ask(SWITCH_ANYWAY), true);
    assert.equal(await ask(undefined), false);
    assert.equal(await ask('Cancel'), false);
    assert.equal(seen.length, 3);
    for (const s of seen) {
      assert.deepEqual(s.actions, [SWITCH_ANYWAY]);
      assert.equal(s.message, midTurnSwitchWarning('a@b.c'));
      assert.match(s.message, /turn is still running/);
      assert.match(s.message, /a@b\.c/);
    }
  });
});

describe('switchTo under a running turn', () => {
  beforeEach(() => {
    global.__caWarnings = [];
    global.__caInfos = [];
    global.__caCommands = [];
    global.__caWarnReply = undefined;
  });

  it('cancelling changes nothing at all', async () => {
    const { wizard, bound, probes, workspaceState, globalState } = makeWizard('in_turn');
    global.__caWarnReply = undefined;
    await wizard.switchTo(ACCOUNT, { userInitiated: true });
    assert.equal(probes.length, 1);
    assert.equal(global.__caWarnings.length, 1);
    // The forget flow's modal idiom: message, { modal: true }, then the button.
    assert.deepEqual(global.__caWarnings[0].rest, [{ modal: true }, SWITCH_ANYWAY]);
    assert.deepEqual(bound, []);
    assert.deepEqual(global.__caCommands, []);
    assert.equal(workspaceState.size, 0);
    assert.equal(globalState.size, 0);
  });

  it('"Switch anyway" carries on: bind, then reload', async () => {
    const { wizard, bound, workspaceState } = makeWizard('in_turn');
    global.__caWarnReply = SWITCH_ANYWAY;
    await wizard.switchTo(ACCOUNT, { userInitiated: true });
    assert.equal(global.__caWarnings.length, 1);
    assert.deepEqual(bound, ['work']);
    assert.deepEqual(global.__caCommands, ['workbench.action.reloadWindow']);
    assert.equal(workspaceState.get(REASON_KEY), 'switch to work');
    assert.ok(workspaceState.get(STAMP_KEY) > 0);
  });

  it('idle and unknown switch straight through, with no modal', async () => {
    for (const phase of ['idle', 'unknown']) {
      global.__caWarnings = [];
      global.__caCommands = [];
      const { wizard, bound, probes } = makeWizard(phase);
      await wizard.switchTo(ACCOUNT, { userInitiated: true });
      assert.equal(probes.length, 1, `${phase} should still probe`);
      assert.deepEqual(global.__caWarnings, [], `${phase} must not warn`);
      assert.deepEqual(bound, ['work']);
      assert.deepEqual(global.__caCommands, ['workbench.action.reloadWindow']);
    }
  });

  it('automatic switches never probe and never warn', async () => {
    // Route correction passes userInitiated: false; panel cutover passes no
    // options at all. Both must reach the reload untouched.
    for (const opts of [{ userInitiated: false }, undefined]) {
      global.__caWarnings = [];
      global.__caCommands = [];
      const { wizard, bound, probes, workspaceState } = makeWizard('in_turn');
      await wizard.switchTo(ACCOUNT, opts);
      assert.equal(probes.length, 0, `${JSON.stringify(opts)} must not probe`);
      assert.deepEqual(global.__caWarnings, []);
      assert.deepEqual(bound, ['work']);
      assert.deepEqual(global.__caCommands, ['workbench.action.reloadWindow']);
      assert.equal(
        workspaceState.get(REASON_KEY),
        opts ? 'route correction to work' : 'switch to work'
      );
    }
  });

  it('a reload with no notice still records a reason and raises no toast', async () => {
    const { wizard, workspaceState, globalState } = makeWizard('idle');
    await wizard.switchTo(ACCOUNT, { userInitiated: true });
    assert.equal(workspaceState.get(REASON_KEY), 'switch to work');
    assert.equal(globalState.has(NOTICE_KEY), false);
    assert.deepEqual(global.__caInfos, []);
  });

  it('a notice still reaches the post-reload notice key unchanged', async () => {
    const { wizard, globalState, workspaceState } = makeWizard('idle');
    await wizard.switchTo(ACCOUNT, { userInitiated: false, notice: 'This folder is pinned.' });
    assert.equal(globalState.get(NOTICE_KEY), 'This folder is pinned.');
    assert.equal(workspaceState.get(REASON_KEY), 'route correction to work');
  });
});
