const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');

const out = path.join(os.tmpdir(), `wsroutes-${process.pid}.cjs`);
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/workspaceRoutes.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: out,
});
const {
  matchWorkspaceRoute,
  mergeRoutes,
  normalizePrefix,
  normalizeEmail,
  emailsEqual,
  pickStoredAccountName,
} = require(out);

describe('matchWorkspaceRoute', () => {
  const routes = [
    { pathPrefix: '/home/user/projects', email: 'personal@x.com' },
    { pathPrefix: '/home/user/projects/work-client', email: 'work@y.com' },
    { pathPrefix: '/home/user/projects/other-client', email: 'work@y.com' },
  ];

  it('picks longest prefix (work over personal root)', () => {
    const m = matchWorkspaceRoute('/home/user/projects/work-client/app', routes);
    assert.equal(m.email, 'work@y.com');
    assert.equal(normalizePrefix(m.pathPrefix), '/home/user/projects/work-client');
  });

  it('falls back to broader personal tree', () => {
    const m = matchWorkspaceRoute('/home/user/projects/side-project', routes);
    assert.equal(m.email, 'personal@x.com');
  });

  it('returns null outside trees', () => {
    assert.equal(matchWorkspaceRoute('/tmp/other', routes), null);
  });

  it('normalizes route email case', () => {
    const m = matchWorkspaceRoute('/home/user/projects/work-client', [
      { pathPrefix: '/home/user/projects/work-client', email: 'Work@Y.COM' },
    ]);
    assert.equal(m.email, 'work@y.com');
  });
});

describe('mergeRoutes', () => {
  it('settings override learned on same prefix', () => {
    const merged = mergeRoutes(
      [{ pathPrefix: '/home/user/projects/work-client', email: 'work@new.com' }],
      [{ pathPrefix: '/home/user/projects/work-client', email: 'old@x.com' }]
    );
    assert.equal(merged.length, 1);
    assert.equal(merged[0].email, 'work@new.com');
  });
});

describe('normalizeEmail / emailsEqual', () => {
  it('folds case and trims', () => {
    assert.equal(normalizeEmail('  Work@Example.COM '), 'work@example.com');
    assert.equal(emailsEqual('Work@Example.com', 'work@example.com'), true);
    assert.equal(emailsEqual('a@x.com', 'b@x.com'), false);
    assert.equal(emailsEqual('', 'a@x.com'), false);
  });
});

describe('pickStoredAccountName', () => {
  it('preferred wins over active and last', () => {
    assert.equal(
      pickStoredAccountName({
        preferredName: 'work',
        activeName: 'personal',
        lastName: 'other',
        hasWorkingDir: true,
      }),
      'work'
    );
  });

  it('active wins over last when no preferred', () => {
    assert.equal(
      pickStoredAccountName({
        activeName: 'personal',
        lastName: 'other',
        hasWorkingDir: true,
      }),
      'personal'
    );
  });

  it('last only when no working dir and no active', () => {
    assert.equal(
      pickStoredAccountName({
        lastName: 'other',
        hasWorkingDir: false,
      }),
      'other'
    );
    assert.equal(
      pickStoredAccountName({
        lastName: 'other',
        hasWorkingDir: true,
      }),
      undefined
    );
  });

  it('suppresses last-used when preferred is set even with working dir', () => {
    assert.equal(
      pickStoredAccountName({
        preferredName: 'work',
        lastName: 'personal',
        hasWorkingDir: true,
      }),
      'work'
    );
  });
});

process.on('exit', () => {
  try {
    fs.unlinkSync(out);
  } catch {
    /* ignore */
  }
});
