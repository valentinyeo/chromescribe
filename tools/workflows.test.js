const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.resolve(__dirname, '../.github/workflows');
const files = fs.readdirSync(dir).filter(name => name.endsWith('.yml'));

test('every workflow cancels its superseded runs', () => {
  assert.ok(files.length > 0);
  for (const name of files) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    assert.match(text, /^concurrency:\n  group: \S.*\n  cancel-in-progress: true$/m, `${name}: add a top-level concurrency group with cancel-in-progress: true`);
  }
});

test('pull request groups are keyed by the pull request number', () => {
  for (const name of files) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    if (!/^  pull_request:/m.test(text)) continue;
    assert.match(text, /group: .*github\.event\.pull_request\.number/, `${name}: key the group by github.event.pull_request.number so one PR cancels only its own older runs`);
  }
});
