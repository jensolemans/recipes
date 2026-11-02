// Drawing the meal plan. It shows in three places: the side panel beside
// the recipes on wide screens, #/plan (a real week on wide screens, the Plan
// tab on phones), and Today on top of the home page. Also the chip cards,
// the pickers and dragging. Loaded when the plan first shows.

import { fmtAmount, initParser } from './cooklang.js';
import * as plan from './plan.js';
import * as shop from './shopping.js';
import * as drive from './drive.js';
import { card } from './home.js';
import { BASKET_ICON, BOOKMARK_ICON, CHECK_ICON, CHEF_ICON, CHEVRON_ICON, CLOSE_ICON, EXPAND_ICON, MEAL_ICONS, NOTE_ICON, PANEL_ICON, PLUS_ICON, SALAD_ICON, SHRINK_ICON, STATE_ICONS, TRASH_ICON, WARN_ICON } from './icons.js';
import { servingsText, shopStatus, startListPolling } from './list.js';
import { go, parseHash, signInFlow } from './app.js';
import { P, addDay, addPlanToList, batchSize, byDayMeal, canPlan, dateText, dayName, dayWord, dropOn, isCooked, isGone, linkList, ownSize, placeRecipe, planBubble, planServings, planSize, planState, planTitleOf, planUndo, relinkList, removeEntry, saveRecipe, setCooked, setCooking, weekday } from './planner.js';
import { baseServings } from './recipe.js';
import { setSide, showSideTab, sideToggle } from './side.js';
import { S } from './state.js';
import { pick, toast } from './ui.js';
import { $, $$, collator, debounce, encPath, esc, fold, folderLabel, saved, wide, wideBrowse } from './util.js';

// ---- drawing

function planThumb(x) {
  if (x.kind === 'note') return `<span class="pthumb is-icon">${NOTE_ICON}</span>`;
  if (x.kind === 'item') return `<span class="pthumb is-icon">${BASKET_ICON}</span>`;
  if (x.kind === 'free') return `<span class="pthumb is-icon">${SALAD_ICON}</span>`;
  const e = x.path && S.recipes.get(x.path);
  if (e?.thumbUrl) return `<span class="pthumb"><img src="${esc(e.thumbUrl)}" alt="" loading="lazy" decoding="async"></span>`;
  return `<span class="pthumb"><span class="ph" aria-hidden="true">${esc(planTitleOf(x).charAt(0))}</span></span>`;
}
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
export function mountPlan(root, layout) {
  root.innerHTML = `<section class="plan plan-${layout}" id="plan-root" data-layout="${layout}"></section>`;
  wirePlan($('#plan-root', root));
  drawPlan();
  startListPolling();
  if (S.live !== 'loading') S.plan.sync();
}

export function drawPlan() {
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

// A recipe moved or renamed somewhere else (the Cooklang app, Claude): find
// it again by its title or file name, once per path.
const healTried = new Set();
export function healPlan() {
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

export function drawToday() {
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
    press = { el: chip || card, chip: Boolean(chip), x: ev.clientX, y: ev.clientY, lx: ev.clientX, ly: ev.clientY, fired: false, timer: 0 };
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

export async function showPlanPage() {
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

// Recipe cards and plan chips can be dragged as soon as the plan is there.
initPlanDrag();
