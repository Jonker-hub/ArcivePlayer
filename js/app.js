import { search, searchArchive, getItem, cachedItem, coverUrl, itemPageUrl } from './api.js';
import { store } from './store.js';
import { player } from './player.js';
import { icons } from './icons.js';
import { aiAvailable, aiSearch } from './ai.js';

// ---------- Hilfsfunktionen ----------

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmt(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function fmtLong(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  if (h && m) return `${h} Std. ${m} Min.`;
  if (h) return `${h} Std.`;
  return `${Math.max(m, sec ? 1 : 0)} Min.`;
}

function htmlToText(html) {
  const doc = new DOMParser().parseFromString(String(html).replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n'), 'text/html');
  return (doc.body.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

function hydrateIcons(root = document) {
  for (const el of $$('[data-icon]', root)) {
    if (!el.dataset.iconDone) { el.insertAdjacentHTML('afterbegin', icons[el.dataset.icon] || ''); el.dataset.iconDone = '1'; }
  }
}

function progressInfo(p) {
  if (!p) return null;
  const pct = p.bookLen ? Math.min(100, (p.bookPos / p.bookLen) * 100) : 0;
  const left = p.bookLen ? p.bookLen - p.bookPos : 0;
  return { pct, left };
}

// ---------- Bausteine ----------

function card(it, { showProgress = false } = {}) {
  const p = showProgress ? progressInfo(store.progress(it.id)) : null;
  return `
    <a class="card" href="#/item/${encodeURIComponent(it.id)}">
      <div class="art">
        <img loading="lazy" src="${coverUrl(it.id)}" alt="" onerror="this.style.opacity=0">
        <button class="art-play" data-play="${esc(it.id)}" aria-label="Abspielen">${icons.play}</button>
        ${it.video ? '<span class="art-badge">Video</span>' : ''}
        ${p ? `<div class="art-progress"><span style="width:${p.pct.toFixed(1)}%"></span></div>` : ''}
      </div>
      <div class="card-title">${esc(it.title)}</div>
      <div class="card-sub">${p && p.left ? `Noch ${fmtLong(p.left)}` : esc(it.creator)}</div>
    </a>`;
}

const skeletonCards = (n) => Array.from({ length: n }, () => '<div class="card skel"><div class="art"></div><div class="card-title"></div><div class="card-sub"></div></div>').join('');

function shelf(title, inner, { link, grid = false } = {}) {
  return `
    <section class="section">
      <h2 class="section-title">${link ? `<a href="${link}">${esc(title)}${icons.chevronRight}</a>` : esc(title)}</h2>
      <div class="${grid ? 'grid' : 'shelf'}">${inner}</div>
    </section>`;
}

// ---------- Router ----------

const view = $('#view');
let renderToken = 0;

function route() {
  const hash = location.hash.slice(1) || '/';
  const [path, qs] = hash.split('?');
  const params = new URLSearchParams(qs || '');
  const token = ++renderToken;
  const isCurrent = () => token === renderToken;
  const parts = path.split('/').filter(Boolean);

  let nav = 'home';
  if (parts[0] === 'search') { nav = 'search'; renderSearch(params, isCurrent); }
  else if (parts[0] === 'library') { nav = 'library'; renderLibrary(params); }
  else if (parts[0] === 'item' && parts[1]) { nav = ''; renderItem(decodeURIComponent(parts[1]), isCurrent); }
  else renderHome(isCurrent);

  for (const a of $$('[data-nav]')) a.classList.toggle('active', a.dataset.nav === nav);
  view.scrollTop = 0;
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);

// ---------- Jetzt hören ----------

function renderHome(isCurrent) {
  const cont = store.continueList();
  const favs = store.favoriteList();
  cont.slice(0, 8).forEach((p) => getItem(p.id).catch(() => {})); // vorladen → sofortiges Abspielen

  view.innerHTML = `
    <h1 class="page-title">Jetzt hören</h1>
    ${cont.length ? shelf('Weiterhören', cont.map((p) => card(p, { showProgress: true })).join(''), { link: '#/library' }) : `
      <div class="hero">
        <div class="hero-logo">${icons.logo}</div>
        <div>
          <h2>Willkommen</h2>
          <p>Suche nach Hörbüchern im Internet Archive. Wo du aufhörst, geht es beim nächsten Mal genau weiter.</p>
          <a class="btn" href="#/search">${icons.search}Hörbücher suchen</a>
        </div>
      </div>`}
    ${favs.length ? shelf('Gemerkt', favs.map((f) => card(f)).join(''), { link: '#/library?tab=favs' }) : ''}
    <div id="home-de">${shelf('Deutsche Hörbücher', skeletonCards(8))}</div>
    <div id="home-pop">${shelf('Beliebt bei LibriVox', skeletonCards(12), { grid: true })}</div>
  `;

  search('collection:librivoxaudio', { filter: 'german', rows: 20, sort: 'downloads desc' })
    .then((r) => { if (isCurrent()) $('#home-de').innerHTML = shelf('Deutsche Hörbücher', r.items.map((i) => card(i)).join(''), { link: '#/search?f=german&q=collection%3Alibrivoxaudio' }); })
    .catch(() => { if (isCurrent()) $('#home-de').innerHTML = ''; });
  search('', { filter: 'librivox', rows: 24 })
    .then((r) => { if (isCurrent()) $('#home-pop').innerHTML = shelf('Beliebt bei LibriVox', r.items.map((i) => card(i)).join(''), { grid: true }); })
    .catch((e) => { if (isCurrent()) $('#home-pop').innerHTML = `<p class="empty">${esc(e.message)}</p>`; });
}

// ---------- Suche ----------

const FILTER_LABELS = { all: 'Alle', audiobooks: 'LibriVox-Hörbücher', german: 'Deutsch' };
const CATEGORIES = [
  ['Krimi', 'subject:(krimi OR mystery OR detective)'],
  ['Märchen', 'subject:(märchen OR "fairy tales")'],
  ['Abenteuer', 'subject:(abenteuer OR adventure)'],
  ['Science-Fiction', 'subject:("science fiction")'],
  ['Kinder', 'subject:(kinder OR children)'],
  ['Gedichte', 'subject:(gedichte OR poetry)'],
  ['Geschichte', 'subject:(geschichte OR history)'],
  ['Philosophie', 'subject:(philosophie OR philosophy)'],
  ['Horror', 'subject:(horror OR gothic)'],
  ['Humor', 'subject:(humor OR humour OR comedy)'],
  ['Hörspiele', 'subject:(hörspiel OR "radio drama" OR "old time radio")'],
  ['Romane', 'subject:(roman OR novel OR fiction)'],
];

let searchState = { key: '', items: [], total: 0, page: 1 };

function renderSearch(params, isCurrent) {
  const q = params.get('q') || '';
  const f = params.get('f') || 'all';

  view.innerHTML = `
    <h1 class="page-title">Suchen</h1>
    <form class="search-box" role="search">
      ${icons.search}
      <input type="search" name="q" value="${esc(q)}" placeholder="${aiAvailable() ? 'Was möchtest du hören?' : 'Titel, Autor:in oder Beschreibung …'}" autocomplete="off" enterkeyhint="search">
      ${aiAvailable() ? `<button type="submit" class="ai-go" aria-label="Mit KI suchen">${icons.sparkle}<span>KI</span></button>` : ''}
    </form>
    ${aiAvailable() && !q ? '<p class="muted ai-hint">Schreib einfach, was du suchst – z. B. „ein gutes Hörbuch zu Peter Thiels Zero to One“ – und drück Enter. Die KI sucht dann auf archive.org.</p>' : ''}
    <div class="chips">${Object.entries(FILTER_LABELS).map(([k, l]) => `<button class="chip ${k === f ? 'on' : ''}" data-filter="${k}">${l}</button>`).join('')}</div>
    <div id="ai-results"></div>
    <div id="results"></div>
  `;

  const input = $('.search-box input', view);
  const results = $('#results');
  const sync = (newQ, newF, ai = false) => {
    const sp = new URLSearchParams();
    if (newQ) sp.set('q', newQ);
    if (newF && newF !== 'all') sp.set('f', newF);
    if (ai && newQ) sp.set('ai', '1');
    const target = `#/search${sp.toString() ? `?${sp}` : ''}`;
    if (location.hash !== target) location.hash = target;
  };

  let t;
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => replaceQuery(input.value.trim(), f), 450); });
  $('.search-box', view).addEventListener('submit', (e) => { e.preventDefault(); input.blur(); clearTimeout(t); sync(input.value.trim(), f, aiAvailable()); });
  for (const c of $$('[data-filter]', view)) c.addEventListener('click', () => sync(input.value.trim(), c.dataset.filter, params.get('ai') === '1'));
  $('.side-search input').value = q;
  if (q && params.get('ai') === '1' && aiAvailable()) runAi(q, isCurrent);

  if (!q && f === 'all') {
    results.innerHTML = `
      <h2 class="section-title">Kategorien</h2>
      <div class="cats">${CATEGORIES.map(([l, query], i) => `<a class="cat c${i % 6}" href="#/search?q=${encodeURIComponent(query)}">${esc(l)}</a>`).join('')}</div>`;
    if (matchMedia('(min-width: 900px)').matches) input.focus();
    return;
  }

  const key = `${q}|${f}`;
  if (searchState.key === key && searchState.items.length) return showResults(results);
  searchState = { key, items: [], total: 0, page: 1 };
  results.innerHTML = `<div class="grid">${skeletonCards(12)}</div>`;
  loadPage(q, f, isCurrent, results);
}

// Tippen aktualisiert die URL ohne neuen Seitenaufbau (Fokus bleibt im Feld).
function replaceQuery(q, f) {
  const sp = new URLSearchParams();
  if (q) sp.set('q', q);
  if (f !== 'all') sp.set('f', f);
  history.replaceState(null, '', `#/search${sp.toString() ? `?${sp}` : ''}`);
  const results = $('#results');
  if (!results) return;
  $('#ai-results').innerHTML = '';
  const token = ++renderToken;
  if (!q && f === 'all') return route();
  searchState = { key: `${q}|${f}`, items: [], total: 0, page: 1 };
  results.innerHTML = `<div class="grid">${skeletonCards(12)}</div>`;
  loadPage(q, f, () => token === renderToken, results);
}

async function loadPage(q, f, isCurrent, results) {
  try {
    let r = await searchArchive(q, { filter: f, page: searchState.page });
    // Seiten ohne (viele) abspielbare Einträge automatisch überspringen
    for (let extra = 0; extra < 3 && r.hasMore && searchState.items.length + r.items.length < 12; extra++) {
      if (!isCurrent()) return;
      searchState.items.push(...r.items);
      searchState.page++;
      r = await searchArchive(q, { filter: f, page: searchState.page });
    }
    if (!isCurrent()) return;
    searchState.items.push(...r.items);
    searchState.items = searchState.items.filter((it, i, all) => all.findIndex((x) => x.id === it.id) === i);
    searchState.total = r.total;
    searchState.hasMore = r.hasMore;
    showResults(results, q, f, isCurrent);
  } catch (e) {
    if (isCurrent()) results.innerHTML = `<p class="empty">${esc(e.message)}</p>`;
  }
}

// Treffer, deren Titel/Autor:in die Suchwörter enthalten, nach oben (sonst Reihenfolge von archive.org)
function byTitleMatch(items, q) {
  const words = String(q || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);
  if (!words.length) return items;
  const score = (it) => { const t = `${it.title} ${it.creator} ${it.id}`.toLowerCase(); return words.filter((w) => t.includes(w)).length; };
  return items.map((it, i) => ({ it, i, s: score(it) })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.it);
}

function showResults(results, q, f, isCurrent) {
  const { hasMore } = searchState;
  const items = byTitleMatch(searchState.items, q ?? searchState.key.split('|')[0]);
  if (!items.length) {
    results.innerHTML = `<p class="empty">Keine Treffer${f !== 'all' ? ` mit dem Filter „${FILTER_LABELS[f]}“. <a class="link" href="#/search?q=${encodeURIComponent(q)}">In allen suchen</a>` : '. Probier einen anderen Begriff.'}</p>`;
    return;
  }
  results.innerHTML = `
    <p class="meta-line">${items.length} abspielbare Treffer</p>
    <div class="grid">${items.map((i) => card(i)).join('')}</div>
    ${hasMore ? '<button class="btn ghost more">Mehr laden</button>' : ''}`;
  const more = $('.more', results);
  if (more) more.addEventListener('click', () => {
    more.disabled = true; more.textContent = 'Lädt …';
    const [qq, ff] = searchState.key.split('|');
    searchState.page++;
    loadPage(q ?? qq, f ?? ff, isCurrent || (() => true), results);
  });
}

// KI-Suche: Claude Haiku sucht wie in einem KI-Chat auf archive.org und begründet die Auswahl.
async function runAi(q, isCurrent) {
  const box = $('#ai-results');
  box.innerHTML = `
    <section class="ai-box loading">
      <div class="ai-head">${icons.sparkle}<span>KI-Suche</span></div>
      <p class="ai-text">Die KI sucht auf archive.org nach „${esc(q)}“ … (dauert ca. 10–20 Sek.)</p>
      <div class="ai-dots"><span></span><span></span><span></span></div>
    </section>`;
  try {
    const r = await aiSearch(q);
    if (!isCurrent() || !box.isConnected) return;
    box.innerHTML = `
      <section class="ai-box">
        <div class="ai-head">${icons.sparkle}<span>KI-Treffer</span></div>
        ${r.interpretation ? `<p class="ai-text">${esc(r.interpretation)}</p>` : ''}
        ${r.results.length ? `<ul class="ai-list">${r.results.map((it) => `
          <li class="ai-item">
            <a href="#/item/${encodeURIComponent(it.id)}">
              <img loading="lazy" src="${coverUrl(it.id)}" alt="">
              <span class="row-text">
                <span class="row-title">${esc(it.title)}</span>
                <span class="row-sub">${esc([it.creator, it.video ? 'Video' : ''].filter(Boolean).join(' · '))}</span>
                <span class="ai-reason">${esc(it.reason)}</span>
              </span>
            </a>
            <button class="ic sm accent" data-play="${esc(it.id)}" aria-label="Abspielen">${icons.play}</button>
          </li>`).join('')}</ul>` : '<p class="muted">Keine passenden Hörbücher gefunden.</p>'}
      </section>`;
  } catch (e) {
    if (!isCurrent() || !box.isConnected) return;
    box.innerHTML = `<section class="ai-box"><div class="ai-head">${icons.sparkle}<span>KI-Suche</span></div><p class="muted">${esc(e.message)}</p></section>`;
  }
}

// ---------- Mediathek ----------

function renderLibrary(params) {
  const tab = params.get('tab') || 'continue';
  const all = Object.values(store.get().progress).filter((p) => !p.removed && p.title);
  const lists = {
    continue: store.continueList(),
    favs: store.favoriteList(),
    done: all.filter((p) => p.finished).sort((a, b) => b.updatedAt - a.updatedAt),
  };
  const labels = { continue: 'Weiterhören', favs: 'Gemerkt', done: 'Gehört' };
  const list = lists[tab] || [];

  view.innerHTML = `
    <h1 class="page-title">Mediathek</h1>
    <div class="segmented">${Object.entries(labels).map(([k, l]) => `<a href="#/library?tab=${k}" class="${k === tab ? 'on' : ''}">${l}<span>${lists[k].length}</span></a>`).join('')}</div>
    ${list.length ? `<ul class="rows">${list.map((p) => libRow(p, tab)).join('')}</ul>` : `<p class="empty">${{
      continue: 'Noch nichts angefangen. Alles, was du hörst, landet automatisch hier.',
      favs: 'Tippe bei einem Titel auf das Herz, um ihn dir zu merken.',
      done: 'Fertig gehörte Titel erscheinen hier.',
    }[tab]}</p>`}
    <section class="section data-box">
      <h2 class="section-title">Daten auf ein anderes Gerät übertragen</h2>
      <p class="muted">Der Hörstand wird in diesem Browser gespeichert. Mit „Exportieren“ kopierst du ihn, mit „Importieren“ führst du ihn auf einem anderen Gerät zusammen – der jeweils neuere Stand gewinnt.</p>
      <div class="btn-row">
        <button class="btn ghost" data-act="export">Exportieren</button>
        <button class="btn ghost" data-act="import">Importieren</button>
      </div>
    </section>`;
  list.slice(0, 10).forEach((p) => getItem(p.id).catch(() => {}));
}

function libRow(p, tab) {
  const info = progressInfo(store.progress(p.id));
  let sub = esc(p.creator || '');
  if (tab === 'continue' && info) sub = `Kapitel ${(p.track || 0) + 1}/${p.trackCount || '?'} · ${info.left ? `noch ${fmtLong(info.left)}` : ''}`;
  return `
    <li class="row">
      <a class="row-main" href="#/item/${encodeURIComponent(p.id)}">
        <img loading="lazy" src="${coverUrl(p.id)}" alt="">
        <span class="row-text">
          <span class="row-title">${esc(p.title)}</span>
          <span class="row-sub">${sub}</span>
          ${tab === 'continue' && info ? `<span class="mini-progress"><span style="width:${info.pct.toFixed(1)}%"></span></span>` : ''}
        </span>
      </a>
      <button class="ic sm accent" data-play="${esc(p.id)}" aria-label="Abspielen">${icons.play}</button>
      <button class="ic sm" data-remove="${esc(p.id)}" data-tab="${tab}" aria-label="Entfernen">${icons.close}</button>
    </li>`;
}

// ---------- Titel-Detail ----------

async function renderItem(id, isCurrent) {
  view.innerHTML = `<div class="item-head skel"><div class="item-cover"></div><div class="item-info"><div class="l1"></div><div class="l2"></div></div></div>`;
  let item;
  try { item = await getItem(id); } catch (e) {
    if (isCurrent()) view.innerHTML = `<p class="empty">${esc(e.message)}</p>`;
    return;
  }
  if (!isCurrent()) return;

  const total = item.tracks.reduce((s, t) => s + (t.duration || 0), 0);
  const desc = htmlToText(item.description);

  view.innerHTML = `
    <div class="item-head">
      <img class="item-cover" src="${esc(item.cover || coverUrl(item.id))}" alt="">
      <div class="item-info">
        <h1>${esc(item.title)}</h1>
        ${item.creator ? `<a class="item-creator" href="#/search?f=all&q=${encodeURIComponent(`creator:("${item.creator.replace(/"/g, '')}")`)}">${esc(item.creator)}</a>` : ''}
        <div class="item-meta">${[item.year, item.tracks.length ? `${item.tracks.length} Kapitel` : '', total ? fmtLong(total) : '', item.language].filter(Boolean).map(esc).join(' · ')}</div>
        <div class="item-actions">
          <button class="btn" id="item-play"></button>
          <button class="ic fav-btn" data-fav="${esc(item.id)}" aria-label="Merken"></button>
          <a class="ic" href="${itemPageUrl(item.id)}" target="_blank" rel="noopener" aria-label="Auf archive.org öffnen">${icons.external}</a>
        </div>
        ${desc ? `<div class="desc clamp">${esc(desc)}</div><button class="link more-desc">Mehr</button>` : ''}
      </div>
    </div>
    ${item.tracks.length ? `<ol class="tracks">${item.tracks.map((t, i) => `
      <li class="track" data-i="${i}">
        <span class="tn"><span class="num">${i + 1}</span><span class="eq">${icons.waves}</span></span>
        <span class="tt"><span class="tt-title">${esc(t.title)}</span><span class="tt-sub"></span></span>
        <span class="td">${t.duration ? fmt(t.duration) : ''}</span>
      </li>`).join('')}</ol>` : '<p class="empty">In diesem Eintrag gibt es keine abspielbaren Audiodateien.</p>'}
  `;

  const cov = $('.item-cover', view);
  cov.addEventListener('error', () => { if (cov.src !== coverUrl(item.id)) cov.src = coverUrl(item.id); }, { once: true });
  $('#item-play').addEventListener('click', () => {
    if (player.item?.id === item.id) return player.toggle();
    player.resume(item, true);
  });
  const more = $('.more-desc', view);
  if (more) {
    const d = $('.desc', view);
    if (d.scrollHeight <= d.clientHeight + 4) more.remove();
    else more.addEventListener('click', () => { d.classList.toggle('clamp'); more.textContent = d.classList.contains('clamp') ? 'Mehr' : 'Weniger'; });
  }
  for (const li of $$('.track', view)) {
    li.addEventListener('click', () => {
      const i = +li.dataset.i;
      if (player.item?.id === item.id && player.index === i) return player.toggle();
      const p = store.progress(item.id);
      const resumeHere = p && !p.removed && !p.finished && p.trackName === item.tracks[i].name;
      player.load(item, i, resumeHere ? p.time : 0, true);
    });
  }
  updateItemView();
}

function updateItemView() {
  const playBtn = $('#item-play');
  if (!playBtn) return;
  const id = decodeURIComponent((location.hash.match(/#\/item\/([^?]+)/) || [])[1] || '');
  const item = cachedItem(id);
  if (!item) return;
  const p = store.progress(id);
  const isCur = player.item?.id === id;
  const fav = store.isFavorite(id);

  const favBtn = $('.fav-btn', view);
  favBtn.innerHTML = fav ? icons.heartFill : icons.heart;
  favBtn.classList.toggle('on', fav);

  if (isCur && player.playing) playBtn.innerHTML = `${icons.pause}Pause`;
  else if (p && !p.removed && !p.finished && (p.bookPos > 1 || p.track > 0)) {
    const info = progressInfo(p);
    playBtn.innerHTML = `${icons.play}Weiterhören<small>Kapitel ${(p.track || 0) + 1} · ${fmt(p.time)}${info.left ? ` · noch ${fmtLong(info.left)}` : ''}</small>`;
  } else playBtn.innerHTML = `${icons.play}${p?.finished ? 'Nochmal hören' : 'Abspielen'}`;

  const done = p?.doneTracks || {};
  for (const li of $$('.track', view)) {
    const i = +li.dataset.i;
    const t = item.tracks[i];
    const active = isCur && player.index === i;
    li.classList.toggle('active', active);
    li.classList.toggle('playing', active && player.playing);
    li.classList.toggle('done', !!done[t.name]);
    const sub = $('.tt-sub', li);
    if (p && !p.removed && !p.finished && p.trackName === t.name && p.time > 1) sub.textContent = `Bei ${fmt(p.time)}`;
    else if (done[t.name]) sub.textContent = 'Gehört';
    else sub.textContent = '';
  }
}

// ---------- Player-Oberfläche ----------

const bar = $('#bar');
const np = $('#np');
let scrubbing = false;
let lastError = null;

function updatePlayerUI() {
  const { item, track } = player;
  document.body.classList.toggle('has-player', !!item);
  np.classList.toggle('playing-now', player.playing);
  bar.hidden = !item;
  if (!item) return;

  const cover = coverUrl(item.id), big = item.cover || cover;
  if ($('.bar-cover').getAttribute('src') !== cover) $('.bar-cover').src = cover;
  if ($('.np-cover').getAttribute('src') !== big) { $('.np-cover').onerror = () => { $('.np-cover').src = cover; }; $('.np-cover').src = big; }
  $('.np-bg').style.backgroundImage = `url("${cover}")`;
  $('.bar-title').textContent = track.title;
  $('.bar-sub').textContent = item.title + (item.creator ? ` · ${item.creator}` : '');
  $('.np-title').textContent = track.title;
  $('.np-sub').textContent = item.title + (item.creator ? ` – ${item.creator}` : '');

  for (const b of $$('[data-act="toggle"]')) {
    b.innerHTML = player.playing ? icons.pause : icons.play;
    b.setAttribute('aria-label', player.playing ? 'Pause' : 'Abspielen');
    b.classList.toggle('loading', player.loading && !player.error);
  }
  for (const b of $$('[data-act="rate"]')) b.textContent = `${String(player.rate).replace('.', ',')}×`;
  for (const b of $$('[data-act="sleep"]')) {
    b.classList.toggle('on', !!player.sleep);
    b.title = player.sleep?.until ? `Stopp in ${fmt((player.sleep.until - Date.now()) / 1000)}` : player.sleep ? 'Stopp am Kapitelende' : 'Schlaf-Timer';
  }
  const fav = store.isFavorite(item.id);
  const favBtn = $('.np .fav');
  favBtn.innerHTML = fav ? icons.heartFill : icons.heart;
  favBtn.classList.toggle('on', fav);

  const err = $('.np-error');
  err.hidden = !player.error;
  err.textContent = player.error || '';
  if (player.error && player.error !== lastError) toast(player.error);
  lastError = player.error;

  renderQueue();
  updateTimeUI();
  updateItemView();
}

let timeRaf = 0;
function updateTimeUI() {
  if (timeRaf) return;
  timeRaf = requestAnimationFrame(() => {
    timeRaf = 0;
    if (!player.item) return;
    const cur = player.currentTime, dur = player.duration;
    const frac = dur ? Math.min(1, cur / dur) : 0;
    if (!scrubbing) {
      for (const s of $$('.scrub')) { s.value = Math.round(frac * 1000); s.style.setProperty('--p', `${frac * 100}%`); }
      for (const el of $$('.t-cur')) el.textContent = fmt(cur);
      for (const el of $$('.t-rem')) el.textContent = `-${fmt(Math.max(0, dur - cur))}`;
    }
    $('.bar-progress span').style.width = `${frac * 100}%`;
    const tracks = player.item.tracks;
    const total = tracks.reduce((s, t) => s + (t.duration || 0), 0);
    if (total) {
      const before = tracks.slice(0, player.index).reduce((s, t) => s + (t.duration || 0), 0);
      const left = Math.max(0, total - before - cur) / (player.rate || 1);
      $('.t-book').textContent = `Kapitel ${player.index + 1}/${tracks.length} · noch ${fmtLong(left)}`;
    } else $('.t-book').textContent = `Kapitel ${player.index + 1}/${tracks.length}`;
  });
}

function renderQueue() {
  const q = $('.np-queue');
  if (q.hidden || !player.item) return;
  const p = store.progress(player.item.id);
  const done = p?.doneTracks || {};
  q.innerHTML = player.item.tracks.map((t, i) => `
    <li class="${i === player.index ? 'active' : ''} ${done[t.name] ? 'done' : ''}" data-i="${i}">
      <span class="qn">${i === player.index && player.playing ? icons.waves : i + 1}</span>
      <span class="qt">${esc(t.title)}</span>
      <span class="qd">${done[t.name] ? icons.check : t.duration ? fmt(t.duration) : ''}</span>
    </li>`).join('');
}

$('.np-queue').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-i]');
  if (li) player.load(player.item, +li.dataset.i, 0, true);
});

for (const s of $$('.scrub')) {
  s.addEventListener('input', () => {
    scrubbing = true;
    const t = (s.value / 1000) * player.duration;
    s.style.setProperty('--p', `${s.value / 10}%`);
    for (const el of $$('.t-cur')) el.textContent = fmt(t);
    for (const el of $$('.t-rem')) el.textContent = `-${fmt(player.duration - t)}`;
  });
  s.addEventListener('change', () => {
    scrubbing = false;
    player.seek((s.value / 1000) * player.duration);
  });
}

function openNowPlaying() {
  np.classList.add('open');
  np.setAttribute('aria-hidden', 'false');
  document.body.classList.add('np-open');
}

function closeNowPlaying() {
  np.classList.remove('open');
  np.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('np-open');
  np.style.transform = '';
}

$('#bar-open').addEventListener('click', openNowPlaying);

// Nach unten wischen schließt den Player (wie in Apple Music).
{
  let y0 = null, dy = 0;
  np.addEventListener('touchstart', (e) => {
    if (e.target.closest('.scrub, .np-queue, button')) return;
    y0 = e.touches[0].clientY; dy = 0; np.style.transition = 'none';
  }, { passive: true });
  np.addEventListener('touchmove', (e) => {
    if (y0 == null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    np.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  np.addEventListener('touchend', () => {
    if (y0 == null) return;
    np.style.transition = '';
    if (dy > 110) closeNowPlaying(); else np.style.transform = '';
    y0 = null;
  });
}

// ---------- Aktionsblatt (Tempo, Schlaf-Timer, Import) ----------

const sheetWrap = $('#sheet');
function openSheet(html, onClick) {
  const sheet = $('.sheet', sheetWrap);
  sheet.innerHTML = html;
  sheetWrap.hidden = false;
  requestAnimationFrame(() => sheetWrap.classList.add('show'));
  sheet.onclick = (e) => onClick?.(e);
}
function closeSheet() {
  sheetWrap.classList.remove('show');
  setTimeout(() => { sheetWrap.hidden = true; }, 220);
}

function optionSheet(title, options, onPick) {
  openSheet(`
    <div class="sheet-title">${esc(title)}</div>
    <div class="sheet-list">${options.map((o, i) => `<button data-i="${i}" class="${o.active ? 'on' : ''}">${esc(o.label)}${o.active ? icons.check : ''}</button>`).join('')}</div>
    <button class="sheet-cancel" data-act="sheet-close">Abbrechen</button>`, (e) => {
    const b = e.target.closest('[data-i]');
    if (b) { onPick(options[+b.dataset.i].value); closeSheet(); }
  });
}

const RATES = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5];
const SLEEPS = [[null, 'Aus'], [5, '5 Minuten'], [10, '10 Minuten'], [15, '15 Minuten'], [30, '30 Minuten'], [45, '45 Minuten'], [60, '1 Stunde'], ['track', 'Ende des Kapitels']];

// ---------- Globale Aktionen ----------

async function playById(id) {
  const ready = cachedItem(id);
  if (ready) {
    if (player.item?.id === id) return player.toggle();
    return player.resume(ready, true);
  }
  toast('Wird geladen …');
  try { player.resume(await getItem(id), true); } catch (e) { toast(e.message); }
}

document.addEventListener('click', async (e) => {
  const play = e.target.closest('[data-play]');
  if (play) { e.preventDefault(); e.stopPropagation(); return playById(play.dataset.play); }

  const fav = e.target.closest('[data-fav]');
  if (fav) {
    const item = cachedItem(fav.dataset.fav);
    if (item) toast(store.toggleFavorite(item) ? 'Gemerkt' : 'Aus der Merkliste entfernt');
    return;
  }

  const rm = e.target.closest('[data-remove]');
  if (rm) {
    const id = rm.dataset.remove;
    if (rm.dataset.tab === 'favs') { const it = store.get().favorites[id]; if (it) store.toggleFavorite(it); }
    else store.removeProgress(id);
    return route();
  }

  const act = e.target.closest('[data-act]')?.dataset.act;
  switch (act) {
    case 'toggle': return player.toggle();
    case 'back': return player.skip(-15);
    case 'fwd': return player.skip(30);
    case 'next': return player.next();
    case 'prev': return player.prev();
    case 'close': return closeNowPlaying();
    case 'openitem':
      if (player.item) { closeNowPlaying(); location.hash = `#/item/${encodeURIComponent(player.item.id)}`; }
      return;
    case 'fav':
      if (player.item) toast(store.toggleFavorite(player.item) ? 'Gemerkt' : 'Aus der Merkliste entfernt');
      return;
    case 'queue': {
      if (!np.classList.contains('open')) openNowPlaying();
      const q = $('.np-queue');
      q.hidden = !q.hidden;
      np.classList.toggle('show-queue', !q.hidden);
      renderQueue();
      if (!q.hidden) q.querySelector('.active')?.scrollIntoView({ block: 'center' });
      return;
    }
    case 'rate':
      return optionSheet('Wiedergabetempo', RATES.map((r) => ({ label: `${String(r).replace('.', ',')}×`, value: r, active: r === player.rate })), (r) => player.setRate(r));
    case 'sleep':
      return optionSheet('Schlaf-Timer', SLEEPS.map(([v, l]) => ({
        label: l, value: v,
        active: v === null ? !player.sleep : v === 'track' ? !!player.sleep?.endOfTrack : false,
      })), (v) => { player.setSleep(v); toast(v ? 'Schlaf-Timer gestellt' : 'Schlaf-Timer aus'); });
    case 'sheet-close': return closeSheet();
    case 'export': {
      const data = store.exportJSON();
      try { await navigator.clipboard.writeText(data); toast('Hörstand kopiert – auf dem anderen Gerät unter „Importieren“ einfügen.'); }
      catch {
        openSheet(`<div class="sheet-title">Hörstand exportieren</div><textarea class="io" readonly>${esc(data)}</textarea><button class="sheet-cancel" data-act="sheet-close">Fertig</button>`);
        $('.sheet textarea').select();
      }
      return;
    }
    case 'import':
      openSheet(`<div class="sheet-title">Hörstand importieren</div><textarea class="io" placeholder="Exportierten Text hier einfügen"></textarea>
        <button class="btn wide" data-act="do-import">Zusammenführen</button><button class="sheet-cancel" data-act="sheet-close">Abbrechen</button>`);
      return;
    case 'do-import': {
      try {
        const changed = store.merge(JSON.parse($('.sheet textarea').value));
        toast(changed ? 'Hörstand übernommen' : 'Nichts Neueres gefunden');
        closeSheet();
        route();
      } catch { toast('Das ist kein gültiger Export.'); }
      return;
    }
  }
});

// Sidebar-Suche (Desktop)
$('.side-search').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = e.target.q.value.trim();
  location.hash = `#/search${q ? `?q=${encodeURIComponent(q)}${aiAvailable() ? '&ai=1' : ''}` : ''}`;
});

// Tastatur: Leertaste, Pfeile, Esc
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === ' ' && player.item) { e.preventDefault(); player.toggle(); }
  else if (e.key === 'ArrowLeft' && player.item) player.skip(-15);
  else if (e.key === 'ArrowRight' && player.item) player.skip(30);
  else if (e.key === 'Escape') { if (!sheetWrap.hidden) closeSheet(); else closeNowPlaying(); }
});

// ---------- Start ----------

player.addEventListener('change', updatePlayerUI);
player.addEventListener('track', updatePlayerUI);
player.addEventListener('time', updateTimeUI);
store.subscribe(() => { updateItemView(); if (player.item) updatePlayerUI(); });

hydrateIcons();
route();

// Letzten Titel wiederherstellen – pausiert, exakt an der gespeicherten Stelle.
const lastId = store.get().lastId;
if (lastId && !store.progress(lastId)?.removed) {
  getItem(lastId).then((item) => { if (!player.item) player.resume(item, false); }).catch(() => {});
}

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
