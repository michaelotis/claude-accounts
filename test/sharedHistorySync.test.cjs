const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

/**
 * SHARED_DIRS / SHARED_FILES are hand-synced between sharedHistory.ts and uninstall.js.
 * Parse both arrays textually so drift fails the suite.
 */
function parseStringArray(src, name) {
  const re = new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\];`, 'm');
  const m = re.exec(src);
  if (!m) throw new Error(`could not find ${name} array`);
  const body = m[1];
  const items = [];
  const itemRe = /['"]([^'"]+)['"]/g;
  let im;
  while ((im = itemRe.exec(body)) !== null) {
    items.push(im[1]);
  }
  return items;
}

describe('shared history name lists stay in sync (D1)', () => {
  const root = path.join(__dirname, '..');
  const tsSrc = fs.readFileSync(path.join(root, 'src/sharedHistory.ts'), 'utf8');
  const uninstallSrc = fs.readFileSync(path.join(root, 'uninstall.js'), 'utf8');

  it('SHARED_DIRS match', () => {
    assert.deepEqual(
      parseStringArray(tsSrc, 'SHARED_DIRS'),
      parseStringArray(uninstallSrc, 'SHARED_DIRS')
    );
  });

  it('SHARED_FILES match', () => {
    assert.deepEqual(
      parseStringArray(tsSrc, 'SHARED_FILES'),
      parseStringArray(uninstallSrc, 'SHARED_FILES')
    );
  });
});
