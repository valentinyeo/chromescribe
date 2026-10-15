#!/usr/bin/env bash
# ChromeScribe Dashboard - Deployment Script

set -euo pipefail

WRANGLER="${WRANGLER:-wrangler}"
BUCKET_NAME="chromescribe-transcripts"
STATIC_PAGES=(index.html transcript.html settings.html stats.html subscriptions.html)

echo "🚀 ChromeScribe Dashboard Deployment"
echo "======================================"
echo "Using the Cloudflare account configured in wrangler.toml."

echo ""
echo "📦 Step 1: Upload static files to R2..."
for page in "${STATIC_PAGES[@]}"; do
  "$WRANGLER" r2 object put "$BUCKET_NAME/$page" \
    --file="./public/$page" \
    --remote
done
echo "✓ Static files uploaded"

echo ""
echo "📦 Step 2: Deploy Worker..."
"$WRANGLER" deploy

echo ""
echo "✅ Deployment complete!"
