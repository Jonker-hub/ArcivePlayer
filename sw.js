// Service Worker:
// - App-Dateien: network-first, offline aus dem Cache (die App startet auch ohne Netz)
// - Bibliotheken vom CDN (Supabase): einmal laden, dann aus dem Cache
// - Heruntergeladene Hörbücher: direkt vom Gerät, inkl. Teilbereichen (Range), die Safari zum Abspielen braucht
const CACHE = 'arciveplayer-v10';
const CDN_CACHE = 'arciveplayer-cdn';
const DOWNLOAD_CACHE = 'arciveplayer-downloads'; // wird nie automatisch gelöscht
const KEEP = [CACHE, CDN_CACHE, DOWNLOAD_CACHE];
const SHELL = ['./', 'index.html', 'css/app.css', 'js/app.js', 'js/api.js', 'js/store.js', 'js/player.js', 'js/icons.js', 'js/ai.js', 'js/config.js', 'js/sync.js', 'js/offline.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-180.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => !KEEP.includes(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // nur Audiodateien und Cover; Suche und Metadaten gehen unverändert ins Netz
  if (url.hostname === 'archive.org' && /^\/(download|services\/img)\//.test(url.pathname)) {
    e.respondWith(fromDownloads(req));
    return;
  }
  if (url.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(caches.open(CDN_CACHE).then(async (c) => {
      const hit = await c.match(req.url);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req.url, res.clone());
      return res;
    }));
    return;
  }
  if (url.origin !== location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
  );
});

// Geladene Datei vom Gerät liefern, sonst normal übers Netz
async function fromDownloads(req) {
  const cache = await caches.open(DOWNLOAD_CACHE);
  const hit = await cache.match(req.url);
  if (!hit) return fetch(req);
  const range = req.headers.get('range');
  if (!range) return hit;
  const blob = await hit.blob();
  const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
  let start = m[1] ? Number(m[1]) : 0;
  let end = m[2] ? Number(m[2]) : blob.size - 1;
  if (!m[1] && m[2]) { start = Math.max(0, blob.size - Number(m[2])); end = blob.size - 1; }
  end = Math.min(end, blob.size - 1);
  if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${blob.size}` } });
  const part = blob.slice(start, end + 1);
  return new Response(part, {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': hit.headers.get('Content-Type') || 'audio/mpeg',
      'Content-Range': `bytes ${start}-${end}/${blob.size}`,
      'Content-Length': String(part.size),
      'Accept-Ranges': 'bytes',
    },
  });
}
