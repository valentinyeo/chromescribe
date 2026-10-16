#!/usr/bin/env bash

set -euo pipefail

WRANGLER="${WRANGLER:-wrangler}"
BUCKET_NAME="chromescribe-transcripts"

echo "🚀 ChromeScribe Dashboard Deployment"
echo "======================================"
echo "Using the Cloudflare account configured in wrangler.toml."

echo ""
echo "📦 Step 1: Upload static files to R2..."
for page in ./public/*.html; do
  "$WRANGLER" r2 object put "$BUCKET_NAME/$(basename "$page")" \
    --file="$page" \
    --remote
done
echo "✓ Static files uploaded"

echo ""
echo "📦 Step 2: Deploy Worker..."
"$WRANGLER" deploy

echo ""
echo "✅ Deployment complete!"
