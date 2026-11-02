// Share: a bottom sheet on phones (link, ingredients, whole recipe as
// text) and a centred card with a QR code on bigger screens. The link
// carries the scale. Loaded when first opened.

import { fmtDuration, fmtGrouped, fmtQuantity, shouldList } from './cooklang.js';
import { qrSvg } from './qr.js';
import { BULLETS_ICON, CLOSE_ICON, LINK_ICON, TEXT_ICON } from './icons.js';
import { ingName } from './recipe.js';
import { toast } from './ui.js';
import { $, $$, esc, wide, wideBrowse } from './util.js';

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
export function openShare(e, parsed, size) {
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
