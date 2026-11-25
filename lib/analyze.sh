ANALYZE_ATTEMPTS="${ANALYZE_ATTEMPTS:-3}"
ANALYZE_RETRY_DELAY="${ANALYZE_RETRY_DELAY:-20}"
ANALYZE_MAX_TIME="${ANALYZE_MAX_TIME:-240}"

analyze_summarized() {
    grep -q '"summarized"[[:space:]]*:[[:space:]]*true'
}

chromescribe_has_summary() {
    api_call GET "/api/transcript/$1/content" | grep -qE '^##[[:space:]]+TL;DR[[:space:]]*$'
}

chromescribe_analyze() {
    local id="$1" attempt=1 delay="$ANALYZE_RETRY_DELAY" result
    while :; do
        result=$(api_call POST "/api/transcripts/$id/analyze" --max-time "$ANALYZE_MAX_TIME")
        if printf '%s' "$result" | analyze_summarized; then
            printf '%s' "$result"
            return 0
        fi
        echo ">>> Analyze attempt $attempt/$ANALYZE_ATTEMPTS failed; waiting ${delay}s before checking the server again" >&2
        sleep "$delay"
        if chromescribe_has_summary "$id"; then
            echo ">>> The server finished the summary after the client gave up; not analyzing again" >&2
            printf '%s' '{"success":true,"data":{"summarized":true,"recovered":true}}'
            return 0
        fi
        if [ "$attempt" -ge "$ANALYZE_ATTEMPTS" ]; then
            printf '%s' "$result"
            return 1
        fi
        attempt=$((attempt + 1))
        delay=$((delay * 2))
    done
}
