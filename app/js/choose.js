// New and Edit ask how: Ask Claude opens a Claude chat with the start of the
// request typed in (Claude writes the recipe with the cooklang-recipe skill
// and saves it to Drive through the recipes connector), or the editor.
// Without the connector (no authUrl) they open the editor straight away;
// offline, or when it does not answer, the editor comes first.
// A bottom sheet on phones, a small menu by the button on bigger screens.

import { CHECK_ICON, CLOSE_ICON, FILE_ICON, OFFLINE_ICON, PHOTO_ICON, SPARK_ICON } from './icons.js';
import { parseHash } from './app.js';
import { editorView } from './lazy.js';
import { S } from './state.js';
import { closeMenus } from './ui.js';
import { $, $$, encPath, esc, wideBrowse } from './util.js';

//
// New and Edit ask how: Ask Claude opens a Claude chat with the start of the
// request typed in (Claude writes the recipe with the cooklang-recipe skill
// and saves it to Drive through the recipes connector), or the editor.
// Without the connector (no authUrl) they open the editor straight away;
// offline, or when it does not answer, the editor comes first.

const CLAUDE_NEW = 'https://claude.ai/new?q=';
let connector = 'unknown'; // unknown | up | down
let connectorChecked = 0;

/** Looks whether the connector answers, at most once a minute unless `again`. */
export async function checkConnector(again = false) {
  if (again) connectorChecked = 0;
  if (!S.config.authUrl || !navigator.onLine || Date.now() - connectorChecked < 60_000) return;
  connectorChecked = Date.now();
  try {
    // Any answer will do; the Worker does not send CORS headers for its home page.
    await fetch(S.config.authUrl, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(5000) });
    connector = 'up';
  } catch {
    connector = 'down';
  }
}

/** Why Claude can't take New or Edit right now, or '' when it can. */
function noClaude() {
  if (!S.config.authUrl) return 'none';
  if (!navigator.onLine) return "You're offline. It works again once you're back online.";
  if (connector === 'down') return "The recipes connector isn't answering right now.";
  return '';
}

/** The folder a new recipe probably goes in: the recipe or folder being looked at. */
function currentFolder() {
  const { path } = parseHash();
  const at = path.startsWith('/r/') ? path.slice(3) : path.startsWith('/cook/') ? path.slice(6) : null;
  if (at != null) return S.recipes.get(at)?.folder || '';
  return [S.filters.chapter, S.filters.sub].filter(Boolean).join('/');
}

function claudeText(path, after = false) {
  if (path && after) return `I just cooked my recipe ${path}.cook. Improve it with what I noticed: `;
  if (path) return `Change my recipe ${path}.cook: `;
  const folder = currentFolder();
  return folder ? `New recipe for my collection, probably for ${folder}. ` : 'New recipe for my collection. ';
}

/** Attributes for a New (no path) or Edit link; `after` asks what to improve after cooking. */
export function claudeLink(path = null, after = false) {
  const editor = path ? `#/edit/${encPath(path)}` : '#/new';
  if (noClaude() === 'none') return `href="${editor}"`;
  return `href="${esc(CLAUDE_NEW + encodeURIComponent(claudeText(path, after)))}" target="_blank" rel="noopener" data-claude="${esc(path || '')}"${after ? ' data-after' : ''}`;
}

// One handler for every New and Edit button: it asks how.
document.addEventListener('click', (ev) => {
  const a = ev.target.closest('a[data-claude]');
  if (!a || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
  ev.preventDefault();
  closeMenus();
  // Edit picked from the recipe's ⋯ menu: the menu is the place to open by.
  const at = a.offsetParent ? a : a.closest('.action-btns')?.querySelector('.recipe-more summary') || a;
  openChoose(at, a.dataset.claude || null, 'after' in a.dataset);
});

/**
 * Ask Claude or the editor, for a new recipe (no path) or an edit. `after`:
 * the recipe was just cooked, so it asks what to improve for next time.
 * `finish`: cook mode's Finish, where finishing without changes comes first.
 */
export function openChoose(anchor, path, after = false, finish = false) {
  const dlg = $('#choose');
  const pop = wideBrowse.matches;
  const why = noClaude();
  const editor = path ? `#/edit/${encPath(path)}` : '#/new';
  const opt = (main, attrs, icon, title, sub, tag = 'a') =>
    `<${tag} class="choose-opt${main ? ' is-main' : ''}" ${attrs}>${icon}<span><b>${title}</b><small>${sub}</small></span></${tag}>`;
  const claude = why === 'none' ? ''
    : why ? `<div class="choose-opt is-off">${OFFLINE_ICON}<span><b>Ask Claude</b><small>${esc(why)}</small></span></div>`
    : opt(!finish, `href="${esc(CLAUDE_NEW + encodeURIComponent(claudeText(path, after)))}" target="_blank" rel="noopener" data-pick="claude"`, SPARK_ICON, 'Ask Claude',
      after ? 'Tell Claude what you noticed. It improves the recipe and saves it.'
        : path ? 'Say what to change. Claude rewrites and saves it.' : 'Give a link, text or photo. Claude writes and saves it.');
  const file = opt(Boolean(why) && !finish, `href="${editor}" data-pick`, FILE_ICON, path ? 'Edit the file' : 'Start blank',
    path ? 'Change the Cooklang text yourself.' : 'Write it yourself in the editor.');
  // Edit also takes a new photo, when Drive is there to save it to.
  const e = path && !after && !finish ? S.recipes.get(path) : null;
  const photo = e && S.live === 'on' && e.driveId
    ? opt(false, 'type="button" data-pick="photo"', PHOTO_ICON, e.driveImage ? 'Change photo' : 'Add photo', 'Paste, pick or link a photo of the dish.', 'button') : '';
  const title = after ? 'How did it go?' : path ? `Edit ${S.recipes.get(path)?.title || 'recipe'}` : 'New recipe';
  const sub = after ? 'Anything to change for next time?'
    : path ? 'How do you want to change it?' : 'How do you want to start?';
  dlg.setAttribute('aria-label', title);
  dlg.classList.toggle('is-pop', pop);
  dlg.innerHTML = `<div class="choose-in">
    ${pop && !after ? '' : `${pop ? '' : '<div class="sheet-grab" aria-hidden="true"></div>'}
    <div class="choose-head"><div><b>${esc(title)}</b><small>${sub}</small></div>
      <button class="sheet-x" data-close aria-label="Close">${CLOSE_ICON}</button></div>`}
    ${finish ? opt(true, 'type="button" data-pick="done"', CHECK_ICON, 'Just finish', 'Nothing to change. Back to the recipe.', 'button') : ''}
    ${why ? file + claude : claude + file}
    ${photo}
  </div>`;
  $$('[data-pick]', dlg).forEach((a) => {
    a.onclick = () => {
      if (a.dataset.pick === 'claude') connectorChecked = 0; // look again when the page comes back
      dlg.close();
      if (a.dataset.pick === 'photo' && e) editorView().then((v) => v.changePhoto(e));
    };
  });
  const x = $('[data-close]', dlg);
  if (x) x.onclick = () => dlg.close();
  dlg.onclick = (ev) => { if (ev.target === dlg) dlg.close(); };
  dlg.style.left = dlg.style.top = '';
  dlg.showModal();
  if (pop) {
    // Under the button, or above it when there is no room below.
    const r = anchor.getBoundingClientRect();
    const w = dlg.offsetWidth, h = dlg.offsetHeight;
    const left = Math.max(16, Math.min(r.right - w, innerWidth - w - 16));
    const top = r.bottom + 8 + h > innerHeight - 8 ? Math.max(8, r.top - 8 - h) : r.bottom + 8;
    dlg.style.left = `${left}px`;
    dlg.style.top = `${top}px`;
  }
}
