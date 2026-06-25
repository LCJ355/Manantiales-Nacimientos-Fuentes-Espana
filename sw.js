const CACHE = 'fuentes-v21';
const URLS = [
  'index.html', 'style.css', 'main.js',
  'manifest.json', 'lib/leaflet.js', 'lib/leaflet.css',
  'lib/leaflet.markercluster.js', 'lib/MarkerCluster.css', 'lib/MarkerCluster.Default.css',
  'osm_drinking_water.json', 'data/index.json', 'photo_counts.js',
];
const TILE_CACHE = 'osm-tiles-v1';
const MAX_TILES = 2000;

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    for (const url of URLS) {
      try {
        const resp = await fetch(url);
        if (resp.ok) await c.put(url, resp);
      } catch(_) { /* skip */ }
    }
  })());
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keep = new Set([CACHE, TILE_CACHE]);
    for (const key of await caches.keys()) {
      if (!keep.has(key)) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  // Only intercept GET requests. Caching POST/DELETE is unsupported and throws TypeErrors.
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);

  // Map tiles -> progressive tile cache
  const tileHosts = ['tile.openstreetmap.org', 'tile.opentopomap.org', 'server.arcgisonline.com'];
  if (tileHosts.some(h => url.hostname.endsWith(h))) {
    e.respondWith(tileStrategy(e.request));
    return;
  }

  // Everything else -> network-first (always get latest from server)
  e.respondWith(networkFirst(e.request));
});

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const resp = await fetch(req);
    if (resp.ok) {
      const c = await caches.open(CACHE);
      await c.put(req, resp.clone());
    }
    return resp;
  } catch(e) {
    return new Response('Offline', { status: 503 });
  }
}

async function networkFirst(req) {
  try {
    const resp = await fetch(req);
    if (resp.ok) {
      const c = await caches.open(CACHE);
      await c.put(req, resp.clone());
    }
    return resp;
  } catch(e) {
    const cached = await caches.match(req);
    if (cached) return cached;
    return new Response('Offline', { status: 503 });
  }
}

async function tileStrategy(req) {
  const cached = await caches.match(req);
  if (cached) return cached;

  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch(req, { signal: ctrl.signal });
    clearTimeout(to);
    if (resp.ok) {
      const c = await caches.open(TILE_CACHE);
      const keys = await c.keys();
      if (keys.length < MAX_TILES) {
        await c.put(req, resp.clone());
      } else if (Math.random() < 0.1) {
        const evict = keys[Math.floor(Math.random() * keys.length)];
        await c.delete(evict);
        await c.put(req, resp.clone());
      }
    }
    return resp;
  } catch(e) {
    // If image failed (offline), return a transparent pixel
    return new Response(
      '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect fill="#1a1a2e" width="256" height="256"/></svg>',
      { headers: { 'Content-Type': 'image/svg+xml' } }
    );
  }
}
