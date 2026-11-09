// Service Worker:
// - App-Dateien: network-first, offline aus dem Cache (die App startet auch ohne Netz)
// - Bibliotheken vom CDN (Supabase): einmal laden, dann aus dem Cache
// - Abspielen (vom Player mit ?play=1 markiert): heruntergeladene Titel direkt vom Gerät,
//   sonst aus dem Puffer – die Datei wird in 2-MB-Stücken geladen und im Cache gehalten,
//   damit kurze Netzaussetzer nicht zu Stopps führen. Antworten immer als Teilbereich (Range),
//   den Safari zum Abspielen braucht.
const CACHE = 'arciveplayer-v13';
const CDN_CACHE = 'arciveplayer-cdn';
const DOWNLOAD_CACHE = 'arciveplayer-downloads'; // wird nie automatisch gelöscht
const BUFFER_CACHE = 'arciveplayer-buffer'; // räumt js/buffer.js auf
const SEG = 2 * 1024 * 1024; // muss zu js/buffer.js passen
const KEEP = [CACHE, CDN_CACHE, DOWNLOAD_CACHE, BUFFER_CACHE];
const SHELL = ['./', 'index.html', 'css/app.css', 'js/app.js', 'js/api.js', 'js/store.js', 'js/player.js', 'js/icons.js', 'js/ai.js', 'js/config.js', 'js/sync.js', 'js/offline.js', 'js/buffer.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-180.png'];

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

  // Nur markierte Abspiel-Adressen und Cover. Unmarkierte Anfragen (Download, Ausweichdateien)
  // reicht der Service Worker nicht durch – Safari bricht durchgereichte Streams mit Netzwerkfehler ab.
  if (url.hostname === 'archive.org') {
    if (url.pathname.startsWith('/download/') && url.searchParams.has('play')) {
      e.respondWith(media(req, url.origin + url.pathname).catch(() => Response.error()));
      return;
    }
    if (url.pathname.startsWith('/services/img/')) {
      e.respondWith(caches.open(DOWNLOAD_CACHE).then((c) => c.match(req.url)).then((hit) => hit || fetch(req)));
      return;
    }
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

// Gewünschten Bereich aus "bytes=a-b" bestimmen; ohne Angabe ab Anfang
function parseRange(header, size) {
  const m = /bytes=(\d*)-(\d*)/.exec(header || '') || [];
  let start = m[1] ? Number(m[1]) : 0;
  let end = m[2] ? Number(m[2]) : size - 1;
  if (!m[1] && m[2]) { start = Math.max(0, size - Number(m[2])); end = size - 1; }
  return [start, Math.min(end, size - 1)];
}

function partial(blob, offset, start, end, size, type) {
  const part = blob.slice(start - offset, end - offset + 1);
  return new Response(part, {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': type || 'audio/mpeg',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(part.size),
      'Accept-Ranges': 'bytes',
    },
  });
}

const notSatisfiable = (size) => new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });

async function media(req, key) {
  const hit = await (await caches.open(DOWNLOAD_CACHE)).match(key);
  if (hit) { // heruntergeladen: komplett vom Gerät
    const blob = await hit.blob();
    const [start, end] = parseRange(req.headers.get('range'), blob.size);
    if (start > end) return notSatisfiable(blob.size);
    return partial(blob, 0, start, end, blob.size, hit.headers.get('Content-Type'));
  }
  // Puffer: nur das Stück liefern, in dem der Bereich beginnt; der Player fragt den Rest nach.
  const meta = await bufferMeta(key);
  const [start, end] = parseRange(req.headers.get('range'), meta.size);
  if (start > end) return notSatisfiable(meta.size);
  const i = Math.floor(start / SEG);
  const seg = await segment(key, i, meta);
  return partial(seg, i * SEG, start, Math.min(end, i * SEG + seg.size - 1), meta.size, meta.type);
}

// Netzanfrage mit Zeitlimit und Wiederholungen (kurze Aussetzer überbrücken)
async function fetchRetry(url, init = {}, tries = 4) {
  for (let n = 0; ; n++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      if (res.ok) return res;
      if (res.status < 500 && res.status !== 429) throw Object.assign(new Error(`HTTP ${res.status}`), { final: true });
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (err.final || n >= tries - 1) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** n));
    } finally {
      clearTimeout(timer);
    }
  }
}

const inflight = new Map(); // gleiche Stücke nicht doppelt laden

function once(id, fn) {
  if (!inflight.has(id)) inflight.set(id, fn().finally(() => inflight.delete(id)));
  return inflight.get(id);
}

// Größe und Typ der Datei (Content-Range ist für Skripte nicht lesbar, Content-Length schon)
function bufferMeta(key) {
  return once(`${key}?meta`, async () => {
    const c = await caches.open(BUFFER_CACHE);
    const hit = await c.match(`${key}?meta`);
    if (hit) return hit.json();
    const res = await fetchRetry(key, { method: 'HEAD' }, 2); // scheitert auch an fehlender CORS-Freigabe – dann schnell aufgeben
    const meta = { size: Number(res.headers.get('Content-Length')), type: (res.headers.get('Content-Type') || '').split(';')[0] };
    if (!meta.size) throw new Error('Größe unbekannt');
    await c.put(`${key}?meta`, new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
    return meta;
  });
}

function segment(key, i, meta) {
  const id = `${key}?seg=${i}`;
  return once(id, async () => {
    const c = await caches.open(BUFFER_CACHE);
    const hit = await c.match(id);
    if (hit) return hit.blob();
    const s = i * SEG, e = Math.min(meta.size, s + SEG) - 1;
    const res = await fetchRetry(key, { headers: { Range: `bytes=${s}-${e}` } });
    let blob = await res.blob();
    if (res.status === 200 && blob.size === meta.size) blob = blob.slice(s, e + 1); // Server ohne Range
    if (blob.size !== e - s + 1) throw new Error('Stück unvollständig');
    await c.put(id, new Response(blob, { headers: { 'Content-Type': meta.type } }));
    return blob;
  });
}
