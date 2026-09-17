const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');

/**
 * The cutover freshness horizons are four numbers that only make sense in
 * relation to each other and to the poll's own clocks. Each has a failure mode
 * that is silent — auto-cutover simply stops happening, or happens on data too
 * old to mean anything — so what is pinned here is the RELATIONSHIPS, not the
 * literals. Change a literal freely; break a relationship and this fails.
 *
 * cutover.ts → log.ts imports vscode, so bundle with the same minimal stub the
 * other unit suites use.
 */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `cutover-horizons-${process.pid}-`));
const vscodeStub = path.join(tmpRoot, 'vscode-stub.js');
fs.writeFileSync(
  vscodeStub,
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
const bundleOut = path.join(tmpRoot, 'cutover.bundle.cjs');
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/cutover.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundleOut,
  alias: { vscode: vscodeStub },
});
const {
  CUTOVER_CURRENT_MAX_AGE_MS,
  CUTOVER_PICK_MAX_AGE_MS,
  CUTOVER_REVALIDATE_FRESH_MS,
  CUTOVER_AUTHORIZE_MAX_AGE_MS,
} = require(bundleOut);

const usageBundle = path.join(tmpRoot, 'usage.bundle.cjs');
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/usage.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: usageBundle,
  alias: { vscode: vscodeStub },
});
const { USAGE_CACHE_TTL_MS, BACKGROUND_TTL_MS, MAX_BACKOFF_MS } = require(usageBundle);

/** Worst case the poll can take to re-arm: interval + the 0-50% jitter on it. */
const MAX_POLL_GAP_MS = 60_000 * 1.5;

describe('cutover freshness horizons', () => {
  it('authorization is never tighter than the fetch it authorizes', () => {
    // Raise the fetch freshness alone and every cache-served snapshot between the
    // two passes the fetch and fails the authorization: auto-cutover stops, and
    // the log line reads exactly like a target that is legitimately no longer cool.
    assert.ok(
      CUTOVER_AUTHORIZE_MAX_AGE_MS >= CUTOVER_REVALIDATE_FRESH_MS,
      `authorize ${CUTOVER_AUTHORIZE_MAX_AGE_MS} must be >= revalidate ${CUTOVER_REVALIDATE_FRESH_MS}`
    );
  });

  it('the active account horizon covers its own worst-case entry age', () => {
    // Nothing re-validates this read, so it wants to be tight — but under the
    // worst case it silently switches evaluation off for the account most likely
    // to be hot: the poll re-arms up to MAX_POLL_GAP_MS late, the entry is only
    // refetchable past the TTL, and a 429 there holds the retry for MAX_BACKOFF_MS.
    const worstCase = MAX_POLL_GAP_MS + USAGE_CACHE_TTL_MS + MAX_BACKOFF_MS;
    assert.ok(
      CUTOVER_CURRENT_MAX_AGE_MS >= worstCase,
      `current ${CUTOVER_CURRENT_MAX_AGE_MS} must cover ${worstCase}`
    );
  });

  it('the candidate horizon exceeds the background tier it draws from', () => {
    // Background entries are only refetched PAST the tier, on a poll that can be
    // skipped, so their real ages run past it. A horizon at or under the tier
    // leaves discovery with no candidates at all.
    assert.ok(
      CUTOVER_PICK_MAX_AGE_MS > BACKGROUND_TTL_MS + MAX_POLL_GAP_MS,
      `pick ${CUTOVER_PICK_MAX_AGE_MS} must exceed ${BACKGROUND_TTL_MS + MAX_POLL_GAP_MS}`
    );
  });

  it('a candidate may be staler than the active account, never the reverse', () => {
    // The candidate read is re-validated live; the active read is not.
    assert.ok(CUTOVER_PICK_MAX_AGE_MS > CUTOVER_CURRENT_MAX_AGE_MS);
  });
});
