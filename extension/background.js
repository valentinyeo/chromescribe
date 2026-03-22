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

function openInTerminal(tabUrl, pageTitle) {
  if (!isValidUrl(tabUrl)) return;

  const title = (pageTitle && `CS: ${pageTitle}`) || deriveTitle(tabUrl);

  const params = new URLSearchParams({
    cwd: PROJECT_DIR,
    cmd: `cd /d "${PROJECT_DIR}" && claude --dangerously-skip-permissions --model haiku --system-prompt-file system-prompt.txt --tools "Bash,Read,Write,Glob,WebFetch" --disable-slash-commands --setting-sources "" "process: ${tabUrl}"`,
    title
  });

  chrome.tabs.create({ url: `${TERMINAL_BASE}?${params.toString()}` });
}

// Toolbar icon click — tab.title has the page title
chrome.action.onClicked.addListener((tab) => {
  openInTerminal(tab.url, cleanPageTitle(tab.title));
});

// Context menu
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "send-to-claude",
    title: "Send to Claude",
    contexts: ["page", "link"]
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "send-to-claude") {
    const url = info.linkUrl || info.pageUrl || tab.url;
    // Use page title if processing the current page, otherwise fall back to URL-based
    const pageTitle = !info.linkUrl ? cleanPageTitle(tab.title) : null;
    openInTerminal(url, pageTitle);
  }
});
