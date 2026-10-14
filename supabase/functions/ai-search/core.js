// KI-Suche: Claude formuliert Suchanfragen für archive.org, prüft die Treffer
// und wählt die passenden Hörbücher aus. Läuft in der Supabase Edge Function.

const MODEL = 'claude-opus-5-5';
const MAX_ROUNDS = 5;
const ARCHIVE = 'https://archive.org/advancedsearch.php';

const SYSTEM = `Du hilfst beim Finden von Hörbüchern und anderen Audioaufnahmen im Internet Archive (archive.org).
Die Person gibt Autor:in, Titel, Inhalt, Thema oder eine freie Beschreibung ein – oft auf Deutsch, manchmal ungenau oder falsch geschrieben.

Vorgehen:
1. Überlege, welches Werk oder welche Art von Aufnahme gemeint ist (auch Originaltitel, Übersetzungen, Schreibvarianten, bekannte Werke zu einer Beschreibung).
2. Durchsuche das Archiv mit search_archive. Nutze mehrere gezielte Anfragen, z. B. title:(…), creator:(…), subject:(…) oder freie Begriffe, auf Deutsch und Englisch. Mehrere Aufrufe in einer Runde sind erwünscht.
3. Rufe am Ende submit_results genau einmal auf: die besten Treffer (bis zu 12), sortiert nach Relevanz, jeweils mit einem kurzen deutschen Satz, warum er passt.

Regeln:
- Verwende nur Kennungen (identifier), die search_archive tatsächlich geliefert hat.
- Bevorzuge vollständige Hörbücher/Lesungen (z. B. LibriVox) vor Einzelkapiteln, Musik oder Sammelsurien.
- Sucht die Person auf Deutsch, liste deutsche Aufnahmen zuerst, wenn es welche gibt.
- Findest du nichts Passendes, gib eine leere Liste zurück und erkläre kurz, warum.`;

const TOOLS = [
  {
    name: 'search_archive',
    description:
      'Durchsucht Audio-Einträge im Internet Archive mit der Lucene-Syntax von advancedsearch. ' +
      'Felder: title, creator, subject, description, language (z. B. ger, eng), collection (z. B. librivoxaudio). ' +
      'Beispiele: title:(moby dick) AND creator:(melville) — subject:(krimi OR detective) AND language:ger — "der zauberberg". ' +
      'Liefert bis zu 15 Treffer mit identifier, Titel, Autor:in, Jahr, Sprache, Downloads und Kurzbeschreibung.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Lucene-Suchanfrage (ohne mediatype, das wird automatisch ergänzt).' },
        audiobooks_only: { type: 'boolean', description: 'Nur Hörbuch-Sammlungen (LibriVox, Hörbücher & Gedichte) durchsuchen.' },
      },
      required: ['query', 'audiobooks_only'],
      additionalProperties: false,
    },
  },
  {
    name: 'submit_results',
    description: 'Gibt die endgültige, nach Relevanz sortierte Trefferliste zurück. Genau einmal ganz am Ende aufrufen.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        interpretation: { type: 'string', description: 'Ein kurzer deutscher Satz: was die Person vermutlich sucht.' },
        results: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              identifier: { type: 'string' },
              reason: { type: 'string', description: 'Kurz auf Deutsch, warum dieser Treffer passt.' },
            },
            required: ['identifier', 'reason'],
            additionalProperties: false,
          },
        },
      },
      required: ['interpretation', 'results'],
      additionalProperties: false,
    },
  },
];

const AUDIOBOOK_FILTER = '(collection:librivoxaudio OR collection:audio_bookspoetry OR subject:audiobook OR subject:hörbuch)';

async function searchArchive(query, audiobooksOnly, fetchImpl) {
  const q = `(${query}) AND mediatype:audio${audiobooksOnly ? ` AND ${AUDIOBOOK_FILTER}` : ''}`;
  const params = new URLSearchParams({ q, rows: '15', page: '1', output: 'json' });
  for (const f of ['identifier', 'title', 'creator', 'year', 'language', 'downloads', 'description']) params.append('fl[]', f);
  const res = await fetchImpl(`${ARCHIVE}?${params}`);
  if (!res.ok) throw new Error(`archive.org antwortet mit ${res.status}`);
  const data = await res.json();
  return {
    total: data.response?.numFound ?? 0,
    docs: (data.response?.docs ?? []).map((d) => ({
      identifier: d.identifier,
      title: first(d.title) || d.identifier,
      creator: first(d.creator) || '',
      year: first(d.year) || '',
      language: first(d.language) || '',
      downloads: d.downloads || 0,
      description: stripHtml(first(d.description) || '').slice(0, 220),
    })),
  };
}

// Führt die Suche aus. `client` ist ein Anthropic-Client, `fetchImpl` i. d. R. globalThis.fetch.
export async function aiSearch(client, userQuery, fetchImpl = fetch) {
  const seen = new Map(); // identifier -> doc
  const messages = [{ role: 'user', content: `Suche: ${userQuery}` }];
  let submitted = null;

  for (let round = 0; round < MAX_ROUNDS && !submitted; round++) {
    const lastRound = round === MAX_ROUNDS - 1;
    if (lastRound) {
      messages.push({ role: 'system', content: 'Letzte Runde: Rufe jetzt submit_results mit den bisher gefundenen Treffern auf.' });
    }

    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 8000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low' },
      system: SYSTEM,
      tools: TOOLS,
      tool_choice: { type: 'auto' },
      messages,
    });

    if (response.stop_reason === 'refusal') throw new Error('Die KI hat diese Anfrage abgelehnt.');
    messages.push({ role: 'assistant', content: response.content });
    if (response.stop_reason === 'pause_turn') continue;

    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    if (!toolUses.length) break; // ohne submit_results beendet

    const results = await Promise.all(toolUses.map(async (t) => {
      if (t.name === 'submit_results') {
        submitted = t.input;
        return { type: 'tool_result', tool_use_id: t.id, content: 'OK' };
      }
      try {
        const r = await searchArchive(String(t.input.query || '').slice(0, 500), !!t.input.audiobooks_only, fetchImpl);
        for (const d of r.docs) seen.set(d.identifier, d);
        return { type: 'tool_result', tool_use_id: t.id, content: JSON.stringify(r) };
      } catch (e) {
        return { type: 'tool_result', tool_use_id: t.id, content: String(e.message || e), is_error: true };
      }
    }));
    if (submitted) break;
    messages.push({ role: 'user', content: results });
  }

  // Nur echte, tatsächlich gefundene Einträge zurückgeben.
  const picks = (submitted?.results || [])
    .filter((r) => seen.has(r.identifier))
    .filter((r, i, arr) => arr.findIndex((x) => x.identifier === r.identifier) === i)
    .slice(0, 12)
    .map((r) => {
      const d = seen.get(r.identifier);
      return { id: d.identifier, title: d.title, creator: d.creator, year: d.year, reason: r.reason };
    });

  return { interpretation: submitted?.interpretation || '', results: picks };
}

function first(v) {
  return Array.isArray(v) ? v[0] : v;
}

function stripHtml(s) {
  return String(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}
