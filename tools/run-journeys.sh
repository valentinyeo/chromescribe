#!/usr/bin/env bash
set -u
cd "$(git rev-parse --show-toplevel)"
CS=.claude/skills/verify-chromescribe/scripts/cs-verify
base="${1:-}"
video="${VIDEO:+--video}"
if [ -z "$base" ] || [ "$base" = "all" ] || ! git cat-file -e "$base^{commit}" 2>/dev/null; then
  features=all
else
  features=$("$CS" select --base "$base" | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(s.all?"all":s.features.join(" "))')
fi
echo "features: ${features:-none}"
[ -z "$features" ] && exit 0
"$CS" launch --seed real || exit 1
mkdir -p /tmp/cs-verify/proof
failed=0
for f in $features; do
  "$CS" journey "$f" $video > "/tmp/cs-verify/proof/journey-$f.json" || failed=1
  node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(`${process.argv[2]}: ${r.passed}/${r.total} passed`)' "/tmp/cs-verify/proof/journey-$f.json" "$f"
done
"$CS" cleanup >/dev/null || true
exit "$failed"
