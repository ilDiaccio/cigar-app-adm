const CACHE_NAME = 'cigar-app-v1';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/styles.css?v=1.2',
  '/app.js?v=1.2',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.url.includes('/api/')) {
    // API requests bypass cache initially
    return;
  }
  
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
});
