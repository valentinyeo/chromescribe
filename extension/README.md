# ChromeScribe extension

Load this directory as an unpacked extension in Chrome or Edge. After updating
the files, reload ChromeScribe on the browser's extensions page, then refresh
any open YouTube tabs.

## Channel subscriptions

Version 1.5.0 adds channels directly through the dashboard API instead of opening
a local terminal. On YouTube channel and watch pages, click **Watch channel**.
The button shows **Subscribed**, **Already subscribed**, or the returned error.
Channels already in the monitored library appear as **Subscribed**.
Sign in to the dashboard through Cloudflare Access before subscribing.

## TikTok saves

The extension checks your TikTok favourites every 15 minutes and queues new videos using your ChromeScribe dashboard login; no key file is needed.
If you are signed out, it pauses and catches up after you sign in at https://chromescribe.yeoux.net.

## TikTok transcription

Open a TikTok video and click the ChromeScribe extension icon. The extension
runs the local `process.bat` script, which downloads the video with `yt-dlp`,
extracts its audio with `ffmpeg`, and sends it to Cloudflare for transcription.

If downloading fails with `Unexpected response from webpage request`, check
`yt-dlp --version`. Version 2026.07.04 has a known TikTok extraction bug fixed
in 2026.08.19. Update the standalone Windows executable with `yt-dlp -U`, then
retry the video. For pip installations, update through that installation's
Python package manager instead. See the
[upstream issue](https://github.com/yt-dlp/yt-dlp/issues/17403).

Run the version check in the same environment as the processing script if
multiple copies of `yt-dlp` are installed. Repeating the download with an old
extractor does not fix this error. No extension reload is needed after updating
the downloader.

## Video card actions

ChromeScribe reserves 34px below each video card's content for its 30px action
row and a 4px gap. This keeps the transcribe and watch-channel buttons clear of
channel names, view counts, and upload dates, including in compact homepage
layouts supplied by SpeedLab. SpeedLab does not need a compatibility override.

To check layout changes, inspect the homepage with standard spacing and with
SpeedLab's five- and six-column layouts. Also check the horizontal recommendation
cards on a watch page. Buttons should stay below the card content, inside the
card, without covering metadata or the next row. Check a long title and channel
name, and navigate between YouTube pages to confirm actions appear only once.
