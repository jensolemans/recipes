// Cooklang parsing (official WASM parser) plus the small helpers the app needs:
// a fast frontmatter reader for the recipe index, duration parsing and
// metric-friendly quantity formatting.
import * as bg from './vendor/cooklang/cooklang_wasm_bg.js';

let parser = null;
let loading = null;

export function initParser() {
  if (parser) return Promise.resolve();
  if (loading) return loading;
  loading = (async () => {
    const url = new URL('./vendor/cooklang/cooklang_wasm_bg.wasm', import.meta.url);
    const imports = { './cooklang_wasm_bg.js': bg };
    let instance;
    try {
      ({ instance } = await WebAssembly.instantiateStreaming(fetch(url), imports));
    } catch {
      const buf = await (await fetch(url)).arrayBuffer();
      ({ instance } = await WebAssembly.instantiate(buf, imports));
    }
    bg.__wbg_set_wasm(instance.exports);
    parser = new bg.Parser();
    parser.load_units = false; // keep units exactly as written (no cups conversion)
  })();
  return loading;
}

/** Parse a recipe scaled by `factor`. Returns { recipe, meta, grouped, warnings, error }. */
export function parseRecipe(src, factor = 1) {
  try {
    const res = parser.parse(src, factor);
    let grouped = [];
    try { grouped = parser.group_ingredients(res); } catch { grouped = []; }
    return { recipe: res.recipe, meta: res.metadata || {}, grouped, ...splitReport(res.report) };
  } catch (e) {
    return { recipe: null, meta: {}, grouped: [], warnings: [], errors: [String(e?.message || e)] };
  }
}

export const shouldList = (ing) => { try { return bg.ingredient_should_be_listed(ing); } catch { return true; } };

function splitReport(report) {
  if (!report) return { warnings: [], errors: [] };
  const txt = report.replace(/<[^>]+>/g, '')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const warnings = [], errors = [];
  for (const block of txt.split(/\n(?=(?:Warning|Error):)/)) {
    const first = block.trim().split('\n')[0];
    if (!first) continue;
    const lineNo = (block.match(/^\s*(\d+)\s*│/m) || [])[1];
    const msg = first.replace(/^(Warning|Error):\s*/, '') + (lineNo ? ` (line ${lineNo})` : '');
    // Units are not loaded (to keep them as written), so the parser cannot
    // validate timer units. That is not a real problem in the recipe.
    if (/Unknown timer unit/i.test(first)) continue;
    (first.startsWith('Error') ? errors : warnings).push(msg);
  }
  return { warnings, errors };
}

// ---------- frontmatter (fast, no WASM needed) ----------

export function readFrontmatter(src) {
  const out = {};
  const text = src.replace(/^﻿/, '');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const lines = m ? m[1].split(/\r?\n/) : [];
  // legacy ">> key: value" metadata
  for (const l of text.split(/\r?\n/)) if (l.startsWith('>>')) lines.push(l.slice(2));
  for (const line of lines) {
    const mm = line.match(/^\s*([A-Za-z][\w .-]*?)\s*:\s*(.*)$/);
    if (!mm) continue;
    const key = mm[1].toLowerCase();
    let val = mm[2].trim();
    if (/^\[.*\]$/.test(val)) {
      val = val.slice(1, -1).split(',').map(s => unquote(s.trim())).filter(Boolean);
    } else {
      val = unquote(val);
    }
    out[key] = val;
  }
  return out;
}

const unquote = (s) => s.replace(/^(['"])(.*)\1$/, '$2');

/** "8h35m", "1h 30m", "45m", "90", "45 minutes" -> minutes (or null) */
export function parseDuration(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v).toLowerCase().replace(/\s+/g, '');
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  let total = 0, hit = false;
  const d = s.match(/(\d+(?:\.\d+)?)d(?:ays?)?/); if (d) { total += d[1] * 1440; hit = true; }
  const h = s.match(/(\d+(?:\.\d+)?)h(?:ours?|rs?)?/); if (h) { total += h[1] * 60; hit = true; }
  const m = s.match(/(\d+(?:\.\d+)?)m(?:in(?:utes?|s)?)?(?![a-z])/); if (m) { total += Number(m[1]); hit = true; }
  return hit ? Math.round(total) : null;
}

export function fmtDuration(min) {
  if (min == null) return '';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  if (h >= 24 && m === 0 && h % 24 === 0) return `${h / 24} day${h / 24 > 1 ? 's' : ''}`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** Ingredient names straight from the source, for search. */
export function ingredientNames(src) {
  const names = new Set();
  const re = /@(?:[?&-]+)?(?:\.\/(?:[^{\n]*\/)?)?([^@#~{}\n]+?)\{|@(?:[?&-]+)?([\p{L}\p{N}_-]+)/gu;
  let m;
  while ((m = re.exec(src))) names.add((m[1] || m[2] || '').trim().toLowerCase());
  names.delete('');
  return [...names];
}

// ---------- quantities ----------

const METRIC = new Set(['g', 'kg', 'mg', 'ml', 'l', 'cl', 'dl', 'cm', 'mm', 'm', '°c', 'c', '%']);
const FRACTIONS = [[1 / 8, '⅛'], [1 / 4, '¼'], [1 / 3, '⅓'], [3 / 8, '⅜'], [1 / 2, '½'], [5 / 8, '⅝'], [2 / 3, '⅔'], [3 / 4, '¾'], [7 / 8, '⅞']];

function numOf(n) {
  if (n == null) return null;
  if (typeof n === 'number') return n;
  if (n.type === 'regular') return Number(n.value);
  if (n.type === 'fraction') {
    const v = n.value || {};
    return (v.whole || 0) + (v.num || 0) / (v.den || 1);
  }
  return null;
}

function decimal(x) {
  if (x >= 100) return String(Math.round(x / 5) * 5);
  if (x >= 10) return String(Math.round(x));
  return String(Math.round(x * 10) / 10);
}

function fraction(x) {
  const whole = Math.floor(x + 1e-9);
  const f = x - whole;
  if (f < 0.04) return String(whole);
  if (f > 0.96) return String(whole + 1);
  let best = null, dist = 1;
  for (const [v, s] of FRACTIONS) { const d = Math.abs(f - v); if (d < dist) { dist = d; best = s; } }
  if (dist > 0.035 || whole >= 10) return decimal(x);
  return (whole ? String(whole) : '') + best;
}

function fmtNumber(x, unit) {
  const u = (unit || '').toLowerCase();
  if (METRIC.has(u)) return decimal(x);
  return fraction(x);
}

/** Bump g->kg and ml->l for big amounts. */
function normalise(x, unit) {
  const u = (unit || '').toLowerCase();
  if (u === 'g' && x >= 1000) return [x / 1000, 'kg'];
  if (u === 'ml' && x >= 1000) return [x / 1000, 'l'];
  return [x, unit];
}

function fmtBig(x, unit) {
  const u = (unit || '').toLowerCase();
  if ((u === 'kg' || u === 'l') && x < 10) return String(Math.round(x * 100) / 100);
  return fmtNumber(x, unit);
}

/** Format a Quantity object as "500 ml", "½ tsp", "2–3", "to taste". */
export function fmtQuantity(q) {
  if (!q) return '';
  const v = q.value;
  if (!v) return q.unit || '';
  if (v.type === 'text') return [v.value, q.unit].filter(Boolean).join(' ');
  let unit = q.unit || '';
  let text;
  if (v.type === 'range') {
    const a = numOf(v.value.start), b = numOf(v.value.end);
    text = `${fmtNumber(a, unit)}–${fmtNumber(b, unit)}`;
  } else {
    let x = numOf(v.value);
    if (x == null) return unit;
    [x, unit] = normalise(x, unit);
    text = fmtBig(x, unit);
  }
  return unit ? `${text} ${unit}` : text;
}

/** Format a grouped quantity (several units possible) as one string. */
export function fmtGrouped(gq) {
  if (!gq) return '';
  const parts = [];
  for (const q of Object.values(gq.known || {})) if (q) parts.push(q);
  for (const q of Object.values(gq.unknown || {})) parts.push(q);
  if (gq.no_unit) parts.push(gq.no_unit);
  for (const q of gq.other || []) parts.push(q);
  return parts.map(fmtQuantity).filter(Boolean).join(' + ');
}

/** Format a plain amount, like a quantity: (1500, "g") -> "1.5 kg". */
export function fmtAmount(n, unit) {
  return fmtQuantity({ value: { type: 'number', value: { type: 'regular', value: n } }, unit: unit || null });
}

// Ranges count as their top end: buy enough for the larger amount.
function amountOf(q) {
  if (!q || !q.value) return q?.unit ? { text: q.unit } : null;
  const v = q.value;
  if (v.type === 'text') return { text: [v.value, q.unit].filter(Boolean).join(' ') };
  const n = v.type === 'range' ? numOf(v.value.end) : numOf(v.value);
  return n == null ? null : { n, unit: q.unit || '' };
}

/**
 * The ingredients to buy for a recipe at `factor`, one entry per ingredient:
 * [{ name, ref, optional, amounts: [{ n, unit } | { text }] }]. `ref` is the
 * path of a linked recipe, if the ingredient is one.
 */
export function shoppingIngredients(src, factor = 1) {
  const { recipe, grouped } = parseRecipe(src, factor);
  if (!recipe) return [];
  const list = grouped.length ? grouped : recipe.ingredients.map((ing, index) => ({ index, single: ing.quantity }));
  const out = [];
  for (const g of list) {
    const ing = recipe.ingredients[g.index];
    if (!ing || !shouldList(ing)) continue;
    const qs = [];
    if (g.quantity) {
      for (const q of Object.values(g.quantity.known || {})) if (q) qs.push(q);
      for (const q of Object.values(g.quantity.unknown || {})) qs.push(q);
      if (g.quantity.no_unit) qs.push(g.quantity.no_unit);
      for (const q of g.quantity.other || []) qs.push(q);
    } else if (g.single) qs.push(g.single);
    const r = ing.reference;
    const ref = r ? [...(r.components || []), r.name].filter((p) => p && p !== '.').join('/') : null;
    out.push({ name: ing.name, ref, optional: /OPT/.test(ing.modifiers || ''), amounts: qs.map(amountOf).filter(Boolean) });
  }
  return out;
}

/** Scale a "10%pancakes" / "1%l" style yield value. */
export function fmtYield(raw, factor) {
  if (!raw) return '';
  const [amount, ...rest] = String(raw).split('%');
  const unit = rest.join('%').trim();
  const n = Number(amount);
  if (!Number.isFinite(n)) return String(raw).replace('%', ' ');
  let [x, u] = normalise(n * factor, unit);
  return `${fmtBig(x, u)}${u ? ' ' + u : ''}`;
}
