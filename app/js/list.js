// The shopping list (#/list, and the side panel or tab bar). The data and
// its sync live in shopping.js; this draws it: by aisle or by recipe, ticks
// that slide to the bottom, the item card, and editing aisle.conf and
// pantry.conf.

import * as shop from './shopping.js';
import { fmtAmount, initParser, parseRecipe, shoppingIngredients } from './cooklang.js';
import * as drive from './drive.js';
import { BASKET_ICON, CHEVRON_ICON, CLOSE_ICON, EXPAND_ICON, MORE_ICON, PANEL_ICON, PLUS_ICON, SHRINK_ICON, TRASH_ICON } from './icons.js';
import { go, renderAccount, signInFlow, watchSession } from './app.js';
import { canPlan } from './planner.js';
import { planView } from './lazy.js';
import { byAisle, cookSteps, refPath } from './recipe.js';
import { listToSide, renderSide, setSide, showSideTab, sideToggle, toBuyCount } from './side.js';
import { S } from './state.js';
import { tickSound } from './timers.js';
import { ask, pick, toast } from './ui.js';
import { $, $$, cap, collator, encPath, esc, fold, lc, prettifyFile, saved, wideBrowse } from './util.js';

let aisleCache = { text: null, parsed: null };
let pantryCache = { text: null, parsed: null };
const ingMemo = new Map();

/** What the shopping list needs to know about recipes, aisles and the pantry. */
export function shopCtx() {
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

export const built = () => shop.buildList(S.shop.list, shopCtx());
export const toBuy = (g) => !g.pantry && !g.home;
const amount = (total) => shop.totalText(total, fmtAmount);
export const servingsText = (n) => `${n} ${n === 1 ? 'serving' : 'servings'}`;
export const partsText = (parts) => `only ${joinAnd(parts.map((p, i) => (i ? p.toLowerCase() : p)))}`;
const joinAnd = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

export function listLink() {
  const n = S.shop ? toBuyCount() : 0;
  return `<a class="icon-link" href="#/list" title="Shopping list" aria-label="Shopping list${n ? `, ${n} to buy` : ''}">${BASKET_ICON}${n ? `<span class="badge">${n}</span>` : ''}</a>`;
}

export function onShopChange() {
  renderAccount();
  S.refreshAddList?.();
  planView.now?.drawPlan(); // in list and bought show on the plan
  if ($('#shop-body')) updateList();
  else renderSide();
}

export async function configFolder() {
  if (!S.drive) throw Object.assign(new Error('Still loading from Google Drive.'), { code: 'wait' });
  let id = S.drive.folders.get('config');
  if (!id) {
    id = (await drive.createFolder('config', S.config.folderId)).id;
    S.drive.folders.set('config', id);
  }
  return id;
}

export let listPoll = null;
export function startListPolling() {
  stopListPolling();
  listPoll = setInterval(() => { if (!document.hidden) { S.shop.sync(); if ($('#plan-root')) S.plan?.sync(); } }, 15000);
}
export function stopListPolling() { clearInterval(listPoll); listPoll = null; }

export async function showList() {
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
export async function mountList(root, panel) {
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

const RENEW_SOON = 10 * 60_000;

export function shopStatus(s = S.shop) {
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
export function undoable(msg, op) {
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
    return ref ? lc(S.recipes.get(ref)?.title || ing.name) : shop.lookup(aisle, ing.name).key;
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
