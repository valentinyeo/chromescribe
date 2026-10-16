import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tokenize, languageFor } from '../../tools/strip-comments.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const found = (file, source) => tokenize(source, languageFor(file, source)).comments.filter(c => !c.reason).length;

test('repo has no code comments', () => {
  assert.match(execFileSync('node', ['tools/strip-comments.mjs', '--check', '.'], { cwd: root, encoding: 'utf8' }), /No code comments found/);
});

test('comments added in 2bbefa8 are caught', () => {
  assert.equal(found('dashboard/src/index.ts', "    // GET /api/queue/all - dashboard history, separate from the drainer feed\n    if (path === '/api/queue/all') {}\n"), 1);
  assert.equal(found('dashboard/src/queue-lib.mjs', '  // Conditional writes prevent two drainers claiming a row or racing a retry.\nconst a = 1;\n'), 1);
  assert.equal(found('queue.sh', '#!/bin/bash\n# Only one drainer at a time - a transcription run takes minutes, cron fires every minute.\nexec 9>/tmp/lock\n'), 1);
  assert.equal(found('dashboard/public/index.html', '<div><!-- note --></div><script>let activeChannel = null; // canonical channel name or null\n</script>'), 2);
});

test('directives, shebangs, URLs and regexes are not comments', () => {
  assert.equal(found('queue.sh', '#!/bin/bash\n# shellcheck disable=SC1090\nsource "$f"\ncurl "https://r.jina.ai/$u#x"\n'), 0);
  assert.equal(found('dashboard/src/index.ts', "const u = 'https://youtube.com/watch';\nconst r = /https?:\\/\\//;\nconst t = `//${u}`;\n"), 0);
});
