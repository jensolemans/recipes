import {
  initParser, parseRecipe, shouldList, readFrontmatter, parseDuration, fmtDuration,
  ingredientNames, fmtQuantity, fmtGrouped, fmtYield,
} from './cooklang.js';
import * as drive from './drive.js';

// ---------------------------------------------------------------- helpers

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const lc = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
const chapterLabel = (folder) => folder.replace(/^\d+\s*[-_.]?\s*/, '');
const folderLabel = (path) => path.split('/').map(chapterLabel).join(' / ');
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');
const prettifyFile = (f) => cap(f.replace(/[_-]+/g, ' ').trim());
const slugify = (s) => fold(s).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.JPG', '.JPEG', '.PNG'];
const SKIP_TOP = /^(config|tools)(\/|$)/;

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

async function pool(tasks, size = 6) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const idx = i++;
      try { results[idx] = await tasks[idx](); } catch (e) { results[idx] = e; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, tasks.length) }, worker));
  return results;
}

const saved = {
  get(k, d) { try { const v = localStorage.getItem('recipes.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('recipes.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

// ---------------------------------------------------------------- state

const S = {
  config: {},
  built: 0,
  recipes: new Map(), // path -> entry
  folders: [],
  live: 'off', // off | loading | on
  drive: null, // { folders: Map, files: Map }
  filters: { chapter: '', sub: '', q: '', course: new Set(), cuisine: new Set(), diet: new Set(), difficulty: new Set(), time: new Set(), tags: new Set() },
  sort: saved.get('sort', 'name'),
  showFilters: false,
  dirty: false,
  ignoreHash: false,
  currentHash: '',
  checked: new Map(), // path -> Set of checked ingredient keys
};

function makeEntry(r) {
  const fm = readFrontmatter(r.src);
  const parts = r.path.split('/');
  const file = parts.pop();
  const prep = parseDuration(fm['prep time']);
  const cook = parseDuration(fm['cook time']);
  let time = parseDuration(fm.time);
  if (time == null && (prep != null || cook != null)) time = (prep || 0) + (cook || 0);
  const tags = (Array.isArray(fm.tags) ? fm.tags : String(fm.tags || '').split(',')).map(lc).filter(Boolean);
  const e = {
    ...r,
    file,
    folder: parts.join('/'),
    chapter: parts[0] || '',
    sub: parts.slice(1).join('/'),
    fm,
    title: fm.title || prettifyFile(file),
    description: fm.description || '',
    course: lc(fm.course),
    cuisine: lc(fm.cuisine),
    diet: lc(fm.diet),
    difficulty: lc(fm.difficulty),
    tags,
    time,
    prep,
    cook,
    imageUrl: r.image ? `img/${r.image}.jpg` : (r.imageUrl || null),
    thumbUrl: r.image ? `thumb/${r.image}.jpg` : (r.imageUrl || null),
  };
  e.search = fold([e.title, e.description, e.cuisine, e.course, e.diet, tags.join(' '), ingredientNames(r.src).join(' '), folderLabel(e.folder)].join(' '));
  return e;
}

// ---------------------------------------------------------------- boot

async function boot() {
  let data;
  try {
    const res = await fetch('data/recipes.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    data = await res.json();
  } catch {
    $('#main').innerHTML = '<div class="empty"><h1>Recipes could not be loaded</h1><p>Check your connection and reload the page.</p></div>';
    return;
  }
  S.config = data.config || {};
  S.built = data.built || 0;
  S.folders = (data.folders || []).filter((f) => !SKIP_TOP.test(f));
  for (const r of data.recipes || []) S.recipes.set(r.path, makeEntry(r));

  const title = S.config.title || 'Recipes';
  document.title = title;
  $$('[data-brand]').forEach((el) => { el.textContent = title; });

  drive.configure(S.config.clientId);
  initParser().catch(() => {});
  renderAccount();
  renderFoot();
  window.addEventListener('hashchange', onHashChange);
  window.addEventListener('beforeunload', (ev) => { if (S.dirty) { ev.preventDefault(); ev.returnValue = ''; } });
  route();
  if (drive.signedIn()) goLive();
}

// ---------------------------------------------------------------- routing

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const q = raw.indexOf('?');
  const p = q < 0 ? raw : raw.slice(0, q);
  let path;
  try { path = p.split('/').map(decodeURIComponent).join('/'); } catch { path = p; }
  return { path, params: new URLSearchParams(q < 0 ? '' : raw.slice(q + 1)) };
}

async function onHashChange() {
  if (S.ignoreHash) { S.ignoreHash = false; return; }
  if (S.dirty) {
    const leave = await ask({
      title: 'Leave without saving?',
      body: 'Your changes to this recipe are not saved yet.',
      actions: [{ label: 'Keep editing', value: false }, { label: 'Discard changes', value: true, danger: true }],
    });
    if (!leave) {
      S.ignoreHash = true;
      history.replaceState(null, '', S.currentHash || '#/');
      return;
    }
    S.dirty = false;
  }
  route();
}

function route() {
  S.currentHash = location.hash || '#/';
  renderAccount();
  stopWakeLock();
  const { path, params } = parseHash();
  document.body.dataset.view = '';
  if (path.startsWith('/r/')) return showRecipe(path.slice(3), params);
  if (path.startsWith('/edit/')) return showEditor(path.slice(6));
  if (path === '/new') return showEditor(null);
  return showHome();
}

const go = (hash) => { location.hash = hash; };

// ---------------------------------------------------------------- account bar

function renderAccount() {
  const el = $('#account');
  if (!drive.enabled()) { el.innerHTML = ''; return; }
  if (S.live === 'loading') {
    el.innerHTML = '<span class="sync">Syncing with Google Drive…</span>';
    return;
  }
  if (S.live === 'on' && drive.signedIn()) {
    const u = drive.user() || {};
    el.innerHTML = `
      <a class="btn btn-primary btn-sm" href="#/new">New recipe</a>
      <details class="menu">
        <summary class="avatar" aria-label="Account menu">${esc((u.name || u.email || '?').charAt(0).toUpperCase())}</summary>
        <div class="menu-pop">
          <p class="menu-who">${esc(u.email || '')}</p>
          <p class="menu-note">You see live recipes from Google Drive. Friends see changes after the next hourly update.</p>
          ${S.config.publishUrl ? `<a class="menu-item" href="${esc(S.config.publishUrl)}" target="_blank" rel="noopener">Update the friends' site now</a>` : ''}
          <button class="menu-item" data-action="refresh">Reload from Google Drive</button>
          <button class="menu-item" data-action="signout">Sign out</button>
        </div>
      </details>`;
    el.querySelector('[data-action="signout"]').onclick = () => { drive.signOut(); location.reload(); };
    el.querySelector('[data-action="refresh"]').onclick = () => { el.querySelector('details').open = false; goLive(); };
    return;
  }
  el.innerHTML = '<button class="link-btn" id="signin">Sign in</button>';
  $('#signin').onclick = () => signInFlow();
}

async function signInFlow() {
  try {
    await drive.signIn();
    await goLive();
  } catch (e) {
    toast(e.message || 'Sign-in failed.');
    renderAccount();
  }
}

function renderFoot() {
  const el = $('#foot');
  if (S.live === 'on') { el.textContent = 'Showing live recipes from Google Drive.'; return; }
  if (!S.built) { el.textContent = ''; return; }
  const d = new Date(S.built * 1000);
  el.textContent = `Recipes updated ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}, ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}.`;
}

// ---------------------------------------------------------------- live mode (signed in)

function findDriveImage(files, path) {
  for (const ext of IMAGE_EXTS) {
    const f = files.get(path + ext);
    if (f) return f;
  }
  return null;
}

async function loadDriveImage(e, img) {
  try {
    const url = await drive.readBlobUrl(img.id);
    e.imageUrl = url; e.thumbUrl = url; e.imageMd5 = img.md5Checksum;
  } catch { /* keep whatever we had */ }
}

async function goLive() {
  const folderId = S.config.folderId;
  if (!folderId) { toast('The site has no Google Drive folder configured.'); return; }
  S.live = 'loading';
  renderAccount();
  try {
    const check = await drive.checkFolder(folderId);
    if (!check.canEdit) {
      toast('This Google account cannot edit the recipe folder, so you stay in read-only mode.');
      drive.signOut();
      S.live = 'off';
      renderAccount();
      return;
    }
    const { folders, files } = await drive.walk(folderId);
    S.drive = { folders, files };
    S.folders = [...folders.keys()].filter((p) => p && !SKIP_TOP.test(p)).sort(collator.compare);

    const seen = new Set();
    const tasks = [];
    for (const [p, f] of files) {
      if (!p.endsWith('.cook') || SKIP_TOP.test(p)) continue;
      const path = p.slice(0, -5);
      seen.add(path);
      const old = S.recipes.get(path);
      const img = findDriveImage(files, path);
      if (old && old.md5 === f.md5Checksum) {
        old.driveId = f.id;
        old.driveImage = img;
        if (img && img.md5Checksum !== old.imageMd5) tasks.push(() => loadDriveImage(old, img));
        if (!img) { old.imageUrl = null; old.thumbUrl = null; }
        continue;
      }
      tasks.push(async () => {
        const src = await drive.readText(f.id);
        const keepImg = old && img && old.imageMd5 === img.md5Checksum;
        const e = makeEntry({
          path, src, md5: f.md5Checksum, modified: Math.floor(Date.parse(f.modifiedTime) / 1000),
          image: keepImg ? old.image : undefined, imageMd5: keepImg ? old.imageMd5 : undefined,
        });
        e.driveId = f.id;
        e.driveImage = img;
        S.recipes.set(path, e);
        if (img && !keepImg) await loadDriveImage(e, img);
      });
    }
    for (const path of [...S.recipes.keys()]) if (!seen.has(path)) S.recipes.delete(path);
    await pool(tasks, 6);
    S.live = 'on';
  } catch (e) {
    S.live = 'off';
    toast(e.message || 'Could not load recipes from Google Drive.');
  }
  renderAccount();
  renderFoot();
  if (!S.dirty) route();
}

// ---------------------------------------------------------------- home

const FACETS = [
  ['course', 'Course'],
  ['cuisine', 'Cuisine'],
  ['diet', 'Diet'],
  ['difficulty', 'Difficulty'],
  ['time', 'Time'],
  ['tags', 'Tags'],
];
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

function chapters() {
  const tops = new Set(S.folders.map((f) => f.split('/')[0]));
  for (const e of S.recipes.values()) if (e.chapter) tops.add(e.chapter);
  return [...tops].sort(collator.compare);
}

function subFolders(chapter) {
  const subs = new Set();
  for (const e of S.recipes.values()) {
    if (e.chapter === chapter && e.sub) subs.add(e.sub.split('/')[0]);
  }
  return [...subs].sort(collator.compare);
}

function showHome() {
  document.body.dataset.view = 'home';
  const title = S.config.title || 'Recipes';
  $('#main').innerHTML = `
    <section class="home">
      <div class="home-head">
        <h1 class="home-title">${esc(title)}</h1>
        <p class="home-count" id="count"></p>
      </div>
      <div class="searchrow">
        <label class="search">
          <span class="sr">Search</span>
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>
          <input id="q" type="search" placeholder="Search recipes or ingredients" autocomplete="off" value="${esc(S.filters.q)}">
        </label>
        <button class="btn btn-quiet" id="toggle-filters" aria-expanded="${S.showFilters}" aria-controls="filters">Filters</button>
        <label class="sort">
          <span class="sr">Sort</span>
          <select id="sort">
            <option value="name">A to Z</option>
            <option value="time">Quickest first</option>
            <option value="recent">Recently changed</option>
          </select>
        </label>
      </div>
      <nav class="chapters" id="chapters" aria-label="Categories"></nav>
      <nav class="subs" id="subs" aria-label="Subcategories"></nav>
      <div class="filters" id="filters" ${S.showFilters ? '' : 'hidden'}></div>
      <div class="active" id="active"></div>
      <div class="grid" id="grid"></div>
    </section>`;
  $('#sort').value = S.sort;
  $('#q').addEventListener('input', debounce((ev) => { S.filters.q = ev.target.value; updateHome(); }, 120));
  $('#sort').onchange = (ev) => { S.sort = ev.target.value; saved.set('sort', S.sort); updateHome(); };
  $('#toggle-filters').onclick = () => {
    S.showFilters = !S.showFilters;
    $('#filters').hidden = !S.showFilters;
    $('#toggle-filters').setAttribute('aria-expanded', S.showFilters);
  };
  updateHome();
}

function updateHome() {
  const f = S.filters;
  const all = [...S.recipes.values()];

  // chapters
  const chs = chapters();
  const countIn = (ch) => all.filter((e) => matches(e, { ...f, chapter: ch, sub: '' })).length;
  $('#chapters').innerHTML = [
    `<button class="chapter" aria-pressed="${!f.chapter}" data-ch="">All <span>${countIn('')}</span></button>`,
    ...chs.map((ch) => `<button class="chapter" aria-pressed="${f.chapter === ch}" data-ch="${esc(ch)}">${esc(chapterLabel(ch))} <span>${countIn(ch)}</span></button>`),
  ].join('');
  $$('#chapters .chapter').forEach((b) => {
    b.onclick = () => { f.chapter = b.dataset.ch; f.sub = ''; updateHome(); };
  });

  const subs = f.chapter ? subFolders(f.chapter) : [];
  $('#subs').innerHTML = subs.length ? [
    `<button class="sub" aria-pressed="${!f.sub}" data-sub="">All ${esc(chapterLabel(f.chapter).toLowerCase())}</button>`,
    ...subs.map((s) => `<button class="sub" aria-pressed="${f.sub === s}" data-sub="${esc(s)}">${esc(chapterLabel(s))}</button>`),
  ].join('') : '';
  $$('#subs .sub').forEach((b) => { b.onclick = () => { f.sub = b.dataset.sub; updateHome(); }; });

  // facets
  $('#filters').innerHTML = FACETS.map(([key, label]) => {
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
    return `<fieldset class="facet facet-${key}"><legend>${label}</legend><div class="facet-opts">${vals.map((v) => `
      <button class="opt" data-key="${key}" data-val="${esc(v)}" aria-pressed="${f[key].has(v)}">${esc(cap(v))} <span>${counts.get(v)}</span></button>`).join('')}</div></fieldset>`;
  }).join('');
  $$('#filters .opt').forEach((b) => {
    b.onclick = () => {
      const set = f[b.dataset.key];
      set.has(b.dataset.val) ? set.delete(b.dataset.val) : set.add(b.dataset.val);
      updateHome();
    };
  });

  // active filter chips
  const active = FACETS.flatMap(([key]) => [...f[key]].map((v) => [key, v]));
  $('#active').innerHTML = active.length ? active.map(([key, v]) => `<button class="pill" data-key="${key}" data-val="${esc(v)}" aria-label="Remove filter ${esc(v)}">${esc(cap(v))}<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8"/></svg></button>`).join('') + '<button class="link-btn" id="clear">Clear filters</button>' : '';
  $$('#active .pill').forEach((b) => { b.onclick = () => { f[b.dataset.key].delete(b.dataset.val); updateHome(); }; });
  if (active.length) $('#clear').onclick = clearFilters;
  const nActive = active.length;
  $('#toggle-filters').textContent = nActive ? `Filters (${nActive})` : 'Filters';

  // grid
  let list = all.filter((e) => matches(e, f));
  const byName = (a, b) => collator.compare(a.title, b.title);
  if (S.sort === 'time') list.sort((a, b) => (a.time ?? 1e9) - (b.time ?? 1e9) || byName(a, b));
  else if (S.sort === 'recent') list.sort((a, b) => (b.modified || 0) - (a.modified || 0) || byName(a, b));
  else list.sort(byName);

  $('#count').textContent = list.length === all.length ? `${all.length} recipes` : `${list.length} of ${all.length} recipes`;
  $('#grid').innerHTML = list.length ? list.map(card).join('') : `
    <div class="empty"><p>No recipes match.</p><button class="btn btn-quiet" id="clear2">Clear search and filters</button></div>`;
  if (!list.length) $('#clear2').onclick = clearFilters;
}

function clearFilters() {
  const f = S.filters;
  f.q = ''; f.chapter = ''; f.sub = '';
  for (const [key] of FACETS) f[key].clear();
  const q = $('#q'); if (q) q.value = '';
  updateHome();
}

function card(e) {
  const facts = [e.time != null ? fmtDuration(e.time) : '', cap(e.difficulty)].filter(Boolean);
  const img = e.thumbUrl
    ? `<img src="${esc(e.thumbUrl)}" alt="" loading="lazy" decoding="async">`
    : `<span class="ph" aria-hidden="true">${esc(e.title.charAt(0))}</span>`;
  return `<a class="card" href="#/r/${encPath(e.path)}">
    <span class="card-img">${img}</span>
    <span class="card-body">
      <span class="card-where">${esc(folderLabel(e.folder))}</span>
      <span class="card-title">${esc(e.title)}</span>
      <span class="card-facts">${facts.map((x) => `<span>${esc(x)}</span>`).join('')}</span>
    </span>
  </a>`;
}

// ---------------------------------------------------------------- recipe view

function baseServings(e) {
  const n = Number(String(e.fm.servings ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

function timerSeconds(q) {
  if (!q || !q.value) return null;
  const v = q.value;
  let n = null;
  if (v.type === 'number') n = Number(v.value?.value);
  else if (v.type === 'range') n = Number(v.value?.start?.value);
  if (!Number.isFinite(n)) return null;
  const u = (q.unit || 'min').toLowerCase();
  if (/^(h|hr|hrs|hour|hours)$/.test(u)) return n * 3600;
  if (/^(s|sec|secs|second|seconds)$/.test(u)) return n;
  if (/^(d|day|days)$/.test(u)) return n * 86400;
  return n * 60;
}

function refPath(ing) {
  const r = ing.reference;
  if (!r) return null;
  const parts = [...(r.components || []), r.name].filter((p) => p && p !== '.');
  return parts.join('/');
}

function ingName(ing) {
  if (ing.alias) return ing.alias;
  const target = refPath(ing);
  if (target) return S.recipes.get(target)?.title || prettifyFile(ing.name);
  return ing.name;
}

/** Renders ingredients, cookware and method for a parsed recipe. */
function recipeBody(parsed, { interactive = true, path = '' } = {}) {
  const { recipe, grouped } = parsed;
  if (!recipe) return '<p class="muted">This recipe could not be read.</p>';
  const checked = S.checked.get(path) || new Set();

  const rows = [];
  const list = grouped.length ? grouped : recipe.ingredients.map((ing, index) => ({ index, quantity: null, single: ing.quantity }));
  for (const g of list) {
    const ing = recipe.ingredients[g.index];
    if (!ing || !shouldList(ing)) continue;
    const qty = g.quantity ? fmtGrouped(g.quantity) : fmtQuantity(g.single);
    const optional = /OPT/.test(ing.modifiers || '');
    const target = refPath(ing);
    const exists = target && S.recipes.has(target);
    const name = exists ? `<a href="#/r/${encPath(target)}">${esc(ingName(ing))}</a>` : esc(ingName(ing));
    const key = String(g.index);
    rows.push(`<li class="ing-row${checked.has(key) ? ' is-checked' : ''}" data-key="${key}">
      ${interactive ? `<input type="checkbox" class="tick" aria-label="Got ${esc(ingName(ing))}" ${checked.has(key) ? 'checked' : ''}>` : ''}
      <span class="ing-qty">${esc(qty)}</span>
      <span class="ing-name">${name}${ing.note ? ` <span class="ing-note">${esc(ing.note)}</span>` : ''}${optional ? ' <span class="ing-note">optional</span>' : ''}</span>
    </li>`);
  }

  const seenTools = new Set();
  const tools = [];
  for (const c of recipe.cookware || []) {
    if (c.relation && c.relation.type === 'reference') continue;
    const n = (c.alias || c.name).toLowerCase();
    if (seenTools.has(n)) continue;
    seenTools.add(n);
    const q = c.quantity ? fmtQuantity(c.quantity) : '';
    tools.push(`<li>${esc(c.alias || c.name)}${q ? ` <span class="ing-note">${esc(q)}</span>` : ''}</li>`);
  }

  const method = (recipe.sections || []).map((sec) => {
    const parts = [];
    let steps = [];
    const flush = () => { if (steps.length) { parts.push(`<ol class="steps">${steps.join('')}</ol>`); steps = []; } };
    for (const c of sec.content || []) {
      if (c.type === 'text') { flush(); parts.push(`<p class="note">${esc(c.value)}</p>`); continue; }
      const html = (c.value.items || []).map((it) => stepItem(it, recipe, interactive)).join('');
      steps.push(`<li class="step" value="${c.value.number}"><span class="step-n" aria-hidden="true">${c.value.number}</span><p>${html}</p></li>`);
    }
    flush();
    return `${sec.name ? `<h3 class="section-name">${esc(sec.name)}</h3>` : ''}${parts.join('')}`;
  }).join('');

  return `
    <aside class="ingredients">
      <h2>Ingredients</h2>
      ${rows.length ? `<ul class="ing-list">${rows.join('')}</ul>` : '<p class="muted">No ingredients listed.</p>'}
      ${tools.length ? `<h2 class="tools-h">Equipment</h2><ul class="tool-list">${tools.join('')}</ul>` : ''}
    </aside>
    <section class="method">
      <h2>Method</h2>
      ${method || '<p class="muted">No steps yet.</p>'}
    </section>`;
}

function stepItem(it, recipe, interactive) {
  switch (it.type) {
    case 'text': return esc(it.value);
    case 'ingredient': {
      const ing = recipe.ingredients[it.index];
      if (!ing) return '';
      const q = fmtQuantity(ing.quantity);
      const target = refPath(ing);
      const inner = `${esc(ingName(ing))}${q ? ` <b>${esc(q)}</b>` : ''}`;
      if (target && S.recipes.has(target)) return `<a class="mark" href="#/r/${encPath(target)}">${inner}</a>`;
      return `<span class="mark">${inner}</span>`;
    }
    case 'cookware': {
      const c = recipe.cookware[it.index];
      return c ? `<span class="tool">${esc(c.alias || c.name)}</span>` : '';
    }
    case 'timer': {
      const t = recipe.timers[it.index];
      if (!t) return '';
      const label = fmtQuantity(t.quantity) || t.name || 'timer';
      const secs = timerSeconds(t.quantity);
      if (!interactive || !secs) return `<span class="timer-chip">${esc(label)}</span>`;
      return `<button class="timer-chip" data-secs="${secs}" data-label="${esc(t.name || label)}" title="Start a ${esc(label)} timer"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="9" r="5.5"/><path d="M8 9V6.5M6.5 1.5h3"/></svg>${esc(label)}</button>`;
    }
    case 'inlineQuantity': {
      const q = recipe.inline_quantities?.[it.index];
      return q ? `<span class="qty">${esc(fmtQuantity(q))}</span>` : '';
    }
    default: return '';
  }
}

function factsList(e, parsed, factor) {
  const fm = e.fm;
  const items = [];
  if (e.time != null) items.push(['Total', fmtDuration(e.time)]);
  if (e.prep != null) items.push(['Prep', fmtDuration(e.prep)]);
  if (e.cook != null && e.cook > 0) items.push(['Cook', fmtDuration(e.cook)]);
  if (fm.yield) items.push(['Makes', fmtYield(fm.yield, factor)]);
  if (e.difficulty) items.push(['Difficulty', cap(e.difficulty)]);
  if (e.cuisine) items.push(['Cuisine', cap(e.cuisine)]);
  if (e.diet) items.push(['Diet', cap(e.diet)]);
  return items.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('');
}

function sourceLine(e) {
  const out = [];
  const src = e.fm.source;
  if (src) {
    if (/^https?:\/\//i.test(src)) {
      let host = src;
      try { host = new URL(src).hostname.replace(/^www\./, ''); } catch { /* keep */ }
      out.push(`Source: <a href="${esc(src)}" target="_blank" rel="noopener">${esc(host)}</a>`);
    } else out.push(`Source: ${esc(src)}`);
  }
  if (e.fm.author) out.push(`By ${esc(e.fm.author)}`);
  return out.length ? `<p class="source">${out.join('<br>')}</p>` : '';
}

async function showRecipe(rawPath, params) {
  const path = rawPath;
  const e = S.recipes.get(path);
  document.body.dataset.view = 'recipe';
  if (!e) {
    $('#main').innerHTML = `<div class="empty"><h1>Recipe not found</h1><p>It may have been moved or renamed.</p><a class="btn btn-quiet" href="#/">All recipes</a></div>`;
    return;
  }
  document.title = `${e.title} | ${S.config.title || 'Recipes'}`;
  if (!document.querySelector('.recipe') || document.querySelector('.recipe')?.dataset.path !== path) {
    $('#main').innerHTML = '<p class="loading">Loading…</p>';
  }
  await initParser();
  if (parseHash().path !== `/r/${path}`) return;

  const base = baseServings(e);
  let servings = Number(params.get('s')) || base;
  let mult = Number(params.get('x')) || 1;

  const crumbs = [e.chapter, ...e.sub.split('/').filter(Boolean)];
  const canEdit = S.live === 'on' && e.driveId;

  $('#main').innerHTML = `
    <article class="recipe" data-path="${esc(path)}">
      <nav class="crumbs" aria-label="Category"><a href="#/">All recipes</a>${crumbs.filter(Boolean).map((c, i) => {
        const ch = crumbs[0];
        return `<span aria-hidden="true">/</span><a href="#/" data-ch="${esc(ch)}" data-sub="${esc(i ? crumbs[1] : '')}">${esc(chapterLabel(c))}</a>`;
      }).join('')}</nav>
      <div class="recipe-top ${e.imageUrl ? 'has-img' : ''}">
        ${e.imageUrl ? `<figure class="hero"><img src="${esc(e.imageUrl)}" alt="${esc(e.title)}"></figure>` : ''}
        <div class="recipe-head">
          <h1>${esc(e.title)}</h1>
          ${e.description ? `<p class="lede">${esc(e.description)}</p>` : ''}
          <dl class="facts" id="facts"></dl>
          ${e.tags.length ? `<p class="tags">${e.tags.map((t) => `<span>${esc(t)}</span>`).join('')}</p>` : ''}
          ${sourceLine(e)}
          <div class="recipe-actions">
            <div class="scaler" id="scaler"></div>
            ${'wakeLock' in navigator ? '<button class="btn btn-quiet btn-sm" id="wake" aria-pressed="false">Keep screen on</button>' : ''}
            ${canEdit ? `<a class="btn btn-quiet btn-sm" href="#/edit/${encPath(path)}">Edit</a>` : ''}
          </div>
        </div>
      </div>
      <div class="recipe-body" id="body"></div>
    </article>`;

  $$('.crumbs a[data-ch]').forEach((a) => {
    a.onclick = (ev) => { ev.preventDefault(); S.filters.chapter = a.dataset.ch; S.filters.sub = a.dataset.sub; go('#/'); };
  });

  const draw = () => {
    const factor = base ? servings / base : mult;
    const parsed = parseRecipe(e.src, factor);
    $('#facts').innerHTML = factsList(e, parsed, factor);
    $('#body').innerHTML = recipeBody(parsed, { path });
    drawScaler();
    wireBody();
    const q = new URLSearchParams();
    if (base && servings !== base) q.set('s', servings);
    if (!base && mult !== 1) q.set('x', mult);
    const h = `#/r/${encPath(path)}${q.toString() ? '?' + q : ''}`;
    if (location.hash !== h) { history.replaceState(null, '', h); S.currentHash = h; }
  };

  const drawScaler = () => {
    const el = $('#scaler');
    if (base) {
      el.innerHTML = `
        <button class="step-btn" data-d="-1" aria-label="Fewer servings" ${servings <= 1 ? 'disabled' : ''}>−</button>
        <output aria-live="polite"><b>${servings}</b> ${servings === 1 ? 'serving' : 'servings'}</output>
        <button class="step-btn" data-d="1" aria-label="More servings">+</button>
        ${servings !== base ? `<button class="link-btn" data-reset>Reset to ${base}</button>` : ''}`;
      el.querySelectorAll('[data-d]').forEach((b) => { b.onclick = () => { servings = Math.max(1, servings + Number(b.dataset.d)); draw(); }; });
    } else {
      el.innerHTML = `<span class="scaler-label">Amount</span>${[0.5, 1, 2, 3].map((m) => `<button class="mult" aria-pressed="${mult === m}" data-m="${m}">${m === 0.5 ? '½' : m}×</button>`).join('')}`;
      el.querySelectorAll('[data-m]').forEach((b) => { b.onclick = () => { mult = Number(b.dataset.m); draw(); }; });
    }
    const r = el.querySelector('[data-reset]');
    if (r) r.onclick = () => { servings = base; draw(); };
  };

  const wireBody = () => {
    const set = S.checked.get(path) || new Set();
    S.checked.set(path, set);
    $$('#body .ing-row').forEach((row) => {
      const box = row.querySelector('.tick');
      if (!box) return;
      box.onchange = () => {
        box.checked ? set.add(row.dataset.key) : set.delete(row.dataset.key);
        row.classList.toggle('is-checked', box.checked);
      };
    });
    $$('#body .step').forEach((li) => {
      li.addEventListener('click', (ev) => {
        if (ev.target.closest('a,button')) return;
        li.classList.toggle('is-done');
      });
    });
    $$('#body .timer-chip[data-secs]').forEach((b) => {
      b.onclick = () => startTimer(Number(b.dataset.secs), b.dataset.label, e.title);
    });
  };

  const wake = $('#wake');
  if (wake) wake.onclick = () => toggleWakeLock(wake);

  draw();
  window.scrollTo({ top: 0 });
}

// ---------------------------------------------------------------- wake lock

let wakeLock = null;
async function toggleWakeLock(btn) {
  if (wakeLock) { stopWakeLock(); return; }
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    btn.setAttribute('aria-pressed', 'true');
    btn.textContent = 'Screen stays on';
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
      btn.setAttribute('aria-pressed', 'false');
      btn.textContent = 'Keep screen on';
    });
  } catch {
    toast('This browser could not keep the screen on.');
  }
}
function stopWakeLock() { if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; } }

// ---------------------------------------------------------------- timers

const timers = [];
let timerTick = null;

function startTimer(secs, label, recipeTitle) {
  timers.push({ id: Math.random().toString(36).slice(2), label, recipeTitle, end: Date.now() + secs * 1000, total: secs, paused: null, done: false });
  try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch { /* ignore */ }
  renderTimers();
  if (!timerTick) timerTick = setInterval(renderTimers, 500);
}

function fmtClock(s) {
  s = Math.max(0, Math.ceil(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.35, 0.7].forEach((t) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.25);
      o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.3);
    });
  } catch { /* no audio */ }
  try { navigator.vibrate?.([300, 150, 300, 150, 300]); } catch { /* ignore */ }
}

function renderTimers() {
  const el = $('#timers');
  const now = Date.now();
  for (const t of timers) {
    if (!t.done && !t.paused && t.end <= now) {
      t.done = true;
      beep();
      try { if (document.hidden && Notification.permission === 'granted') new Notification('Timer done', { body: `${t.label} for ${t.recipeTitle}` }); } catch { /* ignore */ }
    }
  }
  el.innerHTML = timers.map((t) => {
    const left = t.paused != null ? t.paused : (t.end - now) / 1000;
    return `<div class="timer ${t.done ? 'is-done' : ''}" data-id="${t.id}">
      <span class="timer-label">${esc(t.label)}<small>${esc(t.recipeTitle)}</small></span>
      <span class="timer-clock">${t.done ? 'Done' : fmtClock(left)}</span>
      ${t.done ? '' : `<button class="link-btn" data-act="pause">${t.paused != null ? 'Resume' : 'Pause'}</button>`}
      <button class="link-btn" data-act="close">${t.done ? 'Dismiss' : 'Cancel'}</button>
    </div>`;
  }).join('');
  $$('.timer', el).forEach((row) => {
    const t = timers.find((x) => x.id === row.dataset.id);
    row.querySelectorAll('[data-act]').forEach((b) => {
      b.onclick = () => {
        if (b.dataset.act === 'close') timers.splice(timers.indexOf(t), 1);
        else if (t.paused != null) { t.end = Date.now() + t.paused * 1000; t.paused = null; }
        else t.paused = (t.end - Date.now()) / 1000;
        renderTimers();
      };
    });
  });
  if (!timers.length && timerTick) { clearInterval(timerTick); timerTick = null; }
}

// ---------------------------------------------------------------- editor

const TEMPLATE = (author) => `---
title:
description:
author: ${author}
source:
course:
cuisine:
diet:
difficulty: easy
servings: 4
time:
prep time:
cook time:
tags: []
---

`;

const SNIPPETS = {
  ingredient: { label: 'Ingredient', text: '@ingredient{100%g}', select: [1, 11] },
  cookware: { label: 'Equipment', text: '#pan{}', select: [1, 4] },
  timer: { label: 'Timer', text: '~{10%minutes}', select: [2, 4] },
  section: { label: 'Section', text: '\n== Section ==\n', select: [4, 11] },
  note: { label: 'Note', text: '\n> ', select: [3, 3] },
};

function resizeImage(file, max = 1600) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not read this photo.'))), 'image/jpeg', 0.85);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read this photo.')); };
    img.src = url;
  });
}

async function showEditor(rawPath) {
  document.body.dataset.view = 'editor';
  if (!drive.enabled()) { go('#/'); return; }
  if (!(S.live === 'on' && drive.signedIn())) {
    if (S.live === 'loading') { $('#main').innerHTML = '<p class="loading">Syncing with Google Drive…</p>'; return; }
    $('#main').innerHTML = `<div class="empty"><h1>Sign in to edit</h1><p>Editing changes the recipe files in Google Drive, so only the owner of the folder can do it.</p><button class="btn btn-primary" id="signin2">Sign in with Google</button></div>`;
    $('#signin2').onclick = () => signInFlow();
    return;
  }
  const isNew = rawPath == null;
  const e = isNew ? null : S.recipes.get(rawPath);
  if (!isNew && (!e || !e.driveId)) {
    $('#main').innerHTML = `<div class="empty"><h1>Recipe not found</h1><p>It may have been moved, renamed or deleted in Google Drive.</p><a class="btn btn-quiet" href="#/">All recipes</a></div>`;
    return;
  }
  await initParser();

  const folders = S.folders.filter((f) => !SKIP_TOP.test(f));
  const startFolder = isNew ? ([S.filters.chapter, S.filters.sub].filter(Boolean).join('/') || folders[0] || '') : e.folder;
  const author = drive.user()?.name || '';
  const st = {
    src: isNew ? TEMPLATE(author) : e.src,
    loadedMd5: isNew ? null : e.md5,
    folder: startFolder,
    file: isNew ? '' : e.file,
    fileTouched: !isNew,
    photo: null, // Blob
    photoUrl: isNew ? null : e.imageUrl,
    removePhoto: false,
    saving: false,
  };
  S.dirty = false;
  const markDirty = () => { S.dirty = true; $('#save-state').textContent = 'Unsaved changes'; };

  $('#main').innerHTML = `
    <section class="editor">
      <div class="editor-bar">
        <a class="link-btn" href="${isNew ? '#/' : `#/r/${encPath(e.path)}`}">Cancel</a>
        <h1>${isNew ? 'New recipe' : `Edit ${esc(e.title)}`}</h1>
        <span class="save-state" id="save-state" aria-live="polite"></span>
        ${isNew ? '' : '<button class="btn btn-quiet btn-sm btn-danger" id="del">Delete</button>'}
        <button class="btn btn-primary" id="save">Save</button>
      </div>
      <div class="editor-fields">
        <label class="field"><span>Category</span>
          <select id="folder">${folders.map((f) => `<option value="${esc(f)}" ${f === st.folder ? 'selected' : ''}>${esc(folderLabel(f))}</option>`).join('')}</select>
        </label>
        <label class="field field-file"><span>File name</span>
          <span class="file-input"><input id="file" value="${esc(st.file)}" spellcheck="false" autocomplete="off" placeholder="from the title"><span>.cook</span></span>
        </label>
        <div class="field field-photo"><span>Photo</span>
          <div class="photo-row">
            <span class="photo-thumb" id="photo-thumb">${st.photoUrl ? `<img src="${esc(st.photoUrl)}" alt="">` : 'None'}</span>
            <label class="btn btn-quiet btn-sm">Choose photo<input type="file" id="photo" accept="image/*" hidden></label>
          </div>
        </div>
      </div>
      <div class="editor-tabs" role="tablist">
        <button role="tab" aria-selected="true" data-tab="write">Write</button>
        <button role="tab" aria-selected="false" data-tab="preview">Preview</button>
      </div>
      <div class="editor-panes" data-tab="write">
        <div class="pane pane-write">
          <div class="toolbar" aria-label="Insert">${Object.entries(SNIPPETS).map(([k, s]) => `<button class="tool-btn" data-snip="${k}">${s.label}</button>`).join('')}</div>
          <textarea id="src" spellcheck="true" aria-label="Recipe in Cooklang"></textarea>
          <div class="issues" id="issues"></div>
        </div>
        <div class="pane pane-preview" id="preview"></div>
      </div>
    </section>`;

  const ta = $('#src');
  ta.value = st.src;

  const updatePreview = () => {
    const p = parseRecipe(ta.value, 1);
    const fm = readFrontmatter(ta.value);
    const fake = makeEntry({ path: `${st.folder}/${st.file || 'new'}`, src: ta.value });
    $('#preview').innerHTML = `
      <div class="preview-head">
        ${st.photoUrl ? `<img src="${esc(st.photoUrl)}" alt="">` : ''}
        <h2>${esc(fm.title || 'Untitled recipe')}</h2>
        ${fm.description ? `<p class="lede">${esc(fm.description)}</p>` : ''}
        <dl class="facts">${factsList(fake, p, 1)}</dl>
      </div>
      <div class="recipe-body">${recipeBody(p, { interactive: false, path: '' })}</div>`;
    const errs = p.errors || [];
    const warns = (p.warnings || []).filter((w) => !/Time overriden|value for key: 'yield'/.test(w));
    const broken = (p.recipe?.ingredients || []).map(refPath).filter((r) => r && !S.recipes.has(r));
    $('#issues').innerHTML = [
      ...errs.map((m) => `<p class="issue issue-error">${esc(m)}</p>`),
      ...[...new Set(broken)].map((r) => `<p class="issue issue-error">Linked recipe not found: ${esc(r)}</p>`),
      ...warns.map((m) => `<p class="issue">${esc(m)}</p>`),
    ].join('');
    if (!st.fileTouched) {
      st.file = slugify(fm.title || '');
      $('#file').value = st.file;
    }
  };
  const debounced = debounce(updatePreview, 200);
  updatePreview();

  ta.addEventListener('input', () => { markDirty(); debounced(); });
  ta.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); save(); }
    if (ev.key === 'Tab' && !ev.shiftKey) { ev.preventDefault(); insert('  ', 2, 2); }
  });
  document.onkeydown = (ev) => {
    if (document.body.dataset.view !== 'editor') return;
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); save(); }
  };

  function insert(text, selA, selB) {
    const a = ta.selectionStart, b = ta.selectionEnd;
    ta.setRangeText(text, a, b, 'end');
    ta.focus();
    ta.setSelectionRange(a + selA, a + selB);
    markDirty(); debounced();
  }
  $$('.tool-btn').forEach((b) => {
    b.onclick = () => { const s = SNIPPETS[b.dataset.snip]; insert(s.text, s.select[0], s.select[1]); };
  });

  $$('.editor-tabs [data-tab]').forEach((b) => {
    b.onclick = () => {
      $$('.editor-tabs [data-tab]').forEach((x) => x.setAttribute('aria-selected', x === b));
      $('.editor-panes').dataset.tab = b.dataset.tab;
      if (b.dataset.tab === 'preview') updatePreview();
    };
  });

  $('#folder').onchange = (ev) => { st.folder = ev.target.value; markDirty(); };
  $('#file').oninput = (ev) => {
    st.fileTouched = true;
    st.file = ev.target.value.trim().replace(/\.cook$/i, '');
    markDirty();
  };
  $('#photo').onchange = async (ev) => {
    const f = ev.target.files?.[0];
    if (!f) return;
    try {
      st.photo = await resizeImage(f);
      st.photoUrl = URL.createObjectURL(st.photo);
      $('#photo-thumb').innerHTML = `<img src="${st.photoUrl}" alt="">`;
      markDirty(); updatePreview();
    } catch (err) { toast(err.message); }
  };

  if (!isNew) {
    $('#del').onclick = async () => {
      const ok = await ask({
        title: `Delete ${e.title}?`,
        body: 'The recipe file and its photo move to the Google Drive trash. You can restore them from there for 30 days.',
        actions: [{ label: 'Keep recipe', value: false }, { label: 'Move to trash', value: true, danger: true }],
      });
      if (!ok) return;
      try {
        await drive.trash(e.driveId);
        if (e.driveImage) await drive.trash(e.driveImage.id).catch(() => {});
        S.recipes.delete(e.path);
        S.dirty = false;
        toast(`${e.title} moved to the Google Drive trash.`);
        go('#/');
      } catch (err) { toast(err.message); }
    };
  }

  $('#save').onclick = save;

  async function save() {
    if (st.saving) return;
    const src = ta.value;
    const fm = readFrontmatter(src);
    const file = (st.file || slugify(fm.title || '')).replace(/[\\/:*?"<>|]+/g, '_').trim();
    if (!file) { toast('Give the recipe a title or a file name first.'); $('#file').focus(); return; }
    const p = parseRecipe(src, 1);
    if (p.errors?.length) {
      const goOn = await ask({
        title: 'This recipe has errors',
        body: `${p.errors[0]}. Save it anyway? The Cooklang app may not show it correctly.`,
        actions: [{ label: 'Keep editing', value: false }, { label: 'Save anyway', value: true }],
      });
      if (!goOn) return;
    }
    const newPath = `${st.folder}/${file}`;
    if ((isNew || newPath !== e.path) && S.recipes.has(newPath)) {
      toast(`A recipe called ${file}.cook already exists in ${folderLabel(st.folder)}.`);
      return;
    }
    const folderId = S.drive.folders.get(st.folder);
    if (!folderId) { toast('That category no longer exists in Google Drive. Reload and try again.'); return; }

    st.saving = true;
    $('#save').disabled = true;
    $('#save-state').textContent = 'Saving…';
    try {
      let meta;
      if (isNew) {
        meta = await drive.create(`${file}.cook`, folderId, src);
      } else {
        const current = await drive.getMeta(e.driveId);
        if (current.md5Checksum && current.md5Checksum !== st.loadedMd5) {
          const choice = await ask({
            title: 'This recipe changed in Google Drive',
            body: 'Someone (or the Cooklang app) saved a newer version after you opened it. Saving now replaces that version with yours.',
            actions: [{ label: 'Cancel', value: 'cancel' }, { label: 'Replace with mine', value: 'overwrite', danger: true }],
          });
          if (choice !== 'overwrite') throw Object.assign(new Error('Not saved.'), { quiet: true });
        }
        meta = await drive.updateContent(e.driveId, src);
        const oldParent = S.drive.folders.get(e.folder);
        if (newPath !== e.path) {
          meta = await drive.moveRename(e.driveId, { name: `${file}.cook`, fromParent: oldParent, toParent: folderId });
          if (e.driveImage && !st.photo) {
            const ext = e.driveImage.name.slice(e.driveImage.name.lastIndexOf('.'));
            e.driveImage = await drive.moveRename(e.driveImage.id, { name: `${file}${ext}`, fromParent: oldParent, toParent: folderId });
          }
        }
      }

      let driveImage = isNew ? null : e.driveImage;
      if (st.photo) {
        if (driveImage) {
          driveImage = await drive.updateContent(driveImage.id, st.photo, 'image/jpeg');
          const wanted = `${file}.jpg`;
          const oldParent = (driveImage.parents || [])[0];
          if (driveImage.name !== wanted || oldParent !== folderId) {
            driveImage = await drive.moveRename(driveImage.id, { name: wanted, fromParent: oldParent, toParent: folderId });
          }
        } else {
          driveImage = await drive.create(`${file}.jpg`, folderId, st.photo, 'image/jpeg');
        }
      }

      if (!isNew) S.recipes.delete(e.path);
      const entry = makeEntry({
        path: newPath, src, md5: meta.md5Checksum, modified: Math.floor(Date.parse(meta.modifiedTime || new Date().toISOString()) / 1000),
        imageUrl: st.photoUrl || null,
      });
      entry.imageUrl = st.photoUrl || null;
      entry.thumbUrl = st.photoUrl || null;
      entry.image = isNew || st.photo ? undefined : e.image;
      entry.imageMd5 = driveImage?.md5Checksum;
      entry.driveId = meta.id;
      entry.driveImage = driveImage;
      S.recipes.set(newPath, entry);
      if (S.drive) {
        S.drive.files.set(`${newPath}.cook`, meta);
        if (!isNew && newPath !== e.path) S.drive.files.delete(`${e.path}.cook`);
      }
      S.dirty = false;
      toast('Saved to Google Drive. Friends see it after the next hourly update.');
      go(`#/r/${encPath(newPath)}`);
    } catch (err) {
      if (!err.quiet) toast(err.message || 'Saving failed.');
      $('#save-state').textContent = S.dirty ? 'Unsaved changes' : '';
    } finally {
      st.saving = false;
      const b = $('#save'); if (b) b.disabled = false;
    }
  }
}

// ---------------------------------------------------------------- toast + modal

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-on'), 5200);
}

function ask({ title, body, actions }) {
  const dlg = $('#modal');
  dlg.innerHTML = `<form method="dialog">
    <h2>${esc(title)}</h2>
    <p>${esc(body)}</p>
    <div class="modal-actions">${actions.map((a, i) => `<button value="${i}" class="btn ${a.danger ? 'btn-danger-solid' : a.primary ? 'btn-primary' : 'btn-quiet'}">${esc(a.label)}</button>`).join('')}</div>
  </form>`;
  return new Promise((resolve) => {
    dlg.onclose = () => {
      const i = Number(dlg.returnValue);
      resolve(Number.isInteger(i) && actions[i] ? actions[i].value : actions[0].value);
      dlg.returnValue = '';
    };
    dlg.showModal();
  });
}

boot();
