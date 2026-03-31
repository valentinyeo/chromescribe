const PROJECT_DIR = "C:/Users/valen/Documents/GitHub/chromescribe";
const TERMINAL_BASE = "http://localhost:7681/";

function isValidUrl(url) {
  return url && (url.startsWith("http://") || url.startsWith("https://"));
}

function deriveTitle(url) {
  try {
    const u = new URL(url);
    // YouTube: show video ID
    if (u.hostname.includes("youtube.com") || u.hostname === "youtu.be") {
      const id = u.searchParams.get("v") || u.pathname.split("/").pop();
      return `CS: youtube/${id}`;
    }
    // TikTok: show path
    if (u.hostname.includes("tiktok.com")) {
      return `CS: tiktok${u.pathname.slice(0, 30)}`;
    }
    // Articles: show domain
    return `CS: ${u.hostname.replace("www.", "")}`;
  } catch {
    return "ChromeScribe";
  }
}

function cleanPageTitle(title) {
  if (!title) return null;
  // Strip common suffixes: " - YouTube", " | Site Name", etc.
  return title.replace(/\s*[-|]\s*YouTube\s*$/i, "").trim() || null;
}

function buildCmd(tabUrl) {
  return `cd /d "${PROJECT_DIR}" && bash process.sh "${tabUrl}"`;
}

function openInTerminal(tabUrl, pageTitle) {
  if (!isValidUrl(tabUrl)) return;

  const title = (pageTitle && `CS: ${pageTitle}`) || deriveTitle(tabUrl);
  const params = new URLSearchParams({
    cwd: PROJECT_DIR,
    cmd: buildCmd(tabUrl),
    title
  });

  chrome.tabs.create({ url: `${TERMINAL_BASE}?${params.toString()}` });
}

// Icon click — open terminal directly
chrome.action.onClicked.addListener((tab) => {
  const url = tab.url;
  const pageTitle = cleanPageTitle(tab.title);
  openInTerminal(url, pageTitle);
});

// Popup button clicks (for fallback)
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === "process" && msg.tab) {
    const url = msg.tab.url;
    const pageTitle = cleanPageTitle(msg.tab.title);
    openInTerminal(url, pageTitle);
  }
});

// Context menu
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "send-to-pi",
    title: "Process with ChromeScribe",
    contexts: ["page", "link"]
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const url = info.linkUrl || info.pageUrl || tab.url;
  const pageTitle = !info.linkUrl ? cleanPageTitle(tab.title) : null;
  openInTerminal(url, pageTitle);
});
