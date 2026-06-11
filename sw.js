/* 気になり帳 service worker — notifications */
/* The page may schedule notifications via the Notification Triggers API
   (TimestampTrigger) when available. NOTE: that API only existed as Chrome
   origin trials (M80–83, M86–88) and was never shipped to stable browsers,
   so on current Chrome/Edge/Safari it is NOT available — the app feature-
   detects this and falls back to in-app reminders while a tab is open.
   This worker is kept for: (1) immediate activation, and (2) handling
   clicks on notifications if a supporting browser ever schedules them. */

self.addEventListener("install", () => { self.skipWaiting(); });

self.addEventListener("activate", (event) => { event.waitUntil(self.clients.claim()); });

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
