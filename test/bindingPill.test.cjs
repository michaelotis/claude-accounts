const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');

/**
 * statusBar.ts is the one UI module under unit test, so its vscode stub goes
 * further than the log-only stub the other suites use: status bar items are
 * captured by id, and ThemeColor / MarkdownString are recorded so the account
 * item's text and background can be asserted directly.
 */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `binding-pill-${process.pid}-`));
const vscodeStub = path.join(tmpRoot, 'vscode-stub.js');
fs.writeFileSync(
  vscodeStub,
  `// esbuild inlines this stub into the bundle, so the created items are published
   // on a global the test process can read (its own require() of this file would be
   // a separate module instance with an empty registry).
   const items = (globalThis.__caStatusItems = globalThis.__caStatusItems || {});
   class ThemeColor { constructor(id) { this.id = id; } }
   class MarkdownString {
     constructor(value) { this.value = value; }
     appendMarkdown(v) { this.value += v; return this; }
   }
   class Disposable { constructor(fn) { this.dispose = fn || (() => {}); } }
   class EventEmitter {
     constructor() { this.event = () => new Disposable(); }
     fire() {}
     dispose() {}
   }
   module.exports = {
     __items: items,
     window: {
       createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
       showWarningMessage: () => Promise.resolve(undefined),
       showInformationMessage: () => Promise.resolve(undefined),
       showErrorMessage: () => Promise.resolve(undefined),
       onDidChangeWindowState: () => new Disposable(),
       createStatusBarItem: (id) => {
         const item = {
           id,
           text: '',
           tooltip: undefined,
           command: undefined,
           name: undefined,
           backgroundColor: undefined,
           visible: false,
           show() { this.visible = true; },
           hide() { this.visible = false; },
           dispose() {},
         };
         items[id] = item;
         return item;
       },
     },
     workspace: {
       workspaceFolders: undefined,
       getConfiguration: () => ({ get: () => undefined, inspect: () => undefined, update: () => Promise.resolve() }),
     },
     commands: { executeCommand: () => Promise.resolve(undefined) },
     StatusBarAlignment: { Left: 1, Right: 2 },
     ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
     ThemeColor,
     MarkdownString,
     Disposable,
     EventEmitter,
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
const vscode = require(vscodeStub);
/** The items the BUNDLED stub created (shared via globalThis, not this require). */
const items = () => globalThis.__caStatusItems;

function snapFor(over = {}) {
  return {
    sessionPercent: 0,
    sessionResetsAt: null,
    weeklyPercent: 0,
    weeklyResetsAt: null,
    opusPercent: null,
    opusResetsAt: null,
    sonnetPercent: null,
    sonnetResetsAt: null,
    modelLimits: [],
    overagePercent: null,
    email: 'a@x.com',
    orgName: null,
    planLabel: null,
    fetchedAt: Date.now(),
    configDir: '/tmp/x',
    ...over,
  };
}

let n = 0;
/** A real config dir: readIdentity + hasCredentials read it off disk. */
function signedInDir(email) {
  const dir = path.join(tmpRoot, `dir-${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: email, displayName: email } })
  );
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: {} }));
  return dir;
}

/** Paint the bar for one account + snapshot and hand back the account item. */
function paint(email, snap, usageOver = {}) {
  const dir = signedInDir(email);
  const registry = {
    getByDir: () => ({ name: 'acct' }),
    savedForEmail: () => ({ name: 'acct' }),
    listUniqueByEmail: () => [],
    emailOf: () => undefined,
  };
  const binding = {
    onDidChange: { event: () => new vscode.Disposable() },
    getEnvDir: () => dir,
    getActiveName: () => 'acct',
    rememberedForFolder: () => false,
  };
  const usage = {
    setActiveDir() {},
    start() {},
    dispose() {},
    onChange: () => new vscode.Disposable(),
    getCached: () => snap,
    getAllCachedByEmail: () => new Map(snap ? [[email.toLowerCase(), snap]] : []),
    isRateLimited: () => false,
    rateLimitWaitMs: () => null,
    ...usageOver,
  };
  const bar = new StatusBarManager(registry, binding, usage);
  bar.initialize();
  const item = items()['claudeAccounts.status'];
  return { item, bar };
}

/** Markdown of the account item's tooltip card. */
function tip(item) {
  return item.tooltip?.value ?? '';
}

describe('account item leads with the binding constraint', () => {
  it('a 7d at 96% is the text and the color, even with 5h just reset', () => {
    const { item, bar } = paint('a@x.com', snapFor({ sessionPercent: 0, weeklyPercent: 96 }));
    assert.equal(item.text, '$(account) a · 7d 96%');
    assert.equal(item.backgroundColor.id, 'statusBarItem.errorBackground');
    bar.dispose();
  });

  it('a never-fetched snapshot keeps the plain account text and no color', () => {
    const { item, bar } = paint('a@x.com', snapFor({ fetchedAt: 0 }));
    assert.equal(item.text, '$(account) a');
    assert.equal(item.backgroundColor, undefined);
    bar.dispose();
  });

  it('a long account name is truncated but the constraint survives', () => {
    const email = `${'n'.repeat(120)}@x.com`;
    const { item, bar } = paint(email, snapFor({ email, sessionPercent: 0, weeklyPercent: 96 }));
    assert.ok(item.text.length <= 80, `length ${item.text.length}`);
    assert.ok(item.text.endsWith(' · 7d 96%'), item.text);
    assert.ok(item.text.includes('…'), item.text);
    bar.dispose();
  });

  it('truncation never cuts inside a codicon', () => {
    // The name is truncated before composing, so no slice can land inside `$(…)`
    // and leave the status bar printing raw markup.
    const email = `${'n'.repeat(120)}@x.com`;
    const { item, bar } = paint(email, snapFor({ email, sessionPercent: 0, weeklyPercent: 96 }));
    const leftovers = item.text.replace(/\$\([^()]+\)/g, '');
    assert.ok(!leftovers.includes('$('), `unbalanced codicon in ${item.text}`);
    bar.dispose();
  });

  it('an unsaved account keeps both codicons intact at full length', () => {
    const email = `${'n'.repeat(120)}@x.com`;
    const dirless = paint(email, snapFor({ email, sessionPercent: 0, weeklyPercent: 96 }));
    dirless.bar.setRefreshing(true);
    const text = items()['claudeAccounts.status'].text;
    assert.ok(text.length <= 80, `length ${text.length}`);
    assert.ok(text.includes('$(sync~spin)'), text);
    assert.ok(!text.replace(/\$\([^()]+\)/g, '').includes('$('), text);
    dirless.bar.dispose();
  });

  it('the binding figure uses the same warn threshold as its own pill', () => {
    // 67% is under the 7d pill's 70 warn point; the item must not be amber while
    // the pill showing the same number is plain.
    const { item, bar } = paint('a@x.com', snapFor({ sessionPercent: 12, weeklyPercent: 67 }));
    assert.equal(item.text, '$(account) a · 7d 67%');
    assert.equal(item.backgroundColor, undefined);
    assert.equal(items()['claudeAccounts.usage.weekly'].backgroundColor, undefined);
    bar.dispose();
  });

  it('a model limit above both buckets is what the item shows', () => {
    const { item, bar } = paint(
      'a@x.com',
      snapFor({
        sessionPercent: 12,
        weeklyPercent: 60,
        modelLimits: [{ name: 'Fable', percent: 73, resetsAt: null, kind: 'weekly_scoped' }],
      })
    );
    assert.equal(item.text, '$(account) a · Fable 73%');
    assert.equal(item.backgroundColor.id, 'statusBarItem.warningBackground');
    bar.dispose();
  });
});

describe('the tooltip tells the truth about staleness', () => {
  it('a rate-limit warning outranks a refresh receipt', () => {
    const { item, bar } = paint('a@x.com', snapFor({ sessionPercent: 42 }), {
      isRateLimited: () => true,
      rateLimitWaitMs: () => 96_000,
    });
    bar.setRefreshNote('Usage is already current — no call was needed.', true);
    assert.match(tip(item), /rate-limiting this account/);
    assert.match(tip(item), /next attempt in 96s/);
    assert.ok(!tip(item).includes('Usage is already current'), tip(item));
    bar.dispose();
  });

  it('a refresh receipt expires', () => {
    const { item, bar } = paint('a@x.com', snapFor({ sessionPercent: 42 }));
    bar.setRefreshNote('Usage is already current — no call was needed.', true);
    assert.match(tip(item), /Usage is already current/);
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 31_000;
      bar.reconfirm(); // repaint, nothing else changed
      assert.ok(!tip(item).includes('Usage is already current'), tip(item));
    } finally {
      Date.now = realNow;
    }
    bar.dispose();
  });

  it('a 12-minute-old snapshot is never called current or shortly', () => {
    const { item, bar } = paint(
      'a@x.com',
      snapFor({ sessionPercent: 42, fetchedAt: Date.now() - 12 * 60_000 }),
      { isRateLimited: () => true, rateLimitWaitMs: () => 45_000 }
    );
    const md = tip(item);
    assert.ok(!md.includes('current'), md);
    assert.ok(!md.includes('shortly'), md);
    assert.match(md, /last figures are 12m old/);
    assert.match(md, /Refreshed 12m ago/);
    bar.dispose();
  });

  it('a 601s-old row is not stale, a 21-minute-old one is', () => {
    const fresh = paint('a@x.com', snapFor({ fetchedAt: Date.now() - 601_000 }));
    assert.ok(!tip(fresh.item).includes('(stale)'), tip(fresh.item));
    fresh.bar.dispose();

    const old = paint('a@x.com', snapFor({ fetchedAt: Date.now() - 21 * 60_000 }));
    assert.match(tip(old.item), /_\(stale\)_/);
    old.bar.dispose();
  });
});

describe('metric pills are untouched by the binding constraint', () => {
  it('each pill still reads and colors from its own percent', () => {
    const { bar } = paint(
      'a@x.com',
      snapFor({
        sessionPercent: 10,
        weeklyPercent: 96,
        modelLimits: [{ name: 'Fable', percent: 72, resetsAt: null, kind: 'weekly_scoped' }],
      })
    );
    const session = items()['claudeAccounts.usage.session'];
    const weekly = items()['claudeAccounts.usage.weekly'];
    const fable = items()['claudeAccounts.usage.fable'];
    assert.equal(session.text, '5h 10%');
    assert.equal(session.backgroundColor, undefined);
    assert.equal(weekly.text, '7d 96%');
    assert.equal(weekly.backgroundColor.id, 'statusBarItem.errorBackground');
    assert.equal(fable.text, 'Fable 72%');
    assert.equal(fable.backgroundColor.id, 'statusBarItem.warningBackground');
    bar.dispose();
  });
});

process.on('exit', () => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
