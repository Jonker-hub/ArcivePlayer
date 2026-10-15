// Konto + Sync: Anmeldung per E-Mail (6-stelliger Code oder Link, kein Passwort) über Supabase Auth.
// Hörstand, Merkliste und „Gehört“ liegen am Konto; pro Eintrag gewinnt der neuere Stand.

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.0/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { store } from './store.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
});

const PUSH_DELAY_PLAYING_MS = 15000; // während der Wiedergabe gesammelt
const PUSH_DELAY_IDLE_MS = 1500;     // sonst fast sofort (Pause, Springen, Merkliste)
const listeners = new Set();

let session = null;
let isPlaying = () => false;
let pushTimer = null;
let busy = false;
let status = { state: 'off', at: 0, error: '' }; // off | ok | syncing | error

export const account = () => session?.user?.email || '';
export const syncStatus = () => status;
export const onSyncStatus = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

function setStatus(next) {
  status = { ...status, ...next };
  for (const fn of listeners) fn(status);
}

// Schritt 1: Mail mit Code (und Link) anfordern. Neue Adressen bekommen automatisch ein Konto.
export async function sendCode(email) {
  const { error } = await supabase.auth.signInWithOtp({
    email: email.trim(),
    options: { emailRedirectTo: `${location.origin}${location.pathname}` },
  });
  if (error) throw new Error(error.message);
}

// Schritt 2: Code aus der Mail eingeben.
export async function verifyCode(email, code) {
  const { error } = await supabase.auth.verifyOtp({ email: email.trim(), token: code.replace(/\s/g, ''), type: 'email' });
  if (error) throw new Error(/expired|invalid/i.test(error.message) ? 'Code ungültig oder abgelaufen' : error.message);
}

export async function signOut() {
  await supabase.auth.signOut();
}

// Was synchronisiert wird (Einstellungen wie Tempo bleiben pro Gerät).
const payload = () => {
  const { progress, favorites, lastId, lastAt } = store.get();
  return { progress, favorites, lastId, lastAt };
};

// Holen, zusammenführen, zurückschreiben. Gibt true zurück, wenn sich lokal etwas geändert hat.
export async function syncNow() {
  if (!session || busy) return false;
  busy = true;
  setStatus({ state: 'syncing' });
  try {
    const { data: remote, error } = await supabase.rpc('state_get');
    if (error) throw new Error(error.message);
    const changed = remote ? store.merge(remote) : false;
    const mine = payload();
    if (!remote || JSON.stringify(remote) !== JSON.stringify(mine)) {
      const { error: putError } = await supabase.rpc('state_put', { p_state: mine });
      if (putError) throw new Error(putError.message);
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

// Lokale Änderungen gesammelt hochladen.
function schedulePush() {
  if (!session) return;
  const delay = isPlaying() ? PUSH_DELAY_PLAYING_MS : PUSH_DELAY_IDLE_MS;
  if (pushTimer && delay === PUSH_DELAY_PLAYING_MS) return; // beim Hören höchstens alle 15 s
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { pushTimer = null; syncNow(); }, delay);
}

// Beim Schließen sofort sichern (keepalive überlebt das Entladen der Seite).
function flush() {
  if (!session) return;
  clearTimeout(pushTimer);
  pushTimer = null;
  fetch(`${SUPABASE_URL}/rest/v1/rpc/state_put`, {
    method: 'POST',
    keepalive: true,
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ p_state: payload() }),
  }).catch(() => {});
}

export function startSync(onRemoteChange, playingFn) {
  if (playingFn) isPlaying = playingFn;
  supabase.auth.onAuthStateChange((event, s) => {
    const wasSignedIn = !!session;
    session = s;
    if (!s) { setStatus({ state: 'off', at: 0, error: '' }); return; }
    if (!wasSignedIn) {
      setStatus({ state: 'ok' });
      // Erst nach dem Callback abgleichen (Supabase rät, im Callback keine weiteren Aufrufe abzuwarten)
      setTimeout(() => syncNow().then((changed) => { if (changed) onRemoteChange?.(); }), 0);
    }
  });
  store.subscribe(schedulePush);
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden) flush();
    else if (await syncNow()) onRemoteChange?.();
  });
  setInterval(async () => {
    if (!document.hidden && await syncNow()) onRemoteChange?.();
  }, 60000);
}
