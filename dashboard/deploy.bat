@echo off
REM ChromeScribe Dashboard - Deployment Script (Windows)

echo ======================================
echo ChromeScribe Dashboard Deployment
echo ======================================
echo.

set ACCOUNT_ID=7865043d9ae730882b77f3d5d670c158
set DB_NAME=chromescribe
set BUCKET_NAME=chromescribe-transcripts

echo Step 1: Create D1 Database...
wrangler d1 create %DB_NAME% --account-id %ACCOUNT_ID%
echo.

echo Step 2: Apply database schema...
wrangler d1 execute %DB_NAME% --file=./schema.sql --account-id %ACCOUNT_ID% --local
echo.

echo Step 3: Create R2 Bucket...
wrangler r2 bucket create %BUCKET_NAME% --account-id %ACCOUNT_ID%
echo.

echo Step 4: Upload static files to R2...
wrangler r2 object put "index.html" --file=./public/index.html --account-id %ACCOUNT_ID% --bucket=%BUCKET_NAME%
wrangler r2 object put "transcript.html" --file=./public/transcript.html --account-id %ACCOUNT_ID% --bucket=%BUCKET_NAME%
echo.

echo Step 5: Deploy Worker...
wrangler deploy --account-id %ACCOUNT_ID%
echo.

echo ======================================
echo Deployment complete!
echo ======================================
pause
