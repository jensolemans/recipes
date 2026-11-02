import {
  initParser, parseRecipe, shouldList, readFrontmatter, parseDuration, fmtDuration,
  ingredientNames, fmtQuantity, fmtGrouped, fmtYield, fmtAmount, shoppingIngredients, recipeParts,
} from './cooklang.js';
import * as drive from './drive.js';
import * as shop from './shopping.js';
import * as plan from './plan.js';
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
  plan: null, // meal plan sync, the same way
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
  S.builtAisle = data.aisle || '';
  S.folders = (data.folders || []).filter((f) => !SKIP_TOP.test(f));
  for (const r of data.recipes || []) S.recipes.set(r.path, makeEntry(r));

  const title = S.config.title || 'Recipes';
  document.title = title;
  $$('[data-brand]').forEach((el) => { el.textContent = title; });

  drive.configure(S.config.clientId, S.config.authUrl);
  if (drive.enabled()) {
    S.shop = shop.createSync({ drive, configFolder, onChange: onShopChange });
    S.plan = shop.createSync({ drive, configFolder, onChange: onPlanChange, file: 'plan.json', storeKey: 'recipes.plan', clean: plan.cleanPlan, apply: plan.applyPlan });
    window.addEventListener('online', () => { if (drive.wasSignedIn()) { S.shop.sync(); S.plan.sync(); } });
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
  initPlanDrag();
  initTimers();
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
    // A new day may have begun: meals not cooked move on.
    if ($('#plan-root') || $('#today')) S.plan?.sync();
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
  if (!['/list', '/plan'].includes(parseHash().path)) S.lastPage = S.currentHash; // where the full list and plan go back to
  renderAccount();
  stopListPolling();
  renderSide();
  const { path, params } = parseHash();
  document.body.dataset.view = '';
  if (!path.startsWith('/cook/')) keepAwake(false);
  if (path === '/list') return showList();
  if (path === '/plan') return showPlanPage();
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
// New and Edit ask how: Ask Claude opens a Claude chat with the start of the
// request typed in (Claude writes the recipe with the cooklang-recipe skill
// and saves it to Drive through the recipes connector), or the editor.
// Without the connector (no authUrl) they open the editor straight away;
// offline, or when it does not answer, the editor comes first.

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

/** Why Claude can't take New or Edit right now, or '' when it can. */
function noClaude() {
  if (!S.config.authUrl) return 'none';
  if (!navigator.onLine) return "You're offline. It works again once you're back online.";
  if (connector === 'down') return "The recipes connector isn't answering right now.";
  return '';
}

/** The folder a new recipe probably goes in: the recipe or folder being looked at. */
function currentFolder() {
  const { path } = parseHash();
  const at = path.startsWith('/r/') ? path.slice(3) : path.startsWith('/cook/') ? path.slice(6) : null;
  if (at != null) return S.recipes.get(at)?.folder || '';
  return [S.filters.chapter, S.filters.sub].filter(Boolean).join('/');
}

function claudeText(path, after = false) {
  if (path && after) return `I just cooked my recipe ${path}.cook. Improve it with what I noticed: `;
  if (path) return `Change my recipe ${path}.cook: `;
  const folder = currentFolder();
  return folder ? `New recipe for my collection, probably for ${folder}. ` : 'New recipe for my collection. ';
}

/** Attributes for a New (no path) or Edit link; `after` asks what to improve after cooking. */
function claudeLink(path = null, after = false) {
  const editor = path ? `#/edit/${encPath(path)}` : '#/new';
  if (noClaude() === 'none') return `href="${editor}"`;
  return `href="${esc(CLAUDE_NEW + encodeURIComponent(claudeText(path, after)))}" target="_blank" rel="noopener" data-claude="${esc(path || '')}"${after ? ' data-after' : ''}`;
}

// One handler for every New and Edit button: it asks how.
document.addEventListener('click', (ev) => {
  const a = ev.target.closest('a[data-claude]');
  if (!a || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
  ev.preventDefault();
  closeMenus();
  openChoose(a, a.dataset.claude || null, 'after' in a.dataset);
});

const SPARK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2L5 10.5l5.2-1.8z"/><path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/></svg>';
const FILE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M14 3.5V8h4.5M9 12.5h6M9 16h6"/></svg>';
const OFFLINE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4l16 16M8.5 12.8a5 5 0 0 1 2.4-1.2M5 9.4a10 10 0 0 1 3-1.9M19 9.4a10 10 0 0 0-6.4-2.9M15.6 12.9l.1.1M12 17.5h.01"/></svg>';

/**
 * Ask Claude or the editor, for a new recipe (no path) or an edit. `after`:
 * the recipe was just cooked, so it asks what to improve for next time.
 * `finish`: cook mode's Finish, where finishing without changes comes first.
 */
function openChoose(anchor, path, after = false, finish = false) {
  const dlg = $('#choose');
  const pop = wideBrowse.matches;
  const why = noClaude();
  const editor = path ? `#/edit/${encPath(path)}` : '#/new';
  const opt = (main, attrs, icon, title, sub, tag = 'a') =>
    `<${tag} class="choose-opt${main ? ' is-main' : ''}" ${attrs}>${icon}<span><b>${title}</b><small>${sub}</small></span></${tag}>`;
  const claude = why === 'none' ? ''
    : why ? `<div class="choose-opt is-off">${OFFLINE_ICON}<span><b>Ask Claude</b><small>${esc(why)}</small></span></div>`
    : opt(!finish, `href="${esc(CLAUDE_NEW + encodeURIComponent(claudeText(path, after)))}" target="_blank" rel="noopener" data-pick="claude"`, SPARK_ICON, 'Ask Claude',
      after ? 'Tell Claude what you noticed. It improves the recipe and saves it.'
        : path ? 'Say what to change. Claude rewrites and saves it.' : 'Give a link, text or photo. Claude writes and saves it.');
  const file = opt(Boolean(why) && !finish, `href="${editor}" data-pick`, FILE_ICON, path ? 'Edit the file' : 'Start blank',
    path ? 'Change the Cooklang text yourself.' : 'Write it yourself in the editor.');
  const title = after ? 'How did it go?' : path ? `Edit ${S.recipes.get(path)?.title || 'recipe'}` : 'New recipe';
  const sub = after ? 'Anything to change for next time?'
    : path ? 'How do you want to change it?' : 'How do you want to start?';
  dlg.setAttribute('aria-label', title);
  dlg.classList.toggle('is-pop', pop);
  dlg.innerHTML = `<div class="choose-in">
    ${pop && !after ? '' : `${pop ? '' : '<div class="sheet-grab" aria-hidden="true"></div>'}
    <div class="choose-head"><div><b>${esc(title)}</b><small>${sub}</small></div>
      <button class="sheet-x" data-close aria-label="Close">${CLOSE_ICON}</button></div>`}
    ${finish ? opt(true, 'type="button" data-pick="done"', CHECK_ICON, 'Just finish', 'Nothing to change. Back to the recipe.', 'button') : ''}
    ${why ? file + claude : claude + file}
  </div>`;
  $$('[data-pick]', dlg).forEach((a) => {
    a.onclick = () => {
      if (a.dataset.pick === 'claude') connectorChecked = 0; // look again when the page comes back
      dlg.close();
    };
  });
  const x = $('[data-close]', dlg);
  if (x) x.onclick = () => dlg.close();
  dlg.onclick = (ev) => { if (ev.target === dlg) dlg.close(); };
  dlg.style.left = dlg.style.top = '';
  dlg.showModal();
  if (pop) {
    // Under the button, or above it when there is no room below.
    const r = anchor.getBoundingClientRect();
    const w = dlg.offsetWidth, h = dlg.offsetHeight;
    const left = Math.max(16, Math.min(r.right - w, innerWidth - w - 16));
    const top = r.bottom + 8 + h > innerHeight - 8 ? Math.max(8, r.top - 8 - h) : r.bottom + 8;
    dlg.style.left = `${left}px`;
    dlg.style.top = `${top}px`;
  }
}

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
  document.body.classList.toggle('can-plan', canPlan());
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
          <button class="menu-item" data-action="signout">Sign out</button>
        </div>
      </details>`;
    el.querySelector('[data-action="signout"]').onclick = () => {
      drive.signOut();
      S.shop?.reset();
      S.plan?.reset();
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
    S.plan?.sync();
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

// Card size first; the full size only when the recipe opens (fullPhoto).
async function loadDriveImage(e, img) {
  try {
    const url = await drive.readPhotoUrl(img, 640);
    // Let go of the photo this one replaces.
    if (e.imageUrl?.startsWith('blob:') && e.imageUrl !== e.thumbUrl) URL.revokeObjectURL(e.imageUrl);
    if (e.thumbUrl?.startsWith('blob:')) URL.revokeObjectURL(e.thumbUrl);
    e.imageUrl = url; e.thumbUrl = url; e.imageMd5 = img.md5Checksum;
    e.fullPending = img;
  } catch { /* keep whatever we had */ }
  e.photoLoading = false;
  showPhoto(e);
}

/** Loads the full-size photo of a recipe that only has its card photo from Drive yet. */
async function fullPhoto(e) {
  const img = e.fullPending;
  if (!img) return;
  e.fullPending = null;
  try {
    const url = await drive.readPhotoUrl(img, 1600);
    if (e.driveImage !== img) { URL.revokeObjectURL(url); return; } // replaced meanwhile
    e.imageUrl = url;
    const hero = $(`.recipe[data-path="${CSS.escape(e.path)}"] .hero img`);
    if (hero) hero.src = url;
  } catch { e.fullPending = img; }
}

/**
 * The card photo, already on the device, fills the frame until the full-size
 * photo is in, so a recipe opened for the first time does not show an empty
 * frame first.
 */
function heroBackdrop(e) {
  const fig = $(`.recipe[data-path="${CSS.escape(e.path)}"] .hero`);
  if (fig && e.thumbUrl && e.thumbUrl !== e.imageUrl) fig.style.backgroundImage = `url(${JSON.stringify(e.thumbUrl)})`;
}

/** Puts a photo that came in from Drive into the page, wherever it shows. */
function showPhoto(e) {
  const href = `#/r/${encPath(e.path)}`;
  $$('.card').forEach((a) => {
    if (a.getAttribute('href') === href) $('.card-img', a).outerHTML = cardImg(e);
  });
  const fig = $(`.recipe[data-path="${CSS.escape(e.path)}"] .hero`);
  if (!fig) return;
  if (e.imageUrl) {
    fig.classList.remove('skeleton');
    fig.innerHTML = `<img src="${esc(e.imageUrl)}" alt="${esc(e.title)}">`;
    fullPhoto(e);
    heroBackdrop(e);
  } else {
    fig.closest('.recipe-top').classList.remove('has-img');
    fig.remove();
  }
}

async function goLive() {
  const folderId = S.config.folderId;
  if (!folderId) { toast('The site has no Google Drive folder configured.'); return; }
  S.live = 'loading';
  renderAccount();
  const photos = [];
  try {
    const [check, { folders, files }] = await Promise.all([drive.checkFolder(folderId), drive.walk(folderId)]);
    if (!check.canEdit) {
      toast('This Google account cannot edit the recipe folder, so you stay in read-only mode.');
      drive.signOut();
      S.live = 'off';
      renderAccount();
      return;
    }
    S.drive = { folders, files };
    S.folders = [...folders.keys()].filter((p) => p && !SKIP_TOP.test(p)).sort(collator.compare);

    const seen = new Set();
    const tasks = [];
    // A changed photo comes after the recipes show, with an empty frame
    // where there was none before.
    const photo = (e, img) => { e.photoLoading = !e.thumbUrl; photos.push(() => loadDriveImage(e, img)); };
    for (const [p, f] of files) {
      if (!p.endsWith('.cook') || SKIP_TOP.test(p)) continue;
      const path = p.slice(0, -5);
      seen.add(path);
      const old = S.recipes.get(path);
      const img = findDriveImage(files, path);
      if (old && old.md5 === f.md5Checksum) {
        old.driveId = f.id;
        old.driveImage = img;
        if (img && img.md5Checksum !== old.imageMd5) photo(old, img);
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
        if (keepImg) { e.imageUrl = old.imageUrl; e.thumbUrl = old.thumbUrl; e.fullPending = old.fullPending; }
        e.driveId = f.id;
        e.driveImage = img;
        S.recipes.set(path, e);
        if (img && !keepImg) photo(e, img);
      });
    }
    for (const path of [...S.recipes.keys()]) if (!seen.has(path)) S.recipes.delete(path);
    tasks.push(() => loadConf('aisle', files.get(shop.AISLE_PATH)), () => loadConf('pantry', files.get(shop.PANTRY_PATH)));
    await pool(tasks, 6);
    S.live = 'on';
    S.shop?.useFile(files.get(shop.LIST_PATH));
    S.shop?.sync();
    S.plan?.useFile(files.get(plan.PLAN_PATH));
    S.plan?.sync();
  } catch (e) {
    S.live = 'off';
    toast(e.message || 'Could not load recipes from Google Drive.');
  }
  renderAccount();
  renderFoot();
  if (!S.dirty) route();
  if (photos.length) pool(photos, 6);
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
  drawToday();
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

function cardImg(e) {
  if (e.photoLoading) return '<span class="card-img skeleton" aria-hidden="true"></span>';
  const img = e.thumbUrl
    ? `<img src="${esc(e.thumbUrl)}" alt="" loading="lazy" decoding="async">`
    : `<span class="ph" aria-hidden="true">${esc(e.title.charAt(0))}</span>`;
  return `<span class="card-img">${img}</span>`;
}

function card(e) {
  const facts = [e.time != null ? fmtDuration(e.time) : '', cap(e.difficulty)].filter(Boolean);
  return `<a class="card" href="#/r/${encPath(e.path)}">
    ${cardImg(e)}
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

/** The ingredient lines of a parsed recipe, with the keys the ticks use. */
function ingItems(parsed) {
  const { recipe, grouped } = parsed;
  const out = [];
  const list = grouped.length ? grouped : recipe.ingredients.map((ing, index) => ({ index, quantity: null, single: ing.quantity }));
  for (const g of list) {
    const ing = recipe.ingredients[g.index];
    if (!ing || !shouldList(ing)) continue;
    const target = refPath(ing);
    out.push({
      key: String(g.index), name: ingName(ing), ref: target, href: target && S.recipes.has(target) ? target : null,
      note: ing.note || '', optional: /OPT/.test(ing.modifiers || ''),
      qty: g.quantity ? fmtGrouped(g.quantity) : fmtQuantity(g.single),
    });
  }
  return out;
}

// Ingredients as written or by aisle, one pick per device for the recipe
// page and the mise en place. Without an aisle.conf there is no choice.
const hasAisles = () => shopCtx().aisle.sections.length > 0;
const byAisle = () => hasAisles() && saved.get('ingSort', 'recipe') === 'aisle';

function sortToggle() {
  if (!hasAisles()) return '';
  const v = byAisle() ? 'aisle' : 'recipe';
  return `<div class="seg ing-sort" role="group" aria-label="Sort ingredients">
    <button type="button" data-sort="recipe" aria-pressed="${v === 'recipe'}">As written</button>
    <button type="button" data-sort="aisle" aria-pressed="${v === 'aisle'}">By aisle</button>
  </div>`;
}

/** The ingredient list, flat or under aisle headings. `links` makes other recipes links. */
function ingLines(items, checked, { interactive = true, links = true } = {}) {
  const row = (x) => `<li class="ing-row${checked.has(x.key) ? ' is-checked' : ''}" data-key="${esc(x.key)}">
      ${interactive ? `<input type="checkbox" class="tick" aria-label="Got ${esc(x.name)}" ${checked.has(x.key) ? 'checked' : ''}>` : ''}
      <span class="ing-qty">${esc(x.qty)}</span>
      <span class="ing-name">${links && x.href ? `<a href="#/r/${encPath(x.href)}">${esc(x.name)}</a>` : esc(x.name)}${x.note ? ` <span class="ing-note">${esc(x.note)}</span>` : ''}${x.optional ? ' <span class="ing-note">optional</span>' : ''}</span>
    </li>`;
  if (!interactive || !byAisle()) return `<ul class="ing-list">${items.map(row).join('')}</ul>`;
  return shop.aisleGroups(items, shopCtx().aisle).map((g) => `
    <h3 class="ing-sec">${esc(cap(g.name))}</h3>
    <ul class="ing-list">${g.items.map(row).join('')}</ul>`).join('');
}

/** Wires the sort toggle in `root`; `redraw` puts the list in again. */
function wireSort(root, redraw) {
  $$('.ing-sort button', root).forEach((b) => {
    b.onclick = () => {
      saved.set('ingSort', b.dataset.sort);
      $$('.ing-sort button', root).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      redraw();
    };
  });
}

/** Renders ingredients, cookware and method for a parsed recipe. */
function recipeBody(parsed, { interactive = true, path = '' } = {}) {
  const { recipe } = parsed;
  if (!recipe) return '<p class="muted">This recipe could not be read.</p>';
  const checked = S.checked.get(path) || new Set();
  const items = ingItems(parsed);

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
      <div class="ing-head"><h2>Ingredients</h2>${interactive && items.length ? sortToggle() : ''}</div>
      ${items.length ? `<div class="ing-lines">${ingLines(items, checked, { interactive })}</div>` : '<p class="muted">No ingredients listed.</p>'}
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
      <div class="recipe-top ${e.imageUrl || e.photoLoading ? 'has-img' : ''}">
        ${e.imageUrl ? `<figure class="hero"><img src="${esc(e.imageUrl)}" alt="${esc(e.title)}"></figure>`
          : e.photoLoading ? '<figure class="hero skeleton" aria-hidden="true"></figure>' : ''}
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
            ${canPlan() ? `<button class="btn btn-quiet icon-btn" id="save-btn" title="Save" aria-label="Save">${BOOKMARK_ICON}</button>` : ''}
            ${owner
              ? `<a class="btn btn-quiet icon-btn" id="edit-btn" ${claudeLink(path)} title="Edit" aria-label="Edit">${PEN_ICON}</a>`
              : `<button class="btn btn-quiet icon-btn" id="share-btn" title="Share" aria-label="Share" aria-haspopup="dialog">${SHARE_ICON}</button>`}
            ${owner || canEdit ? `
            <details class="menu recipe-more">
              <summary class="btn btn-quiet icon-btn" title="More" aria-label="More">${MORE_ICON}</summary>
              <div class="menu-pop">
                ${owner ? '<button class="menu-item" id="share-btn" aria-haspopup="dialog">Share</button>' : ''}
                <button class="menu-item" id="print-btn">Print</button>
                ${canEdit ? '<button class="menu-item" id="photo-btn" aria-haspopup="dialog">Change photo</button>' : ''}              </div>
            </details>`
              : `<button class="btn btn-quiet icon-btn" id="print-btn" title="Print" aria-label="Print">${PRINT_ICON}</button>`}
          </div>
        </div>
      </div>
      <div class="recipe-body" id="body"></div>
      <p class="print-only print-foot" id="print-foot"></p>
    </article>`;
  $('#print-btn').onclick = () => { closeMenus(); window.print(); };
  // A photo that cannot load (offline and not kept yet) falls back to the
  // card photo, else it goes, rather than showing a broken image.
  fullPhoto(e);
  heroBackdrop(e);
  const hero = $('.hero img');
  if (hero) hero.onerror = () => {
    if (e.thumbUrl && hero.getAttribute('src') !== e.thumbUrl) { hero.src = e.thumbUrl; return; }
    hero.closest('.recipe-top').classList.remove('has-img');
    hero.parentElement.remove();
  };
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
    // The end of the method: what you noticed while cooking goes back in.
    if (owner) $('#body .method').insertAdjacentHTML('beforeend', `<p class="cooked">Cooked it? <a ${claudeLink(path, true)}>Note what to change for next time</a></p>`);
    drawScaler();
    drawAddList();
    drawSave();
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
    const wireTicks = () => $$('#body .ing-row').forEach((row) => {
      const box = row.querySelector('.tick');
      if (!box) return;
      box.onchange = () => {
        box.checked ? set.add(row.dataset.key) : set.delete(row.dataset.key);
        row.classList.toggle('is-checked', box.checked);
      };
    });
    wireTicks();
    wireSort($('#body'), () => { $('#body .ing-lines').innerHTML = ingLines(ingItems(parsed), set); wireTicks(); });
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

  // Save: one tap puts it in Saved, at the size on the page when you changed
  // it, else at Cooking for. Filled when it is saved or planned.
  const drawSave = () => {
    const btn = $('#save-btn');
    if (!btn) return;
    const u = plan.uses(P(), path);
    const t = plan.dayKey();
    const next = u.meals.filter((m) => !isCooked(m) && m.day >= t).sort(byDayMeal)[0];
    const s = u.saved[0];
    const label = s ? 'Saved. Tap to remove.' : next ? `Planned for ${dayWord(next.day)}. Tap to save it again.` : 'Save';
    btn.dataset.state = s ? 'saved' : next ? 'planned' : 'off';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-pressed', String(Boolean(s)));
    btn.innerHTML = s ? BOOKMARK_ON_ICON : next ? CAL_ICON : BOOKMARK_ICON;
  };
  S.refreshSave = drawSave;
  const saveBtn = $('#save-btn');
  if (saveBtn) saveBtn.onclick = () => {
    const s = plan.uses(P(), path).saved[0];
    if (s) {
      planUndo(`Removed ${e.title} from Saved.`, { t: 'unsave', id: s.id });
      return;
    }
    saveRecipe(path, { servings: base && servings !== base ? servings : null, x: !base && mult !== 1 ? mult : null });
  };

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
    if (sideMode() !== 'off' && saved.get('sidePanel', null) == null) showSideTab('list');
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
  const { recipe } = parsed;
  const toolName = (c) => (c.alias || c.name).toLowerCase();
  // Which steps use each thing, matched by name, for the desktop list.
  const usedIn = (test) => steps.map((s, i) => (test(s) ? i + 1 : 0)).filter(Boolean);
  const ings = ingItems(parsed).map((x) => ({ ...x, steps: usedIn((s) => s.ings.some((i) => lc(ingName(i)) === lc(x.name))) }));
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
  const planId = params.get('plan'); // opened from the plan: Finish ticks that meal
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
      ${list.ings.length ? `<div class="ing-head"><h2>Ingredients</h2>${sortToggle()}</div><div class="ing-lines">${ingLines(list.ings, checked, { links: false })}</div>` : ''}
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

  // Finish: back to the recipe, and when it can be changed here, first ask
  // what to improve for next time while it is fresh.
  const finish = () => {
    if (!(drive.enabled() && drive.wasSignedIn())) { go(backHash()); return; }
    markCooked(path, planId);
    const dlg = $('#choose');
    openChoose($('#cook-next'), path, true, true);
    // Edit the file has already moved on; the rest go back.
    dlg.addEventListener('close', () => { if (parseHash().path === `/cook/${path}`) go(backHash()); }, { once: true });
  };

  const go2 = (n, dir = 0) => {
    if (n > steps.length) { finish(); return; }
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

  const wireTicks = () => $$('.ing-row', stage).forEach((row) => {
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

  const wire = () => {
    wireTicks();
    wireSort(stage, () => { $('.ing-lines', stage).innerHTML = ingLines(list.ings, checked, { links: false }); wireTicks(); });
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
  // Signed out, the copy from the last build.
  const a = (S.conf.aisle ? S.conf.aisle.text : S.builtAisle) || '';
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
  drawPlan(); // in list and bought show on the plan
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
  listPoll = setInterval(() => { if (!document.hidden) { S.shop.sync(); if ($('#plan-root')) S.plan?.sync(); } }, 15000);
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
    <section class="shop${panel ? ' shop-panel' : ''}"${panel ? ' data-drop="list"' : ''}>
      ${panel ? `<div class="side-head">
        ${canPlan() ? sideToggle('list') : '<h2>Shopping list</h2>'}${count}
        <a class="icon-btn" href="#/list" title="Open as a page" aria-label="Open the shopping list as a page">${EXPAND_ICON}</a>
        <button class="icon-btn" id="side-close" title="Close (L)" aria-label="Close the shopping list">${PANEL_ICON}</button>
      </div>
      <p class="shop-status" id="shop-status" aria-live="polite"></p>` : `<div class="shop-head">
        <h1>Shopping list</h1>
        ${canPlan() ? '<div class="seg side-tabs list-tabs" role="group" aria-label="Show"><button type="button" data-page-tab="plan" aria-pressed="false">Plan</button><button type="button" aria-pressed="true">List</button></div>' : ''}
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
  $$('[data-side-tab]', root).forEach((b) => { b.onclick = () => showSideTab(b.dataset.sideTab); });
  $$('[data-page-tab]', root).forEach((b) => { b.onclick = () => go('#/plan'); });
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
    tickItem(box.closest('.shop-row').dataset.key, box.checked);
  });
  body.addEventListener('click', (ev) => {
    const more = ev.target.closest('[data-more]');
    if (more) { itemSheet(more.closest('.shop-row')); return; }
    const fold = ev.target.closest('[data-fold-recipe]');
    if (fold) {
      const k = fold.dataset.foldRecipe;
      listFolded.has(k) ? listFolded.delete(k) : listFolded.add(k);
      saved.set('listFolded', [...listFolded].filter((x) => S.shop.list.recipes.some((r) => r.path === x)));
      updateList();
      return;
    }
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

// ---------------------------------------------------------------- meal plan

// Saved recipes and the days ahead (plan.js has the data and its rules).
// Signed in only. It shows in three places: the side panel beside the
// recipes on wide screens, #/plan (a real week on wide screens, the Plan tab
// on phones), and Today on top of the home page.
const BOOKMARK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.5h10a1 1 0 0 1 1 1v16l-6-4.2-6 4.2v-16a1 1 0 0 1 1-1z"/></svg>';
const BOOKMARK_ON_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.5h10a1 1 0 0 1 1 1v16l-6-4.2-6 4.2v-16a1 1 0 0 1 1-1z" fill="currentColor"/></svg>';
const CAL_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>';
// bought: a bag with a tick; cooked: a ticked circle
const BAG_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 8h13l-1 12.5h-11z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8M9.5 14.2l1.8 1.8 3.4-3.6"/></svg>';
const COOKED_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.2 2.4 2.4 4.6-4.9"/></svg>';
const WARN_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.5M12 17h.01"/></svg>';
const MEAL_ICONS = {
  breakfast: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 9.5h11v4.5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5z"/><path d="M16 10.5h1.5a2.5 2.5 0 0 1 0 5H16M9 3.5v2.5M12.5 3.5v2.5"/></svg>',
  lunch: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/></svg>',
  dinner: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/></svg>',
  snack: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7.5c-2-1.5-6.5-1-6.5 4 0 4.5 3 8.5 5 8.5 1 0 1-.5 1.5-.5s.5.5 1.5.5c2 0 5-4 5-8.5 0-5-4.5-5.5-6.5-4z"/><path d="M12 7.5c0-2 .5-3.5 2-4.5"/></svg>',
};
const NOTE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 4.5h13v10l-5 5h-8z"/><path d="M13.5 19.5v-5h5M9 9h6M9 12.5h3"/></svg>';
const SALAD_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 12h17a8.5 8.5 0 0 1-17 0zM7 12a5 5 0 0 1 10 0"/></svg>';

const canPlan = () => Boolean(S.plan && drive.wasSignedIn());
const P = () => S.plan.list;
const planServings = (x) => x.servings ?? P().servings;
const planTitleOf = (x) => (x.path && S.recipes.get(x.path)?.title) || x.title || prettifyFile((x.path || '').split('/').pop());
// Only live data knows for sure that a recipe is gone; the built copy can be an hour old.
const isGone = (x) => Boolean(x.path) && S.live === 'on' && !S.recipes.has(x.path);
const isCooked = (x) => x.kind === 'recipe' && plan.isCookedIn(P(), x);
const mealOrder = (m) => [...plan.MEALS, 'notes'].indexOf(m);
const byDayMeal = (a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : mealOrder(a.meal) - mealOrder(b.meal));

/** How much of a recipe a plan entry is: its servings over the recipe's, or its multiplier. */
function planFactor(x) {
  const e = S.recipes.get(x.path);
  const base = e && baseServings(e);
  return base ? planServings(x) / base : (x.x || 1);
}
function planSize(x) {
  const e = S.recipes.get(x.path);
  return e && !baseServings(e) ? `${x.x || 1}×` : servingsText(planServings(x));
}
/** Set by hand, so it no longer follows "Cooking for". */
const ownSize = (x) => (x.servings != null && x.servings !== P().servings) || (x.x != null && x.x !== 1);
/** The size in the bubble at the end of a chip: servings, or the multiplier. */
function planBubble(x) {
  const e = S.recipes.get(x.path);
  return e && !baseServings(e) ? `${x.x || 1}×` : String(planServings(x));
}
/** Everything a batch cooks, for cook mode on its first day. */
function batchSize(x) {
  const all = plan.cookedOnce(P(), x) ? plan.batchOf(P(), x) : [x];
  return { servings: all.reduce((n, m) => n + planServings(m), 0), x: all.reduce((n, m) => n + (m.x || 1), 0), n: all.length };
}

function dayName(key) {
  const t = plan.dayKey();
  if (key === t) return 'Today';
  if (key === plan.addDays(t, 1)) return 'Tomorrow';
  if (key === plan.addDays(t, -1)) return 'Yesterday';
  return plan.toDate(key).toLocaleDateString(undefined, { weekday: 'long' });
}
const dateText = (key) => plan.toDate(key).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
/** today, tomorrow, or the name of the day, for the middle of a sentence. */
const dayWord = (key) => { const n = dayName(key); return ['Today', 'Tomorrow', 'Yesterday'].includes(n) ? n.toLowerCase() : n; };
const weekday = (key) => plan.toDate(key).toLocaleDateString(undefined, { weekday: 'short' });
/** The meal that fits the time of day, for a recipe cooked without a plan. */
const mealNow = () => { const h = new Date().getHours(); return h < 11 ? 'breakfast' : h < 15 ? 'lunch' : h < 17 ? 'snack' : 'dinner'; };

/** A saved or planned entry by id, wherever it is. */
const planEntry = (id) => P().meals.find((m) => m.id === id) || P().saved.find((s) => s.id === id) || null;

// ---- the plan and the shopping list stay in step

/** Whether everything a list recipe needs is in the basket, per list recipe id. */
let boughtMemo = { list: null, aisle: null, pantry: null, map: new Map() };
function boughtMap() {
  const list = S.shop?.list;
  if (!list || !S.parserReady) return new Map();
  const ctx = shopCtx();
  if (boughtMemo.list !== list || boughtMemo.aisle !== ctx.aisle || boughtMemo.pantry !== ctx.pantry) {
    const map = new Map();
    try {
      const b = shop.buildList(list, ctx);
      for (const r of b.recipes) map.set(r.id, !r.missing && r.lines.every((l) => l.group.checked || !toBuy(l.group)));
      for (const it of b.manual) map.set(it.id, it.group.checked);
    } catch { /* not ready */ }
    boughtMemo = { list, aisle: ctx.aisle, pantry: ctx.pantry, map };
  }
  return boughtMemo.map;
}

/** cooked | bought | list | '' for a plan entry. */
function planState(x) {
  if (isCooked(x)) return 'cooked';
  if (x.bought) return 'bought';
  if (!S.shop) return '';
  if (x.kind === 'item') {
    if (!S.shop.list.items.some((i) => i.id === x.id)) return '';
    return boughtMap().get(x.id) ? 'bought' : 'list';
  }
  const r = S.shop.list.recipes.find((l) => l.planIds?.includes(x.id));
  if (!r) return '';
  return boughtMap().get(r.id) ? 'bought' : 'list';
}

/**
 * Puts plan entries of one recipe on the shopping list, or takes them off
 * (`drop`), as one list recipe at the size of all of them together. What
 * was added by hand on the recipe page stays as `extra`.
 */
function linkList(path, add = [], drop = []) {
  const e = S.recipes.get(path);
  if (!S.shop || !e) return;
  const prior = S.shop.list.recipes.find((r) => r.path === path);
  if (!prior && !add.length) return;
  const extra = prior ? (prior.planIds ? prior.extra || 0 : prior.factor || 1) : 0;
  const ids = [...new Set([...(prior?.planIds || []), ...add])].filter((id) => !drop.includes(id) && P().meals.some((m) => m.id === id));
  if (!ids.length && !extra) { S.shop.do({ t: 'removeRecipe', id: prior.id }); return; }
  const factor = Math.round((extra + ids.reduce((n, id) => n + planFactor(planEntry(id)), 0)) * 1000) / 1000;
  const base = baseServings(e);
  S.shop.do({
    t: 'addRecipe', id: prior?.id || shop.newId(), path, title: e.title, servings: base ? Math.round(factor * base * 100) / 100 : null, factor,
    parts: prior?.parts || null, keys: add.length ? shop.recipeKeys(e.src, factor, shopCtx(), prior?.parts || null) : [], planIds: ids, extra,
  });
}
/** After a plan entry changed size or went: the list follows, if it was on it. */
function relinkList(x, gone = false) {
  if (!x || !x.path || !S.shop) return;
  if (S.shop.list.recipes.some((r) => r.path === x.path && r.planIds?.includes(x.id))) linkList(x.path, [], gone ? [x.id] : []);
}

/** Adds plan entries (recipes and loose ingredients) to the shopping list. */
function addPlanToList(entries) {
  const byPath = new Map();
  for (const x of entries) {
    if (x.kind === 'item') {
      S.shop.do({ t: 'addItem', id: x.id, name: x.title, n: x.n ?? null, unit: x.unit || '', key: shop.lookup(shopCtx().aisle, x.title).key });
      continue;
    }
    if (!byPath.has(x.path)) byPath.set(x.path, []);
    byPath.get(x.path).push(x.id);
  }
  for (const [path, ids] of byPath) linkList(path, ids);
}

// ---- changes

function planUndo(msg, ops) {
  const before = P();
  for (const op of [].concat(ops)) S.plan.do(op);
  toast(msg, { label: 'Undo', run: () => S.plan.do({ t: 'restore', plan: before }) });
}

function saveRecipe(path, { servings = null, x = null, quiet = false } = {}) {
  const e = S.recipes.get(path);
  if (!e) return;
  if (servings === P().servings) servings = null;
  const op = { t: 'save', id: shop.newId(), path, title: e.title, servings, x };
  const size = baseServings(e) ? `for ${servings ?? P().servings}` : x && x !== 1 ? `${x}×` : '';
  if (quiet) { S.plan.do(op); return; }
  planUndo(`Saved ${e.title}${size ? ` ${size}` : ''}.`, op);
  if (sideMode() !== 'off' && saved.get('sidePanel', null) == null) showSideTab('plan');
}

function placeRecipe(path, day, meal, extra = {}) {
  const e = S.recipes.get(path);
  if (!e) return;
  S.plan.do({ t: 'place', entries: [{ id: shop.newId(), kind: 'recipe', path, title: e.title, day, meal, ...extra }] });
}

/** Ticks a meal cooked or not. Cooked once for more days, the whole batch goes with it. */
function setCooked(m, on) {
  for (const x of plan.cookedOnce(P(), m) ? plan.batchOf(P(), m) : [m]) {
    S.plan.do({ t: 'edit', id: x.id, set: { cooked: on ? (x.cooked || plan.dayKey()) : null } });
  }
}

/** Ticks a meal as cooked, from cook mode's Finish. Without a plan id, the one planned for today or before. */
function markCooked(path, id) {
  if (!canPlan()) return;
  const t = plan.dayKey();
  const p = P();
  let m = id ? p.meals.find((x) => x.id === id) : null;
  const s = id && !m ? p.saved.find((x) => x.id === id) : null;
  if (!m && !s) m = p.meals.filter((x) => x.kind === 'recipe' && x.path === path && !isCooked(x) && x.day <= t).sort(byDayMeal)[0];
  if (m) {
    if (!isCooked(m)) setCooked(m, true);
    return;
  }
  // Cooked straight from Saved: it goes on today, ticked.
  if (s) S.plan.do({ t: 'place', entries: [{ ...s, kind: 'recipe', day: t, meal: mealNow(), cooked: t, fromSaved: s.id }] });
}

/**
 * A new "Cooking for". Meals that follow it change size, and the shopping
 * list with them; what is bought or cooked already keeps its size.
 */
function setCooking(n) {
  const p = P();
  if (n === p.servings) return;
  const follow = p.meals.filter((m) => m.kind === 'recipe' && m.servings == null);
  const keep = follow.filter((m) => ['bought', 'cooked'].includes(planState(m)));
  const listed = new Set(follow.filter((m) => planState(m) === 'list').map((m) => m.path));
  for (const m of keep) S.plan.do({ t: 'edit', id: m.id, set: { servings: p.servings } });
  S.plan.do({ t: 'cooking', n });
  for (const path of listed) linkList(path);
}

function addDay() {
  const days = plan.upcoming(P());
  S.plan.do({ t: 'until', day: plan.addDays(days[days.length - 1], 1) });
}

/** Takes a meal or a saved recipe out of the plan, and off the shopping list unless bought. */
function removeEntry(src, x) {
  const name = x.kind === 'recipe' || src !== 'meal' ? planTitleOf(x) : x.title;
  const listed = src === 'meal' && planState(x) === 'list';
  const planBefore = P();
  const listBefore = S.shop?.list;
  S.plan.do(src === 'meal' ? { t: 'remove', id: x.id } : { t: 'unsave', id: x.id });
  if (listed) {
    if (x.kind === 'item') S.shop.do({ t: 'removeItem', id: x.id });
    else linkList(x.path, [], [x.id]);
  }
  toast(`Removed ${name}${listed ? ' from the plan and the shopping list' : ''}.`, { label: 'Undo', run: () => {
    S.plan.do({ t: 'restore', plan: planBefore });
    if (listBefore && listBefore !== S.shop.list) S.shop.do({ t: 'restore', list: listBefore });
  } });
}

/** A recipe card or a plan chip dropped on the shopping list. */
function dropOnList(d) {
  if (!S.shop) return;
  const p = canPlan() ? P() : null;
  if (d.src === 'meal') {
    const m = p?.meals.find((x) => x.id === d.id);
    if (!m || !['recipe', 'item'].includes(m.kind) || planState(m)) return;
    const before = S.shop.list;
    addPlanToList([m]);
    toast(`Added ${m.kind === 'item' ? m.title : planTitleOf(m)} to your shopping list.`, { label: 'Undo', run: () => S.shop.do({ t: 'restore', list: before }) });
    return;
  }
  const s = d.src === 'saved' ? p?.saved.find((x) => x.id === d.id) : null;
  const path = s ? s.path : d.path;
  const e = S.recipes.get(path);
  if (!e || !S.parserReady) return;
  // At its size in Saved, else Cooking for, else as written.
  const base = baseServings(e);
  const servings = base ? (s?.servings ?? p?.servings ?? base) : null;
  const factor = base ? servings / base : (s?.x || 1);
  const prior = S.shop.list.recipes.find((r) => r.path === path);
  const before = S.shop.list;
  const id = shop.newId();
  const keys = shop.recipeKeys(e.src, factor, shopCtx(), prior?.parts || null);
  S.flash = { recipeId: id, keys: new Set(keys), start: Date.now(), until: Date.now() + 2500 };
  S.shop.do({ t: 'addRecipe', id, path, title: e.title, servings, factor, parts: prior?.parts || null, keys });
  toast(`Added ${e.title} (${base ? servingsText(servings) : `${factor}×`}) to your shopping list.`, { label: 'Undo', run: () => S.shop.do({ t: 'restore', list: before }) });
}

/** What happens when something is dropped on a target of the plan. `copy`: Alt was held. */
function dropOn(target, d, copy) {
  const kind = target.dataset.drop;
  const p = P();
  if (kind === 'trash') {
    const x = d.src === 'meal' ? p.meals.find((m) => m.id === d.id) : d.src === 'saved' ? p.saved.find((s) => s.id === d.id) : null;
    if (x) removeEntry(d.src, x);
    return;
  }
  if (kind === 'list') { dropOnList(d); return; }
  if (kind === 'saved') {
    if (d.src === 'recipe') saveRecipe(d.path);
    else if (d.src === 'meal') {
      const m = p.meals.find((x) => x.id === d.id);
      if (m?.kind !== 'recipe') return;
      relinkList(m, true);
      S.plan.do({ t: 'toSaved', id: m.id });
    }
    return;
  }
  const day = target.dataset.day;
  const meal = target.dataset.meal;
  if (!day || !meal) return;
  if (d.src === 'recipe') { if (meal !== 'notes') placeRecipe(d.path, day, meal); return; }
  if (d.src === 'saved') {
    const s = p.saved.find((x) => x.id === d.id);
    if (!s || meal === 'notes') return;
    const id = copy ? shop.newId() : s.id;
    S.plan.do({ t: 'place', entries: [{ ...s, id, kind: 'recipe', day, meal, fromSaved: copy ? null : s.id }] });
    return;
  }
  if (d.src === 'meal') {
    const m = p.meals.find((x) => x.id === d.id);
    if (!m) return;
    // Notes stay notes, and only notes go in the notes row.
    const to = m.kind === 'note' ? 'notes' : meal === 'notes' ? null : meal;
    if (!to) return;
    if (copy) {
      const { cooked, bought, batch, each, ...rest } = m;
      S.plan.do({ t: 'place', entries: [{ ...rest, id: shop.newId(), day, meal: to }] });
    } else if (m.day !== day || m.meal !== to) S.plan.do({ t: 'move', id: m.id, day, meal: to });
  }
}

// ---- drawing

function planThumb(x) {
  if (x.kind === 'note') return `<span class="pthumb is-icon">${NOTE_ICON}</span>`;
  if (x.kind === 'item') return `<span class="pthumb is-icon">${BASKET_ICON}</span>`;
  if (x.kind === 'free') return `<span class="pthumb is-icon">${SALAD_ICON}</span>`;
  const e = x.path && S.recipes.get(x.path);
  if (e?.thumbUrl) return `<span class="pthumb"><img src="${esc(e.thumbUrl)}" alt="" loading="lazy" decoding="async"></span>`;
  return `<span class="pthumb"><span class="ph" aria-hidden="true">${esc(planTitleOf(x).charAt(0))}</span></span>`;
}

const STATE_ICONS = { list: BASKET_ICON, bought: BAG_ICON, cooked: COOKED_ICON };
const STATE_WORDS = { list: 'on the shopping list', bought: 'bought', cooked: 'cooked' };

/** One saved or planned thing: photo, name, a state icon and the servings bubble. `src`: meal or saved. */
function planChip(x, src) {
  const gone = isGone(x) && x.kind === 'recipe';
  const state = src === 'meal' ? planState(x) : '';
  const cls = [`pchip kind-${x.kind || 'recipe'}`];
  const isRecipe = src === 'saved' || x.kind === 'recipe';
  let sub = '';
  if (x.kind === 'free') sub = 'No recipe';
  else if (x.kind === 'item') sub = x.n != null ? fmtAmount(x.n, x.unit || '') : 'To buy';
  if (src === 'meal' && isRecipe) {
    const first = plan.cookMeal(P(), x);
    if (first !== x) { cls.push('is-later'); sub = `${first.cooked ? 'Cooked' : 'From'} ${weekday(first.day)}`; }
    else if (x.cooked && x.cooked < x.day) sub = `Cooked ${weekday(x.cooked)}`;
    else if (plan.cookedOnce(P(), x)) sub = `Cook for ${plan.batchOf(P(), x).length} days`;
  }
  if (x.note) sub = sub ? `${sub} · ${x.note}` : x.note;
  if (state) cls.push(`is-${state}`);
  if (gone) { cls.push('is-gone'); sub = 'This recipe was deleted'; }
  const title = isRecipe ? planTitleOf(x) : x.title;
  const mark = gone ? WARN_ICON : STATE_ICONS[state] || '';
  const bubble = isRecipe && !gone ? `<span class="pbubble${ownSize(x) ? ' is-own' : ''}" title="${esc(planSize(x))}">${esc(planBubble(x))}</span>` : '';
  const label = [title, isRecipe ? planSize(x) : '', sub, STATE_WORDS[state]].filter(Boolean).join(', ');
  return `<button class="${cls.join(' ')}" type="button" draggable="true" data-src="${src}" data-id="${esc(x.id)}" aria-label="${esc(label)}">
    ${planThumb(x)}<span class="pchip-text"><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span>${mark ? `<span class="pchip-mark">${mark}</span>` : ''}${bubble}
  </button>`;
}

function savedHTML(layout) {
  const now = P().saved;
  const hint = layout === 'page' ? 'Tap Save on a recipe, or hold a recipe card. Hold one here to drag it onto a day.' : 'Drag a recipe here, or tap Save on a recipe.';
  return `<section class="psaved" data-drop="saved">
      <div class="psec-head"><h3>Saved</h3><span>${now.length || ''}</span></div>
      ${now.length ? `<div class="pchips">${now.map((s) => planChip(s, 'saved')).join('')}</div>` : `<p class="phint">${hint}</p>`}
    </section>`;
}

// Days folded away, per device.
const planFolded = new Set(saved.get('planFolded', []));

function dayHTML(day) {
  const xs = plan.on(P(), day).sort(byDayMeal);
  const t = plan.dayKey();
  const late = day < t && xs.some((m) => m.kind === 'recipe' && !isCooked(m));
  const slots = plan.MEALS.map((meal) => {
    const here = xs.filter((m) => m.meal === meal);
    return `<div class="pslot${here.length ? '' : ' is-empty'}" data-drop="slot" data-day="${day}" data-meal="${meal}">
      <span class="pslot-icon" title="${plan.MEAL_NAMES[meal]}">${MEAL_ICONS[meal]}</span>
      <div class="pslot-items">${here.length ? here.map((m) => planChip(m, 'meal')).join('') : `<span class="pslot-name">${plan.MEAL_NAMES[meal]}</span>`}</div>
    </div>`;
  }).join('');
  const notes = xs.filter((m) => m.meal === 'notes');
  const folded = planFolded.has(day);
  const n = xs.filter((m) => m.meal !== 'notes').length;
  return `<li class="pday${day === t ? ' is-today' : ''}${day < t ? ' is-past' : ''}${late ? ' is-late' : ''}${xs.length ? '' : ' is-blank'}${folded ? ' is-folded' : ''}">
    <div class="pday-head">
      <button class="pday-fold" type="button" data-fold-day="${day}" aria-expanded="${!folded}" title="${folded ? 'Show' : 'Hide'} this day">${CHEVRON_ICON}</button>
      <b>${esc(dayName(day))}</b><span>${esc(dateText(day))}${folded && n ? ` · ${n} ${n === 1 ? 'meal' : 'meals'}` : ''}</span>
      <button class="icon-btn pday-add" type="button" data-add-day="${day}" title="Add to this day" aria-label="Add to ${esc(dayName(day))}">${PLUS_ICON}</button></div>
    ${late ? `<p class="plate">${WARN_ICON}<span>Not ticked as cooked. Move it to a day, or tap it and tick Cooked.</span></p>` : ''}
    <div class="pday-body">
    ${xs.length ? '' : '<p class="pday-empty">Nothing planned</p>'}
    ${slots}
    ${notes.length ? `<div class="pnotes">${notes.map((m) => planChip(m, 'meal')).join('')}</div>` : ''}
    </div>
  </li>`;
}

function cookingForHTML() {
  const n = P().servings;
  return `<div class="pcook"><span>Cooking for</span>
    <div class="scaler">
      <button class="step-btn" type="button" data-cook="-1" aria-label="Cook for fewer" ${n <= 1 ? 'disabled' : ''}>−</button>
      <output aria-live="polite"><b>${n}</b></output>
      <button class="step-btn" type="button" data-cook="1" aria-label="Cook for more">+</button>
    </div></div>`;
}

const sideToggle = (on, attr = 'data-side-tab') => `<div class="seg side-tabs" role="group" aria-label="Show">
  <button type="button" ${attr}="plan" aria-pressed="${on === 'plan'}" title="Plan (P)" aria-label="Plan">${CAL_ICON}</button>
  <button type="button" ${attr}="list" aria-pressed="${on === 'list'}" title="Shopping list (L)" aria-label="Shopping list"${attr === 'data-side-tab' ? ' data-drop="list"' : ''}>${BASKET_ICON}</button></div>`;

/** The calendar: days left uncooked first, then today and on. */
function daysHTML() {
  const p = P();
  const t = plan.dayKey();
  return `<section class="pcal"><div class="psec-head"><h3>Calendar</h3></div>
    <ol class="pdays">${[...plan.late(p, t), ...plan.upcoming(p, t)].map(dayHTML).join('')}</ol>
    <button class="pghost" type="button" data-act="add-day">${PLUS_ICON}<span>Add a day</span></button></section>`;
}

function weekHTML() {
  const p = P();
  const t = plan.dayKey();
  const lateDays = plan.late(p, t);
  const past = S.weekEarlier ? plan.earlier(p, t) : lateDays;
  const days = [...past, ...plan.upcoming(p, t)];
  const head = days.map((d) => `<div class="whead${d === t ? ' is-today' : ''}${d < t ? ' is-past' : ''}${lateDays.includes(d) ? ' is-late' : ''}">
      <b>${lateDays.includes(d) ? WARN_ICON : ''}${esc(dayName(d))}</b><span>${esc(dateText(d))}</span>
      <button class="icon-btn pday-add" type="button" data-add-day="${d}" title="Add to this day" aria-label="Add to ${esc(dayName(d))}">${PLUS_ICON}</button></div>`).join('');
  const rows = [...plan.MEALS, 'notes'].map((meal) => `<div class="wlabel">${MEAL_ICONS[meal] || NOTE_ICON}<span>${plan.MEAL_NAMES[meal]}</span></div>${days.map((d) => `
      <div class="wcell${d < t ? ' is-past' : ''}" data-drop="slot" data-day="${d}" data-meal="${meal}">${plan.on(p, d, meal).map((m) => planChip(m, 'meal')).join('')}</div>`).join('')}`).join('');
  const nPast = plan.earlier(p, t).length;
  return `<header class="week-head">
      <h1>Plan</h1>
      ${sideToggle('plan', 'data-page-tab')}
      <p class="shop-status" id="plan-status" aria-live="polite">${shopStatus(S.plan)}</p>
      ${cookingForHTML()}
      ${nPast ? `<button class="btn btn-quiet btn-sm" type="button" data-act="earlier" aria-pressed="${Boolean(S.weekEarlier)}">${S.weekEarlier ? 'Hide earlier' : `Earlier days (${nPast})`}</button>` : ''}
      <button class="btn btn-primary btn-sm" type="button" data-act="shop">${BASKET_ICON}Add to shopping list</button>
      <button class="icon-btn" type="button" data-act="to-side" title="Show beside the recipes (P)" aria-label="Show the plan beside the recipes">${SHRINK_ICON}</button>
    </header>
    ${lateDays.length ? `<p class="plate">${WARN_ICON}<span>${lateDays.length === 1 ? `${esc(dayName(lateDays[0]))} has a meal` : `${lateDays.length} days have meals`} not ticked as cooked. Move them, or tick Cooked.</span></p>` : ''}
    <div class="week">
      <aside class="week-side">${savedHTML('week')}</aside>
      <div class="week-scroll"><div class="week-grid" style="--days:${days.length}">
        <div class="wcorner"></div>${head}
        <button class="wghost" type="button" data-act="add-day" title="Add a day" aria-label="Add a day">${PLUS_ICON}</button>
        ${rows}
      </div></div>
    </div>`;
}

/** Puts the plan in `root`. layout: panel (beside the recipes), week (full screen, wide) or page (phones). */
function mountPlan(root, layout) {
  root.innerHTML = `<section class="plan plan-${layout}" id="plan-root" data-layout="${layout}"></section>`;
  wirePlan($('#plan-root', root));
  drawPlan();
  startListPolling();
  if (S.live !== 'loading') S.plan.sync();
}

function drawPlan() {
  const root = $('#plan-root');
  if (!root || !S.plan) return;
  // A redraw would take the dragged chip away and end the drag: it waits for the drop.
  if (drag) { drawLater = true; return; }
  const layout = root.dataset.layout;
  const status = `<p class="shop-status" id="plan-status" aria-live="polite">${shopStatus(S.plan)}</p>`;
  const shopBtn = `<button class="btn btn-primary pshop" type="button" data-act="shop">${BASKET_ICON}Add to shopping list</button>`;
  if (layout === 'week') root.innerHTML = weekHTML();
  else if (layout === 'panel') {
    root.innerHTML = `<div class="side-head">${sideToggle('plan')}
        <a class="icon-btn" href="#/plan" title="Full screen" aria-label="Open the plan full screen">${EXPAND_ICON}</a>
        <button class="icon-btn" type="button" id="side-close" title="Close (P)" aria-label="Close the plan">${PANEL_ICON}</button></div>
      ${status}${cookingForHTML()}${savedHTML(layout)}${daysHTML()}${shopBtn}`;
  } else {
    root.innerHTML = `<div class="shop-head"><h1>Plan</h1>${status}</div>
      <div class="plan-bar">${cookingForHTML()}</div>
      ${savedHTML(layout)}${daysHTML()}${shopBtn}`;
  }
  const renew = $('#shop-renew', root); if (renew) renew.onclick = () => signInFlow();
  const retry = $('#shop-retry', root); if (retry) retry.onclick = () => S.plan.sync();
}

function wirePlan(root) {
  // The empty meals of a day open when the pointer is on its name line, and
  // stay open while it is anywhere on the day.
  root.addEventListener('mouseover', (ev) => {
    const day = ev.target.closest('.pday');
    $$('.pday.is-open', root).forEach((d) => { if (d !== day) d.classList.remove('is-open'); });
    if (day && ev.target.closest('.pday-head')) day.classList.add('is-open');
  });
  root.addEventListener('mouseleave', () => $$('.pday.is-open', root).forEach((d) => d.classList.remove('is-open')));
  root.addEventListener('click', (ev) => {
    const t = ev.target;
    const chip = t.closest('.pchip');
    if (chip) { planSheet(chip.dataset.src, chip.dataset.id); return; }
    const add = t.closest('[data-add-day]');
    if (add) { openAdd(add, add.dataset.addDay); return; }
    const fold = t.closest('[data-fold-day]');
    if (fold) {
      const d = fold.dataset.foldDay;
      planFolded.has(d) ? planFolded.delete(d) : planFolded.add(d);
      // Days gone by are forgotten.
      saved.set('planFolded', [...planFolded].filter((x) => x >= plan.addDays(plan.dayKey(), -14)));
      drawPlan();
      return;
    }
    const cook = t.closest('[data-cook]');
    if (cook) { setCooking(Math.max(1, P().servings + Number(cook.dataset.cook))); return; }
    const side = t.closest('[data-side-tab]');
    if (side) { showSideTab(side.dataset.sideTab); return; }
    const page = t.closest('[data-page-tab]');
    if (page) { if (page.dataset.pageTab === 'list') go('#/list'); return; }
    if (t.closest('#side-close')) { setSide('closed'); return; }
    const act = t.closest('[data-act]')?.dataset.act;
    if (act === 'add-day') addDay();
    else if (act === 'shop') openPlanShop();
    else if (act === 'earlier') { S.weekEarlier = !S.weekEarlier; drawPlan(); }
    else if (act === 'to-side') { saved.set('sideTab', 'plan'); saved.set('sidePanel', 'open'); go(S.lastPage && !S.lastPage.startsWith('#/plan') ? S.lastPage : '#/'); }
    else {
      // An empty meal: add something there.
      const cell = t.closest('.wcell, .pslot.is-empty');
      if (cell) openAdd(cell, cell.dataset.day, cell.dataset.meal);
    }
  });
}

function onPlanChange() {
  S.refreshSave?.();
  drawPlan();
  drawToday();
  healPlan();
}

// A recipe moved or renamed somewhere else (the Cooklang app, Claude): find
// it again by its title or file name, once per path.
const healTried = new Set();
function healPlan() {
  if (S.live !== 'on' || !S.plan?.loaded) return;
  const p = P();
  for (const x of [...p.saved, ...p.meals]) {
    if (!x.path || S.recipes.has(x.path) || healTried.has(x.path)) continue;
    healTried.add(x.path);
    const file = x.path.split('/').pop();
    const hits = [...S.recipes.values()].filter((e) => (x.title && fold(e.title) === fold(x.title)) || e.file === file);
    if (hits.length === 1) S.plan.do({ t: 'repath', from: x.path, to: hits[0].path, title: hits[0].title });
  }
}

// ---- Today, on top of the home page

function drawToday() {
  const el = $('#today');
  if (!el) return;
  const t = plan.dayKey();
  const xs = canPlan() ? plan.on(P(), t).filter((m) => m.kind !== 'item').sort(byDayMeal) : [];
  if (!xs.length) { el.innerHTML = ''; return; }
  const row = (m) => {
    if (m.meal === 'notes') return `<li class="today-note">${NOTE_ICON}<span>${esc(m.title)}</span></li>`;
    const e = m.path && S.recipes.get(m.path);
    const title = m.kind === 'free' ? m.title : planTitleOf(m);
    const first = m.kind === 'recipe' ? plan.cookMeal(P(), m) : m;
    const cooked = isCooked(m);
    const batch = m.kind === 'recipe' && first === m && plan.cookedOnce(P(), m) ? batchSize(m) : null;
    const size = batch ? `${baseServings(e || {}) ? servingsText(batch.servings) : `${batch.x}×`} for ${batch.n} days` : m.kind === 'recipe' ? planSize(m) : '';
    const sub = [plan.MEAL_NAMES[m.meal], size, first !== m ? `${first.cooked ? 'cooked' : 'from'} ${dayWord(first.day)}` : ''].filter(Boolean).join(' · ');
    const cookable = m.kind === 'recipe' && e && first === m;
    return `<li class="today-row${cooked ? ' is-cooked' : ''}">
      ${planThumb(m)}
      <span class="today-text">${e ? `<a href="#/r/${encPath(m.path)}">${esc(title)}</a>` : `<b>${esc(title)}</b>`}<small>${esc(sub)}</small></span>
      ${cookable && !cooked ? `<a class="btn btn-primary btn-sm" href="${cookHref(m)}">${CHEF_ICON}<span>Cook</span></a>` : ''}
      ${m.kind === 'recipe' ? `<button class="btn btn-quiet btn-sm today-done" type="button" data-done="${esc(m.id)}" aria-pressed="${cooked}">${CHECK_ICON}<span>${cooked ? 'Cooked' : 'Done'}</span></button>` : ''}
    </li>`;
  };
  el.innerHTML = `<section class="today" aria-label="Today">
    <div class="today-head"><h2>Today</h2><span>${esc(dateText(t))}</span><a class="link-btn" href="#/plan">Plan</a></div>
    <ul class="today-list">${xs.map(row).join('')}</ul></section>`;
  $$('[data-done]', el).forEach((b) => {
    b.onclick = () => {
      const m = P().meals.find((x) => x.id === b.dataset.done);
      if (m) setCooked(m, !isCooked(m));
    };
  });
}

/** Cook mode at the planned size (all days of a batch), remembering which meal it is for. */
function cookHref(x) {
  const e = S.recipes.get(x.path);
  const q = new URLSearchParams();
  const size = x.day ? batchSize(x) : { servings: planServings(x), x: x.x || 1 };
  if (e && baseServings(e)) { if (size.servings !== baseServings(e)) q.set('s', size.servings); }
  else if (size.x !== 1) q.set('x', size.x);
  q.set('plan', x.id);
  return `#/cook/${encPath(x.path)}?${q}`;
}

// ---- the card behind a chip

/** Also eat on: the days after the first one of a batch, as toggles. */
function alsoDays(x) {
  const all = plan.batchOf(P(), x);
  const start = all[0].day;
  return Array.from({ length: 7 }, (_, i) => plan.addDays(start, i + 1));
}

function toggleAlso(x, day) {
  const p = P();
  const all = plan.batchOf(p, x);
  const there = all.find((m) => m.day === day);
  if (there) {
    if (there.id === x.id) return;
    relinkList(there, true);
    S.plan.do({ t: 'remove', id: there.id });
    return;
  }
  const batch = x.batch || x.id;
  if (!x.batch) S.plan.do({ t: 'edit', id: x.id, set: { batch } });
  const nid = shop.newId();
  S.plan.do({ t: 'place', entries: [{
    id: nid, kind: 'recipe', path: x.path, title: planTitleOf(x), servings: x.servings ?? null, x: x.x ?? null,
    day, meal: x.meal, batch, ...(x.each ? { each: true } : {}),
  }] });
  // On the shopping list already: the new day joins it.
  if (planState(x) === 'list') linkList(x.path, [nid]);
}

function planSheet(src, id) {
  const dlg = $('#meal');
  const find = () => (src === 'meal' ? P().meals : P().saved).find((x) => x.id === id);
  const close = () => { if (dlg.open) dlg.close(); };
  const setSize = (x, set) => {
    S.plan.do(src === 'saved' ? { t: 'editSaved', id, set } : { t: 'edit', id, set });
    relinkList(find());
  };
  const acts = {
    servings: (x, el) => setSize(x, { servings: Math.max(1, planServings(x) + Number(el.dataset.d)) }),
    mult: (x, el) => setSize(x, { x: Number(el.dataset.m) }),
    reset: (x) => setSize(x, { servings: null, x: null }),
    cooked: (x) => setCooked(x, !isCooked(x)),
    note: async (x) => {
      const r = await askLine({ title: 'Note', body: 'A short note, like "double the sauce" or "for Ana".', label: 'Note', value: x.note || '' });
      if (r) S.plan.do(src === 'saved' ? { t: 'editSaved', id, set: { note: r.text } } : { t: 'edit', id, set: { note: r.text } });
      planSheet(src, id);
    },
    rename: async (x) => {
      const r = await askLine({ title: 'Rename', label: 'Name', value: x.title });
      if (r) S.plan.do({ t: 'edit', id, set: { title: r.text } });
      planSheet(src, id);
    },
    also: (x, el) => toggleAlso(x, el.dataset.day),
    each: (x) => { for (const m of plan.batchOf(P(), x)) S.plan.do({ t: 'edit', id: m.id, set: { each: !x.each } }); },
    move: async (x) => {
      close();
      const to = await pickSlot({ title: `Move ${x.kind === 'recipe' ? planTitleOf(x) : x.title}`, day: x.day, meal: x.meal === 'notes' ? null : x.meal });
      if (to) S.plan.do({ t: 'move', id, day: to.day, meal: x.meal === 'notes' ? 'notes' : to.meal });
    },
    plan: async (x) => {
      close();
      const to = await pickSlot({ title: `Plan ${planTitleOf(x)}`, meal: 'dinner' });
      if (to) S.plan.do({ t: 'place', entries: [{ ...x, kind: 'recipe', day: to.day, meal: to.meal, fromSaved: x.id }] });
    },
    toSaved: (x) => { close(); relinkList(x, true); planUndo(`${planTitleOf(x)} is back in Saved.`, { t: 'toSaved', id }); },
    remove: (x) => { close(); removeEntry(src, x); },
  };
  const render = () => {
    const x = find();
    if (!x) { close(); return null; }
    const e = x.path ? S.recipes.get(x.path) : null;
    const isRecipe = src === 'saved' || x.kind === 'recipe';
    const base = e && baseServings(e);
    const title = isRecipe ? planTitleOf(x) : x.title;
    const where = src === 'saved' ? 'Saved' : `${dayName(x.day)}, ${dateText(x.day)}${x.meal === 'notes' ? '' : ` · ${plan.MEAL_NAMES[x.meal]}`}`;
    const kindText = { free: 'Meal without a recipe', item: 'To buy', note: 'Note' }[x.kind] || '';
    const row = (act, label, val = '') => `<button class="item-row" type="button" data-act="${act}"><span>${label}</span><span class="item-val">${val}${CHEVRON_ICON}</span></button>`;
    const sw = (act, on, label) => `<button class="item-row" type="button" role="switch" aria-checked="${on}" data-act="${act}"><span>${label}</span><span class="switch" aria-hidden="true"></span></button>`;
    const state = src === 'meal' ? planState(x) : '';
    const stateText = { list: 'On the shopping list', bought: 'Bought' }[state];
    const cooked = src === 'meal' && isCooked(x);
    const first = src === 'meal' && isRecipe ? plan.cookMeal(P(), x) : x;
    const out = [];
    if (isGone(x) && isRecipe) out.push(`<p class="pwarn">${WARN_ICON}This recipe was deleted.</p>`);
    if (src === 'meal' && isRecipe && x.day < plan.dayKey() && !cooked) out.push(`<p class="pwarn">${WARN_ICON}Not ticked as cooked on ${esc(dayWord(x.day))}. Move it, or tick Cooked.</p>`);
    if (isRecipe && e && !cooked) {
      const reset = ownSize(x) ? `<button class="link-btn preset" type="button" data-act="reset">Reset to ${base ? P().servings : '1×'}</button>` : '';
      out.push(base
        ? `<div class="item-row"><span>Servings${reset}</span><div class="scaler">
            <button class="step-btn" type="button" data-act="servings" data-d="-1" aria-label="Fewer servings" ${planServings(x) <= 1 ? 'disabled' : ''}>−</button>
            <output><b>${planServings(x)}</b></output>
            <button class="step-btn" type="button" data-act="servings" data-d="1" aria-label="More servings">+</button></div></div>`
        : `<div class="item-row"><span>Amount${reset}</span><div class="scaler">${[0.5, 1, 2, 3].map((m) => `<button class="mult" type="button" data-act="mult" data-m="${m}" aria-pressed="${(x.x || 1) === m}">${m === 0.5 ? '½' : m}×</button>`).join('')}</div></div>`);
    }
    if (src === 'meal' && x.kind === 'recipe') {
      const when = first !== x ? ` <small>with ${esc(dayWord(first.day))}</small>` : first.cooked && first.cooked !== first.day ? ` <small>${esc(dayName(first.cooked))}</small>` : '';
      out.push(sw('cooked', cooked, `Cooked${when}`));
      // Also eat on: more days with the same recipe, cooked once or each day.
      const all = plan.batchOf(P(), x);
      const onDays = new Set(all.map((m) => m.day));
      out.push(`<div class="palso"><span class="palso-h">Also eat on</span>
        <div class="pdaypick" role="group" aria-label="Also eat on">${alsoDays(x).map((d) => `<button type="button" class="pdaybtn" data-act="also" data-day="${d}" aria-pressed="${onDays.has(d)}"${d === x.day ? ' disabled' : ''}><small>${esc(weekday(d))}</small><b>${plan.toDate(d).getDate()}</b></button>`).join('')}</div></div>`);
      if (all.length > 1) {
        const total = batchSize(x);
        const w = dayWord(all[0].day);
        out.push(sw('each', !x.each, `Cook once, ${['today', 'tomorrow', 'yesterday'].includes(w) ? w : `on ${esc(w)}`} <small>${x.each ? 'Off: each day is cooked on its own.' : `Cook mode makes ${base ? total.servings : `${total.x}×`} for ${all.length} days.`}</small>`));
      }
    }
    if (isRecipe) out.push(row('note', 'Note', esc(x.note || 'Add')));
    if (src === 'meal' && x.kind === 'recipe') out.push(row('move', 'Move'), row('toSaved', 'Back to Saved'));
    else if (src === 'meal') out.push(...(x.kind === 'free' || x.kind === 'item' || x.kind === 'note' ? [row('rename', 'Rename')] : []), row('move', 'Move'));
    else out.push(row('plan', 'Plan for a day'));
    const cook = isRecipe && e && !cooked && !isGone(x) && first === x ? `<a class="btn btn-primary pcook-btn" href="${cookHref(x)}">${CHEF_ICON}Cook</a>` : '';
    dlg.classList.toggle('is-wide', wideBrowse.matches);
    dlg.setAttribute('aria-label', title);
    dlg.innerHTML = `
      <div class="sheet-grab" aria-hidden="true"></div>
      <button class="sheet-x item-x" type="button" data-close aria-label="Close">${CLOSE_ICON}</button>
      <h2>${e ? `<a href="#/r/${encPath(x.path)}">${esc(title)}</a>` : esc(title)}</h2>
      <p class="psheet-where">${esc([where, kindText, stateText].filter(Boolean).join(' · '))}</p>
      ${out.join('')}
      ${cook}
      <button class="btn item-remove" type="button" data-act="remove">${TRASH_ICON}Remove</button>`;
    $('[data-close]', dlg).onclick = close;
    $$('a', dlg).forEach((a) => { a.addEventListener('click', close); });
    $$('[data-act]', dlg).forEach((el) => { el.onclick = () => { const cur = find(); if (cur) acts[el.dataset.act](cur, el); if (dlg.open) render(); }; });
    return x;
  };
  dlg.onclick = (ev) => { if (ev.target === dlg) close(); };
  if (render() && !dlg.open) dlg.showModal();
}

// ---- small pickers

const mealSeg = (on, { notes = false } = {}) => `<div class="seg pmeals" role="group" aria-label="Meal">${[...plan.MEALS, ...(notes ? ['notes'] : [])].map((m) => `<button type="button" data-meal="${m}" aria-pressed="${m === on}">${plan.MEAL_NAMES[m]}</button>`).join('')}</div>`;
function wireSeg(dlg, sel, onPick) {
  $$(sel, dlg).forEach((b) => {
    b.onclick = () => { $$(sel, dlg).forEach((x) => x.setAttribute('aria-pressed', String(x === b))); onPick(b); };
  });
}

/** The days you can pick: the plan's days, and at least the next 10. */
function pickableDays(after = null) {
  const t = plan.dayKey();
  const set = new Set(plan.upcoming(P(), t));
  for (let i = 0; i < 10; i++) set.add(plan.addDays(t, i));
  return [...set].sort().filter((d) => !after || d >= after);
}
const dayBtn = (d, on, attr = 'data-day') => `<button type="button" class="pdaybtn" ${attr}="${d}" aria-pressed="${on}"><small>${esc(weekday(d))}</small><b>${plan.toDate(d).getDate()}</b></button>`;

/** Asks for a day and a meal. Resolves with { day, meal } or null. */
function pickSlot({ title, body = '', day = null, meal = 'dinner', after = null }) {
  const dlg = $('#modal');
  const days = pickableDays(after);
  let d = days.includes(day) ? day : days[0];
  let m = meal;
  dlg.innerHTML = `<form method="dialog" class="pick-slot">
    <h2>${esc(title)}</h2>${body ? `<p>${esc(body)}</p>` : ''}
    <div class="pdaypick" role="group" aria-label="Day">${days.map((x) => dayBtn(x, x === d)).join('')}</div>
    ${meal ? mealSeg(m) : ''}
    <div class="modal-actions"><button value="cancel" class="btn btn-quiet">Cancel</button><button value="ok" class="btn btn-primary">Save</button></div>
  </form>`;
  const dayBtns = '.pdaypick .pdaybtn';
  wireSeg(dlg, dayBtns, (b) => { d = b.dataset.day; });
  wireSeg(dlg, '.pmeals button', (b) => { m = b.dataset.meal; });
  $(`.pdaypick [aria-pressed="true"]`, dlg)?.scrollIntoView({ block: 'nearest', inline: 'center' });
  return new Promise((resolve) => {
    dlg.onclose = () => {
      resolve(dlg.returnValue === 'ok' ? { day: d, meal: m } : null);
      dlg.returnValue = '';
    };
    dlg.showModal();
  });
}

/** Asks for a line of text, with a meal when `meal` is given. Resolves with { text, meal } or null. */
function askLine({ title, body = '', label, placeholder = '', value = '', meal = null }) {
  const dlg = $('#modal');
  let m = meal;
  dlg.innerHTML = `<form method="dialog">
    <h2>${esc(title)}</h2>${body ? `<p>${esc(body)}</p>` : ''}
    <label class="field modal-field"><span>${esc(label)}</span>
      <input id="ask-line" type="text" placeholder="${esc(placeholder)}" value="${esc(value)}" autocomplete="off" enterkeyhint="done">
    </label>
    ${meal ? mealSeg(m) : ''}
    <div class="modal-actions"><button value="cancel" class="btn btn-quiet">Cancel</button><button value="ok" class="btn btn-primary">Save</button></div>
  </form>`;
  wireSeg(dlg, '.pmeals button', (b) => { m = b.dataset.meal; });
  return new Promise((resolve) => {
    dlg.onclose = () => {
      const v = $('#ask-line', dlg).value.trim();
      resolve(dlg.returnValue === 'ok' ? { text: v, meal: m } : null);
      dlg.returnValue = '';
    };
    dlg.showModal();
    $('#ask-line', dlg).select();
  });
}

/** The + on a day: a recipe, an ingredient, a meal without a recipe, or a note. */
function openAdd(anchor, day, meal = null) {
  const dlg = $('#choose');
  const pop = wideBrowse.matches;
  const opt = (pick, icon, title, sub) => `<button class="choose-opt" type="button" data-pick="${pick}">${icon}<span><b>${title}</b><small>${sub}</small></span></button>`;
  dlg.setAttribute('aria-label', `Add to ${dayName(day)}`);
  dlg.classList.toggle('is-pop', pop);
  dlg.innerHTML = `<div class="choose-in">
    ${pop ? '' : `<div class="sheet-grab" aria-hidden="true"></div>
    <div class="choose-head"><div><b>Add to ${esc(dayName(day))}</b><small>${esc(dateText(day))}${meal ? `, ${plan.MEAL_NAMES[meal].toLowerCase()}` : ''}</small></div>
      <button class="sheet-x" data-close aria-label="Close">${CLOSE_ICON}</button></div>`}
    ${meal === 'notes' ? '' : opt('recipe', CHEF_ICON, 'Recipe', 'From Saved or all your recipes.')}
    ${meal === 'notes' ? '' : opt('item', BASKET_ICON, 'Ingredient', 'Something to buy, like bread.')}
    ${meal === 'notes' ? '' : opt('free', SALAD_ICON, 'Meal without a recipe', 'Eating out, or pizza from the freezer.')}
    ${opt('note', NOTE_ICON, 'Note', 'Anything for the day.')}
  </div>`;
  const x = $('[data-close]', dlg);
  if (x) x.onclick = () => dlg.close();
  dlg.onclick = (ev) => { if (ev.target === dlg) dlg.close(); };
  $$('[data-pick]', dlg).forEach((b) => {
    b.onclick = async () => {
      dlg.close();
      const kind = b.dataset.pick;
      const m = meal && meal !== 'notes' ? meal : 'dinner';
      if (kind === 'recipe') { pickRecipe(day, m); return; }
      if (kind === 'note') {
        const r = await askLine({ title: `Note for ${dayName(day)}`, label: 'Note', placeholder: 'Ana comes for dinner' });
        if (r?.text) S.plan.do({ t: 'place', entries: [{ id: shop.newId(), kind: 'note', title: r.text, day, meal: 'notes' }] });
        return;
      }
      if (kind === 'item') {
        const r = await askLine({ title: 'Add an ingredient', body: 'It goes on the shopping list with the rest of the day.', label: 'Ingredient', placeholder: 'Bread, or 2 kg potatoes', meal: m });
        const it = r?.text ? shop.parseItem(r.text) : null;
        if (it?.name) S.plan.do({ t: 'place', entries: [{ id: shop.newId(), kind: 'item', title: it.name, n: it.n ?? null, unit: it.unit || '', day, meal: r.meal }] });
        return;
      }
      const r = await askLine({ title: 'Meal without a recipe', label: 'What is it?', placeholder: 'Eating out', meal: m });
      if (r?.text) S.plan.do({ t: 'place', entries: [{ id: shop.newId(), kind: 'free', title: r.text, day, meal: r.meal }] });
    };
  });
  dlg.style.left = dlg.style.top = '';
  dlg.showModal();
  if (pop) {
    const r = anchor.getBoundingClientRect();
    const w = dlg.offsetWidth, h = dlg.offsetHeight;
    dlg.style.left = `${Math.max(16, Math.min(r.left, innerWidth - w - 16))}px`;
    dlg.style.top = `${r.bottom + 8 + h > innerHeight - 8 ? Math.max(8, r.top - 8 - h) : r.bottom + 8}px`;
  }
}

/** A recipe for a day: Saved first, then a search through all recipes. */
function pickRecipe(day, meal) {
  const dlg = $('#planpick');
  let m = meal;
  let q = '';
  dlg.innerHTML = `
    <div class="sheet-grab" aria-hidden="true"></div>
    <div class="sheet-head"><h2>${esc(dayName(day))}, ${esc(dateText(day))}</h2>
      <button class="sheet-x" type="button" data-close aria-label="Close">${CLOSE_ICON}</button></div>
    <div class="ppick-top">
      <label class="search"><span class="sr">Search</span>
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>
        <input id="ppick-q" type="search" placeholder="Search recipes" autocomplete="off"></label>
      ${mealSeg(m)}
    </div>
    <div class="sheet-body" id="ppick-list"></div>`;
  const draw = () => {
    const f = fold(q);
    const savedNow = P().saved.filter((s) => !f || fold(planTitleOf(s)).includes(f));
    const all = [...S.recipes.values()].filter((e) => !f || e.search.includes(f)).sort((a, b) => collator.compare(a.title, b.title)).slice(0, 60);
    const row = (e, attrs, sub) => `<button class="ppick-row" type="button" ${attrs}>${planThumb({ path: e.path, title: e.title })}<span><b>${esc(e.title)}</b><small>${esc(sub)}</small></span></button>`;
    $('#ppick-list', dlg).innerHTML = `
      ${savedNow.length ? `<h3 class="ppick-h">Saved</h3>${savedNow.map((s) => row({ path: s.path, title: planTitleOf(s) }, `data-saved="${esc(s.id)}"`, planSize(s))).join('')}` : ''}
      <h3 class="ppick-h">${f ? 'Recipes' : 'All recipes'}</h3>
      ${all.length ? all.map((e) => row(e, `data-path="${esc(e.path)}"`, folderLabel(e.folder))).join('') : '<p class="muted">No recipes match.</p>'}`;
    $$('[data-saved]', dlg).forEach((b) => { b.onclick = () => { dropOn({ dataset: { drop: 'slot', day, meal: m } }, { src: 'saved', id: b.dataset.saved }, false); dlg.close(); }; });
    $$('[data-path]', dlg).forEach((b) => { b.onclick = () => { placeRecipe(b.dataset.path, day, m); dlg.close(); }; });
  };
  $('[data-close]', dlg).onclick = () => dlg.close();
  dlg.onclick = (ev) => { if (ev.target === dlg) dlg.close(); };
  $('#ppick-q', dlg).addEventListener('input', debounce((ev) => { q = ev.target.value; draw(); }, 100));
  wireSeg(dlg, '.pmeals button', (b) => { m = b.dataset.meal; });
  draw();
  dlg.showModal();
}

/** Holding a recipe card on a phone: tap where it goes. */
function dropSheet(path) {
  const e = S.recipes.get(path);
  if (!e) return;
  const dlg = $('#choose');
  dlg.classList.remove('is-pop');
  dlg.setAttribute('aria-label', `Plan ${e.title}`);
  const days = plan.upcoming(P());
  dlg.innerHTML = `<div class="choose-in">
    <div class="sheet-grab" aria-hidden="true"></div>
    <div class="choose-head"><div><b>${esc(e.title)}</b><small>Tap where it goes.</small></div>
      <button class="sheet-x" data-close aria-label="Close">${CLOSE_ICON}</button></div>
    <button class="choose-opt is-main" type="button" data-to="saved">${BOOKMARK_ICON}<span><b>Saved</b><small>To make some time. Pick a day later.</small></span></button>
    <div class="pdrop-days">${days.map((d) => `<div class="pdrop-day"><span><b>${esc(dayName(d))}</b><small>${esc(dateText(d))}</small></span>
      <div class="pdrop-meals">${plan.MEALS.map((m) => `<button type="button" data-day="${d}" data-meal="${m}" title="${plan.MEAL_NAMES[m]}" aria-label="${esc(`${dayName(d)}, ${plan.MEAL_NAMES[m]}`)}">${MEAL_ICONS[m]}</button>`).join('')}</div></div>`).join('')}</div>
  </div>`;
  $('[data-close]', dlg).onclick = () => dlg.close();
  dlg.onclick = (ev) => { if (ev.target === dlg) dlg.close(); };
  $$('[data-to]', dlg).forEach((b) => { b.onclick = () => { dlg.close(); saveRecipe(path); }; });
  $$('[data-meal]', dlg).forEach((b) => {
    b.onclick = () => {
      dlg.close();
      planUndo(`${e.title} is on ${dayWord(b.dataset.day)}, ${plan.MEAL_NAMES[b.dataset.meal].toLowerCase()}.`,
        { t: 'place', entries: [{ id: shop.newId(), kind: 'recipe', path, title: e.title, day: b.dataset.day, meal: b.dataset.meal }] });
    };
  });
  dlg.style.left = dlg.style.top = '';
  dlg.showModal();
}

// ---- shopping for the plan

/**
 * The check before the shopping list: pick the days (tap the first, then
 * the last), untick what you have. Cooked, bought and already listed meals,
 * meals without a recipe and Saved add nothing.
 */
function openPlanShop() {
  if (!S.shop) return;
  const dlg = $('#planpick');
  const t = plan.dayKey();
  const days = plan.upcoming(P(), t);
  const st = { from: t, to: plan.addDays(t, 2), next: 'from', off: new Set() };
  const candidates = () => {
    const p = P();
    return p.meals.filter((m) => m.day >= st.from && m.day <= st.to && plan.shops(p, m)).sort(byDayMeal).map((m) => ({ x: m, src: 'meal' }));
  };
  // Can go on the list: not there yet, not bought, not deleted.
  const can = (x) => !planState(x) && !(x.kind === 'recipe' && !S.recipes.has(x.path));
  const draw = () => {
    // The same recipe on more days is one row, with its days below it.
    const groups = new Map();
    for (const { x } of candidates()) {
      const k = x.kind === 'item' ? `item:${fold(x.title)}` : x.path;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(x);
    }
    let skipped = 0;
    let n = 0;
    const html = [...groups.values()].map((xs) => {
      const x = xs[0];
      const open = xs.filter(can);
      skipped += xs.length - open.length;
      const on = open.filter((m) => !st.off.has(m.id));
      if (on.length) n++;
      const title = x.kind === 'item' ? x.title : planTitleOf(x);
      const size = (m) => (m.kind === 'item' ? (m.n != null ? fmtAmount(m.n, m.unit || '') : '') : planBubble(m));
      const total = x.kind === 'recipe' && on.length > 1 ? (baseServings(S.recipes.get(x.path) || {}) ? servingsText(on.reduce((t, m) => t + planServings(m), 0)) : `${on.reduce((t, m) => t + (m.x || 1), 0)}×`) : '';
      const days = xs.map((m) => {
        const state = planState(m);
        const why = state === 'list' ? 'on the list' : state === 'bought' ? 'bought' : !can(m) ? 'deleted' : '';
        return `<li${why ? ' class="is-off"' : ''}><span>${esc(weekday(m.day))} ${esc(plan.MEAL_NAMES[m.meal].toLowerCase())}</span><b>${esc(size(m))}</b>${why ? `<small>${why}</small>` : ''}</li>`;
      }).join('');
      return `<li><label class="pshop-row${open.length ? '' : ' is-off'}">
        <input type="checkbox" class="tick" data-ids="${esc(open.map((m) => m.id).join(' '))}" ${on.length ? 'checked' : ''} ${open.length ? '' : 'disabled'}>
        ${planThumb(x)}<span><b>${esc(title)}</b>${total ? `<small>${esc(total)} together</small>` : ''}<ul class="pshop-when">${days}</ul></span></label></li>`;
    });
    const range = st.from === st.to ? dateText(st.from) : `${dateText(st.from)} to ${dateText(st.to)}`;
    dlg.innerHTML = `
      <div class="sheet-grab" aria-hidden="true"></div>
      <div class="sheet-head"><h2>Add to shopping list</h2>
        <button class="sheet-x" type="button" data-close aria-label="Close">${CLOSE_ICON}</button></div>
      <div class="pshop-top">
        <p class="muted">${st.next === 'to' ? 'Now tap the last day.' : 'Tap the first and the last day.'} <b>${esc(range)}</b></p>
        <div class="pdaypick pshop-days" role="group" aria-label="Days">${days.map((d) => `<button type="button" class="pdaybtn${d >= st.from && d <= st.to ? ' is-in' : ''}" data-day="${d}" aria-pressed="${d === st.from || d === st.to}"><small>${esc(weekday(d))}</small><b>${plan.toDate(d).getDate()}</b></button>`).join('')}</div>
        <div class="pquick">
          <button type="button" class="opt" data-range="3" aria-pressed="${st.from === t && st.to === plan.addDays(t, 2)}">Next 3 days</button>
          <button type="button" class="opt" data-range="all" aria-pressed="${st.from === t && st.to === days[days.length - 1]}">Whole plan</button>
        </div>
      </div>
      <div class="sheet-body">${html.length ? `<ul class="pshop-list">${html.join('')}</ul>` : '<p class="muted pshop-none">Nothing to buy for these days.</p>'}
        ${skipped ? `<p class="muted pshop-skip">${skipped} ${skipped === 1 ? 'meal is' : 'meals are'} already on the list, bought or deleted.</p>` : ''}
        <p class="muted pshop-skip">Cooked meals, meals without a recipe and Saved add nothing.</p></div>
      <div class="sheet-foot"><button class="link-btn" type="button" data-close>Cancel</button>
        <button class="btn btn-primary" type="button" id="pshop-go" ${n ? '' : 'disabled'}>Add ${n || ''} to shopping list</button></div>`;
    $$('[data-close]', dlg).forEach((b) => { b.onclick = () => dlg.close(); });
    $$('.pshop-days .pdaybtn', dlg).forEach((b) => {
      b.onclick = () => {
        const d = b.dataset.day;
        if (st.next === 'from' || d < st.from) { st.from = d; st.to = d; st.next = 'to'; }
        else { st.to = d; st.next = 'from'; }
        draw();
      };
    });
    $$('[data-range]', dlg).forEach((b) => {
      b.onclick = () => {
        const r = b.dataset.range;
        st.from = t;
        st.to = r === '3' ? plan.addDays(t, 2) : days[days.length - 1];
        st.next = 'from';
        draw();
      };
    });
    $$('.pshop-list .tick', dlg).forEach((b) => {
      b.onchange = () => { for (const id of b.dataset.ids.split(' ')) b.checked ? st.off.delete(id) : st.off.add(id); draw(); };
    });
    $('#pshop-go', dlg).onclick = () => {
      const picked = candidates().map(({ x }) => x).filter((x) => can(x) && !st.off.has(x.id));
      const before = S.shop.list;
      addPlanToList(picked);
      dlg.close();
      toast(`Added ${n} to your shopping list.`, { label: 'Undo', run: () => S.shop.do({ t: 'restore', list: before }) });
    };
  };
  dlg.onclick = (ev) => { if (ev.target === dlg) dlg.close(); };
  draw();
  dlg.showModal();
}

// ---- dragging: recipe cards and chips onto Saved and the meals of a day,
// or into the bin that shows at the bottom while a chip is dragged

let drag = null;
const cardPath = (a) => a.getAttribute('href').replace(/^#\/r\//, '').split('/').map(decodeURIComponent).join('/');
const clearOver = () => $$('.is-over').forEach((el) => el.classList.remove('is-over'));
// A finger dragging a chip (phones): the chip follows it, the page holds still.
const planTouch = { on: false };
let drawLater = false;

function startDrag(d, later = false) {
  drag = d;
  const show = () => {
    if (drag !== d) return;
    document.body.classList.add('is-dragging');
    document.body.classList.toggle('drag-chip', d.src !== 'recipe');
  };
  // The empty meals open when a drag starts. Chrome drops a mouse drag when
  // the page moves inside dragstart, so then they open a moment later.
  if (later) setTimeout(show, 0); else show();
}

// Over the plan, near the top or bottom of the window or of the side panel,
// it scrolls along with a dragged thing: faster the closer it gets. Over the
// recipes it stays put.
const EDGE = 140;
let edge = null;
function edgeScroll(x, y) {
  const at = document.elementFromPoint(x, y);
  if (!at?.closest('.side, #plan-root')) { edge = null; return; }
  const el = at.closest('.side');
  const box = el ? el.getBoundingClientRect() : { top: 0, bottom: innerHeight };
  const bottom = Math.min(box.bottom, innerHeight) - (document.body.classList.contains('has-tabbar') ? 70 : 0);
  const top = Math.max(box.top, 0);
  const speed = y < top + EDGE ? -Math.ceil(((top + EDGE - y) / EDGE) * 16) : y > bottom - EDGE ? Math.ceil(((y - bottom + EDGE) / EDGE) * 16) : 0;
  const was = edge;
  edge = speed ? { el, speed } : null;
  if (edge && !was) requestAnimationFrame(function step() {
    if (!edge || !drag) { edge = null; return; }
    (edge.el || window).scrollBy(0, edge.speed);
    requestAnimationFrame(step);
  });
}
function endDrag() {
  drag = null;
  document.body.classList.remove('is-dragging', 'drag-chip');
  clearOver();
  if (drawLater) { drawLater = false; drawPlan(); }
}
function markOver(t) {
  if (!t) { clearOver(); return; }
  if (!t.classList.contains('is-over')) { clearOver(); t.classList.add('is-over'); }
}

function initPlanDrag() {
  const bin = document.createElement('div');
  bin.className = 'pbin';
  bin.dataset.drop = 'trash';
  bin.innerHTML = `${TRASH_ICON}<span>Drop here to remove</span>`;
  document.body.append(bin);

  let lastPointer = 'mouse';
  document.addEventListener('pointerdown', (ev) => { lastPointer = ev.pointerType; }, true);
  document.addEventListener('dragstart', (ev) => {
    if (!canPlan() && !(S.shop && drive.wasSignedIn())) return;
    const el = ev.target.closest?.('.pchip[data-id], a.card');
    if (!el) return;
    // Fingers drag chips the hand-made way below.
    if (lastPointer !== 'mouse' && el.matches('.pchip')) { ev.preventDefault(); return; }
    startDrag(el.matches('a.card') ? { src: 'recipe', path: cardPath(el) } : { src: el.dataset.src, id: el.dataset.id }, true);
    ev.dataTransfer.effectAllowed = 'copyMove';
    if (drag.src !== 'recipe') ev.dataTransfer.setData('text/plain', el.textContent.trim());
  });
  document.addEventListener('dragend', endDrag);
  // Entering a target has to be accepted too, or the drop may not come.
  document.addEventListener('dragenter', (ev) => {
    const t = drag && ev.target.closest?.('[data-drop]');
    if (t && !(t.dataset.drop === 'trash' && drag.src === 'recipe')) ev.preventDefault();
  });
  document.addEventListener('dragover', (ev) => {
    if (!drag) return;
    edgeScroll(ev.clientX, ev.clientY);
    const t = ev.target.closest?.('[data-drop]');
    if (!t || (t.dataset.drop === 'trash' && drag.src === 'recipe')) { clearOver(); return; }
    ev.preventDefault();
    ev.dataTransfer.dropEffect = t.dataset.drop === 'trash' ? 'move' : drag.src === 'recipe' || ev.altKey ? 'copy' : 'move';
    markOver(t);
    // Over the closed rail, the plan opens so the drop can go on into a day.
    if (t.dataset.drop === 'rail') showSideTab('plan');
  });
  document.addEventListener('drop', (ev) => {
    if (!drag) return;
    const t = ev.target.closest?.('[data-drop]');
    if (!t) return;
    ev.preventDefault();
    const d = drag;
    endDrag();
    dropOn(t, d, ev.altKey);
  });

  // Fingers: hold a recipe card to pick where it goes, hold a chip to drag it.
  let press = null;
  let ghost = null;
  const targetAt = (x, y) => {
    const t = document.elementFromPoint(x, y)?.closest('[data-drop]');
    return t && t.dataset.drop !== 'rail' ? t : null;
  };

  const lift = (p) => {
    const r = p.el.getBoundingClientRect();
    ghost = p.el.cloneNode(true);
    ghost.classList.add('pghost-chip');
    ghost.style.width = `${r.width}px`;
    p.dx = p.x - r.left; p.dy = p.y - r.top;
    ghost.style.transform = `translate(${r.left}px, ${r.top}px)`;
    document.body.append(ghost);
    p.el.classList.add('is-lifted');
    planTouch.on = true;
    startDrag({ src: p.el.dataset.src, id: p.el.dataset.id });
  };
  const drop = (cancel) => {
    const p = press;
    press = null;
    clearTimeout(p?.timer);
    if (!planTouch.on) return;
    planTouch.on = false;
    edge = null;
    ghost?.remove();
    ghost = null;
    p.el.classList.remove('is-lifted');
    const t = cancel ? null : targetAt(p.lx, p.ly);
    const d = drag;
    endDrag();
    if (t) dropOn(t, d, false);
  };
  document.addEventListener('pointerdown', (ev) => {
    if (ev.pointerType === 'mouse' || !canPlan()) return;
    const card = ev.target.closest('.grid a.card');
    const chip = ev.target.closest('.pchip[data-id]');
    if (!card && !chip) return;
    press = { el: chip || card, chip: Boolean(chip), x: ev.clientX, y: ev.clientY, lx: ev.clientX, ly: ev.clientY, fired: false };
    press.timer = setTimeout(() => {
      press.fired = true;
      navigator.vibrate?.(12);
      if (press.chip) lift(press);
      else dropSheet(cardPath(press.el));
    }, press.chip ? 380 : 480);
  });
  document.addEventListener('pointermove', (ev) => {
    if (!press) return;
    if (!press.fired) {
      if (Math.hypot(ev.clientX - press.x, ev.clientY - press.y) > 10) { clearTimeout(press.timer); press = null; }
      return;
    }
    if (!planTouch.on) return;
    press.lx = ev.clientX; press.ly = ev.clientY;
    ghost.style.transform = `translate(${ev.clientX - press.dx}px, ${ev.clientY - press.dy}px)`;
    const t = targetAt(ev.clientX, ev.clientY);
    markOver(t);
    // Near the top or bottom the page scrolls along, but not over the bin.
    if (t?.dataset.drop === 'trash') edge = null; else edgeScroll(ev.clientX, ev.clientY);
  });
  // While a chip is held, the page must not scroll under the finger.
  document.addEventListener('touchmove', (ev) => { if (planTouch.on) ev.preventDefault(); }, { passive: false });
  document.addEventListener('pointerup', () => {
    if (!press) return;
    if (planTouch.on) { press.done = true; const el = press.el; drop(false); swallow = el; return; }
    if (!press.fired) { clearTimeout(press.timer); press = null; }
  });
  document.addEventListener('pointercancel', () => { if (planTouch.on) drop(true); else if (press) { clearTimeout(press.timer); press = null; } });
  // The click after a hold does not open the card or the recipe.
  let swallow = null;
  document.addEventListener('click', (ev) => {
    if ((press?.fired && press.el.contains(ev.target)) || (swallow && swallow.contains(ev.target))) { ev.preventDefault(); ev.stopPropagation(); }
    press = null;
    swallow = null;
  }, true);
  document.addEventListener('contextmenu', (ev) => { if (canPlan() && ev.target.closest?.('.grid a.card, .pchip') && (press || planTouch.on)) ev.preventDefault(); });
}

async function showPlanPage() {
  document.body.dataset.view = 'plan';
  document.title = `Plan | ${S.config.title || 'Recipes'}`;
  if (!canPlan()) {
    $('#main').innerHTML = `<div class="empty"><h1>Sign in to plan meals</h1><p>The plan is saved in Google Drive, so it is the same on your phone and your computer.</p>${S.plan ? '<button class="btn btn-primary" id="signin2">Sign in with Google</button>' : ''}</div>`;
    const b = $('#signin2'); if (b) b.onclick = () => signInFlow();
    return;
  }
  await initParser();
  S.parserReady = true;
  if (parseHash().path !== '/plan') return;
  mountPlan($('#main'), wide.matches ? 'week' : 'page');
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
  saved.set('sideTab', 'list');
  go(S.lastPage || '#/');
}
const wide = window.matchMedia('(min-width: 1100px)');

function sideMode() {
  if (!wide.matches || !S.shop || !drive.wasSignedIn()) return 'off';
  const { path } = parseHash();
  if (path === '/list' || path === '/plan' || path.startsWith('/cook/')) return 'off';
  if (path === '/new' || path.startsWith('/edit/')) return 'rail';
  return saved.get('sidePanel', 'closed') === 'open' ? 'open' : 'rail';
}

function setSide(state) {
  saved.set('sidePanel', state);
  renderSide();
}

// The open panel shows the plan or the shopping list.
const sideTab = () => (saved.get('sideTab', 'list') === 'plan' && canPlan() ? 'plan' : 'list');
function showSideTab(tab) {
  if (sideTab() === tab && sideMode() === 'open') return;
  saved.set('sideTab', tab);
  saved.set('sidePanel', 'open');
  renderSide();
}

function renderSide() {
  const el = $('#side');
  const mode = sideMode();
  document.body.classList.toggle('has-side', mode !== 'off');
  document.body.classList.toggle('side-open', mode === 'open');
  el.hidden = mode === 'off';
  el.setAttribute('aria-label', mode === 'open' && sideTab() === 'plan' ? 'Plan' : canPlan() ? 'Plan and shopping list' : 'Shopping list');
  if (mode === 'open') {
    const tab = sideTab();
    const there = tab === 'plan' ? $('#plan-root', el) : $('.shop-panel', el);
    if (!there) { if (tab === 'plan') mountPlan(el, 'panel'); else mountList(el, true); }
    else if (!listPoll) startListPolling(); // a page change stopped it
    return;
  }
  if ($('.shop-panel', el) || $('#plan-root', el)) stopListPolling();
  if (mode === 'off') { el.innerHTML = ''; return; }
  const n = toBuyCount();
  el.innerHTML = `<div class="rail">
    <button class="rail-top" id="rail-open" type="button" title="Open the panel" aria-label="Open the panel">${PANEL_ICON}</button>
    ${canPlan() ? `<button class="rail-btn" id="rail-plan" type="button" data-drop="rail" title="Plan (P)" aria-label="Open the plan">${CAL_ICON}<span class="rail-label">Plan</span></button>` : ''}
    <button class="rail-btn" id="rail" type="button" data-drop="list" title="Shopping list (L)" aria-label="Open the shopping list${n ? `, ${n} to buy` : ''}">
      ${BASKET_ICON}${n ? `<span class="badge">${n}</span>` : ''}<span class="rail-label">Shopping list</span>
    </button></div>`;
  $('#rail').onclick = () => showSideTab('list');
  // The toggle on top opens the panel as it was last: the plan or the list.
  $('#rail-open').onclick = () => showSideTab(sideTab());
  const rp = $('#rail-plan');
  if (rp) rp.onclick = () => showSideTab('plan');
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
  const tab = (href, icon, label, on, extra = '', cls = '') => `<a class="tab${cls}" ${href.startsWith('#') ? `href="${href}"` : href}${on ? ' aria-current="page"' : ''}>${icon}<span>${label}</span>${extra}</a>`;
  el.innerHTML = [
    tab('#/', CHEF_ICON, 'Recipes', path !== '/list' && path !== '/plan'),
    tab('#/plan', CAL_ICON, 'Plan', path === '/plan'),
    tab('#/list', BASKET_ICON, 'List', path === '/list', n ? `<span class="badge" aria-label="${n} to buy">${n}</span>` : ''),
    tab(claudeLink(), PLUS_ICON, 'New', false),
  ].join('');
}

function initSide() {
  wide.addEventListener('change', () => { renderSide(); renderTabbar(); if (parseHash().path === '/plan') showPlanPage(); });
  // L for the list and P for the plan: open it, switch to it, or close it.
  document.addEventListener('keydown', (ev) => {
    const k = ev.key.toLowerCase();
    if ((k !== 'l' && k !== 'p') || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.target.closest('input, textarea, select, [contenteditable]') || $$('dialog[open]').length) return;
    const want = k === 'p' ? 'plan' : 'list';
    if (want === 'plan' && !canPlan()) return;
    const path = parseHash().path;
    if (wide.matches && path === '/list' && $('#to-side')) { ev.preventDefault(); if (want === 'list') listToSide(); else go('#/plan'); return; }
    if (wide.matches && path === '/plan') { ev.preventDefault(); if (want === 'plan') $('[data-act="to-side"]')?.click(); else go('#/list'); return; }
    if (sideMode() === 'off') return;
    ev.preventDefault();
    if (sideMode() === 'open' && sideTab() === want) setSide('closed');
    else showSideTab(want);
  });
}

const RENEW_SOON = 10 * 60_000;

function shopStatus(s = S.shop) {
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

// A ticked item first shows the tick, then slides away and lands at the
// bottom (In the basket, or the end of its recipe), so you see where it went.
const TICK_MS = 550;
const ticking = new Map(); // key -> { on, start } while a row plays its way out
const landed = new Map(); // key -> start of the highlight where it lands

function tickItem(key, on) {
  tickSound(on);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    S.shop.do({ t: 'check', key, on });
    return;
  }
  ticking.set(key, { on, start: Date.now() });
  updateList();
  setTimeout(() => {
    if (ticking.get(key)?.on !== on) return; // ticked again since
    ticking.delete(key);
    landed.set(key, Date.now());
    S.shop.do({ t: 'check', key, on });
  }, TICK_MS);
}

function shopRow(g, { total = g.total, recipeId = '', item = '', note = '' } = {}) {
  const qty = amount(total);
  const f = S.flash;
  const isNew = f && Date.now() < f.until && f.keys.has(g.key) && (!recipeId || recipeId === f.recipeId) && !item;
  const tk = ticking.get(g.key);
  const checked = tk ? tk.on : g.checked;
  const land = !tk && landed.get(g.key);
  if (land && Date.now() - land > 1200) landed.delete(g.key);
  // A redraw (after saving to Drive) picks an animation up where it was, so it plays once.
  const since = tk ? tk.start : isNew ? f.start : land || 0;
  const cls = tk ? ' is-leaving' : isNew ? ' is-new' : landed.has(g.key) ? ' is-landed' : '';
  const delay = cls ? ` style="animation-delay:-${Date.now() - since}ms"` : '';
  return `<li class="shop-row${checked ? ' is-checked' : ''}${toBuy(g) ? '' : ' is-have'}${cls}"${delay} data-key="${esc(g.key)}" data-recipe="${esc(recipeId)}" data-item="${esc(item)}">
    <label class="shop-main">
      <input type="checkbox" class="tick" ${checked ? 'checked' : ''}>
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

// Recipes folded away in the list by recipe, per device.
const listFolded = new Set(saved.get('listFolded', []));

function recipeView(b) {
  // Ticked lines go to the end of their recipe, as In the basket does by aisle.
  const lastIfChecked = (list) => [...list.filter((l) => !l.group.checked), ...list.filter((l) => l.group.checked)];
  const out = b.recipes.map((r) => {
    const q = r.servings ? `?s=${r.servings}` : r.factor && r.factor !== 1 ? `?x=${r.factor}` : '';
    const size = r.servings ? servingsText(r.servings) : r.factor && r.factor !== 1 ? `${r.factor}×` : '';
    const only = r.parts && !r.missing ? `<p class="shop-parts">${esc(cap(partsText(r.parts)))}</p>` : '';
    const title = r.missing ? esc(r.title || prettifyFile(r.path.split('/').pop())) : `<a href="#/r/${encPath(r.path)}${q}">${esc(r.title)}</a>`;
    const rows = lastIfChecked(r.lines).map((l) => shopRow(l.group, {
      total: l.total, recipeId: r.id,
      note: [toBuy(l.group) ? '' : 'probably have', l.optional ? 'optional' : ''].filter(Boolean).join(', '),
    }));
    const folded = listFolded.has(r.path);
    const left = r.lines.filter((l) => toBuy(l.group) && !l.group.checked).length;
    return `<section class="shop-recipe${folded ? ' is-folded' : ''}">
      <div class="shop-recipe-head"><button class="pday-fold" type="button" data-fold-recipe="${esc(r.path)}" aria-expanded="${!folded}" title="${folded ? 'Show' : 'Hide'} its ingredients">${CHEVRON_ICON}</button>
        <h2>${title}</h2><span>${esc([size, folded && left ? `${left} to buy` : ''].filter(Boolean).join(' · '))}</span><button class="link-btn" data-remove-recipe="${esc(r.id)}">Remove</button></div>
      ${only}${r.missing ? '<p class="muted">This recipe is no longer in your collection.</p>'
        : rows.length ? `<ul class="shop-list">${rows.join('')}</ul>` : '<p class="muted">Nothing left to buy.</p>'}
    </section>`;
  });
  if (b.manual.length) {
    out.push(`<section class="shop-recipe"><div class="shop-recipe-head"><h2>Added by you</h2></div>
      <ul class="shop-list">${lastIfChecked(b.manual).map((it) => shopRow(it.group, { total: it.total, item: it.id })).join('')}</ul></section>`);
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
  const itemIds = b.manual.filter((it) => keys.has(it.key)).map((it) => it.id);
  // Recipes with nothing left to buy drop off the list.
  const drop = b.recipes.filter((r) => !r.missing && r.lines.every((l) => keys.has(l.key) || !toBuy(l.group)));
  // The plan remembers they were bought.
  const bought = [...itemIds, ...drop.flatMap((r) => r.planIds || [])];
  if (bought.length && canPlan()) S.plan.do({ t: 'bought', ids: bought });
  undoable(`Cleared ${keys.size} checked ${keys.size === 1 ? 'item' : 'items'}.`, { t: 'removeKeys', keys: [...keys], itemIds, dropRecipes: drop.map((r) => r.id) });
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
      ...g.sources.map((src) => {
        const r = b.recipes.find((x) => x.id === src.recipeId);
        const e = r && S.recipes.get(r.path);
        if (!e) return `<li><b>${esc(amount(src.total))}</b><span>${esc(src.title)}</span></li>`;
        const q = r.servings ? `s=${r.servings}` : r.factor && r.factor !== 1 ? `x=${r.factor}` : '';
        const steps = stepsUsing(e.src, g.key).map((n) => `<a class="item-step" href="#/cook/${encPath(r.path)}?${q ? q + '&' : ''}step=${n}">Step ${n}</a>`);
        return `<li><b>${esc(amount(src.total))}</b><span><a href="#/r/${encPath(r.path)}${q ? '?' + q : ''}">${esc(src.title)}</a>${steps.length ? `<span class="item-steps">${steps.join('')}</span>` : ''}</span></li>`;
      }),
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
    $$('a', dlg).forEach((a) => { a.onclick = () => dlg.close(); });
    $$('[data-act]', dlg).forEach((el) => { el.onclick = () => acts[el.dataset.act](g, recipe, el); });
    return g;
  };
  dlg.onclick = (ev) => { if (ev.target === dlg) dlg.close(); };
  if (render()) dlg.showModal();
}

/** The method steps that use the list line `key`, numbered as in cook mode. */
function stepsUsing(src, key) {
  const { recipe } = parseRecipe(src, 1);
  if (!recipe) return [];
  const aisle = shopCtx().aisle;
  // The same keys the shopping list gives each ingredient.
  const keyOf = (ing) => {
    const ref = refPath(ing);
    return ref ? lower(S.recipes.get(ref)?.title || ing.name) : shop.lookup(aisle, ing.name).key;
  };
  return cookSteps(recipe).map((s, i) => (s.ings.some((ing) => keyOf(ing) === key) ? i + 1 : 0)).filter(Boolean);
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

// Timers keep an end time, not a countdown, and are saved on the device, so a
// reload, a closed tab or another tab of the site picks them up where they are.
const timers = saved.get('timers', []);
let timerTick = null;

function saveTimers() { saved.set('timers', timers); }

function tickTimers() {
  renderTimers();
  if (timers.length && !timerTick) timerTick = setInterval(renderTimers, 500);
}

function initTimers() {
  window.addEventListener('storage', (ev) => {
    if (ev.key !== 'recipes.timers') return;
    timers.splice(0, timers.length, ...saved.get('timers', []));
    tickTimers();
  });
  // Closing the tab stops the alarm, so ask first while one is counting down.
  window.addEventListener('beforeunload', (ev) => {
    if (timers.some((t) => !t.done && t.paused == null)) { ev.preventDefault(); ev.returnValue = ''; }
  });
  tickTimers();
}

function startTimer(secs, label, recipeTitle, key = null) {
  timers.push({ id: Math.random().toString(36).slice(2), key, label, recipeTitle, end: Date.now() + secs * 1000, total: secs, paused: null, done: false });
  try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch { /* ignore */ }
  saveTimers();
  tickTimers();
}

function pauseTimer(t) {
  if (t.paused != null) { t.end = Date.now() + t.paused * 1000; t.paused = null; }
  else t.paused = (t.end - Date.now()) / 1000;
  saveTimers();
  renderTimers();
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
  // Right after a reload the page may not play sound or vibrate until it is
  // tapped; beeps queued before that would all sound at once.
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
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

/** A soft click when an item goes in the basket (rising) or comes out (falling). */
function tickSound(on) {
  try {
    // Ambient sound follows the phone's silent switch where the browser supports it.
    if (navigator.audioSession) navigator.audioSession.type = 'ambient';
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    const ctx = audio, t = ctx.currentTime;
    if (ctx.state === 'suspended') ctx.resume();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(on ? 660 : 990, t);
    o.frequency.exponentialRampToValueAtTime(on ? 990 : 660, t + 0.08);
    o.connect(g); g.connect(ctx.destination);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    o.start(t); o.stop(t + 0.16);
  } catch { /* no audio */ }
  try { navigator.vibrate?.(12); } catch { /* ignore */ }
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
    if (!t.done && t.paused == null && t.end <= now) {
      t.done = true;
      saveTimers();
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
        if (b.dataset.act !== 'close') { pauseTimer(t); return; }
        timers.splice(timers.indexOf(t), 1);
        saveTimers();
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
      if (t && !t.done) { pauseTimer(t); return; }
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
    e.fullPending = null; e.photoLoading = false;
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
      // Moved or renamed: the plan follows it.
      if (!isNew && newPath !== e.path) S.plan?.do({ t: 'repath', from: e.path, to: newPath, title: entry.title });
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

const TOAST_ICONS = {
  Undo: '<path d="M9 14 4.5 9.5 9 5"/><path d="M4.5 9.5h10a5 5 0 0 1 0 10H11"/>',
  Reload: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>',
  Save: '<path d="M5.5 12.5l4 4 9-9"/>',
  Discard: '<path d="M5 7h14M10 7V5h4v2M7 7l1 12.5h8L17 7"/>',
};
let toastTimer;
/** Shows a short message with a close button, optionally with one action such as Undo. */
function toast(msg, action) {
  const el = $('#toast');
  const icon = action && TOAST_ICONS[action.label];
  el.innerHTML = `<span class="toast-msg">${esc(msg)}</span>${action ? `<button class="toast-btn">${icon ? `<svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>` : ''}${esc(action.label)}</button>` : ''}<button class="toast-x" aria-label="Close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg></button>`;
  const hide = () => { clearTimeout(toastTimer); el.classList.remove('is-on'); };
  if (action) el.querySelector('.toast-btn').onclick = () => { hide(); action.run(); };
  el.querySelector('.toast-x').onclick = hide;
  // A swipe up puts it away too.
  el.ontouchstart = (e) => { el.dataset.y = e.touches[0].clientY; };
  el.ontouchend = (e) => { if (el.dataset.y - e.changedTouches[0].clientY > 24) hide(); };
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hide, action ? 7000 : 5200);
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
