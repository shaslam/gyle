// Minimal service worker. Its only job is to let the brew-day timer show
// notifications on browsers that require one (Chrome on Android), and to bring
// the app to the front when a notification is tapped. It caches nothing.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => (list[0] ? list[0].focus() : self.clients.openWindow('./'))));
});
