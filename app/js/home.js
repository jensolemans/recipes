// Home: search, sort, the recipe cards, and the folder button that opens one
// panel with the Drive folders and the filters (a bottom sheet with two tabs
// on phones, a wide panel with both side by side on bigger screens).

import { fmtDuration } from './cooklang.js';
import { go } from './app.js';
import { planView } from './lazy.js';
import { canPlan } from './planner.js';
import { S } from './state.js';
import { $, $$, SKIP_TOP, cap, chapterLabel, collator, debounce, encPath, esc, fold, pool, saved, wide, wideBrowse } from './util.js';

const FACETS = [
  ['diet', 'Diet'],
  ['difficulty', 'Difficulty'],
  ['time', 'Time'],
  ['course', 'Course'],
  ['cuisine', 'Cuisine'],
  ['tags', 'Tags'],
];
// Rarely used, so folded away until opened (or one of them is picked).
const FOLDED_FACETS = new Set(['course', 'tags', 'cuisine']);
const openFacets = new Set();
const TIME_BUCKETS = ['30 min or less', '30 to 60 min', '1 to 2 hours', 'Over 2 hours'];
const DIFFICULTY_ORDER = ['easy', 'medium', 'hard'];

function timeBucket(min) {
  if (min == null) return null;
  if (min <= 30) return TIME_BUCKETS[0];
  if (min <= 60) return TIME_BUCKETS[1];
  if (min <= 120) return TIME_BUCKETS[2];
  return TIME_BUCKETS[3];
}

function valuesFor(e, key) {
  switch (key) {
    case 'tags': return e.tags;
    case 'time': return [timeBucket(e.time)].filter(Boolean);
    case 'diet': return e.diet === 'vegan' ? ['vegan', 'vegetarian'] : [e.diet].filter(Boolean);
    default: return [e[key]].filter(Boolean);
  }
}

function matches(e, f, skip) {
  if (f.chapter && e.chapter !== f.chapter) return false;
  if (f.sub && !(e.sub === f.sub || e.sub.startsWith(f.sub + '/'))) return false;
  if (f.q) {
    const words = fold(f.q).split(/\s+/).filter(Boolean);
    if (!words.every((w) => e.search.includes(w))) return false;
  }
  for (const [key] of FACETS) {
    if (key === skip) continue;
    const sel = f[key];
    if (sel.size && !valuesFor(e, key).some((v) => sel.has(v))) return false;
  }
  return true;
}

export function showHome() {
  document.body.dataset.view = 'home';
  const title = S.config.title || 'Recipes';
  $('#main').innerHTML = `
    <section class="home">
      <div class="home-head">
        <h1 class="home-title">${esc(title)}</h1>
      </div>
      <div class="searchrow">
        <label class="search">
          <span class="sr">Search</span>
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>
          <input id="q" type="search" placeholder="Search recipes or ingredients" autocomplete="off" value="${esc(S.filters.q)}">
        </label>
        <button class="place" id="place" aria-haspopup="dialog"></button>
        <label class="sort">
          <span class="sr">Sort</span>
          <svg class="sort-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v16m0 0-3.5-3.5M7 20l3.5-3.5M17 20V4m0 0-3.5 3.5M17 4l3.5 3.5"/></svg>
          <span class="sort-now" id="sort-now" aria-hidden="true"></span>
          <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>
          <select id="sort">
            <option value="recent">Latest</option>
            <option value="name">A to Z</option>
            <option value="time">Quickest</option>
            <option value="random">Random</option>
          </select>
        </label>
      </div>
      <div class="active" id="active"></div>
      <div id="today"></div>
      <div class="grid" id="grid"></div>
      <dialog class="sheet" id="browse" aria-label="Browse recipes"></dialog>
    </section>`;
  // The pill shows the choice itself, so it is always as wide as its words;
  // the real select lies invisibly on top of it.
  const sortNow = () => { $('#sort-now').textContent = $('#sort').selectedOptions[0]?.textContent || ''; };
  if (![...$('#sort').options].some((o) => o.value === S.sort)) S.sort = 'recent';
  $('#sort').value = S.sort;
  sortNow();
  $('#place').onclick = openBrowse;
  $('#browse').onclick = (ev) => { if (ev.target === ev.currentTarget) ev.currentTarget.close(); };
  $('#q').addEventListener('input', debounce((ev) => { S.filters.q = ev.target.value; updateHome(); }, 120));
  $('#sort').onchange = (ev) => {
    S.sort = ev.target.value;
    saved.set('sort', S.sort);
    if (S.sort === 'random') S.shuffle = null; // picking Random again deals a new order
    sortNow();
    updateHome();
  };
  updateHome();
  if (canPlan()) planView().then((v) => v.drawToday());
}

function updateHome() {
  const f = S.filters;
  const all = [...S.recipes.values()];

  // active filter chips
  const active = FACETS.flatMap(([key]) => [...f[key]].map((v) => [key, v]));
  $('#active').innerHTML = active.length ? active.map(([key, v]) => `<button class="pill" data-key="${key}" data-val="${esc(v)}" aria-label="Remove filter ${esc(v)}">${esc(cap(v))}<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8"/></svg></button>`).join('') + '<button class="link-btn" id="clear">Clear filters</button>' : '';
  $$('#active .pill').forEach((b) => { b.onclick = () => { f[b.dataset.key].delete(b.dataset.val); updateHome(); }; });
  if (active.length) $('#clear').onclick = clearFilters;
  const nActive = active.length;

  // grid
  let list = all.filter((e) => matches(e, f));
  const byName = (a, b) => collator.compare(a.title, b.title);
  if (S.sort === 'time') list.sort((a, b) => (a.time ?? 1e9) - (b.time ?? 1e9) || byName(a, b));
  else if (S.sort === 'recent') list.sort((a, b) => (b.modified || 0) - (a.modified || 0) || byName(a, b));
  else if (S.sort === 'random') {
    // one shuffled order that stays put while you search and filter
    if (!S.shuffle) S.shuffle = new Map();
    const at = (e) => { if (!S.shuffle.has(e.path)) S.shuffle.set(e.path, Math.random()); return S.shuffle.get(e.path); };
    list.sort((a, b) => at(a) - at(b));
  }
  else list.sort(byName);

  $('#grid').innerHTML = list.length ? list.map(card).join('') : `
    <div class="empty"><p>No recipes match.</p><button class="btn btn-quiet" id="clear2">Clear search and filters</button></div>`;
  if (!list.length) $('#clear2').onclick = clearFilters;

  // where you are, on the button that opens the folder and filter panel
  const sel = selectedFolder();
  const crumbs = sel ? sel.split('/').map(chapterLabel) : ['All recipes'];
  $('#place').innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg>
    <span class="place-path"><b>${esc(crumbs.at(-1))}</b>${crumbs.length > 1 ? ` <span class="muted">in ${esc(crumbs.slice(0, -1).join(' / '))}</span>` : ''}</span>
    <span class="place-n">${list.length}</span><svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>`;
  $('#place').setAttribute('aria-label', `Browse folders and filters. Showing ${crumbs.join(', ')}, ${list.length} recipes${nActive ? `, ${nActive} filters on` : ''}`);
  renderBrowse(list.length);
}

function facetsHTML(all) {
  const f = S.filters;
  return FACETS.map(([key, label]) => {
    const counts = new Map();
    for (const e of all) {
      if (!matches(e, f, key)) continue;
      for (const v of valuesFor(e, key)) counts.set(v, (counts.get(v) || 0) + 1);
    }
    for (const v of f[key]) if (!counts.has(v)) counts.set(v, 0);
    let vals = [...counts.keys()];
    if (key === 'time') vals.sort((a, b) => TIME_BUCKETS.indexOf(a) - TIME_BUCKETS.indexOf(b));
    else if (key === 'difficulty') vals.sort((a, b) => (DIFFICULTY_ORDER.indexOf(a) + 1 || 9) - (DIFFICULTY_ORDER.indexOf(b) + 1 || 9));
    else if (key === 'tags') vals.sort((a, b) => counts.get(b) - counts.get(a) || collator.compare(a, b));
    else vals.sort(collator.compare);
    if (!vals.length) return '';
    const opts = `<div class="facet-opts">${vals.map((v) => `
      <button class="opt" data-key="${key}" data-val="${esc(v)}" aria-pressed="${f[key].has(v)}">${esc(cap(v))} <span>${counts.get(v)}</span></button>`).join('')}</div>`;
    if (FOLDED_FACETS.has(key)) {
      const n = f[key].size;
      return `<details class="facet facet-${key}" data-fold="${key}" ${n || openFacets.has(key) ? 'open' : ''}><summary>${label}${n ? ` <span>${n} on</span>` : ''}<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg></summary>${opts}</details>`;
    }
    return `<fieldset class="facet facet-${key}"><legend>${label}</legend>${opts}</fieldset>`;
  }).join('');
}

function bindFacets(el) {
  $$('.opt', el).forEach((b) => {
    b.onclick = () => {
      const set = S.filters[b.dataset.key];
      set.has(b.dataset.val) ? set.delete(b.dataset.val) : set.add(b.dataset.val);
      updateHome();
    };
  });
  $$('[data-fold]', el).forEach((d) => {
    d.ontoggle = () => { d.open ? openFacets.add(d.dataset.fold) : openFacets.delete(d.dataset.fold); };
  });
}

// ---- folder panel: the Drive folders with a path back up, and the filters

const selectedFolder = () => [S.filters.chapter, S.filters.sub].filter(Boolean).join('/');
const inFolder = (e, p) => !p || e.folder === p || e.folder.startsWith(p + '/');

function selectFolder(p) {
  const [chapter = '', ...rest] = p ? p.split('/') : [];
  S.filters.chapter = chapter;
  S.filters.sub = rest.join('/');
}

/** Folders directly inside `at` that hold recipes somewhere below them. */
function childFolders(at) {
  const depth = at ? at.split('/').length : 0;
  const kids = new Set();
  for (const e of S.recipes.values()) {
    if (!e.folder || !inFolder(e, at)) continue;
    const parts = e.folder.split('/');
    if (parts.length > depth) kids.add(parts.slice(0, depth + 1).join('/'));
  }
  return [...kids].filter((p) => !SKIP_TOP.test(p)).sort(collator.compare);
}

/** Opens the folder and filter panel where you are: a bottom sheet with two tabs on phones, one wide panel on bigger screens. */
function openBrowse() {
  const sel = selectedFolder();
  // phones show one level, so open on the current folder's level; wide screens show two, so one higher
  const up = (childFolders(sel).length ? 0 : 1) + (wideBrowse.matches ? 1 : 0);
  S.browse = { at: sel.split('/').slice(0, Math.max(0, sel.split('/').length - up)).join('/'), tab: 'folders' };
  $('#browse').showModal();
  updateHome();
}

function renderBrowse(shown) {
  const dlg = $('#browse');
  if (!dlg?.open) return;
  const f = S.filters;
  const b = S.browse;
  const all = [...S.recipes.values()];
  const pool = all.filter((e) => matches(e, { ...f, chapter: '', sub: '' }));
  const count = (p) => pool.filter((e) => inFolder(e, p)).length;
  const sel = selectedFolder();
  const nFilters = FACETS.reduce((n, [key]) => n + f[key].size, 0);
  const label = (p) => (p ? chapterLabel(p.split('/').pop()) : 'All recipes');
  const chev = '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m10 7 5 5-5 5"/></svg>';
  const wide = wideBrowse.matches; // room for two levels of folders and the filters side by side, no tabs
  const showFolders = wide || b.tab === 'folders';
  const showFilters = wide || b.tab === 'filters';
  const allLabel = b.at ? `All ${label(b.at).toLowerCase()}` : 'All recipes';
  // a folder with subfolders opens, any other one is picked; "All ..." picks the folder you're in
  const go = (p, kids) => (kids ? `data-open="${esc(p)}"` : `data-pick="${esc(p)}"`);
  const cls = (base, p) => `${base}${p === sel ? ' is-here' : ''}${count(p) ? '' : ' is-empty'}`;
  let folders;
  if (wide) {
    // two levels at once: every folder with all its subfolders, the panel scrolls when they don't fit
    folders = `<button class="${cls('tree-all', b.at)}" data-pick="${esc(b.at)}">${esc(allLabel)} <span>${count(b.at)}</span></button>
      <div class="tree">${childFolders(b.at).map((p) => `<div class="tree-group">
          <button class="${cls('tree-head', p)}" data-pick="${esc(p)}">${esc(label(p))} <span>${count(p)}</span></button>
          ${childFolders(p).map((k) => `<button class="${cls('tree-leaf', k)}${sel.startsWith(k + '/') ? ' is-in' : ''}" ${go(k, childFolders(k).length)}>${esc(label(k))}${childFolders(k).length ? chev : ''}</button>`).join('')}
        </div>`).join('')}</div>`;
  } else {
    const row = (p, name, kids) => `<button class="${cls('frow', p)}${kids && sel.startsWith(p + '/') ? ' is-in' : ''}" ${go(p, kids)}>
      <span class="frow-name">${esc(name)}</span><span class="frow-n">${count(p)}</span>${kids ? chev : ''}</button>`;
    folders = row(b.at, allLabel, 0) + childFolders(b.at).map((p) => row(p, label(p), childFolders(p).length)).join('');
  }
  // the path is the way back: every folder above this one is a button
  const ups = b.at ? ['', ...b.at.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/'))] : [];
  const title = showFolders
    ? `${ups.map((p) => `<button class="crumb" data-up="${esc(p)}">${esc(label(p))}</button> <span class="crumb-sep">/</span> `).join('')}<span class="crumb-here">${esc(label(b.at))}</span>`
    : 'Filters';
  const filters = `<div class="sheet-facets">${wide ? '<h3>Filters</h3>' : ''}${facetsHTML(all)}</div>`;
  const scrolls = $$('.sheet-body', dlg).map((el) => el.scrollTop);
  dlg.innerHTML = `
    <div class="sheet-grab" aria-hidden="true"></div>
    <div class="sheet-head">
      <h2 class="sheet-path">${title}</h2>
      <button class="sheet-x" id="b-close" aria-label="Close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg></button>
    </div>
    ${wide ? `<div class="sheet-cols"><div class="sheet-body sheet-folders">${folders}</div><div class="sheet-body sheet-side">${filters}</div></div>` : `
    <div class="seg" role="tablist">
      <button role="tab" data-tab="folders" aria-selected="${b.tab === 'folders'}">Folders</button>
      <button role="tab" data-tab="filters" aria-selected="${b.tab === 'filters'}">Filters${nFilters ? ` (${nFilters})` : ''}</button>
    </div>
    <div class="sheet-body">${showFolders ? folders : filters}</div>`}
    ${showFilters ? `<div class="sheet-foot">
      <button class="link-btn" id="b-clear">Clear filters</button>
      <button class="btn btn-primary" id="b-show">Show ${shown} recipe${shown === 1 ? '' : 's'}</button>
    </div>` : ''}`;
  $$('.sheet-body', dlg).forEach((el, i) => { el.scrollTop = scrolls[i] || 0; });
  bindFacets(dlg);
  const goTo = (p) => { b.at = p; $('.sheet-body', dlg).scrollTop = 0; updateHome(); };
  $('#b-close', dlg).onclick = () => dlg.close();
  $$('[data-up]', dlg).forEach((c) => { c.onclick = () => goTo(c.dataset.up); });
  $$('[data-tab]', dlg).forEach((t) => { t.onclick = () => { b.tab = t.dataset.tab; updateHome(); }; });
  $$('[data-open]', dlg).forEach((r) => { r.onclick = () => goTo(r.dataset.open); });
  $$('[data-pick]', dlg).forEach((r) => { r.onclick = () => { selectFolder(r.dataset.pick); dlg.close(); updateHome(); window.scrollTo(0, 0); }; });
  if ($('#b-show', dlg)) $('#b-show', dlg).onclick = () => dlg.close();
  if ($('#b-clear', dlg)) $('#b-clear', dlg).onclick = () => { for (const [key] of FACETS) f[key].clear(); updateHome(); };
}
wideBrowse.addEventListener('change', () => { if ($('#browse')?.open) updateHome(); });

function clearFilters() {
  const f = S.filters;
  f.q = ''; f.chapter = ''; f.sub = '';
  for (const [key] of FACETS) f[key].clear();
  const q = $('#q'); if (q) q.value = '';
  updateHome();
}

export function cardImg(e) {
  if (e.photoLoading) return '<span class="card-img skeleton" aria-hidden="true"></span>';
  const img = e.thumbUrl
    ? `<img src="${esc(e.thumbUrl)}" alt="" loading="lazy" decoding="async">`
    : `<span class="ph" aria-hidden="true">${esc(e.title.charAt(0))}</span>`;
  return `<span class="card-img">${img}</span>`;
}

export function card(e) {
  const facts = [e.time != null ? fmtDuration(e.time) : '', cap(e.difficulty)].filter(Boolean);
  return `<a class="card" href="#/r/${encPath(e.path)}">
    ${cardImg(e)}
    <span class="card-body">
      <span class="card-title">${esc(e.title)}</span>
      <span class="card-facts">${facts.map((x) => `<span>${esc(x)}</span>`).join('')}</span>
    </span>
  </a>`;
}
