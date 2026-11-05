// Home: search, the recipe cards, and above them the folder button with the
// filter bar beside it (Diet, Time, Difficulty, More). On bigger screens each
// opens a small panel under the bar; on phones the folder button opens one
// sheet with the folder list and the filters as pills on top.

import { fmtDuration } from './cooklang.js';
import { CLOSE_ICON } from './icons.js';
import { planView } from './lazy.js';
import { canPlan } from './planner.js';
import { S } from './state.js';
import { $, $$, SKIP_TOP, cap, chapterLabel, collator, debounce, encPath, esc, fold, saved, wideBrowse } from './util.js';

const FACETS = [
  ['diet', 'Diet'],
  ['difficulty', 'Difficulty'],
  ['course', 'Course'],
  ['cuisine', 'Cuisine'],
  ['tags', 'Tags'],
];
// Rarely used, so behind More.
const MORE = ['course', 'cuisine', 'tags'];
const openFacets = new Set();
// Each recipe has one; you can pick several.
const DIETS = [['meat', 'Meat'], ['fish', 'Fish'], ['vegetarian', 'Vegetarian'], ['vegan', 'Vegan']];
const DIFFICULTY_ORDER = ['easy', 'medium', 'hard'];
// The time slider's scale in minutes: every 15 minutes up to an hour, then
// every half hour; the top end means "or more".
const STOPS = [0, 15, 30, 45, 60, 90, 120, Infinity];
const TOP = STOPS.length - 1;

const FOLDER_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg>';
const CHEV = '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>';
const MORE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h9m4 0h3M4 17h3m4 0h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg>';
const CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7"/></svg>';
const X = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8"/></svg>';

function valuesFor(e, key) {
  if (key === 'tags') return e.tags;
  // "pescatarian" is the old name for fish
  if (key === 'diet') return e.diet === 'pescatarian' ? ['fish'] : [e.diet].filter(Boolean);
  return [e[key]].filter(Boolean);
}

const anyTime = (t) => t.lo === 0 && t.hi === TOP;
const timeOk = (e, t) => anyTime(t) || (e.time != null && e.time >= STOPS[t.lo] && e.time <= STOPS[t.hi]);

function matches(e, f, skip) {
  if (f.chapter && e.chapter !== f.chapter) return false;
  if (f.sub && !(e.sub === f.sub || e.sub.startsWith(f.sub + '/'))) return false;
  if (f.q) {
    const words = fold(f.q).split(/\s+/).filter(Boolean);
    if (!words.every((w) => e.search.includes(w))) return false;
  }
  if (skip !== 'time' && !timeOk(e, f.time)) return false;
  for (const [key] of FACETS) {
    if (key === skip) continue;
    const sel = f[key];
    if (sel.size && !valuesFor(e, key).some((v) => sel.has(v))) return false;
  }
  return true;
}

// ---- what the bar and the chips say

/** A place on the time scale: "15 min", "1 h 30", "2 h+". */
function stopText(i) {
  if (i === TOP) return `${stopText(TOP - 1)}+`;
  const m = STOPS[i];
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60}` : ''}`;
}

function timeLabel(t) {
  if (anyTime(t)) return '';
  if (t.lo === 0) return `Up to ${stopText(t.hi)}`;
  if (t.hi === TOP) return `${stopText(t.lo)} or more`;
  const a = stopText(t.lo), b = stopText(t.hi);
  return `${a.endsWith(' min') && b.endsWith(' min') ? a.slice(0, -4) : a} to ${b}`;
}

function dietLabel(d) {
  if (!d.size || d.size === DIETS.length) return '';
  const has = (k) => d.has(k);
  if (d.size === 3 && !has('meat')) return 'No meat';
  if (d.size === 2 && has('vegetarian') && has('vegan')) return 'Vegetarian';
  if (d.size === 2 && has('meat') && has('fish')) return 'Meat or fish';
  return DIETS.filter(([k]) => has(k)).map(([, n], i) => (i ? n.toLowerCase() : n)).join(', ');
}

// a vegan dish is vegetarian too, so vegetarian brings vegan along
function toggleDiet(k) {
  const d = S.filters.diet;
  const on = !d.has(k);
  for (const x of k === 'vegetarian' ? ['vegetarian', 'vegan'] : [k]) on ? d.add(x) : d.delete(x);
}

// two of the three reads best as the one left out: "Not hard"
function diffLabel(d) {
  if (!d.size || d.size === DIFFICULTY_ORDER.length) return '';
  if (d.size === DIFFICULTY_ORDER.length - 1) return `Not ${DIFFICULTY_ORDER.find((v) => !d.has(v))}`;
  return DIFFICULTY_ORDER.filter((v) => d.has(v)).map((v, i) => (i ? v : cap(v))).join(', ');
}

/** Every filter that is on, each one a chip under the search on phones. */
function chosen() {
  const f = S.filters;
  const out = [];
  for (const [key, label] of [['diet', dietLabel(f.diet)], ['time', timeLabel(f.time)], ['difficulty', diffLabel(f.difficulty)]]) if (label) out.push({ key, label });
  for (const key of MORE) for (const val of f[key]) out.push({ key, val, label: cap(val) });
  return out;
}

function unchoose(c) {
  const f = S.filters;
  if (c.key === 'time') f.time = { lo: 0, hi: TOP };
  else if (c.val == null) f[c.key].clear();
  else f[c.key].delete(c.val);
}

function clearChosen() {
  const f = S.filters;
  for (const [key] of FACETS) f[key].clear();
  f.time = { lo: 0, hi: TOP };
}

function clearFilters() {
  const f = S.filters;
  f.q = ''; f.chapter = ''; f.sub = '';
  clearChosen();
  const q = /** @type {HTMLInputElement} */ ($('#q'));
  if (q) q.value = '';
  updateHome();
}

export function showHome() {
  document.body.dataset.view = 'home';
  S.browse.pop = '';
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
        <div class="browse-btns">
          <button class="place" id="place" aria-haspopup="true"></button>
          <div class="fbar" id="fbar" role="group" aria-label="Filters"></div>
          <label class="sort" id="sort-btn">
            <span class="sr">Sort</span>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v16m0 0-3.5-3.5M7 20l3.5-3.5M17 20V4m0 0-3.5 3.5M17 4l3.5 3.5"/></svg>
            <select id="sort">
              <option value="recent">Latest</option>
              <option value="name">A to Z</option>
              <option value="time">Quickest</option>
              <option value="random">Random</option>
            </select>
          </label>
        </div>
      </div>
      <div class="pop" id="pop" hidden></div>
      <div class="active" id="active"></div>
      <div id="today"></div>
      <div class="grid" id="grid"></div>
      <dialog class="sheet" id="browse" aria-label="Folders and filters"></dialog>
    </section>`;
  // Sort is just its icon; the real select lies invisibly on top of it and the
  // choice shows when you point at it.
  const sort = /** @type {HTMLSelectElement} */ ($('#sort'));
  const sortNow = () => { $('#sort-btn').title = `Sort: ${sort.selectedOptions[0]?.textContent || ''}`; };
  if (![...sort.options].some((o) => o.value === S.sort)) S.sort = 'recent';
  sort.value = S.sort;
  sortNow();
  $('#place').addEventListener('click', () => (wideBrowse.matches ? togglePop('folder') : openSheet()));
  $('#browse').addEventListener('click', (ev) => { if (ev.target === ev.currentTarget) /** @type {HTMLDialogElement} */ (ev.currentTarget).close(); });
  $('#q').addEventListener('input', debounce((ev) => { S.filters.q = ev.target.value; updateHome(); }, 120));
  sort.onchange = () => {
    S.sort = sort.value;
    saved.set('sort', S.sort);
    if (S.sort === 'random') S.shuffle = null; // picking Random again deals a new order
    sortNow();
    updateHome();
  };
  updateHome();
  if (canPlan()) planView().then((v) => v.drawToday());
}

/** Draws home again. `keep` names a panel to leave alone: the time slider while it is dragged. */
function updateHome(keep = '') {
  const f = S.filters;
  const all = [...S.recipes.values()];
  const picked = chosen();

  // phones: the filters that are on, as chips under the search
  $('#active').innerHTML = picked.length ? picked.map((c, i) => `<button class="pill" data-i="${i}" aria-label="Remove filter ${esc(c.label)}">${esc(c.label)}${X}</button>`).join('') + '<button class="link-btn" id="clear">Clear filters</button>' : '';
  $$('#active .pill').forEach((b) => { b.onclick = () => { unchoose(picked[+b.dataset.i]); updateHome(); }; });
  if (picked.length) $('#clear').onclick = clearFilters;

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

  // where you are, on the folder button
  const sel = selectedFolder();
  const crumbs = sel ? sel.split('/').map(chapterLabel) : ['All recipes'];
  const n = list.length;
  /** @type {HTMLInputElement} */ ($('#q')).placeholder = wideBrowse.matches ? 'Search recipes or ingredients' : 'Search';
  $('#place').innerHTML = `${FOLDER_ICON}<span class="place-path">${esc(crumbs.at(-1))}</span><span class="place-n">${n}</span>${CHEV}`;
  $('#place').setAttribute('aria-label', `Folders. Showing ${crumbs.join(', ')}, ${n} recipes`);

  keepFocus($('#fbar'), renderBar);
  fitRow();
  renderPop(all, keep);
  renderSheet(all, n, keep);
}

/**
 * Bigger screens: search, folder, filters and sort share one row while the
 * search is at least as wide as the rest; narrower than that, the search gets
 * a row of its own and the folder button stretches to fill the one below.
 * Phones: search, folder and sort always share the row; once the search
 * would be narrower than the folder button, that button is just its icon.
 */
function fitRow() {
  const row = $('.searchrow');
  if (!row) return;
  row.classList.remove('is-wrapped', 'is-compact');
  const rest = $('.browse-btns', row).offsetWidth;
  const search = row.clientWidth - rest - 10;
  if (wideBrowse.matches) row.classList.toggle('is-wrapped', search < rest);
  else row.classList.toggle('is-compact', search < $('#place').offsetWidth);
}
new ResizeObserver(() => { fitRow(); placePop(); }).observe(document.documentElement);

/** Redraws el and puts the focus back on the same control, so keyboard users keep their place. */
function keepFocus(el, draw) {
  const a = document.activeElement;
  const sel = a && a !== el && el.contains(a) ? [...a.attributes].filter((x) => x.name.startsWith('data-')).map((x) => `[${x.name}="${CSS.escape(x.value)}"]`).join('') : '';
  draw();
  if (sel) /** @type {HTMLElement} */ ($(sel, el))?.focus({ preventScroll: true });
}

// ---- the bar beside the folder button (bigger screens)

/** The parts of a filter bar, each a button with `data-<attr>`; the phone sheet calls Difficulty "Level" to fit. */
function segsHTML(attr, open, diffName = 'Difficulty') {
  const f = S.filters;
  const seg = (k, name, val) => `<button class="fseg" data-${attr}="${k}" aria-haspopup="true" aria-expanded="${open === k}"><small>${name}</small><span class="fseg-v${val ? '' : ' is-any'}">${esc(val || 'Any')}</span></button>`;
  const nMore = MORE.reduce((n, k) => n + f[k].size, 0);
  return seg('diet', 'Diet', dietLabel(f.diet)) + seg('time', 'Time', timeLabel(f.time))
    + seg('difficulty', diffName, diffLabel(f.difficulty))
    + `<button class="fseg fseg-more" data-${attr}="more" aria-haspopup="true" aria-expanded="${open === 'more'}" aria-label="More filters${nMore ? `, ${nMore} on` : ''}">${MORE_ICON}${nMore ? `<span class="fseg-n">${nMore}</span>` : ''}</button>`;
}

function renderBar() {
  $('#fbar').innerHTML = segsHTML('pop', S.browse.pop);
  $$('#fbar [data-pop]').forEach((b) => { b.onclick = () => togglePop(b.dataset.pop); });
}

function togglePop(kind) {
  S.browse.pop = S.browse.pop === kind ? '' : kind;
  updateHome();
  // into the panel, on what is picked there
  if (S.browse.pop) /** @type {HTMLElement} */ ($('#pop .is-here, #pop [aria-pressed="true"], #pop button, #pop input'))?.focus({ preventScroll: true });
}

function closePop() {
  if (!S.browse.pop) return;
  S.browse.pop = '';
  updateHome();
}

function renderPop(all, keep) {
  const el = $('#pop');
  if (!el) return;
  const kind = wideBrowse.matches ? S.browse.pop : '';
  el.hidden = !kind;
  $('#place').setAttribute('aria-expanded', String(kind === 'folder'));
  if (!kind) return;
  if (keep !== kind) {
    el.className = `pop pop-${kind}`;
    keepFocus(el, () => {
      el.innerHTML = kind === 'folder' ? folderPanel(all) : panelHTML(kind, all);
      bindPanel(el, all);
      $$('[data-pick]', el).forEach((b) => { b.onclick = () => { selectFolder(b.dataset.pick); S.browse.pop = ''; updateHome(); $('#place').focus(); }; });
    });
  }
  placePop();
}

// under the folder button across the page, or under its own part of the bar
// (which grows as you pick, and moves when the row wraps)
function placePop() {
  const el = $('#pop');
  const kind = S.browse.pop;
  if (!el || el.hidden || !kind) return;
  const home = $('.home').getBoundingClientRect();
  el.style.top = `${$('.searchrow').getBoundingClientRect().bottom - home.top + 8}px`;
  if (kind === 'folder') { el.style.left = '0'; return; }
  const at = $(`#fbar [data-pop="${kind}"]`).getBoundingClientRect();
  el.style.left = `${Math.max(0, Math.min(at.left - home.left, home.width - el.offsetWidth))}px`;
}

// close the panel on a click outside it, or Escape
document.addEventListener('pointerdown', (ev) => {
  const pop = $('#pop');
  if (pop && !pop.hidden && !/** @type {Element} */ (ev.target).closest('#pop, #place, #fbar')) closePop();
});
document.addEventListener('keydown', (ev) => {
  const kind = S.browse.pop;
  if (ev.key !== 'Escape' || !kind || $('#pop')?.hidden !== false) return;
  closePop();
  /** @type {HTMLElement} */ (kind === 'folder' ? $('#place') : $(`#fbar [data-pop="${kind}"]`))?.focus();
});
wideBrowse.addEventListener('change', () => {
  if (!$('#grid')) return;
  S.browse.pop = '';
  /** @type {HTMLDialogElement} */ ($('#browse'))?.close();
  updateHome();
});

// ---- the filters themselves, in a panel under the bar or open in the phone sheet

function counts(all, key) {
  const c = new Map();
  for (const e of all) {
    if (!matches(e, S.filters, key)) continue;
    for (const v of valuesFor(e, key)) c.set(v, (c.get(v) || 0) + 1);
  }
  return c;
}

function panelHTML(kind, all) {
  const f = S.filters;
  // diet and difficulty: tick as many as you like
  const checks = (key, attr, opts) => {
    const c = counts(all, key);
    return `<div class="chk-list">${opts.map(([v, name]) => `
      <button class="chk" data-${attr}="${v}" aria-pressed="${f[key].has(v)}"><span class="chk-box">${CHECK}</span>${name}<span class="chk-n">${c.get(v) || 0}</span></button>`).join('')}
    </div>`;
  };
  if (kind === 'diet') return `${checks('diet', 'diet', DIETS)}<p class="pop-hint">Vegetarian picks vegan too</p>`;
  if (kind === 'difficulty') return checks('difficulty', 'diff', DIFFICULTY_ORDER.map((v) => [v, cap(v)]));
  if (kind === 'time') return timeHTML(all);
  return `<div class="more">${facetsHTML(all, MORE)}</div>
    <div class="pop-foot"><button class="link-btn" data-clear>Clear all filters</button></div>`;
}

function bindPanel(el, all) {
  $$('[data-diet]', el).forEach((b) => { b.onclick = () => { toggleDiet(b.dataset.diet); updateHome(); }; });
  $$('[data-diff]', el).forEach((b) => {
    b.onclick = () => {
      const d = S.filters.difficulty;
      d.has(b.dataset.diff) ? d.delete(b.dataset.diff) : d.add(b.dataset.diff);
      updateHome();
    };
  });
  $$('[data-clear]', el).forEach((b) => { b.onclick = () => { clearChosen(); updateHome(); }; });
  bindFacets(el);
  bindTime(el, all);
}

// Time: a slider with two ends over a small chart of how long the recipes take.
function timeHTML(all) {
  const t = S.filters.time;
  const pool = all.filter((e) => matches(e, S.filters, 'time'));
  const bins = STOPS.slice(1).map(() => 0);
  for (const e of pool) if (e.time != null) bins[Math.max(0, STOPS.findIndex((m) => e.time <= m) - 1)]++;
  const max = Math.max(1, ...bins);
  return `<div class="tsl">
    <p class="tsl-read"><b></b> <span></span></p>
    <div class="tsl-hist" aria-hidden="true">${bins.map((b) => `<span style="height:${Math.round((b / max) * 100)}%"></span>`).join('')}</div>
    <div class="tsl-track"><span class="tsl-fill"></span>
      <input type="range" min="0" max="${TOP}" step="1" value="${t.lo}" data-end="lo" aria-label="Shortest time">
      <input type="range" min="0" max="${TOP}" step="1" value="${t.hi}" data-end="hi" aria-label="Longest time">
    </div>
    <div class="tsl-ticks" aria-hidden="true">${[0, 2, 4, 6, TOP].map((i) => `<span style="left:${(i / TOP) * 100}%">${i ? stopText(i) : '0'}</span>`).join('')}</div>
  </div>`;
}

function bindTime(el, all) {
  const tsl = $('.tsl', el);
  if (!tsl) return;
  const [lo, hi] = /** @type {HTMLInputElement[]} */ ($$('input', tsl));
  const pool = all.filter((e) => matches(e, S.filters, 'time'));
  const paint = () => {
    const t = S.filters.time;
    const n = pool.filter((e) => timeOk(e, t)).length;
    tsl.style.setProperty('--lo', String(t.lo / TOP));
    tsl.style.setProperty('--hi', String(t.hi / TOP));
    $('.tsl-read b', tsl).textContent = timeLabel(t) || 'Any time';
    $('.tsl-read span', tsl).textContent = `${n} recipe${n === 1 ? '' : 's'}`;
    $$('.tsl-hist span', tsl).forEach((s, i) => s.classList.toggle('in', i >= t.lo && i < t.hi));
    lo.setAttribute('aria-valuetext', stopText(t.lo));
    hi.setAttribute('aria-valuetext', stopText(t.hi));
  };
  const live = (ev) => {
    let a = +lo.value, b = +hi.value;
    // the two ends never cross
    if (a >= b) {
      if (ev.target === lo) lo.value = String(a = b - 1);
      else hi.value = String(b = a + 1);
    }
    S.filters.time = { lo: a, hi: b };
    paint();
    updateHome('time');
  };
  lo.oninput = live;
  hi.oninput = live;
  paint();
}

function facetsHTML(all, keys) {
  const f = S.filters;
  return FACETS.filter(([key]) => keys.includes(key)).map(([key, label]) => {
    const c = counts(all, key);
    for (const v of f[key]) if (!c.has(v)) c.set(v, 0);
    const vals = [...c.keys()];
    if (key === 'tags') vals.sort((a, b) => c.get(b) - c.get(a) || collator.compare(a, b));
    else vals.sort(collator.compare);
    if (!vals.length) return '';
    const opts = `<div class="facet-opts">${vals.map((v) => `
      <button class="opt" data-key="${key}" data-val="${esc(v)}" aria-pressed="${f[key].has(v)}">${esc(cap(v))} <span>${c.get(v)}</span></button>`).join('')}</div>`;
    if (key === 'tags') {
      const n = f[key].size;
      return `<details class="facet facet-${key}" data-fold="${key}" ${n || openFacets.has(key) ? 'open' : ''}><summary>${label}${n ? ` <span>${n} on</span>` : ''}${CHEV}</summary>${opts}</details>`;
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
    d.addEventListener('toggle', () => { /** @type {HTMLDetailsElement} */ (d).open ? openFacets.add(d.dataset.fold) : openFacets.delete(d.dataset.fold); });
  });
}

// ---- folders

const selectedFolder = () => [S.filters.chapter, S.filters.sub].filter(Boolean).join('/');
const inFolder = (e, p) => !p || e.folder === p || e.folder.startsWith(p + '/');
const folderName = (p) => (p ? chapterLabel(p.split('/').pop()) : 'All recipes');

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

/** How many recipes each folder has with the filters on, and the class that marks where you are. */
function folderTools(all) {
  const pool = all.filter((e) => matches(e, { ...S.filters, chapter: '', sub: '' }));
  const count = (p) => pool.filter((e) => inFolder(e, p)).length;
  const sel = selectedFolder();
  const cls = (base, p) => `${base}${p === sel ? ' is-here' : ''}${count(p) ? '' : ' is-empty'}`;
  return { count, cls };
}

// Bigger screens: every folder at once in flowing columns, subfolders as small chips under it.
function folderPanel(all) {
  const { count, cls } = folderTools(all);
  const chips = (p) => {
    const kids = childFolders(p);
    const chip = `<button class="${cls('fp-sub', p)}" data-pick="${esc(p)}">${esc(folderName(p))}</button>`;
    return kids.length ? `<span class="fp-nest">${chip}<span class="fp-sep" aria-hidden="true">›</span>${kids.map(chips).join('')}</span>` : chip;
  };
  const group = (p) => {
    const kids = p ? childFolders(p) : [];
    return `<div class="fp-group"><button class="${cls('fp-head', p)}" data-pick="${esc(p)}">${esc(folderName(p))} <span>${count(p)}</span></button>
      ${kids.length ? `<div class="fp-subs">${kids.map(chips).join('')}</div>` : ''}</div>`;
  };
  return `<div class="fp">${group('')}${childFolders('').map(group).join('')}</div>`;
}

// Phones: one sheet, the filters as pills on top and the folder list below,
// a folder with subfolders opening in place.
function openSheet() {
  const b = S.browse;
  b.pill = '';
  const parts = selectedFolder().split('/').filter(Boolean);
  b.open = new Set(parts.map((_, i) => parts.slice(0, i + 1).join('/')));
  const dlg = /** @type {HTMLDialogElement} */ ($('#browse'));
  dlg.innerHTML = `
    <div class="sheet-grab" aria-hidden="true"></div>
    <div class="mband">
      <div class="mband-head"><h2 class="mlabel">Filter</h2><button class="sheet-x" id="b-close" aria-label="Close">${CLOSE_ICON}</button></div>
      <div class="fbar mbar" id="m-pills" role="group" aria-label="Filters"></div>
      <div class="mpanel" id="m-panel" hidden></div>
    </div>
    <h2 class="mlabel mlabel-folders">Folder</h2>
    <div class="sheet-body" id="m-list"></div>
    <div class="sheet-foot"><button class="link-btn" id="b-clear">Clear</button><button class="btn btn-primary" id="b-show"></button></div>`;
  $('#b-close').onclick = () => dlg.close();
  $('#b-show').onclick = () => dlg.close();
  $('#b-clear').onclick = () => { clearChosen(); selectFolder(''); updateHome(); };
  dlg.showModal();
  updateHome();
}

function renderSheet(all, shown, keep) {
  const dlg = $('#browse');
  if (!dlg?.open) return;
  const f = S.filters;
  const b = S.browse;
  keepFocus($('#m-pills', dlg), () => {
    $('#m-pills', dlg).innerHTML = segsHTML('pill', b.pill, 'Level');
    $$('[data-pill]', dlg).forEach((p) => { p.onclick = () => { b.pill = b.pill === p.dataset.pill ? '' : p.dataset.pill; updateHome(); }; });
  });

  const panel = $('#m-panel', dlg);
  panel.hidden = !b.pill;
  if (!(keep === 'time' && b.pill === 'time')) keepFocus(panel, () => { panel.innerHTML = b.pill ? panelHTML(b.pill, all) : ''; bindPanel(panel, all); });

  const { count, cls } = folderTools(all);
  const row = (p, depth) => {
    const kids = childFolders(p);
    const open = kids.length > 0 && b.open.has(p);
    return `<button class="${cls(depth ? 'frow is-sub' : 'frow', p)}" data-pick="${esc(p)}" style="--depth:${depth}"${kids.length ? ` aria-expanded="${open}"` : ''}>
      <span class="frow-name">${esc(folderName(p))}</span><span class="frow-n">${count(p)}</span>${kids.length ? CHEV : ''}</button>${open ? kids.map((k) => row(k, depth + 1)).join('') : ''}`;
  };
  const list = $('#m-list', dlg);
  keepFocus(list, () => {
    list.innerHTML = `<button class="${cls('frow', '')}" data-pick="" style="--depth:0"><span class="frow-name">All recipes</span><span class="frow-n">${count('')}</span></button>`
      + childFolders('').map((p) => row(p, 0)).join('');
    $$('[data-pick]', list).forEach((r) => {
      r.onclick = () => {
        // a folder with subfolders opens as it is picked, and closes on a second tap
        const p = r.dataset.pick;
        if (r.hasAttribute('aria-expanded')) b.open.has(p) && selectedFolder() === p ? b.open.delete(p) : b.open.add(p);
        selectFolder(p);
        updateHome();
      };
    });
  });
  $('#b-show', dlg).textContent = `Show ${shown} recipe${shown === 1 ? '' : 's'}`;
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
