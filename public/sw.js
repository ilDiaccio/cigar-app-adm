const CACHE_NAME = 'cigar-app-v3';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/styles.css?v=1.3',
  '/app.js?v=1.3',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  console.log('Service Worker: Installing v2');
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    }).then(() => {
      return self.skipWaiting(); // Forza l'attivazione immediata
    })
  );
});

self.addEventListener('activate', (event) => {
  console.log('Service Worker: Activating v2');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('Service Worker: Deleting old cache', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      return self.clients.claim(); // Prendi controllo di tutti i client
    })
  );
});

self.addEventListener('fetch', (event) => {
  // IMPORTANTE: NON cachare mai le API
  if (event.request.url.includes('/api/')) {
    console.log('Service Worker: Bypassing cache for API:', event.request.url);
    event.respondWith(fetch(event.request));
    return;
  }
  
  // Per gli altri file, usa cache-first
  event.respondWith(
    caches.match(event.request).then((response) => {
      if (response) {
        console.log('Service Worker: Serving from cache:', event.request.url);
        return response;
      }
      console.log('Service Worker: Fetching:', event.request.url);
      return fetch(event.request);
    })
  );
});
