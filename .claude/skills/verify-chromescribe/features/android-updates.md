---
name: android-updates
journey: android-updates
paths:
  - dashboard/src/android-updates.mjs
  - dashboard/src/index.ts
---

# Android app updates

The Android app checks `/api/android/latest` for release metadata and downloads `/api/android/releases/<versionCode>/app.apk`; the Worker serves both from R2 and answers a JSON 404 when a release is missing.

## Sub-features

- `android-latest` serves the stored `android/latest.json` verbatim with `cache-control: no-store`.
- `android-apk` serves `android/releases/<versionCode>/app.apk` as an APK attachment that browsers may cache for a year.
- `android-missing` answers 404 `{"error":"not_found"}` when the metadata or the APK is absent.
- `android-method` leaves every method except GET to the rest of the API router.

## How to get to it (user POV)

- The ChromeScribe Android app checks `https://chromescribe.yeoux.net/api/android/latest` on launch.
- Choosing Update downloads `https://chromescribe.yeoux.net/api/android/releases/<versionCode>/app.apk`.
- Both calls carry the signed-in Cloudflare Access session; the app holds no service key.

## Driving it with cs-verify

Preconditions:

- `cs-verify launch --seed real` seeded `android/latest.json` and `android/releases/7/app.apk` into local R2.
- `cs-verify doctor` is ok and the instance runs with `CHRO10_API_GATE=0`.

- **Latest metadata.** Run `cs-verify journey android-updates`. `GET /api/android/latest` returns 200, `application/json`, `cache-control: no-store`, and the seeded `versionCode`.
- **APK download.** `GET /api/android/releases/7/app.apk` returns 200, `application/vnd.android.package-archive`, `content-disposition: attachment; filename="app.apk"`, and the seeded marker bytes.
- **Missing release.** `GET /api/android/releases/8/app.apk` returns 404 with `error: not_found`.
- **Proof.** `proof/android-updates/android-update.json` records the status, headers and body of every response.

## Gotchas

- The APK route matches only a positive integer version code and the exact `/app.apk` suffix. Any other shape falls through to the normal API 404.
- The Worker reads release objects from the same R2 bucket as the pages. The local seed writes a small placeholder APK, not a signed build.
- The local gate is off, so the journey proves the stored bytes and headers, not the Cloudflare Access login that fronts them in production.
- The Android updater lives in https://github.com/valentinyeo/chromescribe-android and is not driven here.
