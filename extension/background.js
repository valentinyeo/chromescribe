importScripts('tiktok-saves.js');
const PROJECT_DIR = "C:/Users/valen/Documents/GitHub/chromescribe";
const TERMINAL_BASE = "http://localhost:7681/";
const DASHBOARD_BASE = "https://chromescribe-dashboard.ancient-glitter-9ac9.workers.dev";
const LIBRARY_CACHE_MS = 5 * 60 * 1000;
const DEFAULT_WATCHED_CHANNELS = [
  { id: "UC_mYaQAE6-71rjSN6CeCA-g", handle: "@NeetCode" },
  { id: "UC0m81bQuthaQZmFbXEY9QSw", handle: "@AICodeKing" },
  { id: "UC2ojq-nuP8ceeHqiroeKhBA", handle: "@nateherk" },
  { id: "UC2WmuBuFq6gL08QYG-JjXKw", handle: "@intheworldofai" },
  { id: "UC3w193M5tYPJqF0Hi-7U-2g", handle: "@Drberg" },
  { id: "UC6t1O76G0jYXOAoYCm153dA", handle: "@LennysPodcast" },
  { id: "UCAohrrjG-3gEp5QF1WlM9_w", handle: "@SiimLand" },
  { id: "UCAwT-7B6StW_xzXPku6v7MQ", handle: "@atmoio" },
  { id: "UCbDmEdLs-SB3FjrDFQJ4TDg", handle: "@reysu" },
  { id: "UCbRP3c757lWg9M-U7TyEkXA", handle: "@t3dotgg" },
  { id: "UCctL30i8tVgSS9A37Q532eg", handle: "@Incomestreamsurfers" },
  { id: "UCLKPca3kwwd-B59HNr-_lvA", handle: "@aiDotEngineer" },
  { id: "UCmL7cQmNgV-3FxaB3Ueoixg", handle: "@claudelog" },
  { id: "UCNJ1Ymd5yFuUPtn21xtRbbw", handle: "@aiexplained-official" },
  { id: "UCNleq2p_chOqORPKQkMurOQ", handle: "@thejimmyreilly" },
  { id: "UCoy6cTJ7Tg0dqS-DI-_REsA", handle: "@Chase-H-AI" },
  { id: "UCPjNBjflYl0-HQtUvOx0Ibw", handle: "@GregIsenberg" },
  { id: "UCrXSVX9a1mj8l0CMLwKgMVw", handle: "@AIJasonZ" },
  { id: "UCsBjURrPoezykLs9EqgamOA", handle: "@Fireship" },
  { id: "UCswG6FSbgZjbWtdf_hMLaow", handle: "@mattpocockuk" },
  { id: "UCUyeluBRhGPCW4rPe_UvBZQ", handle: "@ThePrimeTimeagen" },
  { id: "UCxSRl6Qr7PxxArDzqm14IQQ", handle: "@atmoio" },
  { id: "UC_x36zCEGilGpB1m-V4gmjg", handle: "@indydevdan", name: "IndyDevDan" },
  { id: "UCkVfrGwV-iG9bSsgCbrNPxQ", handle: "@betterstack", name: "Better Stack" },
];
let libraryStatusCache = null;
let libraryStatusCachedAt = 0;
let libraryStatusRequest = null;

function isValidUrl(url) {
  return url && (url.startsWith("http://") || url.startsWith("https://"));
}

function deriveTitle(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtube.com") || u.hostname === "youtu.be") {
      const id = u.searchParams.get("v") || u.pathname.split("/").pop();
      return `CS: youtube/${id}`;
    }
    if (u.hostname.includes("tiktok.com")) {
      return `CS: tiktok${u.pathname.slice(0, 30)}`;
    }
    return `CS: ${u.hostname.replace("www.", "")}`;
  } catch {
    return "ChromeScribe";
  }
}

function cleanPageTitle(title) {
  if (!title) return null;
  return title.replace(/\s*[-|]\s*YouTube\s*$/i, "").trim() || null;
}

function buildCmd(tabUrl) {
  return `cd /d "${PROJECT_DIR}" && .\\process.bat "${tabUrl}"`;
}

function openTerminal(cmd, title) {
  const params = new URLSearchParams({
    cwd: PROJECT_DIR,
    cmd,
    title
  });

  chrome.tabs.create({ url: `${TERMINAL_BASE}?${params.toString()}` });
}

function openInTerminal(tabUrl, pageTitle) {
  if (!isValidUrl(tabUrl)) return;

  const title = (pageTitle && `CS: ${pageTitle}`) || deriveTitle(tabUrl);
  openTerminal(buildCmd(tabUrl), title);
}

function sourceVideoId(sourceUrl) {
  try {
    const url = new URL(sourceUrl);
    if (url.hostname === "youtu.be") return url.pathname.split("/").filter(Boolean)[0] || "";
    if (url.hostname.endsWith("youtube.com")) {
      return url.searchParams.get("v") || url.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{11})/)?.[1] || "";
    }
    if (url.hostname.endsWith("tiktok.com")) {
      const id = url.pathname.match(/\/video\/(\d+)/)?.[1];
      return id ? `tiktok:${id}` : "";
    }
  } catch {}
  return "";
}

function transcriptViewUrl(transcript) {
  return transcript.view_url || `${DASHBOARD_BASE}/transcript.html?id=${encodeURIComponent(transcript.id)}`;
}

function openTranscript(transcript) {
  if (!transcript?.id) return false;
  chrome.tabs.create({ url: transcriptViewUrl(transcript) });
  return true;
}

async function fetchDashboardList(path) {
  const response = await fetch(`${DASHBOARD_BASE}${path}`, { credentials: "include" });
  if (!response.ok) throw new Error(`ChromeScribe API returned ${response.status}`);
  const payload = await response.json();
  return Array.isArray(payload?.data) ? payload.data : [];
}

async function getLibraryStatus(forceRefresh = false) {
  if (!forceRefresh && libraryStatusCache && Date.now() - libraryStatusCachedAt < LIBRARY_CACHE_MS) {
    return libraryStatusCache;
  }
  if (libraryStatusRequest) return libraryStatusRequest;

  libraryStatusRequest = (async () => {
    const [transcriptResult, channelResult, stored] = await Promise.all([
      fetchDashboardList("/api/transcripts").catch(() => []),
      fetchDashboardList("/api/channels").catch(() => []),
      chrome.storage.local.get({ watchedChannels: [] }),
    ]);

    const channelMap = new Map();
    for (const channel of [...DEFAULT_WATCHED_CHANNELS, ...channelResult, ...stored.watchedChannels]) {
      const key = channel.id || String(channel.handle || "").toLowerCase();
      if (key) channelMap.set(key, channel);
    }

    const transcripts = transcriptResult
      .filter((item) => item.id && item.video_id)
      .map((item) => ({
        id: item.id,
        videoId: item.video_id,
        title: item.title || "",
        viewUrl: transcriptViewUrl(item),
      }));

    libraryStatusCache = {
      videoIds: [...new Set(transcripts.map((item) => item.videoId))],
      transcripts,
      channels: [...channelMap.values()],
    };
    libraryStatusCachedAt = Date.now();
    libraryStatusRequest = null;
    return libraryStatusCache;
  })().catch((error) => {
    libraryStatusRequest = null;
    throw error;
  });

  return libraryStatusRequest;
}

async function processOrOpen(tab) {
  const url = tab?.url;
  if (!isValidUrl(url)) return { success: false, error: "Invalid URL" };

  const videoId = sourceVideoId(url);
  if (videoId) {
    try {
      const status = await getLibraryStatus(true);
      const transcript = status.transcripts.find((item) => item.videoId === videoId);
      if (transcript) {
        openTranscript({ id: transcript.id, view_url: transcript.viewUrl });
        return { success: true, alreadyExists: true, transcript };
      }
    } catch (error) {
      console.warn("Could not check ChromeScribe library before processing:", error);
    }
  }

  openInTerminal(url, cleanPageTitle(tab.title));
  return { success: true, alreadyExists: false };
}

async function rememberWatchedChannel(channel) {
  const stored = await chrome.storage.local.get({ watchedChannels: [] });
  const channels = stored.watchedChannels.filter((item) => (
    item.id !== channel.id &&
    String(item.handle || "").toLowerCase() !== String(channel.handle || "").toLowerCase()
  ));
  channels.push(channel);
  await chrome.storage.local.set({ watchedChannels: channels });
  libraryStatusCachedAt = 0;
}

chrome.action.onClicked.addListener((tab) => {
  processOrOpen(tab);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === "getLibraryStatus") {
    getLibraryStatus()
      .then((status) => sendResponse({ success: true, ...status }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (msg.action === "openTranscript" && msg.transcriptId) {
    const opened = openTranscript({ id: msg.transcriptId });
    sendResponse({ success: opened, alreadyExists: opened });
    return;
  }

  if (msg.action === "addChannel") {
    (async () => {
      const response = await fetch(`${DASHBOARD_BASE}/api/channels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ input: msg.channelId || msg.handle }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `ChromeScribe API returned ${response.status}`);
      const channel = payload.data;
      if (!channel?.id) throw new Error("ChromeScribe API returned no channel");
      await rememberWatchedChannel({
        id: channel.id,
        handle: channel.handle || msg.handle || "",
        name: channel.name || msg.channelName || "",
      });
      return {
        success: true,
        alreadyExists: Boolean(payload.already_exists || channel.already_exists),
        name: channel.name || msg.channelName || "",
      };
    })()
      .then(sendResponse)
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (msg.action === "process" && msg.tab) {
    processOrOpen(msg.tab)
      .then(sendResponse)
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "send-to-pi",
    title: "Process with ChromeScribe",
    contexts: ["page", "link"]
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const url = info.linkUrl || info.pageUrl || tab.url;
  const title = !info.linkUrl ? tab.title : null;
  processOrOpen({ url, title });
});
