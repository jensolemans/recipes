// The meal plan's state and changes: saved recipes and the days ahead,
// kept in step with the shopping list (plan.js has the data and its rules).
// Signed in only. The drawing is in planner-view.js, loaded when needed.

import * as drive from './drive.js';
import * as plan from './plan.js';
import * as shop from './shopping.js';
import { servingsText, shopCtx, toBuy } from './list.js';
import { planView } from './lazy.js';
import { baseServings } from './recipe.js';
import { showSideTab, sideMode } from './side.js';
import { S } from './state.js';
import { toast } from './ui.js';
import { prettifyFile, saved } from './util.js';

export const canPlan = () => Boolean(S.plan && drive.wasSignedIn());
export const P = () => S.plan.list;
export const planServings = (x) => x.servings ?? P().servings;
export const planTitleOf = (x) => (x.path && S.recipes.get(x.path)?.title) || x.title || prettifyFile((x.path || '').split('/').pop());
// Only live data knows for sure that a recipe is gone; the built copy can be an hour old.
export const isGone = (x) => Boolean(x.path) && S.live === 'on' && !S.recipes.has(x.path);
export const isCooked = (x) => x.kind === 'recipe' && plan.isCookedIn(P(), x);
const mealOrder = (m) => [...plan.MEALS, 'notes'].indexOf(m);
export const byDayMeal = (a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : mealOrder(a.meal) - mealOrder(b.meal));

/** How much of a recipe a plan entry is: its servings over the recipe's, or its multiplier. */
function planFactor(x) {
  const e = S.recipes.get(x.path);
  const base = e && baseServings(e);
  return base ? planServings(x) / base : (x.x || 1);
}
export function planSize(x) {
  const e = S.recipes.get(x.path);
  return e && !baseServings(e) ? `${x.x || 1}×` : servingsText(planServings(x));
}
/** Set by hand, so it no longer follows "Cooking for". */
export const ownSize = (x) => (x.servings != null && x.servings !== P().servings) || (x.x != null && x.x !== 1);
/** The size in the bubble at the end of a chip: servings, or the multiplier. */
export function planBubble(x) {
  const e = S.recipes.get(x.path);
  return e && !baseServings(e) ? `${x.x || 1}×` : String(planServings(x));
}
/** Everything a batch cooks, for cook mode on its first day. */
export function batchSize(x) {
  const all = plan.cookedOnce(P(), x) ? plan.batchOf(P(), x) : [x];
  return { servings: all.reduce((n, m) => n + planServings(m), 0), x: all.reduce((n, m) => n + (m.x || 1), 0), n: all.length };
}

export function dayName(key) {
  const t = plan.dayKey();
  if (key === t) return 'Today';
  if (key === plan.addDays(t, 1)) return 'Tomorrow';
  if (key === plan.addDays(t, -1)) return 'Yesterday';
  return plan.toDate(key).toLocaleDateString(undefined, { weekday: 'long' });
}
export const dateText = (key) => plan.toDate(key).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
/** today, tomorrow, or the name of the day, for the middle of a sentence. */
export const dayWord = (key) => { const n = dayName(key); return ['Today', 'Tomorrow', 'Yesterday'].includes(n) ? n.toLowerCase() : n; };
export const weekday = (key) => plan.toDate(key).toLocaleDateString(undefined, { weekday: 'short' });
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
export function planState(x) {
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
export function linkList(path, add = [], drop = []) {
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
export function relinkList(x, gone = false) {
  if (!x || !x.path || !S.shop) return;
  if (S.shop.list.recipes.some((r) => r.path === x.path && r.planIds?.includes(x.id))) linkList(x.path, [], gone ? [x.id] : []);
}

/** Adds plan entries (recipes and loose ingredients) to the shopping list. */
export function addPlanToList(entries) {
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

export function planUndo(msg, ops) {
  const before = P();
  for (const op of [].concat(ops)) S.plan.do(op);
  toast(msg, { label: 'Undo', run: () => S.plan.do({ t: 'restore', plan: before }) });
}

export function saveRecipe(path, { servings = null, x = null, quiet = false } = {}) {
  const e = S.recipes.get(path);
  if (!e) return;
  if (servings === P().servings) servings = null;
  const op = { t: 'save', id: shop.newId(), path, title: e.title, servings, x };
  const size = baseServings(e) ? `for ${servings ?? P().servings}` : x && x !== 1 ? `${x}×` : '';
  if (quiet) { S.plan.do(op); return; }
  planUndo(`Saved ${e.title}${size ? ` ${size}` : ''}.`, op);
  if (sideMode() !== 'off' && saved.get('sidePanel', null) == null) showSideTab('plan');
}

export function placeRecipe(path, day, meal, extra = {}) {
  const e = S.recipes.get(path);
  if (!e) return;
  S.plan.do({ t: 'place', entries: [{ id: shop.newId(), kind: 'recipe', path, title: e.title, day, meal, ...extra }] });
}

/** Ticks a meal cooked or not. Cooked once for more days, the whole batch goes with it. */
export function setCooked(m, on) {
  for (const x of plan.cookedOnce(P(), m) ? plan.batchOf(P(), m) : [m]) {
    S.plan.do({ t: 'edit', id: x.id, set: { cooked: on ? (x.cooked || plan.dayKey()) : null } });
  }
}

/** Ticks a meal as cooked, from cook mode's Finish. Without a plan id, the one planned for today or before. */
export function markCooked(path, id) {
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
export function setCooking(n) {
  const p = P();
  if (n === p.servings) return;
  const follow = p.meals.filter((m) => m.kind === 'recipe' && m.servings == null);
  const keep = follow.filter((m) => ['bought', 'cooked'].includes(planState(m)));
  const listed = new Set(follow.filter((m) => planState(m) === 'list').map((m) => m.path));
  for (const m of keep) S.plan.do({ t: 'edit', id: m.id, set: { servings: p.servings } });
  S.plan.do({ t: 'cooking', n });
  for (const path of listed) linkList(path);
}

export function addDay() {
  const days = plan.upcoming(P());
  S.plan.do({ t: 'until', day: plan.addDays(days[days.length - 1], 1) });
}

/** Takes a meal or a saved recipe out of the plan, and off the shopping list unless bought. */
export function removeEntry(src, x) {
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
export function dropOn(target, d, copy) {
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

export function onPlanChange() {
  S.refreshSave?.();
  if (canPlan()) planView().then((v) => { v.drawPlan(); v.drawToday(); v.healPlan(); });
}
