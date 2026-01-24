// Bump cache name when you change any core asset list so phones update reliably.
const CACHE_NAME = 'truck-audit-utility-v0.4';
const APP_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './xlsx.full.min.js',
  './zxing-browser.min.js',
  './manifest.webmanifest',
  './logo.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_ASSETS)).then(()=>self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => (k===CACHE_NAME)?null:caches.delete(k)))).then(()=>self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if(url.origin === location.origin){
    event.respondWith(
      caches.match(req).then(cached => cached || fetch(req).then(resp=>{
        const copy = resp.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
        return resp;
      }))
    );
    return;
  }

  event.respondWith(
    fetch(req).then(resp=>{
      const copy = resp.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
      return resp;
    }).catch(()=>caches.match(req))
  );
});
