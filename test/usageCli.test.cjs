const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const path = require('path');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `usage-cli-${process.pid}-`));

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

/**
 * The CLI is built with NO vscode alias on purpose: it has to run with every
 * window closed, so this build failing IS the test that nothing in its graph
 * reaches vscode.
 */
const cliSource = path.join(__dirname, '../src/usageCli.ts');

function buildCli(outfile, extra = {}) {
  esbuild.buildSync({
    entryPoints: [cliSource],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    outfile,
    ...extra,
  });
  return outfile;
}

const cliBundle = buildCli(path.join(tmpRoot, 'usage-cli.cjs'));

/** A config dir that exists, credentials and all: what a live account looks like. */
const presentDir = path.join(tmpRoot, 'present-config');
fs.mkdirSync(presentDir, { recursive: true });
fs.writeFileSync(path.join(presentDir, '.credentials.json'), '{}');

/** A config dir that was removed: the shape of an account signed out of. */
const absentDir = path.join(tmpRoot, 'absent-config');

after(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** A fresh HOME per case: policyDir/usage-cache live under it. */
function withHome(fn) {
  const home = fs.mkdtempSync(path.join(tmpRoot, 'home-'));
  try {
    return fn(home);
  } finally {
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function cacheFile(home) {
  return path.join(home, '.config', 'claude-accounts', 'usage-cache.json');
}

/** Write the cache exactly as given — some cases need raw JSON text. */
function writeCacheText(home, text) {
  const file = cacheFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function writeCache(home, entries) {
  return writeCacheText(home, JSON.stringify({ entries }, null, 2));
}

function presenceDir(home) {
  return path.join(home, '.config', 'claude-accounts', 'windows');
}

/**
 * A config dir under `home` whose `.claude.json` names `email` — what the CLI
 * derives a window's account from, rather than from the record itself.
 */
function writeConfigDir(home, id, email) {
  const dir = path.join(home, '.claude-windows', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: email } })
  );
  return dir;
}

/** A live presence record: this test process's own pid, beating right now. */
function writeWindow(home, { id, workspace, configDir, pid = process.pid, lastSeen = Date.now() }) {
  const dir = presenceDir(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({ v: 1, id, workspace, configDir, pid, lastSeen })
  );
  return { workspace, configDir, pid, lastSeen };
}

function snap() {
  return {
    sessionPercent: 12,
    sessionResetsAt: '2026-01-01T00:00:00Z',
    weeklyPercent: 34,
    weeklyResetsAt: null,
    opusPercent: null,
    opusResetsAt: null,
    sonnetPercent: null,
    sonnetResetsAt: null,
    modelLimits: [{ name: 'Fable', percent: 40, resetsAt: null, kind: 'weekly_scoped' }],
    overagePercent: null,
    email: 'a@example.com',
    orgName: 'Example',
    planLabel: 'Max',
    fetchedAt: Date.now(),
    configDir: presentDir,
  };
}

function entry(key, fetchedAt, over = {}) {
  return { key, fetchedAt, snap: { ...snap(), fetchedAt, ...over } };
}

function run(home, args = [], bundle = cliBundle) {
  try {
    const stdout = execFileSync(process.execPath, [bundle, ...args], {
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    if (typeof err.status !== 'number') throw err;
    return { status: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function runJson(home, args = []) {
  const res = run(home, ['--json', ...args]);
  res.json = JSON.parse(res.stdout);
  return res;
}

describe('usage CLI — contract', () => {
  it('prints the schema, the fields and the age of a fresh reading, exit 0', () => {
    withHome((home) => {
      const fetchedAt = Date.now() - 5_000;
      writeCache(home, { 'email:a@example.com': entry('email:a@example.com', fetchedAt) });
      const res = runJson(home);
      assert.equal(res.status, 0);
      assert.equal(res.json.schema, 'claude-accounts/usage@1');
      assert.equal(res.json.stale, false);
      assert.deepEqual(res.json.warnings, []);
      assert.equal(typeof res.json.generatedAt, 'number');
      assert.equal(res.json.accounts.length, 1);
      const a = res.json.accounts[0];
      assert.deepEqual(Object.keys(a).sort(), [
        'ageMs',
        'email',
        'fetchedAt',
        'models',
        'orgName',
        'planLabel',
        'present',
        'sessionPercent',
        'sessionResetsAt',
        'stale',
        'weeklyPercent',
        'weeklyResetsAt',
        'windows',
      ]);
      assert.equal(a.email, 'a@example.com');
      assert.equal(a.planLabel, 'Max');
      assert.equal(a.orgName, 'Example');
      assert.equal(a.sessionPercent, 12);
      assert.equal(a.sessionResetsAt, '2026-01-01T00:00:00Z');
      assert.equal(a.weeklyPercent, 34);
      assert.deepEqual(a.models, [{ name: 'Fable', percent: 40, resetsAt: null }]);
      assert.equal(a.fetchedAt, fetchedAt);
      assert.ok(a.ageMs >= 5_000 && a.ageMs < 120_000, `ageMs was ${a.ageMs}`);
      assert.equal(a.stale, false);
      assert.equal(a.present, true);
    });
  });

  it('sorts accounts by email and keeps dir-keyed entries with email null', () => {
    withHome((home) => {
      const now = Date.now();
      writeCache(home, {
        'email:b@example.com': entry('email:b@example.com', now, { email: 'b@example.com' }),
        'dir:/home/x/.claude': entry('dir:/home/x/.claude', now, { email: null }),
        'email:a@example.com': entry('email:a@example.com', now, { email: 'a@example.com' }),
      });
      const res = runJson(home);
      assert.equal(res.status, 0);
      assert.deepEqual(
        res.json.accounts.map((a) => a.email),
        ['a@example.com', 'b@example.com', null]
      );
    });
  });
});

describe('usage CLI — freshness', () => {
  it('is fresh at the max-age boundary and stale past it, exit 0 then 1', () => {
    withHome((home) => {
      const now = Date.now();
      // 60s old against --max-age 120s: inside the window.
      writeCache(home, { 'email:a@example.com': entry('email:a@example.com', now - 60_000) });
      const fresh = runJson(home, ['--max-age', '120s']);
      assert.equal(fresh.status, 0);
      assert.equal(fresh.json.accounts[0].stale, false);
      assert.equal(fresh.json.stale, false);

      // The same reading against --max-age 30s: past it.
      const stale = runJson(home, ['--max-age', '30s']);
      assert.equal(stale.status, 1);
      assert.equal(stale.json.accounts[0].stale, true);
      assert.equal(stale.json.stale, true);
      assert.ok(stale.json.accounts[0].ageMs >= 60_000);
    });
  });

  it('reads a bare --max-age as seconds and an m suffix as minutes', () => {
    withHome((home) => {
      const now = Date.now();
      writeCache(home, { 'email:a@example.com': entry('email:a@example.com', now - 90_000) });
      assert.equal(runJson(home, ['--max-age', '60']).status, 1);
      assert.equal(runJson(home, ['--max-age', '120']).status, 0);
      assert.equal(runJson(home, ['--max-age', '1m']).status, 1);
      assert.equal(runJson(home, ['--max-age', '2m']).status, 0);
    });
  });

  it('treats a stamp a few seconds ahead as clock jitter: ageMs 0 and fresh', () => {
    withHome((home) => {
      // 30s ahead, inside the writer's 60s skew tolerance.
      writeCache(home, {
        'email:a@example.com': entry('email:a@example.com', Date.now() + 30_000),
      });
      const res = runJson(home);
      assert.equal(res.status, 0);
      assert.equal(res.json.accounts[0].ageMs, 0);
      assert.equal(res.json.accounts[0].stale, false);
      assert.equal(res.json.stale, false);
      assert.deepEqual(res.json.warnings, []);
    });
  });

  it('cannot age a stamp far in the future: null, stale, warned, exit 1', () => {
    withHome((home) => {
      const ahead = Date.now() + 3_600_000;
      writeCache(home, { 'email:a@example.com': entry('email:a@example.com', ahead) });
      const res = runJson(home);
      assert.equal(res.status, 1);
      const a = res.json.accounts[0];
      assert.equal(a.ageMs, null);
      assert.equal(a.stale, true);
      assert.equal(res.json.stale, true);
      assert.match(
        res.json.warnings.join('\n'),
        /a@example\.com: reading is stamped in the future/
      );
      // The stamp is still reported; it is the age that is unknown, and the
      // readings go with it because none of them can be placed in time.
      assert.equal(a.fetchedAt, ahead);
      assert.equal(a.sessionPercent, null);
      assert.equal(a.weeklyPercent, null);
      assert.deepEqual(a.models, []);

      const table = run(home, ['--text']);
      assert.equal(table.status, 1);
      const row = table.stdout.trimEnd().split('\n')[1];
      assert.match(row, /\s\?\s+stale$/);
      assert.doesNotMatch(row, /\s0s\s/);
    });
  });

  it('defaults to 10m', () => {
    withHome((home) => {
      const now = Date.now();
      writeCache(home, {
        'email:a@example.com': entry('email:a@example.com', now - 9 * 60_000),
      });
      assert.equal(runJson(home).status, 0);
      writeCache(home, {
        'email:a@example.com': entry('email:a@example.com', now - 11 * 60_000),
      });
      assert.equal(runJson(home).status, 1);
    });
  });
});

describe('usage CLI — honesty', () => {
  it('reports a never-fetched account as nulls and stale, never 0%', () => {
    withHome((home) => {
      writeCache(home, {
        'email:a@example.com': {
          key: 'email:a@example.com',
          fetchedAt: 0,
          snap: {
            ...snap(),
            fetchedAt: 0,
            sessionPercent: 0,
            weeklyPercent: 0,
            modelLimits: [{ name: 'Fable', percent: 0, resetsAt: null, kind: 'weekly_scoped' }],
          },
        },
      });
      const res = runJson(home);
      assert.equal(res.status, 1);
      const a = res.json.accounts[0];
      assert.equal(a.sessionPercent, null);
      assert.equal(a.weeklyPercent, null);
      assert.deepEqual(a.models, []);
      assert.equal(a.fetchedAt, null);
      assert.equal(a.ageMs, null);
      assert.equal(a.stale, true);
      assert.equal(res.json.stale, true);
      // Still the account's own identity — only the readings are unknown.
      assert.equal(a.email, 'a@example.com');
      assert.equal(a.planLabel, 'Max');
    });
  });

  it('still says "never" in --text for an account that was never fetched', () => {
    withHome((home) => {
      writeCache(home, {
        'email:a@example.com': { key: 'email:a@example.com', fetchedAt: 0, snap: { email: null } },
      });
      const res = run(home, ['--text']);
      assert.match(res.stdout.trimEnd().split('\n')[1], /\snever\s+stale$/);
    });
  });

  it('is stale with a warning when a fetched entry carries no reading at all', () => {
    withHome((home) => {
      // A stamp the extension wrote, and a fetch that recovered nothing.
      writeCache(home, {
        'email:a@example.com': { key: 'email:a@example.com', fetchedAt: Date.now() },
      });
      const res = runJson(home);
      assert.equal(res.status, 1);
      const a = res.json.accounts[0];
      assert.equal(a.stale, true);
      assert.equal(res.json.stale, true);
      assert.ok(typeof a.fetchedAt === 'number');
      assert.ok(a.ageMs < 60_000, `ageMs was ${a.ageMs}`);
      assert.match(res.json.warnings.join('\n'), /a@example\.com: no usable reading/);
    });
  });

  it('is stale with a warning when the last fetch carried no bucket at all', () => {
    withHome((home) => {
      // What the writer stores for a fetch that recovered nothing: zeros to give
      // the snapshot a shape, and a count saying they stand for nothing.
      writeCache(home, {
        'email:a@example.com': entry('email:a@example.com', Date.now(), {
          bucketsSeen: 0,
          sessionPercent: 0,
          weeklyPercent: 0,
          modelLimits: [],
        }),
      });
      const res = runJson(home);
      assert.equal(res.status, 1);
      const a = res.json.accounts[0];
      assert.equal(a.sessionPercent, null);
      assert.equal(a.weeklyPercent, null);
      assert.deepEqual(a.models, []);
      assert.equal(a.stale, true);
      assert.equal(res.json.stale, true);
      assert.match(
        res.json.warnings.join('\n'),
        /^a@example\.com: the last fetch carried no usage buckets$/m
      );
    });
  });

  it('trusts zeros from a fetch that did carry buckets', () => {
    withHome((home) => {
      writeCache(home, {
        'email:a@example.com': entry('email:a@example.com', Date.now(), {
          bucketsSeen: 2,
          sessionPercent: 0,
          weeklyPercent: 0,
          modelLimits: [],
        }),
      });
      const res = runJson(home);
      assert.equal(res.status, 0);
      assert.equal(res.json.accounts[0].sessionPercent, 0);
      assert.equal(res.json.accounts[0].stale, false);
      assert.deepEqual(res.json.warnings, []);
    });
  });

  it('judges a snapshot written before the count exactly as it did', () => {
    withHome((home) => {
      // An older build wrote no count at all; guessing from the zeros alone
      // would turn every idle account into a warning.
      writeCache(home, {
        'email:a@example.com': entry('email:a@example.com', Date.now(), {
          sessionPercent: 0,
          weeklyPercent: 0,
          modelLimits: [],
        }),
      });
      const res = runJson(home);
      assert.equal(res.status, 0);
      assert.equal(res.json.accounts[0].sessionPercent, 0);
      assert.equal(res.json.accounts[0].stale, false);
      assert.deepEqual(res.json.warnings, []);
    });
  });

  it('counts one recovered model percentage as a reading', () => {
    withHome((home) => {
      writeCache(home, {
        'email:a@example.com': entry('email:a@example.com', Date.now(), {
          sessionPercent: null,
          weeklyPercent: null,
        }),
      });
      const res = runJson(home);
      assert.equal(res.status, 0);
      assert.equal(res.json.accounts[0].stale, false);
      assert.deepEqual(res.json.warnings, []);
    });
  });

  it('drops a non-finite percentage to null with a warning', () => {
    withHome((home) => {
      const now = Date.now();
      // 1e999 parses to Infinity — a number JSON can carry but no bucket holds.
      writeCacheText(
        home,
        JSON.stringify({
          entries: { 'email:a@example.com': entry('email:a@example.com', now) },
        }).replace('"sessionPercent":12', '"sessionPercent":1e999')
      );
      const res = runJson(home);
      assert.equal(res.status, 0);
      assert.equal(res.json.accounts[0].sessionPercent, null);
      assert.equal(res.json.warnings.length, 1);
      assert.match(res.json.warnings[0], /a@example\.com 5h: dropped an unusable percentage/);
    });
  });

  it('drops an out-of-range percentage to null with a warning', () => {
    withHome((home) => {
      const now = Date.now();
      writeCache(home, {
        'email:a@example.com': entry('email:a@example.com', now, {
          weeklyPercent: 150,
          modelLimits: [{ name: 'Fable', percent: -1, resetsAt: null, kind: 'weekly_scoped' }],
        }),
      });
      const res = runJson(home);
      assert.equal(res.json.accounts[0].weeklyPercent, null);
      assert.equal(res.json.accounts[0].models[0].percent, null);
      assert.equal(res.json.warnings.length, 2);
      assert.match(res.json.warnings.join('\n'), /7d: dropped an unusable percentage/);
      assert.match(res.json.warnings.join('\n'), /Fable: dropped an unusable percentage/);
    });
  });

  it('leaves the cache file bytes and mtime untouched', () => {
    withHome((home) => {
      const now = Date.now();
      const file = writeCache(home, {
        'email:a@example.com': entry('email:a@example.com', now),
      });
      const before = fs.readFileSync(file);
      const beforeStat = fs.statSync(file);
      run(home, ['--json']);
      run(home, ['--text']);
      run(home, ['--account', 'A@Example.com']);
      const after = fs.readFileSync(file);
      const afterStat = fs.statSync(file);
      assert.ok(before.equals(after), 'cache bytes changed');
      assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
      // No lock, no temp file, nothing else written beside it either.
      assert.deepEqual(fs.readdirSync(path.dirname(file)), ['usage-cache.json']);
    });
  });
});

describe('usage CLI — accounts that are gone', () => {
  it('keeps an absent account out of the exit code and out of top-level stale', () => {
    withHome((home) => {
      const now = Date.now();
      writeCache(home, {
        'email:live@example.com': entry('email:live@example.com', now, {
          email: 'live@example.com',
        }),
        'email:gone@example.com': entry('email:gone@example.com', now - 86_400_000, {
          email: 'gone@example.com',
          configDir: absentDir,
        }),
      });
      const res = runJson(home);
      assert.equal(res.status, 0);
      assert.equal(res.json.stale, false);
      // Still listed — the caller decides what to do about it.
      const byEmail = Object.fromEntries(res.json.accounts.map((a) => [a.email, a]));
      assert.equal(byEmail['gone@example.com'].present, false);
      assert.equal(byEmail['gone@example.com'].stale, true);
      assert.equal(byEmail['live@example.com'].present, true);

      const table = run(home, ['--text']);
      assert.equal(table.status, 0);
      assert.match(table.stdout, /gone@example\.com.*\sgone$/m);
    });
  });

  it('names the account it left out of the exit code', () => {
    withHome((home) => {
      const now = Date.now();
      writeCache(home, {
        'email:live@example.com': entry('email:live@example.com', now, {
          email: 'live@example.com',
        }),
        'email:gone@example.com': entry('email:gone@example.com', now, {
          email: 'gone@example.com',
          configDir: absentDir,
        }),
      });
      // Exit 0 means less with an account taken out of it, and a caller reading
      // the code alone would otherwise never learn which one that was.
      const res = runJson(home);
      assert.equal(res.status, 0);
      assert.deepEqual(res.json.warnings, [
        'gone@example.com: no credentials in its config directory — left out of the exit code',
      ]);
    });
  });

  it('is no data, exit 2, when every account listed is gone', () => {
    withHome((home) => {
      writeCache(home, {
        'email:a@example.com': entry('email:a@example.com', Date.now(), { configDir: absentDir }),
      });
      const res = runJson(home);
      assert.equal(res.status, 2);
      assert.equal(res.json.stale, true);
      assert.equal(res.json.accounts.length, 1);
      assert.equal(res.json.accounts[0].present, false);
      assert.deepEqual(res.json.warnings, [
        'a@example.com: no credentials in its config directory — left out of the exit code',
      ]);
    });
  });

  it('is present, with a warning, when the config dir is not an absolute path', () => {
    for (const configDir of ['~/.claude-relative', 'relative-config']) {
      withHome((home) => {
        writeCache(home, {
          'email:a@example.com': entry('email:a@example.com', Date.now(), { configDir }),
        });
        const res = runJson(home);
        // CLAUDE_CONFIG_DIR is stored verbatim, so this says nothing about the
        // account: reading it as "signed out" would drop a live one silently.
        assert.equal(res.status, 0, `${configDir}: ${res.stderr}`);
        assert.equal(res.json.accounts[0].present, true);
        assert.match(
          res.json.warnings.join('\n'),
          /^a@example\.com: its config directory is not an absolute path, so its credentials could not be checked — counted as present$/m
        );
      });
    }
  });

  it(
    'is present, with a warning, when the config dir cannot be looked into',
    { skip: isRoot ? 'running as root — mode 000 does not deny traversal' : false },
    () => {
      withHome((home) => {
        const parent = fs.mkdtempSync(path.join(tmpRoot, 'sealed-'));
        const dir = path.join(parent, 'config');
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, '.credentials.json'), '{}');
        fs.chmodSync(parent, 0o000);
        try {
          writeCache(home, {
            'email:a@example.com': entry('email:a@example.com', Date.now(), { configDir: dir }),
          });
          const res = runJson(home);
          assert.equal(res.status, 0, res.stderr);
          assert.equal(res.json.accounts[0].present, true);
          assert.match(
            res.json.warnings.join('\n'),
            /^a@example\.com: could not check its credentials \(EACCES\) — counted as present$/m
          );
        } finally {
          fs.chmodSync(parent, 0o700);
        }
      });
    }
  );

  it('is present when the entry names no config dir', () => {
    withHome((home) => {
      writeCache(home, {
        'email:a@example.com': entry('email:a@example.com', Date.now(), { configDir: undefined }),
      });
      const res = runJson(home);
      assert.equal(res.status, 0);
      assert.equal(res.json.accounts[0].present, true);
    });
  });

  it(
    'checks for the credentials file without opening it',
    { skip: isRoot ? 'running as root — mode 000 does not deny reads' : false },
    () => {
      withHome((home) => {
        const dir = fs.mkdtempSync(path.join(tmpRoot, 'locked-config-'));
        const creds = path.join(dir, '.credentials.json');
        fs.writeFileSync(creds, '{"unreadable":true}');
        fs.chmodSync(creds, 0o000);
        try {
          // Mode 000: any read of it fails, so a pass here is a read that never happened.
          assert.throws(() => fs.readFileSync(creds), /EACCES/, 'the credentials file is readable');
          writeCache(home, {
            'email:a@example.com': entry('email:a@example.com', Date.now(), { configDir: dir }),
          });
          const res = runJson(home);
          assert.equal(res.status, 0, res.stderr);
          assert.equal(res.json.accounts[0].present, true);
          assert.deepEqual(res.json.warnings, []);
        } finally {
          fs.chmodSync(creds, 0o600);
        }
      });
    }
  );

  it('never puts a config directory in the output', () => {
    withHome((home) => {
      writeCache(home, {
        'email:a@example.com': entry('email:a@example.com', Date.now(), { configDir: absentDir }),
      });
      const res = run(home, ['--json']);
      assert.doesNotMatch(res.stdout, new RegExp(absentDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.doesNotMatch(res.stdout, /configDir/);
    });
  });
});

describe('usage CLI — filtering and flags', () => {
  it('filters by account case-insensitively', () => {
    withHome((home) => {
      const now = Date.now();
      writeCache(home, {
        'email:a@example.com': entry('email:a@example.com', now, { email: 'a@example.com' }),
        'email:b@example.com': entry('email:b@example.com', now, { email: 'b@example.com' }),
      });
      const res = runJson(home, ['--account', 'A@ExAmPlE.CoM']);
      assert.equal(res.status, 0);
      assert.deepEqual(
        res.json.accounts.map((a) => a.email),
        ['a@example.com']
      );
    });
  });

  it('is no data, exit 2, when the filter matches nothing', () => {
    withHome((home) => {
      const now = Date.now();
      writeCache(home, { 'email:a@example.com': entry('email:a@example.com', now) });
      const res = runJson(home, ['--account', 'nobody@example.com']);
      assert.equal(res.status, 2);
      assert.deepEqual(res.json.accounts, []);
      assert.equal(res.json.stale, true);
      assert.match(res.json.warnings[0], /no cached usage for nobody@example\.com/);
    });
  });

  it('says only that nothing matched, never what some other account looked like', () => {
    withHome((home) => {
      const now = Date.now();
      writeCache(home, {
        'email:a@example.com': entry('email:a@example.com', now, { sessionPercent: 150 }),
      });
      const res = runJson(home, ['--account', 'nobody@example.com']);
      assert.equal(res.status, 2);
      assert.deepEqual(res.json.accounts, []);
      assert.deepEqual(res.json.warnings, ['no cached usage for nobody@example.com']);
      assert.ok(!res.stdout.includes('a@example.com'), res.stdout);
    });
  });

  it('warns about the account asked for, and about the cache, never about the rest', () => {
    withHome((home) => {
      const now = Date.now();
      writeCache(home, {
        'email:a@example.com': entry('email:a@example.com', now, {
          email: 'a@example.com',
          sessionPercent: 150,
        }),
        'email:b@example.com': entry('email:b@example.com', now, {
          email: 'b@example.com',
          weeklyPercent: 150,
          configDir: absentDir,
        }),
        'email:c@example.com': 'not an object',
      });
      const res = runJson(home, ['--account', 'a@example.com']);
      assert.equal(res.status, 0);
      const warnings = res.json.warnings.join('\n');
      assert.match(warnings, /a@example\.com 5h: dropped an unusable percentage/);
      // A filter is a question about one account; an answer carrying another
      // one's address is both noise and something the caller never asked for.
      assert.ok(!res.stdout.includes('b@example.com'), res.stdout);
      // The cache itself is still the caller's problem whoever they asked about.
      assert.match(warnings, /c@example\.com: skipped an entry that is not an object/);
    });
  });

  it('names a dir-keyed entry by its basename, never by its path', () => {
    withHome((home) => {
      const parent = path.join(tmpRoot, 'profiles');
      const configDir = path.join(parent, '.claude-work');
      writeCache(home, {
        [`dir:${configDir}`]: entry(`dir:${configDir}`, Date.now(), {
          email: null,
          sessionPercent: 150,
          configDir: undefined,
        }),
      });
      const res = runJson(home);
      const warnings = res.json.warnings.join('\n');
      assert.match(warnings, /^\.claude-work 5h: dropped an unusable percentage$/m);
      assert.ok(!res.stdout.includes(parent), `stdout carried ${parent}`);
    });
  });

  it('tells two dir-keyed entries sharing a basename apart', () => {
    withHome((home) => {
      const now = Date.now();
      const projA = '/home/someone/projA/.claude';
      const projB = '/home/someone/projB/.claude';
      writeCache(home, {
        [`dir:${projA}`]: entry(`dir:${projA}`, now, {
          email: null,
          sessionPercent: 150,
          configDir: undefined,
        }),
        [`dir:${projB}`]: entry(`dir:${projB}`, now, {
          email: null,
          weeklyPercent: 150,
          configDir: undefined,
        }),
      });
      const res = runJson(home);
      const warnings = res.json.warnings.join('\n');
      // Two lines both naming `.claude` would say nothing about which is which.
      assert.match(warnings, /^projA\/\.claude 5h: dropped an unusable percentage$/m);
      assert.match(warnings, /^projB\/\.claude 7d: dropped an unusable percentage$/m);
      assert.ok(!res.stdout.includes('/home/someone'), res.stdout);
    });
  });

  it('refuses a flag where a value belongs rather than filtering on it', () => {
    withHome((home) => {
      writeCache(home, { 'email:a@example.com': entry('email:a@example.com', Date.now()) });
      for (const args of [
        ['--account', '--json'],
        ['--max-age', '--text'],
      ]) {
        const res = run(home, args);
        assert.equal(res.status, 3, `args ${args.join(' ')}`);
        assert.equal(res.stdout, '');
        assert.match(res.stderr, /^claude-usage: (--account|--max-age) needs a value\n$/);
      }
    });
  });

  it('prints a compact table with --text and still says stale', () => {
    withHome((home) => {
      const now = Date.now();
      writeCache(home, {
        'email:a@example.com': entry('email:a@example.com', now - 30 * 60_000),
      });
      const res = run(home, ['--text']);
      assert.equal(res.status, 1);
      const lines = res.stdout.trimEnd().split('\n');
      assert.match(lines[0], /^ACCOUNT\s+PLAN\s+5H\s+7D\s+MODELS\s+WIN\s+AGE\s+STATE$/);
      assert.match(lines[1], /^a@example\.com\s+Max\s+12%\s+34%\s+Fable 40%\s+0\s+30m\s+stale$/);
    });
  });

  it('prints help and version on exit 0', () => {
    withHome((home) => {
      const help = run(home, ['--help']);
      assert.equal(help.status, 0);
      assert.match(help.stdout, /--max-age <n>\[s\|m\]/);
      assert.match(help.stdout, /1 {2}data printed, some of it stale \(older than --max-age/);
      const version = run(home, ['--version']);
      assert.equal(version.status, 0);
      assert.match(version.stdout.trim(), /^(\d+\.\d+\.\d+|unknown)$/);
    });
  });

  it('prints the manifest version when the manifest sits beside dist/', () => {
    // extensionVersion() reads ../package.json relative to the bundle, so the
    // bundle has to sit where dist/ does for this to be the real answer.
    const repoRoot = fs.mkdtempSync(path.join(tmpRoot, 'version-repo-'));
    fs.mkdirSync(path.join(repoRoot, 'dist'));
    fs.symlinkSync(path.join(__dirname, '../package.json'), path.join(repoRoot, 'package.json'));
    const bundle = buildCli(path.join(repoRoot, 'dist', 'usage-cli.cjs'));
    withHome((home) => {
      const res = run(home, ['--version'], bundle);
      assert.equal(res.status, 0);
      assert.equal(res.stdout.trim(), require('../package.json').version);
    });
  });
});

describe('usage CLI — errors', () => {
  it('exits 3 with the message on stderr and nothing on stdout', () => {
    withHome((home) => {
      const now = Date.now();
      writeCache(home, { 'email:a@example.com': entry('email:a@example.com', now) });
      for (const args of [['--nope'], ['--max-age', 'soon'], ['--max-age', '0'], ['extra']]) {
        const res = run(home, args);
        assert.equal(res.status, 3, `args ${args.join(' ')}`);
        assert.equal(res.stdout, '');
        assert.match(res.stderr, /^claude-usage: .+\n$/);
      }
    });
  });

  it('exits 2 with valid JSON when there is no cache at all', () => {
    withHome((home) => {
      const res = runJson(home);
      assert.equal(res.status, 2);
      assert.equal(res.json.schema, 'claude-accounts/usage@1');
      assert.deepEqual(res.json.accounts, []);
      assert.equal(res.json.stale, true);
      assert.match(res.json.warnings[0], /no usage cache at .*usage-cache\.json/);
    });
  });

  it('exits 2 with valid JSON on a corrupt cache file', () => {
    withHome((home) => {
      writeCacheText(home, '{"entries": {"email:a@example.com": ');
      const res = runJson(home);
      assert.equal(res.status, 2);
      assert.deepEqual(res.json.accounts, []);
      assert.match(res.json.warnings[0], /is not valid JSON/);
    });
  });

  it('exits 2 with valid JSON on a cache of the wrong shape', () => {
    withHome((home) => {
      writeCacheText(home, '[1,2,3]');
      const wrongRoot = runJson(home);
      assert.equal(wrongRoot.status, 2);
      assert.match(wrongRoot.json.warnings[0], /has no entries object/);

      writeCacheText(home, '{"entries": {"email:a@example.com": "nope"}}');
      const wrongEntry = runJson(home);
      assert.equal(wrongEntry.status, 2);
      assert.match(wrongEntry.json.warnings[0], /skipped an entry that is not an object/);
    });
  });
});

describe('usage CLI — internal failures never look like data', () => {
  /** Anything unforeseen inside the command: homedir() is reached before any guard. */
  function throwingBundle() {
    const stub = path.join(tmpRoot, 'os-stub.js');
    fs.writeFileSync(
      stub,
      `const real = require('node:os');
       module.exports = { ...real, homedir() { throw new TypeError('homedir blew up'); } };`
    );
    return buildCli(path.join(tmpRoot, 'throwing-cli.cjs'), { alias: { os: stub } });
  }

  it('exits 3 with one stderr line, never 1, when something unforeseen throws', () => {
    withHome((home) => {
      const res = run(home, ['--json'], throwingBundle());
      assert.equal(res.status, 3);
      assert.equal(res.stdout, '');
      assert.equal(res.stderr, 'claude-usage: homedir blew up\n');
    });
  });

  it('keeps its exit code when a consumer closes the pipe', () => {
    withHome((home) => {
      // Enough accounts to outrun the pipe buffer, so the write really does fail.
      const entries = {};
      for (let i = 0; i < 4_000; i++) {
        const email = `u${i}@example.com`;
        entries[`email:${email}`] = entry(`email:${email}`, Date.now() - 10_000, { email });
      }
      writeCache(home, entries);

      /** `claude-usage | head`: the CLI's own status, and its own stderr. */
      function piped(args) {
        const errFile = path.join(home, 'pipe.err');
        const script = [
          `node ${JSON.stringify(cliBundle)} ${args.join(' ')} 2> ${JSON.stringify(errFile)} |`,
          'head -c 20 > /dev/null',
          'exit "${PIPESTATUS[0]}"',
        ].join('\n');
        const res = spawnSync('bash', ['-c', script], {
          env: { ...process.env, HOME: home },
          encoding: 'utf-8',
        });
        return { status: res.status, stderr: fs.readFileSync(errFile, 'utf-8') };
      }

      const fresh = piped(['--json', '--max-age', '120s']);
      assert.equal(fresh.stderr, '', 'the broken pipe was reported as a failure');
      assert.equal(fresh.status, 0);
      // The verdict the command reached still stands; the reader simply left.
      const stale = piped(['--json', '--max-age', '1s']);
      assert.equal(stale.stderr, '');
      assert.equal(stale.status, 1);
    });
  });

  it('keeps its exit code when a consumer closes stderr', async () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, 'home-'));
    const child = spawn(process.execPath, [cliBundle, '--nope'], {
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    // The message has nowhere to land. An unhandled error on stderr exits 1 —
    // "data printed, some of it stale" — from a run that printed nothing.
    child.stderr.destroy();
    const status = await new Promise((resolve) => child.on('exit', resolve));
    assert.equal(status, 3);
  });
});

describe('claude-usage wrapper', () => {
  /** A checkout of the wrapper with, or without, the bundle it runs. */
  function checkout(name, withBundle) {
    const root = path.join(tmpRoot, name);
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '../scripts/claude-usage'), wrapperIn(root));
    fs.chmodSync(wrapperIn(root), 0o755);
    if (withBundle) {
      fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
      buildCli(path.join(root, 'dist', 'usage-cli.js'));
    }
    return root;
  }

  function wrapperIn(root) {
    return path.join(root, 'scripts', 'claude-usage');
  }

  function runWrapper(script, home, args = []) {
    try {
      const stdout = execFileSync(script, args, {
        env: { ...process.env, HOME: home },
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { status: 0, stdout, stderr: '' };
    } catch (err) {
      if (typeof err.status !== 'number') throw err;
      return { status: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
    }
  }

  it('exits 3 with empty stdout when the bundle has not been built', () => {
    const root = checkout('wrapper-bare', false);
    withHome((home) => {
      const res = runWrapper(wrapperIn(root), home, ['--json']);
      // 1 would mean "data printed, some of it stale"; there is no data at all.
      assert.equal(res.status, 3);
      assert.equal(res.stdout, '');
      assert.equal(res.stderr.trimEnd().split('\n').length, 1);
      assert.match(res.stderr, /npm run compile/);
    });
  });

  it('exits 3 with a message when it cannot work out where it is', () => {
    const root = checkout('wrapper-unresolvable', true);
    const fakeBin = fs.mkdtempSync(path.join(tmpRoot, 'fakebin-'));
    const readlink = path.join(fakeBin, 'readlink');
    fs.writeFileSync(readlink, '#!/bin/sh\nexit 1\n');
    fs.chmodSync(readlink, 0o755);
    withHome((home) => {
      const res = spawnSync('bash', [wrapperIn(root), '--json'], {
        env: {
          ...process.env,
          HOME: home,
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
        },
        encoding: 'utf-8',
      });
      // Left to `set -e` this exits 1 — a reading — without a word about why.
      assert.equal(res.status, 3);
      assert.equal(res.stdout, '');
      assert.equal(res.stderr.trimEnd().split('\n').length, 1);
      assert.match(res.stderr, /^claude-usage: .+\n$/);
    });
  });

  it('finds the bundle when it is reached through a symlink', () => {
    const root = checkout('wrapper-built', true);
    const elsewhere = fs.mkdtempSync(path.join(tmpRoot, 'bin-'));
    const link = path.join(elsewhere, 'claude-usage');
    fs.symlinkSync(wrapperIn(root), link);
    withHome((home) => {
      writeCache(home, { 'email:a@example.com': entry('email:a@example.com', Date.now()) });
      const res = runWrapper(link, home, ['--json']);
      assert.equal(res.status, 0, res.stderr);
      assert.equal(JSON.parse(res.stdout).accounts[0].email, 'a@example.com');
    });
  });
});

describe('usage CLI — which windows are on which account', () => {
  it('lists windows as an empty array, never absent, when none has ever recorded one', () => {
    withHome((home) => {
      writeCache(home, { 'email:a@example.com': entry('email:a@example.com', Date.now()) });
      const res = runJson(home);
      assert.equal(res.status, 0);
      assert.deepEqual(res.json.accounts[0].windows, []);
      assert.deepEqual(res.json.otherWindows, []);
      // No warning either: every window closed is when this command matters most.
      assert.deepEqual(res.json.warnings, []);
    });
  });

  it('puts a live window under the account its config dir runs', () => {
    withHome((home) => {
      const now = Date.now();
      writeCache(home, {
        'email:a@example.com': entry('email:a@example.com', now, { email: 'a@example.com' }),
        'email:b@example.com': entry('email:b@example.com', now, { email: 'b@example.com' }),
      });
      const cfg = writeConfigDir(home, 'aaaa1111', 'a@example.com');
      const written = writeWindow(home, {
        id: 'aaaa1111',
        workspace: 'my-project',
        configDir: cfg,
      });
      const res = runJson(home);
      assert.equal(res.status, 0);
      const byEmail = new Map(res.json.accounts.map((a) => [a.email, a.windows]));
      assert.deepEqual(byEmail.get('a@example.com'), [
        {
          workspace: 'my-project',
          configDir: cfg,
          pid: written.pid,
          lastSeen: written.lastSeen,
        },
      ]);
      assert.deepEqual(byEmail.get('b@example.com'), []);
      assert.deepEqual(res.json.otherWindows, []);
      // The count reaches the table as its own column.
      const text = run(home, ['--text']);
      assert.match(
        text.stdout.split('\n')[1],
        /^a@example\.com\s+Max\s+12%\s+34%\s+Fable 40%\s+1\s/
      );
      assert.match(
        text.stdout.split('\n')[2],
        /^b@example\.com\s+Max\s+12%\s+34%\s+Fable 40%\s+0\s/
      );
    });
  });

  it('puts a window whose account the cache does not know into otherWindows', () => {
    withHome((home) => {
      const now = Date.now();
      writeCache(home, {
        'email:a@example.com': entry('email:a@example.com', now, { email: 'a@example.com' }),
      });
      const known = writeConfigDir(home, 'aaaa1111', 'a@example.com');
      writeWindow(home, { id: 'aaaa1111', workspace: 'my-project', configDir: known });
      const uncached = writeConfigDir(home, 'bbbb2222', 'b@example.com');
      const other = writeWindow(home, {
        id: 'bbbb2222',
        workspace: 'other-repo',
        configDir: uncached,
      });
      // A dir with no identity at all: live, but nothing says whose it is.
      const blank = path.join(home, '.claude-windows', 'cccc3333');
      fs.mkdirSync(blank, { recursive: true });
      const nameless = writeWindow(home, { id: 'cccc3333', workspace: '', configDir: blank });

      const res = runJson(home);
      assert.equal(res.status, 0);
      assert.deepEqual(
        res.json.accounts[0].windows.map((w) => w.workspace),
        ['my-project']
      );
      assert.deepEqual(res.json.otherWindows, [
        {
          workspace: '',
          configDir: blank,
          pid: nameless.pid,
          lastSeen: nameless.lastSeen,
          email: null,
        },
        {
          workspace: 'other-repo',
          configDir: uncached,
          pid: other.pid,
          lastSeen: other.lastSeen,
          email: 'b@example.com',
        },
      ]);
    });
  });

  it('never lists a window that is not live', () => {
    withHome((home) => {
      const now = Date.now();
      writeCache(home, {
        'email:a@example.com': entry('email:a@example.com', now, { email: 'a@example.com' }),
      });
      const cfg = writeConfigDir(home, 'aaaa1111', 'a@example.com');
      // Pid 1 is alive but this record has not beaten in half an hour; the other
      // beats now but its pid is long gone.
      writeWindow(home, {
        id: 'aaaa1111',
        workspace: 'stale-window',
        configDir: cfg,
        pid: 1,
        lastSeen: now - 30 * 60_000,
      });
      writeWindow(home, {
        id: 'bbbb2222',
        workspace: 'dead-window',
        configDir: cfg,
        pid: 0x7ffffff0,
        lastSeen: now,
      });
      const res = runJson(home);
      assert.deepEqual(res.json.accounts[0].windows, []);
      assert.deepEqual(res.json.otherWindows, []);
    });
  });

  it('narrows windows with --account, and does not resurface the filtered ones', () => {
    withHome((home) => {
      const now = Date.now();
      writeCache(home, {
        'email:a@example.com': entry('email:a@example.com', now, { email: 'a@example.com' }),
        'email:b@example.com': entry('email:b@example.com', now, { email: 'b@example.com' }),
      });
      writeWindow(home, {
        id: 'aaaa1111',
        workspace: 'my-project',
        configDir: writeConfigDir(home, 'aaaa1111', 'a@example.com'),
      });
      writeWindow(home, {
        id: 'bbbb2222',
        workspace: 'other-repo',
        configDir: writeConfigDir(home, 'bbbb2222', 'b@example.com'),
      });
      const res = runJson(home, ['--account', 'a@example.com']);
      assert.equal(res.status, 0);
      assert.equal(res.json.accounts.length, 1);
      assert.deepEqual(
        res.json.accounts[0].windows.map((w) => w.workspace),
        ['my-project']
      );
      // b's window is accounted for by an account the filter dropped — it is not
      // an unattributed window.
      assert.deepEqual(res.json.otherWindows, []);
    });
  });

  it('never lends a dir-keyed entry the windows it cannot claim', () => {
    withHome((home) => {
      // An entry keyed by directory has no email, and a window whose config dir
      // names nobody has none either — matching them would be a guess, and the
      // window would then be counted twice.
      const configDir = path.join(home, 'profiles', '.claude-work');
      writeCache(home, {
        [`dir:${configDir}`]: entry(`dir:${configDir}`, Date.now(), { email: null }),
      });
      const blank = path.join(home, '.claude-windows', 'cccc3333');
      fs.mkdirSync(blank, { recursive: true });
      const nameless = writeWindow(home, {
        id: 'cccc3333',
        workspace: 'mystery',
        configDir: blank,
      });
      const res = runJson(home);
      assert.equal(res.status, 0);
      assert.equal(res.json.accounts.length, 1);
      assert.equal(res.json.accounts[0].email, null);
      assert.deepEqual(res.json.accounts[0].windows, []);
      assert.deepEqual(res.json.otherWindows, [
        {
          workspace: 'mystery',
          configDir: blank,
          pid: nameless.pid,
          lastSeen: nameless.lastSeen,
          email: null,
        },
      ]);
    });
  });

  it('says in --text how many windows no row accounts for', () => {
    withHome((home) => {
      writeCache(home, {
        'email:a@example.com': entry('email:a@example.com', Date.now(), {
          email: 'a@example.com',
        }),
      });
      writeWindow(home, {
        id: 'aaaa1111',
        workspace: 'my-project',
        configDir: writeConfigDir(home, 'aaaa1111', 'a@example.com'),
      });
      writeWindow(home, {
        id: 'bbbb2222',
        workspace: 'other-repo',
        configDir: writeConfigDir(home, 'bbbb2222', 'b@example.com'),
      });
      const res = run(home, ['--text']);
      assert.equal(res.status, 0);
      // The table has no row to hang them on, so without this line they would
      // simply vanish from the format most people read.
      assert.match(res.stdout, /^other windows: 1 \(no cached usage for their account\)$/m);
    });
    withHome((home) => {
      writeCache(home, {
        'email:a@example.com': entry('email:a@example.com', Date.now(), {
          email: 'a@example.com',
        }),
      });
      writeWindow(home, {
        id: 'aaaa1111',
        workspace: 'my-project',
        configDir: writeConfigDir(home, 'aaaa1111', 'a@example.com'),
      });
      // Every window has a row of its own, so there is nothing to say.
      assert.doesNotMatch(run(home, ['--text']).stdout, /other windows:/);
    });
  });

  it('leaves the presence directory bytes and mtimes untouched', () => {
    withHome((home) => {
      const now = Date.now();
      writeCache(home, {
        'email:a@example.com': entry('email:a@example.com', now, { email: 'a@example.com' }),
      });
      writeWindow(home, {
        id: 'aaaa1111',
        workspace: 'my-project',
        configDir: writeConfigDir(home, 'aaaa1111', 'a@example.com'),
      });
      // A dead, day-old record the extension's sweep would remove: this command
      // must not sweep it, or it would be writing to a dir it only reads.
      writeWindow(home, {
        id: 'dddd4444',
        workspace: 'long-gone',
        configDir: path.join(home, '.claude-windows', 'dddd4444'),
        pid: 0x7ffffff0,
        lastSeen: now - 25 * 60 * 60_000,
      });
      const dir = presenceDir(home);
      const snapshot = () => ({
        files: fs.readdirSync(dir).sort(),
        dirMtimeMs: fs.statSync(dir).mtimeMs,
        entries: fs
          .readdirSync(dir)
          .sort()
          .map((f) => ({
            name: f,
            bytes: fs.readFileSync(path.join(dir, f)).toString('base64'),
            mtimeMs: fs.statSync(path.join(dir, f)).mtimeMs,
          })),
      });
      const before = snapshot();
      run(home, ['--json']);
      run(home, ['--text']);
      run(home, ['--account', 'a@example.com']);
      assert.deepEqual(snapshot(), before);
    });
  });
});
describe('usage CLI — cache path pin', () => {
  /** usage.ts reaches vscode through the logger, so it needs the usual stub. */
  function bundleUsage() {
    const stub = path.join(tmpRoot, 'vscode-stub.js');
    fs.writeFileSync(
      stub,
      `module.exports = {
         window: {
           createOutputChannel: () => ({ appendLine() {}, show() {} }),
           showWarningMessage: () => Promise.resolve(undefined),
           showInformationMessage: () => Promise.resolve(undefined),
           showErrorMessage: () => Promise.resolve(undefined),
         },
         commands: { executeCommand: () => Promise.resolve(undefined) },
       };`
    );
    const out = path.join(tmpRoot, 'usage.bundle.cjs');
    esbuild.buildSync({
      entryPoints: [path.join(__dirname, '../src/usage.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: out,
      alias: { vscode: stub },
    });
    return require(out);
  }

  it('reads the very file usage.ts writes', () => {
    const { policyDir } = bundleUsage();
    // usageCachePath() is module-private, so the file name comes from the source
    // it is declared in: this pins the CLI to the writer, not to a copy of it.
    const source = fs.readFileSync(path.join(__dirname, '../src/usage.ts'), 'utf-8');
    const declared =
      /function usageCachePath\(\)[^{]*\{\s*return path\.join\(policyDir\(\), '([^']+)'\);/.exec(
        source
      );
    assert.ok(declared, 'usage.ts no longer declares usageCachePath() as policyDir()/<file>');

    withHome((home) => {
      const prev = process.env.HOME;
      process.env.HOME = home;
      let expected;
      try {
        expected = path.join(policyDir(), declared[1]);
      } finally {
        process.env.HOME = prev;
      }
      // The CLI names the file it looked for when there is none.
      const res = runJson(home);
      const named = /no usage cache at (\S+)/.exec(res.json.warnings[0]);
      assert.ok(named, `no path in warning: ${res.json.warnings[0]}`);
      assert.equal(named[1], expected);
      assert.equal(named[1], cacheFile(home));
    });
  });
});
