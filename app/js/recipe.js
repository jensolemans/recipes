// The recipe page: photo, facts, ingredients (as written or by aisle),
// method with timers, scaling, and the actions (cook, plan, list, share,
// edit). Also the ingredient helpers cook mode and the list share.

import { fmtDuration, fmtGrouped, fmtQuantity, fmtYield, initParser, parseRecipe, recipeParts, shouldList } from './cooklang.js';
import * as shop from './shopping.js';
import * as drive from './drive.js';
import * as plan from './plan.js';
import { claudeLink } from './choose.js';
import { BASKET_ICON, BASKET_ON_ICON, BASKET_UPDATE_ICON, BOOKMARK_ICON, BOOKMARK_ON_ICON, CAL_ICON, CHEF_ICON, MORE_ICON, PEN_ICON, PRINT_ICON, SHARE_ICON } from './icons.js';
import { partsText, servingsText, shopCtx, undoable } from './list.js';
import { fullPhoto, heroBackdrop } from './live.js';
import { go, parseHash } from './app.js';
import { P, byDayMeal, canPlan, dayWord, isCooked, planUndo, saveRecipe } from './planner.js';
import { editorView, shareView } from './lazy.js';
import { showSideTab, sideMode } from './side.js';
import { S } from './state.js';
import { wireTimerChips } from './timers.js';
import { chooseParts, closeMenus, toast } from './ui.js';
import { $, $$, cap, chapterLabel, encPath, esc, prettifyFile, saved } from './util.js';

export function baseServings(e) {
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

export function refPath(ing) {
  const r = ing.reference;
  if (!r) return null;
  const parts = [...(r.components || []), r.name].filter((p) => p && p !== '.');
  return parts.join('/');
}

export function ingName(ing) {
  if (ing.alias) return ing.alias;
  const target = refPath(ing);
  if (target) return S.recipes.get(target)?.title || prettifyFile(ing.name);
  return ing.name;
}

/** The ingredient lines of a parsed recipe, with the keys the ticks use. */
export function ingItems(parsed) {
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
export const byAisle = () => hasAisles() && saved.get('ingSort', 'recipe') === 'aisle';

export function sortToggle() {
  if (!hasAisles()) return '';
  const v = byAisle() ? 'aisle' : 'recipe';
  return `<div class="seg ing-sort" role="group" aria-label="Sort ingredients">
    <button type="button" data-sort="recipe" aria-pressed="${v === 'recipe'}">As written</button>
    <button type="button" data-sort="aisle" aria-pressed="${v === 'aisle'}">By aisle</button>
  </div>`;
}

/** The ingredient list, flat or under aisle headings. `links` makes other recipes links. */
export function ingLines(items, checked, { interactive = true, links = true } = {}) {
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
export function wireSort(root, redraw) {
  $$('.ing-sort button', root).forEach((b) => {
    b.onclick = () => {
      saved.set('ingSort', b.dataset.sort);
      $$('.ing-sort button', root).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      redraw();
    };
  });
}

/** Renders ingredients, cookware and method for a parsed recipe. */
export function recipeBody(parsed, { interactive = true, path = '' } = {}) {
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

export function factsList(e, parsed, factor) {
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

export async function showRecipe(rawPath, params) {
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
  if (photoBtn) photoBtn.onclick = () => { closeMenus(); editorView().then((v) => v.changePhoto(e)); };
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
    if (base && servings !== base) q.set('s', String(servings));
    if (!base && mult !== 1) q.set('x', String(mult));
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
    shareView().then((v) => v.openShare(e, parsed, base ? servingsText(servings) : mult !== 1 ? `${mult}× the recipe` : ''));
  };

  draw();
  window.scrollTo({ top: 0 });
}

/** The method as a flat list of steps, each with its chapter, notes and what it uses. */
export function cookSteps(recipe) {
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
