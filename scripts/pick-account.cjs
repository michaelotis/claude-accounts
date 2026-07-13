#!/usr/bin/env node
/**
 * Shared account picker for claude-orch.
 * Usage: node scripts/pick-account.cjs <policy.json> <cwd>
 * Prints chosen CLAUDE_CONFIG_DIR path or empty.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const libCandidates = [
  path.join(__dirname, 'lib', 'usageParse.cjs'),
  path.join(__dirname, 'claude-accounts-lib', 'lib', 'usageParse.cjs'),
  path.join(__dirname, '..', 'scripts', 'lib', 'usageParse.cjs'),
];
const lib = libCandidates.find((p) => fs.existsSync(p));
if (!lib) {
  console.error('pick-account: usageParse.cjs not found — run npm run compile in claude-accounts');
  process.exit(1);
}
const { selectFailoverAccount, accountIsCool } = require(lib);

const policyPath = process.argv[2];
const cwd = process.argv[3] || process.cwd();
const envDir = process.env.CLAUDE_CONFIG_DIR || '';

if (!policyPath || !fs.existsSync(policyPath)) {
  if (envDir && fs.existsSync(envDir)) process.stdout.write(envDir);
  process.exit(0);
}

let p;
try {
  p = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
} catch {
  process.exit(0);
}

const accounts = Array.isArray(p.accounts) ? p.accounts : [];
const thr = p.thresholds || { session: 90, weekly: 90, fable: 90 };
const trig = Object.assign({ session: true, weekly: true, fable: false }, p.triggers || {});
const routes = Array.isArray(p.workspaceRoutes) ? p.workspaceRoutes : [];
const strategy = p.strategy || 'lowestUsage';
let order = Array.isArray(p.accountOrder) ? p.accountOrder.map(String) : [];
if (!order.length) {
  if (p.primaryEmail) order.push(p.primaryEmail);
  if (p.secondaryEmail) order.push(p.secondaryEmail);
}

function norm(p0) {
  let n = path.resolve(p0 || '');
  while (n.length > 1 && (n.endsWith('/') || n.endsWith(path.sep))) n = n.slice(0, -1);
  return n;
}

function matchRoute(fsPath) {
  const target = norm(fsPath);
  let best = null;
  let bestLen = -1;
  for (const r of routes) {
    if (!r || !r.pathPrefix || !r.email) continue;
    const prefix = norm(r.pathPrefix);
    if (target === prefix || target.startsWith(prefix + path.sep)) {
      if (prefix.length > bestLen) {
        best = r;
        bestLen = prefix.length;
      }
    }
  }
  return best;
}

function byEmail(email) {
  return accounts.find((a) => a && a.email === email) || null;
}

// 1) Workspace hard pin
const route = matchRoute(cwd);
if (route) {
  const acc = byEmail(route.email);
  if (acc && acc.dir && fs.existsSync(acc.dir)) {
    if (process.env.CLAUDE_ORCH_VERBOSE) {
      console.error('claude-orch: workspace', cwd, '→', route.email);
    }
    process.stdout.write(acc.dir);
    process.exit(0);
  }
  if (process.env.CLAUDE_ORCH_VERBOSE) {
    console.error('claude-orch: workspace route', route.email, 'but no account dir');
  }
  // fail closed for wrong-account risk under a work tree: no env fallthrough
  process.exit(0);
}

// 2) Honor bound window env when no route
if (envDir && fs.existsSync(envDir)) {
  process.stdout.write(envDir);
  process.exit(0);
}

// 3) Strategy pick only in cli mode
if (p.mode !== 'cli') process.exit(0);

const pool = accounts
  .filter((a) => a && a.dir && fs.existsSync(a.dir))
  .map((a) => ({
    id: a.email || a.id || a.name,
    email: a.email,
    name: a.name,
    dir: a.dir,
    sessionPercent: a.sessionPercent ?? 0,
    weeklyPercent: a.weeklyPercent ?? 0,
    fablePercent: a.fablePercent ?? null,
  }));

// Prefer cool accounts only for auto pick (no hot least-bad for CLI either when any cool exists)
const cool = pool.filter((a) => accountIsCool(a, thr, trig));
const usePool = cool.length ? cool : pool;

const picked = selectFailoverAccount(usePool, {
  strategy,
  order,
  thresholds: thr,
  triggers: trig,
});

if (picked && picked.dir && fs.existsSync(picked.dir)) {
  if (process.env.CLAUDE_ORCH_VERBOSE) {
    console.error(
      'claude-orch: pick',
      strategy,
      picked.email || picked.id,
      cool.length ? 'cool-pool' : 'least-bad'
    );
  }
  process.stdout.write(picked.dir);
}
