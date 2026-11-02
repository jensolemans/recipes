// From 1100 px the list and plan sit on the right: a slim rail, a panel
// beside the recipes, or the whole page, with a button at the top of each to
// step between them. Rail or panel is remembered per device; the editor keeps
// it a rail for the space. L toggles it.
// Narrower, signed in, Recipes, Shopping list and New sit in a tab bar at the
// bottom, in reach of a thumb. The editor hides it to leave room to write.

import * as drive from './drive.js';
import { claudeLink } from './choose.js';
import { BASKET_ICON, CAL_ICON, CHEF_ICON, PANEL_ICON, PLUS_ICON } from './icons.js';
import { built, listPoll, mountList, startListPolling, stopListPolling, toBuy } from './list.js';
import { go, parseHash } from './app.js';
import { canPlan } from './planner.js';
import { planView } from './lazy.js';
import { S } from './state.js';
import { $, $$, saved, wide } from './util.js';

export const sideToggle = (on, attr = 'data-side-tab') => `<div class="seg side-tabs" role="group" aria-label="Show">
  <button type="button" ${attr}="plan" aria-pressed="${on === 'plan'}" title="Plan (P)" aria-label="Plan">${CAL_ICON}</button>
  <button type="button" ${attr}="list" aria-pressed="${on === 'list'}" title="Shopping list (L)" aria-label="Shopping list"${attr === 'data-side-tab' ? ' data-drop="list"' : ''}>${BASKET_ICON}</button></div>`;

/** From the full list page back to the panel beside the page you came from. */
export function listToSide() {
  saved.set('sidePanel', 'open');
  saved.set('sideTab', 'list');
  go(S.lastPage || '#/');
}

export function sideMode() {
  if (!wide.matches || !S.shop || !drive.wasSignedIn()) return 'off';
  const { path } = parseHash();
  if (path === '/list' || path === '/plan' || path.startsWith('/cook/')) return 'off';
  if (path === '/new' || path.startsWith('/edit/')) return 'rail';
  return saved.get('sidePanel', 'closed') === 'open' ? 'open' : 'rail';
}

export function setSide(state) {
  saved.set('sidePanel', state);
  renderSide();
}

// The open panel shows the plan or the shopping list.
const sideTab = () => (saved.get('sideTab', 'list') === 'plan' && canPlan() ? 'plan' : 'list');
export function showSideTab(tab) {
  if (sideTab() === tab && sideMode() === 'open') return;
  saved.set('sideTab', tab);
  saved.set('sidePanel', 'open');
  renderSide();
}

export function renderSide() {
  const el = $('#side');
  const mode = sideMode();
  document.body.classList.toggle('has-side', mode !== 'off');
  document.body.classList.toggle('side-open', mode === 'open');
  el.hidden = mode === 'off';
  el.setAttribute('aria-label', mode === 'open' && sideTab() === 'plan' ? 'Plan' : canPlan() ? 'Plan and shopping list' : 'Shopping list');
  if (mode === 'open') {
    const tab = sideTab();
    const there = tab === 'plan' ? $('#plan-root', el) : $('.shop-panel', el);
    if (!there) { if (tab === 'plan') planView().then((v) => v.mountPlan(el, 'panel')); else mountList(el, true); }
    else if (!listPoll) startListPolling(); // a page change stopped it
    return;
  }
  if ($('.shop-panel', el) || $('#plan-root', el)) stopListPolling();
  if (mode === 'off') { el.innerHTML = ''; return; }
  const n = toBuyCount();
  el.innerHTML = `<div class="rail">
    <button class="rail-top" id="rail-open" type="button" title="Open the panel" aria-label="Open the panel">${PANEL_ICON}</button>
    ${canPlan() ? `<button class="rail-btn" id="rail-plan" type="button" data-drop="rail" title="Plan (P)" aria-label="Open the plan">${CAL_ICON}<span class="rail-label">Plan</span></button>` : ''}
    <button class="rail-btn" id="rail" type="button" data-drop="list" title="Shopping list (L)" aria-label="Open the shopping list${n ? `, ${n} to buy` : ''}">
      ${BASKET_ICON}${n ? `<span class="badge">${n}</span>` : ''}<span class="rail-label">Shopping list</span>
    </button></div>`;
  $('#rail').onclick = () => showSideTab('list');
  // The toggle on top opens the panel as it was last: the plan or the list.
  $('#rail-open').onclick = () => showSideTab(sideTab());
  const rp = $('#rail-plan');
  if (rp) rp.onclick = () => showSideTab('plan');
}

export function toBuyCount() {
  if (!S.parserReady) return 0;
  try { return [...built().groups.values()].filter((g) => toBuy(g) && !g.checked).length; } catch { return 0; }
}

export function renderTabbar() {
  const el = $('#tabbar');
  const { path } = parseHash();
  const show = !wide.matches && S.shop && drive.wasSignedIn() && path !== '/new' && !path.startsWith('/edit/') && !path.startsWith('/cook/');
  document.body.classList.toggle('has-tabbar', Boolean(show));
  el.hidden = !show;
  if (!show) { el.innerHTML = ''; return; }
  const n = toBuyCount();
  const tab = (href, icon, label, on, extra = '', cls = '') => `<a class="tab${cls}" ${href.startsWith('#') ? `href="${href}"` : href}${on ? ' aria-current="page"' : ''}>${icon}<span>${label}</span>${extra}</a>`;
  el.innerHTML = [
    tab('#/', CHEF_ICON, 'Recipes', path !== '/list' && path !== '/plan'),
    tab('#/plan', CAL_ICON, 'Plan', path === '/plan'),
    tab('#/list', BASKET_ICON, 'List', path === '/list', n ? `<span class="badge" aria-label="${n} to buy">${n}</span>` : ''),
    tab(claudeLink(), PLUS_ICON, 'New', false),
  ].join('');
}

export function initSide() {
  wide.addEventListener('change', () => { renderSide(); renderTabbar(); if (parseHash().path === '/plan') planView().then((v) => v.showPlanPage()); });
  // L for the list and P for the plan: open it, switch to it, or close it.
  document.addEventListener('keydown', (ev) => {
    const k = ev.key.toLowerCase();
    if ((k !== 'l' && k !== 'p') || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.target.closest('input, textarea, select, [contenteditable]') || $$('dialog[open]').length) return;
    const want = k === 'p' ? 'plan' : 'list';
    if (want === 'plan' && !canPlan()) return;
    const path = parseHash().path;
    if (wide.matches && path === '/list' && $('#to-side')) { ev.preventDefault(); if (want === 'list') listToSide(); else go('#/plan'); return; }
    if (wide.matches && path === '/plan') { ev.preventDefault(); if (want === 'plan') $('[data-act="to-side"]')?.click(); else go('#/list'); return; }
    if (sideMode() === 'off') return;
    ev.preventDefault();
    if (sideMode() === 'open' && sideTab() === want) setSide('closed');
    else showSideTab(want);
  });
}
