// The meal plan: what is saved to cook, and what is on which day.
//
// Stored in Google Drive as config/plan.json and synced like the shopping
// list (shopping.js createSync): every change is an operation that waits on
// the device and is replayed on top of the newest Drive version.
//
// - saved: recipes you want to make some time. Never shopped.
// - meals: the calendar, what is on a day. A meal slot (breakfast, lunch,
//   dinner, snack) holds any number of them. Kinds: a recipe, a meal without
//   a recipe ("Eating out"), a loose ingredient to buy, or a note for the day
//   (meal "notes"). Shopping buys the calendar.
// - until: the last day you added with the ghost day, so empty days stay.
//
// `servings: null` follows the plan's "Cooking for". A recipe eaten on more
// days shares a `batch` (the first meal's id); without `each` it is cooked
// once, on its first day, for all of them.
//
// A meal only counts as cooked when you say so (cook mode or Done). One that
// is not stays on its day, which shows a warning until you move or tick it.

export const PLAN_PATH = 'config/plan.json';
export const MEALS = ['breakfast', 'lunch', 'dinner', 'snack'];
export const MEAL_NAMES = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snack', notes: 'Notes' };
export const AHEAD = 3; // days after today that always show

const pad = (n) => String(n).padStart(2, '0');
/** A local date as YYYY-MM-DD. */
export const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const toDate = (key) => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (key, n) => { const d = toDate(key); d.setDate(d.getDate() + n); return dayKey(d); };
const isDay = (s) => typeof s === 'string' && /^\d{4}-\d\d-\d\d$/.test(s);

export function emptyPlan() {
  return { version: 1, servings: 4, saved: [], meals: [], until: null };
}

export function cleanPlan(raw) {
  const p = emptyPlan();
  if (!raw || typeof raw !== 'object') return p;
  if (Number(raw.servings) > 0) p.servings = Number(raw.servings);
  if (Array.isArray(raw.saved)) p.saved = raw.saved.filter((s) => s && s.id && s.path).map(({ someday, ...s }) => s);
  if (Array.isArray(raw.meals)) p.meals = raw.meals.filter((m) => m && m.id && isDay(m.day) && (MEALS.includes(m.meal) || m.meal === 'notes') && m.kind !== 'leftover');
  if (isDay(raw.until)) p.until = raw.until;
  return p;
}

// ---------------------------------------------------------------- reading the plan

/** The days to show: today to 3 days ahead, or further to the last planned or added day. */
export function upcoming(plan, today = dayKey()) {
  let last = addDays(today, AHEAD);
  if (plan.until && plan.until > last) last = plan.until;
  for (const m of plan.meals) if (m.day > last) last = m.day;
  const out = [];
  for (let d = today; d <= last; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Past days that have something on them, oldest first. */
export function earlier(plan, today = dayKey()) {
  return [...new Set(plan.meals.filter((m) => m.day < today).map((m) => m.day))].sort();
}

/** Past days with a recipe that was not ticked as cooked: likely bought, still to move. */
export function late(plan, today = dayKey()) {
  return [...new Set(plan.meals.filter((m) => m.day < today && m.kind === 'recipe' && !isCookedIn(plan, m)).map((m) => m.day))].sort();
}

/** The meals eaten together with `m`, first day first (just `m` when it is on its own). */
export function batchOf(plan, m) {
  if (!m?.batch) return m ? [m] : [];
  return plan.meals.filter((x) => x.batch === m.batch)
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : MEALS.indexOf(a.meal) - MEALS.indexOf(b.meal)));
}
/** Cooked once for the whole batch: the first meal is where it is cooked. */
export const cookedOnce = (plan, m) => Boolean(m?.batch) && !m.each && batchOf(plan, m).length > 1;
/** The meal of a batch that is cooked (itself when cooked each day). */
export const cookMeal = (plan, m) => (cookedOnce(plan, m) ? batchOf(plan, m)[0] : m);
export const isCookedIn = (plan, m) => m.kind === 'recipe' && Boolean(cookMeal(plan, m).cooked);

export const on = (plan, day, meal) => plan.meals.filter((m) => m.day === day && (!meal || m.meal === meal));

/** Meals that buy something: recipes not cooked, and loose ingredients. */
export const shops = (plan, m) => (m.kind === 'recipe' && !isCookedIn(plan, m)) || m.kind === 'item';

/** The recipe entries that point at `path`, saved or planned. */
export const uses = (plan, path) => ({
  saved: plan.saved.filter((s) => s.path === path),
  meals: plan.meals.filter((m) => m.path === path && m.kind === 'recipe'),
});

// ---------------------------------------------------------------- operations

const copy = (x) => JSON.parse(JSON.stringify(x));
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const ENTRY = ['id', 'day', 'meal', 'kind', 'path', 'title', 'servings', 'x', 'note', 'n', 'unit', 'cooked', 'bought', 'batch', 'each'];

export function applyPlan(plan, op) {
  const p = cleanPlan(copy(plan));
  const meal = (id) => p.meals.find((m) => m.id === id);
  const saved = (id) => p.saved.find((s) => s.id === id);
  switch (op.t) {
    case 'cooking': if (op.n > 0) p.servings = op.n; break;
    case 'save':
      if (!saved(op.id)) p.saved.push({ id: op.id, path: op.path, title: op.title, servings: op.servings ?? null, x: op.x ?? null, note: op.note || '', added: op.at });
      break;
    case 'unsave': p.saved = p.saved.filter((s) => s.id !== op.id); break;
    case 'editSaved': { const s = saved(op.id); if (s) Object.assign(s, pick(op.set || {}, ['servings', 'x', 'note'])); break; }
    case 'place':
      // One or more entries onto days. A saved recipe leaves Saved when it goes on a day.
      for (const e of op.entries || []) {
        if (meal(e.id)) continue;
        p.meals.push({ ...pick(e, ENTRY), added: op.at });
        if (e.fromSaved) p.saved = p.saved.filter((s) => s.id !== e.fromSaved);
      }
      break;
    case 'move': {
      const m = meal(op.id);
      if (m) { m.day = op.day; m.meal = op.meal; }
      break;
    }
    case 'edit': {
      const m = meal(op.id);
      if (!m) break;
      for (const [k, v] of Object.entries(pick(op.set || {}, ['servings', 'x', 'note', 'cooked', 'bought', 'title', 'batch', 'each']))) {
        if (v == null || v === false) delete m[k]; else m[k] = v;
      }
      break;
    }
    case 'remove': p.meals = p.meals.filter((m) => !(op.ids || [op.id]).includes(m.id)); break;
    case 'bought':
      // Cleared from the shopping list with everything in the basket.
      // What was bought keeps its size when "Cooking for" changes later.
      for (const x of p.meals) if (op.ids.includes(x.id)) { x.bought = true; if (x.kind === 'recipe' && x.servings == null) x.servings = p.servings; }
      break;
    case 'toSaved': {
      const m = meal(op.id);
      if (!m) break;
      p.meals = p.meals.filter((x) => x.id !== op.id);
      if (m.kind === 'recipe' && !saved(m.id)) p.saved.push({ id: m.id, path: m.path, title: m.title, servings: m.servings ?? null, x: m.x ?? null, note: m.note || '', added: op.at });
      break;
    }
    case 'until': if (isDay(op.day)) p.until = op.day; break;
    case 'repath':
      // A recipe was moved or renamed: everything that points at it follows.
      for (const x of [...p.saved, ...p.meals]) if (x.path === op.from) { x.path = op.to; if (op.title) x.title = op.title; }
      break;
    case 'restore': return cleanPlan(op.plan);
    default: break;
  }
  return p;
}
