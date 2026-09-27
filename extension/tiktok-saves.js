// Polls the logged-in user's TikTok Favourites and enqueues new videos in
// ChromeScribe (/api/queue). The first successful run only records what is
// already saved, so old favourites are never imported.
importScripts('config.js'); // gitignored: self.CS_ACCESS = { id, secret }

const SEC_UID = 'MS4wLjABAAAAO8vjkqSS1JkvuHoW-QqfEGHehWGnNUw7e__oQOp6csS2ko6HkiSgZOLvWDR6GPph';
const QUEUE_URL = 'https://chromescribe-dashboard.ancient-glitter-9ac9.workers.dev/api/queue';
const FAVS_URL = 'https://www.tiktok.com/api/user/collect/item_list/?aid=1988&count=30&cursor=0&secUid=' + SEC_UID;
const MAX_SEEN = 1000;

function ensureAlarm() {
  chrome.alarms.get('check', (a) => { if (!a) chrome.alarms.create('check', { periodInMinutes: 15, delayInMinutes: 0.1 }); });
}
chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'check') check(); });

async function setStatus(status) {
  await chrome.storage.local.set({ status: { ...status, at: new Date().toISOString() } });
  console.log('[tiktok-saves]', status);
}

async function check() {
  let items;
  try {
    const res = await fetch(FAVS_URL, { credentials: 'include' });
    const body = await res.json();
    if (!Array.isArray(body.itemList) || body.itemList.length === 0) {
      return setStatus({ ok: false, error: 'No favourites returned (logged out of TikTok?) HTTP ' + res.status });
    }
    items = body.itemList;
  } catch (e) {
    return setStatus({ ok: false, error: 'TikTok fetch failed: ' + e.message });
  }

  const { seen } = await chrome.storage.local.get('seen');
  if (!Array.isArray(seen)) {
    await chrome.storage.local.set({ seen: items.map((i) => i.id) });
    return setStatus({ ok: true, seeded: items.length });
  }

  const known = new Set(seen);
  const fresh = items.filter((i) => !known.has(i.id));
  const queued = [];
  const failed = [];
  // Oldest first so the dashboard order matches save order.
  for (const item of fresh.reverse()) {
    if (item.imagePost) { known.add(item.id); continue; } // photo slideshows have no audio to transcribe
    const url = 'https://www.tiktok.com/@' + item.author.uniqueId + '/video/' + item.id;
    try {
      const res = await fetch(QUEUE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CF-Access-Client-Id': self.CS_ACCESS.id,
          'CF-Access-Client-Secret': self.CS_ACCESS.secret,
        },
        body: JSON.stringify({ url }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) throw new Error(body.error || 'HTTP ' + res.status);
      known.add(item.id);
      queued.push(url);
    } catch (e) {
      failed.push(url + ': ' + e.message); // not marked seen, retried next run
    }
  }
  await chrome.storage.local.set({ seen: [...known].slice(-MAX_SEEN) });
  return setStatus({ ok: failed.length === 0, queued, failed });
}
