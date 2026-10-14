// Zugriff auf die öffentliche archive.org-API (CORS-fähig, kein Key nötig).

const BASE = 'https://archive.org';

export const coverUrl = (id) => `${BASE}/services/img/${encodeURIComponent(id)}`;

export const trackUrl = (id, name) =>
  `${BASE}/download/${encodeURIComponent(id)}/${name.split('/').map(encodeURIComponent).join('/')}`;

export const itemPageUrl = (id) => `${BASE}/details/${encodeURIComponent(id)}`;

const FILTERS = {
  audiobooks: 'mediatype:audio AND (collection:librivoxaudio OR collection:audio_bookspoetry OR subject:audiobook OR subject:hörbuch)',
  librivox: 'mediatype:audio AND collection:librivoxaudio',
  german: 'mediatype:audio AND (language:ger OR language:German OR language:deu OR language:Deutsch)',
  all: 'mediatype:audio',
};

export async function search(query, { filter = 'audiobooks', page = 1, rows = 36, sort = '' } = {}) {
  const parts = [];
  if (query && query.trim()) parts.push(`(${query.trim()})`);
  parts.push(`(${FILTERS[filter] || FILTERS.all})`);
  const params = new URLSearchParams({ q: parts.join(' AND '), rows: String(rows), page: String(page), output: 'json' });
  for (const f of ['identifier', 'title', 'creator', 'downloads', 'year']) params.append('fl[]', f);
  if (sort) params.append('sort[]', sort);
  else if (!query || !query.trim()) params.append('sort[]', 'downloads desc');

  const res = await fetch(`${BASE}/advancedsearch.php?${params}`);
  if (!res.ok) throw new Error(`Suche fehlgeschlagen (${res.status})`);
  const data = await res.json();
  return {
    total: data.response?.numFound ?? 0,
    items: (data.response?.docs ?? []).map((d) => ({
      id: d.identifier,
      title: first(d.title) || d.identifier,
      creator: first(d.creator) || '',
      downloads: d.downloads || 0,
      year: d.year || '',
    })),
  };
}

// Suche wie auf archive.org selbst: alle Medientypen, gleiche Relevanz-Sortierung.
// Danach bleibt nur, was sich wirklich abspielen lässt (Audio oder Video mit Tonspur, nicht gesperrt).
const SEARCH_FILTERS = {
  all: {},
  audiobooks: { collection: { librivoxaudio: 'inc', audio_bookspoetry: 'inc' } },
  german: { language: { German: 'inc' } },
};
const PLAYABLE = /mp3|ogg|m4a|aac|opus|flac|wave|h\.264|mpeg4/i;

async function playableIds(ids) {
  const p = new URLSearchParams({ q: `identifier:(${ids.map((id) => `"${id}"`).join(' OR ')})`, rows: String(ids.length), output: 'json' });
  for (const f of ['identifier', 'format', 'access-restricted-item']) p.append('fl[]', f);
  const res = await fetch(`${BASE}/advancedsearch.php?${p}`);
  if (!res.ok) throw new Error(String(res.status));
  const docs = (await res.json()).response?.docs || [];
  return new Set(docs
    .filter((d) => String(d['access-restricted-item']) !== 'true' && [].concat(d.format || []).some((f) => PLAYABLE.test(f)))
    .map((d) => d.identifier));
}

export async function searchArchive(query, { filter = 'all', page = 1, rows = 36 } = {}) {
  const params = new URLSearchParams({
    user_query: query.trim(),
    page_type: 'search_results',
    hits_per_page: String(rows),
    page: String(page),
  });
  const filterMap = SEARCH_FILTERS[filter];
  if (filterMap && Object.keys(filterMap).length) params.set('filter_map', JSON.stringify(filterMap));
  const res = await fetch(`${BASE}/services/search/beta/page_production/?${params}`);
  const hits = res.ok ? (await res.json()).response?.body?.hits : null;
  if (!hits) throw new Error(`Suche fehlgeschlagen (${res.status})`);
  let items = (hits.hits || []).map(({ fields: d }) => ({
    id: d.identifier,
    title: first(d.title) || d.identifier,
    creator: first(d.creator) || '',
    downloads: d.downloads || 0,
    year: d.year || '',
    video: d.mediatype === 'movies',
  }));
  if (items.length) {
    try {
      const ok = await playableIds(items.map((i) => i.id));
      items = items.filter((i) => ok.has(i.id));
    } catch { /* Formatprüfung fehlgeschlagen: lieber alles zeigen */ }
  }
  return { total: hits.total ?? 0, items, hasMore: page * rows < (hits.total ?? 0) };
}

const itemCache = new Map();
const resolved = new Map();

// Bereits geladene Titel synchron liefern (wichtig für iOS: play() muss direkt im Tap passieren).
export const cachedItem = (id) => resolved.get(id) || null;

export async function getItem(id) {
  if (itemCache.has(id)) return itemCache.get(id);
  const promise = (async () => {
    const res = await fetch(`${BASE}/metadata/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`Titel konnte nicht geladen werden (${res.status})`);
    const data = await res.json();
    if (!data.metadata) throw new Error('Diesen Titel gibt es auf archive.org nicht (mehr).');
    const m = data.metadata;
    return {
      id,
      title: first(m.title) || id,
      creator: first(m.creator) || '',
      description: first(m.description) || '',
      year: first(m.year) || first(m.date) || '',
      language: first(m.language) || '',
      tracks: pickTracks(data.files || []),
      cover: pickCover(id, data.files || []),
    };
  })();
  itemCache.set(id, promise);
  promise.then((item) => resolved.set(id, item), () => itemCache.delete(id));
  return promise;
}

// Aus allen Dateien eines Items eine Spur pro Kapitel wählen (beste abspielbare Variante).
// Videoformate (Rang ≥ 30) nur, wenn es keine Audiodateien gibt; <audio> spielt deren Tonspur.
const FORMAT_RANK = ['VBR MP3', '128Kbps MP3', 'MP3', '64Kbps MP3', '96Kbps MP3', '160Kbps MP3', '192Kbps MP3', '256Kbps MP3', '320Kbps MP3', '32Kbps MP3', 'Ogg Vorbis', 'M4A', 'AAC', 'Opus'];
const VIDEO_RANK = ['512Kb MPEG4', 'h.264 IA', 'h.264', 'MPEG4', 'h.264 HD'];
const EXTRA_AUDIO = ['Flac', '24bit Flac', 'WAVE'];

function rank(format) {
  const i = FORMAT_RANK.indexOf(format);
  if (i >= 0) return i;
  if (/mp3/i.test(format)) return 20;
  if (EXTRA_AUDIO.includes(format)) return 25;
  const v = VIDEO_RANK.indexOf(format);
  if (v >= 0) return 30 + v;
  return -1;
}

export function pickTracks(files) {
  const groups = new Map();
  for (const f of files) {
    if (String(f.private) === 'true') continue; // gesperrte Dateien lassen sich nicht laden
    const r = rank(f.format || '');
    if (r < 0) continue;
    const key = f.source === 'derivative' && f.original ? f.original : f.name;
    const cur = groups.get(key);
    if (!cur || r < cur.r) groups.set(key, { r, f });
  }
  const hasAudio = [...groups.values()].some((g) => g.r < 30);
  const tracks = [...groups.entries()].filter(([, g]) => !hasAudio || g.r < 30).map(([key, { f }]) => {
    const orig = files.find((x) => x.name === key) || f;
    return {
      name: f.name,
      title: cleanTitle(orig.title || f.title, f.name),
      duration: parseLength(orig.length || f.length),
      trackNo: parseInt(String(orig.track || f.track || '').split('/')[0], 10),
      sortName: key,
    };
  });
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const allNumbered = tracks.length > 1 && tracks.every((t) => Number.isFinite(t.trackNo)) &&
    new Set(tracks.map((t) => t.trackNo)).size === tracks.length;
  tracks.sort((a, b) => (allNumbered ? a.trackNo - b.trackNo : collator.compare(a.sortName, b.sortName)));
  return tracks.map(({ name, title, duration }) => ({ name, title, duration }));
}

// Großes Originalbild (falls vorhanden) statt der kleinen Kachel.
function pickCover(id, files) {
  const img = files
    .filter((f) => f.source === 'original' && /^(JPEG|PNG)$/.test(f.format) && !/spectrogram|thumb/i.test(f.name))
    .sort((a, b) => (+b.size || 0) - (+a.size || 0))[0];
  return img && +img.size < 6e6 ? trackUrl(id, img.name) : coverUrl(id);
}

function cleanTitle(title, name) {
  let t = title && String(title).trim();
  if (!t) t = name.split('/').pop().replace(/\.[^.]+$/, '').replace(/_(64|128)kb$/i, '');
  // Dateinamen wie "wonderland_ch_02" lesbar machen
  if (!/\s/.test(t) && /[_-]/.test(t)) t = t.replace(/[_-]+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function parseLength(v) {
  if (v == null || v === '') return 0;
  const s = String(v);
  if (s.includes(':')) return s.split(':').reduce((acc, p) => acc * 60 + (parseFloat(p) || 0), 0);
  return parseFloat(s) || 0;
}

function first(v) {
  return Array.isArray(v) ? v[0] : v;
}
