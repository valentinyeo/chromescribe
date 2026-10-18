CHROMESCRIBE_ENV_FILE="${CHROMESCRIBE_ENV_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.env.chromescribe}"
if command -v yeo-key >/dev/null 2>&1; then
    if [ -z "${CF_ACCESS_CLIENT_ID-}" ]; then
        CF_ACCESS_CLIENT_ID=$(yeo-key "${CHROMESCRIBE_KEY_ITEM:-Chromescribe Access}" CF_ACCESS_CLIENT_ID 2>/dev/null) || CF_ACCESS_CLIENT_ID=
    fi
    if [ -z "${CF_ACCESS_CLIENT_SECRET-}" ]; then
        CF_ACCESS_CLIENT_SECRET=$(yeo-key "${CHROMESCRIBE_KEY_ITEM:-Chromescribe Access}" CF_ACCESS_CLIENT_SECRET 2>/dev/null) || CF_ACCESS_CLIENT_SECRET=
    fi
fi
if [ -z "${CF_ACCESS_CLIENT_ID-}" ] || [ -z "${CF_ACCESS_CLIENT_SECRET-}" ]; then
    if [ -f "$CHROMESCRIBE_ENV_FILE" ]; then
        _chromescribe_access_id="${CF_ACCESS_CLIENT_ID-}"
        _chromescribe_access_secret="${CF_ACCESS_CLIENT_SECRET-}"
        . "$CHROMESCRIBE_ENV_FILE"
        CF_ACCESS_CLIENT_ID="${_chromescribe_access_id:-${CF_ACCESS_CLIENT_ID-}}"
        CF_ACCESS_CLIENT_SECRET="${_chromescribe_access_secret:-${CF_ACCESS_CLIENT_SECRET-}}"
        unset _chromescribe_access_id _chromescribe_access_secret
    fi
fi
: "${CF_ACCESS_CLIENT_ID:?CF_ACCESS_CLIENT_ID is required (env, yeo-key or $CHROMESCRIBE_ENV_FILE)}"
: "${CF_ACCESS_CLIENT_SECRET:?CF_ACCESS_CLIENT_SECRET is required (env, yeo-key or $CHROMESCRIBE_ENV_FILE)}"
export CF_ACCESS_CLIENT_ID CF_ACCESS_CLIENT_SECRET
