const CHROMESCRIBE_ROW_ID = "chromescribe-btn-row";
const CHROMESCRIBE_CARD_ACTIONS = "chromescribe-card-actions";
const CHROMESCRIBE_CARD_SELECTOR = [
  "ytd-rich-item-renderer",
  "ytd-grid-video-renderer",
  "ytd-video-renderer",
  "ytd-compact-video-renderer",
  "yt-lockup-view-model",
].join(",");
let chromescribeInjectTimer = null;
let chromescribeCardScanQueued = false;
const chromescribeChannelIdCache = new Map();
const chromescribeLibrary = {
  videoIds: new Set(),
  transcriptsByVideoId: new Map(),
  channelIds: new Set(),
  handles: new Set(),
  pendingVideoIds: new Set(),
};

function isWatchPage() {
  return location.pathname === "/watch";
}

function isChannelPage() {
  return /^\/(@|channel\/|c\/|user\/)/.test(location.pathname);
}

function shouldShowButtons() {
  return isWatchPage() || isChannelPage();
}

function shouldShowCardActions() {
  return location.pathname === "/" || isWatchPage();
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

function ensureCardStyles() {
  if (document.getElementById("chromescribe-card-styles")) return;

  const style = document.createElement("style");
  style.id = "chromescribe-card-styles";
  style.textContent = `
    .${CHROMESCRIBE_CARD_ACTIONS} {
      display: flex;
      position: absolute;
      right: 28px;
      bottom: 0;
      z-index: 20;
      gap: 2px;
      align-items: center;
      padding: 1px 2px;
      background: var(--yt-spec-base-background, #0f0f0f);
      border-radius: 16px;
    }

    .chromescribe-card-host {
      position: relative !important;
    }

    .chromescribe-card-button {
      display: inline-flex;
      width: 28px;
      height: 28px;
      padding: 0;
      align-items: center;
      justify-content: center;
      color: var(--yt-spec-text-secondary, #aaa);
      background: transparent;
      border: 0;
      border-radius: 50%;
      cursor: pointer;
    }

    .chromescribe-card-button:hover,
    .chromescribe-card-button:focus-visible {
      color: var(--yt-spec-text-primary, #fff);
      background: var(--yt-spec-10-percent-layer, rgba(255, 255, 255, 0.1));
      outline: none;
    }

    .chromescribe-card-button:disabled {
      cursor: wait;
      opacity: 0.45;
    }

    .chromescribe-card-button.is-complete {
      color: #34d058;
      background: rgba(52, 208, 88, 0.16);
    }

    .chromescribe-card-button.is-pending {
      color: #f2b84b;
      background: rgba(242, 184, 75, 0.16);
    }

    .chromescribe-card-button svg {
      width: 19px;
      height: 19px;
      fill: none;
      stroke: currentColor;
      stroke-linecap: round;
      stroke-linejoin: round;
      stroke-width: 1.8;
      pointer-events: none;
    }
  `;
  document.head.appendChild(style);
}

function makeIconButton(label, svgMarkup, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "chromescribe-card-button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.innerHTML = svgMarkup;

  // YouTube makes the whole card clickable, so keep these actions from
  // activating the underlying video link.
  for (const eventName of ["pointerdown", "mousedown"]) {
    button.addEventListener(eventName, (event) => event.stopPropagation());
  }
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick(button);
  });
  return button;
}

const TRANSCRIBE_ICON = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M6.5 3.5h8l3 3v14h-11z" />
    <path d="M14.5 3.5v3h3M9 11h6M9 14.5h6M9 18h4" />
  </svg>`;

const WATCH_CHANNEL_ICON = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 19.5a2 2 0 0 1-4 0M5.5 17.5h9c-1-1.2-1.5-2.8-1.5-4.4V11a4 4 0 0 0-8 0v2.1c0 1.6-.5 3.2-1.5 4.4z" />
    <path d="M18.5 8v6M15.5 11h6" />
  </svg>`;

function youtubeVideoId(url) {
  try {
    const parsed = new URL(url, location.origin);
    return parsed.searchParams.get("v") || parsed.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{11})/)?.[1] || "";
  } catch {
    return "";
  }
}

function normalizeHandle(handle) {
  return String(handle || "").trim().toLowerCase();
}

function isKnownChannel(info) {
  return Boolean(
    (info.channelId && chromescribeLibrary.channelIds.has(info.channelId)) ||
    (info.handle && chromescribeLibrary.handles.has(normalizeHandle(info.handle)))
  );
}

function existingTranscript(videoId) {
  return chromescribeLibrary.transcriptsByVideoId.get(videoId) || null;
}

function openExistingTranscript(transcript) {
  chrome.runtime.sendMessage({ action: "openTranscript", transcriptId: transcript.id });
  showToast(`Opening “${transcript.title || "transcript"}” in ChromeScribe`);
}

function processVideo(video) {
  const videoId = youtubeVideoId(video.url);
  const transcript = existingTranscript(videoId);
  if (transcript) {
    openExistingTranscript(transcript);
    return;
  }
  if (chromescribeLibrary.pendingVideoIds.has(videoId)) {
    showToast("ChromeScribe: this video is already queued");
    return;
  }

  if (videoId) chromescribeLibrary.pendingVideoIds.add(videoId);
  refreshAllActionButtons();
  chrome.runtime.sendMessage({ action: "process", tab: video }, (response) => {
    if (chrome.runtime.lastError) {
      if (videoId) chromescribeLibrary.pendingVideoIds.delete(videoId);
      refreshAllActionButtons();
      showToast("ChromeScribe: could not start processing");
      return;
    }

    if (response?.alreadyExists && response.transcript) {
      if (videoId) {
        chromescribeLibrary.pendingVideoIds.delete(videoId);
        chromescribeLibrary.videoIds.add(videoId);
        chromescribeLibrary.transcriptsByVideoId.set(videoId, response.transcript);
      }
      refreshAllActionButtons();
      showToast(`Opening “${response.transcript.title || "transcript"}” in ChromeScribe`);
      return;
    }

    if (!response?.success) {
      if (videoId) chromescribeLibrary.pendingVideoIds.delete(videoId);
      refreshAllActionButtons();
      showToast(`ChromeScribe: ${response?.error || "could not start processing"}`);
    }
  });
  showToast(`Sent “${video.title || "video"}” to ChromeScribe`);
}

function configureActionButton(button, action, details = {}) {
  button.dataset.chromescribeAction = action;
  button.dataset.defaultLabel = button.textContent || button.title || "";
  if (details.videoId) button.dataset.videoId = details.videoId;
  if (details.channelId) button.dataset.channelId = details.channelId;
  if (details.handle) button.dataset.channelHandle = normalizeHandle(details.handle);
  refreshActionButton(button);
  return button;
}

function refreshActionButton(button) {
  const action = button.dataset.chromescribeAction;
  const isIcon = button.classList.contains("chromescribe-card-button");
  let complete = false;
  let pending = false;

  if (action === "transcribe") {
    const videoId = button.dataset.videoId || "";
    complete = chromescribeLibrary.videoIds.has(videoId);
    pending = !complete && chromescribeLibrary.pendingVideoIds.has(videoId);
  } else if (action === "watchChannel") {
    complete = isKnownChannel({
      channelId: button.dataset.channelId || "",
      handle: button.dataset.channelHandle || "",
    });
  }

  button.classList.toggle("is-complete", complete);
  button.classList.toggle("is-pending", pending);
  button.dataset.chromescribeStatus = complete ? "complete" : pending ? "pending" : "new";

  const completeLabel = action === "transcribe" ? "Already transcribed" : "Already watching channel";
  const pendingLabel = "Queued in ChromeScribe";
  const label = complete ? completeLabel : pending ? pendingLabel : button.dataset.defaultLabel;
  button.title = label;
  button.setAttribute("aria-label", label);

  if (!isIcon) {
    button.textContent = complete
      ? (action === "transcribe" ? "✓ Transcribed" : "✓ Watching channel")
      : pending ? "⏳ Queued" : button.dataset.defaultLabel;
    button.style.color = complete ? "#34d058" : pending ? "#f2b84b" : "#fff";
  }
}

function refreshAllActionButtons() {
  document.querySelectorAll("[data-chromescribe-action]").forEach(refreshActionButton);
}

function requestLibraryStatus() {
  chrome.runtime.sendMessage({ action: "getLibraryStatus" }, (response) => {
    if (chrome.runtime.lastError || !response?.success) return;

    chromescribeLibrary.videoIds = new Set(response.videoIds || []);
    chromescribeLibrary.transcriptsByVideoId = new Map(
      (response.transcripts || []).map((transcript) => [transcript.videoId, transcript])
    );
    chromescribeLibrary.channelIds = new Set((response.channels || []).map((channel) => channel.id).filter(Boolean));
    chromescribeLibrary.handles = new Set(
      (response.channels || []).map((channel) => normalizeHandle(channel.handle)).filter(Boolean)
    );
    refreshAllActionButtons();
  });
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
  const canonicalHref = firstHref('link[rel="canonical"]');
  const candidates = [
    firstHref('span[itemprop="author"] link[itemprop="url"]'),
    canonicalHref,
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
  const pageHandle = location.pathname.match(/^\/(\@[A-Za-z0-9._-]+)/)?.[1] || "";
  const handle = pageHandle || (handleHref ? handleHref.split("/").find((part) => part.startsWith("@")) || "" : "");
  const channelName = (
    document.querySelector("ytd-video-owner-renderer ytd-channel-name a") ||
    document.querySelector("#channel-name a") ||
    document.querySelector("yt-page-header-view-model h1, #channel-header-container h1")
  )?.textContent?.trim() || "";

  return { channelId, handle, channelName, href: canonicalHref || handleHref || location.pathname };
}

function getCardVideo(card) {
  const link = card.querySelector(
    'a#video-title-link[href*="/watch"], a#video-title[href*="/watch"], a#thumbnail[href*="/watch"], a[href*="/watch?v="], a[href^="/shorts/"]'
  );
  if (!link) return null;

  const url = new URL(link.getAttribute("href"), location.origin).href;
  const title = (
    card.querySelector("#video-title")?.textContent?.trim() ||
    card.querySelector("#video-title-link")?.textContent?.trim() ||
    card.querySelector('[class*="lockup-metadata-view-model__title"]')?.textContent?.trim() ||
    link.getAttribute("title") ||
    link.getAttribute("aria-label") ||
    "YouTube video"
  );
  return { url, title };
}

function channelIdFromRendererData(card) {
  const renderers = [card, card.querySelector("ytd-rich-grid-media"), card.querySelector("ytd-video-renderer")];
  for (const renderer of renderers) {
    const data = renderer?.data;
    if (!data) continue;

    for (const key of ["longBylineText", "shortBylineText", "ownerText"]) {
      for (const run of data[key]?.runs || []) {
        const channelId = run.navigationEndpoint?.browseEndpoint?.browseId || "";
        if (/^UC[A-Za-z0-9_-]{22}$/.test(channelId)) return channelId;
      }
    }
  }
  return "";
}

function getCardChannelInfo(card) {
  const channelLink = card.querySelector(
    'a[href^="/@"], a[href*="youtube.com/@"], a[href^="/channel/UC"], a[href*="youtube.com/channel/UC"], #channel-name a, ytd-channel-name a'
  );
  const href = channelLink?.getAttribute("href") || "";
  const directId = href.match(/\/channel\/(UC[A-Za-z0-9_-]{22})/)?.[1] || "";
  const handle = href.match(/\/(\@[A-Za-z0-9._-]+)/)?.[1] || "";
  const channelName = (
    card.querySelector("#channel-name a, ytd-channel-name a") || channelLink
  )?.textContent?.trim() || "";
  return {
    channelId: directId || channelIdFromRendererData(card),
    handle,
    channelName,
    href,
  };
}

async function resolveChannelId(info) {
  if (info.channelId) return info.channelId;
  if (!info.href) return "";

  const channelPath = new URL(info.href, location.origin).pathname;
  if (chromescribeChannelIdCache.has(channelPath)) {
    return chromescribeChannelIdCache.get(channelPath);
  }

  try {
    const response = await fetch(channelPath, { credentials: "same-origin" });
    if (!response.ok) return "";
    const html = await response.text();
    const channelId = (
      html.match(/"channelId":"(UC[A-Za-z0-9_-]{22})"/)?.[1] ||
      html.match(/"externalId":"(UC[A-Za-z0-9_-]{22})"/)?.[1] ||
      html.match(/itemprop="channelId" content="(UC[A-Za-z0-9_-]{22})"/)?.[1] ||
      ""
    );
    if (channelId) chromescribeChannelIdCache.set(channelPath, channelId);
    return channelId;
  } catch {
    return "";
  }
}

function createCardActions(card, video) {
  const actions = document.createElement("div");
  actions.className = CHROMESCRIBE_CARD_ACTIONS;

  const transcribeButton = makeIconButton("Transcribe with ChromeScribe", TRANSCRIBE_ICON, (button) => {
    const currentVideo = getCardVideo(card) || video;
    processVideo({ url: currentVideo.url, title: currentVideo.title });
  });
  configureActionButton(transcribeButton, "transcribe", { videoId: youtubeVideoId(video.url) });
  actions.appendChild(transcribeButton);

  const initialChannelInfo = getCardChannelInfo(card);
  if (initialChannelInfo.channelId || initialChannelInfo.href) {
    const channelButton = makeIconButton("Watch channel with ChromeScribe", WATCH_CHANNEL_ICON, async (button) => {
      const currentInfo = getCardChannelInfo(card);
      if (isKnownChannel(currentInfo)) {
        showToast("ChromeScribe: already watching this channel");
        return;
      }

      button.disabled = true;
      const channelId = await resolveChannelId(currentInfo);
      button.disabled = false;

      if (!channelId) {
        showToast("ChromeScribe: couldn't find this channel's id");
        return;
      }

      chrome.runtime.sendMessage({
        action: "addChannel",
        channelId,
        handle: currentInfo.handle,
        channelName: currentInfo.channelName,
      });
      chromescribeLibrary.channelIds.add(channelId);
      if (currentInfo.handle) chromescribeLibrary.handles.add(normalizeHandle(currentInfo.handle));
      refreshAllActionButtons();
      showToast(`Watching ${currentInfo.handle || currentInfo.channelName || channelId}`);
    });
    configureActionButton(channelButton, "watchChannel", initialChannelInfo);
    actions.appendChild(channelButton);
  }

  return actions;
}

function injectCardActions(root = document) {
  if (!shouldShowCardActions()) return;
  ensureCardStyles();

  const cards = [];
  if (root instanceof Element && root.matches(CHROMESCRIBE_CARD_SELECTOR)) cards.push(root);
  if (root.querySelectorAll) cards.push(...root.querySelectorAll(CHROMESCRIBE_CARD_SELECTOR));

  for (const card of cards) {
    if (card.parentElement?.closest(".chromescribe-card-host")) continue;
    if (card.querySelector(`.${CHROMESCRIBE_CARD_ACTIONS}`)) continue;
    const video = getCardVideo(card);
    if (!video) continue;

    card.classList.add("chromescribe-card-host");
    const actions = createCardActions(card, video);
    card.appendChild(actions);
  }
}

function queueCardScan() {
  if (chromescribeCardScanQueued || !shouldShowCardActions()) return;
  chromescribeCardScanQueued = true;
  requestAnimationFrame(() => {
    chromescribeCardScanQueued = false;
    injectCardActions();
  });
}

function createButtonRow() {
  const row = document.createElement("div");
  row.id = CHROMESCRIBE_ROW_ID;
  row.style.display = "flex";
  row.style.alignItems = "center";
  row.style.margin = "8px 0";

  if (isWatchPage()) {
    const transcribeButton = makeButton("📝 Transcribe", () => {
      processVideo({ url: location.href, title: document.title });
    });
    configureActionButton(transcribeButton, "transcribe", { videoId: youtubeVideoId(location.href) });
    row.appendChild(transcribeButton);
  }

  const channelInfo = getChannelInfo();
  const channelButton = makeButton("➕ Watch channel", async () => {
    const channelInfo = getChannelInfo();
    if (isKnownChannel(channelInfo)) {
      showToast("ChromeScribe: already watching this channel");
      return;
    }
    channelButton.disabled = true;
    const channelId = await resolveChannelId(channelInfo);
    channelButton.disabled = false;
    if (!channelId) {
      showToast("ChromeScribe: couldn't find channel id on this page");
      return;
    }

    const { handle, channelName } = channelInfo;
    chrome.runtime.sendMessage({ action: "addChannel", channelId, handle, channelName });
    chromescribeLibrary.channelIds.add(channelId);
    if (handle) chromescribeLibrary.handles.add(normalizeHandle(handle));
    refreshAllActionButtons();
    showToast(`Watching ${handle || channelId}`);
  });
  configureActionButton(channelButton, "watchChannel", channelInfo);
  row.appendChild(channelButton);

  return row;
}

function inject() {
  queueCardScan();
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

requestLibraryStatus();
inject();
window.addEventListener("yt-navigate-finish", () => {
  document.getElementById(CHROMESCRIBE_ROW_ID)?.remove();
  document.querySelectorAll(`.${CHROMESCRIBE_CARD_ACTIONS}`).forEach((actions) => actions.remove());
  document.querySelectorAll(".chromescribe-card-host").forEach((card) => {
    card.classList.remove("chromescribe-card-host");
  });
  inject();
  queueCardScan();
});

new MutationObserver((mutations) => {
  if (!shouldShowCardActions()) return;
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node instanceof Element) {
        queueCardScan();
        return;
      }
    }
  }
}).observe(document.documentElement, { childList: true, subtree: true });
