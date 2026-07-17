const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');

/** usageParse.ts is vscode-free; bundle it directly. */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `acct-table-${process.pid}-`));
const bundleOut = path.join(tmpRoot, 'usageParse.bundle.cjs');
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/usageParse.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundleOut,
});
const { formatAccountsTable } = require(bundleOut);

const inOneHour = new Date(Date.now() + 3_600_000 + 5_000).toISOString();

function snap(overrides = {}) {
  return {
    sessionPercent: 62,
    sessionResetsAt: inOneHour,
    weeklyPercent: 41,
    weeklyResetsAt: null,
    opusPercent: null,
    opusResetsAt: null,
    sonnetPercent: null,
    sonnetResetsAt: null,
    modelLimits: [{ name: 'Fable', percent: 55, resetsAt: inOneHour, kind: 'fable' }],
    overagePercent: null,
    email: 'a@x.com',
    orgName: null,
    planLabel: null,
    fetchedAt: Date.now(),
    configDir: '/tmp/x',
    ...overrides,
  };
}

describe('formatAccountsTable', () => {
  it('renders header, active marker, bold percents, and inline resets', () => {
    const md = formatAccountsTable([
      { label: 'motis', active: true, snap: snap() },
      { label: 'michaelotis', active: false, snap: snap({ sessionPercent: 10 }) },
    ]);
    const lines = md.split('\n');
    assert.equal(lines[0], '| Account | 5h | 7d | Fable |');
    assert.equal(lines[1], '| --- | --- | --- | --- |');
    assert.match(lines[2], /^\| \*\*motis\*\* • \| /, 'active row bolded + marked');
    assert.match(lines[2], /\*\*62%\*\* 1h \d+m/, 'percent bold with inline reset');
    assert.match(lines[2], /\*\*55%\*\*/, 'fable percent present');
    assert.match(
      lines[3],
      /^\| michaelotis \| \*\*10%\*\*/,
      'secondary row unmarked, override applied'
    );
  });

  it('escapes pipes and markdown-active characters in labels', () => {
    const md = formatAccountsTable([
      { label: 'weird|name', active: false, snap: snap() },
      { label: 'em_pha*sis`[x]', active: true, snap: snap() },
    ]);
    assert.match(md, /weird\\\|name/);
    assert.match(md, /em\\_pha\\\*sis\\`\\\[x\\\]/);
  });

  it('renders dashes for a missing snapshot and a missing Fable bucket', () => {
    const md = formatAccountsTable([
      { label: 'empty', active: false, snap: null },
      { label: 'nofable', active: false, snap: { ...snap(), modelLimits: [] } },
    ]);
    const lines = md.split('\n');
    assert.equal(lines[2], '| empty | — | — | — |');
    assert.match(lines[3], /\| — \|$/, 'fable cell dashes when the bucket is absent');
  });

  it('marks stale rows', () => {
    const md = formatAccountsTable([{ label: 'old', active: false, snap: snap(), stale: true }]);
    assert.match(md, /old _\(stale\)_/);
  });
});
