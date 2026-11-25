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

const stepBody = (text, name) => {
  const steps = text.split(/^ {6}- /m).slice(1);
  const match = steps.find(step => ((step.match(/^name: *(.+?) *$/m) || [])[1] || '').trim() === name);
  return match || null;
};

test('map upkeep merges its own pull request on a PASS verdict', () => {
  const text = fs.readFileSync(path.join(dir, 'map-maintenance.yml'), 'utf8');
  const merge = stepBody(text, 'Merge the pull request on a PASS verdict');
  assert.ok(merge, 'map-maintenance.yml: add a step that merges the upkeep pull request, because nothing else merges it: the repository has auto-merge off and no other workflow calls the merge API');
  assert.match(merge, /pstack-verifier/, 'map-maintenance.yml: the merge step reads the pstack-verifier verdict that verify.yml posts on the head commit');
  assert.match(merge, /pulls\/\$pr\/merge/, 'map-maintenance.yml: merge the upkeep pull request through the merge API once the verdict is PASS');
  assert.match(merge, /merge_method=squash/, 'map-maintenance.yml: merge the upkeep pull request with squash');
  assert.match(merge, /success/, 'map-maintenance.yml: only a PASS or PASS+NOTES verdict, which verify.yml posts as the success state, may merge');
});

test('map upkeep updates the open map pull request instead of stacking a new one each day', () => {
  const text = fs.readFileSync(path.join(dir, 'map-maintenance.yml'), 'utf8');
  const open = stepBody(text, 'Open or update one pull request of corrections');
  assert.ok(open, 'map-maintenance.yml: keep the step that opens the upkeep pull request');
  assert.match(open, /gh pr list[^\n]*--state open/, 'map-maintenance.yml: look for an open map pull request first, so yesterday\'s PR is updated instead of a second one opened beside it');
  assert.match(open, /map-upkeep-/, 'map-maintenance.yml: recognise the map pull request by its branch prefix');
  assert.match(open, /gh pr edit/, 'map-maintenance.yml: refresh the open map pull request title and body with today\'s pass');
});

test('pull request groups are keyed by the pull request number', () => {
  for (const name of files) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    if (!/^  pull_request:/m.test(text)) continue;
    assert.match(text, /group: .*github\.event\.pull_request\.number/, `${name}: key the group by github.event.pull_request.number so one PR cancels only its own older runs`);
  }
});
