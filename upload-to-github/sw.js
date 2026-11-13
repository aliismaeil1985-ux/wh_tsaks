/* WH Tasks — service worker: receives push messages and shows them as phone notifications,
   even when the platform is closed. It does not cache pages (the platform always loads fresh). */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { body: e.data ? e.data.text() : '' }; }
  var title = d.title || 'مهام المستودعات';
  var opts = {
    body: d.body || '',
    icon: '/icon-192.png',
    tag: d.tag || ('wh-' + Date.now()),
    renotify: true,
    requireInteraction: false,
    vibrate: [200, 100, 200, 100, 350],
    dir: 'rtl',
    lang: 'ar',
    timestamp: Date.now(),
    data: { url: d.url || '/', taskId: d.taskId || null }
  };
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      /* the platform is open on screen: its own in-app alert already shows it */
      var visible = list.some(function (c) { return c.visibilityState === 'visible'; });
      if (visible && !d.test) {
        list.forEach(function (c) { try { c.postMessage({ type: 'push-received', taskId: opts.data.taskId }); } catch (x) {} });
        return;
      }
      return self.registration.showNotification(title, opts);
    })
  );
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var data = e.notification.data || {};
  var url = data.url || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (c.url && c.url.indexOf(self.location.origin) === 0 && 'focus' in c) {
          return c.focus().then(function (fc) { try { (fc || c).postMessage({ type: 'ntf-click', taskId: data.taskId }); } catch (x) {} });
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
