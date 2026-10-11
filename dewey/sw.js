// Caches the app shell so it opens instantly and survives a weak signal.
// Book data always comes live from Supabase. Bump VERSION when you deploy changes to force a refresh.
const VERSION = 'dewey-v1';
const SHELL = [
  './', './index.html', './styles.css', './app.js', './config.js', './isbn.js', './lookup.js',
  './categories.js', './scan.js', './ocr.js', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png',
];
const CDN = /^https:\/\/(cdn\.jsdelivr\.net\/npm\/(@supabase|@zxing)|fonts\.(googleapis|gstatic)\.com)/;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && !CDN.test(req.url)) return; // APIs, Supabase, covers: always network

  // Stale-while-revalidate: serve the cached copy, refresh it in the background.
  e.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: sameOrigin });
      const fresh = fetch(req)
        .then((res) => { if (res.ok) cache.put(req, res.clone()); return res; })
        .catch(() => cached);
      return cached || fresh;
    }),
  );
});
