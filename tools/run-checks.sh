#!/usr/bin/env bash
set +e
cd "$(git rev-parse --show-toplevel)"
pattern='openrouter\.ai|OPENROUTER_API_KEY|api\.z\.ai'
if git grep -n -I -i -E "$pattern" -- . ':!tools/run-checks.sh'; then
  echo "::error::No OpenRouter or Z.ai API use. Helpers run on the Codex or Claude subscriptions." >&2
  exit 1
fi
bad_mail=$(git log HEAD --format='%ae%n%ce%n%(trailers:key=Co-authored-by,valueonly)' | sed -E 's/.*<([^>]*)>.*/\1/' | grep -E '@' | grep -vE '@users\.noreply\.github\.com$|^noreply@github\.com$|^noreply@anthropic\.com$' | sort -u)
if [ -n "$bad_mail" ]; then
  echo "::error::A commit carries a real email and this repo is public. Commit with your id+login@users.noreply.github.com address. Domains found:" >&2
  echo "$bad_mail" | sed -E 's/^[^@]*//' >&2
  exit 1
fi
work=$(mktemp -d)
pids=()
labels=()
index=0
check() {
  index=$((index + 1))
  labels[$index]="$1"
  ( eval "$2" ) > "$work/$index.log" 2>&1 &
  pids[$index]=$!
}
check "Comment checker tests" "node --test tools/strip-comments.test.js"
check "No code comments" "node tools/strip-comments.mjs --check ."
check "Encoding checker tests" "node --test tools/encoding-check.test.js"
check "UTF-8 encoding" "node tools/encoding-check.mjs"
check "Media checker tests" "node --test tools/media-check.test.js"
check "No downloaded media" "node tools/media-check.mjs"
check "Local state checker tests" "node --test tools/local-state-check.test.js"
check "No local test databases" "node tools/local-state-check.mjs"
check "Client key checker tests" "node --test tools/client-key-check.test.js"
check "No Access key in apps people install" "node tools/client-key-check.mjs"
check "Live check tests" "node --test tools/live-check.test.js"
check "API setting tests" "node --test tools/api-setting.test.js"
check "Telegram switch tests" "node --test tools/telegram-switch.test.js"
check "Verifier verdict tests" "node --test tools/verifier/verdict.test.mjs"
check "Verifier model picker self-test" "python3 -I scripts/pick-verifier-model --self-test"
check "Workflow tests" "node --test tools/workflows.test.js"
check "Process blocked tests" "node --test tools/process-blocked.test.js"
check "CLI tests" "node --test cli/test/*.test.mjs"
check "Feature map tests" "node --test tools/feature-map.test.js"
check "Dashboard tests" "cd dashboard && node --test test/*.test.mjs"
formal_needed=0
if [ "${FORMAL:-}" = "all" ]; then
  formal_needed=1
elif [ -f formal/queue/coverage.json ]; then
  formal_files=$(node -e 'const c=require("./formal/queue/coverage.json"); const s=new Set(c.covered.map(x=>x.file)); s.add("formal/queue/Queue.tla"); s.add("formal/queue/check.sh"); s.add("formal/queue/coverage.json"); process.stdout.write([...s].join("\n"))')
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if ! git diff --quiet origin/master -- "$f" 2>/dev/null; then
      formal_needed=1
      break
    fi
  done <<EOF
$formal_files
EOF
fi
if [ "$formal_needed" = 1 ]; then
  check "Share queue formal" "bash formal/queue/check.sh"
fi
failed=0
for i in "${!pids[@]}"; do
  wait "${pids[$i]}"
  code=$?
  echo "::group::${labels[$i]}"
  cat "$work/$i.log"
  echo "::endgroup::"
  if [ "$code" -ne 0 ]; then
    failed=1
    echo "::error::${labels[$i]} failed with exit $code"
  fi
done
rm -rf "$work"
exit "$failed"
