// Shared pieces of interface: menus that close on a tap outside, the toast
// and the modal questions (ask, askText, pick, chooseParts).

import { TOAST_ICONS } from './icons.js';
import { $, $$, esc } from './util.js';

// The account menu and the recipe's ⋯ menu close on a tap outside them or Escape.
export function closeMenus(except) {
  $$('details.menu[open]').forEach((d) => { if (d !== except) d.open = false; });
}
document.addEventListener('click', (ev) => closeMenus(ev.target.closest('details.menu')));
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeMenus(); });
let toastTimer;
/** Shows a short message with a close button, optionally with one action such as Undo. */
export function toast(msg, action) {
  const el = $('#toast');
  const icon = action && TOAST_ICONS[action.label];
  el.innerHTML = `<span class="toast-msg">${esc(msg)}</span>${action ? `<button class="toast-btn">${icon ? `<svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>` : ''}${esc(action.label)}</button>` : ''}<button class="toast-x" aria-label="Close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg></button>`;
  const hide = () => { clearTimeout(toastTimer); el.classList.remove('is-on'); };
  if (action) el.querySelector('.toast-btn').onclick = () => { hide(); action.run(); };
  el.querySelector('.toast-x').onclick = hide;
  // A swipe up puts it away too.
  el.ontouchstart = (e) => { el.dataset.y = e.touches[0].clientY; };
  el.ontouchend = (e) => { if (el.dataset.y - e.changedTouches[0].clientY > 24) hide(); };
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hide, action ? 7000 : 5200);
}

export function ask({ title, body, actions }) {
  const dlg = $('#modal');
  dlg.innerHTML = `<form method="dialog">
    <h2>${esc(title)}</h2>
    <p>${esc(body)}</p>
    <div class="modal-actions">${actions.map((a, i) => `<button value="${i}" class="btn ${a.danger ? 'btn-danger-solid' : a.primary ? 'btn-primary' : 'btn-quiet'}">${esc(a.label)}</button>`).join('')}</div>
  </form>`;
  return new Promise((resolve) => {
    dlg.onclose = () => {
      const i = Number(dlg.returnValue);
      resolve(Number.isInteger(i) && actions[i] ? actions[i].value : actions[0].value);
      dlg.returnValue = '';
    };
    dlg.showModal();
  });
}

/**
 * Asks which parts of a recipe to shop for. Resolves with the chosen part
 * names, or undefined when cancelled. `before` ticks an earlier choice.
 */
export function chooseParts(title, parts, before) {
  const dlg = $('#modal');
  const on = (p) => !before || before.includes(p.name);
  dlg.innerHTML = `<form method="dialog" class="parts">
    <h2>Add ${esc(title)}</h2>
    <p>This recipe has parts. Untick the ones you are not making.</p>
    <ul class="parts-list">${parts.map((p, i) => `<li><label>
      <input type="checkbox" class="tick" value="${i}" ${on(p) ? 'checked' : ''}>
      <span><b>${esc(p.name)}</b><small>${esc(p.ingredients.join(', '))}</small></span>
    </label></li>`).join('')}</ul>
    <div class="modal-actions"><button value="cancel" class="btn btn-quiet">Cancel</button><button value="ok" class="btn btn-primary" id="parts-ok">Add to list</button></div>
  </form>`;
  const boxes = $$('.parts-list input', dlg);
  const update = () => { $('#parts-ok', dlg).disabled = !boxes.some((b) => b.checked); };
  boxes.forEach((b) => { b.onchange = update; });
  update();
  return new Promise((resolve) => {
    dlg.onclose = () => {
      resolve(dlg.returnValue === 'ok' ? boxes.filter((b) => b.checked).map((b) => parts[Number(b.value)].name) : undefined);
      dlg.returnValue = '';
    };
    dlg.showModal();
  });
}

/** Asks for one line of text. Resolves with it, or null when cancelled or empty. */
export function askText({ title, body, label, placeholder = '' }) {
  const dlg = $('#modal');
  dlg.innerHTML = `<form method="dialog">
    <h2>${esc(title)}</h2>
    <p>${esc(body)}</p>
    <label class="field modal-field"><span>${esc(label)}</span>
      <input id="ask-text" type="url" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false">
    </label>
    <div class="modal-actions"><button value="cancel" class="btn btn-quiet">Cancel</button><button value="ok" class="btn btn-primary">Add</button></div>
  </form>`;
  return new Promise((resolve) => {
    dlg.onclose = () => {
      const v = $('#ask-text', dlg).value.trim();
      resolve(dlg.returnValue === 'ok' && v ? v : null);
      dlg.returnValue = '';
    };
    dlg.showModal();
    $('#ask-text', dlg).focus();
  });
}

/** Asks to choose one option from a list. Resolves with its index, or null. */
export function pick({ title, body, label, options, value = -1 }) {
  const dlg = $('#modal');
  dlg.innerHTML = `<form method="dialog">
    <h2>${esc(title)}</h2>
    <p>${esc(body)}</p>
    <label class="field modal-field"><span>${esc(label)}</span>
      <select id="pick">${options.map((o, i) => `<option value="${i}"${i === value ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>
    </label>
    <div class="modal-actions"><button value="cancel" class="btn btn-quiet">Cancel</button><button value="ok" class="btn btn-primary">Save</button></div>
  </form>`;
  return new Promise((resolve) => {
    dlg.onclose = () => {
      resolve(dlg.returnValue === 'ok' ? Number($('#pick', dlg).value) : null);
      dlg.returnValue = '';
    };
    dlg.showModal();
  });
}
