// Lokaler Zustand: Hörfortschritt, Merkliste, Einstellungen.
// Jeder Eintrag trägt `updatedAt`, damit sich Stände verschiedener Geräte zusammenführen lassen.

const KEY = 'arciveplayer:v1';
const listeners = new Set();

function empty() {
  return { progress: {}, favorites: {}, settings: { rate: 1 }, lastId: null, lastAt: 0 };
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...empty(), ...JSON.parse(raw) };
  } catch { /* privater Modus o. ä. */ }
  return empty();
}

let state = load();

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* Speicher voll/blockiert */ }
  for (const fn of listeners) fn(state);
}

// Änderungen aus einem anderen Tab übernehmen.
window.addEventListener('storage', (e) => {
  if (e.key !== KEY) return;
  state = load();
  for (const fn of listeners) fn(state);
});

export const store = {
  get: () => state,
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  progress: (id) => state.progress[id] || null,

  saveProgress(id, data) {
    const prev = state.progress[id] || { doneTracks: {} };
    state.progress[id] = { ...prev, ...data, id, updatedAt: Date.now() };
    state.lastId = id;
    state.lastAt = Date.now();
    persist();
  },

  markTrackDone(id, trackName, done = true) {
    const prev = state.progress[id] || { id, doneTracks: {} };
    const doneTracks = { ...(prev.doneTracks || {}) };
    if (done) doneTracks[trackName] = true; else delete doneTracks[trackName];
    state.progress[id] = { ...prev, doneTracks, updatedAt: Date.now() };
    persist();
  },

  removeProgress(id) {
    // Tombstone statt Löschen, damit Sync das Entfernen nicht wieder rückgängig macht.
    state.progress[id] = { id, removed: true, updatedAt: Date.now() };
    if (state.lastId === id) state.lastId = null;
    persist();
  },

  isFavorite: (id) => !!(state.favorites[id] && !state.favorites[id].removed),

  toggleFavorite(item) {
    const on = !store.isFavorite(item.id);
    state.favorites[item.id] = on
      ? { id: item.id, title: item.title, creator: item.creator, addedAt: Date.now(), updatedAt: Date.now() }
      : { id: item.id, removed: true, updatedAt: Date.now() };
    persist();
    return on;
  },

  setSetting(key, value) {
    state.settings = { ...state.settings, [key]: value };
    persist();
  },

  continueList() {
    return Object.values(state.progress)
      .filter((p) => !p.removed && !p.finished && p.title)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  },

  favoriteList() {
    return Object.values(state.favorites)
      .filter((f) => !f.removed)
      .sort((a, b) => b.addedAt - a.addedAt);
  },

  // Für Sync: fremden Zustand einmischen, pro Eintrag gewinnt der neuere.
  merge(remote) {
    if (!remote) return false;
    let changed = false;
    for (const bucket of ['progress', 'favorites']) {
      for (const [id, r] of Object.entries(remote[bucket] || {})) {
        const l = state[bucket][id];
        if (!l || (r.updatedAt || 0) > (l.updatedAt || 0)) { state[bucket][id] = r; changed = true; }
      }
    }
    if ((remote.lastAt || 0) > (state.lastAt || 0)) {
      state.lastId = remote.lastId; state.lastAt = remote.lastAt; changed = true;
    }
    if (changed) persist();
    return changed;
  },

  exportJSON: () => JSON.stringify(state),
};
