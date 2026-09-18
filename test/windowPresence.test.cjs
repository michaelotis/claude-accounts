const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `window-presence-${process.pid}-`));

/**
 * Bundled with NO vscode alias on purpose: the usage CLI bundles this module
 * with nothing marked external, so this build failing IS the test that nothing
 * in its graph reaches vscode.
 */
const bundleOut = path.join(tmpRoot, 'windowPresence.bundle.cjs');
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/windowPresence.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile: bundleOut,
});
const {
  PRESENCE_HEARTBEAT_MS,
  PRESENCE_MAX_AGE_MS,
  PRESENCE_SWEEP_AGE_MS,
  describeWindows,
  moveRecord,
  presenceDir,
  presenceIdFor,
  readWindows,
  removePresence,
  sweepPresence,
  writePresence,
} = require(bundleOut);

/** A record written by another machine — its pid means nothing here. */
const FOREIGN_HOST = `not-${os.hostname()}`;

after(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

let n = 0;
/** A presence dir that does not exist yet — writePresence has to create it. */
function freshDir() {
  return path.join(tmpRoot, `presence-${n++}`, 'windows');
}

/** A config dir whose .claude.json names `email` (null writes no identity). */
function configDir(email) {
  const dir = path.join(tmpRoot, `config-${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  if (email !== null) {
    fs.writeFileSync(
      path.join(dir, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: email } })
    );
  }
  return dir;
}

function rec(over = {}) {
  return {
    id: 'aaaa1111',
    workspace: 'my-project',
    configDir: '/nonexistent',
    pid: process.pid,
    lastSeen: Date.now(),
    ...over,
  };
}

/** Bytes + mtime of every file in a dir, plus the dir's own mtime. */
function snapshot(dir) {
  const files = fs.readdirSync(dir).sort();
  return {
    files,
    dirMtimeMs: fs.statSync(dir).mtimeMs,
    entries: files.map((f) => ({
      name: f,
      bytes: fs.readFileSync(path.join(dir, f)).toString('base64'),
      mtimeMs: fs.statSync(path.join(dir, f)).mtimeMs,
    })),
  };
}

function win(over = {}) {
  return {
    id: 'aaaa1111',
    workspace: 'my-project',
    configDir: '/nonexistent',
    pid: 1,
    lastSeen: 0,
    email: 'a@example.com',
    ...over,
  };
}

describe('window presence — the directory it owns', () => {
  it('writes the record 0600 inside a 0700 directory', () => {
    const dir = freshDir();
    writePresence(rec(), dir);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dir, 'aaaa1111.json')).mode & 0o777, 0o600);
  });

  it('writes one file per window id, and removePresence takes exactly that one', () => {
    const dir = freshDir();
    writePresence(rec({ id: 'aaaa1111' }), dir);
    writePresence(rec({ id: 'default-4242' }), dir);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['aaaa1111.json', 'default-4242.json']);
    removePresence('aaaa1111', dir);
    assert.deepEqual(fs.readdirSync(dir), ['default-4242.json']);
    // Removing what is already gone is not an error — deactivate runs blind.
    removePresence('aaaa1111', dir);
  });

  it('records the shape readers expect, and no account of its own', () => {
    const dir = freshDir();
    const written = rec({ configDir: '/home/x/.claude-windows/aaaa1111' });
    writePresence(written, dir);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'aaaa1111.json'), 'utf-8'));
    assert.deepEqual(Object.keys(onDisk).sort(), [
      'configDir',
      'host',
      'id',
      'lastSeen',
      'pid',
      'v',
      'workspace',
    ]);
    assert.equal(onDisk.v, 1);
    assert.equal(onDisk.host, os.hostname());
    assert.equal(onDisk.configDir, written.configDir);
    // The account is derived from configDir at read time; a record that carried
    // one could name an account the dir no longer runs.
    assert.equal(JSON.stringify(onDisk).includes('email'), false);
  });

  it('resolves under $HOME, so an overridden HOME gets its own directory', () => {
    const prev = process.env.HOME;
    process.env.HOME = path.join(tmpRoot, 'home-a');
    try {
      assert.equal(
        presenceDir(),
        path.join(tmpRoot, 'home-a', '.config', 'claude-accounts', 'windows')
      );
    } finally {
      process.env.HOME = prev;
    }
  });
});

describe('window presence — one record per window', () => {
  it('gives two windows on one working dir two ids', () => {
    const envDir = '/home/x/.claude-windows/aaaa1111';
    assert.notEqual(presenceIdFor(envDir, 4242), presenceIdFor(envDir, 4343));
    // The dir is still recognisable in the id; the pid is what separates them.
    assert.match(presenceIdFor(envDir, 4242), /^aaaa1111-.*-4242$/);
    assert.match(presenceIdFor(undefined, 4242), /^default-.*-4242$/);
  });

  it('keeps both of them, and closing one leaves the other', () => {
    const dir = freshDir();
    const now = Date.now();
    const envDir = '/home/x/.claude-windows/aaaa1111';
    const first = presenceIdFor(envDir, process.pid);
    const second = presenceIdFor(envDir, process.pid + 1);
    writePresence(rec({ id: first, workspace: 'my-project', lastSeen: now }), dir);
    writePresence(rec({ id: second, workspace: 'my-project', lastSeen: now }), dir);
    assert.deepEqual(
      readWindows(now, { dir, isAlive: () => true })
        .map((w) => w.id)
        .sort(),
      [first, second].sort()
    );
    // What deactivate() does in one of the two windows.
    removePresence(first, dir);
    assert.deepEqual(
      readWindows(now, { dir, isAlive: () => true }).map((w) => w.id),
      [second]
    );
  });

  it('moveRecord writes the new record and retires the old one', () => {
    const dir = freshDir();
    moveRecord(undefined, rec({ id: 'before' }), dir);
    moveRecord('before', rec({ id: 'after' }), dir);
    assert.deepEqual(fs.readdirSync(dir), ['after.json']);
    // The same id twice is a heartbeat, not a move — it must not delete itself.
    moveRecord('after', rec({ id: 'after' }), dir);
    assert.deepEqual(fs.readdirSync(dir), ['after.json']);
  });

  it('moveRecord still writes the new record when the old one cannot be removed', () => {
    const dir = freshDir();
    fs.mkdirSync(dir, { recursive: true });
    // A directory where the old record's file should be: removing it throws.
    fs.mkdirSync(path.join(dir, 'stuck.json'));
    assert.throws(() => removePresence('stuck', dir));
    // The failure is handed back rather than swallowed: the record left behind
    // carries a live pid, so nothing else would ever report it.
    const handed = [];
    moveRecord('stuck', rec({ id: 'moved' }), dir, (err) => handed.push(err));
    assert.equal(handed.length, 1, 'the removal failure reached the caller');
    assert.ok(handed[0] instanceof Error);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['moved.json', 'stuck.json']);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(dir, 'moved.json'), 'utf-8')).id,
      'moved',
      'the new record was not written'
    );
  });
});

describe('window presence — liveness', () => {
  it('returns a live record with the email its configDir names', () => {
    const dir = freshDir();
    const cfg = configDir('a@example.com');
    const now = Date.now();
    writePresence(rec({ configDir: cfg, lastSeen: now }), dir);
    const windows = readWindows(now, { dir });
    assert.equal(windows.length, 1);
    assert.deepEqual(windows[0], {
      id: 'aaaa1111',
      workspace: 'my-project',
      configDir: cfg,
      pid: process.pid,
      lastSeen: now,
      host: os.hostname(),
      email: 'a@example.com',
    });
  });

  it('excludes a record whose pid is dead', () => {
    const dir = freshDir();
    const now = Date.now();
    writePresence(rec({ id: 'alive', pid: 4242, lastSeen: now }), dir);
    writePresence(rec({ id: 'dead', pid: 4343, lastSeen: now }), dir);
    const windows = readWindows(now, { dir, isAlive: (pid) => pid === 4242 });
    assert.deepEqual(
      windows.map((w) => w.id),
      ['alive']
    );
  });

  it('excludes a live pid whose record is past the max age — pid reuse is not presence', () => {
    const dir = freshDir();
    const now = Date.now();
    writePresence(rec({ id: 'fresh', lastSeen: now - PRESENCE_MAX_AGE_MS }), dir);
    writePresence(rec({ id: 'aged', lastSeen: now - PRESENCE_MAX_AGE_MS - 1_000 }), dir);
    const windows = readWindows(now, { dir, isAlive: () => true });
    // The bound itself is still live; only past it is gone.
    assert.deepEqual(
      windows.map((w) => w.id),
      ['fresh']
    );
  });

  it('reads a stamp up to one heartbeat ahead as now, and one further ahead as undatable', () => {
    const dir = freshDir();
    const now = Date.now();
    // A clock stepped back between the write and this read: the window is there,
    // and blanking the whole map over a few seconds of drift helps nobody.
    writePresence(rec({ id: 'jitter', lastSeen: now + 30_000 }), dir);
    writePresence(rec({ id: 'edge', lastSeen: now + PRESENCE_HEARTBEAT_MS }), dir);
    // Ten minutes ahead is not a heartbeat this machine can date.
    writePresence(rec({ id: 'future', lastSeen: now + 10 * 60_000 }), dir);
    assert.deepEqual(
      readWindows(now, { dir, isAlive: () => true })
        .map((w) => w.id)
        .sort(),
      ['edge', 'jitter']
    );
  });

  it('judges another host by its heartbeat alone — its pid is about another machine', () => {
    const dir = freshDir();
    const now = Date.now();
    // Dead here, beating there: the pid answers about THIS machine's processes.
    writePresence(rec({ id: 'elsewhere', host: FOREIGN_HOST, pid: 4343, lastSeen: now }), dir);
    // Alive here by coincidence of a reused pid, but nothing has beaten in an hour.
    writePresence(
      rec({
        id: 'elsewhere-gone',
        host: FOREIGN_HOST,
        pid: process.pid,
        lastSeen: now - PRESENCE_MAX_AGE_MS - 1_000,
      }),
      dir
    );
    assert.deepEqual(
      readWindows(now, { dir, isAlive: (pid) => pid === process.pid }).map((w) => w.id),
      ['elsewhere']
    );
  });

  it('treats a record with no host as this machine’s, as the first release wrote them', () => {
    const dir = freshDir();
    const now = Date.now();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'v1.json'),
      JSON.stringify({ v: 1, id: 'v1', workspace: 'x', configDir: '/x', pid: 4343, lastSeen: now })
    );
    // Judged on its pid, like any local record: dead here means gone.
    assert.deepEqual(readWindows(now, { dir, isAlive: () => false }), []);
    assert.deepEqual(
      readWindows(now, { dir, isAlive: () => true }).map((w) => w.id),
      ['v1']
    );
  });

  it('uses the real pid check when none is injected', () => {
    const dir = freshDir();
    const now = Date.now();
    writePresence(rec({ id: 'self', pid: process.pid, lastSeen: now }), dir);
    assert.deepEqual(
      readWindows(now, { dir }).map((w) => w.id),
      ['self']
    );
  });

  it('is empty, never a throw, when the directory does not exist', () => {
    assert.deepEqual(readWindows(Date.now(), { dir: path.join(tmpRoot, 'no-such-dir') }), []);
  });
});

describe('window presence — the account follows the config dir', () => {
  it('re-reads the config dir on every read, so a switch shows up at once', () => {
    const dir = freshDir();
    const cfg = configDir('a@example.com');
    const now = Date.now();
    writePresence(rec({ configDir: cfg, lastSeen: now }), dir);
    assert.equal(readWindows(now, { dir })[0].email, 'a@example.com');

    // The same window, the same record — the dir was signed in to as someone else.
    fs.writeFileSync(
      path.join(cfg, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'b@example.com' } })
    );
    assert.equal(readWindows(now, { dir })[0].email, 'b@example.com');
  });

  it('is null, never a guess, when the config dir names no account', () => {
    const dir = freshDir();
    const now = Date.now();
    writePresence(rec({ id: 'missing', configDir: configDir(null), lastSeen: now }), dir);
    const cfg = configDir('a@example.com');
    fs.writeFileSync(path.join(cfg, '.claude.json'), '{ not json');
    writePresence(rec({ id: 'corrupt', configDir: cfg, lastSeen: now }), dir);
    const byId = new Map(readWindows(now, { dir }).map((w) => [w.id, w.email]));
    assert.equal(byId.get('missing'), null);
    assert.equal(byId.get('corrupt'), null);
  });

  it('reads the default dir identity from the home root, where Claude Code keeps it', () => {
    const prev = process.env.HOME;
    const home = path.join(tmpRoot, `home-default-${n++}`);
    const dir = freshDir();
    const now = Date.now();
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    // ~/.claude/.claude.json has no oauthAccount; the identity is one level up.
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'a@example.com' } })
    );
    process.env.HOME = home;
    try {
      writePresence(
        rec({ id: 'default-1', configDir: path.join(home, '.claude'), lastSeen: now }),
        dir
      );
      assert.equal(readWindows(now, { dir })[0].email, 'a@example.com');
    } finally {
      process.env.HOME = prev;
    }
  });

  it('applies that fallback to the default dir only, never to a working dir', () => {
    const prev = process.env.HOME;
    const home = path.join(tmpRoot, `home-only-default-${n++}`);
    const dir = freshDir();
    const now = Date.now();
    const workDir = path.join(home, '.claude-windows', 'aaaa1111');
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'a@example.com' } })
    );
    process.env.HOME = home;
    try {
      // A working dir mid-sign-in has no identity of its own. The home root's
      // belongs to ~/.claude, and lending it here would name an account this
      // window is not running.
      writePresence(rec({ id: 'working', configDir: workDir, lastSeen: now }), dir);
      assert.equal(readWindows(now, { dir })[0].email, null);
    } finally {
      process.env.HOME = prev;
    }
  });
});

describe('window presence — records it refuses to read', () => {
  it('skips unreadable, non-JSON, non-object and wrong-version files without throwing', () => {
    const dir = freshDir();
    const now = Date.now();
    writePresence(rec({ id: 'good', lastSeen: now }), dir);
    fs.writeFileSync(path.join(dir, 'truncated.json'), '{"v":1,"id":"truncated"');
    fs.writeFileSync(path.join(dir, 'array.json'), '[1,2,3]');
    fs.writeFileSync(path.join(dir, 'string.json'), '"nope"');
    fs.writeFileSync(path.join(dir, 'null.json'), 'null');
    fs.writeFileSync(
      path.join(dir, 'v2.json'),
      JSON.stringify({ ...rec({ id: 'v2' }), v: 2, lastSeen: now })
    );
    fs.writeFileSync(
      path.join(dir, 'nofield.json'),
      JSON.stringify({ v: 1, id: 'nofield', workspace: 'x', configDir: '/x', lastSeen: now })
    );
    // Not a .json file at all — a stray editor backup must not be read as one.
    fs.writeFileSync(path.join(dir, 'good.json.bak'), '{"v":1}');

    const windows = readWindows(now, { dir, isAlive: () => true });
    assert.deepEqual(
      windows.map((w) => w.id),
      ['good']
    );
  });

  it('refuses a pid that is not a real process id', () => {
    const dir = freshDir();
    const now = Date.now();
    writePresence(rec({ id: 'good', lastSeen: now }), dir);
    // kill(0, 0) signals THIS process and a negative pid signals a process
    // GROUP, so either would answer "alive" for as long as the file sat there.
    writePresence(rec({ id: 'zero', pid: 0, lastSeen: now }), dir);
    writePresence(rec({ id: 'negative', pid: -1, lastSeen: now }), dir);
    writePresence(rec({ id: 'fractional', pid: 42.5, lastSeen: now }), dir);
    assert.deepEqual(
      readWindows(now, { dir, isAlive: () => true }).map((w) => w.id),
      ['good']
    );
  });

  it('refuses a record missing or mistyping a field a reader would have to invent', () => {
    const dir = freshDir();
    const now = Date.now();
    writePresence(rec({ id: 'good', lastSeen: now }), dir);
    const bad = {
      'empty-id': { id: '', workspace: 'x', configDir: '/x', pid: 42, lastSeen: now },
      'workspace-number': { id: 'a', workspace: 5, configDir: '/x', pid: 42, lastSeen: now },
      'empty-configdir': { id: 'b', workspace: 'x', configDir: '', pid: 42, lastSeen: now },
      'lastseen-text': { id: 'c', workspace: 'x', configDir: '/x', pid: 42, lastSeen: 'now' },
      'host-number': { id: 'd', workspace: 'x', configDir: '/x', pid: 42, lastSeen: now, host: 5 },
    };
    for (const [name, fixture] of Object.entries(bad)) {
      fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ v: 1, ...fixture }));
    }
    // A directory named like a record: reading it fails with EISDIR, and one
    // unreadable entry must cost its own window and no other.
    fs.mkdirSync(path.join(dir, 'adir.json'));

    assert.deepEqual(
      readWindows(now, { dir, isAlive: () => true }).map((w) => w.id),
      ['good']
    );
  });
});

describe('window presence — reading changes nothing', () => {
  it('leaves the directory byte- and mtime-identical', () => {
    const dir = freshDir();
    const now = Date.now();
    writePresence(rec({ id: 'one', configDir: configDir('a@example.com'), lastSeen: now }), dir);
    writePresence(rec({ id: 'two', workspace: '', lastSeen: now - 10 * 60_000 }), dir);
    fs.writeFileSync(path.join(dir, 'junk.json'), 'not json');
    const before = snapshot(dir);
    readWindows(now, { dir });
    readWindows(now, { dir, isAlive: () => false });
    readWindows(now + PRESENCE_MAX_AGE_MS * 10, { dir });
    assert.deepEqual(snapshot(dir), before);
  });
});

describe('window presence — the sweep', () => {
  it('removes a dead day-old record and keeps a dead recent one and a live old one', () => {
    const dir = freshDir();
    const now = Date.now();
    writePresence(rec({ id: 'dead-25h', pid: 4343, lastSeen: now - 25 * 60 * 60_000 }), dir);
    writePresence(rec({ id: 'dead-1h', pid: 4343, lastSeen: now - 60 * 60_000 }), dir);
    writePresence(rec({ id: 'live-25h', pid: 4242, lastSeen: now - 25 * 60 * 60_000 }), dir);
    const removed = sweepPresence(now, { dir, isAlive: (pid) => pid === 4242 });
    assert.equal(removed, 1);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['dead-1h.json', 'live-25h.json']);
  });

  it('keeps a record at exactly the sweep age and removes one a millisecond past it', () => {
    const dir = freshDir();
    const now = Date.now();
    writePresence(rec({ id: 'at-bound', pid: 4343, lastSeen: now - PRESENCE_SWEEP_AGE_MS }), dir);
    writePresence(rec({ id: 'past', pid: 4343, lastSeen: now - PRESENCE_SWEEP_AGE_MS - 1 }), dir);
    assert.equal(sweepPresence(now, { dir, isAlive: () => false }), 1);
    assert.deepEqual(fs.readdirSync(dir), ['at-bound.json']);
  });

  it('removes another host’s record on age alone, and never on its pid', () => {
    const dir = freshDir();
    const now = Date.now();
    writePresence(
      rec({ id: 'far-old', host: FOREIGN_HOST, pid: 4242, lastSeen: now - 25 * 60 * 60_000 }),
      dir
    );
    writePresence(rec({ id: 'far-recent', host: FOREIGN_HOST, pid: 4343, lastSeen: now }), dir);
    // isAlive says yes to everything: a foreign pid must not be asked at all,
    // and a foreign record still beating must survive it.
    assert.equal(sweepPresence(now, { dir, isAlive: () => true }), 1);
    assert.deepEqual(fs.readdirSync(dir), ['far-recent.json']);
  });

  it('collects a staging file an interrupted write left behind, once it is a day old', () => {
    const dir = freshDir();
    const now = Date.now();
    writePresence(rec({ id: 'live', lastSeen: now }), dir);
    const old = path.join(dir, 'aaaa1111.json.4242.0.tmp');
    const fresh = path.join(dir, 'aaaa1111.json.4343.0.tmp');
    fs.writeFileSync(old, '{"half":');
    fs.writeFileSync(fresh, '{"half":');
    const aged = (now - PRESENCE_SWEEP_AGE_MS - 60_000) / 1_000;
    fs.utimesSync(old, aged, aged);
    assert.equal(sweepPresence(now, { dir, isAlive: () => true }), 1);
    // The fresh one may belong to a write in flight right now.
    assert.deepEqual(fs.readdirSync(dir).sort(), ['aaaa1111.json.4343.0.tmp', 'live.json']);
  });

  it('leaves a record it cannot date, and is 0 on a directory that is not there', () => {
    const dir = freshDir();
    writePresence(rec({ id: 'good', pid: 4242 }), dir);
    fs.writeFileSync(path.join(dir, 'junk.json'), 'not json');
    assert.equal(sweepPresence(Date.now(), { dir, isAlive: () => false }), 0);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['good.json', 'junk.json']);
    assert.equal(sweepPresence(Date.now(), { dir: path.join(tmpRoot, 'no-such-sweep') }), 0);
  });
});

describe('window presence — the card line', () => {
  const label = (email) => `acct-${email.split('@')[0]}`;

  it('says nothing when no window is live', () => {
    assert.equal(describeWindows([], label), '');
  });

  it('names one window in the singular', () => {
    const line = describeWindows([win({ workspace: 'my-project' })], label);
    assert.equal(line, '**acct-a** — 1 window: my-project');
  });

  it('counts in the plural and collapses past two names into +N', () => {
    const line = describeWindows(
      [
        win({ id: '1', workspace: 'my-project' }),
        win({ id: '2', workspace: 'other-repo' }),
        win({ id: '3', workspace: 'third-repo' }),
      ],
      label
    );
    assert.equal(line, '**acct-a** — 3 windows: my-project, other-repo, +1');
  });

  it('says just the two names when there are exactly two, never a +0', () => {
    const line = describeWindows(
      [win({ id: '1', workspace: 'my-project' }), win({ id: '2', workspace: 'other-repo' })],
      label
    );
    assert.equal(line, '**acct-a** — 2 windows: my-project, other-repo');
  });

  it('renders a folder name that looks like a theme icon as text', () => {
    // The card has theme icons enabled, so `$(sync~spin)` would come out as a
    // spinning icon standing where a folder name should be.
    const line = describeWindows([win({ workspace: '$(sync~spin)' })], label);
    assert.equal(line.includes('$(sync~spin)'), false);
    assert.equal(line, '**acct-a** — 1 window: $ (sync~spin)');
  });

  it('keeps a name with a newline or a tab on one line', () => {
    const line = describeWindows([win({ workspace: 'one\r\ntwo\tthree' })], label);
    assert.equal(line, '**acct-a** — 1 window: one two three');
    assert.equal(line.includes('\n'), false);
  });

  it('reads a folderless window as (no folder)', () => {
    assert.equal(
      describeWindows([win({ workspace: '' })], label),
      '**acct-a** — 1 window: (no folder)'
    );
  });

  it('groups windows with no readable account under unknown account, last', () => {
    const line = describeWindows(
      [
        win({ id: '1', email: null, workspace: 'mystery' }),
        win({ id: '2', email: 'a@example.com', workspace: 'my-project' }),
      ],
      label
    );
    assert.equal(
      line,
      '**acct-a** — 1 window: my-project\n\n**unknown account** — 1 window: mystery'
    );
  });

  it('asks for a label by lowercased email, once per account', () => {
    const asked = [];
    describeWindows(
      [
        win({ id: '1', email: 'A@Example.com', workspace: 'one' }),
        win({ id: '2', email: 'a@example.com', workspace: 'two' }),
        win({ id: '3', email: null, workspace: 'three' }),
      ],
      (email) => {
        asked.push(email);
        return 'acct';
      }
    );
    assert.deepEqual(asked, ['a@example.com']);
  });

  it('sorts accounts by label', () => {
    const line = describeWindows(
      [
        win({ id: '1', email: 'z@example.com', workspace: 'zed' }),
        win({ id: '2', email: 'a@example.com', workspace: 'ay' }),
      ],
      label
    );
    assert.match(line, /^\*\*acct-a\*\*[\s\S]*\*\*acct-z\*\*/);
  });

  it('renders a folder name that looks like a command link inert', () => {
    const line = describeWindows([win({ workspace: '](command:evil)' })], label);
    // The bracket that would close a link label is escaped, so the card shows the
    // folder name instead of a link the hover would run.
    assert.equal(line, '**acct-a** — 1 window: \\](command:evil)');
    assert.equal(line.includes('**](command:evil)'), false);
  });

  it('escapes the account label the same way', () => {
    const line = describeWindows([win({ workspace: 'my-project' })], () => 'a](command:evil)');
    assert.equal(line, '**a\\](command:evil)** — 1 window: my-project');
  });
});
