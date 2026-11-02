// The site's entry point: loads the recipe index, starts sign-in and the
// shopping list and plan syncs, and routes the #hash to a view:
//   #/            home (home.js)            #/r/<path>     recipe (recipe.js)
//   #/cook/<path> cook mode (cook.js)       #/edit/<path>  editor (editor.js)
//   #/new         editor, new recipe        #/list         shopping list (list.js)
//   #/plan        meal plan (planner-view.js)
// Also the theme toggle and the account bar.

import * as drive from './drive.js';
import * as shop from './shopping.js';
import * as plan from './plan.js';
import { initParser } from './cooklang.js';
import { checkConnector, claudeLink } from './choose.js';
import { showHome } from './home.js';
import { THEME_ICONS } from './icons.js';
import { configFolder, listLink, onShopChange, showList, stopListPolling } from './list.js';
import { goLive } from './live.js';
import { canPlan, onPlanChange } from './planner.js';
import { cookView, editorView, planView } from './lazy.js';
import { showRecipe } from './recipe.js';
import { initSide, renderSide, renderTabbar } from './side.js';
import { S, makeEntry } from './state.js';
import { initTimers } from './timers.js';
import { ask, toast } from './ui.js';
import { $, $$, SKIP_TOP, esc, saved } from './util.js';

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
    if (!res.ok) throw new Error(String(res.status));
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
    if (!drive.wasSignedIn()) return;
    checkConnector(true);
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
  initTimers();
  window.addEventListener('hashchange', onHashChange);
  window.addEventListener('beforeunload', (ev) => { if (S.dirty) { ev.preventDefault(); ev.returnValue = ''; } });
  route();
  if (drive.signedIn()) goLive();
  // Signed in, the editor and cook mode come along right after, so they open
  // straight away later, also without a connection.
  if (drive.wasSignedIn()) { editorView().catch(() => {}); cookView().catch(() => {}); }
  watchSession();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    watchSession();
    if (drive.wasSignedIn()) checkConnector();
    if ($('#shop-body')) S.shop?.sync();
    // A new day may have begun: meals not cooked move on.
    if ($('#plan-root') || $('#today')) S.plan?.sync();
    if (document.body.dataset.view === 'cook' && saved.get('cookAwake', true)) cookView.now?.keepAwake(true); // the lock goes when the tab is hidden
  });
}

export function parseHash() {
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

export function route() {
  S.currentHash = location.hash || '#/';
  if (!['/list', '/plan'].includes(parseHash().path)) S.lastPage = S.currentHash; // where the full list and plan go back to
  renderAccount();
  stopListPolling();
  renderSide();
  const { path, params } = parseHash();
  document.body.dataset.view = '';
  document.title = S.config.title || 'Recipes'; // views with a title of their own set it
  if (!path.startsWith('/cook/')) cookView.now?.keepAwake(false);
  if (path === '/list') return showList();
  if (path === '/plan') return showView(planView, (v) => v.showPlanPage());
  if (path.startsWith('/r/')) return showRecipe(path.slice(3), params);
  if (path.startsWith('/cook/')) return showView(cookView, (v) => v.showCook(path.slice(6), params));
  if (path.startsWith('/edit/')) return showView(editorView, (v) => v.showEditor(path.slice(6)));
  if (path === '/new') return showView(editorView, (v) => v.showEditor(null));
  return showHome();
}

export const go = (hash) => { location.hash = hash; };

/** Shows a view that loads on first use, or says why it cannot. */
function showView(view, show) {
  return view().then(show, () => {
    $('#main').innerHTML = '<div class="empty"><h1>This page could not be loaded</h1><p>It needs a connection the first time. Check yours and try again.</p></div>';
  });
}

// Light or dark. Until someone picks one it follows the device (dark when
// the device says nothing); a pick is remembered on this device.
// index.html applies the same choice before first paint.

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

export function renderAccount() {
  renderTabbar();
  document.body.classList.toggle('can-plan', canPlan());
  if (canPlan()) planView(); // signed in, the plan shows in several places: load it early
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

export async function signInFlow() {
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
export function watchSession() {
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

export function renderFoot() {
  const el = $('#foot');
  if (S.live === 'on') { el.textContent = 'Showing live recipes from Google Drive.'; return; }
  if (!S.built) { el.textContent = ''; return; }
  const d = new Date(S.built * 1000);
  el.textContent = `Recipes updated ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}, ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}.`;
}

boot();
