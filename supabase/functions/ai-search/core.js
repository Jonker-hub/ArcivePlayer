// KI-Suche mit Google Gemini (Gratis-Tarif): sucht wie in einem KI-Chat auf archive.org nach Hörbüchern.
// 1. Gemini + Google-Suche findet passende archive.org-Einträge (auch schlecht beschriftete)
// 2. archive.org prüft: gibt es den Eintrag, ist er abspielbar, wie lang, welche Sprache
// 3. Gemini wählt die besten aus und begründet kurz

const MODEL = 'gemini-2.5-flash';
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models';
const BASE = 'https://archive.org';
const PLAYABLE = /mp3|ogg|m4a|aac|opus|flac|wave|h\.264|mpeg4/i;

const first = (v) => (Array.isArray(v) ? v[0] : v);
const strip = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

export class QuotaError extends Error {}

async function gemini(apiKey, body, fetchImpl) {
  const res = await fetchImpl(`${GEMINI}/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 429) throw new QuotaError('Gratis-Kontingent für heute aufgebraucht. Morgen geht es wieder.');
  if (!res.ok) throw new Error(`Gemini-Fehler (${res.status}): ${data.error?.message || ''}`.trim());
  const cand = data.candidates?.[0];
  return {
    text: (cand?.content?.parts || []).map((p) => p.text || '').join(''),
    chunks: cand?.groundingMetadata?.groundingChunks || [],
  };
}

async function getJSON(url, fetchImpl) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`archive.org antwortet mit ${res.status}`);
  return res.json();
}

const ID_RE = /archive\.org\/(?:details|download|embed)\/([A-Za-z0-9._-]+)/g;
const idsFrom = (text) => [...String(text).matchAll(ID_RE)].map((m) => m[1]);

// Google-Quellen sind Weiterleitungs-Links; das Ziel verrät die archive.org-Kennung.
async function resolveChunk(chunk, fetchImpl) {
  const uri = chunk.web?.uri || '';
  if (idsFrom(uri).length) return idsFrom(uri);
  if (!/archive\.org/i.test(chunk.web?.title || '')) return [];
  try {
    const res = await fetchImpl(uri, { redirect: 'manual' });
    return idsFrom(res.headers.get('location') || '');
  } catch {
    return [];
  }
}

// Schritt 1: Google-Suche über Gemini
async function webCandidates(apiKey, query, fetchImpl) {
  const prompt = `Suche mit Google auf archive.org nach Hörbüchern bzw. Audioaufnahmen zu folgender Anfrage:
"${query}"

Suche mehrfach (z. B. site:archive.org mit Titel, Originaltitel, Autor:in, „audiobook“, „hörbuch“, „unabridged“).
Antworte nur mit einer Liste der passendsten archive.org-Adressen (bis zu 12), eine pro Zeile, im Format
https://archive.org/details/<identifier> – <kurze Beschreibung>
Danach eine Zeile „SUCHBEGRIFFE:“ mit 2–4 kurzen Suchbegriffen, mit denen man das Werk auf archive.org finden würde (durch ; getrennt).`;
  const { text, chunks } = await gemini(apiKey, {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
  }, fetchImpl);
  const fromChunks = (await Promise.all(chunks.slice(0, 15).map((c) => resolveChunk(c, fetchImpl)))).flat();
  const terms = (text.match(/SUCHBEGRIFFE:\s*(.+)/i)?.[1] || '').split(';').map((s) => s.trim()).filter(Boolean).slice(0, 4);
  return { ids: [...idsFrom(text), ...fromChunks], terms };
}

function identifierPrefixes(query) {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).slice(0, 8);
  const out = new Set();
  if (words.length === 1 && words[0].length >= 5) out.add(`${words[0]}*`);
  for (let n = Math.min(4, words.length); n >= 2; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const gram = words.slice(i, i + n);
      if (gram.join('').length < 8) continue;
      for (const sep of ['', '-', '_']) out.add(`${gram.join(sep)}*`);
    }
  }
  return [...out].slice(0, 36);
}

// archive.org-Suche (wie auf der Webseite) + Kennungs-Präfixe
async function archiveCandidates(query, fetchImpl) {
  const pp = new URLSearchParams({ user_query: query, page_type: 'search_results', hits_per_page: '25', page: '1' });
  const prefixes = identifierPrefixes(query);
  const idq = new URLSearchParams({ q: `identifier:(${prefixes.join(' OR ')})`, rows: '20', output: 'json' });
  idq.append('fl[]', 'identifier');
  const [a, b] = await Promise.allSettled([
    getJSON(`${BASE}/services/search/beta/page_production/?${pp}`, fetchImpl),
    prefixes.length ? getJSON(`${BASE}/advancedsearch.php?${idq}`, fetchImpl) : Promise.resolve(null),
  ]);
  const ids = [];
  if (b.status === 'fulfilled' && b.value) ids.push(...(b.value.response?.docs || []).map((d) => d.identifier));
  if (a.status === 'fulfilled') ids.push(...(a.value.response?.body?.hits?.hits || []).map((h) => h.fields.identifier));
  return ids;
}

// Schritt 2: Kandidaten auf archive.org prüfen (abspielbar, nicht gesperrt) und Details holen
async function describe(ids, fetchImpl) {
  const ok = new Map();
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    const p = new URLSearchParams({ q: `identifier:(${chunk.join(' OR ')})`, rows: String(chunk.length), output: 'json' });
    for (const f of ['identifier', 'title', 'creator', 'mediatype', 'language', 'downloads', 'format', 'access-restricted-item']) p.append('fl[]', f);
    try {
      const data = await getJSON(`${BASE}/advancedsearch.php?${p}`, fetchImpl);
      for (const d of data.response?.docs || []) {
        if (String(d['access-restricted-item']) === 'true' || ![].concat(d.format || []).some((f) => PLAYABLE.test(f))) continue;
        ok.set(d.identifier, {
          id: d.identifier,
          title: first(d.title) || d.identifier,
          creator: first(d.creator) || '',
          video: d.mediatype === 'movies',
          language: [].concat(d.language || []).join(', '),
          downloads: d.downloads || 0,
        });
      }
    } catch { /* Paket übersprungen */ }
  }
  return ok;
}

async function details(item, fetchImpl) {
  try {
    const data = await getJSON(`${BASE}/metadata/${encodeURIComponent(item.id)}`, fetchImpl);
    const files = (data.files || []).filter((f) => String(f.private) !== 'true' && PLAYABLE.test(f.format || ''));
    const originals = files.filter((f) => f.source === 'original');
    const tracks = originals.length ? originals : files;
    const seconds = tracks.reduce((s, f) => s + parseLength(f.length), 0);
    return { ...item, description: strip(first(data.metadata?.description)).slice(0, 300), files: tracks.length, minutes: Math.round(seconds / 60) };
  } catch {
    return item;
  }
}

function parseLength(v) {
  if (v == null || v === '') return 0;
  const s = String(v);
  if (s.includes(':')) return s.split(':').reduce((acc, p) => acc * 60 + (parseFloat(p) || 0), 0);
  return parseFloat(s) || 0;
}

// Schritt 3: Auswahl durch Gemini (JSON)
async function choose(apiKey, query, candidates, fetchImpl) {
  const list = candidates.map((c) => ({
    identifier: c.id, title: c.title, creator: c.creator, language: c.language, video: c.video,
    minutes: c.minutes, files: c.files, downloads: c.downloads, description: c.description,
  }));
  const prompt = `Anfrage: "${query}"

Kandidaten von archive.org (alle abspielbar):
${JSON.stringify(list)}

Wähle die besten Treffer für die Anfrage (höchstens 8), das beste zuerst.
Vollständige Hörbücher/Lesungen vor Zusammenfassungen, Rezensionen oder Podcasts über das Werk; Zusammenfassungen dürfen als Alternative dabei sein.
Sucht die Person auf Deutsch, deutsche Aufnahmen zuerst, wenn vorhanden. Unpassendes weglassen.
Begründe jeden Treffer mit einem kurzen deutschen Satz (z. B. „Vollständige Lesung, ca. 5 Std., Englisch“).`;
  const { text } = await gemini(apiKey, {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          interpretation: { type: 'STRING', description: 'Ein kurzer deutscher Satz: was gesucht und was gefunden wurde.' },
          results: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: { identifier: { type: 'STRING' }, reason: { type: 'STRING' } },
              required: ['identifier', 'reason'],
            },
          },
        },
        required: ['interpretation', 'results'],
      },
    },
  }, fetchImpl);
  return JSON.parse(text);
}

export async function aiSearch(apiKey, userQuery, fetchImpl = fetch) {
  const web = await webCandidates(apiKey, userQuery, fetchImpl).catch((e) => {
    if (e instanceof QuotaError) throw e;
    return { ids: [], terms: [] };
  });
  const archiveLists = await Promise.all([userQuery, ...web.terms].map((q) => archiveCandidates(q, fetchImpl).catch(() => [])));

  // Google-Funde zuerst, dann archive.org-Suchen abwechselnd
  const ordered = [...web.ids];
  for (let i = 0; i < 25; i++) for (const l of archiveLists) if (l[i]) ordered.push(l[i]);
  const unique = [...new Set(ordered)].filter((id) => /^[\w.-]+$/.test(id)).slice(0, 80);

  const valid = await describe(unique, fetchImpl);
  const candidates = await Promise.all(unique.filter((id) => valid.has(id)).slice(0, 25).map((id) => details(valid.get(id), fetchImpl)));
  if (!candidates.length) return { interpretation: 'Auf archive.org habe ich dazu nichts Abspielbares gefunden.', results: [] };

  const picked = await choose(apiKey, userQuery, candidates, fetchImpl);
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const results = (picked.results || [])
    .filter((r, i, all) => byId.has(r.identifier) && all.findIndex((x) => x.identifier === r.identifier) === i)
    .slice(0, 8)
    .map((r) => {
      const c = byId.get(r.identifier);
      return { id: c.id, title: c.title, creator: c.creator, video: c.video, reason: r.reason };
    });
  return { interpretation: picked.interpretation || '', results };
}
