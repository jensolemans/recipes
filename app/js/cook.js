// Cook mode (#/cook/<path>). Step 0 is the mise en place (servings,
// ingredients and tools as ticks, shared with the recipe page), then one step
// at a time in big type (swipe, buttons, arrow keys) or every step in one
// column. The bar at the bottom has a pill per step, grouped and labelled by
// the recipe's == Section == chapters. Wake Lock keeps the screen on.
// Loaded when first opened.

import { fmtQuantity, initParser, parseRecipe } from './cooklang.js';
import * as drive from './drive.js';
import { openChoose } from './choose.js';
import { BULB_ICON, CARDS_ICON, CHECK_ICON, CLOSE_ICON, LEFT_ICON, LIST_ICON, RIGHT_ICON } from './icons.js';
import { go, parseHash } from './app.js';
import { markCooked } from './planner.js';
import { baseServings, cookSteps, ingItems, ingLines, ingName, sortToggle, wireSort } from './recipe.js';
import { S } from './state.js';
import { wireTimerChips } from './timers.js';
import { $, $$, encPath, esc, lc, saved } from './util.js';

/** Everything to get out, with the same keys as the ticks on the recipe page. */
function cookList(parsed, steps) {
  const { recipe } = parsed;
  const toolName = (c) => (c.alias || c.name).toLowerCase();
  // Which steps use each thing, matched by name, for the desktop list.
  const usedIn = (test) => steps.map((s, i) => (test(s) ? i + 1 : 0)).filter(Boolean);
  const ings = ingItems(parsed).map((x) => ({ ...x, steps: usedIn((s) => s.ings.some((i) => lc(ingName(i)) === lc(x.name))) }));
  const tools = [];
  const seen = new Set();
  for (const c of recipe.cookware || []) {
    if (c.relation && c.relation.type === 'reference') continue;
    const n = toolName(c);
    if (seen.has(n)) continue;
    seen.add(n);
    tools.push({ key: `tool:${n}`, name: c.alias || c.name, qty: c.quantity ? fmtQuantity(c.quantity) : '', steps: usedIn((s) => s.tools.some((x) => toolName(x) === n)) });
  }
  return { ings, tools };
}

let wakeLock = null;
const canWake = () => 'wakeLock' in navigator;
export async function keepAwake(on) {
  if (!canWake()) return;
  try {
    if (on && !wakeLock && !document.hidden) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      const l = wakeLock;
      wakeLock = null;
      await l.release();
    }
  } catch { wakeLock = null; }
}

let cookKeys = null;
let cookScroll = null;

export async function showCook(rawPath, params) {
  const path = rawPath;
  const e = S.recipes.get(path);
  document.body.dataset.view = 'cook';
  if (!e) {
    $('#main').innerHTML = `<div class="empty"><h1>Recipe not found</h1><p>It may have been moved or renamed.</p><a class="btn btn-quiet" href="#/">All recipes</a></div>`;
    return;
  }
  document.title = `${e.title} | ${S.config.title || 'Recipes'}`;
  $('#main').innerHTML = '<p class="loading">Loading…</p>';
  await initParser();
  if (parseHash().path !== `/cook/${path}`) return;

  const base = baseServings(e);
  const fromLink = (v, min, max) => (Number.isFinite(Number(v)) && Number(v) >= min && Number(v) <= max ? Number(v) : null);
  let servings = fromLink(params.get('s'), 1, 100) ?? base;
  let mult = fromLink(params.get('x'), 0.25, 10) ?? 1;
  let at = fromLink(params.get('step'), 0, 999) ?? 0;
  const planId = params.get('plan'); // opened from the plan: Finish ticks that meal
  let mode = saved.get('cookMode', 'steps') === 'scroll' ? 'scroll' : 'steps';
  let awake = saved.get('cookAwake', true);
  const checked = S.checked.get(path) || new Set();
  S.checked.set(path, checked);

  let parsed, steps, list;
  const parse = () => {
    parsed = parseRecipe(e.src, base ? servings / base : mult);
    steps = parsed.recipe ? cookSteps(parsed.recipe) : [];
    list = parsed.recipe ? cookList(parsed, steps) : { ings: [], tools: [] };
    at = Math.min(at, steps.length);
  };
  const query = (withStep) => {
    const q = new URLSearchParams();
    if (base && servings !== base) q.set('s', String(servings));
    if (!base && mult !== 1) q.set('x', String(mult));
    if (withStep && at) q.set('step', String(at));
    return q.toString() ? '?' + q : '';
  };
  const backHash = () => `#/r/${encPath(path)}${query(false)}`;

  $('#main').innerHTML = `
    <div class="cook" id="cook">
      <header class="cook-top">
        <div class="cook-top-l">
          ${canWake() ? `<button class="cook-icon" id="cook-awake" type="button">${BULB_ICON}</button>` : ''}
          <button class="cook-icon" id="cook-mode" type="button"></button>
        </div>
        <span class="cook-title">${esc(e.title)}</span>
        <div class="cook-top-r"><a class="cook-icon" id="cook-close" href="${backHash()}" title="Close cook mode (Esc)" aria-label="Close cook mode">${CLOSE_ICON}</a></div>
      </header>
      <div class="cook-main">
        <aside class="cook-side" id="cook-side" aria-label="Ingredients"></aside>
        <div class="cook-stage" id="cook-stage"></div>
      </div>
      <footer class="cook-foot" id="cook-foot"></footer>
    </div>`;
  const root = $('#cook'), stage = $('#cook-stage'), foot = $('#cook-foot'), side = $('#cook-side');

  const ingLine = (qty, name, note = '') => `<li>${qty ? `<b>${esc(qty)}</b> ` : ''}${esc(name)}${note ? ` <span class="ing-note">${esc(note)}</span>` : ''}</li>`;

  const stepHTML = (s) => `
    ${s.chapter ? `<p class="cook-chapter">${esc(s.chapter)}</p>` : ''}
    ${s.notes.map((n) => `<p class="note">${esc(n)}</p>`).join('')}
    <p class="cook-text">${s.html}</p>
    ${s.after.map((n) => `<p class="note">${esc(n)}</p>`).join('')}
    ${s.ings.length || s.tools.length ? `<ul class="cook-sum">
      ${s.ings.map((ing) => ingLine(fmtQuantity(ing.quantity), ingName(ing), ing.note)).join('')}
      ${s.tools.map((c) => `<li class="is-tool">${esc(c.alias || c.name)}</li>`).join('')}
    </ul>` : ''}`;

  const readyText = () => {
    const all = [...list.ings, ...list.tools];
    return `${all.filter((x) => checked.has(x.key)).length} of ${all.length} ready`;
  };
  const tickRow = (x, tool) => `<li class="ing-row${tool ? ' tool-row' : ''}${checked.has(x.key) ? ' is-checked' : ''}" data-key="${esc(x.key)}">
      <input type="checkbox" class="tick" aria-label="Got ${esc(x.name)}" ${checked.has(x.key) ? 'checked' : ''}>
      ${tool ? '' : `<span class="ing-qty">${esc(x.qty)}</span>`}
      <span class="ing-name">${esc(x.name)}${x.note ? ` <span class="ing-note">${esc(x.note)}</span>` : ''}${x.optional ? ' <span class="ing-note">optional</span>' : ''}${tool && x.qty ? ` <span class="ing-note">${esc(x.qty)}</span>` : ''}</span>
    </li>`;
  const miseHTML = () => `
    <div class="cook-mise">
      <h1>Mise en place</h1>
      <div class="mise-meta"><div class="scaler" id="cook-scaler"></div><span id="mise-count">${readyText()}</span></div>
      ${list.ings.length ? `<div class="ing-head"><h2>Ingredients</h2>${sortToggle()}</div><div class="ing-lines">${ingLines(list.ings, checked, { links: false })}</div>` : ''}
      ${list.tools.length ? `<h2>Tools</h2><ul class="ing-list tool-list">${list.tools.map((x) => tickRow(x, true)).join('')}</ul>` : ''}
    </div>`;

  // Every step in full in one column: the one at the top of the screen is the
  // current one and the page snaps to it, with the next one below.
  const flowHTML = () => {
    const out = [`<li class="cf-step cf-mise" data-at="0">${miseHTML()}</li>`];
    let chapter = '';
    steps.forEach((s, i) => {
      const n = i + 1;
      if (s.chapter && s.chapter !== chapter) out.push(`<li class="cf-chapter">${esc(s.chapter)}</li>`);
      chapter = s.chapter;
      out.push(`<li class="cf-step" data-at="${n}"><p class="cook-count">Step ${n} of ${steps.length}</p>${stepHTML({ ...s, chapter: '' })}</li>`);
    });
    return `<ol class="cook-flow">${out.join('')}</ol>`;
  };

  // The progress bar: a short pill for the mise en place, then one per step,
  // grouped and labelled by chapter when the recipe has them.
  const barHTML = () => {
    const groups = [];
    steps.forEach((s, i) => {
      const last = groups[groups.length - 1];
      if (last && last.chapter === s.chapter) last.items.push(i + 1);
      else groups.push({ chapter: s.chapter, items: [i + 1] });
    });
    const labels = steps.some((s) => s.chapter);
    const pill = (n, label) => `<button class="cb-pill${n < at ? ' is-done' : n === at ? ' is-now' : ''}" data-at="${n}" aria-label="${esc(label)}"${n === at ? ' aria-current="step"' : ''}></button>`;
    return `<div class="cook-bar${labels ? ' has-labels' : ''}">
      <div class="cb-group cb-mise">${pill(0, 'Mise en place')}</div>
      ${groups.map((g) => `<div class="cb-group" style="flex:${g.items.length}">
        <div class="cb-pills">${g.items.map((n) => pill(n, `Step ${n}`)).join('')}</div>
        ${labels ? `<span class="cb-label${g.items.includes(at) ? ' is-now' : ''}">${esc(g.chapter)}</span>` : ''}
      </div>`).join('')}
    </div>`;
  };

  const footHTML = () => {
    const last = at >= steps.length;
    return `${barHTML()}
      <div class="cook-nav">
        <button class="cook-arrow${at === 0 ? ' is-hidden' : ''}" id="cook-prev" aria-label="Previous step" ${at === 0 ? 'tabindex="-1"' : ''}>${LEFT_ICON}<span>Back</span></button>
        <span class="cook-where">${at === 0 ? 'Before you start' : `${at} of ${steps.length}`}</span>
        <button class="cook-arrow is-primary" id="cook-next" aria-label="${last ? 'Finish' : 'Next step'}">${last ? `<span>Finish</span>${CHECK_ICON}` : `<span>Next</span>${RIGHT_ICON}`}</button>
      </div>`;
  };

  // Desktop: the whole list beside the step, ticking off what is behind you.
  const sideHTML = () => {
    const row = (x, qty) => {
      const now = x.steps.includes(at);
      const used = !now && x.steps.length && Math.max(...x.steps) < at;
      return `<li class="${now ? 'is-now' : used ? 'is-used' : ''}">${qty && x.qty ? `<b>${esc(x.qty)}</b> ` : ''}${esc(x.name)}</li>`;
    };
    return `${list.ings.length ? `<h2>Ingredients</h2><ul>${list.ings.map((x) => row(x, true)).join('')}</ul>` : ''}
      ${list.tools.length ? `<h2>Tools</h2><ul>${list.tools.map((x) => row(x, false)).join('')}</ul>` : ''}`;
  };

  const drawScaler = () => {
    const el = $('#cook-scaler');
    if (!el) return;
    if (base) {
      el.innerHTML = `
        <button class="step-btn" data-d="-1" aria-label="Fewer servings" ${servings <= 1 ? 'disabled' : ''}>−</button>
        <output aria-live="polite"><b>${servings}</b> ${servings === 1 ? 'serving' : 'servings'}</output>
        <button class="step-btn" data-d="1" aria-label="More servings">+</button>`;
      el.querySelectorAll('[data-d]').forEach((b) => { b.onclick = () => { servings = Math.max(1, servings + Number(b.dataset.d)); parse(); render(); }; });
    } else {
      el.innerHTML = `<span class="scaler-label">Amount</span>${[0.5, 1, 2, 3].map((m) => `<button class="mult" aria-pressed="${mult === m}" data-m="${m}">${m === 0.5 ? '½' : m}×</button>`).join('')}`;
      el.querySelectorAll('[data-m]').forEach((b) => { b.onclick = () => { mult = Number(b.dataset.m); parse(); render(); }; });
    }
  };

  const syncHash = () => {
    const h = `#/cook/${encPath(path)}${query(true)}`;
    if (location.hash !== h) { history.replaceState(null, '', h); S.currentHash = h; }
    $('#cook-close').href = backHash();
  };

  // Scroll mode: put a step at the top, just under the top bar; the scroll
  // itself makes it the current step. Snapping is off during the glide, as
  // some browsers (Safari) otherwise stop it or pull it back to where it was.
  const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  let glide = null;
  const land = () => {
    if (!glide) return;
    clearTimeout(glide.timer);
    removeEventListener('scrollend', glide.end);
    glide = null;
    root.classList.remove('is-gliding');
  };
  const scrollToStep = (n, smooth = true) => {
    const li = $(`.cf-step[data-at="${n}"]`, stage);
    if (!li) return;
    const top = Math.max(0, Math.round(scrollY + li.getBoundingClientRect().top - $('.cook-top', root).offsetHeight));
    land();
    if (!smooth || calm()) { window.scrollTo({ top }); return; }
    root.classList.add('is-gliding');
    // Done when the page stops at the step (or can go no further), or after
    // a while for browsers without scrollend.
    const end = () => { if (Math.abs(scrollY - top) < 2 || scrollY + innerHeight >= document.documentElement.scrollHeight - 1) land(); };
    glide = { end, timer: setTimeout(land, 1500) };
    addEventListener('scrollend', end);
    window.scrollTo({ top, behavior: 'smooth' });
  };

  // The last step whose top has come up to the top bar (give or take a
  // little), so a short step at the top is never passed over for the one
  // below it. A tall step stays current while you read down it.
  const topStep = () => {
    const line = $('.cook-top', root).offsetHeight + 48;
    let best = 0;
    for (const li of $$('.cf-step', stage)) {
      if (li.getBoundingClientRect().top > line) break;
      best = Number(li.dataset.at);
    }
    return best;
  };

  // Scroll mode: show the new current step without redrawing the steps.
  const mark = () => {
    $$('.cf-step', stage).forEach((li) => {
      const n = Number(li.dataset.at);
      li.classList.toggle('is-now', n === at);
      li.classList.toggle('is-done', n < at);
      li.classList.toggle('is-next', n === at + 1);
    });
    side.innerHTML = sideHTML();
    foot.innerHTML = footHTML();
    wireFoot();
    syncHash();
  };

  // Finish: back to the recipe, and when it can be changed here, first ask
  // what to improve for next time while it is fresh.
  const finish = () => {
    if (!(drive.enabled() && drive.wasSignedIn())) { go(backHash()); return; }
    markCooked(path, planId);
    const dlg = $('#choose');
    openChoose($('#cook-next'), path, true, true);
    // Edit the file has already moved on; the rest go back.
    dlg.addEventListener('close', () => { if (parseHash().path === `/cook/${path}`) go(backHash()); }, { once: true });
  };

  const go2 = (n, dir = 0) => {
    if (n > steps.length) { finish(); return; }
    if (mode === 'scroll') { scrollToStep(Math.max(0, n)); return; }
    at = Math.max(0, n);
    render(dir, true);
  };

  const render = (dir = 0, moved = false) => {
    root.dataset.mode = mode;
    root.classList.toggle('is-mise', at === 0);
    const awakeBtn = $('#cook-awake');
    if (awakeBtn) {
      awakeBtn.setAttribute('aria-pressed', String(awake));
      awakeBtn.title = awake ? 'Screen stays on' : 'Keep the screen on';
      awakeBtn.setAttribute('aria-label', awakeBtn.title);
    }
    const modeBtn = $('#cook-mode');
    modeBtn.innerHTML = mode === 'steps' ? LIST_ICON : CARDS_ICON;
    modeBtn.title = mode === 'steps' ? 'Show all steps' : 'One step at a time';
    modeBtn.setAttribute('aria-label', modeBtn.title);

    side.innerHTML = sideHTML();
    if (mode === 'steps') {
      stage.innerHTML = `<div class="cook-card${dir > 0 ? ' from-right' : dir < 0 ? ' from-left' : ''}">${at ? stepHTML(steps[at - 1]) : miseHTML()}</div>`;
    } else stage.innerHTML = flowHTML();
    foot.innerHTML = footHTML();
    const html = document.documentElement.style;
    html.setProperty('--cook-top', `${$('.cook-top', root).offsetHeight}px`);
    html.setProperty('--cook-foot', `${foot.offsetHeight}px`);
    drawScaler();
    wire();
    syncHash();
    if (mode === 'scroll') { mark(); scrollToStep(at, false); } else if (moved) window.scrollTo({ top: 0 });
  };

  const wireFoot = () => {
    $$('.cb-pill', foot).forEach((b) => { b.onclick = () => { const n = Number(b.dataset.at); go2(n, Math.sign(n - at)); }; });
    const prev = $('#cook-prev');
    if (prev) prev.onclick = () => go2(at - 1, -1);
    const next = $('#cook-next');
    if (next) next.onclick = () => go2(at + 1, 1);
  };

  const wireTicks = () => $$('.ing-row', stage).forEach((row) => {
    const box = row.querySelector('.tick');
    const set = () => {
      box.checked ? checked.add(row.dataset.key) : checked.delete(row.dataset.key);
      row.classList.toggle('is-checked', box.checked);
      const c = $('#mise-count');
      if (c) c.textContent = readyText();
    };
    box.onchange = set;
    row.onclick = (ev) => { if (ev.target === box) return; box.checked = !box.checked; set(); };
  });

  const wire = () => {
    wireTicks();
    wireSort(stage, () => { $('.ing-lines', stage).innerHTML = ingLines(list.ings, checked, { links: false }); wireTicks(); });
    if (mode === 'steps') wireTimerChips(stage, e.path, `${e.title}, step ${at}`);
    else $$('.cf-step', stage).forEach((li) => wireTimerChips(li, e.path, `${e.title}, step ${li.dataset.at}`));
    wireFoot();
  };

  // Scroll mode: a tap on a faded step brings it to the top instead of
  // ticking or starting what is in it.
  stage.addEventListener('click', (ev) => {
    const li = mode === 'scroll' && ev.target.closest('.cf-step');
    if (!li || li.classList.contains('is-now')) return;
    ev.preventDefault();
    ev.stopPropagation();
    scrollToStep(Number(li.dataset.at));
  }, true);

  // Scroll mode: whichever step comes up to the top becomes the current one.
  if (cookScroll) removeEventListener('scroll', cookScroll);
  let frame = 0;
  cookScroll = () => {
    if (!root.isConnected) { removeEventListener('scroll', cookScroll); cookScroll = null; return; }
    if (mode !== 'scroll' || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const n = topStep();
      if (n !== at) { at = n; mark(); }
    });
  };
  addEventListener('scroll', cookScroll, { passive: true });

  const awakeBtn = $('#cook-awake');
  if (awakeBtn) awakeBtn.onclick = () => { awake = !awake; saved.set('cookAwake', awake); keepAwake(awake); render(); };
  $('#cook-mode').onclick = () => { mode = mode === 'steps' ? 'scroll' : 'steps'; saved.set('cookMode', mode); render(); };

  // Swipe left and right between steps on a touch screen.
  let touch = null;
  stage.addEventListener('touchstart', (ev) => { const t = ev.touches[0]; touch = { x: t.clientX, y: t.clientY }; }, { passive: true });
  stage.addEventListener('touchend', (ev) => {
    if (!touch || mode !== 'steps') return;
    const t = ev.changedTouches[0];
    const dx = t.clientX - touch.x, dy = t.clientY - touch.y;
    touch = null;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    if (dx < 0 && at < steps.length) go2(at + 1, 1);
    else if (dx > 0 && at > 0) go2(at - 1, -1);
  });

  if (cookKeys) document.removeEventListener('keydown', cookKeys);
  cookKeys = (ev) => {
    if (document.body.dataset.view !== 'cook' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.target.closest('input, textarea, select, [contenteditable]') || $('#modal').open) return;
    const k = ev.key;
    if (k === 'ArrowRight' || k === 'PageDown' || (k === ' ' && !ev.target.closest('button, a'))) { ev.preventDefault(); if (at < steps.length) go2(at + 1, 1); }
    else if (k === 'ArrowLeft' || k === 'PageUp') { ev.preventDefault(); if (at > 0) go2(at - 1, -1); }
    else if (k === 'Escape') go(backHash());
    else if (k.toLowerCase() === 't') {
      const chip = $(mode === 'steps' ? '.timer-chip[data-secs]' : '.cf-step.is-now .timer-chip[data-secs]', stage);
      if (chip) { ev.preventDefault(); chip.click(); }
    }
  };
  document.addEventListener('keydown', cookKeys);

  parse();
  window.scrollTo({ top: 0 });
  render();
  keepAwake(awake);
}
