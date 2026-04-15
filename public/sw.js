/**
 * FaceSense Phase 4 — Service Worker
 *
 * Handles background push notification display.
 * Placed in /public so it's served at the root scope.
 *
 * This is the OPTIONAL Firebase Cloud Messaging integration.
 * The app works fully without this — browser Notification API
 * on the main page handles in-session alerts automatically.
 *
 * To enable FCM push (optional):
 *   1. Create a Firebase project at https://console.firebase.google.com (free)
 *   2. Enable Cloud Messaging
 *   3. Replace the firebaseConfig values below
 *   4. Set NEXT_PUBLIC_FIREBASE_* env vars
 */

// ─── Cache name ────────────────────────────────────────────────────────────────
const CACHE_NAME = "facesense-v4";

// ─── Install: cache core assets ────────────────────────────────────────────────
self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(["/", "/dashboard"])
    )
  );
});

// ─── Activate: clean old caches ───────────────────────────────────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ─── Push: show notification from FCM payload ──────────────────────────────────
self.addEventListener("push", (event) => {
  let data = { title: "FaceSense Alert", body: "Check your wellness status." };

  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      data.body = event.data.text();
    }
  }

  event.waitUntil(
    self.registration.showNotification(data.title ?? "FaceSense", {
      body: data.body ?? "",
      icon: "/favicon.ico",
      badge: "/favicon.ico",
      tag: data.tag ?? "facesense-alert",
      requireInteraction: false,
      data: { url: data.url ?? "/dashboard" },
    })
  );
});

// ─── Notification click: open dashboard ───────────────────────────────────────
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? "/dashboard";
  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windowClients) => {
        const existing = windowClients.find(
          (c) => c.url.includes(url) && "focus" in c
        );
        if (existing) return existing.focus();
        return clients.openWindow(url);
      })
  );
});
