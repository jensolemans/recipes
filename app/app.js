import {
  initParser, parseRecipe, shouldList, readFrontmatter, parseDuration, fmtDuration,
  ingredientNames, fmtQuantity, fmtGrouped, fmtYield, fmtAmount, shoppingIngredients, recipeParts,
} from './cooklang.js';
import * as drive from './drive.js';
import * as shop from './shopping.js';
import { qrSvg } from './qr.js';

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
  sort: saved.get('sort', 'recent'),
  browse: { at: '', tab: 'folders' }, // phone browse sheet: folder being shown, open tab
  dirty: false,
  currentHash: '',
  checked: new Map(), // path -> Set of checked ingredient keys
  shop: null, // shopping list sync, when sign-in is set up
  conf: { aisle: saved.get('conf.aisle', null), pantry: saved.get('conf.pantry', null) }, // { id, md5, text }
  parserReady: false,
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
  initTheme();
  if ('serviceWorker' in navigator) {
    // A new release takes over in the background; this page still runs the
    // old code until it reloads. (The first install is not an update.)
    const hadWorker = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadWorker && !S.dirty) toast('A new version of the site is ready.', { label: 'Reload', run: () => location.reload() });
    });
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
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

  drive.configure(S.config.clientId, S.config.authUrl);
  if (drive.enabled()) {
    S.shop = shop.createSync({ drive, configFolder, onChange: onShopChange });
    window.addEventListener('online', () => { if (drive.wasSignedIn()) S.shop.sync(); });
  }
  if (drive.wasSignedIn()) checkConnector();
  window.addEventListener('online', () => {
    connectorChecked = 0;
    if (!drive.wasSignedIn()) return;
    checkConnector();
    // The editor opened offline: its work can go to Drive now.
    if (document.body.dataset.view === 'editor' && S.live !== 'on') {
      $('#save-state').textContent = S.dirty ? 'Unsaved changes' : '';
      toast("You're back online.", { label: 'Save', run: () => $('#save')?.click() });
    }
  });
  initParser().then(() => { S.parserReady = true; renderAccount(); }).catch(() => {});
  renderAccount();
  renderFoot();
  initSide();
  window.addEventListener('hashchange', onHashChange);
  window.addEventListener('beforeunload', (ev) => { if (S.dirty) { ev.preventDefault(); ev.returnValue = ''; } });
  route();
  if (drive.signedIn()) goLive();
  watchSession();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    watchSession();
    if (drive.wasSignedIn()) checkConnector();
    if ($('#shop-body')) S.shop?.sync();
    if (document.body.dataset.view === 'cook' && saved.get('cookAwake', true)) keepAwake(true); // the lock goes when the tab is hidden
  });
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
  if (S.dirty) {
    const leave = await ask({
      title: 'Leave without saving?',
      body: 'Your changes to this recipe are not saved yet.',
      actions: [{ label: 'Keep editing', value: false }, { label: 'Discard changes', value: true, danger: true }],
    });
    if (!leave) {
      // replaceState fires no hashchange, so the next click on a link counts again.
      history.replaceState(null, '', S.currentHash || '#/');
      return;
    }
    S.dirty = false;
    S.dropDraft?.();
  }
  route();
}

function route() {
  S.currentHash = location.hash || '#/';
  if (parseHash().path !== '/list') S.lastPage = S.currentHash; // where the full list goes back to
  renderAccount();
  stopListPolling();
  renderSide();
  const { path, params } = parseHash();
  document.body.dataset.view = '';
  if (!path.startsWith('/cook/')) keepAwake(false);
  if (path === '/list') return showList();
  if (path.startsWith('/r/')) return showRecipe(path.slice(3), params);
  if (path.startsWith('/cook/')) return showCook(path.slice(6), params);
  if (path.startsWith('/edit/')) return showEditor(path.slice(6));
  if (path === '/new') return showEditor(null);
  return showHome();
}

const go = (hash) => { location.hash = hash; };

// ---------------------------------------------------------------- theme

// Light or dark. Until someone picks one it follows the device (dark when
// the device says nothing); a pick is remembered on this device.
// index.html applies the same choice before first paint.
const THEME_ICONS = {
  light: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/></svg>',
  dark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>',
};

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $$('meta[name="theme-color"]').forEach((m) => { m.content = theme === 'dark' ? '#0E0E0E' : '#FAFAFA'; });
  const next = theme === 'dark' ? 'light' : 'dark';
  const btn = $('#theme');
  btn.innerHTML = THEME_ICONS[next];
  const label = `Switch to ${next} mode`;
  btn.setAttribute('aria-label', label);
  btn.title = label;
}

function initTheme() {
  let theme = saved.get('theme', null);
  if (theme !== 'light' && theme !== 'dark') theme = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  applyTheme(theme);
  $('#theme').onclick = () => {
    theme = theme === 'dark' ? 'light' : 'dark';
    saved.set('theme', theme);
    applyTheme(theme);
  };
}

// ---------------------------------------------------------------- Claude
//
// New and Edit open a Claude chat with the start of the request typed in;
// Claude writes the recipe with the cooklang-recipe skill and saves it to
// Drive through the recipes connector. Without the connector (no authUrl),
// offline, or when it does not answer, they open the editor instead.

const CLAUDE_NEW = 'https://claude.ai/new?q=';
let connector = 'unknown'; // unknown | up | down
let connectorChecked = 0;

async function checkConnector() {
  if (!S.config.authUrl || !navigator.onLine || Date.now() - connectorChecked < 60_000) return;
  connectorChecked = Date.now();
  try {
    // Any answer will do; the Worker does not send CORS headers for its home page.
    await fetch(S.config.authUrl, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(5000) });
    connector = 'up';
  } catch {
    connector = 'down';
  }
}

/** Why New and Edit open the editor instead of Claude, or '' when Claude can take it. */
function noClaude() {
  if (!S.config.authUrl) return 'none';
  if (!navigator.onLine) return "You're offline, so this opens the editor.";
  if (connector === 'down') return "The recipes connector isn't answering, so this opens the editor.";
  return '';
}

/** The folder a new recipe probably goes in: the recipe or folder being looked at. */
function currentFolder() {
  const { path } = parseHash();
  const at = path.startsWith('/r/') ? path.slice(3) : path.startsWith('/cook/') ? path.slice(6) : null;
  if (at != null) return S.recipes.get(at)?.folder || '';
  return [S.filters.chapter, S.filters.sub].filter(Boolean).join('/');
}

function claudeText(path) {
  if (path) return `Change my recipe ${path}.cook: `;
  const folder = currentFolder();
  return folder ? `New recipe for my collection, probably for ${folder}. ` : 'New recipe for my collection. ';
}

/** Attributes for a New (no path) or Edit link. */
function claudeLink(path = null) {
  const editor = path ? `#/edit/${encPath(path)}` : '#/new';
  if (noClaude() === 'none') return `href="${editor}"`;
  return `href="${esc(CLAUDE_NEW + encodeURIComponent(claudeText(path)))}" target="_blank" rel="noopener" data-claude="${esc(path || '')}"`;
}

// One handler for every Claude link: the folder is filled in at the tap,
// and without Claude the editor opens with a line saying why.
document.addEventListener('click', (ev) => {
  const a = ev.target.closest('a[data-claude]');
  if (!a) return;
  const path = a.dataset.claude || null;
  const why = noClaude();
  if (why) {
    ev.preventDefault();
    go(path ? `#/edit/${encPath(path)}` : '#/new');
    toast(why);
    return;
  }
  a.href = CLAUDE_NEW + encodeURIComponent(claudeText(path));
  connectorChecked = 0; // look again when the page comes back
});

// ---------------------------------------------------------------- menus

// The account menu and the recipe's ⋯ menu close on a tap outside them or Escape.
function closeMenus(except) {
  $$('details.menu[open]').forEach((d) => { if (d !== except) d.open = false; });
}
document.addEventListener('click', (ev) => closeMenus(ev.target.closest('details.menu')));
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeMenus(); });

// ---------------------------------------------------------------- account bar

function renderAccount() {
  renderTabbar();
  const el = $('#account');
  if (!drive.enabled()) { el.innerHTML = ''; return; }
  const list = drive.wasSignedIn() ? listLink() : '';
  if (S.live === 'loading') {
    const u = drive.user() || {};
    el.innerHTML = `${list}<span class="avatar is-syncing" role="status" aria-label="Syncing with Google Drive" title="Syncing with Google Drive">${esc((u.name || u.email || '').charAt(0).toUpperCase())}</span>`;
    return;
  }
  if (S.live === 'on' && drive.signedIn()) {
    const u = drive.user() || {};
    el.innerHTML = `${list}
      <a class="btn btn-primary btn-sm btn-new" ${claudeLink()} aria-label="New recipe" title="New recipe"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span>New recipe</span></a>
      <details class="menu">
        <summary class="avatar" aria-label="Account menu">${esc((u.name || u.email || '?').charAt(0).toUpperCase())}</summary>
        <div class="menu-pop">
          <p class="menu-who">${esc(u.email || '')}</p>
          <p class="menu-note">You see live recipes from Google Drive. Friends see changes after the next hourly update.</p>
          ${S.config.publishUrl ? `<a class="menu-item" href="${esc(S.config.publishUrl)}" target="_blank" rel="noopener">Update the friends' site now</a>` : ''}
          <button class="menu-item" data-action="refresh">Reload from Google Drive</button>
          <a class="menu-item" href="#/new">New blank recipe</a>
          <button class="menu-item" data-action="signout">Sign out</button>
        </div>
      </details>`;
    el.querySelector('[data-action="signout"]').onclick = () => {
      drive.signOut();
      S.shop?.reset();
      saved.set('conf.aisle', null);
      saved.set('conf.pantry', null);
      location.reload();
    };
    el.querySelector('[data-action="refresh"]').onclick = async () => {
      el.querySelector('details').open = false;
      try { await drive.renewIfNeeded(); } catch (e) { toast(e.message); renderAccount(); return; }
      goLive();
    };
    return;
  }
  if (S.live === 'on') {
    // Live data is loaded but the hour ran out: renew in place, keep the page.
    el.innerHTML = `${list}<button class="btn btn-quiet btn-sm" id="signin">Renew sign-in</button>`;
  } else {
    el.innerHTML = `${list}<button class="link-btn" id="signin">Sign in</button>`;
  }
  $('#signin').onclick = () => signInFlow();
}

async function signInFlow() {
  try {
    await drive.signIn();
    watchSession();
    S.shop?.sync();
    if (S.live === 'on') { renderAccount(); toast(drive.lasting() ? 'Signed in again.' : 'Signed in again for another hour.'); return; }
    await goLive();
  } catch (e) {
    if (!e.quiet) toast(e.message || 'Sign-in failed.');
    renderAccount();
  }
}

// Google sign-ins in the browser last an hour. When it ends while live, swap
// the account menu for a one-tap "Renew sign-in" and say so once.
let sessionTimer;
function watchSession() {
  clearTimeout(sessionTimer);
  if (!drive.enabled()) return;
  const left = drive.expiresAt() - Date.now();
  if (left > 0) { sessionTimer = setTimeout(watchSession, Math.min(left + 500, 2 ** 31 - 1)); return; }
  if (S.live === 'on' && !$('#account #signin')) {
    renderAccount();
    toast(S.dirty
      ? 'Your Google sign-in ran out. Your changes are kept: Save renews it with one tap.'
      : 'Your Google sign-in ran out. Tap Renew sign-in to keep editing.');
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
    // Let go of the photo this one replaces.
    if (e.imageUrl?.startsWith('blob:')) URL.revokeObjectURL(e.imageUrl);
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
    tasks.push(() => loadConf('aisle', files.get(shop.AISLE_PATH)), () => loadConf('pantry', files.get(shop.PANTRY_PATH)));
    await pool(tasks, 6);
    S.live = 'on';
    S.shop?.useFile(files.get(shop.LIST_PATH));
    S.shop?.sync();
  } catch (e) {
    S.live = 'off';
    toast(e.message || 'Could not load recipes from Google Drive.');
  }
  renderAccount();
  renderFoot();
  if (!S.dirty) route();
}

/** Reads aisle.conf or pantry.conf from Drive, reusing the saved copy when it has not changed. */
async function loadConf(kind, f) {
  const old = S.conf[kind];
  if (!f) { S.conf[kind] = { id: null, md5: null, text: '' }; }
  else if (old && old.md5 === f.md5Checksum) { S.conf[kind] = { ...old, id: f.id }; }
  else S.conf[kind] = { id: f.id, md5: f.md5Checksum, text: await drive.readText(f.id) };
  saved.set(`conf.${kind}`, S.conf[kind]);
}

// ---------------------------------------------------------------- home

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

function showHome() {
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

const wideBrowse = matchMedia('(min-width: 701px)');
wideBrowse.addEventListener('change', () => { if ($('#browse')?.open) updateHome(); });

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
    const key = `tool:${n}`;
    tools.push(`<li class="ing-row tool-row${checked.has(key) ? ' is-checked' : ''}" data-key="${esc(key)}">
      ${interactive ? `<input type="checkbox" class="tick" aria-label="Got ${esc(c.alias || c.name)}" ${checked.has(key) ? 'checked' : ''}>` : ''}
      <span class="ing-name">${esc(c.alias || c.name)}${q ? ` <span class="ing-note">${esc(q)}</span>` : ''}</span>
    </li>`);
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
      const inner = `${q ? `<b>${esc(q)}</b> ` : ''}${esc(ingName(ing))}`;
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
      return `<button class="timer-chip" data-secs="${secs}" data-timer="${it.index}" data-text="${esc(label)}" data-label="${esc(t.name || label)}" title="Start a ${esc(label)} timer"><svg class="tc-clock" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="13.5" r="8"/><path d="M12 13.5V9.5M10 2.5h4"/></svg><svg class="tc-ring" viewBox="0 0 24 24" aria-hidden="true"><circle class="tc-track" cx="12" cy="12" r="9"/><circle class="tc-left" cx="12" cy="12" r="9" pathLength="100" stroke-dasharray="100 100"/></svg><svg class="tc-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg><span class="tc-text">${esc(label)}</span></button>`;
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
  return out.length ? `<p class="source">${out.join(' <span aria-hidden="true">·</span> ')}</p>` : '';
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
  // Links can carry anything: only take a sensible amount from them.
  const fromLink = (v, min, max) => (Number.isFinite(Number(v)) && Number(v) >= min && Number(v) <= max ? Number(v) : null);
  let servings = fromLink(params.get('s'), 1, 100) ?? base;
  let mult = fromLink(params.get('x'), 0.25, 10) ?? 1;

  const crumbs = [e.chapter, ...e.sub.split('/').filter(Boolean)];
  const canEdit = S.live === 'on' && e.driveId;
  // Signed in on this device: also offline, where Edit opens the editor.
  const owner = drive.enabled() && drive.wasSignedIn();

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
          <p class="print-only print-size" id="print-size"></p>
          <div class="recipe-actions">
            <div class="scaler" id="scaler"></div>
            <span class="row-break" aria-hidden="true"></span>
            <a class="btn btn-primary icon-btn" id="cook-btn" href="#/cook/${encPath(path)}" title="Cook mode" aria-label="Cook mode">${CHEF_ICON}</a>
            ${S.shop && S.live === 'on' ? `<button class="btn btn-quiet icon-btn" id="add-list" title="Add to shopping list" aria-label="Add to shopping list">${BASKET_ICON}</button>` : ''}
            ${owner
              ? `<a class="btn btn-quiet icon-btn" id="edit-btn" ${claudeLink(path)} title="Edit" aria-label="Edit">${PEN_ICON}</a>`
              : `<button class="btn btn-quiet icon-btn" id="share-btn" title="Share" aria-label="Share" aria-haspopup="dialog">${SHARE_ICON}</button>`}
            ${owner || canEdit ? `
            <details class="menu recipe-more">
              <summary class="btn btn-quiet icon-btn" title="More" aria-label="More">${MORE_ICON}</summary>
              <div class="menu-pop">
                ${owner ? '<button class="menu-item" id="share-btn" aria-haspopup="dialog">Share</button>' : ''}
                <button class="menu-item" id="print-btn">Print</button>
                ${canEdit ? '<button class="menu-item" id="photo-btn" aria-haspopup="dialog">Change photo</button>' : ''}
                ${owner ? `<a class="menu-item" href="#/edit/${encPath(path)}">Edit file</a>` : ''}
              </div>
            </details>`
              : `<button class="btn btn-quiet icon-btn" id="print-btn" title="Print" aria-label="Print">${PRINT_ICON}</button>`}
          </div>
        </div>
      </div>
      <div class="recipe-body" id="body"></div>
      <p class="print-only print-foot" id="print-foot"></p>
    </article>`;
  $('#print-btn').onclick = () => { closeMenus(); window.print(); };
  const photoBtn = $('#photo-btn');
  if (photoBtn) photoBtn.onclick = () => { closeMenus(); changePhoto(e); };
  // When the row wraps, ⋯ can end up on the left: open the menu rightwards then.
  const more = $('.recipe-more');
  if (more) more.ontoggle = () => { if (more.open) $('.menu-pop', more).classList.toggle('at-left', more.getBoundingClientRect().right < 220); };

  $$('.crumbs a[data-ch]').forEach((a) => {
    a.onclick = (ev) => { ev.preventDefault(); S.filters.chapter = a.dataset.ch; S.filters.sub = a.dataset.sub; go('#/'); };
  });

  let parsed = null;
  const draw = () => {
    const factor = base ? servings / base : mult;
    parsed = parseRecipe(e.src, factor);
    $('#facts').innerHTML = factsList(e, parsed, factor);
    $('#body').innerHTML = recipeBody(parsed, { path });
    drawScaler();
    drawAddList();
    wireBody();
    const q = new URLSearchParams();
    if (base && servings !== base) q.set('s', servings);
    if (!base && mult !== 1) q.set('x', mult);
    const h = `#/r/${encPath(path)}${q.toString() ? '?' + q : ''}`;
    if (location.hash !== h) { history.replaceState(null, '', h); S.currentHash = h; }
    $('#cook-btn').href = `#/cook/${encPath(path)}${q.toString() ? '?' + q : ''}`;
    // Paper has no scaler, so the printout says the size and where it came from.
    $('#print-size').textContent = base ? `Serves ${servings}` : mult !== 1 ? `${mult}× the recipe` : '';
    $('#print-foot').textContent = decodeURI(location.href).replace(/^https?:\/\//, '');
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
    wireTimerChips($('#body'), e.path, e.title);
  };

  // The basket says whether the recipe is on the list: filled with a check
  // at this size (a tap takes it off), a refresh arrow at another size (a
  // tap updates it), plain when it is not on the list.
  const onList = () => S.shop?.list.recipes.find((r) => r.path === path);
  const sameSize = (r) => Math.abs(r.factor - (base ? servings / base : mult)) < 1e-6;
  const drawAddList = () => {
    const btn = $('#add-list');
    if (!btn) return;
    const r = onList();
    const state = !r ? 'add' : sameSize(r) ? 'on' : 'update';
    const size = base ? servingsText(servings) : `${mult}×`;
    const label = state === 'on' ? 'On your shopping list. Tap to remove.'
      : state === 'update' ? `Update to ${size} (now ${r.servings ? servingsText(r.servings) : `${Math.round(r.factor * 100) / 100}×`} on your list)`
      : 'Add to shopping list';
    btn.dataset.state = state;
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-pressed', String(state === 'on'));
    btn.innerHTML = state === 'on' ? BASKET_ON_ICON : state === 'update' ? BASKET_UPDATE_ICON : BASKET_ICON;
  };
  // Another device or the side panel can change the list while this is open.
  S.refreshAddList = drawAddList;

  const addList = $('#add-list');
  if (addList) addList.onclick = async () => {
    const factor = base ? servings / base : mult;
    const existing = onList();
    if (existing && sameSize(existing)) {
      undoable(`Removed ${e.title} from your shopping list.`, { t: 'removeRecipe', id: existing.id });
      return;
    }
    const before = S.shop.list;
    // A recipe in parts (meatballs, gravy) asks which parts to shop for.
    let parts = null;
    const all = recipeParts(e.src);
    if (all.length > 1) {
      parts = await chooseParts(e.title, all, existing?.parts);
      if (parts === undefined) return;
      if (parts.length === all.length) parts = null;
    }
    const id = shop.newId();
    const keys = shop.recipeKeys(e.src, factor, shopCtx(), parts);
    // The new lines light up for a moment in the side panel.
    S.flash = { recipeId: id, keys: new Set(keys), start: Date.now(), until: Date.now() + 2500 };
    S.shop.do({ t: 'addRecipe', id, path, title: e.title, servings: base ? servings : null, factor, parts, keys });
    // The first time on a wide screen the panel opens by itself; after
    // that it stays the way it was left.
    if (sideMode() !== 'off' && saved.get('sidePanel', null) == null) setSide('open');
    const size = [base ? servingsText(servings) : `${mult}×`, parts ? partsText(parts) : ''].filter(Boolean).join(', ');
    toast(existing ? `${e.title} on your shopping list is now ${size}.` : `Added ${e.title} (${size}) to your shopping list.`,
      { label: 'Undo', run: () => S.shop.do({ t: 'restore', list: before }) });
  };

  // The link already carries the scale, so everything shared opens at it.
  $('#share-btn').onclick = () => {
    closeMenus();
    openShare(e, parsed, base ? servingsText(servings) : mult !== 1 ? `${mult}× the recipe` : '');
  };

  draw();
  window.scrollTo({ top: 0 });
}

// ---------------------------------------------------------------- share

const SHARE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 14.5v-11M8 7.5l4-4 4 4"/><path d="M8.5 10.5H7A1.5 1.5 0 0 0 5.5 12v6.5A1.5 1.5 0 0 0 7 20h10a1.5 1.5 0 0 0 1.5-1.5V12a1.5 1.5 0 0 0-1.5-1.5h-1.5"/></svg>';
const LINK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>';
const BULLETS_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 6.5h10M9.5 12h10M9.5 17.5h10"/><path d="M5 6.5h.01M5 12h.01M5 17.5h.01" style="stroke-width:3"/></svg>';
const TEXT_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.5h7l4.5 4.5v11a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5z"/><path d="M13.5 3.5v5h5M9 12.5h6M9 16h6"/></svg>';

// A quantity that is a number ("2", "½ tsp"), not words like "to taste".
const AMOUNT = /^[\d½¼¾⅓⅔⅛⅜⅝⅞]/;

/** The ingredients as plain text bullets, at the scale they were parsed at. */
function ingredientLines({ recipe, grouped }) {
  const list = grouped.length ? grouped : recipe.ingredients.map((ing, index) => ({ index, single: ing.quantity }));
  return list.flatMap((g) => {
    const ing = recipe.ingredients[g.index];
    if (!ing || !shouldList(ing)) return [];
    const qty = g.quantity ? fmtGrouped(g.quantity) : fmtQuantity(g.single);
    // "200 g flour", but "butter (to taste)"
    const counted = AMOUNT.test(qty);
    const note = [counted ? '' : qty, ing.note, /OPT/.test(ing.modifiers || '') ? 'optional' : ''].filter(Boolean).join(', ');
    return [`• ${counted ? `${qty} ` : ''}${ingName(ing)}${note ? ` (${note})` : ''}`];
  });
}

/** The method as numbered plain text steps, with section names and notes. */
function methodLines({ recipe }) {
  const out = [];
  const item = (it) => {
    switch (it.type) {
      case 'text': return it.value;
      case 'ingredient': {
        const ing = recipe.ingredients[it.index];
        const q = ing ? fmtQuantity(ing.quantity) : '';
        return ing ? `${AMOUNT.test(q) ? `${q} ` : ''}${ingName(ing)}` : '';
      }
      case 'cookware': { const c = recipe.cookware[it.index]; return c ? c.alias || c.name : ''; }
      case 'timer': { const t = recipe.timers[it.index]; return t ? fmtQuantity(t.quantity) || t.name || '' : ''; }
      case 'inlineQuantity': return fmtQuantity(recipe.inline_quantities?.[it.index]);
      default: return '';
    }
  };
  for (const sec of recipe.sections || []) {
    if (sec.name) out.push(sec.name);
    for (const c of sec.content || []) {
      out.push(c.type === 'text' ? c.value : `${c.value.number}. ${(c.value.items || []).map(item).join('').trim()}`);
    }
  }
  return out;
}

/** Opens the share options: a bottom sheet on phones, a card with a QR code on bigger screens. */
function openShare(e, parsed, size) {
  const dlg = $('#share');
  const url = location.href;
  const wide = wideBrowse.matches;
  const canShare = !wide && typeof navigator.share === 'function';
  const heading = size ? `${e.title} (${size})` : e.title;
  const ingredientsText = () => [heading, ...ingredientLines(parsed), '', url].join('\n');
  const recipeText = () => [
    e.title, e.description || '', [size, e.time != null ? fmtDuration(e.time) : ''].filter(Boolean).join(' · '),
    'Ingredients', ingredientLines(parsed).join('\n'), 'Method', methodLines(parsed).join('\n\n'), url,
  ].filter(Boolean).join('\n\n');

  const copy = async (text, done) => {
    dlg.close();
    try { await navigator.clipboard.writeText(text); toast(done); } catch { toast('Could not copy. Try again.'); }
  };
  const share = async (data, fallback, done) => {
    dlg.close();
    try { await navigator.share({ title: e.title, ...data }); } catch (err) {
      if (err?.name !== 'AbortError') copy(fallback, done);
    }
  };
  const acts = {
    link: () => (canShare ? share({ url }, url, 'Link copied') : copy(url, 'Link copied')),
    ingredients: () => copy(ingredientsText(), 'Ingredients copied'),
    recipe: () => (canShare ? share({ text: recipeText() }, recipeText(), 'Recipe copied') : copy(recipeText(), 'Recipe copied')),
  };

  const sub = size ? `Opens at ${size}.` : '';
  dlg.classList.toggle('is-wide', wide);
  dlg.innerHTML = wide ? `
    <button class="sheet-x share-x" data-close aria-label="Close">${CLOSE_ICON}</button>
    <h2 class="share-title">${esc(e.title)}</h2>
    <p class="share-sub">Scan with a phone camera to open it there. ${esc(sub)}</p>
    <div class="share-qr">${qrSvg(url, `QR code for ${esc(e.title)}`)}</div>
    <button class="btn btn-primary share-main" data-act="link" autofocus>${LINK_ICON}Copy link</button>
    <div class="share-more">
      <button class="share-quiet" data-act="ingredients">${BULLETS_ICON}Copy ingredients</button>
      <button class="share-quiet" data-act="recipe">${TEXT_ICON}Copy whole recipe</button>
    </div>` : `
    <div class="sheet-grab" aria-hidden="true"></div>
    <div class="share-head">
      ${e.thumbUrl ? `<img src="${esc(e.thumbUrl)}" alt="">` : ''}
      <div><b>${esc(e.title)}</b>${size ? `<small>${esc(size)}</small>` : ''}</div>
      <button class="sheet-x" data-close aria-label="Close">${CLOSE_ICON}</button>
    </div>
    <button class="share-row" data-act="link">${LINK_ICON}${canShare ? 'Share link' : 'Copy link'}</button>
    <button class="share-row" data-act="ingredients">${BULLETS_ICON}Copy ingredients</button>
    <button class="share-row" data-act="recipe">${TEXT_ICON}${canShare ? 'Share whole recipe' : 'Copy whole recipe'}</button>`;
  $$('[data-act]', dlg).forEach((b) => { b.onclick = acts[b.dataset.act]; });
  $('[data-close]', dlg).onclick = () => dlg.close();
  dlg.onclick = (ev) => { if (ev.target === dlg) dlg.close(); };
  dlg.showModal();
}

// ---------------------------------------------------------------- cook mode

// One step at a time in big type, or every step in one column. Step 0 is the
// mise en place: everything to get out first. Chapters are the recipe's
// == Section == headings; a recipe without them has a bar without labels.
const PEN_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 19.5l1-4.2L15.8 5a2 2 0 0 1 2.8 0l.4.4a2 2 0 0 1 0 2.8L8.7 18.5z"/><path d="M13.8 7l3.2 3.2"/></svg>';
const BULB_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 17.5h6M10 20.5h4"/><path d="M12 3.5a6 6 0 0 0-3.6 10.8c.7.5 1.1 1.3 1.1 2.2h5c0-.9.4-1.7 1.1-2.2A6 6 0 0 0 12 3.5z"/></svg>';
const LIST_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4.5" y="4.5" width="15" height="4.5" rx="1.5"/><rect x="4.5" y="11.5" width="15" height="8" rx="1.5"/></svg>';
const CARDS_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7.5" y="4.5" width="9" height="15" rx="2"/><path d="M4 7v10M20 7v10"/></svg>';
const CLOSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const PASTE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 3h6v4H9z"/></svg>';
const CLEAR_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 20H8.5l-4.2-4.3a1 1 0 0 1 0-1.4l10-10a1 1 0 0 1 1.4 0l4.6 4.6a1 1 0 0 1 0 1.4L11 20M18 13l-6.3-6.3"/></svg>';
const LEFT_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>';
const RIGHT_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
const PRINT_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 9V4.5h10V9"/><path d="M7 17H5.5A1.5 1.5 0 0 1 4 15.5v-5A1.5 1.5 0 0 1 5.5 9h13a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5H17"/><rect x="7" y="14" width="10" height="5.5" rx="1"/></svg>';
const CHECK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

/** The method as a flat list of steps, each with its chapter, notes and what it uses. */
function cookSteps(recipe) {
  const steps = [];
  let notes = [];
  for (const sec of recipe.sections || []) {
    for (const c of sec.content || []) {
      if (c.type === 'text') { notes.push(c.value); continue; }
      const items = c.value.items || [];
      const ings = [], tools = [];
      for (const it of items) {
        if (it.type === 'ingredient' && !ings.includes(it.index)) ings.push(it.index);
        if (it.type === 'cookware' && !tools.includes(it.index)) tools.push(it.index);
      }
      steps.push({
        chapter: sec.name || '', notes, after: [],
        html: items.map((it) => stepItem(it, recipe, true)).join(''),
        ings: ings.map((i) => recipe.ingredients[i]).filter((ing) => ing && shouldList(ing)),
        tools: tools.map((i) => recipe.cookware[i]).filter((c) => c && !(c.relation && c.relation.type === 'reference')),
      });
      notes = [];
    }
  }
  if (notes.length && steps.length) steps[steps.length - 1].after = notes;
  return steps;
}

/** Everything to get out, with the same keys as the ticks on the recipe page. */
function cookList(parsed, steps) {
  const { recipe, grouped } = parsed;
  const toolName = (c) => (c.alias || c.name).toLowerCase();
  // Which steps use each thing, matched by name, for the desktop list.
  const usedIn = (test) => steps.map((s, i) => (test(s) ? i + 1 : 0)).filter(Boolean);
  const ings = [];
  const list = grouped.length ? grouped : recipe.ingredients.map((ing, index) => ({ index, quantity: null, single: ing.quantity }));
  for (const g of list) {
    const ing = recipe.ingredients[g.index];
    if (!ing || !shouldList(ing)) continue;
    const name = ingName(ing);
    ings.push({
      key: String(g.index), name, note: ing.note || '', optional: /OPT/.test(ing.modifiers || ''),
      qty: g.quantity ? fmtGrouped(g.quantity) : fmtQuantity(g.single),
      steps: usedIn((s) => s.ings.some((x) => lc(ingName(x)) === lc(name))),
    });
  }
  const tools = [];
  const seen = new Set();
  for (const c of recipe.cookware || []) {
    if (c.relation && c.relation.type === 'reference') continue;
    const n = toolName(c);
    if (seen.has(n)) continue;
    seen.add(n);
    tools.push({ key: `tool:${n}`, name: c.alias || c.name, qty: c.quantity ? fmtQuantity(c.quantity) : '', steps: usedIn((s) => s.tools.some((x) => toolName(x) === n)) });
  }
  return { ings, tools };
}

let wakeLock = null;
const canWake = () => 'wakeLock' in navigator;
async function keepAwake(on) {
  if (!canWake()) return;
  try {
    if (on && !wakeLock && !document.hidden) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      const l = wakeLock;
      wakeLock = null;
      await l.release();
    }
  } catch { wakeLock = null; }
}

let cookKeys = null;
let cookScroll = null;

async function showCook(rawPath, params) {
  const path = rawPath;
  const e = S.recipes.get(path);
  document.body.dataset.view = 'cook';
  if (!e) {
    $('#main').innerHTML = `<div class="empty"><h1>Recipe not found</h1><p>It may have been moved or renamed.</p><a class="btn btn-quiet" href="#/">All recipes</a></div>`;
    return;
  }
  document.title = `${e.title} | ${S.config.title || 'Recipes'}`;
  $('#main').innerHTML = '<p class="loading">Loading…</p>';
  await initParser();
  if (parseHash().path !== `/cook/${path}`) return;

  const base = baseServings(e);
  const fromLink = (v, min, max) => (Number.isFinite(Number(v)) && Number(v) >= min && Number(v) <= max ? Number(v) : null);
  let servings = fromLink(params.get('s'), 1, 100) ?? base;
  let mult = fromLink(params.get('x'), 0.25, 10) ?? 1;
  let at = fromLink(params.get('step'), 0, 999) ?? 0;
  let mode = saved.get('cookMode', 'steps') === 'scroll' ? 'scroll' : 'steps';
  let awake = saved.get('cookAwake', true);
  const checked = S.checked.get(path) || new Set();
  S.checked.set(path, checked);

  let parsed, steps, list;
  const parse = () => {
    parsed = parseRecipe(e.src, base ? servings / base : mult);
    steps = parsed.recipe ? cookSteps(parsed.recipe) : [];
    list = parsed.recipe ? cookList(parsed, steps) : { ings: [], tools: [] };
    at = Math.min(at, steps.length);
  };
  const query = (withStep) => {
    const q = new URLSearchParams();
    if (base && servings !== base) q.set('s', servings);
    if (!base && mult !== 1) q.set('x', mult);
    if (withStep && at) q.set('step', at);
    return q.toString() ? '?' + q : '';
  };
  const backHash = () => `#/r/${encPath(path)}${query(false)}`;

  $('#main').innerHTML = `
    <div class="cook" id="cook">
      <header class="cook-top">
        <div class="cook-top-l">
          ${canWake() ? `<button class="cook-icon" id="cook-awake" type="button">${BULB_ICON}</button>` : ''}
          <button class="cook-icon" id="cook-mode" type="button"></button>
        </div>
        <span class="cook-title">${esc(e.title)}</span>
        <div class="cook-top-r"><a class="cook-icon" id="cook-close" href="${backHash()}" title="Close cook mode (Esc)" aria-label="Close cook mode">${CLOSE_ICON}</a></div>
      </header>
      <div class="cook-main">
        <aside class="cook-side" id="cook-side" aria-label="Ingredients"></aside>
        <div class="cook-stage" id="cook-stage"></div>
      </div>
      <footer class="cook-foot" id="cook-foot"></footer>
    </div>`;
  const root = $('#cook'), stage = $('#cook-stage'), foot = $('#cook-foot'), side = $('#cook-side');

  const ingLine = (qty, name, note = '') => `<li>${qty ? `<b>${esc(qty)}</b> ` : ''}${esc(name)}${note ? ` <span class="ing-note">${esc(note)}</span>` : ''}</li>`;

  const stepHTML = (s) => `
    ${s.chapter ? `<p class="cook-chapter">${esc(s.chapter)}</p>` : ''}
    ${s.notes.map((n) => `<p class="note">${esc(n)}</p>`).join('')}
    <p class="cook-text">${s.html}</p>
    ${s.after.map((n) => `<p class="note">${esc(n)}</p>`).join('')}
    ${s.ings.length || s.tools.length ? `<ul class="cook-sum">
      ${s.ings.map((ing) => ingLine(fmtQuantity(ing.quantity), ingName(ing), ing.note)).join('')}
      ${s.tools.map((c) => `<li class="is-tool">${esc(c.alias || c.name)}</li>`).join('')}
    </ul>` : ''}`;

  const readyText = () => {
    const all = [...list.ings, ...list.tools];
    return `${all.filter((x) => checked.has(x.key)).length} of ${all.length} ready`;
  };
  const tickRow = (x, tool) => `<li class="ing-row${tool ? ' tool-row' : ''}${checked.has(x.key) ? ' is-checked' : ''}" data-key="${esc(x.key)}">
      <input type="checkbox" class="tick" aria-label="Got ${esc(x.name)}" ${checked.has(x.key) ? 'checked' : ''}>
      ${tool ? '' : `<span class="ing-qty">${esc(x.qty)}</span>`}
      <span class="ing-name">${esc(x.name)}${x.note ? ` <span class="ing-note">${esc(x.note)}</span>` : ''}${x.optional ? ' <span class="ing-note">optional</span>' : ''}${tool && x.qty ? ` <span class="ing-note">${esc(x.qty)}</span>` : ''}</span>
    </li>`;
  const miseHTML = () => `
    <div class="cook-mise">
      <h1>Mise en place</h1>
      <div class="mise-meta"><div class="scaler" id="cook-scaler"></div><span id="mise-count">${readyText()}</span></div>
      ${list.ings.length ? `<h2>Ingredients</h2><ul class="ing-list">${list.ings.map((x) => tickRow(x, false)).join('')}</ul>` : ''}
      ${list.tools.length ? `<h2>Tools</h2><ul class="ing-list tool-list">${list.tools.map((x) => tickRow(x, true)).join('')}</ul>` : ''}
    </div>`;

  // Every step in full, like the wheel of an alarm clock: the one in the
  // middle of the screen is the current one and the page snaps to it.
  const flowHTML = () => {
    const out = [`<li class="cf-step cf-mise" data-at="0">${miseHTML()}</li>`];
    let chapter = '';
    steps.forEach((s, i) => {
      const n = i + 1;
      if (s.chapter && s.chapter !== chapter) out.push(`<li class="cf-chapter">${esc(s.chapter)}</li>`);
      chapter = s.chapter;
      out.push(`<li class="cf-step" data-at="${n}"><p class="cook-count">Step ${n} of ${steps.length}</p>${stepHTML({ ...s, chapter: '' })}</li>`);
    });
    return `<ol class="cook-flow">${out.join('')}</ol>`;
  };

  // The progress bar: a short pill for the mise en place, then one per step,
  // grouped and labelled by chapter when the recipe has them.
  const barHTML = () => {
    const groups = [];
    steps.forEach((s, i) => {
      const last = groups[groups.length - 1];
      if (last && last.chapter === s.chapter) last.items.push(i + 1);
      else groups.push({ chapter: s.chapter, items: [i + 1] });
    });
    const labels = steps.some((s) => s.chapter);
    const pill = (n, label) => `<button class="cb-pill${n < at ? ' is-done' : n === at ? ' is-now' : ''}" data-at="${n}" aria-label="${esc(label)}"${n === at ? ' aria-current="step"' : ''}></button>`;
    return `<div class="cook-bar${labels ? ' has-labels' : ''}">
      <div class="cb-group cb-mise">${pill(0, 'Mise en place')}</div>
      ${groups.map((g) => `<div class="cb-group" style="flex:${g.items.length}">
        <div class="cb-pills">${g.items.map((n) => pill(n, `Step ${n}`)).join('')}</div>
        ${labels ? `<span class="cb-label${g.items.includes(at) ? ' is-now' : ''}">${esc(g.chapter)}</span>` : ''}
      </div>`).join('')}
    </div>`;
  };

  const footHTML = () => {
    const last = at >= steps.length;
    return `${barHTML()}
      <div class="cook-nav">
        <button class="cook-arrow${at === 0 ? ' is-hidden' : ''}" id="cook-prev" aria-label="Previous step" ${at === 0 ? 'tabindex="-1"' : ''}>${LEFT_ICON}<span>Back</span></button>
        <span class="cook-where">${at === 0 ? 'Before you start' : `${at} of ${steps.length}`}</span>
        <button class="cook-arrow is-primary" id="cook-next" aria-label="${last ? 'Finish' : 'Next step'}">${last ? `<span>Finish</span>${CHECK_ICON}` : `<span>Next</span>${RIGHT_ICON}`}</button>
      </div>`;
  };

  // Desktop: the whole list beside the step, ticking off what is behind you.
  const sideHTML = () => {
    const row = (x, qty) => {
      const now = x.steps.includes(at);
      const used = !now && x.steps.length && Math.max(...x.steps) < at;
      return `<li class="${now ? 'is-now' : used ? 'is-used' : ''}">${qty && x.qty ? `<b>${esc(x.qty)}</b> ` : ''}${esc(x.name)}</li>`;
    };
    return `${list.ings.length ? `<h2>Ingredients</h2><ul>${list.ings.map((x) => row(x, true)).join('')}</ul>` : ''}
      ${list.tools.length ? `<h2>Tools</h2><ul>${list.tools.map((x) => row(x, false)).join('')}</ul>` : ''}`;
  };

  const drawScaler = () => {
    const el = $('#cook-scaler');
    if (!el) return;
    if (base) {
      el.innerHTML = `
        <button class="step-btn" data-d="-1" aria-label="Fewer servings" ${servings <= 1 ? 'disabled' : ''}>−</button>
        <output aria-live="polite"><b>${servings}</b> ${servings === 1 ? 'serving' : 'servings'}</output>
        <button class="step-btn" data-d="1" aria-label="More servings">+</button>`;
      el.querySelectorAll('[data-d]').forEach((b) => { b.onclick = () => { servings = Math.max(1, servings + Number(b.dataset.d)); parse(); render(); }; });
    } else {
      el.innerHTML = `<span class="scaler-label">Amount</span>${[0.5, 1, 2, 3].map((m) => `<button class="mult" aria-pressed="${mult === m}" data-m="${m}">${m === 0.5 ? '½' : m}×</button>`).join('')}`;
      el.querySelectorAll('[data-m]').forEach((b) => { b.onclick = () => { mult = Number(b.dataset.m); parse(); render(); }; });
    }
  };

  const syncHash = () => {
    const h = `#/cook/${encPath(path)}${query(true)}`;
    if (location.hash !== h) { history.replaceState(null, '', h); S.currentHash = h; }
    $('#cook-close').href = backHash();
  };

  // Scroll mode: put a step in the middle (a tall one with its top in view);
  // the scroll itself makes it the current step.
  const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const scrollToStep = (n, smooth = true) => {
    const li = $(`.cf-step[data-at="${n}"]`, stage);
    if (!li) return;
    const room = innerHeight - $('.cook-top', root).offsetHeight - foot.offsetHeight;
    li.scrollIntoView({ block: li.offsetHeight > room ? 'start' : 'center', behavior: smooth && !calm() ? 'smooth' : 'auto' });
  };

  // The step under the middle of the space between the top bar and the foot,
  // or the nearest one when the middle falls between two.
  const centreStep = () => {
    const top = $('.cook-top', root).offsetHeight;
    const mid = top + (innerHeight - top - foot.offsetHeight) / 2;
    let best = at, dist = Infinity;
    for (const li of $$('.cf-step', stage)) {
      const r = li.getBoundingClientRect();
      const d = r.top <= mid && r.bottom >= mid ? 0 : Math.min(Math.abs(r.top - mid), Math.abs(r.bottom - mid));
      if (d < dist) { dist = d; best = Number(li.dataset.at); }
    }
    return best;
  };

  // Scroll mode: show the new current step without redrawing the steps.
  const mark = () => {
    $$('.cf-step', stage).forEach((li) => {
      const n = Number(li.dataset.at);
      li.classList.toggle('is-now', n === at);
      li.classList.toggle('is-done', n < at);
    });
    side.innerHTML = sideHTML();
    foot.innerHTML = footHTML();
    wireFoot();
    syncHash();
  };

  const go2 = (n, dir = 0) => {
    if (n > steps.length) { go(backHash()); return; }
    if (mode === 'scroll') { scrollToStep(Math.max(0, n)); return; }
    at = Math.max(0, n);
    render(dir, true);
  };

  const render = (dir = 0, moved = false) => {
    root.dataset.mode = mode;
    root.classList.toggle('is-mise', at === 0);
    const awakeBtn = $('#cook-awake');
    if (awakeBtn) {
      awakeBtn.setAttribute('aria-pressed', String(awake));
      awakeBtn.title = awake ? 'Screen stays on' : 'Keep the screen on';
      awakeBtn.setAttribute('aria-label', awakeBtn.title);
    }
    const modeBtn = $('#cook-mode');
    modeBtn.innerHTML = mode === 'steps' ? LIST_ICON : CARDS_ICON;
    modeBtn.title = mode === 'steps' ? 'Show all steps' : 'One step at a time';
    modeBtn.setAttribute('aria-label', modeBtn.title);

    side.innerHTML = sideHTML();
    if (mode === 'steps') {
      stage.innerHTML = `<div class="cook-card${dir > 0 ? ' from-right' : dir < 0 ? ' from-left' : ''}">${at ? stepHTML(steps[at - 1]) : miseHTML()}</div>`;
    } else stage.innerHTML = flowHTML();
    foot.innerHTML = footHTML();
    const html = document.documentElement.style;
    html.setProperty('--cook-top', `${$('.cook-top', root).offsetHeight}px`);
    html.setProperty('--cook-foot', `${foot.offsetHeight}px`);
    drawScaler();
    wire();
    syncHash();
    if (mode === 'scroll') { mark(); scrollToStep(at, false); } else if (moved) window.scrollTo({ top: 0 });
  };

  const wireFoot = () => {
    $$('.cb-pill', foot).forEach((b) => { b.onclick = () => { const n = Number(b.dataset.at); go2(n, Math.sign(n - at)); }; });
    const prev = $('#cook-prev');
    if (prev) prev.onclick = () => go2(at - 1, -1);
    const next = $('#cook-next');
    if (next) next.onclick = () => go2(at + 1, 1);
  };

  const wire = () => {
    $$('.ing-row', stage).forEach((row) => {
      const box = row.querySelector('.tick');
      const set = () => {
        box.checked ? checked.add(row.dataset.key) : checked.delete(row.dataset.key);
        row.classList.toggle('is-checked', box.checked);
        const c = $('#mise-count');
        if (c) c.textContent = readyText();
      };
      box.onchange = set;
      row.onclick = (ev) => { if (ev.target === box) return; box.checked = !box.checked; set(); };
    });
    if (mode === 'steps') wireTimerChips(stage, e.path, `${e.title}, step ${at}`);
    else $$('.cf-step', stage).forEach((li) => wireTimerChips(li, e.path, `${e.title}, step ${li.dataset.at}`));
    wireFoot();
  };

  // Scroll mode: a tap on a faded step brings it to the middle instead of
  // ticking or starting what is in it.
  stage.addEventListener('click', (ev) => {
    const li = mode === 'scroll' && ev.target.closest('.cf-step');
    if (!li || li.classList.contains('is-now')) return;
    ev.preventDefault();
    ev.stopPropagation();
    scrollToStep(Number(li.dataset.at));
  }, true);

  // Scroll mode: whichever step passes the middle becomes the current one.
  if (cookScroll) removeEventListener('scroll', cookScroll);
  let frame = 0;
  cookScroll = () => {
    if (!root.isConnected) { removeEventListener('scroll', cookScroll); cookScroll = null; return; }
    if (mode !== 'scroll' || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const n = centreStep();
      if (n !== at) { at = n; mark(); }
    });
  };
  addEventListener('scroll', cookScroll, { passive: true });

  const awakeBtn = $('#cook-awake');
  if (awakeBtn) awakeBtn.onclick = () => { awake = !awake; saved.set('cookAwake', awake); keepAwake(awake); render(); };
  $('#cook-mode').onclick = () => { mode = mode === 'steps' ? 'scroll' : 'steps'; saved.set('cookMode', mode); render(); };

  // Swipe left and right between steps on a touch screen.
  let touch = null;
  stage.addEventListener('touchstart', (ev) => { const t = ev.touches[0]; touch = { x: t.clientX, y: t.clientY }; }, { passive: true });
  stage.addEventListener('touchend', (ev) => {
    if (!touch || mode !== 'steps') return;
    const t = ev.changedTouches[0];
    const dx = t.clientX - touch.x, dy = t.clientY - touch.y;
    touch = null;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    if (dx < 0 && at < steps.length) go2(at + 1, 1);
    else if (dx > 0 && at > 0) go2(at - 1, -1);
  });

  if (cookKeys) document.removeEventListener('keydown', cookKeys);
  cookKeys = (ev) => {
    if (document.body.dataset.view !== 'cook' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.target.closest('input, textarea, select, [contenteditable]') || $('#modal').open) return;
    const k = ev.key;
    if (k === 'ArrowRight' || k === 'PageDown' || (k === ' ' && !ev.target.closest('button, a'))) { ev.preventDefault(); if (at < steps.length) go2(at + 1, 1); }
    else if (k === 'ArrowLeft' || k === 'PageUp') { ev.preventDefault(); if (at > 0) go2(at - 1, -1); }
    else if (k === 'Escape') go(backHash());
    else if (k.toLowerCase() === 't') {
      const chip = $(mode === 'steps' ? '.timer-chip[data-secs]' : '.cf-step.is-now .timer-chip[data-secs]', stage);
      if (chip) { ev.preventDefault(); chip.click(); }
    }
  };
  document.addEventListener('keydown', cookKeys);

  parse();
  window.scrollTo({ top: 0 });
  render();
  keepAwake(awake);
}

// ---------------------------------------------------------------- shopping list

const BASKET_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 9.5h17l-1.7 9.1a2 2 0 0 1-2 1.6H7.2a2 2 0 0 1-2-1.6z"/><path d="m8.5 9.5 3-6M15.5 9.5l-3-6"/></svg>';
// The basket with a check (on the list) or a refresh arrow (on it at another
// size) in its top corner. The wide `halo` stroke cuts a gap around the mark.
const BASKET_MARK = (mark, filled) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 9.5h17l-1.7 9.1a2 2 0 0 1-2 1.6H7.2a2 2 0 0 1-2-1.6z"${filled ? ' fill="currentColor"' : ''}/><path d="m8.5 9.5 3-6M15.5 9.5l-3-6"/>${mark}</svg>`;
const BASKET_ON_ICON = BASKET_MARK('<path class="halo" d="M14.3 4.8l3.2 3.2 6.3-6.3" style="stroke-width:5"/><path d="M14.3 4.8l3.2 3.2 6.3-6.3" style="stroke-width:2"/>', true);
const ARROW_RING = 'M23.45 5.94A4.2 4.2 0 1 1 22.62 1.69';
const ARROW_HEAD = 'M24.36 3.62L23.88 .55 21.36 2.83z';
const BASKET_UPDATE_ICON = BASKET_MARK(`<path class="halo" d="${ARROW_RING}" style="stroke-width:4.5"/><path class="halo" d="${ARROW_HEAD}" style="stroke-width:3"/><path d="${ARROW_RING}" style="stroke-width:1.5"/><path d="${ARROW_HEAD}" fill="currentColor" style="stroke-width:1"/>`, false);
const MORE_ICON ='<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>';

let aisleCache = { text: null, parsed: null };
let pantryCache = { text: null, parsed: null };
const ingMemo = new Map();

/** What the shopping list needs to know about recipes, aisles and the pantry. */
function shopCtx() {
  const a = S.conf.aisle?.text || '';
  if (aisleCache.text !== a) aisleCache = { text: a, parsed: shop.parseAisle(a) };
  const p = S.conf.pantry?.text || '';
  if (pantryCache.text !== p) pantryCache = { text: p, parsed: shop.parsePantry(p) };
  return {
    aisle: aisleCache.parsed,
    pantry: pantryCache.parsed,
    recipe: (path) => S.recipes.get(path),
    ingredients: (src, factor, parts = null) => {
      const k = `${factor}|${parts ? JSON.stringify(parts) : ''}|${src}`;
      if (!ingMemo.has(k)) {
        if (ingMemo.size > 300) ingMemo.clear();
        ingMemo.set(k, shoppingIngredients(src, factor, parts));
      }
      return ingMemo.get(k);
    },
  };
}

const built = () => shop.buildList(S.shop.list, shopCtx());
const toBuy = (g) => !g.pantry && !g.home;
const amount = (total) => shop.totalText(total, fmtAmount);
const servingsText = (n) => `${n} ${n === 1 ? 'serving' : 'servings'}`;
const partsText = (parts) => `only ${joinAnd(parts.map((p, i) => (i ? p.toLowerCase() : p)))}`;
const joinAnd = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

function listLink() {
  const n = S.shop ? toBuyCount() : 0;
  return `<a class="icon-link" href="#/list" title="Shopping list" aria-label="Shopping list${n ? `, ${n} to buy` : ''}">${BASKET_ICON}${n ? `<span class="badge">${n}</span>` : ''}</a>`;
}

function onShopChange() {
  renderAccount();
  S.refreshAddList?.();
  if ($('#shop-body')) updateList();
  else renderSide();
}

async function configFolder() {
  if (!S.drive) throw Object.assign(new Error('Still loading from Google Drive.'), { code: 'wait' });
  let id = S.drive.folders.get('config');
  if (!id) {
    id = (await drive.createFolder('config', S.config.folderId)).id;
    S.drive.folders.set('config', id);
  }
  return id;
}

let listPoll = null;
function startListPolling() {
  stopListPolling();
  listPoll = setInterval(() => { if (!document.hidden) S.shop.sync(); }, 15000);
}
function stopListPolling() { clearInterval(listPoll); listPoll = null; }

async function showList() {
  document.body.dataset.view = 'list';
  document.title = `Shopping list | ${S.config.title || 'Recipes'}`;
  if (!S.shop || !drive.wasSignedIn()) {
    $('#main').innerHTML = `<div class="empty"><h1>Sign in to use the shopping list</h1><p>The shopping list is saved in Google Drive, so it is the same on your phone and your computer.</p>${S.shop ? '<button class="btn btn-primary" id="signin2">Sign in with Google</button>' : ''}</div>`;
    const b = $('#signin2'); if (b) b.onclick = () => signInFlow();
    return;
  }
  await mountList($('#main'), false);
}

/**
 * Puts the shopping list in `root`: the list page, or the side panel on wide
 * screens. Only one is shown at a time, so the ids stay unique.
 */
async function mountList(root, panel) {
  const view = saved.get('listView', 'aisle');
  const count = '<span class="shop-count" id="shop-count"></span>';
  root.innerHTML = `
    <section class="shop${panel ? ' shop-panel' : ''}">
      ${panel ? `<div class="side-head">
        <h2>Shopping list</h2>${count}
        <a class="icon-btn" href="#/list" title="Open as a page" aria-label="Open the shopping list as a page">${EXPAND_ICON}</a>
        <button class="icon-btn" id="side-close" title="Close (L)" aria-label="Close the shopping list">${PANEL_ICON}</button>
      </div>
      <p class="shop-status" id="shop-status" aria-live="polite"></p>` : `<div class="shop-head">
        <h1>Shopping list</h1>
        <p class="shop-status" id="shop-status" aria-live="polite"></p>
        <button class="icon-btn shop-to-side" id="to-side" title="Show beside the recipes (L)" aria-label="Show the shopping list beside the recipes">${SHRINK_ICON}</button>
      </div>`}
      <form class="shop-add" id="shop-add" autocomplete="off">
        <label class="sr" for="shop-new">Add an item</label>
        <input id="shop-new" list="shop-names" placeholder="${panel ? 'Add an item' : 'Add an item, like 2 kg potatoes'}" enterkeyhint="done">
        <button class="btn btn-primary">Add</button>
        <datalist id="shop-names"></datalist>
      </form>
      <div class="shop-bar">
        <div class="seg" role="group" aria-label="Show the list">
          <button type="button" data-view="aisle" aria-pressed="${view === 'aisle'}">By aisle</button>
          <button type="button" data-view="recipe" aria-pressed="${view === 'recipe'}">By recipe</button>
        </div>
        ${panel ? '' : count}
        <button class="link-btn" id="clear-checked">Clear checked</button>
      </div>
      <div class="shop-body" id="shop-body"><p class="loading">Loading…</p></div>
      <button class="btn btn-quiet btn-danger shop-clear" id="clear-all">Clear shopping list</button>
    </section>`;

  if (panel) $('#side-close', root).onclick = () => setSide('closed');
  else $('#to-side', root).onclick = listToSide;
  $('#shop-add', root).onsubmit = (ev) => {
    ev.preventDefault();
    const input = $('#shop-new', root);
    const it = shop.parseItem(input.value);
    if (!it.name) return;
    S.shop.do({ t: 'addItem', id: shop.newId(), ...it, key: shop.lookup(shopCtx().aisle, it.name).key });
    input.value = '';
  };
  $$('.seg [data-view]', root).forEach((b) => {
    b.onclick = () => {
      saved.set('listView', b.dataset.view);
      $$('.seg [data-view]', root).forEach((x) => x.setAttribute('aria-pressed', x === b));
      updateList();
    };
  });
  $('#clear-checked', root).onclick = clearChecked;
  $('#clear-all', root).onclick = async () => {
    const ok = await ask({
      title: 'Clear the shopping list?',
      body: 'This removes every recipe and item from the list, on all your devices.',
      actions: [{ label: 'Keep it', value: false }, { label: 'Clear list', value: true, danger: true }],
    });
    if (ok) undoable('Shopping list cleared.', { t: 'clearAll' });
  };
  const body = $('#shop-body', root);
  body.addEventListener('change', (ev) => {
    const box = ev.target.closest('.tick');
    if (!box) return;
    S.shop.do({ t: 'check', key: box.closest('.shop-row').dataset.key, on: box.checked });
  });
  body.addEventListener('click', (ev) => {
    const more = ev.target.closest('[data-more]');
    if (more) { itemSheet(more.closest('.shop-row')); return; }
    const rem = ev.target.closest('[data-remove-recipe]');
    if (rem) {
      const r = S.shop.list.recipes.find((x) => x.id === rem.dataset.removeRecipe);
      if (r) undoable(`Removed ${r.title || 'the recipe'} from the list.`, { t: 'removeRecipe', id: r.id });
    }
  });

  await initParser();
  S.parserReady = true;
  if (!body.isConnected) return; // moved on while the parser loaded
  const names = new Set([...shopCtx().aisle.names.values()].map((x) => x.name));
  $('#shop-names', root).innerHTML = [...names].sort(collator.compare).map((n) => `<option value="${esc(n)}">`).join('');
  updateList();
  startListPolling();
  if (S.live !== 'loading') S.shop.sync();
}

// ---------------------------------------------------------------- side panel (wide screens)

// On a wide screen the list has three sizes: a slim rail, a panel beside the
// recipes, or the whole page, with a button at the top of each to step
// between them. Rail or panel is remembered per device; the editor keeps it
// a rail for the space.
const PANEL_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M14.5 4.5v15M9 10l2 2-2 2"/></svg>';
const EXPAND_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4.5h5.5V10M10 19.5H4.5V14M19.5 4.5l-6 6M4.5 19.5l6-6"/></svg>';
const SHRINK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.5 10H14V4.5M4.5 14H10v5.5M14 10l6-6M10 14l-6 6"/></svg>';

/** From the full list page back to the panel beside the page you came from. */
function listToSide() {
  saved.set('sidePanel', 'open');
  go(S.lastPage || '#/');
}
const wide = window.matchMedia('(min-width: 1100px)');

function sideMode() {
  if (!wide.matches || !S.shop || !drive.wasSignedIn()) return 'off';
  const { path } = parseHash();
  if (path === '/list' || path.startsWith('/cook/')) return 'off';
  if (path === '/new' || path.startsWith('/edit/')) return 'rail';
  return saved.get('sidePanel', 'closed') === 'open' ? 'open' : 'rail';
}

function setSide(state) {
  saved.set('sidePanel', state);
  renderSide();
}

function renderSide() {
  const el = $('#side');
  const mode = sideMode();
  document.body.classList.toggle('has-side', mode !== 'off');
  document.body.classList.toggle('side-open', mode === 'open');
  el.hidden = mode === 'off';
  if (mode === 'open') {
    if (!$('.shop-panel', el)) mountList(el, true);
    else if (!listPoll) startListPolling(); // a page change stopped it
    return;
  }
  if ($('.shop-panel', el)) stopListPolling();
  if (mode === 'off') { el.innerHTML = ''; return; }
  const n = toBuyCount();
  el.innerHTML = `<button class="rail" id="rail" title="Shopping list (L)" aria-label="Open the shopping list${n ? `, ${n} to buy` : ''}">
    ${PANEL_ICON}${BASKET_ICON}${n ? `<span class="badge">${n}</span>` : ''}<span class="rail-label">Shopping list</span>
  </button>`;
  $('#rail').onclick = () => setSide('open');
}

// ---------------------------------------------------------------- tab bar (phones and narrow windows)

// Signed in on a narrower screen, Recipes, Shopping list and New sit at the
// bottom, in reach of a thumb. The editor hides it to leave room to write.
const CHEF_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 14.5a4 4 0 1 1 1.6-7.7 4 4 0 0 1 6.8 0A4 4 0 1 1 17 14.5V19a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1z"/><path d="M7 16.5h10"/></svg>';
const PLUS_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';

function toBuyCount() {
  if (!S.parserReady) return 0;
  try { return [...built().groups.values()].filter((g) => toBuy(g) && !g.checked).length; } catch { return 0; }
}

function renderTabbar() {
  const el = $('#tabbar');
  const { path } = parseHash();
  const show = !wide.matches && S.shop && drive.wasSignedIn() && path !== '/new' && !path.startsWith('/edit/') && !path.startsWith('/cook/');
  document.body.classList.toggle('has-tabbar', Boolean(show));
  el.hidden = !show;
  if (!show) { el.innerHTML = ''; return; }
  const n = toBuyCount();
  const tab = (href, icon, label, on, extra = '') => `<a class="tab" ${href.startsWith('#') ? `href="${href}"` : href}${on ? ' aria-current="page"' : ''}>${icon}<span>${label}</span>${extra}</a>`;
  el.innerHTML = [
    tab('#/', CHEF_ICON, 'Recipes', path !== '/list'),
    tab('#/list', BASKET_ICON, 'Shopping list', path === '/list', n ? `<span class="badge" aria-label="${n} to buy">${n}</span>` : ''),
    tab(claudeLink(), PLUS_ICON, 'New', false),
  ].join('');
}

function initSide() {
  wide.addEventListener('change', () => { renderSide(); renderTabbar(); });
  document.addEventListener('keydown', (ev) => {
    if (ev.key.toLowerCase() !== 'l' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.target.closest('input, textarea, select, [contenteditable]') || $('#modal').open) return;
    if (wide.matches && parseHash().path === '/list' && $('#to-side')) { ev.preventDefault(); listToSide(); return; }
    if (sideMode() === 'off') return;
    ev.preventDefault();
    setSide(sideMode() === 'open' ? 'closed' : 'open');
  });
}

const RENEW_SOON = 10 * 60_000;

function shopStatus() {
  const s = S.shop;
  const waiting = s.pendingCount ? ` ${s.pendingCount === 1 ? 'One change waits' : `${s.pendingCount} changes wait`} on this device.` : '';
  // Offer the renewal before the hour runs out, so it does not end halfway
  // through the shop. The list checks again every 15 seconds.
  const left = drive.expiresAt() - Date.now();
  if (s.status !== 'offline' && left < RENEW_SOON) {
    const when = left <= 0 ? 'Your Google sign-in has ended.' : `Your Google sign-in ends in ${Math.max(1, Math.round(left / 60_000))} min.`;
    return `${when}${waiting} <button class="link-btn" id="shop-renew">Renew now</button>`;
  }
  switch (s.status) {
    case 'signin': return `Not synced.${waiting} <button class="link-btn" id="shop-renew">Renew sign-in</button>`;
    case 'offline': return `Offline.${waiting || ' '} Changes sync when you are back online.`;
    case 'error': return `Could not sync with Google Drive.${waiting} <button class="link-btn" id="shop-retry">Try again</button>`;
    case 'syncing': return s.pendingCount ? 'Saving…' : 'Syncing…';
    case 'ok': return s.pendingCount ? 'Saving…' : 'Saved in Google Drive.';
    default: return s.pendingCount ? 'Saving…' : '';
  }
}

function updateList() {
  const body = $('#shop-body');
  if (!body || !S.parserReady) return;
  const st = $('#shop-status');
  st.innerHTML = shopStatus();
  const renew = $('#shop-renew'); if (renew) renew.onclick = () => signInFlow();
  const retry = $('#shop-retry'); if (retry) retry.onclick = () => S.shop.sync();

  const b = built();
  const groups = [...b.groups.values()];
  const buy = groups.filter(toBuy);
  const empty = !b.recipes.length && !b.manual.length;
  $('#shop-count').textContent = buy.length ? `${buy.filter((g) => g.checked).length} of ${buy.length}` : '';
  $('#clear-checked').hidden = !groups.some((g) => g.checked);
  $('#clear-all').hidden = empty;
  if (empty) {
    body.innerHTML = `<div class="shop-empty"><p>Your shopping list is empty.</p><p class="muted">Open a recipe and tap Add to shopping list, or add an item above.</p></div>`;
    return;
  }
  body.innerHTML = saved.get('listView', 'aisle') === 'recipe' ? recipeView(b) : aisleView(b);
}

function shopRow(g, { total = g.total, recipeId = '', item = '', note = '' } = {}) {
  const qty = amount(total);
  const f = S.flash;
  const isNew = f && Date.now() < f.until && f.keys.has(g.key) && (!recipeId || recipeId === f.recipeId) && !item;
  // A redraw (after saving to Drive) picks the flash up where it was, so it plays once.
  const flash = isNew ? ` style="animation-delay:-${Date.now() - f.start}ms"` : '';
  return `<li class="shop-row${g.checked ? ' is-checked' : ''}${toBuy(g) ? '' : ' is-have'}${isNew ? ' is-new' : ''}"${flash} data-key="${esc(g.key)}" data-recipe="${esc(recipeId)}" data-item="${esc(item)}">
    <label class="shop-main">
      <input type="checkbox" class="tick" ${g.checked ? 'checked' : ''}>
      <span class="ing-qty">${esc(qty)}</span>
      <span class="shop-name">${esc(g.name)}${note ? `<small>${esc(note)}</small>` : ''}</span>
    </label>
    <button class="more-btn" data-more aria-label="More for ${esc(g.name)}">${MORE_ICON}</button>
  </li>`;
}

function aisleView(b) {
  const ctx = shopCtx();
  const groups = [...b.groups.values()];
  const byName = (x, y) => collator.compare(x.name, y.name);
  const from = (g) => [...g.sources.map((s) => s.title), ...(g.items.length ? ['added by you'] : [])].join(', ');
  const secs = ctx.aisle.sections.map((name) => ({ name, items: [] }));
  const other = { name: 'Other', items: [] };
  for (const g of groups) if (toBuy(g) && !g.checked) (secs[g.sec] || other).items.push(g);
  // Within an aisle, items follow the order they have in aisle.conf.
  const byAisle = (x, y) => (x.pos === y.pos ? 0 : x.pos < y.pos ? -1 : 1) || byName(x, y);
  const block = (title, items, cls = '', sort = byName) => `<section class="shop-sec ${cls}"><h2>${title}</h2><ul class="shop-list">${items.sort(sort).map((g) => shopRow(g, { note: from(g) })).join('')}</ul></section>`;
  const out = [...secs, other].filter((s) => s.items.length).map((s) => block(esc(cap(s.name)), s.items, '', byAisle));
  const have = groups.filter((g) => !toBuy(g) && !g.checked);
  if (have.length) out.push(`<details class="shop-sec shop-have"><summary>Probably have <span>${have.length}</span></summary><ul class="shop-list">${have.sort(byName).map((g) => shopRow(g, { note: from(g) })).join('')}</ul></details>`);
  const done = groups.filter((g) => g.checked);
  if (done.length) out.push(block(`In the basket <span>${done.length}</span>`, done, 'shop-done'));
  return out.join('');
}

function recipeView(b) {
  const out = b.recipes.map((r) => {
    const q = r.servings ? `?s=${r.servings}` : r.factor && r.factor !== 1 ? `?x=${r.factor}` : '';
    const size = r.servings ? servingsText(r.servings) : r.factor && r.factor !== 1 ? `${r.factor}×` : '';
    const only = r.parts && !r.missing ? `<p class="shop-parts">${esc(cap(partsText(r.parts)))}</p>` : '';
    const title = r.missing ? esc(r.title || prettifyFile(r.path.split('/').pop())) : `<a href="#/r/${encPath(r.path)}${q}">${esc(r.title)}</a>`;
    const rows = r.lines.map((l) => shopRow(l.group, {
      total: l.total, recipeId: r.id,
      note: [toBuy(l.group) ? '' : 'probably have', l.optional ? 'optional' : ''].filter(Boolean).join(', '),
    }));
    return `<section class="shop-recipe">
      <div class="shop-recipe-head"><h2>${title}</h2><span>${esc(size)}</span><button class="link-btn" data-remove-recipe="${esc(r.id)}">Remove</button></div>
      ${only}${r.missing ? '<p class="muted">This recipe is no longer in your collection.</p>'
        : rows.length ? `<ul class="shop-list">${rows.join('')}</ul>` : '<p class="muted">Nothing left to buy.</p>'}
    </section>`;
  });
  if (b.manual.length) {
    out.push(`<section class="shop-recipe"><div class="shop-recipe-head"><h2>Added by you</h2></div>
      <ul class="shop-list">${b.manual.map((it) => shopRow(it.group, { total: it.total, item: it.id })).join('')}</ul></section>`);
  }
  return out.join('');
}

/** Makes a change with an Undo button in the message. */
function undoable(msg, op) {
  const before = S.shop.list;
  S.shop.do(op);
  toast(msg, { label: 'Undo', run: () => S.shop.do({ t: 'restore', list: before }) });
}

function clearChecked() {
  const b = built();
  const keys = new Set([...b.groups.values()].filter((g) => g.checked).map((g) => g.key));
  if (!keys.size) return;
  undoable(`Cleared ${keys.size} checked ${keys.size === 1 ? 'item' : 'items'}.`, {
    t: 'removeKeys',
    keys: [...keys],
    itemIds: b.manual.filter((it) => keys.has(it.key)).map((it) => it.id),
    // Recipes with nothing left to buy drop off the list.
    dropRecipes: b.recipes.filter((r) => !r.missing && r.lines.every((l) => keys.has(l.key) || !toBuy(l.group))).map((r) => r.id),
  });
}

const CHEVRON_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 6l6 6-6 6"/></svg>';
const TRASH_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5M10 11v5M14 11v5"/></svg>';

/**
 * The card behind an item's ... button: where it is used, its aisle, whether
 * you always have it, and remove. A bottom sheet on phones, a card on bigger screens.
 */
function itemSheet(row) {
  const dlg = $('#item');
  const { key, recipe: recipeId, item: itemId } = row.dataset;
  const acts = {
    remove: (g, recipe) => {
      dlg.close();
      if (recipe) undoable(`Removed ${g.name} from ${recipe.title}.`, { t: 'removeLine', recipeId, key: g.key });
      else if (itemId) undoable(`Removed ${g.name}.`, { t: 'removeItem', id: itemId });
      else undoable(`Removed ${g.name} from the list.`, { t: 'removeKeys', keys: [g.key], itemIds: g.items });
    },
    pantry: async (g, recipe, el) => {
      el.setAttribute('aria-checked', String(!g.pantry));
      el.disabled = true;
      await editConf('pantry', (t) => (g.pantry ? shop.removeFromPantry(t, g.key) : shop.addToPantry(t, g.name)));
      if (dlg.open) render();
    },
    aisle: async (g) => {
      const sections = shopCtx().aisle.sections;
      const i = await pick({ title: `Where is ${g.name}?`, body: 'This is saved in aisle.conf, so it is sorted the same way next time.', label: 'Aisle', options: sections.map(cap), value: g.sec });
      if (i != null && i !== g.sec && await editConf('aisle', (t) => shop.moveInAisle(t, sections[i], g.name)) && dlg.open) render();
    },
  };
  const render = () => {
    const b = built();
    const g = b.groups.get(key);
    if (!g) { if (dlg.open) dlg.close(); return null; }
    const sections = shopCtx().aisle.sections;
    const recipe = recipeId ? b.recipes.find((r) => r.id === recipeId) : null;
    const uses = [
      ...g.sources.map((src) => `<li><b>${esc(amount(src.total))}</b><span>${esc(src.title)}</span></li>`),
      ...b.manual.filter((it) => it.key === g.key).map((it) => `<li class="is-you"><b>${esc(amount(it.total))}</b><span>Added by you</span></li>`),
    ];
    const aisle = g.home
      ? '<div class="item-row"><span>Aisle</span><span class="item-val">Made at home</span></div>'
      : g.sec >= 0
        ? `<button class="item-row" data-act="aisle"><span>Aisle</span><span class="item-val">${esc(cap(sections[g.sec]))}${CHEVRON_ICON}</span></button>`
        : `<div class="item-row"><span>Aisle</span><button class="btn btn-sm item-add" data-act="aisle">${PLUS_ICON}Add aisle</button></div>`;
    const pantry = g.home ? '' : `<button class="item-row" role="switch" aria-checked="${g.pantry}" data-act="pantry"><span>I always have this</span><span class="switch" aria-hidden="true"></span></button>`;
    dlg.classList.toggle('is-wide', wideBrowse.matches);
    dlg.setAttribute('aria-label', cap(g.name));
    dlg.innerHTML = `
      <div class="sheet-grab" aria-hidden="true"></div>
      <button class="sheet-x item-x" data-close aria-label="Close">${CLOSE_ICON}</button>
      <h2>${esc(cap(g.name))}</h2>
      ${uses.length ? `<ul class="item-uses">${uses.join('')}</ul>` : ''}
      ${aisle}${pantry}
      <button class="btn item-remove" data-act="remove">${TRASH_ICON}${esc(recipe ? `Remove from ${recipe.title}` : 'Remove from list')}</button>`;
    $('[data-close]', dlg).onclick = () => dlg.close();
    $$('[data-act]', dlg).forEach((el) => { el.onclick = () => acts[el.dataset.act](g, recipe, el); });
    return g;
  };
  dlg.onclick = (ev) => { if (ev.target === dlg) dlg.close(); };
  if (render()) dlg.showModal();
}

/** Changes aisle.conf or pantry.conf in Drive. Call straight from a tap. */
async function editConf(kind, change) {
  const name = `${kind}.conf`;
  try {
    await drive.renewIfNeeded();
    watchSession();
    const c = S.conf[kind] || { id: null, md5: null, text: '' };
    // Start from the newest version, in case the Cooklang app changed it.
    let text = c.text;
    if (c.id) {
      const meta = await drive.getMeta(c.id);
      if (meta.md5Checksum !== c.md5) text = await drive.readText(c.id);
    }
    const next = change(text);
    const meta = c.id ? await drive.updateContent(c.id, next) : await drive.create(name, await configFolder(), next);
    S.conf[kind] = { id: meta.id, md5: meta.md5Checksum, text: next };
    saved.set(`conf.${kind}`, S.conf[kind]);
    if (S.drive) S.drive.files.set(`config/${name}`, meta);
    onShopChange();
    return true;
  } catch (e) {
    toast(e.message || `Could not save ${name}.`);
    renderAccount();
    return false;
  }
}

// ---------------------------------------------------------------- timers

const timers = [];
let timerTick = null;

function startTimer(secs, label, recipeTitle, key = null) {
  timers.push({ id: Math.random().toString(36).slice(2), key, label, recipeTitle, end: Date.now() + secs * 1000, total: secs, paused: null, done: false });
  try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch { /* ignore */ }
  renderTimers();
  if (!timerTick) timerTick = setInterval(renderTimers, 500);
}

function fmtClock(s) {
  s = Math.max(0, Math.ceil(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

let audio = null;
let lastBeep = 0;

function beep() {
  lastBeep = Date.now();
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    const ctx = audio;
    if (ctx.state === 'suspended') ctx.resume();
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

// Phones (Android Chrome) only show notifications through the service worker.
async function notify(title, body) {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) await reg.showNotification(title, { body, icon: 'icons/icon-192.png' });
    else new Notification(title, { body });
  } catch { /* ignore */ }
}

function renderTimers() {
  const el = $('#timers');
  const now = Date.now();
  for (const t of timers) {
    if (!t.done && !t.paused && t.end <= now) {
      t.done = true;
      beep();
      if (document.hidden) notify('Timer done', `${t.label} for ${t.recipeTitle}`);
    }
  }
  // Keeps ringing until every finished timer is dismissed.
  if (timers.some((t) => t.done) && now - lastBeep > 2000) beep();
  el.innerHTML = timers.map((t) => {
    const left = t.paused != null ? t.paused : (t.end - now) / 1000;
    return `<div class="timer ${t.done ? 'is-done' : ''}" data-id="${t.id}">
      <span class="timer-label">${esc(t.label)}<small>${esc(t.recipeTitle)}</small></span>
      <span class="timer-clock">${t.done ? 'Done' : fmtClock(left)}</span>
      ${t.done ? '' : t.paused != null
        ? `<button class="timer-btn" data-act="pause" aria-label="Resume" title="Resume"><svg viewBox="0 0 24 24" aria-hidden="true"><path class="fill" d="M8 5.5v13l10.5-6.5z"/></svg></button>`
        : `<button class="timer-btn" data-act="pause" aria-label="Pause" title="Pause"><svg viewBox="0 0 24 24" aria-hidden="true"><rect class="fill" x="6.5" y="5.5" width="3.8" height="13" rx="1"/><rect class="fill" x="13.7" y="5.5" width="3.8" height="13" rx="1"/></svg></button>`}
      <button class="timer-btn" data-act="close" aria-label="${t.done ? 'Dismiss' : 'Cancel'}" title="${t.done ? 'Dismiss' : 'Cancel'}">${t.done
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>'}</button>
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
  syncTimerChips();
  if (!timers.length && timerTick) { clearInterval(timerTick); timerTick = null; }
}

// A timer in the method starts once; tapping it again pauses or resumes it, and after it
// is done a tap starts it fresh.
function wireTimerChips(root, path, recipeTitle) {
  $$('.timer-chip[data-secs]', root).forEach((b) => {
    b.dataset.key = `${path}#${b.dataset.timer}`;
    b.onclick = () => {
      const t = timers.find((x) => x.key === b.dataset.key);
      if (t && !t.done) {
        if (t.paused != null) { t.end = Date.now() + t.paused * 1000; t.paused = null; }
        else t.paused = (t.end - Date.now()) / 1000;
        renderTimers();
        return;
      }
      if (t) timers.splice(timers.indexOf(t), 1);
      startTimer(Number(b.dataset.secs), b.dataset.label, recipeTitle, b.dataset.key);
    };
  });
  syncTimerChips();
}

function syncTimerChips() {
  const now = Date.now();
  $$('.timer-chip[data-key]').forEach((b) => {
    const t = timers.find((x) => x.key === b.dataset.key);
    const left = t ? (t.done ? 0 : t.paused != null ? t.paused : (t.end - now) / 1000) : 0;
    b.classList.toggle('is-running', !!t);
    b.classList.toggle('is-paused', !!t && t.paused != null);
    b.classList.toggle('is-done', !!t && t.done);
    b.querySelector('.tc-left').setAttribute('stroke-dasharray', `${t ? Math.max(0, Math.min(100, (left / t.total) * 100)).toFixed(1) : 100} 100`);
    b.querySelector('.tc-text').textContent = !t ? b.dataset.text : t.done ? 'Done' : fmtClock(left);
    b.title = !t ? `Start a ${b.dataset.text} timer` : t.done ? 'Start again' : t.paused != null ? 'Resume timer' : 'Pause timer';
  });
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
  ingredient: { label: 'Ingredient', sym: '@', text: '@ingredient{100%g}', select: [1, 11] },
  cookware: { label: 'Equipment', sym: '#', text: '#pan{}', select: [1, 4] },
  timer: { label: 'Timer', sym: '~', text: '~{10%minutes}', select: [2, 4] },
  section: { label: 'Section', sym: '==', text: '\n== Section ==\n', select: [4, 11] },
  note: { label: 'Note', sym: '>', text: '\n> ', select: [3, 3] },
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

/**
 * Takes the recipe out of a pasted Claude reply: the code block that holds
 * it, or everything from the frontmatter on when there is text before it.
 * Returns null when the text is not a reply around a recipe.
 */
function recipeFromReply(text) {
  const blocks = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const block = blocks.find((b) => /^---\s*$/m.test(b) && /^title\s*:/mi.test(b)) || blocks.find((b) => /@[\p{L}]/u.test(b));
  if (block) return `${block.replace(/\s+$/, '')}\n`;
  const at = text.search(/^---\s*$/m);
  if (at > 0 && /^title\s*:/mi.test(text.slice(at))) return text.slice(at);
  return null;
}

// Words in a recipe that point at a folder with another name.
const FOLDER_WORDS = {
  bread: 'baking', vegan: 'vegetarian', pescatarian: 'seafood', fish: 'seafood', prawn: 'seafood',
  shrimp: 'seafood', salmon: 'seafood', chicken: 'poultry', turkey: 'poultry', duck: 'poultry',
  beef: 'meat', pork: 'meat', lamb: 'meat', noodle: 'pasta', risotto: 'rice', cake: 'cake', cookie: 'cookie',
};
const stem = (w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

/**
 * The best folder for a recipe: the category named after its course, then
 * the subfolder that matches its title and tags best (or its diet). Null
 * when the course matches no category.
 */
function suggestFolder(fm, folders) {
  const words = (s) => fold(s).split(/[^a-z0-9]+/).filter(Boolean).map(stem);
  const both = (ws) => ws.flatMap((w) => [w, FOLDER_WORDS[w]].filter(Boolean));
  const tags = Array.isArray(fm.tags) ? fm.tags : String(fm.tags || '').split(',');
  const course = new Set(both(words(fm.course)));
  const strong = new Set(both([...words(fm.title), ...tags.flatMap(words)]));
  const weak = new Set(both([...words(fm.diet), ...words(fm.cuisine)]));
  const label = (f) => words(chapterLabel(f.split('/').pop())).filter((w) => w !== 'and');
  const top = folders.find((f) => !f.includes('/') && label(f).some((w) => course.has(w)));
  if (!top) return null;
  let best = top, bestScore = 0;
  for (const f of folders.filter((x) => x.startsWith(`${top}/`) && x.split('/').length === 2)) {
    const score = label(f).reduce((n, w) => n + (course.has(w) ? 3 : strong.has(w) ? 2 : weak.has(w) ? 1 : 0), 0);
    if (score > bestScore) { best = f; bestScore = score; }
  }
  return best;
}

/** Downloads a photo from its web address. Throws a message that says what to do instead. */
async function photoFromLink(url) {
  let res;
  try {
    res = await fetch(url, { mode: 'cors' });
  } catch {
    throw new Error("That site doesn't let other sites download its photos. Copy the photo and use Paste photo instead.");
  }
  if (!res.ok) throw new Error(`That photo could not be downloaded (${res.status}).`);
  const blob = await res.blob();
  if (!blob.type.startsWith('image/')) throw new Error("That's a page, not a photo. Right-click or long-press the photo and copy the image address.");
  return blob;
}

/** The photo on the clipboard, or null when there is none. Throws when the browser cannot read it. */
async function clipboardPhoto() {
  const items = await navigator.clipboard.read();
  for (const item of items) {
    const type = item.types.find((t) => t.startsWith('image/'));
    if (type) return item.getType(type);
  }
  return null;
}

/** Asks for a dish photo: picked or taken, pasted, or from a link. Resolves with it, or null. */
function choosePhoto(title) {
  const dlg = $('#modal');
  dlg.innerHTML = `<form method="dialog">
    <h2>${esc(title)}</h2>
    <p>Take a photo or pick one, or copy a photo on a recipe site and paste it.</p>
    <div class="photo-choices">
      <label class="btn btn-quiet">Choose photo<input type="file" id="pc-file" accept="image/*" hidden></label>
      <button type="button" class="btn btn-quiet" id="pc-paste">Paste photo</button>
      <button value="link" class="btn btn-quiet">Photo link</button>
    </div>
    <div class="modal-actions"><button value="cancel" class="btn btn-quiet">Cancel</button></div>
  </form>`;
  let photo = null;
  const take = (blob) => { photo = blob; dlg.close('ok'); };
  $('#pc-file', dlg).onchange = (ev) => { const f = ev.target.files?.[0]; if (f) take(f); };
  $('#pc-paste', dlg).onclick = async () => {
    let blob;
    try { blob = await clipboardPhoto(); } catch { blob = undefined; }
    if (blob) { take(blob); return; }
    dlg.close('cancel');
    toast(blob === null
      ? 'There is no photo on the clipboard. Right-click or long-press the photo on the recipe site and copy it first.'
      : 'This browser cannot read photos from the clipboard here. Press Ctrl+V while this window is open instead.');
  };
  // Ctrl+V while the window is open works too.
  dlg.onpaste = (ev) => {
    const img = [...(ev.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
    if (img) { ev.preventDefault(); take(img); }
  };
  return new Promise((resolve) => {
    dlg.onclose = async () => {
      const v = dlg.returnValue;
      dlg.returnValue = '';
      dlg.onpaste = null;
      if (v === 'ok') { resolve(photo); return; }
      if (v !== 'link') { resolve(null); return; }
      const url = await askText({ title: 'Photo link', body: 'Paste the web address of the photo. Right-click or long-press the photo on the recipe site and copy the image address.', label: 'Photo address', placeholder: 'https://' });
      if (!url) { resolve(null); return; }
      try { resolve(await photoFromLink(url)); } catch (err) { toast(err.message); resolve(null); }
    };
    dlg.showModal();
  });
}

/** Change photo in the recipe's ⋯ menu: saves the photo next to the recipe in Drive. */
async function changePhoto(e) {
  const picked = await choosePhoto(e.driveImage ? 'Change photo' : 'Add photo');
  if (!picked) return;
  try {
    const blob = await resizeImage(picked);
    await drive.renewIfNeeded();
    const folderId = S.drive.folders.get(e.folder);
    const old = e.driveImage;
    let img;
    if (old) {
      img = await drive.updateContent(old.id, blob, 'image/jpeg');
      if (img.name !== `${e.file}.jpg`) img = await drive.moveRename(img.id, { name: `${e.file}.jpg` });
      S.drive.files.delete(`${e.folder}/${old.name}`);
    } else {
      img = await drive.create(`${e.file}.jpg`, folderId, blob, 'image/jpeg');
    }
    S.drive.files.set(`${e.path}.jpg`, img);
    if (e.imageUrl?.startsWith('blob:')) URL.revokeObjectURL(e.imageUrl);
    e.imageUrl = URL.createObjectURL(blob);
    e.thumbUrl = e.imageUrl;
    e.image = undefined;
    e.imageMd5 = img.md5Checksum;
    e.driveImage = img;
    toast('Photo saved to Google Drive.');
    if (parseHash().path === `/r/${e.path}`) route();
  } catch (err) {
    toast(err.message || 'The photo could not be saved.');
    renderAccount();
  }
}

async function showEditor(rawPath) {
  document.body.dataset.view = 'editor';
  if (!drive.enabled()) { go('#/'); return; }
  // An ended sign-in does not block editing: Save renews it. Offline, the
  // editor works from the copy on this device and keeps a draft until Save works.
  const offline = S.live !== 'on' && !navigator.onLine && drive.wasSignedIn();
  if (S.live !== 'on' && !offline) {
    if (S.live === 'loading') { $('#main').innerHTML = '<p class="loading">Syncing with Google Drive…</p>'; return; }
    $('#main').innerHTML = `<div class="empty"><h1>Sign in to edit</h1><p>Editing changes the recipe files in Google Drive, so only the owner of the folder can do it.</p><button class="btn btn-primary" id="signin2">Sign in with Google</button></div>`;
    $('#signin2').onclick = () => signInFlow();
    return;
  }
  const isNew = rawPath == null;
  let e = isNew ? null : S.recipes.get(rawPath);
  if (!isNew && (!e || (!e.driveId && !offline))) {
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
    folderTouched: !isNew,
    photo: null, // Blob
    photoUrl: isNew ? null : e.imageUrl,
    saving: false,
  };
  S.dirty = false;
  // Unsaved work is kept on this device (not the photo), so a closed tab or
  // a save that fails offline loses nothing. Leaving without saving drops it.
  const draftKey = `draft.${isNew ? '/new' : e.path}`;
  const keepDraft = debounce(() => {
    if (S.dirty && ta.isConnected) saved.set(draftKey, { src: ta.value, folder: st.folder, file: st.file, md5: st.loadedMd5, at: Date.now() });
  }, 400);
  const dropDraft = () => { saved.set(draftKey, null); };
  S.dropDraft = dropDraft;
  const markDirty = () => { S.dirty = true; $('#save-state').textContent = 'Unsaved changes'; keepDraft(); };

  $('#main').innerHTML = `
    <section class="editor" data-tab="text">
      <div class="editor-bar">
        <h1>${isNew ? 'New recipe' : `Edit ${esc(e.title)}`}</h1>
        <div class="editor-tabs" role="tablist">
          <button role="tab" aria-selected="false" data-tab="details">Details</button>
          <button role="tab" aria-selected="true" data-tab="text">Text</button>
          <button role="tab" aria-selected="false" data-tab="preview">Preview</button>
        </div>
        <a class="sheet-x editor-x" href="${isNew ? '#/' : `#/r/${encPath(e.path)}`}" aria-label="Close" title="Close">${CLOSE_ICON}</a>
      </div>
      <div class="editor-head">
        <span class="photo-thumb" id="photo-thumb">${st.photoUrl ? `<img src="${esc(st.photoUrl)}" alt="">` : 'No photo'}</span>
        <div class="photo-btns">
          <label class="btn btn-quiet btn-sm">Choose<input type="file" id="photo" accept="image/*" hidden></label>
          <button class="btn btn-quiet btn-sm" id="paste-photo" title="Copy a photo on a recipe site first">Paste</button>
          <button class="btn btn-quiet btn-sm" id="photo-link" title="The web address of a photo">Link</button>
        </div>
        <div class="editor-fields">
          <label class="field"><span>Category</span>
            <select id="folder">${folders.map((f) => `<option value="${esc(f)}" ${f === st.folder ? 'selected' : ''}>${esc(folderLabel(f))}</option>`).join('')}</select>
          </label>
          <label class="field field-file"><span>File name</span>
            <span class="file-input"><input id="file" value="${esc(st.file)}" spellcheck="false" autocomplete="off" placeholder="from the title"><span>.cook</span></span>
          </label>
        </div>
      </div>
      <div class="toolbar" id="toolbar" aria-label="Insert">
        <span class="toolbar-label">Insert</span>
        ${Object.entries(SNIPPETS).map(([k, s]) => `<button class="tool-btn" data-snip="${k}"><span class="tool-sym">${esc(s.sym)}</span>${s.label}</button>`).join('')}
        <span class="toolbar-gap"></span>
        <button class="tool-btn" id="paste-recipe" title="Paste a recipe, or Claude\'s whole reply"><span class="tool-sym">${PASTE_ICON}</span>Paste recipe</button>
        <button class="tool-btn" id="clear-src" title="Empty the recipe text, ready to paste"><span class="tool-sym">${CLEAR_ICON}</span>Clear text</button>
      </div>
      <div class="editor-panes">
        <div class="pane pane-write">
          <textarea id="src" spellcheck="true" aria-label="Recipe in Cooklang"></textarea>
          <div class="issues" id="issues"></div>
        </div>
        <div class="pane pane-preview" id="preview"></div>
      </div>
      <div class="editor-save">
        ${isNew || offline ? '' : '<button class="btn btn-quiet btn-sm btn-danger" id="del">Delete recipe</button>'}
        <span class="save-state" id="save-state" aria-live="polite"></span>
        <button class="ins-btn" id="ins-btn" aria-label="Insert" aria-expanded="false" aria-controls="toolbar" title="Insert">@#</button>
        <button class="btn btn-primary" id="save">Save</button>
      </div>
    </section>`;

  const ta = $('#src');
  ta.value = st.src;

  // A draft left from last time comes back. It keeps the version it started
  // from, so saving still asks when the recipe changed in Drive since.
  const draft = saved.get(draftKey, null);
  if (draft && draft.src !== st.src) {
    const original = { ...st };
    ta.value = draft.src;
    st.folder = draft.folder || st.folder;
    st.file = draft.file ?? st.file;
    st.loadedMd5 = isNew ? null : draft.md5 ?? st.loadedMd5;
    st.fileTouched = st.folderTouched = true;
    $('#folder').value = st.folder;
    $('#file').value = st.file;
    S.dirty = true;
    $('#save-state').textContent = 'Unsaved changes';
    toast(`Your unsaved changes from ${new Date(draft.at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} are back.`, {
      label: 'Discard',
      run: () => {
        Object.assign(st, original);
        ta.value = st.src;
        $('#folder').value = st.folder;
        $('#file').value = st.file;
        S.dirty = false;
        $('#save-state').textContent = '';
        dropDraft();
        updatePreview();
      },
    });
  }
  if (offline) $('#save-state').textContent = S.dirty ? 'Offline, unsaved changes' : 'Offline';

  const updatePreview = () => {
    if (!ta.isConnected) return; // left the editor before the debounce fired
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
    // A new recipe goes where its course says, until a category is picked by hand.
    if (!st.folderTouched) {
      const f = suggestFolder(fm, folders);
      if (f && f !== st.folder) { st.folder = f; $('#folder').value = f; }
    }
  };
  const debounced = debounce(updatePreview, 200);
  updatePreview();

  ta.addEventListener('input', () => { markDirty(); debounced(); });
  ta.addEventListener('keydown', (ev) => {
    if (ev.key === 'Tab' && !ev.shiftKey) { ev.preventDefault(); insert('  ', 2, 2); }
  });
  // Ctrl+S anywhere in the editor, the recipe text included.
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
  $$('.tool-btn[data-snip]').forEach((b) => {
    b.onclick = () => { const s = SNIPPETS[b.dataset.snip]; insert(s.text, s.select[0], s.select[1]); setIns(false); };
  });

  // Phones: Details, Text and Preview are tabs.
  const sec = $('.editor');
  $$('.editor-tabs [data-tab]').forEach((b) => {
    b.onclick = () => {
      $$('.editor-tabs [data-tab]').forEach((x) => x.setAttribute('aria-selected', x === b));
      sec.dataset.tab = b.dataset.tab;
      setIns(false);
      if (b.dataset.tab === 'preview') updatePreview();
    };
  });

  // Phones: the toolbar is a menu behind the @# button. Tapping it or a
  // choice keeps the focus (and the keyboard) in the recipe text.
  const insBtn = $('#ins-btn');
  function setIns(open) {
    sec.classList.toggle('ins-open', open);
    insBtn.setAttribute('aria-expanded', open);
  }
  insBtn.onclick = () => setIns(!sec.classList.contains('ins-open'));
  $$('#ins-btn, #toolbar .tool-btn').forEach((b) => { b.onmousedown = (ev) => { if (document.activeElement === ta) ev.preventDefault(); }; });
  sec.addEventListener('click', (ev) => { if (!ev.target.closest('#toolbar, #ins-btn')) setIns(false); });
  sec.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && sec.classList.contains('ins-open')) { setIns(false); ta.focus(); } });

  // While the keyboard is open the Save bar steps aside and only @# stays,
  // just above the keyboard.
  const vv = window.visualViewport;
  if (vv) {
    const onViewport = () => {
      if (!sec.isConnected) { vv.removeEventListener('resize', onViewport); vv.removeEventListener('scroll', onViewport); return; }
      const kb = Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop));
      const typing = kb > 120 && /^(TEXTAREA|INPUT|SELECT)$/.test(document.activeElement?.tagName || '');
      sec.style.setProperty('--kb', `${typing ? kb : 0}px`);
      sec.classList.toggle('kb-open', typing);
    };
    vv.addEventListener('resize', onViewport);
    vv.addEventListener('scroll', onViewport);
  }

  $('#folder').onchange = (ev) => { st.folder = ev.target.value; st.folderTouched = true; markDirty(); };
  $('#file').oninput = (ev) => {
    st.fileTouched = true;
    st.file = ev.target.value.trim().replace(/\.cook$/i, '');
    markDirty();
  };
  async function usePhoto(blob) {
    try {
      st.photo = await resizeImage(blob);
      // A photo picked earlier in this editor is no longer needed.
      if (st.photoUrl?.startsWith('blob:') && st.photoUrl !== e?.imageUrl) URL.revokeObjectURL(st.photoUrl);
      st.photoUrl = URL.createObjectURL(st.photo);
      $('#photo-thumb').innerHTML = `<img src="${st.photoUrl}" alt="">`;
      markDirty(); updatePreview();
      return true;
    } catch (err) { toast(err.message); return false; }
  }
  $('#photo').onchange = (ev) => { const f = ev.target.files?.[0]; if (f) usePhoto(f); };
  $('#paste-photo').onclick = async () => {
    let blob;
    try { blob = await clipboardPhoto(); } catch {
      toast('This browser cannot read photos from the clipboard here. Click in the recipe text and press Ctrl+V instead.');
      return;
    }
    if (blob) { usePhoto(blob); return; }
    toast('There is no photo on the clipboard. Right-click or long-press the photo on the recipe site and copy it first.');
  };
  $('#photo-link').onclick = async () => {
    const url = await askText({ title: 'Photo link', body: 'Paste the web address of the photo. Right-click or long-press the photo on the recipe site and copy the image address.', label: 'Photo address', placeholder: 'https://' });
    if (!url) return;
    try { if (await usePhoto(await photoFromLink(url))) toast('Photo added.'); } catch (err) { toast(err.message); }
  };

  // Pasting Claude's whole reply keeps only the recipe. Text that is empty or
  // still the template is replaced, not added to.
  const isBlank = () => !ta.value.trim() || ta.value.trim() === TEMPLATE(author).trim();
  function takeRecipe(text) {
    const rec = recipeFromReply(text);
    const plain = rec == null && isBlank() && /^\s*---/.test(text) ? text : null;
    if (rec == null && plain == null) return false;
    if (isBlank()) ta.value = rec ?? plain;
    else ta.setRangeText(rec, ta.selectionStart, ta.selectionEnd, 'end');
    markDirty(); updatePreview();
    if (rec != null && rec.trim() !== text.trim()) toast("Took the recipe out of Claude's reply.");
    // The recipe may name its photo; try it if there is none yet.
    const img = readFrontmatter(ta.value).image;
    if (!st.photo && typeof img === 'string' && /^https?:\/\//.test(img)) {
      photoFromLink(img).then(usePhoto).catch(() => toast('Recipe pasted. Add the photo with Paste photo or Photo link.'));
    }
    return true;
  }
  ta.addEventListener('paste', (ev) => {
    const dt = ev.clipboardData;
    const text = dt?.getData('text/plain') || '';
    const img = [...(dt?.files || [])].find((f) => f.type.startsWith('image/'));
    if (img && !text.trim()) { ev.preventDefault(); usePhoto(img); return; }
    if (takeRecipe(text)) ev.preventDefault();
  });
  // A photo pasted anywhere else in the editor becomes the recipe photo.
  document.onpaste = (ev) => {
    if (document.body.dataset.view !== 'editor' || ev.target === ta) return;
    const img = [...(ev.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
    if (img) { ev.preventDefault(); usePhoto(img); }
  };
  // Empties the text for pasting; done as an edit so Ctrl+Z brings it back.
  $('#clear-src').onclick = () => {
    setIns(false);
    ta.focus();
    ta.select();
    if (!document.execCommand('delete')) ta.value = '';
    markDirty(); updatePreview();
  };
  const pasteBtn = $('#paste-recipe');
  if (pasteBtn) pasteBtn.onclick = async () => {
    setIns(false);
    let text;
    try { text = await navigator.clipboard.readText(); } catch {
      toast('This browser cannot read the clipboard here. Tap in the recipe text and paste it there instead.');
      return;
    }
    if (!isBlank() && !(await ask({
      title: 'Replace the recipe text?',
      body: isNew ? 'What you typed so far is replaced by the pasted recipe.' : 'The recipe text is replaced by the pasted recipe. Nothing changes in Drive until you save.',
      actions: [{ label: 'Keep mine', value: false }, { label: 'Replace', value: true, danger: true }],
    }))) return;
    if (!isBlank()) ta.value = '';
    if (!takeRecipe(text)) toast('The clipboard has no recipe. Copy Claude\'s reply, or the recipe starting at ---, and try again.');
  };

  if (!isNew && !offline) {
    $('#del').onclick = async () => {
      const ok = await ask({
        title: `Delete ${e.title}?`,
        body: 'The recipe file and its photo move to the Google Drive trash. You can restore them from there for 30 days.',
        actions: [{ label: 'Keep recipe', value: false }, { label: 'Move to trash', value: true, danger: true }],
      });
      if (!ok) return;
      try {
        await drive.renewIfNeeded();
        await drive.trash(e.driveId);
        if (e.driveImage) await drive.trash(e.driveImage.id).catch(() => {});
        S.recipes.delete(e.path);
        S.dirty = false;
        dropDraft();
        toast(`${e.title} moved to the Google Drive trash.`);
        go('#/');
      } catch (err) { toast(err.message); renderAccount(); }
    };
  }

  $('#save').onclick = save;

  // One save at a time, also while the sign-in window or a question is open.
  async function save() {
    if (st.saving) return;
    st.saving = true;
    try { await saveNow(); } finally {
      st.saving = false;
      const b = $('#save'); if (b) b.disabled = false;
    }
  }

  async function saveNow() {
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
    // Opened offline: get the Drive side first, now that there may be a connection.
    if (S.live !== 'on') {
      if (!navigator.onLine) { toast("You're offline. Your changes stay on this device: save again when you're back online."); return; }
      try { await drive.renewIfNeeded(); } catch (err) { toast(err.message); renderAccount(); return; }
      await goLive();
      if (S.live !== 'on') return;
      if (!isNew) e = S.recipes.get(e.path) || e;
    }
    if (!isNew && !e.driveId) { toast('This recipe is no longer in Google Drive. Copy your text before leaving.'); return; }
    const newPath = `${st.folder}/${file}`;
    if ((isNew || newPath !== e.path) && S.recipes.has(newPath)) {
      toast(`A recipe called ${file}.cook already exists in ${folderLabel(st.folder)}.`);
      return;
    }
    const folderId = S.drive.folders.get(st.folder);
    if (!folderId) { toast('That category no longer exists in Google Drive. Reload and try again.'); return; }

    // Renew first, while we are still inside the tap, so the sign-in cannot
    // run out halfway through saving the recipe and its photo.
    try {
      await drive.renewIfNeeded();
    } catch (err) {
      toast(err.message);
      renderAccount();
      return;
    }
    watchSession();
    renderAccount();

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
      dropDraft();
      toast('Saved to Google Drive. Friends see it after the next hourly update.');
      go(`#/r/${encPath(newPath)}`);
    } catch (err) {
      if (!err.quiet) toast(err.message || 'Saving failed.');
      if (err.code === 401) renderAccount();
      $('#save-state').textContent = S.dirty ? 'Unsaved changes' : '';
    }
  }
}

// ---------------------------------------------------------------- toast + modal

let toastTimer;
/** Shows a short message, optionally with one action button such as Undo. */
function toast(msg, action) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button class="toast-btn">${esc(action.label)}</button>` : ''}`;
  if (action) el.querySelector('.toast-btn').onclick = () => { el.classList.remove('is-on'); action.run(); };
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-on'), action ? 7000 : 5200);
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

/**
 * Asks which parts of a recipe to shop for. Resolves with the chosen part
 * names, or undefined when cancelled. `before` ticks an earlier choice.
 */
function chooseParts(title, parts, before) {
  const dlg = $('#modal');
  const on = (p) => !before || before.includes(p.name);
  dlg.innerHTML = `<form method="dialog" class="parts">
    <h2>Add ${esc(title)}</h2>
    <p>This recipe has parts. Untick the ones you are not making.</p>
    <ul class="parts-list">${parts.map((p, i) => `<li><label>
      <input type="checkbox" class="tick" value="${i}" ${on(p) ? 'checked' : ''}>
      <span><b>${esc(p.name)}</b><small>${esc(p.ingredients.join(', '))}</small></span>
    </label></li>`).join('')}</ul>
    <div class="modal-actions"><button value="cancel" class="btn btn-quiet">Cancel</button><button value="ok" class="btn btn-primary" id="parts-ok">Add to list</button></div>
  </form>`;
  const boxes = $$('.parts-list input', dlg);
  const update = () => { $('#parts-ok', dlg).disabled = !boxes.some((b) => b.checked); };
  boxes.forEach((b) => { b.onchange = update; });
  update();
  return new Promise((resolve) => {
    dlg.onclose = () => {
      resolve(dlg.returnValue === 'ok' ? boxes.filter((b) => b.checked).map((b) => parts[Number(b.value)].name) : undefined);
      dlg.returnValue = '';
    };
    dlg.showModal();
  });
}

/** Asks for one line of text. Resolves with it, or null when cancelled or empty. */
function askText({ title, body, label, placeholder = '' }) {
  const dlg = $('#modal');
  dlg.innerHTML = `<form method="dialog">
    <h2>${esc(title)}</h2>
    <p>${esc(body)}</p>
    <label class="field modal-field"><span>${esc(label)}</span>
      <input id="ask-text" type="url" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false">
    </label>
    <div class="modal-actions"><button value="cancel" class="btn btn-quiet">Cancel</button><button value="ok" class="btn btn-primary">Add</button></div>
  </form>`;
  return new Promise((resolve) => {
    dlg.onclose = () => {
      const v = $('#ask-text', dlg).value.trim();
      resolve(dlg.returnValue === 'ok' && v ? v : null);
      dlg.returnValue = '';
    };
    dlg.showModal();
    $('#ask-text', dlg).focus();
  });
}

/** Asks to choose one option from a list. Resolves with its index, or null. */
function pick({ title, body, label, options, value = -1 }) {
  const dlg = $('#modal');
  dlg.innerHTML = `<form method="dialog">
    <h2>${esc(title)}</h2>
    <p>${esc(body)}</p>
    <label class="field modal-field"><span>${esc(label)}</span>
      <select id="pick">${options.map((o, i) => `<option value="${i}"${i === value ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>
    </label>
    <div class="modal-actions"><button value="cancel" class="btn btn-quiet">Cancel</button><button value="ok" class="btn btn-primary">Save</button></div>
  </form>`;
  return new Promise((resolve) => {
    dlg.onclose = () => {
      resolve(dlg.returnValue === 'ok' ? Number($('#pick', dlg).value) : null);
      dlg.returnValue = '';
    };
    dlg.showModal();
  });
}

boot();
