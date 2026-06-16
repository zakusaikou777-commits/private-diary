/* 気になり帳 service worker — notifications */
/* The page may schedule notifications via the Notification Triggers API
   (TimestampTrigger) when available. NOTE: that API only existed as Chrome
   origin trials (M80–83, M86–88) and was never shipped to stable browsers,
   so on current Chrome/Edge/Safari it is NOT available — the app feature-
   detects this and falls back to in-app reminders while a tab is open.
   This worker is kept for: (1) immediate activation, and (2) handling
   clicks on notifications if a supporting browser ever schedules them. */

self.addEventListener("install", (event) => {
  // ネットワーク優先＋オフライン時フォールバック用に主要ファイルを事前キャッシュ
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((c) => c.addAll(SHELL_ASSETS))
      .catch(() => {}) // 一部が無くてもインストールは続行
  );
  self.skipWaiting();
});

const CACHE_NAME = "nk-shell-v1";
const SHELL_ASSETS = ["./", "./index.html", "./kininari.html", "./diary.html", "./image-streaming.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"];

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

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
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match("./index.html")))
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
