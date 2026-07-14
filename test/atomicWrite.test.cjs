const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), `atomic-write-${process.pid}-`));
const out = path.join(dir, 'fsSafe.cjs');
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/fsSafe.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: out,
});
const { writeFileAtomic } = require(out);

// Worker: hammer one target with distinct large payloads through writeFileAtomic.
// Large payloads make a fixed-temp-name implementation interleave several write()
// syscalls, which is when a torn file would surface.
const worker = path.join(dir, 'worker.cjs');
fs.writeFileSync(
  worker,
  `const { writeFileAtomic } = require(${JSON.stringify(out)});
const [target, tag, iters] = [process.argv[2], process.argv[3], Number(process.argv[4])];
const pad = 'x'.repeat(4096);
for (let i = 0; i < iters; i++) writeFileAtomic(target, JSON.stringify({ tag, i, pad }), { mode: 0o600 });
`
);

describe('writeFileAtomic', () => {
  it('leaves a valid file under concurrent in-process writes', async () => {
    const target = path.join(dir, 'inproc.json');
    const payloads = Array.from({ length: 50 }, (_, i) =>
      JSON.stringify({ writer: i, token: `payload-${i}` })
    );
    await Promise.all(
      payloads.map(
        (payload) =>
          new Promise((resolve, reject) => {
            setImmediate(() => {
              try {
                writeFileAtomic(target, payload, { mode: 0o600 });
                resolve();
              } catch (err) {
                reject(err);
              }
            });
          })
      )
    );
    const raw = fs.readFileSync(target, 'utf-8');
    assert.ok(payloads.includes(raw), 'final content must equal one whole payload');
  });

  it('never publishes a torn file under concurrent separate processes', async () => {
    const target = path.join(dir, 'multiproc.json');
    const N = 8;
    const iters = 250;
    const kids = Array.from({ length: N }, (_, k) =>
      spawn(process.execPath, [worker, target, `t${k}`, String(iters)], { stdio: 'ignore' })
    );
    const done = kids.map(
      (c) =>
        new Promise((res, rej) => {
          c.on('exit', (code) => (code === 0 ? res() : rej(new Error(`worker exit ${code}`))));
          c.on('error', rej);
        })
    );

    // Read the target in a tight loop while the processes write. With a fixed temp
    // name a reader would eventually catch a half-written file and JSON.parse would
    // throw; unique-temp + rename means every observable state is a complete file.
    let reads = 0;
    let stop = false;
    const reader = (async () => {
      while (!stop) {
        try {
          const s = fs.readFileSync(target, 'utf-8');
          if (s) {
            JSON.parse(s);
            reads++;
          }
        } catch (err) {
          if (err.code !== 'ENOENT') throw err; // ENOENT only before the first write
        }
        await new Promise((r) => setImmediate(r));
      }
    })();

    await Promise.all(done);
    stop = true;
    await reader;

    const final = JSON.parse(fs.readFileSync(target, 'utf-8'));
    assert.equal(typeof final.tag, 'string');
    assert.ok(reads > 0, 'reader should have observed complete files during the run');
  });
});

process.on('exit', () => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
