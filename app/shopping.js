// The shopping list: what is on it, how it combines, and how it syncs.
//
// The list file in Google Drive (config/shopping_list.json) stores what was
// asked for, not the finished list: the recipes with their scale, the items
// added by hand, what is checked and which lines were removed. The combined
// list is worked out from that with aisle.conf and pantry.conf every time, so
// fixing a recipe or reordering the aisles changes the list straight away.
//
// Every change is an operation. Operations wait in localStorage until they
// reach Drive, and are replayed on top of the newest Drive version, so ticks
// made offline or on two devices at once are all kept.

export const LIST_PATH = 'config/shopping_list.json';
export const AISLE_PATH = 'config/aisle.conf';
export const PANTRY_PATH = 'config/pantry.conf';
const STORE_KEY = 'recipes.shop';
const MADE_AT_HOME = 'made at home';

export const newId = () => Math.random().toString(36).slice(2, 10);
const lower = (s) => String(s ?? '').trim().toLowerCase();

export function emptyList() {
  return { version: 1, recipes: [], items: [], checked: [] };
}

function cleanList(raw) {
  const l = emptyList();
  if (!raw || typeof raw !== 'object') return l;
  if (Array.isArray(raw.recipes)) l.recipes = raw.recipes.filter((r) => r && r.path).map((r) => ({ ...r, removed: Array.isArray(r.removed) ? r.removed : [] }));
  if (Array.isArray(raw.items)) l.items = raw.items.filter((i) => i && i.name);
  if (Array.isArray(raw.checked)) l.checked = raw.checked.filter((k) => typeof k === 'string');
  return l;
}

// ---------------------------------------------------------------- aisle.conf

/** Parses aisle.conf: sections in store order, each line one item with its other spellings after "|". */
export function parseAisle(text) {
  const sections = [];
  const names = new Map(); // any spelling -> { name, sec, pos }
  let sec = -1;
  let pos = 0;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    const head = line.match(/^\[(.+)\]$/);
    if (head) { sections.push(head[1].trim()); sec = sections.length - 1; continue; }
    if (sec < 0) continue;
    const spellings = line.split('|').map((s) => s.trim()).filter(Boolean);
    if (!spellings.length) continue;
    pos++;
    for (const s of spellings) if (!names.has(lower(s))) names.set(lower(s), { name: spellings[0], sec, pos });
  }
  return { sections, names, madeAtHome: sections.findIndex((s) => lower(s) === MADE_AT_HOME) };
}

/** Adds an item to the end of a section and returns the new aisle.conf text. */
export function addToAisle(text, section, name) {
  const lines = String(text || '').split(/\r?\n/);
  const start = lines.findIndex((l) => lower(l.replace(/\/\/.*$/, '')) === `[${lower(section)}]`);
  if (start < 0) return `${String(text || '').replace(/\s*$/, '')}\n\n[${section}]\n${name}\n`;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  let at = end;
  while (at > start + 1 && !lines[at - 1].trim()) at--;
  lines.splice(at, 0, name);
  return lines.join('\n');
}

// ---------------------------------------------------------------- pantry.conf

const pantryKey = (k) => lower(k.replace(/^["']|["']$/g, '').replace(/_/g, ' '));

/** The item names in pantry.conf (TOML: `name = ...` under any section). */
export function parsePantry(text) {
  const out = new Set();
  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = raw.match(/^\s*("[^"]+"|'[^']+'|[^=#[\s][^=#]*?)\s*=/);
    if (m) out.add(pantryKey(m[1]));
  }
  return out;
}

export function addToPantry(text, name) {
  let t = String(text || '');
  const line = `"${name.replace(/"/g, '')}" = {}`;
  if (!/^\s*\[pantry\]\s*$/m.test(t)) {
    if (!t.trim()) t = '# Things you always have at home. The shopping list moves them to "Probably have".\n';
    return `${t.replace(/\s*$/, '')}\n\n[pantry]\n${line}\n`;
  }
  const lines = t.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*\[pantry\]\s*$/.test(l));
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  let at = end;
  while (at > start + 1 && !lines[at - 1].trim()) at--;
  lines.splice(at, 0, line);
  return lines.join('\n');
}

export function removeFromPantry(text, key) {
  return String(text || '').split(/\r?\n/).filter((raw) => {
    const m = raw.match(/^\s*("[^"]+"|'[^']+'|[^=#[\s][^=#]*?)\s*=/);
    return !(m && pantryKey(m[1]) === key);
  }).join('\n');
}

// ---------------------------------------------------------------- names and amounts

/** Finds an ingredient in aisle.conf, trying the plural or singular too. */
export function lookup(aisle, name) {
  const n = lower(name);
  const tries = [n, n.replace(/es$/, ''), n.replace(/s$/, ''), `${n}s`, `${n}es`];
  for (const t of tries) {
    const hit = aisle.names.get(t);
    if (hit) return { key: lower(hit.name), name: hit.name, sec: hit.sec, pos: hit.pos };
  }
  return { key: n, name: String(name).trim(), sec: -1, pos: Infinity };
}

// Metric amounts add up across units; anything else only with the same unit.
const BASE = { g: ['g', 1], kg: ['g', 1000], mg: ['g', 0.001], ml: ['ml', 1], l: ['ml', 1000], cl: ['ml', 10], dl: ['ml', 100] };

export function addAmounts(target, amounts) {
  for (const a of amounts) {
    if (a.text != null) { if (!target.texts.includes(a.text)) target.texts.push(a.text); continue; }
    const u = lower(a.unit);
    const [unit, mul] = BASE[u] || [u, 1];
    target.sums.set(unit, (target.sums.get(unit) || 0) + a.n * mul);
  }
  return target;
}

export const newTotal = () => ({ sums: new Map(), texts: [] });

/** Turns a total into display text with `fmt(n, unit)`, metric first. */
export function totalText(total, fmt) {
  const order = (u) => (u === 'g' ? 0 : u === 'ml' ? 1 : u === '' ? 3 : 2);
  const parts = [...total.sums].sort((a, b) => order(a[0]) - order(b[0])).map(([u, n]) => fmt(n, u));
  return [...parts, ...total.texts].filter(Boolean).join(' + ');
}

/** "2 kg potatoes" -> { n: 2, unit: 'kg', name: 'potatoes' }; "frozen fries" -> { name }. */
export function parseItem(text) {
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  const m = t.match(/^(\d+(?:[.,]\d+)?)\s*(g|kg|mg|ml|l|cl|dl)?\s+(.+)$/i) || t.match(/^(\d+(?:[.,]\d+)?)\s*(g|kg|ml|l)(?=\s|$)\s*(.*)$/i);
  if (m && m[3]) return { n: Number(m[1].replace(',', '.')), unit: lower(m[2] || ''), name: m[3] };
  return { name: t };
}

// ---------------------------------------------------------------- building the list

/**
 * Works out the list. `ctx`: { recipe(path) -> { title, src } | undefined,
 * ingredients(src, factor, parts) -> [...], aisle, pantry: Set }.
 * Returns { groups: Map(key -> group), recipes: [...], manual: [...] }.
 */
export function buildList(list, ctx) {
  const checked = new Set(list.checked);
  const groups = new Map();
  const group = (found, extra = {}) => {
    let g = groups.get(found.key);
    if (!g) {
      const pantry = ctx.pantry.has(found.key) || ctx.pantry.has(lower(found.name));
      g = { key: found.key, name: found.name, sec: found.sec, pos: found.pos ?? Infinity, total: newTotal(), sources: [], items: [], checked: checked.has(found.key), pantry, home: false };
      groups.set(found.key, g);
    }
    Object.assign(g, extra);
    return g;
  };

  const recipes = list.recipes.map((r) => {
    const e = ctx.recipe(r.path);
    if (!e) return { ...r, missing: true, lines: [] };
    const lines = new Map();
    for (const ing of ctx.ingredients(e.src, r.factor || 1, r.parts || null)) {
      let found;
      if (ing.ref) {
        const title = ctx.recipe(ing.ref)?.title || ing.name;
        found = { key: lower(title), name: title, sec: ctx.aisle.madeAtHome };
      } else found = lookup(ctx.aisle, ing.name);
      if (r.removed.includes(found.key)) continue;
      const g = group(found);
      if (ing.ref || (found.sec >= 0 && found.sec === ctx.aisle.madeAtHome)) g.home = true;
      addAmounts(g.total, ing.amounts);
      // Two spellings in one recipe ("onion", "onions") land on one line.
      let line = lines.get(found.key);
      if (!line) {
        line = { key: found.key, name: found.name, total: newTotal(), optional: ing.optional, group: g };
        lines.set(found.key, line);
        g.sources.push({ recipeId: r.id, title: e.title, total: line.total });
      } else line.optional = line.optional && ing.optional;
      addAmounts(line.total, ing.amounts);
    }
    return { ...r, title: e.title, lines: [...lines.values()] };
  });

  const manual = list.items.map((it) => {
    const found = lookup(ctx.aisle, it.name);
    const g = group(found);
    const amounts = it.n != null ? [{ n: it.n, unit: it.unit || '' }] : [];
    addAmounts(g.total, amounts);
    g.items.push(it.id);
    if (found.sec >= 0 && found.sec === ctx.aisle.madeAtHome) g.home = true;
    return { ...it, key: found.key, group: g, total: addAmounts(newTotal(), amounts) };
  });

  return { groups, recipes, manual };
}

/** Ingredient keys a recipe would put on the list, for unchecking them when it is added. */
export function recipeKeys(src, factor, ctx, parts = null) {
  return ctx.ingredients(src, factor, parts).map((ing) => (ing.ref ? lower(ctx.recipe(ing.ref)?.title || ing.name) : lookup(ctx.aisle, ing.name).key));
}

// ---------------------------------------------------------------- operations

const without = (arr, v) => arr.filter((x) => x !== v);

export function apply(list, op) {
  const l = cleanList(JSON.parse(JSON.stringify(list)));
  switch (op.t) {
    case 'addRecipe': {
      l.recipes = l.recipes.filter((r) => r.path !== op.path);
      l.recipes.push({ id: op.id, path: op.path, title: op.title, servings: op.servings ?? null, factor: op.factor, parts: op.parts || null, removed: [], added: op.at });
      l.checked = l.checked.filter((k) => !(op.keys || []).includes(k));
      break;
    }
    case 'removeRecipe': l.recipes = l.recipes.filter((r) => r.id !== op.id); break;
    case 'addItem':
      l.items.push({ id: op.id, name: op.name, n: op.n ?? null, unit: op.unit || '', added: op.at });
      l.checked = without(l.checked, op.key);
      break;
    case 'removeItem': l.items = l.items.filter((i) => i.id !== op.id); break;
    case 'check':
      l.checked = without(l.checked, op.key);
      if (op.on) l.checked.push(op.key);
      break;
    case 'removeLine': {
      const r = l.recipes.find((x) => x.id === op.recipeId);
      if (r && !r.removed.includes(op.key)) r.removed.push(op.key);
      break;
    }
    case 'removeKeys': {
      // Removes items everywhere: from every recipe and the items added by hand.
      for (const r of l.recipes) for (const k of op.keys) if (!r.removed.includes(k)) r.removed.push(k);
      l.items = l.items.filter((i) => !(op.itemIds || []).includes(i.id));
      l.checked = l.checked.filter((k) => !op.keys.includes(k));
      l.recipes = l.recipes.filter((r) => !(op.dropRecipes || []).includes(r.id));
      break;
    }
    case 'clearAll': return emptyList();
    case 'restore': return cleanList(op.list);
    default: break;
  }
  return l;
}

// ---------------------------------------------------------------- sync with Drive

/**
 * Keeps the list in step with Drive. `drive` is the drive.js module;
 * `configFolder()` resolves to the id of the config folder; `onChange()` is
 * called whenever the list or the sync status changes.
 */
export function createSync({ drive, configFolder, onChange }) {
  const saved = (() => { try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { return null; } })() || {};
  const st = {
    base: cleanList(saved.base),
    md5: saved.md5 || null,
    fileId: saved.fileId || null,
    pending: Array.isArray(saved.pending) ? saved.pending : [],
    status: 'idle', // idle | syncing | ok | signin | offline | error
    loaded: Boolean(saved.base),
  };
  let running = false;
  let again = false;
  let timer = null;

  const persist = () => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ base: st.base, md5: st.md5, fileId: st.fileId, pending: st.pending })); } catch { /* private mode */ }
  };

  // The list is read on every render; work it out again only after a change
  // (a new Drive version, an op added, or ops that reached Drive).
  let memo = { base: null, n: -1, last: null, list: null };
  const current = () => {
    const last = st.pending[st.pending.length - 1] || null;
    if (memo.base !== st.base || memo.n !== st.pending.length || memo.last !== last) {
      memo = { base: st.base, n: st.pending.length, last, list: st.pending.reduce(apply, st.base) };
    }
    return memo.list;
  };

  async function sync() {
    if (running) { again = true; return; }
    running = true;
    st.status = 'syncing';
    try {
      if (!drive.signedIn()) { st.status = 'signin'; return; }
      if (st.fileId) {
        let meta = null;
        try { meta = await drive.getMeta(st.fileId); } catch (e) { if (e.code !== 404) throw e; }
        if (!meta || meta.trashed) { st.fileId = null; st.md5 = null; st.base = emptyList(); }
        else if (meta.md5Checksum !== st.md5) {
          const text = await drive.readText(st.fileId);
          let parsed = null;
          try { parsed = JSON.parse(text); } catch { /* broken file: start again */ }
          st.base = cleanList(parsed);
          st.md5 = meta.md5Checksum;
        }
      }
      st.loaded = true;
      if (st.pending.length) {
        const n = st.pending.length;
        const next = st.pending.slice(0, n).reduce(apply, st.base);
        const body = JSON.stringify({ ...next, updated: new Date().toISOString() }, null, 1);
        let meta;
        if (st.fileId) meta = await drive.updateContent(st.fileId, body, 'application/json');
        else {
          const folder = await configFolder();
          meta = await drive.create('shopping_list.json', folder, body, 'application/json');
        }
        st.fileId = meta.id;
        st.md5 = meta.md5Checksum;
        st.base = next;
        st.pending.splice(0, n);
      }
      st.status = 'ok';
    } catch (e) {
      st.status = e.code === 401 ? 'signin' : e.code === 'wait' ? 'idle' : (navigator.onLine === false || e instanceof TypeError) ? 'offline' : 'error';
      st.error = e.message;
    } finally {
      running = false;
      persist();
      onChange();
      if (again) { again = false; sync(); }
    }
  }

  return {
    get list() { return current(); },
    get status() { return st.status; },
    get loaded() { return st.loaded; },
    get pendingCount() { return st.pending.length; },
    get error() { return st.error; },
    /** Use the file found while walking the Drive folder, unless we already know it. */
    useFile(meta) {
      if (meta && meta.id !== st.fileId) { st.fileId = meta.id; st.md5 = null; }
    },
    do(op) {
      st.pending.push({ at: Date.now(), ...op });
      persist();
      onChange();
      clearTimeout(timer);
      timer = setTimeout(sync, 400);
    },
    sync,
    reset() { try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ } },
  };
}
