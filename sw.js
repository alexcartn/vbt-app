// Service worker : l'app reste utilisable hors ligne (utile en salle), sans jamais servir une version périmée si le réseau répond.
const CACHE = 'vbt-v3';
const SHELL = ['./', 'index.html', 'style.css', 'manifest.webmanifest', 'js/app.js', 'js/signal.js', 'js/ble.js', 'js/sim.js', 'js/profile.js', 'js/store.js', 'js/feedback.js', 'js/audio.js', 'icons/icon-192.png', 'icons/icon-512.png', 'fonts/big-shoulders-800.woff2', 'fonts/hanken-grotesk.woff2'];

self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request))
  );
});
