import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChannelInput } from '../src/channels-lib.mjs';

const id = 'UC9-XlrmeMEAdIha_XBuHp1w';

test('YouTube channel IDs and URL forms', () => {
  for (const input of [id, ` https://www.youtube.com/channel/${id}/videos `,
    `https://youtube.com/channel/${id}`, `https://m.youtube.com/channel/${id}/`]) {
    assert.deepEqual(parseChannelInput(input), { platform: 'youtube', id, handle: null });
  }
  for (const input of ['@jaketrinder', 'https://www.youtube.com/@jaketrinder',
    'https://youtube.com/@jaketrinder/videos', 'https://m.youtube.com/@jaketrinder/videos/?view=0']) {
    assert.deepEqual(parseChannelInput(input), { platform: 'youtube', id: null, handle: '@jaketrinder' });
  }
  assert.equal(parseChannelInput('https://youtube.com/@caf%C3%A9/videos').handle, '@café');
});

test('TikTok profile forms normalize case and identify the platform', () => {
  for (const input of ['tiktok:@Some.User', 'https://www.tiktok.com/@Some.User',
    'https://tiktok.com/@Some.User/', 'https://m.tiktok.com/@Some.User?lang=en']) {
    assert.deepEqual(parseChannelInput(input), { platform: 'tiktok', id: 'tiktok:@some.user', handle: '@some.user' });
  }
  assert.equal(parseChannelInput('@some.user').platform, 'youtube');
});

test('rejects junk, videos, lookalike hosts, unsafe URLs, and invalid identifiers', () => {
  for (const input of [null, 123, {}, '', '  ', 'jaketrinder', '@', '@ab', '@bad handle', '@bad/handle',
    '@' + 'a'.repeat(31), 'UCshort', id + 'x', 'tiktok:handle', 'tiktok:@bad-handle',
    'tiktok:@user.', 'tiktok:@' + 'a'.repeat(25), 'javascript:alert(1)',
    'http://youtube.com/@jaketrinder', 'https://youtube.com.evil.com/@jaketrinder',
    'https://evil.com/?url=https://youtube.com/@jaketrinder', 'https://music.youtube.com/@jaketrinder',
    'https://user' + ':' + 'x@youtube.com/@jaketrinder', 'https://youtube.com:8443/@jaketrinder',
    'https://youtube.com/watch?v=abcdefghijk', 'https://youtu.be/abcdefghijk',
    `https://youtube.com/channel/${id}/shorts`, 'https://youtube.com/@jaketrinder/about',
    'https://youtube.com/@bad%2Fhandle', 'https://youtube.com/@bad%22handle',
    'https://youtube.com/ignored/../@jaketrinder', 'https://youtube.com/%2e/@jaketrinder',
    'https://youtube.com\\@jaketrinder', 'https://youtube.com/@jake\ntrinder',
    'https://tiktok.com/@user/video/123456789012345', 'https://tiktok.com.evil.com/@user',
    'https://vm.tiktok.com/abc', 'https://tiktok.com/@user/videos', 'https://tiktok.com/@%ZZ']) {
    assert.equal(parseChannelInput(input), null, JSON.stringify(input));
  }
});
