const CACHE = 'era-ai-v8-2-2';

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'ERA AI';
  const type = data.data?.type || 'MARKET';
  const options = {
    body: data.body || 'New ERA AI market update',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: `era-${type}`,
    renotify: true,
    vibrate: [120, 60, 120],
    data: {
      ...(data.data || {}),
      url: data.data?.url || '/'
    },
    actions: [
      { action: 'open', title: 'Open ERA' },
      { action: 'close', title: 'Dismiss' }
    ]
  };

  if (['apiError', 'riskWarning', 'slHit'].includes(type)) {
    options.requireInteraction = true;
  }

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'close') return;

  const target = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if ('focus' in client) {
          try { client.navigate(target); } catch (_) {}
          return client.focus();
        }
      }
      return clients.openWindow(target);
    })
  );
});
