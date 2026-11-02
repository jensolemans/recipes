// Small helpers every module uses: DOM lookups, escaping, text folding,
// per-device storage and the screen-width breakpoints.

export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
export const lc = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');
export const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
export const chapterLabel = (folder) => folder.replace(/^\d+\s*[-_.]?\s*/, '');
export const folderLabel = (path) => path.split('/').map(chapterLabel).join(' / ');
export const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');
export const prettifyFile = (f) => cap(f.replace(/[_-]+/g, ' ').trim());
export const slugify = (s) => fold(s).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
export const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.JPG', '.JPEG', '.PNG'];
export const SKIP_TOP = /^(config|tools)(\/|$)/;

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export async function pool(tasks, size = 6) {
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

export const saved = {
  get(k, d) { try { const v = localStorage.getItem('recipes.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('recipes.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

// Bigger than a phone: menus and panels instead of bottom sheets.
export const wideBrowse = matchMedia('(min-width: 701px)');
// Room for the side panel beside the recipes.
export const wide = window.matchMedia('(min-width: 1100px)');
