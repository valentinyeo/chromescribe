# Login-free YouTube downloads (IGSH-471)

## Diagnosis and measured result

Verified on 2026-10-22 from this VPS, without browser authentication.
Its direct IPv4 and IPv6 connections received `LOGIN_REQUIRED` for the ticket
video. Changing clients, upgrading or generating a proof-of-origin token did
not remove that restriction.

The installed stable yt-dlp is `2026.08.19`; the isolated prerelease tested was
`2026.10.21.233146`. The loaded plugin directory is
`~/.local/lib/python3.12/site-packages/yt_dlp_plugins`. Both providers and the
running HTTP server are `2.0.2`, compatible with yt-dlp's provider framework.
The baseline forced `mweb` and failed before requesting a token.
With `fetch_pot=always`, verbose output instead showed:

```text
[youtube] [pot:bgutil:http] Generating a player PO Token for mweb client via bgutil HTTP server
[debug] [youtube] OLqP8jxJ0Wc: Retrieved a player PO Token for mweb client
[debug] [youtube] OLqP8jxJ0Wc: mweb player response playability status: LOGIN_REQUIRED
```

Direct-source matrix, all against `OLqP8jxJ0Wc` with `--ignore-config -v`,
`--simulate --print title`, Node 22, and `fetch_pot=never` / `always`:

| yt-dlp | Source | Clients | Policies | Result |
|---|---|---|---|---|
| stable | IPv4 | tv, web_safari, web_embedded, android_vr, ios, mweb | both | 12 failures |
| prerelease | IPv4 | same six | both | 12 failures |
| prerelease | IPv6 | same six | both | 12 failures |
| stable + prerelease | IPv4, script provider forced | mweb, web_safari | always | 4 failures |

All 40 attempts exited 1. Sixteen retrieved a player token and still failed.
`android_vr` and `ios` were tested with forced fetching, but bgutil cannot
provide their native-platform tokens; a web token is not a substitute.
IPv4 used the HTTP provider on `127.0.0.1:4416`. The IPv6 runs fell back to
the script provider because `-6` also prevents reaching that IPv4 loopback
HTTP address. The forced script trials used an unavailable HTTP address
(`http://127.0.0.1:1`) and the installed `server_home`.
Detailed local diagnostics are in `/tmp/IGSH-471/`, including `matrix.json`.

A second source (the older VPS) also failed a clean, configuration-free
simulation. The egress server succeeded when used as SOCKS egress, with both
stable and prerelease yt-dlp. This isolates the remaining restriction to the
source network/session rather than a missing provider installation.

Current upstream guidance read during diagnosis:

- [yt-dlp PO Token Guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide):
  recommends an `mweb` GVS token provider; tokens are platform-specific.
- [bgutil README](https://github.com/Brainicism/bgutil-ytdlp-pot-provider):
  matching provider/server versions are required; a generated token does not
  bypass IP-based login restrictions. HTTP takes priority over the script.

## Working server configuration

`~/.config/yt-dlp/config` is exactly `tools/yt-dlp-login-free.conf`:

```text
--js-runtimes node:/usr/bin/node
--proxy socks5://127.0.0.1:14416
--extractor-args "youtube:player_client=mweb;fetch_pot=always"
--extractor-args "youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416"
```

`chromescribe-youtube-egress.service` maintains a loopback-only SSH SOCKS
listener through the already-authorized egress server. `bgutil-pot.service`
maintains the loopback-only HTTP token provider. Both user services are enabled,
restart on failure, and user lingering is enabled. The global yt-dlp executable
was not upgraded; the prerelease remains isolated in
`~/.local/share/yt-dlp-IGSH-471-venv` for diagnosis.

The exact ticket command now exits 0 and prints:

```console
$ cd /tmp && yt-dlp --simulate --print title https://www.youtube.com/watch?v=OLqP8jxJ0Wc
My Jev Pi Durable Agent CURATES News: HYPE, FACT, or SIGNAL
```

A real `yt-dlp --test --no-playlist -f bestaudio` request also downloaded
10,241 bytes to `/tmp/IGSH-471/audio.webm`. This is a bounded media transport
check, not a complete transcription or ingestion run.

The existing installation has Node 22 and bgutil server `2.0.2` at
`~/.local/share/bgutil-pot/server`. To reapply the configuration there:

Create `~/.config/chromescribe/egress.env` outside the repository, readable only
by the service user, with `YOUTUBE_EGRESS_HOST` set to the existing authorized
SSH alias or destination for the egress server. The egress unit reads this file
via `EnvironmentFile=%h/.config/chromescribe/egress.env`. To reuse it in a shell:

```bash
set -a
. "$HOME/.config/chromescribe/egress.env"
set +a
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes "$YOUTUBE_EGRESS_HOST" true
install -Dm644 tools/chromescribe-youtube-egress.service ~/.config/systemd/user/chromescribe-youtube-egress.service
install -Dm644 tools/bgutil-pot.service ~/.config/systemd/user/bgutil-pot.service
install -Dm644 tools/yt-dlp-login-free.conf ~/.config/yt-dlp/config
systemctl --user daemon-reload
systemctl --user enable --now bgutil-pot chromescribe-youtube-egress
systemctl --user is-enabled bgutil-pot chromescribe-youtube-egress
systemctl --user is-active bgutil-pot chromescribe-youtube-egress
loginctl show-user "$USER" -p Linger
```

On a fresh server, first install matching components using the bgutil README;
these units do not install dependencies or authorize SSH. The configured SSH
destination, existing authorized private key and verified known-host entry must
be available to the service user. Do not copy keys into the repository. Retain
any unrelated existing yt-dlp settings when adapting this example elsewhere.

This is an alternate-egress workaround, not an IP unblock or a permanent
YouTube guarantee. If that source becomes blocked or unavailable, requests
fail rather than silently switching back to the blocked direct source. Keep
both listeners on loopback. Check with:

```bash
systemctl --user status chromescribe-youtube-egress bgutil-pot --no-pager
curl --proxy socks5h://127.0.0.1:14416 https://api.ipify.org
yt-dlp -v --simulate --print title https://www.youtube.com/watch?v=OLqP8jxJ0Wc
```

`process.sh`, `monitor.sh`, and YouTube jobs dispatched by `queue.sh` inherit
this global config. Monitor no longer requests Chrome authentication.
TikTok calls explicitly override the proxy with `--proxy ""`, preserving
laptop direct-network downloads. Do not run TikTok ingestion on a VPS.
The global proxy also applies to other yt-dlp invocations unless overridden.

## Windows laptop: direct downloads

The runner verified on 2026-10-22 that the laptop downloads directly on its
home connection: with no yt-dlp config, Chocolatey's yt-dlp `2026.08.19`
(the executable `process.bat` puts on PATH) printed the title for `OLqP8jxJ0Wc`.
No tunnel or proxy is needed. Only if it gets blocked later, install the local
provider in PowerShell, without configuring a proxy:

```powershell
& "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe" -m pip install --upgrade bgutil-ytdlp-pot-provider
```

## Monitor history and next run

No current monitor log or monitor timer was found on this VPS.
The existing scheduled monitor is on the older VPS, at
`/home/valentin/projects/chromescribe/monitor.log`, with cron at 07:00, 12:00,
16:00 and 20:00 UTC (`Timezone=Etc/UTC`).

The first recorded bot failure is 2026-05-01 20:00 (line 17530), following a
warning that historical browser authentication was no longer valid. The last
recorded bot failure is on 2026-05-05. The latest completed run is
2026-10-21 20:24:16 (line 262701), reporting six new videos; it is not evidence
of an ongoing all-video monitor outage. That old deployment still explicitly
requests Chrome authentication; it was read, not run or changed here.

The next scheduled old-VPS run will check new videos under its existing setup,
not automatically inherit this different server's config or this unmerged PR.
In this branch, failures are never appended to `.processed_videos`, so they
retry while still returned by the feed. `lib/youtube_feed.py` defaults to a
36-hour publication window: older failed videos need an explicit
`monitor.sh --force VIDEO_ID TITLE` after deployment. No ingestion, queue
mutation, or backfill was performed for verification.

## External acceptance ledger

The external `IGSH-471.deeper-repro` and `provider-survives` checks pass on
this server. `process.sh` already contains the plain `YouTube blocked` message;
`tools/process-blocked.test.js` now covers persistent blocking, IPv6 recovery,
unrelated failures, direct TikTok routing, and authentication-free monitor
routing. Only that small test file was run; no project test suite or build ran.

The external `blocked-message` check deliberately reads `origin/master`, not
this branch. It cannot pass until an authorized runner merges the PR, because
master lacks a test filename containing `process-blocked`. This session did not
merge, edit the external ledger, add a GitHub workflow, or access the laptop.
