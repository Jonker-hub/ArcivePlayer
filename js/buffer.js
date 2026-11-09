// Vorpuffern: Während ein Titel läuft, werden die nächsten Minuten der Datei (und am Kapitelende
// der Anfang des nächsten Kapitels) stückweise in den Cache geladen. Der Service Worker (sw.js)
// spielt die markierte Adresse aus diesen Stücken ab – so überbrückt der Player Funklöcher.

export const BUFFER_CACHE = 'arciveplayer-buffer';
export const SEG = 2 * 1024 * 1024; // muss zu sw.js passen

const AHEAD_SEC = 15 * 60;            // so weit voraus laden …
const AHEAD_MAX = 40 * 1024 * 1024;   // … aber höchstens so viel (Videos)
const BEHIND_MAX = 40 * 1024 * 1024;  // so viel hinter der Position behalten (Zurückspulen)
const NEXT_SEGS = 2;                  // vom nächsten Kapitel vorab

// Nur mit aktivem Service Worker – ohne ihn streamt der Browser direkt.
export const canBuffer = () => 'caches' in window && !!navigator.serviceWorker?.controller;
export const playUrl = (url) => `${url}?play=1`;

let want = null;   // { url, pos, dur, next }
let running = false;

// Puffer für die aktuelle Position auffüllen. `pos`/`dur` in Sekunden, `next` = URL des nächsten Kapitels.
export function fill(url, pos, dur, next) {
  if (!canBuffer()) return;
  want = { url, pos, dur, next };
  if (!running) loop();
}

export function stop() { want = null; }

async function loop() {
  running = true;
  try {
    while (want) {
      const job = want;
      const cache = await caches.open(BUFFER_CACHE);
      const meta = await getMeta(cache, job.url);
      if (want !== job) continue;
      const segs = Math.ceil(meta.size / SEG);
      const bytesPerSec = job.dur > 0 ? meta.size / job.dur : meta.size / 3600;
      const from = Math.floor((job.pos * bytesPerSec) / SEG);
      const to = Math.min(segs - 1, Math.floor((job.pos * bytesPerSec + Math.min(AHEAD_MAX, AHEAD_SEC * bytesPerSec)) / SEG));
      await prune(cache, job.url, job.next, from - Math.ceil(BEHIND_MAX / SEG));
      const missing = await firstMissing(cache, job.url, from, to);
      if (want !== job) continue;
      if (missing != null) { await touch(job.url, missing); continue; }
      // Bis zum Ende gepuffert: Anfang des nächsten Kapitels
      if (to === segs - 1 && job.next) {
        const nextMissing = await firstMissing(cache, job.next, 0, NEXT_SEGS - 1);
        if (nextMissing != null) { await touch(job.next, nextMissing); continue; }
      }
      if (want === job) want = null; // alles da
    }
  } catch {
    // Netz weg o. Ä.: beim nächsten fill() erneut versuchen
    await new Promise((r) => setTimeout(r, 3000));
    want = null;
  } finally {
    running = false;
  }
}

async function getMeta(cache, url) {
  let hit = await cache.match(`${url}?meta`);
  if (!hit) { await touch(url, 0); hit = await cache.match(`${url}?meta`); }
  if (!hit) throw new Error('keine Dateigröße');
  return hit.json();
}

async function firstMissing(cache, url, from, to) {
  for (let i = Math.max(0, from); i <= to; i++) if (!(await cache.match(`${url}?seg=${i}`))) return i;
  return null;
}

// Ein Byte des Stücks anfragen – der Service Worker lädt und speichert dabei das ganze Stück.
async function touch(url, i) {
  const res = await fetch(playUrl(url), { headers: { Range: `bytes=${i * SEG}-${i * SEG}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await res.arrayBuffer();
}

// Andere Dateien und weit zurückliegende Stücke löschen, damit der Puffer klein bleibt.
const norm = (x) => { if (!x) return ''; const u = new URL(x); return u.origin + u.pathname; };

async function prune(cache, url, next, keepFrom) {
  url = norm(url); next = norm(next);
  for (const req of await cache.keys()) {
    const u = new URL(req.url);
    const base = u.origin + u.pathname;
    const seg = u.searchParams.get('seg');
    if (base !== url && base !== next) await cache.delete(req);
    else if (base === url && seg != null && Number(seg) < keepFrom) await cache.delete(req);
  }
}
