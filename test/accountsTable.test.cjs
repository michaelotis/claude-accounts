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

  /** The link destination of the first switch link in the table, if any. */
  function linkArgs(md) {
    const m = md.match(/\(command:claudeProfiles\.switchAccount\?([^)\s]*)\)/);
    return m ? m[1] : null;
  }

  it('links a non-active row to the switch command with its email as a JSON array', () => {
    const md = formatAccountsTable([
      { label: 'motis', active: true, snap: snap(), email: 'motis@x.com' },
      { label: 'michaelotis', active: false, snap: snap(), email: 'mike@x.com' },
    ]);
    const lines = md.split('\n');
    assert.match(
      lines[3],
      /^\| \[michaelotis\]\(command:claudeProfiles\.switchAccount\?/,
      'non-active row is a command link'
    );
    const encoded = linkArgs(md);
    assert.deepEqual(
      JSON.parse(decodeURIComponent(encoded)),
      ['mike@x.com'],
      'positional args are a JSON array'
    );
    assert.ok(!lines[2].includes('command:'), 'the active row has nowhere to go');
    assert.match(lines[2], /^\| \*\*motis\*\* • \| /, 'active row still bolded + marked');
  });

  it('leaves a row without an email as plain text', () => {
    const md = formatAccountsTable([{ label: 'nomail', active: false, snap: snap() }]);
    assert.equal(linkArgs(md), null, 'no email, no link');
    assert.match(md.split('\n')[2], /^\| nomail \| /);
  });

  it('encodes an email that would otherwise break out of the link', () => {
    const email = 'we ird+"x"(y)[z]@ex.com';
    const md = formatAccountsTable([
      { label: 'odd', active: false, snap: snap(), email, stale: true },
    ]);
    const encoded = linkArgs(md);
    assert.deepEqual(JSON.parse(decodeURIComponent(encoded)), [email], 'round-trips intact');
    assert.ok(
      !/[()[\]"|\s]/.test(encoded),
      `destination carries no markdown or table metacharacter: ${encoded}`
    );
    // The stale hint stays outside the link, where a click cannot reach it.
    assert.match(md, /\) _\(stale\)_ \|/);
  });
});
