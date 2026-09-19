# ChromeScribe extension

Load this directory as an unpacked extension in Chrome or Edge. After updating
the files, reload ChromeScribe on the browser's extensions page, then refresh
any open YouTube tabs.

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
