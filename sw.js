// Offline support. Bump VERSION (and APP_VERSION in js/app.js) whenever app files change.
const VERSION = 'fuel-v7';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/db.js', 'js/calc.js', 'js/food.js', 'js/charts.js', 'js/scan.js', 'js/ui.js',
  'data/cofid.json', 'icons/icon-192.png', 'icons/apple-touch-icon.png',
];
const RUNTIME = 'fuel-runtime'; // fonts and the barcode library

self.addEventListener('install', e => {
  // cache: 'reload' skips the browser's HTTP cache, so an update never stores stale copies of the files.
  const fresh = SHELL.map(url => new Request(url, { cache: 'reload' }));
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(fresh)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== RUNTIME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // Live food lookups always go to the network.
  if (url.hostname.endsWith('openfoodfacts.org')) return;

  // Fonts and the barcode scanner: cache once, then serve offline.
  if (/fonts\.(googleapis|gstatic)\.com$|cdn\.jsdelivr\.net$/.test(url.hostname)) {
    e.respondWith(caches.open(RUNTIME).then(async c => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok || res.type === 'opaque') c.put(e.request, res.clone());
      return res;
    }));
    return;
  }

  // App files: cache first, falling back to the network.
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request).catch(() => caches.match('index.html')))
    );
  }
});
