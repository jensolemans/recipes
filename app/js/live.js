// Signed in: the recipes come live from Google Drive. Only files whose md5
// differs from the built index are downloaded; photos follow after.

import * as drive from './drive.js';
import * as shop from './shopping.js';
import * as plan from './plan.js';
import { cardImg } from './home.js';
import { renderAccount, renderFoot, route } from './app.js';
import { S, makeEntry } from './state.js';
import { toast } from './ui.js';
import { $, $$, IMAGE_EXTS, SKIP_TOP, collator, encPath, esc, pool, saved } from './util.js';

function findDriveImage(files, path) {
  for (const ext of IMAGE_EXTS) {
    const f = files.get(path + ext);
    if (f) return f;
  }
  return null;
}

// Card size first; the full size only when the recipe opens (fullPhoto).
async function loadDriveImage(e, img) {
  try {
    const url = await drive.readPhotoUrl(img, 640);
    // Let go of the photo this one replaces.
    if (e.imageUrl?.startsWith('blob:') && e.imageUrl !== e.thumbUrl) URL.revokeObjectURL(e.imageUrl);
    if (e.thumbUrl?.startsWith('blob:')) URL.revokeObjectURL(e.thumbUrl);
    e.imageUrl = url; e.thumbUrl = url; e.imageMd5 = img.md5Checksum;
    e.fullPending = img;
  } catch { /* keep whatever we had */ }
  e.photoLoading = false;
  showPhoto(e);
}

/** Loads the full-size photo of a recipe that only has its card photo from Drive yet. */
export async function fullPhoto(e) {
  const img = e.fullPending;
  if (!img) return;
  e.fullPending = null;
  try {
    const url = await drive.readPhotoUrl(img, 1600);
    if (e.driveImage !== img) { URL.revokeObjectURL(url); return; } // replaced meanwhile
    e.imageUrl = url;
    const hero = $(`.recipe[data-path="${CSS.escape(e.path)}"] .hero img`);
    if (hero) hero.src = url;
  } catch { e.fullPending = img; }
}

/**
 * The card photo, already on the device, fills the frame until the full-size
 * photo is in, so a recipe opened for the first time does not show an empty
 * frame first.
 */
export function heroBackdrop(e) {
  const fig = $(`.recipe[data-path="${CSS.escape(e.path)}"] .hero`);
  if (fig && e.thumbUrl && e.thumbUrl !== e.imageUrl) fig.style.backgroundImage = `url(${JSON.stringify(e.thumbUrl)})`;
}

/** Puts a photo that came in from Drive into the page, wherever it shows. */
function showPhoto(e) {
  const href = `#/r/${encPath(e.path)}`;
  $$('.card').forEach((a) => {
    if (a.getAttribute('href') === href) $('.card-img', a).outerHTML = cardImg(e);
  });
  const fig = $(`.recipe[data-path="${CSS.escape(e.path)}"] .hero`);
  if (!fig) return;
  if (e.imageUrl) {
    fig.classList.remove('skeleton');
    fig.innerHTML = `<img src="${esc(e.imageUrl)}" alt="${esc(e.title)}">`;
    fullPhoto(e);
    heroBackdrop(e);
  } else {
    fig.closest('.recipe-top').classList.remove('has-img');
    fig.remove();
  }
}

export async function goLive() {
  const folderId = S.config.folderId;
  if (!folderId) { toast('The site has no Google Drive folder configured.'); return; }
  S.live = 'loading';
  renderAccount();
  const photos = [];
  try {
    const [check, { folders, files }] = await Promise.all([drive.checkFolder(folderId), drive.walk(folderId)]);
    if (!check.canEdit) {
      toast('This Google account cannot edit the recipe folder, so you stay in read-only mode.');
      drive.signOut();
      S.live = 'off';
      renderAccount();
      return;
    }
    S.drive = { folders, files };
    S.folders = [...folders.keys()].filter((p) => p && !SKIP_TOP.test(p)).sort(collator.compare);

    const seen = new Set();
    const tasks = [];
    // A changed photo comes after the recipes show, with an empty frame
    // where there was none before.
    const photo = (e, img) => { e.photoLoading = !e.thumbUrl; photos.push(() => loadDriveImage(e, img)); };
    for (const [p, f] of files) {
      if (!p.endsWith('.cook') || SKIP_TOP.test(p)) continue;
      const path = p.slice(0, -5);
      seen.add(path);
      const old = S.recipes.get(path);
      const img = findDriveImage(files, path);
      if (old && old.md5 === f.md5Checksum) {
        old.driveId = f.id;
        old.driveImage = img;
        if (img && img.md5Checksum !== old.imageMd5) photo(old, img);
        if (!img) { old.imageUrl = null; old.thumbUrl = null; }
        continue;
      }
      tasks.push(async () => {
        const src = await drive.readText(f.id);
        const keepImg = old && img && old.imageMd5 === img.md5Checksum;
        const e = makeEntry({
          path, src, md5: f.md5Checksum, modified: Math.floor(Date.parse(f.modifiedTime) / 1000),
          image: keepImg ? old.image : undefined, imageMd5: keepImg ? old.imageMd5 : undefined,
        });
        if (keepImg) { e.imageUrl = old.imageUrl; e.thumbUrl = old.thumbUrl; e.fullPending = old.fullPending; }
        e.driveId = f.id;
        e.driveImage = img;
        S.recipes.set(path, e);
        if (img && !keepImg) photo(e, img);
      });
    }
    for (const path of [...S.recipes.keys()]) if (!seen.has(path)) S.recipes.delete(path);
    tasks.push(() => loadConf('aisle', files.get(shop.AISLE_PATH)), () => loadConf('pantry', files.get(shop.PANTRY_PATH)));
    await pool(tasks, 6);
    S.live = 'on';
    S.shop?.useFile(files.get(shop.LIST_PATH));
    S.shop?.sync();
    S.plan?.useFile(files.get(plan.PLAN_PATH));
    S.plan?.sync();
  } catch (e) {
    S.live = 'off';
    toast(e.message || 'Could not load recipes from Google Drive.');
  }
  renderAccount();
  renderFoot();
  if (!S.dirty) route();
  if (photos.length) pool(photos, 6);
}

/** Reads aisle.conf or pantry.conf from Drive, reusing the saved copy when it has not changed. */
async function loadConf(kind, f) {
  const old = S.conf[kind];
  if (!f) { S.conf[kind] = { id: null, md5: null, text: '' }; }
  else if (old && old.md5 === f.md5Checksum) { S.conf[kind] = { ...old, id: f.id }; }
  else S.conf[kind] = { id: f.id, md5: f.md5Checksum, text: await drive.readText(f.id) };
  saved.set(`conf.${kind}`, S.conf[kind]);
}
