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

function sender() {
  const text = fs.readFileSync(script, 'utf8');
  const start = text.indexOf('send_telegram() {');
  const end = text.indexOf('\n}\n', start);
  return text.slice(start, end + 3);
}

test('monitor.sh reports no Telegram send when the posts are off', () => {
  const result = spawnSync('bash', ['-c', 'TG_TOKEN=""; TG_CHAT="0"; eval "$1"; send_telegram test; echo "exit=$?"', 'bash', sender()], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'exit=1');
});
