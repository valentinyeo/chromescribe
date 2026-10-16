
const LATEST_OBJECT_KEY = "android/latest.json";
const RELEASE_PREFIX = "android/releases/";

const RELEASE_APK_RE = /^\/api\/android\/releases\/([1-9][0-9]{0,9})\/app\.apk$/;

const APK_MIME = "application/vnd.android.package-archive";

function jsonResponse(status, body) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function notFound() {
  return jsonResponse(404, JSON.stringify({ error: "not_found" }));
}

function badGateway() {
  return jsonResponse(502, JSON.stringify({ error: "upstream_error" }));
}

async function serveLatest(bucket) {
  if (!bucket || typeof bucket.get !== "function") return badGateway();
  const object = await bucket.get(LATEST_OBJECT_KEY);
  if (!object || !object.body) return notFound();
  const text = await object.text();
  return new Response(text, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function serveApk(bucket, versionCode) {
  if (!bucket || typeof bucket.get !== "function") return badGateway();
  const key = `${RELEASE_PREFIX}${versionCode}/app.apk`;
  const object = await bucket.get(key);
  if (!object || !object.body) return notFound();
  return apkResponse(object.body, object.size);
}

function apkResponse(body, size) {
  const headers = {
    "content-type": APK_MIME,
    "cache-control": "private, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
    "content-disposition": 'attachment; filename="app.apk"',
  };
  if (typeof size === "number" && size >= 0) {
    headers["content-length"] = String(size);
  }
  return new Response(body, { status: 200, headers });
}

export async function handleAndroidUpdates(request, env) {
  try {
    if (!request || request.method !== "GET") {
      return null;
    }

    let pathname;
    try {
      pathname = new URL(request.url).pathname;
    } catch {
      return null;
    }

    if (pathname === "/api/android/latest") {
      return await serveLatest(env && env.TRANSCRIPTS);
    }

    const match = RELEASE_APK_RE.exec(pathname);
    if (match) {
      return await serveApk(env && env.TRANSCRIPTS, match[1]);
    }

    return null;
  } catch {
    return badGateway();
  }
}

export default handleAndroidUpdates;