import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const realPython = spawnSync('sh', ['-c', 'command -v python3'], {encoding:'utf8'}).stdout.trim();
function run({required = '1', exists = false, analysis = false, fallback = false, url = 'https://example.com/article'} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'process-test-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    copyFileSync(join(repo, 'process.sh'), join(dir, 'process.sh'));
    copyFileSync(join(repo, 'fxtwitter_article.py'), join(dir, 'fxtwitter_article.py'));
    writeFileSync(join(dir, 'upload_article.py'), `print(${JSON.stringify(JSON.stringify({data:{id:7,already_exists:exists}}))})\n`);
    writeFileSync(join(bin, 'curl'), `#!/bin/bash
if [[ "$*" == *r.jina.ai* ]]; then
  printf '# Example\\n\\n'; printf '%0250d' 0
else
  touch '${dir}/analyzed'
  printf '%s' '${JSON.stringify({data:{summarized:analysis,classified:analysis}})}'
fi
`, {mode:0o755});
    writeFileSync(join(bin, 'cmd.exe'), `#!/bin/bash\ntouch '${dir}/opened'\n`, {mode:0o755});
    if (fallback) {
      writeFileSync(join(bin, 'python3'), '#!/bin/bash\nexit 1\n', {mode:0o755});
      writeFileSync(join(bin, 'python'), `#!/bin/bash\nexec '${realPython}' "$@"\n`, {mode:0o755});
    }
    const result = spawnSync('bash', [join(dir,'process.sh'), url], {
      encoding:'utf8', env:{...process.env, PATH:`${bin}:${process.env.PATH}`, CHROMESCRIBE_NO_OPEN:'1', REQUIRE_ANALYZE:required}
    });
    assert.equal(existsSync(join(dir,'opened')), false, result.stdout);
    return {...result, analyzed:existsSync(join(dir,'analyzed'))};
  } finally { rmSync(dir, {recursive:true,force:true}); }
}

test('required analysis failure fails processing; extension default remains best effort', () => {
  assert.equal(run().status, 1);
  assert.equal(run({required:''}).status, 0);
  assert.equal(run({analysis:true}).status, 0);
});
test('existing content completes without analysis and Python Store stub falls back', () => {
  const result = run({exists:true, fallback:true});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.analyzed, false);
});

test('article URL mentioning YouTube remains in article flow', () => {
  const result = run({analysis:true, url:'https://example.com/?link=youtube.com'});
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.analyzed, true);
});
