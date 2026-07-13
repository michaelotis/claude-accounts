const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');

/**
 * syncMcpServers lives in workdir.ts which imports vscode via accounts/log.
 * Bundle with a minimal vscode stub (alias — buildSync cannot use plugins).
 */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `mcp-sync-${process.pid}-`));
const vscodeStub = path.join(tmpRoot, 'vscode-stub.js');
fs.writeFileSync(
  vscodeStub,
  `
module.exports = {
  window: {
    createOutputChannel: () => ({ appendLine() {}, show() {} }),
  },
  workspace: {
    workspaceFolders: undefined,
    workspaceFile: undefined,
  },
};
`
);
const out = path.join(tmpRoot, 'workdir.bundle.cjs');
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/workdir.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: out,
  alias: {
    vscode: vscodeStub,
  },
});

const { syncMcpServers } = require(out);

describe('syncMcpServers', () => {
  let tmpHome;
  let prevHome;
  let workingDir;
  let cfgPath;

  before(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-mcp-'));
    prevHome = process.env.HOME;
    process.env.HOME = tmpHome;

    fs.writeFileSync(
      path.join(tmpHome, '.claude.json'),
      JSON.stringify({ mcpServers: { a: { command: 'x' } } }, null, 2),
      { mode: 0o600 }
    );

    workingDir = path.join(tmpHome, '.claude-windows', 'testdir');
    fs.mkdirSync(workingDir, { recursive: true, mode: 0o700 });
    cfgPath = path.join(workingDir, '.claude.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ otherKey: true }, null, 2), { mode: 0o600 });
  });

  after(() => {
    process.env.HOME = prevHome;
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('merges home mcpServers into the working dir and is idempotent', () => {
    syncMcpServers(workingDir);

    const afterFirst = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.equal(afterFirst.otherKey, true, 'original non-MCP key preserved');
    assert.deepEqual(afterFirst.mcpServers.a, { command: 'x' }, 'home server merged in');

    const contentAfterFirst = fs.readFileSync(cfgPath);
    const mtimeAfterFirst = fs.statSync(cfgPath).mtimeMs;

    // Brief pause so a spurious rewrite would change mtime on typical filesystems.
    const end = Date.now() + 20;
    while (Date.now() < end) {
      /* spin */
    }

    syncMcpServers(workingDir);

    const contentAfterSecond = fs.readFileSync(cfgPath);
    const mtimeAfterSecond = fs.statSync(cfgPath).mtimeMs;
    assert.ok(contentAfterFirst.equals(contentAfterSecond), 'second call leaves content unchanged');
    assert.equal(mtimeAfterSecond, mtimeAfterFirst, 'second call is a no-op write (mtime unchanged)');
  });
});
