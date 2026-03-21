const PROJECT_DIR = "C:/Users/valen/Documents/GitHub/chromescribe";
const TERMINAL_BASE = "http://localhost:7681/";

function isValidUrl(url) {
  return url && (url.startsWith("http://") || url.startsWith("https://"));
}

function openInTerminal(tabUrl) {
  if (!isValidUrl(tabUrl)) return;

  const params = new URLSearchParams({
    cwd: PROJECT_DIR,
    cmd: `claude "process: ${tabUrl}"`,
    title: "ChromeScribe"
  });

  chrome.tabs.create({ url: `${TERMINAL_BASE}?${params.toString()}` });
}

// Toolbar icon click
chrome.action.onClicked.addListener((tab) => {
  openInTerminal(tab.url);
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
    openInTerminal(url);
  }
});
