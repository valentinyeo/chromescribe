@echo off
setlocal

set "BUCKET_NAME=chromescribe-transcripts"

echo ======================================
echo ChromeScribe Dashboard Deployment
echo ======================================
echo Using the Cloudflare account configured in wrangler.toml.
echo.

echo Step 1: Upload static files to R2...
wrangler r2 object put "%BUCKET_NAME%/index.html" --file=./public/index.html --remote || exit /b 1
wrangler r2 object put "%BUCKET_NAME%/transcript.html" --file=./public/transcript.html --remote || exit /b 1
wrangler r2 object put "%BUCKET_NAME%/settings.html" --file=./public/settings.html --remote || exit /b 1
wrangler r2 object put "%BUCKET_NAME%/stats.html" --file=./public/stats.html --remote || exit /b 1
echo Static files uploaded
echo.

echo Step 2: Deploy Worker...
wrangler deploy || exit /b 1
echo.

echo ======================================
echo Deployment complete!
echo ======================================

endlocal
