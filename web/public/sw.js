/* sasa service worker: shows price-alert notifications. It caches nothing,
   so the site always loads fresh from the network. */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "sasa", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "sasa";
  const options = {
    body: data.body || "",
    icon: "/sasa-icon-192.png",
    badge: "/sasa-badge-96.png",
    tag: data.tag || undefined,
    renotify: !!data.tag,
    data: { url: data.url || "/terminal/" },
  };
  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, options);
      // Open sasa tabs refresh their 🔔 right away.
      const tabs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const t of tabs) t.postMessage({ type: "sasa-note" });
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "/terminal/", self.location.origin);
  // Only open pages of this site.
  const url = target.origin === self.location.origin ? target.href : self.location.origin + "/terminal/";
  event.waitUntil(
    (async () => {
      const tabs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const t of tabs) {
        if (new URL(t.url).origin === self.location.origin && "focus" in t) {
          await t.focus();
          if ("navigate" in t) {
            try {
              await t.navigate(url);
            } catch (e) {}
          }
          return;
        }
      }
      await self.clients.openWindow(url);
    })()
  );
});

// The browser replaced this device's subscription: the site re-saves it on its next visit.
self.addEventListener("pushsubscriptionchange", () => {});
