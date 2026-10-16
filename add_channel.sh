#!/bin/bash
cd "$(dirname "$0")"
ARG="$1"; HANDLE="${2:-}"; NAME="${3:-}"
if [ -z "$ARG" ]; then echo "Usage: add_channel.sh <UC_CHANNEL_ID>|<tiktok @handle|url> [name]"; exit 1; fi

case "$ARG" in
    UC*)
        if grep -qiF "$ARG" channels.txt 2>/dev/null; then
            echo "Already watching: $ARG ($HANDLE)"; exit 0
        fi
        LABEL="$HANDLE"; [ -n "$NAME" ] && LABEL="$HANDLE ($NAME)"
        echo "$ARG # $LABEL" >> channels.txt
        echo "Added: $ARG # $LABEL"
        ;;
    tiktok:@*|@*|*tiktok.com/*)
        if [[ "$ARG" == *tiktok.com/* ]]; then
            TT_HANDLE=$(echo "$ARG" | sed -n 's#.*tiktok.com/@\([^/?]*\).*#\1#p')
        elif [[ "$ARG" == tiktok:@* ]]; then
            TT_HANDLE="${ARG#tiktok:@}"
        else
            TT_HANDLE="${ARG#@}"
        fi
        if [ -z "$TT_HANDLE" ]; then echo "Could not parse TikTok handle: $ARG"; exit 1; fi
        if grep -qiF "tiktok:@${TT_HANDLE}" channels.txt 2>/dev/null; then
            echo "Already watching: tiktok:@${TT_HANDLE}"; exit 0
        fi
        LABEL="${HANDLE}"; [ -z "$LABEL" ] && LABEL="${NAME}"
        echo "tiktok:@${TT_HANDLE} # ${LABEL:-@${TT_HANDLE}}" >> channels.txt
        echo "Added: tiktok:@${TT_HANDLE} # ${LABEL:-@${TT_HANDLE}}"
        echo "Note: the monitor seeds the current backlog on first run — only NEW videos get transcribed."
        ;;
    *)
        echo "Not a channel id (expected UC... for YouTube, @handle or tiktok.com URL for TikTok): $ARG"
        exit 1
        ;;
esac
