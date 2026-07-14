const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');

const pick = path.join(__dirname, '../scripts/pick-account.cjs');
const orch = path.join(__dirname, '../scripts/claude-orch');

describe('claude-orch refuse on matched-but-missing pin', () => {
  it('exits non-zero and does not exec real claude', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-orch-refuse-'));
    const envDir = path.join(tmp, 'inherited-account');
    fs.mkdirSync(envDir, { recursive: true });
    const policyFile = path.join(tmp, 'policy.json');
    fs.writeFileSync(
      policyFile,
      JSON.stringify({
        mode: 'cli',
        thresholds: { session: 90, weekly: 90, fable: 90 },
        triggers: { session: true, weekly: true, fable: false },
        workspaceRoutes: [{ pathPrefix: tmp, email: 'missing@example.com' }],
        accounts: [],
      })
    );

    const stub = path.join(tmp, 'fake-claude');
    fs.writeFileSync(stub, '#!/usr/bin/env bash\necho "RAN:$CLAUDE_CONFIG_DIR"\n', { mode: 0o755 });

    const result = spawnSync('bash', [orch], {
      cwd: tmp,
      env: {
        ...process.env,
        CLAUDE_ACCOUNTS_POLICY: policyFile,
        CLAUDE_ACCOUNTS_REAL: stub,
        CLAUDE_CONFIG_DIR: envDir,
        // Avoid sticky path short-circuit if present in ambient env
        CLAUDE_ORCH_STICKY_DIR: '',
      },
      encoding: 'utf8',
    });

    assert.notEqual(result.status, 0, `expected non-zero exit, got ${result.status}`);
    assert.ok(
      !result.stdout.includes('RAN:'),
      `stub must not run; stdout was: ${JSON.stringify(result.stdout)}`
    );
    assert.ok(
      (result.stderr || '').includes('pinned') || (result.stderr || '').includes('Refusing'),
      `expected actionable message on stderr, got: ${JSON.stringify(result.stderr)}`
    );

    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
});

describe('pick-account prefers metered over unmetered 0%', () => {
  it('picks the metered account when an unmetered 0% row would otherwise win', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-pick-meter-'));
    const meteredDir = path.join(tmp, 'metered');
    const unmeteredDir = path.join(tmp, 'unmetered');
    fs.mkdirSync(meteredDir, { recursive: true });
    fs.mkdirSync(unmeteredDir, { recursive: true });

    const policyFile = path.join(tmp, 'policy.json');
    fs.writeFileSync(
      policyFile,
      JSON.stringify({
        mode: 'cli',
        strategy: 'lowestUsage',
        thresholds: { session: 90, weekly: 90, fable: 90 },
        triggers: { session: true, weekly: true, fable: false },
        workspaceRoutes: [],
        accounts: [
          {
            email: 'unmetered@example.com',
            dir: unmeteredDir,
            sessionPercent: 0,
            weeklyPercent: 0,
            fablePercent: null,
            fetchedAt: 0,
          },
          {
            email: 'metered@example.com',
            dir: meteredDir,
            sessionPercent: 40,
            weeklyPercent: 30,
            fablePercent: null,
            fetchedAt: Date.now(),
          },
        ],
      })
    );

    const stdout = execFileSync(process.execPath, [pick, policyFile, tmp], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: '' },
      encoding: 'utf8',
    });

    assert.equal(stdout.trim(), meteredDir, `expected metered dir, got: ${JSON.stringify(stdout)}`);

    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
});
