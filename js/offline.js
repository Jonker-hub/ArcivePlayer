// Downloads für das Hören ohne Internet: Audiodateien landen im Cache Storage des Browsers,
// der Service Worker (sw.js) spielt sie von dort ab – auch im Flugmodus.
// Pro Kapitel wird die kleinste MP3-Variante geladen, aber unter der normalen Abspiel-Adresse
// gespeichert; der Player merkt davon nichts.

import { trackUrl, coverUrl, DOWNLOADS_KEY } from './api.js';

export const DOWNLOAD_CACHE = 'arciveplayer-downloads';
const listeners = new Set();
const running = new Map(); // id -> { controller, done, total }

function readIndex() {
  try { return JSON.parse(localStorage.getItem(DOWNLOADS_KEY) || '{}'); } catch { return {}; }
}
function writeIndex(index) {
  try { localStorage.setItem(DOWNLOADS_KEY, JSON.stringify(index)); } catch { /* Speicher voll */ }
}
function emit(id) {
  for (const fn of listeners) fn(id);
}

export const onDownloadChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const isDownloaded = (id) => readIndex()[id]?.status === 'done';
export const downloadedList = () => Object.values(readIndex()).sort((a, b) => b.at - a.at);

// Fortschritt eines laufenden Downloads (0–1) oder null
export function downloadProgress(id) {
  const r = running.get(id);
  return r ? (r.total ? r.done / r.total : 0) : null;
}

const pickVariant = (track) => {
  const mp3s = (track.variants || []).filter((v) => v.mp3 && v.size);
  if (!mp3s.length) return { name: track.name, size: (track.variants || [])[0]?.size || 0 };
  return mp3s.reduce((a, b) => (b.size < a.size ? b : a));
};

export async function download(item) {
  if (running.has(item.id) || !('caches' in window)) return;
  navigator.storage?.persist?.().catch(() => {}); // Browser bitten, die Downloads nicht wegzuräumen
  const cache = await caches.open(DOWNLOAD_CACHE);
  const plan = item.tracks.map((t) => ({ key: trackUrl(item.id, t.name), ...pickVariant(t) }));
  const state = { controller: new AbortController(), done: 0, total: plan.reduce((s, p) => s + p.size, 0) };
  running.set(item.id, state);

  const index = readIndex();
  index[item.id] = { id: item.id, title: item.title, creator: item.creator, item, status: 'loading', bytes: 0, at: Date.now() };
  writeIndex(index);
  emit(item.id);

  try {
    let bytes = 0;
    for (const p of plan) {
      const existing = await cache.match(p.key);
      if (existing) { // schon geladen (z. B. abgebrochener Download wird fortgesetzt)
        const size = +existing.headers.get('Content-Length') || p.size;
        state.done += p.size; bytes += size; emit(item.id);
        continue;
      }
      const res = await fetch(trackUrl(item.id, p.name), { signal: state.controller.signal });
      if (!res.ok) throw new Error(`Download fehlgeschlagen (${res.status})`);
      const reader = res.body.getReader();
      const chunks = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        state.done += value.length;
        emit(item.id);
      }
      const blob = new Blob(chunks, { type: 'audio/mpeg' });
      await cache.put(p.key, new Response(blob, {
        headers: { 'Content-Type': blob.type, 'Content-Length': String(blob.size), 'Accept-Ranges': 'bytes' },
      }));
      bytes += blob.size;
      state.done += Math.max(0, p.size - got); // Größenangaben aus den Metadaten sind nicht immer exakt
    }
    // Cover für die Offline-Ansicht
    for (const url of new Set([coverUrl(item.id), item.cover].filter(Boolean))) {
      try { const r = await fetch(url); if (r.ok) await cache.put(url, r); } catch { /* ohne Cover geht es auch */ }
    }
    const idx = readIndex();
    idx[item.id] = { ...idx[item.id], status: 'done', bytes, at: Date.now() };
    writeIndex(idx);
  } catch (e) {
    const idx = readIndex();
    if (idx[item.id]) { idx[item.id].status = 'partial'; writeIndex(idx); }
    if (e.name !== 'AbortError') throw e;
  } finally {
    running.delete(item.id);
    emit(item.id);
  }
}

export function cancelDownload(id) {
  running.get(id)?.controller.abort();
}

export async function removeDownload(id) {
  cancelDownload(id);
  const entry = readIndex()[id];
  if ('caches' in window && entry?.item) {
    const cache = await caches.open(DOWNLOAD_CACHE);
    await Promise.all(entry.item.tracks.map((t) => cache.delete(trackUrl(id, t.name))));
  }
  const idx = readIndex();
  delete idx[id];
  writeIndex(idx);
  emit(id);
}

// Belegter Speicher aller Downloads in Bytes
export const downloadedBytes = () => downloadedList().reduce((s, d) => s + (d.bytes || 0), 0);
