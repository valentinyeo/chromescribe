const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.join(__dirname, '..', 'monitor.sh');
const token = 'shape-only-not-a-token';

function settings() {
  const lines = fs.readFileSync(script, 'utf8').split('\n');
  return lines.filter(line => /^(TG_TOKEN=|TG_CHAT=|\[ )/.test(line)).join('\n') + '\n';
}

function telegramState(env) {
  const result = spawnSync('bash', ['-c', 'eval "$1"; if [ -n "${TG_TOKEN:-}" ]; then echo on; else echo off; fi', 'bash', settings()], {
    encoding: 'utf8',
    env: { ...process.env, TELEGRAM_TINYDICTATION_BOT_TOKEN: token, CHROMESCRIBE_TELEGRAM: '', ...env },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('monitor.sh keeps Telegram posts off when the setting is absent', () => {
  assert.equal(telegramState({}), 'off');
});

test('monitor.sh sends again when CHROMESCRIBE_TELEGRAM is 1', () => {
  assert.equal(telegramState({ CHROMESCRIBE_TELEGRAM: '1' }), 'on');
});
