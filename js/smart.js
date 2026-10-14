// Smarte Suche ohne KI-Kosten: erkennt aus Titel, Autor:in oder Beschreibung das gemeinte Werk
// über Wikipedia/Wikidata und Open Library und sucht dann gezielt auf archive.org.
// Alle Quellen sind offen, kostenlos und brauchen keinen Schlüssel.

const ARCHIVE = 'https://archive.org/advancedsearch.php';

const STOPWORDS = new Set(`
  der die das den dem des ein eine einer einen einem eines und oder mit von vom zum zur zu im in ins am an auf aus bei
  über unter für gegen ohne um nach vor wie was wer wo als auch noch nur sich er sie es ich du wir ihr man ist sind war
  waren wird werden hat haben hatte buch bücher hörbuch hörbücher roman romane geschichte erzählung lesung titel autor
  autorin von suche suchen gesucht kennt heißt namens irgendwas etwas welches welcher welche dieses diese dieser jenes
  the a an and or of in on at to for with by from about book books audiobook novel story stories title author
`.split(/\s+/).filter(Boolean));

const WORK_TYPES = new Set(['Q7725634', 'Q8261', 'Q47461344', 'Q571', 'Q49084', 'Q25379', 'Q5185279', 'Q1279564', 'Q17518461', 'Q149537', 'Q12308638', 'Q699', 'Q182015']);

export function keywords(q) {
  return q.toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

const looksGerman = (q) => /[äöüß]|\b(der|die|das|und|ein|eine|mit|über|von)\b|\w(ung|keit|heit|lich|schaft|chen)\b/i.test(q);

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

// Wikipedia-Volltextsuche → Wikidata: Werke (mit Autor) und Personen
async function wikiCandidates(terms, lang) {
  const search = await getJSON(`https://${lang}.wikipedia.org/w/api.php?` + new URLSearchParams({
    action: 'query', generator: 'search', gsrsearch: terms.join(' '), gsrlimit: '6',
    prop: 'pageprops', ppprop: 'wikibase_item', format: 'json', origin: '*',
  }));
  const pages = Object.values(search.query?.pages || {}).sort((a, b) => a.index - b.index);
  const ids = pages.map((p) => p.pageprops?.wikibase_item).filter(Boolean);
  if (!ids.length) return [];

  const ents = (await getJSON('https://www.wikidata.org/w/api.php?' + new URLSearchParams({
    action: 'wbgetentities', ids: ids.join('|'), props: 'labels|claims', languages: 'de|en', format: 'json', origin: '*',
  }))).entities || {};

  const claimIds = (e, p) => (e.claims?.[p] || []).map((c) => c.mainsnak?.datavalue?.value?.id).filter(Boolean);
  const label = (e) => e?.labels?.[lang]?.value || e?.labels?.de?.value || e?.labels?.en?.value || '';

  const authorIds = new Set();
  for (const id of ids) for (const a of claimIds(ents[id] || {}, 'P50')) authorIds.add(a);
  const authors = authorIds.size ? (await getJSON('https://www.wikidata.org/w/api.php?' + new URLSearchParams({
    action: 'wbgetentities', ids: [...authorIds].slice(0, 20).join('|'), props: 'labels', languages: 'de|en', format: 'json', origin: '*',
  }))).entities || {} : {};

  const out = [];
  for (const id of ids) {
    const e = ents[id];
    if (!e) continue;
    const types = claimIds(e, 'P31');
    const authorNames = claimIds(e, 'P50').map((a) => label(authors[a])).filter(Boolean);
    if (authorNames.length || types.some((t) => WORK_TYPES.has(t))) {
      const titles = new Set([e.labels?.de?.value, e.labels?.en?.value].filter(Boolean));
      for (const c of e.claims?.P1476 || []) if (c.mainsnak?.datavalue?.value?.text) titles.add(c.mainsnak.datavalue.value.text);
      out.push({ kind: 'work', titles: [...titles], author: authorNames[0] || '', source: 'Wikipedia' });
    } else if (types.includes('Q5')) {
      out.push({ kind: 'person', name: label(e), source: 'Wikipedia' });
    }
  }
  return out;
}

// Open Library: Titel/Autor-Varianten (inkl. Übersetzungen)
async function openLibraryCandidates(q) {
  const data = await getJSON('https://openlibrary.org/search.json?' + new URLSearchParams({
    q, fields: 'title,author_name', limit: '4',
  }));
  return (data.docs || []).filter((d) => d.title).map((d) => ({
    kind: 'work', titles: [d.title], author: d.author_name?.[0] || '', source: 'Open Library',
  }));
}

const norm = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ß ]+/g, ' ').replace(/\s+/g, ' ').trim();
const luceneWords = (s) => norm(s).split(' ').filter((w) => w.length > 1).slice(0, 6);

function archiveQueryFor(c) {
  if (c.kind === 'person') {
    const words = luceneWords(c.name);
    return words.length ? `creator:(${words.join(' AND ')})` : null;
  }
  const titleWords = luceneWords(c.titles[0]);
  if (!titleWords.length) return null;
  const titleQ = c.titles.slice(0, 3)
    .map((t) => luceneWords(t)).filter((w) => w.length)
    .map((w) => `title:(${w.join(' AND ')})`);
  const last = luceneWords(c.author).pop();
  return `(${[...new Set(titleQ)].join(' OR ')})${last ? ` AND creator:(${last})` : ''}`;
}

async function archiveSearch(query) {
  const params = new URLSearchParams({ q: `(${query}) AND mediatype:audio`, rows: '12', page: '1', output: 'json' });
  for (const f of ['identifier', 'title', 'creator', 'year', 'language', 'downloads', 'collection']) params.append('fl[]', f);
  const data = await getJSON(`${ARCHIVE}?${params}`);
  return data.response?.docs || [];
}

const first = (v) => (Array.isArray(v) ? v[0] : v);
const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []);

export async function smartSearch(q) {
  const terms = keywords(q);
  if (!terms.length) return { hints: [], results: [] };
  const german = looksGerman(q);

  const sources = await Promise.allSettled([
    wikiCandidates(terms, german ? 'de' : 'en'),
    wikiCandidates(terms, german ? 'en' : 'de'),
    openLibraryCandidates(terms.join(' ')),
  ]);
  // Reihenfolge: bestes Wikipedia-Ergebnis zuerst, dann Open Library, dann Rest
  const [w1, w2, ol] = sources.map((s) => (s.status === 'fulfilled' ? s.value : []));
  const merged = [...w1.slice(0, 3), ...ol.slice(0, 2), ...w2.slice(0, 2), ...w1.slice(3), ...ol.slice(2)];

  const candidates = [];
  const keys = new Set();
  const termSet = new Set(terms.map(norm));
  for (const c of merged) {
    // Personen nur, wenn ihr Name in der Suche vorkommt (sonst Zufallstreffer der Volltextsuche)
    if (c.kind === 'person' && !termSet.has(luceneWords(c.name).pop())) continue;
    const key = c.kind === 'person' ? `p:${norm(c.name)}` : `w:${norm(c.titles[0])}|${norm(c.author).split(' ').pop()}`;
    if (keys.has(key)) continue;
    keys.add(key);
    const query = archiveQueryFor(c);
    if (query) candidates.push({ ...c, query });
    if (candidates.length >= 6) break;
  }

  const found = await Promise.allSettled(candidates.map((c) => archiveSearch(c.query)));
  const byId = new Map();
  const useful = new Set();
  found.forEach((r, rank) => {
    if (r.status !== 'fulfilled') return;
    const c = candidates[rank];
    const lastName = luceneWords(c.kind === 'person' ? c.name : c.author).pop();
    for (const d of r.value) {
      const collections = asList(d.collection);
      const langs = asList(d.language).join(' ').toLowerCase();
      const creatorWords = luceneWords(asList(d.creator).join(' '));
      if (c.kind === 'person' && lastName && !creatorWords.includes(lastName)) continue;
      const titleWords = new Set(luceneWords(first(d.title) || ''));
      let score = 100 - rank * 12 + Math.log10((d.downloads || 0) + 1) * 3;
      score += [...termSet].filter((t) => titleWords.has(t)).length * 15;
      if (collections.includes('librivoxaudio') || collections.includes('audio_bookspoetry')) score += 15;
      if (german && /ger|deu|german|deutsch/.test(langs)) score += 20;
      useful.add(rank);
      const prev = byId.get(d.identifier);
      if (prev && prev.score >= score) continue;
      const label = c.kind === 'person' ? `von ${c.name}` : `„${c.titles[0]}“${c.author ? ` von ${c.author}` : ''}`;
      byId.set(d.identifier, {
        id: d.identifier,
        title: first(d.title) || d.identifier,
        creator: first(d.creator) || '',
        year: first(d.year) || '',
        reason: `Passt zu ${label} · ${c.source}`,
        score,
      });
    }
  });

  const results = [...byId.values()].sort((a, b) => b.score - a.score).slice(0, 12);
  const hints = candidates.filter((_, i) => useful.has(i)).slice(0, 3).map((c) => (c.kind === 'person' ? c.name : `${c.titles[0]}${c.author ? ` (${c.author})` : ''}`));
  return { hints, results };
}
