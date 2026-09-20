self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { data = { title: 'ERA AI', body: event.data?.text?.() || 'New ERA update.' }; }
  event.waitUntil(self.registration.showNotification(data.title || 'ERA AI', {
    body: data.body || 'New ERA update.',
    icon: '/favicon.ico',
    badge: '/favicon.ico',
    data: data.data || {}
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    if (list.length) return list[0].focus();
    return clients.openWindow('/');
  }));
});
