#!/bin/bash
# ChromeScribe Dashboard - Deployment Script

set -e

echo "🚀 ChromeScribe Dashboard Deployment"
echo "======================================"

# Configuration
ACCOUNT_ID="7865043d9ae730882b77f3d5d670c158"
DB_NAME="chromescribe"
BUCKET_NAME="chromescribe-transcripts"

echo ""
echo "📦 Step 1: Create D1 Database..."
DB_EXISTS=$(wrangler d1 list --account-id $ACCOUNT_ID --json 2>/dev/null | grep -c "$DB_NAME" || echo "0")
if [ "$DB_EXISTS" -eq "0" ]; then
    wrangler d1 create $DB_NAME --account-id $ACCOUNT_ID
    echo "✓ D1 database created"
else
    echo "✓ D1 database already exists"
fi

echo ""
echo "📦 Step 2: Apply database schema..."
wrangler d1 execute $DB_NAME --file=./schema.sql --account-id $ACCOUNT_ID --local
echo "✓ Schema applied"

echo ""
echo "📦 Step 3: Create R2 Bucket..."
BUCKET_EXISTS=$(wrangler r2 bucket list --account-id $ACCOUNT_ID --json 2>/dev/null | grep -c "$BUCKET_NAME" || echo "0")
if [ "$BUCKET_EXISTS" -eq "0" ]; then
    wrangler r2 bucket create $BUCKET_NAME --account-id $ACCOUNT_ID
    echo "✓ R2 bucket created"
else
    echo "✓ R2 bucket already exists"
fi

echo ""
echo "📦 Step 4: Upload static files to R2..."
# Upload HTML files
wrangler r2 object put "index.html" --file=./public/index.html --account-id $ACCOUNT_ID --bucket=$BUCKET_NAME
wrangler r2 object put "transcript.html" --file=./public/transcript.html --account-id $ACCOUNT_ID --bucket=$BUCKET_NAME
echo "✓ Static files uploaded"

echo ""
echo "📦 Step 5: Update wrangler.toml with database ID..."
# Get database ID
DB_ID=$(wrangler d1 list --account-id $ACCOUNT_ID --json 2>/dev/null | grep -o '"uuid":"[^"]*"' | grep -A1 "$DB_NAME" | tail -1 | cut -d'"' -f4)
if [ -z "$DB_ID" ]; then
    echo "⚠️  Could not get database ID automatically. Please update wrangler.toml manually."
fi

echo ""
echo "📦 Step 6: Deploy Worker..."
wrangler deploy --account-id $ACCOUNT_ID

echo ""
echo "✅ Deployment complete!"
echo ""
echo "📝 Next steps:"
echo "   1. Update wrangler.toml with your D1 database ID if not auto-detected"
echo "   2. Visit your worker URL to access the dashboard"
echo "   3. Use the API to add transcripts:"
echo "      POST /api/transcribe"
echo "      { \"url\": \"https://youtube.com/watch?v=...\", \"title\": \"...\", \"srt_content\": \"...\" }"
