const CHROMESCRIBE_ROW_ID = "chromescribe-btn-row";
let chromescribeInjectTimer = null;

function isWatchPage() {
  return location.pathname === "/watch";
}

function isChannelPage() {
  return /^\/(@|channel\/|c\/|user\/)/.test(location.pathname);
}

function shouldShowButtons() {
  return isWatchPage() || isChannelPage();
}

function showToast(message) {
  const toast = document.createElement("div");
  toast.textContent = message;
  toast.style.position = "fixed";
  toast.style.top = "16px";
  toast.style.right = "16px";
  toast.style.zIndex = "2147483647";
  toast.style.background = "rgba(15, 15, 15, 0.95)";
  toast.style.color = "#fff";
  toast.style.padding = "10px 14px";
  toast.style.borderRadius = "8px";
  toast.style.fontSize = "13px";
  toast.style.fontFamily = "Arial, sans-serif";
  toast.style.boxShadow = "0 6px 24px rgba(0, 0, 0, 0.35)";
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

function makeButton(label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", onClick);
  button.style.background = "rgba(255, 255, 255, 0.12)";
  button.style.color = "#fff";
  button.style.border = "1px solid rgba(255, 255, 255, 0.18)";
  button.style.borderRadius = "18px";
  button.style.padding = "6px 12px";
  button.style.marginRight = "8px";
  button.style.fontSize = "13px";
  button.style.fontWeight = "500";
  button.style.cursor = "pointer";
  button.style.fontFamily = "Arial, sans-serif";
  return button;
}

function findInsertionAnchor() {
  return document.querySelector("ytd-watch-metadata #actions") ||
    document.querySelector("#top-level-buttons-computed") ||
    document.querySelector("#owner");
}

function firstHref(selector) {
  return document.querySelector(selector)?.getAttribute("href") || "";
}

function getChannelInfo() {
  const candidates = [
    firstHref('span[itemprop="author"] link[itemprop="url"]'),
    firstHref('link[rel="canonical"]'),
  ];

  document.querySelectorAll('ytd-video-owner-renderer a[href*="/channel/UC"]').forEach((a) => {
    candidates.push(a.getAttribute("href") || "");
  });
  document.querySelectorAll('a[href*="/channel/UC"]').forEach((a) => {
    candidates.push(a.getAttribute("href") || "");
  });

  let channelId = "";
  for (const href of candidates) {
    const match = href.match(/UC[A-Za-z0-9_-]{22}/);
    if (match) {
      channelId = match[0];
      break;
    }
  }

  const handleHref = firstHref('a[href^="/@"]');
  const handle = handleHref ? handleHref.split("/").find((part) => part.startsWith("@")) || "" : "";
  const channelName = (
    document.querySelector("ytd-video-owner-renderer ytd-channel-name a") ||
    document.querySelector("#channel-name a")
  )?.textContent?.trim() || "";

  return { channelId, handle, channelName };
}

function createButtonRow() {
  const row = document.createElement("div");
  row.id = CHROMESCRIBE_ROW_ID;
  row.style.display = "flex";
  row.style.alignItems = "center";
  row.style.margin = "8px 0";

  if (isWatchPage()) {
    row.appendChild(makeButton("📝 Transcribe", () => {
      chrome.runtime.sendMessage({
        action: "process",
        tab: { url: location.href, title: document.title },
      });
      showToast("Sent to ChromeScribe");
    }));
  }

  row.appendChild(makeButton("➕ Watch channel", () => {
    const { channelId, handle, channelName } = getChannelInfo();
    if (!channelId) {
      showToast("ChromeScribe: couldn't find channel id on this page");
      return;
    }

    chrome.runtime.sendMessage({ action: "addChannel", channelId, handle, channelName });
    showToast(`Watching ${handle || channelId}`);
  }));

  return row;
}

function inject() {
  if (!shouldShowButtons() || document.getElementById(CHROMESCRIBE_ROW_ID)) return;
  if (chromescribeInjectTimer) clearInterval(chromescribeInjectTimer);

  let attempts = 0;
  chromescribeInjectTimer = setInterval(() => {
    if (document.getElementById(CHROMESCRIBE_ROW_ID)) {
      clearInterval(chromescribeInjectTimer);
      chromescribeInjectTimer = null;
      return;
    }

    const anchor = findInsertionAnchor();
    if (anchor) {
      anchor.insertAdjacentElement("afterend", createButtonRow());
      clearInterval(chromescribeInjectTimer);
      chromescribeInjectTimer = null;
      return;
    }

    attempts += 1;
    if (attempts >= 34) {
      clearInterval(chromescribeInjectTimer);
      chromescribeInjectTimer = null;
    }
  }, 300);
}

inject();
window.addEventListener("yt-navigate-finish", inject);
