const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');

const out = path.join(os.tmpdir(), `atomic-write-${process.pid}.cjs`);
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/fsSafe.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: out,
});
const { writeFileAtomic } = require(out);

const target = path.join(os.tmpdir(), `atomic-write-target-${process.pid}.json`);

describe('writeFileAtomic concurrent writers', () => {
  it('never leaves a torn JSON file under concurrent writes', async () => {
    const bursts = 20;
    const writers = 50;

    for (let burst = 0; burst < bursts; burst++) {
      const payloads = Array.from({ length: writers }, (_, i) =>
        JSON.stringify({ burst, writer: i, token: `payload-${burst}-${i}` })
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
      let parsed;
      assert.doesNotThrow(() => {
        parsed = JSON.parse(raw);
      });
      assert.ok(
        payloads.includes(raw),
        `final content must equal one of the ${writers} payloads written in burst ${burst}`
      );
      assert.equal(typeof parsed.writer, 'number');
    }
  });
});

process.on('exit', () => {
  for (const f of [out, target]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
});
