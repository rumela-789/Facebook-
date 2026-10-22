// Vimline service worker: push notifications + offline fallback for the app shell.
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js","https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");
firebase.initializeApp({
  apiKey: "AIzaSyAKqNt9KLTVy3OXiLVmJGyADzdnQQ_cASE",
  authDomain: "livoapp-dc2da.firebaseapp.com",
  projectId: "livoapp-dc2da",
  storageBucket: "livoapp-dc2da.firebasestorage.app",
  messagingSenderId: "178266701059",
  appId: "1:178266701059:web:d1faf2497993afb165fd36"
});
const messaging = firebase.messaging();
messaging.onBackgroundMessage(p => {
  const d = p.data || {};
  return self.registration.showNotification(d.title || "Vimline", {
    body: d.body || "", tag: d.tag || "vimline",
    icon: "icon-192.png", badge: "icon-192.png",
    data: { url: d.url || "./" }
  });
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(l => {
    for (const c of l) if ("focus" in c) return c.focus();
    return clients.openWindow((e.notification.data && e.notification.data.url) || "./");
  }));
});
self.addEventListener("install", e => {
  self.skipWaiting();
  e.waitUntil(caches.open("vimline-v1").then(c => c.addAll(["./", "icon-192.png"]).catch(() => {})));
});
self.addEventListener("activate", e => e.waitUntil(clients.claim()));
self.addEventListener("fetch", e => {
  if (e.request.mode === "navigate") e.respondWith(fetch(e.request).catch(() => caches.match("./")));
});
