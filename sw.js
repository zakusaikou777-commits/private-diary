/* 気になり帳 service worker — notifications */
/* The page may schedule notifications via the Notification Triggers API
   (TimestampTrigger) when available. NOTE: that API only existed as Chrome
   origin trials (M80–83, M86–88) and was never shipped to stable browsers,
   so on current Chrome/Edge/Safari it is NOT available — the app feature-
   detects this and falls back to in-app reminders while a tab is open.
   This worker is kept for: (1) immediate activation, and (2) handling
   clicks on notifications if a supporting browser ever schedules them. */

const CACHE_NAME = "nk-shell-v25";
const SHELL_ASSETS = ["./", "./index.html", "./kininari.html", "./diary.html", "./image-streaming.html", "./bgm.html", "./autogenic.html", "./tasks.html", "./sync.js", "./version.js", "./clipper.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png",
  // 就寝用の音はオフラインでも鳴らせるようにキャッシュしておく（各625KB）
  "./audio/brown.wav", "./audio/pink.wav", "./audio/rain.wav"];

self.addEventListener("install", (event) => {
  // ネットワーク優先＋オフライン時フォールバック用に主要ファイルを事前キャッシュ。
  // addAll は1つでも失敗すると全体が失敗するので、1件ずつ入れて取りこぼしを防ぐ。
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((c) => Promise.all(SHELL_ASSETS.map((u) => c.add(u).catch(() => {}))))
      .catch(() => {}) // 一部が無くてもインストールは続行
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

/* <audio> は Range 付き（bytes=0-1 など）で取りに来る。iOS Safari は 206（部分応答）で
   返さないと再生しないため、キャッシュに入れた就寝用の音がオフラインで鳴らなかった。
   キャッシュから返すときは、頼まれた範囲だけを切り出して 206 で返す。
   （ネットワークから返すときはサーバーが 206 を返すので、そのまま渡す） */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;      // 複数範囲などは扱わない（丸ごと返す）
  let start, end;
  if (m[1] === "") {                                         // bytes=-500 … 末尾の500バイト
    const n = parseInt(m[2], 10);
    if (!(n > 0)) return { bad: true };
    start = Math.max(0, size - n); end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === "" ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
  }
  if (!(start >= 0) || start >= size || end < start) return { bad: true };
  return { start, end };
}
async function rangeFromCache(req, res) {
  const header = req.headers.get("range");
  if (!header || !res || res.status !== 200) return res;
  const buf = await res.arrayBuffer();
  const size = buf.byteLength;
  const type = res.headers.get("content-type") || "application/octet-stream";
  const r = parseRange(header, size);
  if (!r) return new Response(buf, { status: 200, headers: { "Content-Type": type, "Content-Length": String(size), "Accept-Ranges": "bytes" } });
  if (r.bad) return new Response(null, { status: 416, statusText: "Range Not Satisfiable", headers: { "Content-Range": "bytes */" + size, "Accept-Ranges": "bytes" } });
  return new Response(buf.slice(r.start, r.end + 1), {
    status: 206, statusText: "Partial Content",
    headers: { "Content-Type": type, "Content-Range": "bytes " + r.start + "-" + r.end + "/" + size,
               "Content-Length": String(r.end - r.start + 1), "Accept-Ranges": "bytes" }
  });
}

/* ネットワーク優先: オンライン時は常に最新を取得して裏でキャッシュ更新、
   オフライン時のみキャッシュから返す（古い版を配り続けない） */
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(req).then((res) => {
      // 部分応答（206）は Cache に入らない（put が必ず失敗する）ので、丸ごとの応答だけ入れる
      if (res && res.ok && res.status !== 206) {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit ? rangeFromCache(req, hit) : caches.match("./index.html")))
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const url = (event.notification.data && event.notification.data.url) || "./";
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of wins) {
      try { await c.focus(); return; } catch (e) {}
    }
    if (self.clients.openWindow) {
      try { return await self.clients.openWindow(url); } catch (e) {}
    }
  })());
});
