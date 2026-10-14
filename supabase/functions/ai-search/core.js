// KI-Suche über OpenRouter (Claude Haiku 5.5) als Such-Agent: sucht wie ein KI-Chat auf archive.org –
// per Websuche (nur archive.org) und mit eigenen archive.org-Werkzeugen –, prüft Kandidaten
// (vollständig?, Länge, Sprache) und wählt die besten aus.

const MODEL = 'anthropic/claude-haiku-5.5';
const OPENROUTER = 'https://openrouter.ai/api/v1/chat/completions';
const BASE = 'https://archive.org';
const PLAYABLE = /mp3|ogg|m4a|aac|opus|flac|wave|h\.264|mpeg4/i;
const MAX_ROUNDS = 8;

const first = (v) => (Array.isArray(v) ? v[0] : v);
const strip = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

export class QuotaError extends Error {}
export class BusyError extends Error {}

const SYSTEM = `Du findest Hörbücher und andere Audioaufnahmen auf archive.org für eine Person, die frei beschreibt, was sie hören möchte (Titel, Autor:in, Thema oder Beschreibung, oft auf Deutsch, auch mit Tippfehlern).

Vorgehen:
1. Überlege, welches Werk gemeint ist (Originaltitel, Übersetzungen, Schreibvarianten, Autor:in).
2. Suche im Web (nur archive.org) und gründlich mit search_archive – mehrere Anfragen, z. B. Originaltitel, deutscher Titel, Titel + Autor:in, Titel + „audiobook“/„hörbuch“/„unabridged“.
3. Viele Uploads sind schlecht beschriftet (Titel unvollständig, Autor leer). Der Name steckt dann oft nur in der Kennung, z. B. „ZeroToOnePeterThielUnabridged“. Suche deshalb zusätzlich mit search_identifier nach Kennungs-Anfängen wie „zerotoone“, „zero-to-one“, „peterthiel“.
4. Prüfe die besten Kandidaten mit inspect_items (vollständig oder Zusammenfassung, Gesamtdauer, Sprache) – auch alle, die du über die Websuche gefunden hast (Kennung = Teil nach archive.org/details/).
5. Rufe zum Schluss submit_results auf: die besten Treffer (höchstens 8), das beste zuerst, je ein kurzer deutscher Satz warum (z. B. „Vollständige Lesung, ca. 5 Std., Englisch“).

Regeln: Nur Kennungen verwenden, die du in Ergebnissen gesehen hast. Vollständige Hörbücher vor Zusammenfassungen, Rezensionen oder Podcasts über das Werk (diese dürfen als Alternative dabei sein). Sucht die Person auf Deutsch, deutsche Aufnahmen zuerst, wenn es welche gibt. Gibt es nichts Passendes, gib eine leere Liste zurück und erkläre kurz warum.`;

const fn = (name, description, parameters) => ({ type: 'function', function: { name, description, parameters } });

const TOOLS = [
  {
    type: 'openrouter:web_search',
    parameters: { max_results: 8, max_uses: 3, allowed_domains: ['archive.org'] },
  },
  fn('search_archive', 'Durchsucht archive.org wie die Suche auf der Webseite (Titel, Autor:in, Beschreibung, Schlagwörter). Liefert nur abspielbare Einträge.', {
    type: 'object',
    properties: { query: { type: 'string', description: 'Suchbegriffe, z. B. "zero to one thiel" oder "die verwandlung kafka".' } },
    required: ['query'],
  }),
  fn('search_identifier', 'Findet Einträge, deren Kennung (identifier) mit einem der Präfixe beginnt, z. B. "zerotoone", "zero-to-one", "peterthiel". Hilft bei schlecht beschrifteten Uploads. Liefert nur abspielbare Einträge.', {
    type: 'object',
    properties: { prefixes: { type: 'array', items: { type: 'string' }, description: 'Kleingeschriebene Anfänge, mind. 6 Zeichen, nur a-z, 0-9, - und _.' } },
    required: ['prefixes'],
  }),
  fn('inspect_items', 'Details zu bis zu 8 Einträgen: Titel, Autor:in, Sprache, Beschreibung (gekürzt), Anzahl abspielbarer Dateien, Gesamtdauer in Minuten.', {
    type: 'object',
    properties: { identifiers: { type: 'array', items: { type: 'string' } } },
    required: ['identifiers'],
  }),
  fn('submit_results', 'Gibt die endgültige Auswahl zurück. Genau einmal ganz am Ende aufrufen.', {
    type: 'object',
    properties: {
      interpretation: { type: 'string', description: 'Ein kurzer deutscher Satz: was gesucht und was gefunden wurde.' },
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: { identifier: { type: 'string' }, reason: { type: 'string', description: 'Kurz auf Deutsch, warum dieser Treffer passt.' } },
          required: ['identifier', 'reason'],
        },
      },
    },
    required: ['interpretation', 'results'],
  }),
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function chat(apiKey, messages, fetchImpl) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(OPENROUTER, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://jonker-hub.github.io/ArcivePlayer/',
        'X-Title': 'ArcivePlayer',
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 4000, messages, tools: TOOLS, tool_choice: 'auto' }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && !data.error) {
      const choice = data.choices?.[0];
      if (!choice) throw new Error('Leere Antwort der KI');
      return choice.message;
    }
    const status = data.error?.code || res.status;
    if ((status === 502 || status === 503 || status === 500) && attempt < 2) { await sleep(1500 * (attempt + 1)); continue; }
    if (status === 402) throw new QuotaError('OpenRouter-Guthaben aufgebraucht.');
    if (status === 429) throw new QuotaError('Zu viele Anfragen an die KI. Bitte kurz warten.');
    if (status === 502 || status === 503) throw new BusyError('Die KI ist gerade überlastet. Bitte gleich nochmal versuchen.');
    throw new Error(`KI-Fehler (${status}): ${data.error?.message || ''}`.trim());
  }
}

async function getJSON(url, fetchImpl) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`archive.org antwortet mit ${res.status}`);
  return res.json();
}

// Abspielbarkeit + Grunddaten (in Paketen, lange Anfragen lehnt archive.org ab)
async function describe(ids, fetchImpl) {
  const ok = new Map();
  const clean = [...new Set(ids)].filter((id) => /^[\w.-]+$/.test(id));
  for (let i = 0; i < clean.length; i += 20) {
    const chunk = clean.slice(i, i + 20);
    const p = new URLSearchParams({ q: `identifier:(${chunk.join(' OR ')})`, rows: String(chunk.length), output: 'json' });
    for (const f of ['identifier', 'title', 'creator', 'mediatype', 'language', 'downloads', 'format', 'access-restricted-item']) p.append('fl[]', f);
    try {
      const data = await getJSON(`${BASE}/advancedsearch.php?${p}`, fetchImpl);
      for (const d of data.response?.docs || []) {
        if (String(d['access-restricted-item']) === 'true' || ![].concat(d.format || []).some((f) => PLAYABLE.test(f))) continue;
        ok.set(d.identifier, {
          identifier: d.identifier,
          title: first(d.title) || d.identifier,
          creator: first(d.creator) || '',
          mediatype: d.mediatype || '',
          language: [].concat(d.language || []).join(', '),
          downloads: d.downloads || 0,
        });
      }
    } catch { /* Paket übersprungen */ }
  }
  return clean.filter((id) => ok.has(id)).map((id) => ok.get(id));
}

async function searchArchive(query, fetchImpl) {
  const p = new URLSearchParams({ user_query: query, page_type: 'search_results', hits_per_page: '40', page: '1' });
  const data = await getJSON(`${BASE}/services/search/beta/page_production/?${p}`, fetchImpl);
  const ids = (data.response?.body?.hits?.hits || []).map((h) => h.fields.identifier);
  return (await describe(ids, fetchImpl)).slice(0, 20);
}

async function searchIdentifier(prefixes, fetchImpl) {
  const clean = [...new Set(prefixes.map((s) => String(s).toLowerCase().replace(/[^a-z0-9_-]/g, '')))].filter((s) => s.length >= 6).slice(0, 12);
  if (!clean.length) return [];
  const p = new URLSearchParams({ q: `identifier:(${clean.map((s) => `${s}*`).join(' OR ')})`, rows: '40', output: 'json' });
  p.append('fl[]', 'identifier');
  const data = await getJSON(`${BASE}/advancedsearch.php?${p}`, fetchImpl);
  return (await describe((data.response?.docs || []).map((d) => d.identifier), fetchImpl)).slice(0, 20);
}

async function inspectItems(ids, fetchImpl) {
  return Promise.all(ids.slice(0, 8).map(async (id) => {
    try {
      const data = await getJSON(`${BASE}/metadata/${encodeURIComponent(id)}`, fetchImpl);
      if (!data.metadata) return { identifier: id, error: 'nicht gefunden' };
      const m = data.metadata;
      const files = (data.files || []).filter((f) => String(f.private) !== 'true' && PLAYABLE.test(f.format || ''));
      const originals = files.filter((f) => f.source === 'original');
      const tracks = originals.length ? originals : files;
      return {
        identifier: id,
        title: first(m.title) || id,
        creator: first(m.creator) || '',
        language: [].concat(m.language || []).join(', '),
        description: strip(first(m.description)).slice(0, 400),
        restricted: String(m['access-restricted-item']) === 'true',
        playable_files: tracks.length,
        total_minutes: Math.round(tracks.reduce((s, f) => s + parseLength(f.length), 0) / 60),
      };
    } catch (e) {
      return { identifier: id, error: String(e.message || e) };
    }
  }));
}

function parseLength(v) {
  if (v == null || v === '') return 0;
  const s = String(v);
  if (s.includes(':')) return s.split(':').reduce((acc, p) => acc * 60 + (parseFloat(p) || 0), 0);
  return parseFloat(s) || 0;
}

async function runTool(name, args, fetchImpl) {
  if (name === 'search_archive') return { items: await searchArchive(String(args.query || '').slice(0, 200), fetchImpl) };
  if (name === 'search_identifier') return { items: await searchIdentifier([].concat(args.prefixes || []), fetchImpl) };
  if (name === 'inspect_items') return { items: await inspectItems([].concat(args.identifiers || []).map(String), fetchImpl) };
  return { error: `Unbekanntes Werkzeug ${name}` };
}

export async function aiSearch(apiKey, userQuery, fetchImpl = fetch) {
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: userQuery }];
  let submitted = null;

  for (let round = 0; round < MAX_ROUNDS && !submitted; round++) {
    if (round === MAX_ROUNDS - 1) {
      messages.push({ role: 'user', content: 'Letzte Runde: Rufe jetzt submit_results mit den bisher besten Treffern auf.' });
    }
    const msg = await chat(apiKey, messages, fetchImpl);
    messages.push(msg); // unverändert zurückgeben
    const calls = msg.tool_calls || [];
    if (!calls.length) break;

    for (const call of calls) {
      let args = {};
      try { args = JSON.parse(call.function?.arguments || '{}'); } catch { /* leer lassen */ }
      let result;
      if (call.function?.name === 'submit_results') {
        submitted = args;
        result = { ok: true };
      } else {
        try { result = await runTool(call.function?.name, args, fetchImpl); } catch (e) { result = { error: String(e.message || e) }; }
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }

  // Nur Einträge zurückgeben, die es auf archive.org gibt und die abspielbar sind.
  const picks = [].concat(submitted?.results || [])
    .filter((r, i, all) => r?.identifier && all.findIndex((x) => x.identifier === r.identifier) === i);
  const info = new Map((await describe(picks.map((r) => String(r.identifier)), fetchImpl)).map((d) => [d.identifier, d]));
  const results = picks.filter((r) => info.has(r.identifier)).slice(0, 8).map((r) => {
    const d = info.get(r.identifier);
    return { id: d.identifier, title: d.title, creator: d.creator, video: d.mediatype === 'movies', reason: String(r.reason || '') };
  });
  return { interpretation: String(submitted?.interpretation || ''), results };
}
