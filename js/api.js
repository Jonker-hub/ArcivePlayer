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

// Formate + Sperrstatus in Paketen abfragen (lange Anfragen lehnt archive.org ab).
async function playableIds(ids) {
  const chunks = [];
  for (let i = 0; i < ids.length; i += 20) chunks.push(ids.slice(i, i + 20));
  const results = await Promise.all(chunks.map(async (chunk) => {
    const q = chunk.map((id) => (/^[\w.-]+$/.test(id) ? id : `"${id.replace(/"/g, '')}"`)).join(' OR ');
    const p = new URLSearchParams({ q: `identifier:(${q})`, rows: String(chunk.length), output: 'json' });
    for (const f of ['identifier', 'format', 'access-restricted-item']) p.append('fl[]', f);
    const res = await fetch(`${BASE}/advancedsearch.php?${p}`);
    const data = res.ok ? await res.json() : null;
    if (!data?.response) return null; // Prüfung nicht möglich
    return new Set(data.response.docs
      .filter((d) => String(d['access-restricted-item']) !== 'true' && [].concat(d.format || []).some((f) => PLAYABLE.test(f)))
      .map((d) => d.identifier));
  }));
  if (results.some((r) => r === null)) {
    // Teilweise fehlgeschlagen: für diese Einträge grob nach Medientyp entscheiden
    return { ok: new Set(results.filter(Boolean).flatMap((set) => [...set])), failed: chunks.filter((_, i) => !results[i]).flat() };
  }
  return { ok: new Set(results.flatMap((set) => [...set])), failed: [] };
}

// Viele Uploads sind schlecht beschriftet (z. B. Titel nur „Zero To One“, Autor leer); der Name steckt
// dann oft nur in der Kennung wie „ZeroToOnePeterThielUnabridged“. Die normale Suche zerlegt die
// Kennung nicht in Wörter, daher zusätzlich: Kennungen, die mit aufeinanderfolgenden Suchwörtern
// beginnen (zerotoone*, zero-to-one*, zero_to_one*, peterthiel* …). Präfix-Suchen sind schnell.
function identifierPrefixes(query) {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).slice(0, 8);
  const out = new Set();
  if (words.length === 1 && words[0].length >= 5) out.add(`${words[0]}*`);
  for (let n = Math.min(4, words.length); n >= 2; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const gram = words.slice(i, i + n);
      if (gram.join('').length < 8) continue; // kurze Präfixe wie „zeroto*“ treffen zu viel
      for (const sep of ['', '-', '_']) out.add(`${gram.join(sep)}*`);
    }
  }
  return [...out].slice(0, 36);
}

async function identifierSearch(query, filter) {
  const prefixes = identifierPrefixes(query);
  if (!prefixes.length) return [];
  const parts = [`identifier:(${prefixes.join(' OR ')})`];
  if (filter === 'audiobooks') parts.push('(collection:librivoxaudio OR collection:audio_bookspoetry)');
  if (filter === 'german') parts.push('(language:ger OR language:German OR language:deu)');
  const p = new URLSearchParams({ q: parts.join(' AND '), rows: '60', output: 'json' });
  for (const f of ['identifier', 'title', 'creator', 'downloads', 'year', 'mediatype']) p.append('fl[]', f);
  const res = await fetch(`${BASE}/advancedsearch.php?${p}`);
  if (!res.ok) return [];
  return ((await res.json()).response?.docs || []).map((d) => ({
    id: d.identifier,
    title: first(d.title) || d.identifier,
    creator: first(d.creator) || '',
    downloads: d.downloads || 0,
    year: d.year || '',
    video: d.mediatype === 'movies',
    mediatype: d.mediatype || '',
  }));
}

export async function searchArchive(query, { filter = 'all', page = 1, rows = 36 } = {}) {
  const extra = page === 1 ? identifierSearch(query, filter).catch(() => []) : Promise.resolve([]);
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
    mediatype: d.mediatype || '',
  }));
  const seen = new Set(items.map((i) => i.id));
  items = [...(await extra).filter((i) => !seen.has(i.id)), ...items];
  if (items.length) {
    try {
      const { ok, failed } = await playableIds(items.map((i) => i.id));
      const unknown = new Set(failed);
      items = items.filter((i) => ok.has(i.id) || (unknown.has(i.id) && /audio|movies|etree/.test(i.mediatype)));
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
