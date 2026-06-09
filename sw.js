/* 気になり帳 service worker — background task notifications */
/* Works with the Notification Triggers API (TimestampTrigger), which the
   page schedules via registration.showNotification(..., { showTrigger }).
   The browser fires those at the set time even if the tab is closed
   (supported on Chrome / Edge / Android Chrome). This worker only needs to
   activate immediately and handle clicks on the notifications. */

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
