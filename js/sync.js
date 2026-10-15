// Geräte-Sync ohne Konto: Alle Geräte mit demselben geheimen Sync-Code teilen Hörstand und Merkliste.
// Gespeichert wird im Supabase-Projekt; pro Eintrag gewinnt der neuere Stand (store.merge).

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { store } from './store.js';

const KEY = 'arciveplayer:sync-code';
const PUSH_DELAY_PLAYING_MS = 15000; // während der Wiedergabe gesammelt
const PUSH_DELAY_IDLE_MS = 1500;     // sonst fast sofort (Pause, Springen, Merkliste)
let isPlaying = () => false;
const listeners = new Set();

let pushTimer = null;
let busy = false;
let status = { state: 'off', at: 0, error: '' }; // off | ok | syncing | error

function readCode() {
  try { return localStorage.getItem(KEY) || ''; } catch { return ''; }
}

export const syncCode = () => readCode();
export const syncStatus = () => status;
export const onSyncStatus = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

function setStatus(next) {
  status = { ...status, ...next };
  for (const fn of listeners) fn(status);
}

export function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
  return chars.match(/.{1,5}/g).join('-'); // z. B. k3fq9-m2xpa-77hdr-q8vwe
}

export const syncLink = (code = readCode()) => `${location.origin}${location.pathname}#/sync/${code}`;

async function rpc(fn, body, keepalive = false) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    keepalive,
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Sync fehlgeschlagen (${res.status})`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Was synchronisiert wird (Einstellungen wie Tempo bleiben pro Gerät).
const payload = () => {
  const { progress, favorites, lastId, lastAt } = store.get();
  return { progress, favorites, lastId, lastAt };
};

// Holen, zusammenführen, zurückschreiben. Gibt true zurück, wenn sich lokal etwas geändert hat.
export async function syncNow() {
  const code = readCode();
  if (!code || busy) return false;
  busy = true;
  setStatus({ state: 'syncing' });
  try {
    const remote = await rpc('sync_get', { p_key: code });
    const changed = remote ? store.merge(remote) : false;
    const mine = payload();
    if (!remote || JSON.stringify(remote) !== JSON.stringify(mine)) {
      await rpc('sync_put', { p_key: code, p_state: mine });
    }
    setStatus({ state: 'ok', at: Date.now(), error: '' });
    return changed;
  } catch (e) {
    setStatus({ state: 'error', error: e.message });
    return false;
  } finally {
    busy = false;
  }
}

export async function connect(code) {
  code = String(code || '').trim().toLowerCase();
  if (code.length < 20) throw new Error('Ungültiger Sync-Code');
  try { localStorage.setItem(KEY, code); } catch { /* ignorieren */ }
  return syncNow();
}

export function disconnect() {
  try { localStorage.removeItem(KEY); } catch { /* ignorieren */ }
  setStatus({ state: 'off', at: 0, error: '' });
}

// Lokale Änderungen gesammelt hochladen.
function schedulePush() {
  if (!readCode()) return;
  const delay = isPlaying() ? PUSH_DELAY_PLAYING_MS : PUSH_DELAY_IDLE_MS;
  if (pushTimer && delay === PUSH_DELAY_PLAYING_MS) return; // beim Hören höchstens alle 15 s
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { pushTimer = null; syncNow(); }, delay);
}

// Beim Schließen sofort sichern (keepalive überlebt das Entladen der Seite).
function flush() {
  const code = readCode();
  if (!code) return;
  clearTimeout(pushTimer);
  pushTimer = null;
  rpc('sync_put', { p_key: code, p_state: payload() }, true).catch(() => {});
}

export function startSync(onRemoteChange, playingFn) {
  if (playingFn) isPlaying = playingFn;
  store.subscribe(schedulePush);
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden) flush();
    else if (await syncNow()) onRemoteChange?.();
  });
  setInterval(async () => {
    if (!document.hidden && await syncNow()) onRemoteChange?.();
  }, 60000);
  if (readCode()) setStatus({ state: 'ok' });
  return syncNow().then((changed) => { if (changed) onRemoteChange?.(); });
}
