const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lock-${process.pid}-`));
const bundle = path.join(dir, 'fsSafe.cjs');
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/fsSafe.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundle,
});

// Worker: increment a shared counter file under withLock, `iters` times. If the
// lock grants mutual exclusion, no read-modify-write update is ever lost.
const worker = path.join(dir, 'worker.cjs');
fs.writeFileSync(
  worker,
  `const fs = require('fs');
const { withLock } = require(${JSON.stringify(bundle)});
const [counter, lockDir, iters] = [process.argv[2], process.argv[3], Number(process.argv[4])];
for (let i = 0; i < iters; i++) {
  withLock(lockDir, () => {
    let n = 0;
    try { n = Number(fs.readFileSync(counter, 'utf8')) || 0; } catch {}
    fs.writeFileSync(counter, String(n + 1));
  }, { capMs: 20000, staleMs: 60000, stepMs: 5 });
}
`
);

describe('withLock mutual exclusion across processes', () => {
  it('loses no updates even when many processes start on a stale lock', async () => {
    const counter = path.join(dir, 'counter');
    const lockDir = path.join(dir, 'counter.lock');
    fs.writeFileSync(counter, '0');

    // Seed a STALE lock so every worker's first acquire must reclaim at once —
    // the exact race a broken reclaim would double-enter. Foreign host + old
    // timestamp forces the age path to declare it stale deterministically.
    fs.mkdirSync(lockDir);
    fs.writeFileSync(
      path.join(lockDir, 'owner.json'),
      JSON.stringify({ pid: 1, host: 'stale-holder-that-does-not-exist', at: 1 })
    );

    const N = 6;
    const iters = 50;
    const kids = Array.from({ length: N }, () =>
      spawn(process.execPath, [worker, counter, lockDir, String(iters)], { stdio: 'ignore' })
    );
    await Promise.all(
      kids.map(
        (c) =>
          new Promise((res, rej) => {
            c.on('exit', (code) => (code === 0 ? res() : rej(new Error(`worker exit ${code}`))));
            c.on('error', rej);
          })
      )
    );

    const total = Number(fs.readFileSync(counter, 'utf8'));
    assert.equal(total, N * iters, 'every increment must survive → mutual exclusion held');
  });
});

process.on('exit', () => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
