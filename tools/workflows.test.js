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

test('network setup steps time out before the 20 minute verdict promise', () => {
  const name = 'verify.yml';
  const text = fs.readFileSync(path.join(dir, name), 'utf8');
  const steps = text.split(/^ {6}- /m).slice(1);
  const stepName = step => (step.match(/^name: *(.+?) *$/m) || [])[1] || step.split('\n')[0].trim();
  const stepTimeout = step => {
    const match = step.match(/^ {8}timeout-minutes: *(\d+) *$/m);
    return match ? Number(match[1]) : null;
  };
  const network = /\bnpm (?:install|i|ci)\b|\bnpx |\bapt-get\b|\bcurl /;
  const verifier = steps.findIndex(step => stepName(step) === 'Independent verification');
  assert.ok(verifier > 0, `${name}: keep the "Independent verification" step`);
  const downloads = steps.slice(0, verifier).filter(step => network.test(step));
  assert.ok(downloads.length >= 2, `${name}: the download and install steps stay visible to this test`);
  let setup = 0;
  for (const step of downloads) {
    const minutes = stepTimeout(step);
    assert.ok(minutes, `${name}: give "${stepName(step)}" a timeout-minutes, because a step timeout fails the step and still runs the post step, while a job timeout cancels it`);
    setup += minutes;
  }
  const post = steps.find(step => stepName(step) === 'Post the verdict');
  assert.ok(post, `${name}: keep the "Post the verdict" step`);
  const posting = stepTimeout(post);
  assert.ok(posting, `${name}: give "Post the verdict" a timeout-minutes`);
  assert.ok(setup + 15 + posting <= 20, `${name}: setup may hang for ${setup} minutes, plus the 15 minute verifier budget plus ${posting} to post, over the 20 minute promise`);
});

test('pull request groups are keyed by the pull request number', () => {
  for (const name of files) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    if (!/^  pull_request:/m.test(text)) continue;
    assert.match(text, /group: .*github\.event\.pull_request\.number/, `${name}: key the group by github.event.pull_request.number so one PR cancels only its own older runs`);
  }
});
