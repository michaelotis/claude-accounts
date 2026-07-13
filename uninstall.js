// vscode:uninstall hook — runs via plain `node` when the extension is uninstalled.
//
// What VSCode actually gives us here — all four verified against its logs, and
// every one of them a trap this file used to fall into:
//
//   1. It does NOT run when you click Uninstall. The extension is only MARKED for
//      removal; the hook runs later, from `cleanUp() → deleteExtensionsMarkedForRemoval()`
//      at the next server start. So by the time it runs, the world may have moved on.
//   2. It gets FIVE SECONDS. Overrun and VSCode kills it mid-syscall
//      ("[error] Failed to run post uninstall script … timed out" — measured at
//      5.012s). A hook that is killed halfway through moving data destroys it.
//   3. Because of (1), it can fire AFTER a newer version has been installed — the
//      old version's folder is still on disk with its own copy of this script. A
//      cleanup that deletes account stores would then wipe the LIVE install's
//      accounts. Hence the guard below: if another copy is installed, do nothing.
//   4. It may never run at all (folder deleted by hand, cleanup skipped). So it is
//      best-effort by construction, and nothing may depend on it for correctness.
//
// The contract, in priority order — earlier goals are never sacrificed for later ones:
//   a. Never destroy a live install's data.          (the guard)
//   b. Never lose history.                           (deadline + no destructive step before its data is safe)
//   c. Leave Claude Code signed in and working.      (hand the account back first)
//   d. Leave no OAuth token behind.                  (tokens go even when (b) forces us to stop early)
//   e. Leave no leftover directories.                (only when everything above succeeded)
//
// Vanilla Claude Code (CLAUDE_CONFIG_DIR unset) reads its token from
// ~/.claude/.credentials.json and its identity from ~/.claude.json at the HOME
// ROOT — verified empirically, and NOT the layout of a CLAUDE_CONFIG_DIR account,
// where both sit inside the dir. Restoring to the wrong one leaves Claude Code
// silently signed out, which is the bug this hook exists to prevent.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/** Kept in sync with SHARED_DIRS + SHARED_FILES in src/sharedHistory.ts. */
const SHARED_DIRS = [
  'projects',
  'sessions',
  'session-env',
  'shell-snapshots',
  'file-history',
  'plans',
  'todos',
];
const SHARED_FILES = ['history.jsonl'];
const SHARED_ENTRIES = [...SHARED_DIRS, ...SHARED_FILES];

/**
 * Our own budget, comfortably inside VSCode's 5s kill timer. Being killed is not
 * an option: it happens between two syscalls of our choosing, so there is no way
 * to be safe against it — we simply must not still be running. Every loop that can
 * grow with the user's data checks this and stops at a consistent point instead.
 */
const DEADLINE_MS = 4000;
let deadline = Infinity;
const outOfTime = () => Date.now() > deadline;

/**
 * True if a DIFFERENT copy of this extension is still installed.
 *
 * VSCode defers this hook to the next server start, so the user may well have
 * reinstalled by then — and the folder we are running from is the OLD version's,
 * which knows nothing about that. Deleting the account stores at that point would
 * destroy the data of a perfectly healthy install. (This is not hypothetical: a
 * 1.3.0 folder sat in `.obsolete` with this script in it while 1.3.1 was live.)
 *
 * Everything needed to tell is right next to us: sibling folders in the same
 * extensions dir, minus the ones listed in `.obsolete` (VSCode's own record of
 * what is on its way out).
 */
function anotherCopyInstalled() {
  try {
    const root = path.dirname(__dirname); // …/extensions
    const me = path.basename(__dirname); // publisher.name-version[-target]
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));
    const prefix = `${pkg.publisher}.${pkg.name}-`.toLowerCase();
    let obsolete = {};
    try {
      obsolete = JSON.parse(fs.readFileSync(path.join(root, '.obsolete'), 'utf-8')) || {};
    } catch {
      // no .obsolete → nothing is pending removal → any sibling is a live install
    }
    return fs.readdirSync(root, { withFileTypes: true }).some(
      (e) =>
        e.isDirectory() &&
        e.name !== me &&
        e.name.toLowerCase().startsWith(prefix) &&
        !obsolete[e.name]
    );
  } catch {
    // Cannot tell. Assume there IS one: leaving files behind is a nuisance,
    // deleting a live install's accounts is a catastrophe.
    return true;
  }
}

/** The per-window working dirs this extension creates (~/.claude-windows/<id>). */
function workingDirs(root) {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(root, e.name));
  } catch {
    return [];
  }
}

/**
 * The account stores the extension manages, as recorded by the registry.
 *
 * Only these are ever deleted. A `~/.claude-<name>` dir NOT in the manifest was
 * made by the user (or another tool) and is none of our business — guessing from
 * the name alone is how an uninstall destroys someone else's data.
 */
function managedStores(home, manifestFile) {
  let stores;
  try {
    stores = JSON.parse(fs.readFileSync(manifestFile, 'utf-8')).stores;
  } catch {
    return []; // no manifest → delete no stores (fail safe)
  }
  if (!Array.isArray(stores)) return [];
  const home_ = path.normalize(home);
  return stores.filter((dir) => {
    if (typeof dir !== 'string') return false;
    const norm = path.normalize(dir);
    if (path.dirname(norm) !== home_) return false;
    const base = path.basename(norm);
    if (!/^\.claude[-_].+$/.test(base)) return false;
    return base !== '.claude-shared' && base !== '.claude-windows';
  });
}

/**
 * Folds `src` into `dst` by MOVING entries, never by reading them.
 *
 * The previous version compared colliding files byte for byte. On a real 1.3 GB
 * history that is 1.3 GB of reads: measured at 22 seconds — four times over the
 * kill timer, so the hook died mid-move. Nothing here may cost more than a stat:
 * a file that is already there and the same size is a duplicate of a store every
 * dir was symlinked to, and gets dropped; anything else is left where it is and
 * reported as a conflict, so the caller keeps the store instead of deleting it.
 *
 * Returns false if anything could not be moved (conflict, error, or out of time).
 */
function moveDirInto(src, dst) {
  let complete = true;
  let entries;
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch {
    return false;
  }
  fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    if (outOfTime()) return false;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    try {
      const dstStat = fs.lstatSync(d, { throwIfNoEntry: false });
      if (!dstStat) {
        fs.renameSync(s, d);
      } else if (entry.isDirectory() && dstStat.isDirectory()) {
        if (!moveDirInto(s, d)) complete = false;
      } else if (entry.isFile() && dstStat.isFile() && fs.statSync(s).size === dstStat.size) {
        fs.rmSync(s, { force: true }); // same size ⇒ the same file, seen twice
      } else {
        complete = false; // a real divergence — never resolved by guessing
      }
    } catch {
      complete = false;
    }
  }
  return complete;
}

/** Folds a line-based file (history.jsonl) into `dst`, skipping lines it has. */
function mergeFileInto(src, dst) {
  try {
    const existing = fs.existsSync(dst) ? fs.readFileSync(dst, 'utf-8') : '';
    const known = new Set(existing.split('\n').filter(Boolean));
    const incoming = fs
      .readFileSync(src, 'utf-8')
      .split('\n')
      .filter((line) => line && !known.has(line));
    if (incoming.length > 0) {
      const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
      fs.appendFileSync(dst, `${prefix}${incoming.join('\n')}\n`, { mode: 0o600 });
    }
    fs.rmSync(src, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Brings the history into the default dir, where plain Claude Code will look for it.
 *
 * In the normal case every entry is a symlink into the store, so this is one
 * unlink + one rename per entry — eight syscalls, measured at 135 ms regardless of
 * how many gigabytes the store holds. The unlink and the rename sit next to each
 * other on purpose: a kill between two ENTRIES leaves the rest still symlinked to
 * an intact store, and loses nothing.
 *
 * Returns true only if EVERY entry made it. The caller must not delete the store
 * otherwise — by then it is the only copy of whatever stayed behind.
 */
function consolidateHistory(defaultDir, store, otherDirs) {
  let complete = true;
  fs.mkdirSync(defaultDir, { recursive: true, mode: 0o700 });

  for (const name of SHARED_ENTRIES) {
    if (outOfTime()) return false;
    const src = path.join(store, name);
    const dst = path.join(defaultDir, name);
    try {
      if (!fs.existsSync(src)) continue;
      const dstStat = fs.lstatSync(dst, { throwIfNoEntry: false });
      // The common case: our own symlink. Drop it and move the real thing in.
      if (dstStat && dstStat.isSymbolicLink()) {
        fs.unlinkSync(dst);
        fs.renameSync(src, dst);
        continue;
      }
      if (!dstStat) {
        fs.renameSync(src, dst);
      } else if (SHARED_FILES.includes(name)) {
        if (!mergeFileInto(src, dst)) complete = false;
      } else if (!moveDirInto(src, dst)) {
        complete = false;
      }
    } catch {
      complete = false;
    }
  }

  // Versions up to 1.2.7 had a setting that turned sharing off, leaving real
  // history inside the account dirs that the store never saw. Fold that in too, or
  // deleting those dirs below would delete the only copy.
  for (const dir of otherDirs) {
    for (const name of SHARED_ENTRIES) {
      if (outOfTime()) return false;
      const src = path.join(dir, name);
      const dst = path.join(defaultDir, name);
      try {
        const st = fs.lstatSync(src, { throwIfNoEntry: false });
        if (!st || st.isSymbolicLink()) continue; // symlinks die with their dir (rm doesn't follow them)
        if (st.isDirectory()) {
          if (!moveDirInto(src, dst)) complete = false;
        } else if (st.isFile()) {
          if (fs.existsSync(dst)) {
            if (!mergeFileInto(src, dst)) complete = false;
          } else {
            fs.renameSync(src, dst);
          }
        }
      } catch {
        complete = false;
      }
    }
  }
  return complete;
}

/**
 * The dir holding the account to hand back: the freshest OAuth token on disk.
 *
 * Working dirs win over stores when both have one: a working dir is where Claude
 * Code actually ran, so its token is the one that got refreshed and its config is
 * the live one, where a store's config is only a snapshot from when it was saved.
 */
function lastUsedDir(working, stores) {
  const freshest = (dirs) => {
    let best;
    let bestTime = -1;
    for (const dir of dirs) {
      try {
        const t = fs.statSync(path.join(dir, '.credentials.json')).mtimeMs;
        if (t > bestTime) {
          bestTime = t;
          best = dir;
        }
      } catch {
        // no token here — not a candidate
      }
    }
    return best;
  };
  return freshest(working) ?? freshest(stores);
}

/**
 * Hands the account back to vanilla Claude Code: token into ~/.claude, identity
 * into ~/.claude.json. Both come from the SAME dir — an identity paired with
 * another account's token is the exact desync this extension was built to fix.
 *
 * Runs FIRST, before anything is moved or deleted: it is the one step that decides
 * whether the user still has a working Claude Code, and it costs two small copies.
 * The config is merged over whatever ~/.claude.json already had rather than
 * replacing it, so settings that predate the extension survive.
 */
function restoreDefaultAccount(source, defaultDir, defaultConfig) {
  try {
    const token = path.join(source, '.credentials.json');
    if (!fs.existsSync(token)) return;
    fs.mkdirSync(defaultDir, { recursive: true, mode: 0o700 });
    const dstToken = path.join(defaultDir, '.credentials.json');
    fs.copyFileSync(token, dstToken);
    fs.chmodSync(dstToken, 0o600);

    const cfgFile = path.join(source, '.claude.json');
    if (!fs.existsSync(cfgFile)) return;
    const incoming = JSON.parse(fs.readFileSync(cfgFile, 'utf-8'));
    let existing = {};
    try {
      existing = JSON.parse(fs.readFileSync(defaultConfig, 'utf-8'));
    } catch {
      // no default config yet, or unreadable — the account's is all we need
    }
    const merged = {
      ...existing,
      ...incoming,
      projects: { ...(existing.projects || {}), ...(incoming.projects || {}) },
    };
    const tmp = `${defaultConfig}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, defaultConfig); // atomic: a half-written config bricks Claude Code
  } catch {
    /* best-effort */
  }
}

/** Deletes the OAuth token from our dirs. The one step that must happen even when we bail out. */
function dropTokens(dirs) {
  for (const dir of dirs) {
    try {
      fs.rmSync(path.join(dir, '.credentials.json'), { force: true });
    } catch {
      /* best-effort */
    }
  }
}

function main() {
  // On unsupported platforms the extension activates into an inert mode and never
  // created anything, so there is nothing to revert — and guessing at other OSes'
  // file layouts on uninstall is exactly the manipulation that mode promises not
  // to do.
  if (os.platform() !== 'linux') return;

  // A newer copy is live and this data is now ITS data. Touch nothing.
  if (anotherCopyInstalled()) return;

  deadline = Date.now() + DEADLINE_MS;

  const home = os.homedir();
  const defaultDir = path.join(home, '.claude');
  const defaultConfig = path.join(home, '.claude.json');
  const store = path.join(home, '.claude-shared');
  const workRoot = path.join(home, '.claude-windows');

  const working = workingDirs(workRoot);
  const stores = managedStores(home, path.join(workRoot, '.manifest.json'));
  const ours = [...working, ...stores];

  // 1. Leave Claude Code working. Cheap, and everything after it is optional.
  const source = lastUsedDir(working, stores);
  if (source) restoreDefaultAccount(source, defaultDir, defaultConfig);

  // 2. Get the history somewhere plain Claude Code can see it.
  const consolidated = consolidateHistory(defaultDir, store, ours);

  // 3. If any history stayed behind, the dirs holding it are now its only copy —
  //    keep them. The tokens still go: a leftover folder is untidy, a leftover
  //    OAuth token is a credential we promised not to leave lying around.
  if (!consolidated) {
    dropTokens(ours);
    return;
  }

  // 4. Everything is safe in ~/.claude. Our dirs hold nothing but duplicated
  //    credentials, config and dangling symlinks (rmSync does not follow those,
  //    so the store's content is never at risk here). A short-lived earlier
  //    version also kept token copies in ~/.claude-vault.
  for (const dir of [...ours, workRoot, store, path.join(home, '.claude-vault')]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

main();
