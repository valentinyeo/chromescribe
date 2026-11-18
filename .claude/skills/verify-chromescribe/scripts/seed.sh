#!/usr/bin/env bash
set -euo pipefail
SELF=$(cd "$(dirname "$0")" && pwd)
ROOT=$(git -C "$SELF" rev-parse --show-toplevel)
RUN=${CS_VERIFY_DIR:-/tmp/cs-verify}
W=$(npm root -g)/wrangler/bin/wrangler.js
cd "$ROOT/dashboard"
SQL=""
for i in 1 2 3 4 5 6; do
  id="seedvideo0$i"
  md="$RUN/$id.md"
  printf '# Seed video %s\n\n**Source:** https://www.youtube.com/watch?v=%s\n\n## TL;DR\nSeed lead line for video %s.\n\n## Summary\n**Bottom line:** Seed summary %s.\n\n---\n\n## Full Transcript\n\n<details><summary>Expand</summary>\n\nHello from seed transcript %s.\n\n</details>\n' "$i" "$id" "$i" "$i" "$i" > "$md"
  node "$W" r2 object put "chromescribe-transcripts/content/$id.md" --file "$md" --local --config "$RUN/wrangler.toml" --persist-to "$RUN/state" --content-type "text/markdown; charset=utf-8" >> "$RUN/seed.log" 2>&1
  SQL="$SQL INSERT INTO transcripts (video_id,title,channel,duration,srt_path,word_count,category) VALUES ('$id','Seed video $i','Seed Channel',600,'content/$id.md',1500,'Technology');"
done
node "$W" d1 execute chromescribe --local --config "$RUN/wrangler.toml" --persist-to "$RUN/state" --command "$SQL" >> "$RUN/seed.log" 2>&1
echo "seeded 6 transcripts"
