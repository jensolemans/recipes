// The editor (#/edit/<path>, #/new): the .cook text with a live preview,
// snippets, a folder suggested from the course and tags, photos (paste, pick
// or a link) and a draft kept on the device. Saves straight to Drive.
// Loaded when first opened.

import * as drive from './drive.js';
import { initParser, parseRecipe, readFrontmatter } from './cooklang.js';
import { CLEAR_ICON, CLOSE_ICON, PASTE_ICON } from './icons.js';
import { goLive } from './live.js';
import { go, parseHash, renderAccount, route, signInFlow, watchSession } from './app.js';
import { factsList, recipeBody, refPath } from './recipe.js';
import { S, makeEntry } from './state.js';
import { ask, askText, toast } from './ui.js';
import { $, $$, SKIP_TOP, chapterLabel, debounce, encPath, esc, fold, folderLabel, saved, slugify } from './util.js';

const TEMPLATE = (author) => `---
title:
description:
author: ${author}
source:
course:
cuisine:
diet:
difficulty: easy
servings: 4
time:
prep time:
cook time:
tags: []
---

`;

const SNIPPETS = {
  ingredient: { label: 'Ingredient', sym: '@', text: '@ingredient{100%g}', select: [1, 11] },
  cookware: { label: 'Equipment', sym: '#', text: '#pan{}', select: [1, 4] },
  timer: { label: 'Timer', sym: '~', text: '~{10%minutes}', select: [2, 4] },
  section: { label: 'Section', sym: '==', text: '\n== Section ==\n', select: [4, 11] },
  note: { label: 'Note', sym: '>', text: '\n> ', select: [3, 3] },
};

function resizeImage(file, max = 1600) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not read this photo.'))), 'image/jpeg', 0.85);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read this photo.')); };
    img.src = url;
  });
}

/**
 * Takes the recipe out of a pasted Claude reply: the code block that holds
 * it, or everything from the frontmatter on when there is text before it.
 * Returns null when the text is not a reply around a recipe.
 */
function recipeFromReply(text) {
  const blocks = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const block = blocks.find((b) => /^---\s*$/m.test(b) && /^title\s*:/mi.test(b)) || blocks.find((b) => /@[\p{L}]/u.test(b));
  if (block) return `${block.replace(/\s+$/, '')}\n`;
  const at = text.search(/^---\s*$/m);
  if (at > 0 && /^title\s*:/mi.test(text.slice(at))) return text.slice(at);
  return null;
}

// Words in a recipe that point at a folder with another name.
const FOLDER_WORDS = {
  bread: 'baking', vegan: 'vegetarian', pescatarian: 'seafood', fish: 'seafood', prawn: 'seafood',
  shrimp: 'seafood', salmon: 'seafood', chicken: 'poultry', turkey: 'poultry', duck: 'poultry',
  beef: 'meat', pork: 'meat', lamb: 'meat', noodle: 'pasta', risotto: 'rice', cake: 'cake', cookie: 'cookie',
};
const stem = (w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

/**
 * The best folder for a recipe: the category named after its course, then
 * the subfolder that matches its title and tags best (or its diet). Null
 * when the course matches no category.
 */
function suggestFolder(fm, folders) {
  const words = (s) => fold(s).split(/[^a-z0-9]+/).filter(Boolean).map(stem);
  const both = (ws) => ws.flatMap((w) => [w, FOLDER_WORDS[w]].filter(Boolean));
  const tags = Array.isArray(fm.tags) ? fm.tags : String(fm.tags || '').split(',');
  const course = new Set(both(words(fm.course)));
  const strong = new Set(both([...words(fm.title), ...tags.flatMap(words)]));
  const weak = new Set(both([...words(fm.diet), ...words(fm.cuisine)]));
  const label = (f) => words(chapterLabel(f.split('/').pop())).filter((w) => w !== 'and');
  const top = folders.find((f) => !f.includes('/') && label(f).some((w) => course.has(w)));
  if (!top) return null;
  let best = top, bestScore = 0;
  for (const f of folders.filter((x) => x.startsWith(`${top}/`) && x.split('/').length === 2)) {
    const score = label(f).reduce((n, w) => n + (course.has(w) ? 3 : strong.has(w) ? 2 : weak.has(w) ? 1 : 0), 0);
    if (score > bestScore) { best = f; bestScore = score; }
  }
  return best;
}

/** Downloads a photo from its web address. Throws a message that says what to do instead. */
async function photoFromLink(url) {
  let res;
  try {
    res = await fetch(url, { mode: 'cors' });
  } catch {
    throw new Error("That site doesn't let other sites download its photos. Copy the photo and use Paste photo instead.");
  }
  if (!res.ok) throw new Error(`That photo could not be downloaded (${res.status}).`);
  const blob = await res.blob();
  if (!blob.type.startsWith('image/')) throw new Error("That's a page, not a photo. Right-click or long-press the photo and copy the image address.");
  return blob;
}

/** The photo on the clipboard, or null when there is none. Throws when the browser cannot read it. */
async function clipboardPhoto() {
  const items = await navigator.clipboard.read();
  for (const item of items) {
    const type = item.types.find((t) => t.startsWith('image/'));
    if (type) return item.getType(type);
  }
  return null;
}

/** Asks for a dish photo: picked or taken, pasted, or from a link. Resolves with it, or null. */
function choosePhoto(title) {
  const dlg = $('#modal');
  dlg.innerHTML = `<form method="dialog">
    <h2>${esc(title)}</h2>
    <p>Take a photo or pick one, or copy a photo on a recipe site and paste it.</p>
    <div class="photo-choices">
      <label class="btn btn-quiet">Choose photo<input type="file" id="pc-file" accept="image/*" hidden></label>
      <button type="button" class="btn btn-quiet" id="pc-paste">Paste photo</button>
      <button value="link" class="btn btn-quiet">Photo link</button>
    </div>
    <div class="modal-actions"><button value="cancel" class="btn btn-quiet">Cancel</button></div>
  </form>`;
  let photo = null;
  const take = (blob) => { photo = blob; dlg.close('ok'); };
  $('#pc-file', dlg).onchange = (ev) => { const f = ev.target.files?.[0]; if (f) take(f); };
  $('#pc-paste', dlg).onclick = async () => {
    let blob;
    try { blob = await clipboardPhoto(); } catch { blob = undefined; }
    if (blob) { take(blob); return; }
    dlg.close('cancel');
    toast(blob === null
      ? 'There is no photo on the clipboard. Right-click or long-press the photo on the recipe site and copy it first.'
      : 'This browser cannot read photos from the clipboard here. Press Ctrl+V while this window is open instead.');
  };
  // Ctrl+V while the window is open works too.
  dlg.onpaste = (ev) => {
    const img = [...(ev.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
    if (img) { ev.preventDefault(); take(img); }
  };
  return new Promise((resolve) => {
    dlg.onclose = async () => {
      const v = dlg.returnValue;
      dlg.returnValue = '';
      dlg.onpaste = null;
      if (v === 'ok') { resolve(photo); return; }
      if (v !== 'link') { resolve(null); return; }
      const url = await askText({ title: 'Photo link', body: 'Paste the web address of the photo. Right-click or long-press the photo on the recipe site and copy the image address.', label: 'Photo address', placeholder: 'https://' });
      if (!url) { resolve(null); return; }
      try { resolve(await photoFromLink(url)); } catch (err) { toast(err.message); resolve(null); }
    };
    dlg.showModal();
  });
}

/** Change photo in the recipe's ⋯ menu: saves the photo next to the recipe in Drive. */
export async function changePhoto(e) {
  const picked = await choosePhoto(e.driveImage ? 'Change photo' : 'Add photo');
  if (!picked) return;
  try {
    const blob = await resizeImage(picked);
    await drive.renewIfNeeded();
    const folderId = S.drive.folders.get(e.folder);
    const old = e.driveImage;
    let img;
    if (old) {
      img = await drive.updateContent(old.id, blob, 'image/jpeg');
      if (img.name !== `${e.file}.jpg`) img = await drive.moveRename(img.id, { name: `${e.file}.jpg` });
      S.drive.files.delete(`${e.folder}/${old.name}`);
    } else {
      img = await drive.create(`${e.file}.jpg`, folderId, blob, 'image/jpeg');
    }
    S.drive.files.set(`${e.path}.jpg`, img);
    if (e.imageUrl?.startsWith('blob:')) URL.revokeObjectURL(e.imageUrl);
    e.imageUrl = URL.createObjectURL(blob);
    e.thumbUrl = e.imageUrl;
    e.fullPending = null; e.photoLoading = false;
    e.image = undefined;
    e.imageMd5 = img.md5Checksum;
    e.driveImage = img;
    toast('Photo saved to Google Drive.');
    if (parseHash().path === `/r/${e.path}`) route();
  } catch (err) {
    toast(err.message || 'The photo could not be saved.');
    renderAccount();
  }
}

export async function showEditor(rawPath) {
  document.body.dataset.view = 'editor';
  if (!drive.enabled()) { go('#/'); return; }
  // An ended sign-in does not block editing: Save renews it. Offline, the
  // editor works from the copy on this device and keeps a draft until Save works.
  const offline = S.live !== 'on' && !navigator.onLine && drive.wasSignedIn();
  if (S.live !== 'on' && !offline) {
    if (S.live === 'loading') { $('#main').innerHTML = '<p class="loading">Syncing with Google Drive…</p>'; return; }
    $('#main').innerHTML = `<div class="empty"><h1>Sign in to edit</h1><p>Editing changes the recipe files in Google Drive, so only the owner of the folder can do it.</p><button class="btn btn-primary" id="signin2">Sign in with Google</button></div>`;
    $('#signin2').onclick = () => signInFlow();
    return;
  }
  const isNew = rawPath == null;
  let e = isNew ? null : S.recipes.get(rawPath);
  if (!isNew && (!e || (!e.driveId && !offline))) {
    $('#main').innerHTML = `<div class="empty"><h1>Recipe not found</h1><p>It may have been moved, renamed or deleted in Google Drive.</p><a class="btn btn-quiet" href="#/">All recipes</a></div>`;
    return;
  }
  await initParser();

  const folders = S.folders.filter((f) => !SKIP_TOP.test(f));
  const startFolder = isNew ? ([S.filters.chapter, S.filters.sub].filter(Boolean).join('/') || folders[0] || '') : e.folder;
  const author = drive.user()?.name || '';
  const st = {
    src: isNew ? TEMPLATE(author) : e.src,
    loadedMd5: isNew ? null : e.md5,
    folder: startFolder,
    file: isNew ? '' : e.file,
    fileTouched: !isNew,
    folderTouched: !isNew,
    photo: null, // Blob
    photoUrl: isNew ? null : e.imageUrl,
    saving: false,
  };
  S.dirty = false;
  // Unsaved work is kept on this device (not the photo), so a closed tab or
  // a save that fails offline loses nothing. Leaving without saving drops it.
  const draftKey = `draft.${isNew ? '/new' : e.path}`;
  const keepDraft = debounce(() => {
    if (S.dirty && ta.isConnected) saved.set(draftKey, { src: ta.value, folder: st.folder, file: st.file, md5: st.loadedMd5, at: Date.now() });
  }, 400);
  const dropDraft = () => { saved.set(draftKey, null); };
  S.dropDraft = dropDraft;
  const markDirty = () => { S.dirty = true; $('#save-state').textContent = 'Unsaved changes'; keepDraft(); };

  $('#main').innerHTML = `
    <section class="editor" data-tab="text">
      <div class="editor-bar">
        <h1>${isNew ? 'New recipe' : `Edit ${esc(e.title)}`}</h1>
        <div class="editor-tabs" role="tablist">
          <button role="tab" aria-selected="false" data-tab="details">Details</button>
          <button role="tab" aria-selected="true" data-tab="text">Text</button>
          <button role="tab" aria-selected="false" data-tab="preview">Preview</button>
        </div>
        <a class="sheet-x editor-x" href="${isNew ? '#/' : `#/r/${encPath(e.path)}`}" aria-label="Close" title="Close">${CLOSE_ICON}</a>
      </div>
      <div class="editor-head">
        <span class="photo-thumb" id="photo-thumb">${st.photoUrl ? `<img src="${esc(st.photoUrl)}" alt="">` : 'No photo'}</span>
        <div class="photo-btns">
          <label class="btn btn-quiet btn-sm">Choose<input type="file" id="photo" accept="image/*" hidden></label>
          <button class="btn btn-quiet btn-sm" id="paste-photo" title="Copy a photo on a recipe site first">Paste</button>
          <button class="btn btn-quiet btn-sm" id="photo-link" title="The web address of a photo">Link</button>
        </div>
        <div class="editor-fields">
          <label class="field"><span>Category</span>
            <select id="folder">${folders.map((f) => `<option value="${esc(f)}" ${f === st.folder ? 'selected' : ''}>${esc(folderLabel(f))}</option>`).join('')}</select>
          </label>
          <label class="field field-file"><span>File name</span>
            <span class="file-input"><input id="file" value="${esc(st.file)}" spellcheck="false" autocomplete="off" placeholder="from the title"><span>.cook</span></span>
          </label>
        </div>
      </div>
      <div class="toolbar" id="toolbar" aria-label="Insert">
        <span class="toolbar-label">Insert</span>
        ${Object.entries(SNIPPETS).map(([k, s]) => `<button class="tool-btn" data-snip="${k}"><span class="tool-sym">${esc(s.sym)}</span>${s.label}</button>`).join('')}
        <span class="toolbar-gap"></span>
        <button class="tool-btn" id="paste-recipe" title="Paste a recipe, or Claude\'s whole reply"><span class="tool-sym">${PASTE_ICON}</span>Paste recipe</button>
        <button class="tool-btn" id="clear-src" title="Empty the recipe text, ready to paste"><span class="tool-sym">${CLEAR_ICON}</span>Clear text</button>
      </div>
      <div class="editor-panes">
        <div class="pane pane-write">
          <textarea id="src" spellcheck="true" aria-label="Recipe in Cooklang"></textarea>
          <div class="issues" id="issues"></div>
        </div>
        <div class="pane pane-preview" id="preview"></div>
      </div>
      <div class="editor-save">
        ${isNew || offline ? '' : '<button class="btn btn-quiet btn-sm btn-danger" id="del">Delete recipe</button>'}
        <span class="save-state" id="save-state" aria-live="polite"></span>
        <button class="ins-btn" id="ins-btn" aria-label="Insert" aria-expanded="false" aria-controls="toolbar" title="Insert">@#</button>
        <button class="btn btn-primary" id="save">Save</button>
      </div>
    </section>`;

  const ta = $('#src');
  ta.value = st.src;

  // A draft left from last time comes back. It keeps the version it started
  // from, so saving still asks when the recipe changed in Drive since.
  const draft = saved.get(draftKey, null);
  if (draft && draft.src !== st.src) {
    const original = { ...st };
    ta.value = draft.src;
    st.folder = draft.folder || st.folder;
    st.file = draft.file ?? st.file;
    st.loadedMd5 = isNew ? null : draft.md5 ?? st.loadedMd5;
    st.fileTouched = st.folderTouched = true;
    $('#folder').value = st.folder;
    $('#file').value = st.file;
    S.dirty = true;
    $('#save-state').textContent = 'Unsaved changes';
    toast(`Your unsaved changes from ${new Date(draft.at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} are back.`, {
      label: 'Discard',
      run: () => {
        Object.assign(st, original);
        ta.value = st.src;
        $('#folder').value = st.folder;
        $('#file').value = st.file;
        S.dirty = false;
        $('#save-state').textContent = '';
        dropDraft();
        updatePreview();
      },
    });
  }
  if (offline) $('#save-state').textContent = S.dirty ? 'Offline, unsaved changes' : 'Offline';

  const updatePreview = () => {
    if (!ta.isConnected) return; // left the editor before the debounce fired
    const p = parseRecipe(ta.value, 1);
    const fm = readFrontmatter(ta.value);
    const fake = makeEntry({ path: `${st.folder}/${st.file || 'new'}`, src: ta.value });
    $('#preview').innerHTML = `
      <div class="preview-head">
        ${st.photoUrl ? `<img src="${esc(st.photoUrl)}" alt="">` : ''}
        <h2>${esc(fm.title || 'Untitled recipe')}</h2>
        ${fm.description ? `<p class="lede">${esc(fm.description)}</p>` : ''}
        <dl class="facts">${factsList(fake, p, 1)}</dl>
      </div>
      <div class="recipe-body">${recipeBody(p, { interactive: false, path: '' })}</div>`;
    const errs = p.errors || [];
    const warns = (p.warnings || []).filter((w) => !/Time overriden|value for key: 'yield'/.test(w));
    const broken = (p.recipe?.ingredients || []).map(refPath).filter((r) => r && !S.recipes.has(r));
    $('#issues').innerHTML = [
      ...errs.map((m) => `<p class="issue issue-error">${esc(m)}</p>`),
      ...[...new Set(broken)].map((r) => `<p class="issue issue-error">Linked recipe not found: ${esc(r)}</p>`),
      ...warns.map((m) => `<p class="issue">${esc(m)}</p>`),
    ].join('');
    if (!st.fileTouched) {
      st.file = slugify(fm.title || '');
      $('#file').value = st.file;
    }
    // A new recipe goes where its course says, until a category is picked by hand.
    if (!st.folderTouched) {
      const f = suggestFolder(fm, folders);
      if (f && f !== st.folder) { st.folder = f; $('#folder').value = f; }
    }
  };
  const debounced = debounce(updatePreview, 200);
  updatePreview();

  ta.addEventListener('input', () => { markDirty(); debounced(); });
  ta.addEventListener('keydown', (ev) => {
    if (ev.key === 'Tab' && !ev.shiftKey) { ev.preventDefault(); insert('  ', 2, 2); }
  });
  // Ctrl+S anywhere in the editor, the recipe text included.
  document.onkeydown = (ev) => {
    if (document.body.dataset.view !== 'editor') return;
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); save(); }
  };

  function insert(text, selA, selB) {
    const a = ta.selectionStart, b = ta.selectionEnd;
    ta.setRangeText(text, a, b, 'end');
    ta.focus();
    ta.setSelectionRange(a + selA, a + selB);
    markDirty(); debounced();
  }
  $$('.tool-btn[data-snip]').forEach((b) => {
    b.onclick = () => { const s = SNIPPETS[b.dataset.snip]; insert(s.text, s.select[0], s.select[1]); setIns(false); };
  });

  // Phones: Details, Text and Preview are tabs.
  const sec = $('.editor');
  $$('.editor-tabs [data-tab]').forEach((b) => {
    b.onclick = () => {
      $$('.editor-tabs [data-tab]').forEach((x) => x.setAttribute('aria-selected', x === b));
      sec.dataset.tab = b.dataset.tab;
      setIns(false);
      if (b.dataset.tab === 'preview') updatePreview();
    };
  });

  // Phones: the toolbar is a menu behind the @# button. Tapping it or a
  // choice keeps the focus (and the keyboard) in the recipe text.
  const insBtn = $('#ins-btn');
  function setIns(open) {
    sec.classList.toggle('ins-open', open);
    insBtn.setAttribute('aria-expanded', open);
  }
  insBtn.onclick = () => setIns(!sec.classList.contains('ins-open'));
  $$('#ins-btn, #toolbar .tool-btn').forEach((b) => { b.onmousedown = (ev) => { if (document.activeElement === ta) ev.preventDefault(); }; });
  sec.addEventListener('click', (ev) => { if (!ev.target.closest('#toolbar, #ins-btn')) setIns(false); });
  sec.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && sec.classList.contains('ins-open')) { setIns(false); ta.focus(); } });

  // While the keyboard is open the Save bar steps aside and only @# stays,
  // just above the keyboard.
  const vv = window.visualViewport;
  if (vv) {
    const onViewport = () => {
      if (!sec.isConnected) { vv.removeEventListener('resize', onViewport); vv.removeEventListener('scroll', onViewport); return; }
      const kb = Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop));
      const typing = kb > 120 && /^(TEXTAREA|INPUT|SELECT)$/.test(document.activeElement?.tagName || '');
      sec.style.setProperty('--kb', `${typing ? kb : 0}px`);
      sec.classList.toggle('kb-open', typing);
    };
    vv.addEventListener('resize', onViewport);
    vv.addEventListener('scroll', onViewport);
  }

  $('#folder').onchange = (ev) => { st.folder = ev.target.value; st.folderTouched = true; markDirty(); };
  $('#file').oninput = (ev) => {
    st.fileTouched = true;
    st.file = ev.target.value.trim().replace(/\.cook$/i, '');
    markDirty();
  };
  async function usePhoto(blob) {
    try {
      st.photo = await resizeImage(blob);
      // A photo picked earlier in this editor is no longer needed.
      if (st.photoUrl?.startsWith('blob:') && st.photoUrl !== e?.imageUrl) URL.revokeObjectURL(st.photoUrl);
      st.photoUrl = URL.createObjectURL(st.photo);
      $('#photo-thumb').innerHTML = `<img src="${st.photoUrl}" alt="">`;
      markDirty(); updatePreview();
      return true;
    } catch (err) { toast(err.message); return false; }
  }
  $('#photo').onchange = (ev) => { const f = ev.target.files?.[0]; if (f) usePhoto(f); };
  $('#paste-photo').onclick = async () => {
    let blob;
    try { blob = await clipboardPhoto(); } catch {
      toast('This browser cannot read photos from the clipboard here. Click in the recipe text and press Ctrl+V instead.');
      return;
    }
    if (blob) { usePhoto(blob); return; }
    toast('There is no photo on the clipboard. Right-click or long-press the photo on the recipe site and copy it first.');
  };
  $('#photo-link').onclick = async () => {
    const url = await askText({ title: 'Photo link', body: 'Paste the web address of the photo. Right-click or long-press the photo on the recipe site and copy the image address.', label: 'Photo address', placeholder: 'https://' });
    if (!url) return;
    try { if (await usePhoto(await photoFromLink(url))) toast('Photo added.'); } catch (err) { toast(err.message); }
  };

  // Pasting Claude's whole reply keeps only the recipe. Text that is empty or
  // still the template is replaced, not added to.
  const isBlank = () => !ta.value.trim() || ta.value.trim() === TEMPLATE(author).trim();
  function takeRecipe(text) {
    const rec = recipeFromReply(text);
    const plain = rec == null && isBlank() && /^\s*---/.test(text) ? text : null;
    if (rec == null && plain == null) return false;
    if (isBlank()) ta.value = rec ?? plain;
    else ta.setRangeText(rec, ta.selectionStart, ta.selectionEnd, 'end');
    markDirty(); updatePreview();
    if (rec != null && rec.trim() !== text.trim()) toast("Took the recipe out of Claude's reply.");
    // The recipe may name its photo; try it if there is none yet.
    const img = readFrontmatter(ta.value).image;
    if (!st.photo && typeof img === 'string' && /^https?:\/\//.test(img)) {
      photoFromLink(img).then(usePhoto).catch(() => toast('Recipe pasted. Add the photo with Paste photo or Photo link.'));
    }
    return true;
  }
  ta.addEventListener('paste', (ev) => {
    const dt = ev.clipboardData;
    const text = dt?.getData('text/plain') || '';
    const img = [...(dt?.files || [])].find((f) => f.type.startsWith('image/'));
    if (img && !text.trim()) { ev.preventDefault(); usePhoto(img); return; }
    if (takeRecipe(text)) ev.preventDefault();
  });
  // A photo pasted anywhere else in the editor becomes the recipe photo.
  document.onpaste = (ev) => {
    if (document.body.dataset.view !== 'editor' || ev.target === ta) return;
    const img = [...(ev.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
    if (img) { ev.preventDefault(); usePhoto(img); }
  };
  // Empties the text for pasting; done as an edit so Ctrl+Z brings it back.
  $('#clear-src').onclick = () => {
    setIns(false);
    ta.focus();
    ta.select();
    if (!document.execCommand('delete')) ta.value = '';
    markDirty(); updatePreview();
  };
  const pasteBtn = $('#paste-recipe');
  if (pasteBtn) pasteBtn.onclick = async () => {
    setIns(false);
    let text;
    try { text = await navigator.clipboard.readText(); } catch {
      toast('This browser cannot read the clipboard here. Tap in the recipe text and paste it there instead.');
      return;
    }
    if (!isBlank() && !(await ask({
      title: 'Replace the recipe text?',
      body: isNew ? 'What you typed so far is replaced by the pasted recipe.' : 'The recipe text is replaced by the pasted recipe. Nothing changes in Drive until you save.',
      actions: [{ label: 'Keep mine', value: false }, { label: 'Replace', value: true, danger: true }],
    }))) return;
    if (!isBlank()) ta.value = '';
    if (!takeRecipe(text)) toast('The clipboard has no recipe. Copy Claude\'s reply, or the recipe starting at ---, and try again.');
  };

  if (!isNew && !offline) {
    $('#del').onclick = async () => {
      const ok = await ask({
        title: `Delete ${e.title}?`,
        body: 'The recipe file and its photo move to the Google Drive trash. You can restore them from there for 30 days.',
        actions: [{ label: 'Keep recipe', value: false }, { label: 'Move to trash', value: true, danger: true }],
      });
      if (!ok) return;
      try {
        await drive.renewIfNeeded();
        await drive.trash(e.driveId);
        if (e.driveImage) await drive.trash(e.driveImage.id).catch(() => {});
        S.recipes.delete(e.path);
        S.dirty = false;
        dropDraft();
        toast(`${e.title} moved to the Google Drive trash.`);
        go('#/');
      } catch (err) { toast(err.message); renderAccount(); }
    };
  }

  $('#save').onclick = save;

  // One save at a time, also while the sign-in window or a question is open.
  async function save() {
    if (st.saving) return;
    st.saving = true;
    try { await saveNow(); } finally {
      st.saving = false;
      const b = $('#save'); if (b) b.disabled = false;
    }
  }

  async function saveNow() {
    const src = ta.value;
    const fm = readFrontmatter(src);
    const file = (st.file || slugify(fm.title || '')).replace(/[\\/:*?"<>|]+/g, '_').trim();
    if (!file) { toast('Give the recipe a title or a file name first.'); $('#file').focus(); return; }
    const p = parseRecipe(src, 1);
    if (p.errors?.length) {
      const goOn = await ask({
        title: 'This recipe has errors',
        body: `${p.errors[0]}. Save it anyway? The Cooklang app may not show it correctly.`,
        actions: [{ label: 'Keep editing', value: false }, { label: 'Save anyway', value: true }],
      });
      if (!goOn) return;
    }
    // Opened offline: get the Drive side first, now that there may be a connection.
    if (S.live !== 'on') {
      if (!navigator.onLine) { toast("You're offline. Your changes stay on this device: save again when you're back online."); return; }
      try { await drive.renewIfNeeded(); } catch (err) { toast(err.message); renderAccount(); return; }
      await goLive();
      if (S.live !== 'on') return;
      if (!isNew) e = S.recipes.get(e.path) || e;
    }
    if (!isNew && !e.driveId) { toast('This recipe is no longer in Google Drive. Copy your text before leaving.'); return; }
    const newPath = `${st.folder}/${file}`;
    if ((isNew || newPath !== e.path) && S.recipes.has(newPath)) {
      toast(`A recipe called ${file}.cook already exists in ${folderLabel(st.folder)}.`);
      return;
    }
    const folderId = S.drive.folders.get(st.folder);
    if (!folderId) { toast('That category no longer exists in Google Drive. Reload and try again.'); return; }

    // Renew first, while we are still inside the tap, so the sign-in cannot
    // run out halfway through saving the recipe and its photo.
    try {
      await drive.renewIfNeeded();
    } catch (err) {
      toast(err.message);
      renderAccount();
      return;
    }
    watchSession();
    renderAccount();

    $('#save').disabled = true;
    $('#save-state').textContent = 'Saving…';
    try {
      let meta;
      if (isNew) {
        meta = await drive.create(`${file}.cook`, folderId, src);
      } else {
        const current = await drive.getMeta(e.driveId);
        if (current.md5Checksum && current.md5Checksum !== st.loadedMd5) {
          const choice = await ask({
            title: 'This recipe changed in Google Drive',
            body: 'Someone (or the Cooklang app) saved a newer version after you opened it. Saving now replaces that version with yours.',
            actions: [{ label: 'Cancel', value: 'cancel' }, { label: 'Replace with mine', value: 'overwrite', danger: true }],
          });
          if (choice !== 'overwrite') throw Object.assign(new Error('Not saved.'), { quiet: true });
        }
        meta = await drive.updateContent(e.driveId, src);
        const oldParent = S.drive.folders.get(e.folder);
        if (newPath !== e.path) {
          meta = await drive.moveRename(e.driveId, { name: `${file}.cook`, fromParent: oldParent, toParent: folderId });
          if (e.driveImage && !st.photo) {
            const ext = e.driveImage.name.slice(e.driveImage.name.lastIndexOf('.'));
            e.driveImage = await drive.moveRename(e.driveImage.id, { name: `${file}${ext}`, fromParent: oldParent, toParent: folderId });
          }
        }
      }

      let driveImage = isNew ? null : e.driveImage;
      if (st.photo) {
        if (driveImage) {
          driveImage = await drive.updateContent(driveImage.id, st.photo, 'image/jpeg');
          const wanted = `${file}.jpg`;
          const oldParent = (driveImage.parents || [])[0];
          if (driveImage.name !== wanted || oldParent !== folderId) {
            driveImage = await drive.moveRename(driveImage.id, { name: wanted, fromParent: oldParent, toParent: folderId });
          }
        } else {
          driveImage = await drive.create(`${file}.jpg`, folderId, st.photo, 'image/jpeg');
        }
      }

      if (!isNew) S.recipes.delete(e.path);
      const entry = makeEntry({
        path: newPath, src, md5: meta.md5Checksum, modified: Math.floor(Date.parse(meta.modifiedTime || new Date().toISOString()) / 1000),
        imageUrl: st.photoUrl || null,
      });
      entry.imageUrl = st.photoUrl || null;
      entry.thumbUrl = st.photoUrl || null;
      entry.image = isNew || st.photo ? undefined : e.image;
      entry.imageMd5 = driveImage?.md5Checksum;
      entry.driveId = meta.id;
      entry.driveImage = driveImage;
      S.recipes.set(newPath, entry);
      // Moved or renamed: the plan follows it.
      if (!isNew && newPath !== e.path) S.plan?.do({ t: 'repath', from: e.path, to: newPath, title: entry.title });
      if (S.drive) {
        S.drive.files.set(`${newPath}.cook`, meta);
        if (!isNew && newPath !== e.path) S.drive.files.delete(`${e.path}.cook`);
      }
      S.dirty = false;
      dropDraft();
      toast('Saved to Google Drive. Friends see it after the next hourly update.');
      go(`#/r/${encPath(newPath)}`);
    } catch (err) {
      if (!err.quiet) toast(err.message || 'Saving failed.');
      if (err.code === 401) renderAccount();
      $('#save-state').textContent = S.dirty ? 'Unsaved changes' : '';
    }
  }
}
