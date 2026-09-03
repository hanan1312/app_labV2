const CACHE_NAME = 'helix-lab-v1';
const ASSETS_TO_CACHE = [
    '/',
    '/index_lab.html',
    '/css/style.css',
    '/js/script_lab.js',
    '/react/lab-islands.js',
    '/login'
];

// Install Event: Cache everything
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            return cache.addAll(ASSETS_TO_CACHE);
        })
    );
});

// Fetch Event: Serve from network, fallback to cache if offline
self.addEventListener('fetch', event => {
    // Only cache GET requests (UI assets)
    if (event.request.method === 'GET') {
        event.respondWith(
            fetch(event.request).catch(() => caches.match(event.request))
        );
    }
});