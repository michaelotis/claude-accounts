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
const { matchWorkspaceRoute, mergeRoutes, normalizePrefix } = require(out);

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

process.on('exit', () => {
  try {
    fs.unlinkSync(out);
  } catch {
    /* ignore */
  }
});
