# ChromeScribe — Design Spec

## Overview

A minimal browser extension that sends the current page URL to Claude Code via the local web terminal (`localhost:7681`). Claude Code reads the project's `CLAUDE.md` to determine how to process the content (transcribe videos, summarize articles, etc.).

## Problem

Transcribing videos and summarizing web content with Claude Code requires: opening a terminal, navigating to the right directory, typing out the command with the URL. This is friction that discourages use. ChromeScribe reduces it to a single click.

## Dependencies

- **VPSManager** — must be running, serving local terminal on `localhost:7681`
- **Claude Code CLI** (`claude`) — must be installed and on PATH
- **`transcribe` CLI** — custom CLI command for YouTube/TikTok transcription (installed at `C:\Users\valen\Documents\GitHub\transcribe-cli`)
- **Edge or Chrome** — for loading the extension in developer mode

## Architecture

```
[Browser Extension] → opens new tab → [localhost:7681/?cmd=...] → [Web Terminal (VPSManager)] → [Claude Code session]
```

### Component 1: Browser Extension

**Type:** Manifest V3, compatible with Edge and Chrome.

**Files:**
- `manifest.json` — extension manifest, permissions for `activeTab` and `contextMenus`
- `background.js` — service worker that handles icon click and context menu
- `icons/` — extension icons (16, 48, 128px)

**Interactions:**
- **Toolbar icon click** — gets current tab URL, constructs terminal URL, opens in new tab
- **Right-click context menu** — "Send to Claude" menu item, same behavior as icon click

**No popup, no options page, no native messaging, no content scripts.**

**URL validation:** The extension MUST validate the URL before sending:
- Only allow `http://` and `https://` schemes
- Reject `about:`, `edge://`, `chrome://`, `chrome-extension://`, `file://`, `data:` URLs
- If invalid, do nothing (silent no-op)

**URL sanitization:** The terminal shell is **cmd.exe** (Windows), so `cd /d` and backslash paths are correct. To prevent shell injection from special characters in URLs, the extension must:
- Escape cmd.exe meta-characters (`&`, `|`, `>`, `<`, `^`, `%`, `"`) with `^` prefix
- Double any `%` characters (e.g., `%` → `%%`) to prevent variable expansion
- Wrap the URL in double quotes after escaping

**URL construction logic (background.js):**
```js
const projectDir = "C:\\Users\\valen\\Documents\\GitHub\\chromescribe";
const terminalBase = "http://localhost:7681/";

// Sanitize URL for cmd.exe: escape meta-characters with ^
function sanitizeForCmd(url) {
  return url.replace(/[&|><^"%]/g, '^$&').replace(/%/g, '%%');
}

const safeUrl = sanitizeForCmd(tabUrl);
const cmd = `cd /d ${projectDir} && claude "process: ${safeUrl}"`;
const url = `${terminalBase}?cmd=${encodeURIComponent(cmd)}`;
chrome.tabs.create({ url });
```

### Component 2: Project Directory

**Location:** `C:\Users\valen\Documents\GitHub\chromescribe`

**Structure:**
```
chromescribe/
├── CLAUDE.md          # Smart prompt crafted with prompt-master
├── output/            # Saved transcripts and summaries (pre-created)
├── extension/         # Browser extension source
│   ├── manifest.json
│   ├── background.js
│   └── icons/
└── docs/              # This spec
```

**CLAUDE.md prompt requirements:**

The CLAUDE.md must instruct Claude Code to:

1. **Identify content type** from the URL:
   - YouTube URLs (`youtube.com/watch`, `youtu.be/`, `youtube.com/shorts/`) → video transcription
   - TikTok URLs (`tiktok.com/`) → video transcription
   - All other `http(s)` URLs → article/page summarization

2. **Process accordingly:**
   - Video URLs: run `transcribe <url>` CLI command, then read and summarize the resulting `.srt` file
   - Article URLs: use `WebFetch` or `curl` to get page content, then summarize

3. **Output format:**
   - Display a clear summary in the terminal
   - Save to `output/YYYY-MM-DD-<slug>.md` where `<slug>` is derived from the content title
   - Include metadata: source URL, date, content type
   - Create `output/` directory if it doesn't exist (`mkdir -p output`)

4. **Error handling:**
   - If `transcribe` fails, inform the user and suggest alternatives
   - If URL is unreachable, report clearly
   - Never silently fail

The prompt will be crafted using **prompt-master** (Claude skill for optimized prompt engineering) to ensure clarity, completeness, and robustness.

## Technical Details

### Web Terminal Integration

The local web terminal at `http://localhost:7681` is served by VPSManager (Go app, running on Windows). The terminal shell is **cmd.exe**.

Supported query parameters:
- `?cmd=<command>` — auto-executes command after shell initialization (2s delay)
- `?cwd=<path>` — sets working directory (currently buggy due to ConPTY; workaround: use `cd /d` in cmd)
- `?title=<text>` — sets browser tab title

The extension uses only the `cmd` param with an inline `cd /d` for reliability.

### Permissions

The extension requires minimal permissions:
- `activeTab` — access current tab URL on click
- `contextMenus` — register right-click menu item

No `tabs`, no `host_permissions`, no `content_scripts`.

## Known Limitations (v1)

- **Terminal must be running.** If `localhost:7681` is down, the new tab shows a connection error. No health check in v1.
- **One session at a time.** Opening multiple URLs rapidly will spawn multiple terminal tabs. Each is independent. Claude Code sessions don't conflict but may be confusing.
- **2-second shell init delay.** The command is injected 2 seconds after shell startup. On very slow machines this could race, but is reliable in practice.
- **URL length.** Very long URLs with tracking parameters could approach browser URL limits (~2000 chars). Unlikely in practice for video/article URLs.

## What We're NOT Building

- No content type detection in the extension (Claude decides)
- No popup UI or settings
- No native messaging host
- No local HTTP server
- No clipboard integration
- No VPSManager modifications (using workaround for cwd bug)

## Success Criteria

1. Single click on toolbar icon opens terminal and starts Claude processing
2. Right-click → "Send to Claude" does the same
3. Extension rejects non-http(s) URLs silently
4. Claude correctly identifies and processes YouTube, TikTok, and article URLs
5. Output is displayed in terminal and saved to `output/` with descriptive filenames
6. Extension installs cleanly in Edge via `edge://extensions` developer mode
