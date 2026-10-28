// End-to-end test: viewer on every recipe, scaling, filters, and the editor
// against an in-memory fake of the Google Drive API.
// Usage: node tests/e2e.mjs <site-url> <recipes-dir>
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
// Use a local install if there is one, else the global one from `npm i -g playwright`.
const load = (from) => createRequire(from)('playwright');
let pw;
try { pw = load(import.meta.url); } catch { pw = load(path.join(execSync('npm root -g', { shell: true }).toString().trim(), 'noop.js')); }
const { chromium } = pw;

const [, , BASE, RECIPES] = process.argv;
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failures++; };
const until2 = async (page, fn) => {
  for (let i = 0; i < 50; i++) { try { if (await fn()) return true; } catch { /* not yet */ } await page.waitForTimeout(100); }
  return false;
};

// ---------- fake Drive ----------
const files = new Map(); // id -> {id,name,mimeType,parents,content:Buffer,trashed}
let nextId = 1;
const FOLDER = 'application/vnd.google-apps.folder';
function add(name, parent, content = null) {
  const id = name === '__root' ? 'ROOT' : `f${nextId++}`;
  files.set(id, { id, name: name === '__root' ? 'Cooklang Recipes' : name, mimeType: content ? 'text/plain' : FOLDER, parents: parent ? [parent] : [], content, trashed: false, modifiedTime: new Date().toISOString() });
  return id;
}
(function walk(dir, parent) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, add(d.name, parent));
    else add(d.name, parent, fs.readFileSync(p));
  }
})(RECIPES, add('__root', null));
// Start the shopping list tests from nothing, whatever the real folder holds.
for (const f of files.values()) if (['shopping_list.json', 'pantry.conf'].includes(f.name)) files.delete(f.id);
const pub = (f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, parents: f.parents, modifiedTime: f.modifiedTime, ...(f.content ? { md5Checksum: md5(f.content) } : {}) });
const byName = (parent, name) => [...files.values()].find((f) => f.parents.includes(parent) && f.name === name && !f.trashed);

// Change one recipe in "Drive" so the live sync has something to pick up.
const crepesFolder = byName('ROOT', '01 Breakfast').id;
const crepes = byName(crepesFolder, 'crepes.cook');
crepes.content = Buffer.from(crepes.content.toString().replace('title: Crêpes', 'title: Crêpes (from Drive)'));

// Fake Google sign-in: hands out a token at once, as Google does for someone
// who already allowed access.
const fakeGis = (route) => route.fulfill({ contentType: 'text/javascript', body: `
  window.__gis = { calls: 0, prompt: null };
  window.google = { accounts: { oauth2: {
    initTokenClient: (o) => ({ requestAccessToken: (p) => {
      window.__gis.calls++; window.__gis.prompt = p && p.prompt;
      setTimeout(() => o.callback({ access_token: 'fake' + window.__gis.calls, expires_in: 3600 }), 50);
    } }),
    revoke: () => {},
  } } };` });

// Points the site at the fake Drive's root folder, whatever local.json says,
// so the editor tests never see the real folder ID or the real Worker.
async function fakeConfig(route) {
  const res = await route.fetch();
  const data = await res.json();
  data.config = { ...data.config, folderId: 'ROOT', clientId: data.config?.clientId || 'test-client', authUrl: '' };
  return route.fulfill({ response: res, json: data });
}

async function driveRoute(route) {
  const req = route.request();
  const url = new URL(req.url());
  const m = req.method();
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const idMatch = url.pathname.match(/\/files\/([^/]+)$/);
  const id = idMatch?.[1];
  if (url.pathname.endsWith('/about')) return json({ user: { emailAddress: 'jens@example.com', displayName: 'Jens Olemans' } });
  if (url.pathname.startsWith('/drive/v3/files') && m === 'GET' && !id) {
    const parent = url.searchParams.get('q').match(/'([^']+)' in parents/)[1];
    return json({ files: [...files.values()].filter((f) => f.parents.includes(parent) && !f.trashed).map(pub) });
  }
  if (url.pathname.startsWith('/drive/v3/files/') && m === 'GET') {
    const f = files.get(id);
    if (!f) return json({ error: { message: 'File not found' } }, 404);
    if (url.searchParams.get('alt') === 'media') return route.fulfill({ status: 200, body: f.content });
    if (id === 'ROOT') return json({ ...pub(f), capabilities: { canEdit: true } });
    return json(pub(f));
  }
  if (url.pathname.startsWith('/upload/drive/v3/files/') && m === 'PATCH') {
    const f = files.get(id);
    f.content = req.postDataBuffer(); f.modifiedTime = new Date().toISOString();
    return json(pub(f));
  }
  if (url.pathname.startsWith('/drive/v3/files/') && m === 'PATCH') {
    const f = files.get(id);
    const body = JSON.parse(req.postData() || '{}');
    if (body.name) f.name = body.name;
    if (body.trashed) f.trashed = true;
    const add = url.searchParams.get('addParents'), rem = url.searchParams.get('removeParents');
    if (add) f.parents = f.parents.filter((p) => p !== rem).concat(add);
    return json(pub(f));
  }
  if (url.pathname === '/upload/drive/v3/files' && m === 'POST') {
    const buf = req.postDataBuffer();
    const boundary = req.headers()['content-type'].match(/boundary=(.+)$/)[1];
    const text = buf.toString('latin1');
    const parts = text.split(`--${boundary}`).slice(1, -1);
    const meta = JSON.parse(parts[0].split('\r\n\r\n')[1].trim());
    const start = text.indexOf('\r\n\r\n', text.indexOf(parts[1])) + 4;
    const end = text.lastIndexOf(`\r\n--${boundary}--`);
    const content = buf.subarray(start, end);
    const nid = `f${nextId++}`;
    files.set(nid, { id: nid, name: meta.name, mimeType: meta.mimeType, parents: meta.parents, content, trashed: false, modifiedTime: new Date().toISOString() });
    return json(pub(files.get(nid)));
  }
  return json({ error: { message: `unmocked ${m} ${url.pathname}` } }, 500);
}

// ---------- tests ----------
const browser = await chromium.launch();
const errors = [];
const newPage = async (opts = {}) => {
  const p = await browser.newPage({ viewport: { width: 1280, height: 900 }, ...opts });
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (msg) => { if (msg.type() === 'error' && !/favicon/.test(msg.text())) errors.push(`${msg.text()} ${msg.location().url || ''}`.trim()); });
  return p;
};

// 1. every recipe renders
{
  const page = await newPage();
  await page.goto(`${BASE}/#/`);
  await page.waitForSelector('.card');
  const data = await page.evaluate(() => fetch('data/recipes.json').then((r) => r.json()));
  let bad = [];
  for (const r of data.recipes) {
    await page.evaluate((h) => { location.hash = h; }, `#/r/${r.path.split('/').map(encodeURIComponent).join('/')}`);
    try {
      await page.waitForSelector(`.recipe[data-path="${r.path.replace(/"/g, '\\"')}"] .step`, { timeout: 4000 });
    } catch { bad.push(r.path); }
  }
  ok(bad.length === 0, `all ${data.recipes.length} recipes render with steps ${bad.length ? JSON.stringify(bad) : ''}`);
  await page.close();
}

// 2. scaling
{
  const page = await newPage();
  await page.goto(`${BASE}/#/r/01%20Breakfast/crepes`);
  await page.waitForSelector('.ing-row');
  const qty = async (name) => page.$eval(`.ing-list`, (ul, n) => [...ul.querySelectorAll('.ing-row')].find((r) => r.querySelector('.ing-name').textContent.trim().startsWith(n))?.querySelector('.ing-qty').textContent, name);
  ok(await qty('whole milk') === '500 ml', 'crepes: 500 ml milk at 4 servings');
  await page.click('[data-d="1"]'); await page.click('[data-d="1"]'); await page.click('[data-d="1"]'); await page.click('[data-d="1"]');
  ok(await qty('whole milk') === '1 l', `crepes: 1 l milk at 8 servings (got ${await qty('whole milk')})`);
  ok(await qty('egg') === '6', 'crepes: 6 eggs at 8 servings');
  ok(page.url().includes('?s=8'), 'servings kept in the link');
  const stepText = await page.$eval('.step', (li) => li.textContent);
  ok(stepText.includes('1 l'), 'method shows the scaled amount too');
  // fixed quantity
  await page.goto(`${BASE}/#/`);
  const fixed = await page.evaluate(() => fetch('data/recipes.json').then((r) => r.json()).then((d) => d.recipes.find((r) => /@salt\{=1%tsp\}/.test(r.src))?.path));
  if (fixed) {
    await page.goto(`${BASE}/#/r/${fixed.split('/').map(encodeURIComponent).join('/')}?s=40`);
    await page.waitForSelector('.ing-row');
    ok(await qty('salt') === '1 tsp', `fixed salt stays 1 tsp when scaled (${fixed})`);
  }
  await page.close();
}

// 3. search + filters
{
  const page = await newPage();
  await page.goto(`${BASE}/#/`);
  await page.waitForSelector('.card');
  await page.fill('#q', 'crepe');
  await page.waitForTimeout(300);
  const titles = await page.$$eval('.card-title', (els) => els.map((e) => e.textContent));
  ok(titles.includes('Crêpes'), `search "crepe" finds Crêpes (${titles.join(', ')})`);
  await page.fill('#q', '');
  await page.waitForTimeout(300);
  await page.click('#place');
  await page.click('#browse [data-pick="01 Breakfast"]');
  ok((await page.$$('.card')).length === 5, 'Breakfast folder shows 5');
  ok(!(await page.$eval('#browse', (d) => d.open)), 'picking a folder closes the panel');
  ok((await page.textContent('#place')).includes('Breakfast'), 'the folder button says where you are');
  await page.click('#place');
  await page.click('#browse [data-pick="05 Mains/Pasta"]');
  const where = await page.$$eval('.card', (els) => [...new Set(els.map((a) => decodeURIComponent(a.getAttribute('href')).split('/').slice(2, -1).join('/')))]);
  ok(where.length === 1 && where[0] === '05 Mains/Pasta', `picking Pasta under Mains shows only pasta (${where.join(', ')})`);
  await page.click('#place');
  ok(await page.$eval('#browse [data-pick="05 Mains/Pasta"]', (b) => b.classList.contains('is-here')), 'the panel opens with the current folder marked');
  const hasRecipes = (d) => fs.readdirSync(d, { withFileTypes: true }).some((x) => (x.isDirectory() ? hasRecipes(path.join(d, x.name)) : x.name.endsWith('.cook')));
  const mainsSubs = fs.readdirSync(path.join(RECIPES, '05 Mains'), { withFileTypes: true }).filter((x) => x.isDirectory() && hasRecipes(path.join(RECIPES, '05 Mains', x.name))).length;
  const subs = await page.$$eval('#browse .tree-leaf[data-pick^="05 Mains/"]', (els) => els.length);
  ok(subs === mainsSubs, `on desktop every subfolder of Mains is listed (${subs} of ${mainsSubs})`);
  await page.click('#browse [data-pick=""]');
  const total = (await page.$$('.card')).length;
  await page.click('#place');
  await page.click('#browse .opt[data-key="diet"][data-val="vegan"]');
  await page.click('#b-show');
  const n = (await page.$$('.card')).length;
  ok(n > 0 && n < total, `vegan filter narrows the list (${n})`);
  await page.close();
}

// 4. mobile layout has no horizontal scroll
{
  const page = await newPage({ viewport: { width: 375, height: 800 } });
  for (const h of ['#/', '#/r/05%20Mains/Pasta/lasagna']) {
    await page.goto(`${BASE}/${h}`);
    await page.waitForTimeout(800);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok(over <= 0, `no sideways scroll on phone for ${h} (${over}px)`);
  }
  await page.goto(`${BASE}/#/`);
  await page.click('#place');
  ok(await page.$eval('#browse', (d) => !d.querySelector('.opt') && Boolean(d.querySelector('[data-tab="filters"]'))), 'on a phone the panel opens on the folders tab');
  await page.click('#browse [data-open="05 Mains"]');
  ok((await page.textContent('#browse h2')).replace(/\s+/g, ' ').trim() === 'All recipes / Mains', 'a folder with subfolders opens, with the path on top');
  await page.click('#browse [data-pick="05 Mains/Pasta"]');
  await page.click('#place');
  ok(await page.$eval('#browse [data-pick="05 Mains/Pasta"]', (b) => b.classList.contains('is-here')), 'reopening shows the level you are on');
  await page.click('#browse [data-up=""]');
  ok(Boolean(await page.$('#browse [data-open="05 Mains"]')), 'tapping All recipes in the path goes back up');
  await page.click('#browse [data-tab="filters"]');
  ok(Boolean(await page.$('#browse .opt')) && Boolean(await page.$('#b-show')), 'and the filters tab has the filters');
  await page.close();
}

// 12. cook mode: mise en place, one step at a time, chapters, scroll mode
{
  const page = await newPage();
  await page.goto(`${BASE}/#/r/01%20Breakfast/crepes`);
  await page.waitForSelector('#cook-btn');
  const order = await page.$$eval('.recipe-actions > :not(.row-break)', (els) => els.map((e) => e.id || e.className));
  ok(order[0] === 'scaler' && order[1] === 'cook-btn', `cook mode sits right after the servings (${order.join(', ')})`);
  await page.click('[data-d="1"]');
  await page.click('#cook-btn');
  await page.waitForSelector('.cook-mise');
  ok(page.url().includes('#/cook/') && page.url().includes('s=5'), 'cook mode opens with the servings from the recipe');
  ok(await page.$eval('.topbar', (el) => getComputedStyle(el).display === 'none'), 'the site top bar is hidden');
  ok((await page.textContent('.cook-where')) === 'Before you start', 'it starts with the mise en place');
  const count = () => page.textContent('#mise-count');
  const before = await count();
  await page.click('.cook-mise .ing-row .ing-name');
  ok((await count()) !== before, `ticking an ingredient counts it (${before} to ${await count()})`);
  await page.click('#cook-next');
  await page.waitForSelector('.cook-text');
  ok((await page.textContent('.cook-where')).startsWith('1 of '), 'Next goes to step 1');
  ok(page.url().includes('step=1'), 'the step is kept in the link');
  ok(Boolean(await page.$('.cook-sum li')), 'the step lists what it uses');
  await page.keyboard.press('ArrowRight');
  ok((await page.textContent('.cook-where')).startsWith('2 of '), 'the right arrow key goes on');
  await page.keyboard.press('ArrowLeft');
  ok((await page.textContent('.cook-where')).startsWith('1 of '), 'the left arrow key goes back');
  await page.click('.cb-pill[data-at="0"]');
  ok(Boolean(await page.$('.cook-mise .ing-row.is-checked')), 'the tick is still there when you come back');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.recipe');
  ok(page.url().includes('#/r/') && page.url().includes('s=5'), 'Esc goes back to the recipe at the same servings');

  // A recipe with == Section == chapters labels the bar with them.
  const withChapters = await page.evaluate(() => fetch('data/recipes.json').then((r) => r.json()).then((d) => d.recipes.find((r) => /^==[^=\n]+==\s*$/m.test(r.src))?.path));
  if (withChapters) {
    await page.goto(`${BASE}/#/cook/${withChapters.split('/').map(encodeURIComponent).join('/')}?step=1`);
    await page.waitForSelector('.cook-text');
    const labels = await page.$$eval('.cb-label', (els) => els.map((e) => e.textContent).filter(Boolean));
    ok(labels.length > 0, `the bar is labelled by chapter (${withChapters}: ${labels.join(', ')})`);
  }
  await page.goto(`${BASE}/#/cook/01%20Breakfast/crepes?step=2`);
  await page.waitForSelector('.cook-text');
  await page.click('#cook-mode');
  await page.waitForSelector('.cook-flow');
  ok((await page.$$('.cf-done')).length === 2, 'scroll mode folds the mise en place and step 1');
  ok(Boolean(await page.$('.cf-now .cook-text')), 'and shows the current step in full');
  await page.click('#cook-mode'); // leave it in steps mode for the next test
  await page.close();

  const phone = await newPage({ viewport: { width: 375, height: 800 } });
  await phone.goto(`${BASE}/#/cook/01%20Breakfast/crepes`);
  await phone.waitForSelector('.cook-mise');
  await phone.click('#cook-next');
  await phone.waitForTimeout(50); // halfway through the slide-in
  const over = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok(over <= 0, `no sideways scroll while a step slides in on a phone (${over}px)`);
  const nav = await phone.$eval('.cook-where', (el) => { const r = el.getBoundingClientRect(); return Math.abs(r.left + r.width / 2 - innerWidth / 2); });
  ok(nav < 4, `the step count is centred on a phone (${Math.round(nav)}px off)`);
  await phone.close();
}

// 5. editor against fake Drive
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  await ctx.addInitScript(() => {
    localStorage.setItem('recipes.session', JSON.stringify({ token: 'fake', expires: Date.now() + 3600e3, email: 'jens@example.com', name: 'Jens Olemans' }));
    localStorage.setItem('recipes.email', 'jens@example.com');
  });
  await ctx.route('https://www.googleapis.com/**', driveRoute);
  await ctx.route('https://accounts.google.com/gsi/client', fakeGis);
  await ctx.route('**/data/recipes.json', fakeConfig);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/#/`);
  await page.waitForSelector('a[href="#/new"]', { timeout: 15000 });
  ok(true, 'signed-in session goes live');
  ok(await page.isVisible('text=Crêpes (from Drive)'), 'change made in Drive shows up live');

  // edit crepes
  await page.goto(`${BASE}/#/edit/01%20Breakfast/crepes`);
  await page.waitForSelector('#src');
  const src = await page.inputValue('#src');
  await page.fill('#src', src.replace('@egg{3}', '@egg{4}'));
  await page.waitForTimeout(300);
  ok((await page.textContent('#preview')).includes('egg'), 'preview renders');
  await page.click('#save');
  try { await page.waitForSelector('.recipe', { timeout: 8000 }); } catch { console.log('TOAST:', await page.textContent('#toast'), 'DIALOG:', await page.textContent('dialog')); throw new Error('save failed'); }
  const saved = byName(crepesFolder, 'crepes.cook').content.toString();
  ok(saved.includes('@egg{4}'), 'edit saved to Drive');
  ok(await page.$eval('.ing-list', (ul) => ul.textContent.includes('4')), 'recipe page shows the saved version');

  // conflict detection
  await page.goto(`${BASE}/#/edit/01%20Breakfast/crepes`);
  await page.waitForSelector('#src');
  byName(crepesFolder, 'crepes.cook').content = Buffer.from(saved + '\n> Edited on phone\n');
  await page.fill('#src', (await page.inputValue('#src')) + '\n> Edited on web\n');
  await page.click('#save');
  await page.waitForSelector('dialog[open]');
  ok((await page.textContent('dialog')).includes('changed in Google Drive'), 'warns when the file changed elsewhere');
  await page.click('dialog button:has-text("Cancel")');
  ok(byName(crepesFolder, 'crepes.cook').content.toString().includes('Edited on phone'), 'cancel keeps the Drive version');

  // unsaved-changes guard
  await page.click('.editor-x');
  await page.waitForSelector('dialog[open]');
  await page.click('dialog button:has-text("Keep editing")');
  ok(await page.isVisible('#src'), 'Keep editing stays in the editor');
  await page.click('.editor-x');
  ok(await page.waitForSelector('dialog[open]', { timeout: 3000 }).then(() => true, () => false), 'and the close button asks again the next time');
  await page.click('dialog button:has-text("Discard changes")');
  await page.waitForSelector('.recipe');
  ok(true, 'leaving with unsaved changes asks first');

  // new recipe with photo
  await page.goto(`${BASE}/#/new`);
  await page.waitForSelector('#src');
  await page.selectOption('#folder', '10 Drinks');
  await page.fill('#src', '---\ntitle: Test Spritz\nservings: 2\ntime: 5m\n---\n\nPour @prosecco{90%ml} over @ice{} in a #wine glass{}.\n');
  await page.waitForTimeout(400);
  ok(await page.inputValue('#file') === 'test_spritz', 'file name follows the title');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await page.setInputFiles('#photo', { name: 'photo.png', mimeType: 'image/png', buffer: png });
  await page.waitForTimeout(500);
  await page.click('#save');
  await page.waitForSelector('.recipe[data-path="10 Drinks/test_spritz"]');
  const drinks = byName('ROOT', '10 Drinks').id;
  ok(Boolean(byName(drinks, 'test_spritz.cook')), 'new recipe created in Drive');
  const photo = byName(drinks, 'test_spritz.jpg');
  ok(Boolean(photo) && photo.content[0] === 0xff && photo.content[1] === 0xd8, 'photo uploaded as JPEG next to it');

  // move + rename
  await page.goto(`${BASE}/#/edit/10%20Drinks/test_spritz`);
  await page.waitForSelector('#src');
  await page.selectOption('#folder', '07 Basics');
  await page.fill('#file', 'spritz_test');
  await page.click('#save');
  await page.waitForSelector('.recipe[data-path="07 Basics/spritz_test"]');
  const sauces = byName('ROOT', '07 Basics').id;
  ok(Boolean(byName(sauces, 'spritz_test.cook')) && Boolean(byName(sauces, 'spritz_test.jpg')), 'move and rename keeps the photo with the recipe');

  // delete
  await page.goto(`${BASE}/#/edit/07%20Basics/spritz_test`);
  await page.waitForSelector('#del');
  await page.click('#del');
  await page.click('dialog button:has-text("Move to trash")');
  await page.waitForSelector('.home');
  ok(!byName(sauces, 'spritz_test.cook') && !byName(sauces, 'spritz_test.jpg'), 'delete moves recipe and photo to trash');
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/live-home.png` });
  await page.goto(`${BASE}/#/edit/05%20Mains/Curry/aloo_gobi`);
  await page.waitForSelector('#preview .step');
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/editor.png` });
  await ctx.close();
}

// 6. sign-in survives closing the tab, and renews in place when the hour ends
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await ctx.addInitScript(() => {
    if (localStorage.getItem('test.seeded')) return;
    localStorage.setItem('test.seeded', '1');
    localStorage.setItem('recipes.session', JSON.stringify({ token: 'fake', expires: Date.now() + 3600e3, email: 'jens@example.com', name: 'Jens Olemans' }));
    localStorage.setItem('recipes.email', 'jens@example.com');
  });
  await ctx.route('https://www.googleapis.com/**', driveRoute);
  await ctx.route('https://accounts.google.com/gsi/client', fakeGis);
  await ctx.route('**/data/recipes.json', fakeConfig);
  const first = await ctx.newPage();
  await first.goto(`${BASE}/#/`);
  await first.waitForSelector('a[href="#/new"]', { timeout: 15000 });
  await first.close();

  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/#/edit/01%20Breakfast/crepes`);
  await page.waitForSelector('#src', { timeout: 15000 });
  ok(await page.isVisible('a[href="#/new"]'), 'sign-in survives closing the tab');

  // Let the hour run out while editing.
  await page.fill('#src', (await page.inputValue('#src')) + '\n> Saved after renewing\n');
  const expire = () => page.evaluate(async () => {
    const d = await import(new URL('drive.js', location.href).href);
    d.user().expires = Date.now() - 1;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expire();
  await page.waitForSelector('#signin:has-text("Renew sign-in")');
  ok((await page.textContent('#toast')).includes('changes are kept'), 'says the sign-in ran out and the changes are kept');
  ok((await page.inputValue('#src')).includes('Saved after renewing'), 'editor stays open with the changes');

  await page.click('#save');
  await page.waitForSelector('.recipe', { timeout: 8000 });
  ok(await page.evaluate(() => window.__gis.calls) === 1, 'Save renews the sign-in with one Google window');
  ok(await page.evaluate(() => window.__gis.prompt) === '', 'renewal skips the account picker');
  ok(byName(crepesFolder, 'crepes.cook').content.toString().includes('Saved after renewing'), 'save after renewing reaches Drive');

  await expire();
  await page.click('#signin:has-text("Renew sign-in")');
  await page.waitForSelector('summary.avatar');
  ok(page.url().includes('#/r/'), 'Renew sign-in keeps you on the same page');
  await ctx.close();
}

// 7. shopping list, saved in the fake Drive
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await ctx.addInitScript(() => {
    if (localStorage.getItem('test.seeded')) return;
    localStorage.setItem('test.seeded', '1');
    localStorage.setItem('recipes.session', JSON.stringify({ token: 'fake', expires: Date.now() + 3600e3, email: 'jens@example.com', name: 'Jens Olemans' }));
    localStorage.setItem('recipes.email', 'jens@example.com');
  });
  await ctx.route('https://www.googleapis.com/**', driveRoute);
  await ctx.route('https://accounts.google.com/gsi/client', fakeGis);
  await ctx.route('**/data/recipes.json', fakeConfig);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  const config = byName('ROOT', 'config').id;
  const listFile = () => byName(config, 'shopping_list.json');
  const listJson = () => JSON.parse(listFile().content.toString());
  const until = async (fn, what) => {
    for (let i = 0; i < 60; i++) { try { if (await fn()) return true; } catch { /* not yet */ } await page.waitForTimeout(100); }
    console.log('timed out waiting for', what);
    return false;
  };
  const row = (name) => page.locator('.shop-row', { has: page.locator('.shop-name', { hasText: new RegExp(`^${name}`) }) }).first();
  const qtyOf = async (name) => (await row(name).locator('.ing-qty').textContent()).trim();
  const sync = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

  await page.goto(`${BASE}/#/r/01%20Breakfast/crepes`);
  await page.waitForSelector('#add-list', { timeout: 15000 });
  await page.click('#add-list');
  ok((await page.textContent('#toast')).includes('Added Crêpes'), 'adding a recipe says so');
  ok(await until(() => page.$eval('#add-list', (b) => b.dataset.state === 'on'), 'basket on'), 'the basket then shows it is on the list');
  ok((await page.getAttribute('#add-list', 'aria-label')).includes('Tap to remove'), 'and says a tap removes it');
  await page.click('.toast-btn:has-text("Undo")');
  ok(await until(() => page.$eval('#add-list', (b) => b.dataset.state === 'add'), 'basket add'), 'Undo after adding takes it off again');
  await page.click('#add-list');
  await page.click('#add-list');
  ok(await until(() => page.textContent('#toast').then((t) => t.includes('Removed Crêpes')), 'removed'), 'a tap on the filled basket removes the recipe');
  await page.click('.toast-btn:has-text("Undo")');
  ok(await until(() => page.$eval('#add-list', (b) => b.dataset.state === 'on'), 'basket back'), 'and Undo puts it back');
  if (process.env.SHOT_DIR) await page.locator('.recipe-actions').screenshot({ path: `${process.env.SHOT_DIR}/basket-on.png` });
  await page.click('#scaler [data-d="1"]');
  ok(await page.$eval('#add-list', (b) => b.dataset.state === 'update' && b.title.startsWith('Update to')), 'at another size the basket offers to update');
  if (process.env.SHOT_DIR) await page.locator('.recipe-actions').screenshot({ path: `${process.env.SHOT_DIR}/basket-update.png` });
  await page.click('#add-list');
  ok(await until(() => page.textContent('#toast').then((t) => t.includes('is now')), 'updated'), 'and a tap updates the size');
  ok(await page.$eval('#add-list', (b) => b.dataset.state === 'on'), 'after which it is on the list at this size');
  await page.click('#scaler [data-reset]');
  await page.click('#add-list');
  await page.goto(`${BASE}/#/r/05%20Mains/Pasta/lasagna?s=4`);
  await page.waitForSelector('#add-list');
  await page.click('#add-list');
  ok(await until(() => listJson().recipes.length === 2, 'list file'), 'list file created in Drive config folder with both recipes');
  ok(listJson().recipes.find((r) => r.path.endsWith('lasagna')).servings === 4, 'the chosen servings are saved');

  await page.goto(`${BASE}/#/list`);
  await page.waitForSelector('.shop-row');
  ok(await qtyOf('eggs') === '5½', `eggs combine across spellings and recipes (${await qtyOf('eggs')})`);
  ok(await qtyOf('milk') === '850 ml', `milk and whole milk combine (${await qtyOf('milk')})`);
  const secs = await page.$$eval('.shop-sec h2', (hs) => hs.map((h) => h.textContent.trim()));
  ok(secs[0] === 'Produce' && secs.indexOf('Dairy & eggs') < secs.indexOf('Baking') && secs.indexOf('Baking') < secs.indexOf('Wine, beer & spirits'), `sections follow aisle.conf (${secs.join(' | ')})`);
  ok(await page.isVisible('.shop-have summary'), 'made-at-home things go under Probably have');
  const produce = await page.locator('.shop-sec', { hasText: 'Produce' }).locator('.shop-name').allTextContents();
  const at = (n) => produce.findIndex((t) => t.startsWith(n));
  ok(at('onion') < at('garlic') && at('garlic') < at('celery'), `items follow the aisle.conf order within an aisle (${produce.map((t) => t.split(/[A-Z]/)[0]).join(', ')})`);
  ok(await page.$eval('.brand', (b) => b.getBoundingClientRect().height < 30), 'site title stays on one line on a phone');
  const tabs = await page.$$eval('#tabbar .tab', (ts) => ts.map((t) => `${t.textContent.trim()}${t.getAttribute('aria-current') ? '*' : ''}`));
  ok(tabs.length === 3 && tabs[0] === 'Recipes' && /^Shopping list\d*\*$/.test(tabs[1]) && tabs[2] === 'New', `phone has a bottom tab bar with the list selected (${tabs.join(' | ')})`);
  ok(!(await page.isVisible('.account .icon-link')) && !(await page.isVisible('.btn-new')), 'the top bar leaves the list and New to the tab bar');
  const barTop = await page.$eval('#tabbar', (t) => t.getBoundingClientRect().top);
  ok(barTop > 844 - 80 && barTop < 844, 'the tab bar sits at the bottom of the screen');

  // offers to renew the sign-in before the hour runs out
  await page.evaluate(async () => {
    const d = await import(new URL('drive.js', location.href).href);
    d.user().expires = Date.now() + 5 * 60e3;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForSelector('#shop-renew');
  ok((await page.textContent('#shop-status')).includes('ends in 5 min'), 'says the sign-in ends soon');
  await page.click('#shop-renew');
  ok(await until(() => page.textContent('#shop-status').then((t) => t.includes('Saved in Google Drive')), 'renewed'), 'Renew now renews it in place');
  ok(await page.evaluate(() => window.__gis.calls) === 1, 'with one Google window');
  ok(await page.textContent('.shop-have').then((t) => t.includes('batter') && t.includes('water')), 'batter and water are under Probably have');

  // add items by hand
  await page.fill('#shop-new', 'frozen fries');
  await page.press('#shop-new', 'Enter');
  await page.fill('#shop-new', 'bagged lettuce');
  await page.press('#shop-new', 'Enter');
  await page.fill('#shop-new', '1 kg onions');
  await page.press('#shop-new', 'Enter');
  await page.waitForSelector('.shop-name:has-text("frozen fries")');
  ok((await qtyOf('onion')).startsWith('1 kg + ½'), `"1 kg onions" adds to the onion line (${await qtyOf('onion')})`);
  ok(await page.locator('.shop-sec', { hasText: 'Other' }).locator('.shop-name', { hasText: 'bagged lettuce' }).count() === 1, 'unknown items go under Other');

  // check off
  await row('eggs').locator('.tick').check();
  await page.waitForSelector('.shop-done .shop-name:has-text("eggs")');
  ok(await until(() => listJson().checked.includes('eggs'), 'checked'), 'checking an item saves to Drive');
  ok(/^1 of \d+$/.test(await page.textContent('#shop-count')), 'count shows what is checked');

  // change made on another device shows up
  const remote = listJson();
  remote.items.push({ id: 'phone1', name: 'bread', n: null, unit: '' });
  listFile().content = Buffer.from(JSON.stringify(remote));
  await sync();
  ok(await until(() => page.isVisible('.shop-name:has-text("bread")'), 'bread'), 'an item added on another device shows up');

  // offline-style merge: a local tick and a remote change both survive
  const remote2 = listJson();
  remote2.items.push({ id: 'phone2', name: 'cucumber', n: null, unit: '' });
  listFile().content = Buffer.from(JSON.stringify(remote2));
  await row('bread').locator('.tick').check();
  ok(await until(() => listJson().checked.includes('bread') && listJson().items.some((i) => i.name === 'cucumber'), 'merge'), 'a tick here and a change elsewhere are both kept');

  // by recipe: remove a whole recipe, then undo
  await page.click('.seg [data-view="recipe"]');
  await page.waitForSelector('.shop-recipe-head');
  ok(await page.locator('.shop-recipe-head h2').allTextContents().then((t) => t.includes('Crêpes (from Drive)') && t.includes('Added by you')), 'by recipe shows each recipe and your own items');
  ok((await page.textContent('.shop-recipe-head:has-text("Lasagna") > span')) === '4 servings', 'recipe shows its servings');
  await page.click('.shop-recipe-head:has-text("Crêpes") [data-remove-recipe]');
  ok(await until(() => listJson().recipes.length === 1, 'remove recipe'), 'removing a recipe keeps the others');
  ok(await row('milk').locator('.ing-qty').textContent() === '350 ml', 'only the lasagna milk is left');
  await page.click('.toast-btn:has-text("Undo")');
  ok(await until(() => listJson().recipes.length === 2, 'undo'), 'undo brings the recipe back');

  // remove one line from one recipe
  await page.locator('.shop-recipe', { hasText: 'Lasagna' }).locator('.shop-row', { hasText: 'carrot' }).locator('[data-more]').click();
  await page.click('dialog button:has-text("Remove from Lasagna")');
  ok(await until(() => listJson().recipes.find((r) => r.path.endsWith('lasagna')).removed.includes('carrot'), 'line'), 'removing one ingredient from one recipe');

  // pantry and aisles
  await page.click('.seg [data-view="aisle"]');
  await row('olive oil').locator('[data-more]').click();
  await page.click('#item [role="switch"]:has-text("Always have this")');
  ok(await until(() => byName(config, 'pantry.conf')?.content.toString().includes('"olive oil" = {}'), 'pantry'), 'Always have this writes pantry.conf');
  ok(await until(() => page.locator('.shop-have .shop-name', { hasText: 'olive oil' }).count().then((n) => n === 1), 'have'), 'olive oil moves to Probably have');
  ok(await until(() => page.getAttribute('#item [role="switch"]', 'aria-checked').then((v) => v === 'true'), 'switch'), 'the switch stays on');
  await page.click('#item [data-close]');
  await row('bagged lettuce').locator('[data-more]').click();
  if (process.env.SHOT_DIR) {
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${process.env.SHOT_DIR}/item-card-phone.png` });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await page.screenshot({ path: `${process.env.SHOT_DIR}/item-card-phone-dark.png` });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  }
  await page.click('#item button:has-text("Add aisle")');
  await page.selectOption('#pick', { label: 'Produce' });
  await page.click('dialog button:has-text("Save")');
  ok(await until(() => /\[produce\][^[]*\nbagged lettuce\n/.test(byName(config, 'aisle.conf').content.toString()), 'aisle'), 'Choose aisle adds it to aisle.conf');
  ok(await until(() => page.locator('.shop-sec', { hasText: 'Produce' }).locator('.shop-name', { hasText: 'bagged lettuce' }).count().then((n) => n === 1), 'produce'), 'and the list sorts it there');
  ok(await until(() => page.textContent('#item .item-val').then((t) => t.trim() === 'Produce').catch(() => false), 'card aisle'), 'the card shows the new aisle');
  await page.click('#item [data-close]');

  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok(over <= 0, `no sideways scroll on the list on a phone (${over}px)`);
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/list-phone.png`, fullPage: true });

  // clear checked, then clear all
  await page.click('#clear-checked');
  ok(await until(() => !listJson().checked.length && !listJson().items.some((i) => i.name === 'bread'), 'clear checked'), 'Clear checked removes what is in the basket');
  ok(await page.locator('.shop-name', { hasText: /^eggs/ }).count() === 0, 'eggs are gone from both recipes');
  await page.click('#clear-all');
  await page.click('dialog button:has-text("Clear list")');
  ok(await until(() => !listJson().recipes.length && !listJson().items.length, 'clear all'), 'Clear shopping list empties it');
  await page.waitForSelector('.shop-empty');

  // phone: the servings on one line, the add button a round basket beside
  // cook mode under it, the editor hides the bar
  await page.goto(`${BASE}/#/r/01%20Breakfast/crepes`);
  await page.waitForSelector('#add-list');
  const add = await page.$eval('#add-list', (b) => b.getBoundingClientRect().toJSON());
  const cook = await page.$eval('#cook-btn', (s) => s.getBoundingClientRect().toJSON());
  const more = await page.$eval('.recipe-more', (s) => s.getBoundingClientRect().toJSON());
  ok(add.width < 60 && Math.abs(add.top - cook.top) < 10 && Math.abs(more.top - cook.top) < 10, 'on a recipe, Add to shopping list is a basket in the row with cook mode and ⋯');
  ok(await page.$eval('#tabbar .tab[aria-current]', (t) => t.textContent.trim()) === 'Recipes', 'Recipes is selected on a recipe');
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/tabbar-recipe.png` });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`${BASE}/#/list`);
  await page.waitForSelector('.shop-body');
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/tabbar-list-dark.png` });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.click('#tabbar .tab:has-text("New")');
  await page.waitForSelector('#src');
  ok(!(await page.isVisible('#tabbar')) && await page.isVisible('.btn-new'), 'the editor hides the tab bar');
  await page.click('.editor-x');
  await page.waitForSelector('#tabbar .tab');

  // a recipe in parts asks which parts to shop for
  await page.goto(`${BASE}/#/r/05%20Mains/Meat/swedish_meatballs`);
  await page.waitForSelector('#add-list');
  await page.click('#add-list');
  await page.waitForSelector('dialog[open] .parts-list');
  const parts = await page.$$eval('.parts-list b', (bs) => bs.map((b) => b.textContent));
  ok(parts.join() === 'Meatballs,Browning,Gravy', `lists the parts of the recipe (${parts.join(', ')})`);
  ok((await page.textContent('.parts-list li:has-text("Gravy") small')).includes('beef stock'), 'each part shows its ingredients');
  await page.uncheck('.parts-list li:has-text("Gravy") input');
  await page.click('dialog button:has-text("Add to list")');
  ok(await until(() => page.textContent('#toast').then((t) => t.includes('only Meatballs and browning')), 'toast'), 'says which parts were added');
  ok(await until(() => listJson().recipes[0]?.parts?.join() === 'Meatballs,Browning', 'parts'), 'the chosen parts are saved');
  await page.goto(`${BASE}/#/list`);
  await page.waitForSelector('.shop-row');
  const names = await page.$$eval('.shop-name', (els) => els.map((e) => e.firstChild.textContent.trim()));
  ok(names.includes('ground beef') && !names.includes('beef stock') && !names.some((n) => n.includes('cream')), `only the ticked parts are on the list (${names.length} items)`);
  await page.click('.seg [data-view="recipe"]');
  ok((await page.textContent('.shop-parts')) === 'Only Meatballs and browning', 'by recipe says which parts');
  await page.goBack();
  await page.goto(`${BASE}/#/r/05%20Mains/Meat/swedish_meatballs`);
  await page.waitForSelector('#add-list');
  await page.click('#scaler [data-d="1"]');
  await page.click('#add-list');
  await page.waitForSelector('dialog[open] .parts-list');
  ok(!(await page.isChecked('.parts-list li:has-text("Gravy") input')), 'adding again starts from the earlier choice');
  await page.click('dialog button:has-text("Cancel")');
  ok(listJson().recipes.length === 1, 'cancel adds nothing');
  if (process.env.SHOT_DIR) {
    await page.click('#add-list');
    await page.waitForSelector('dialog[open] .parts-list');
    await page.screenshot({ path: `${process.env.SHOT_DIR}/parts-phone.png` });
    await page.click('dialog button:has-text("Cancel")');
  }
  await ctx.close();
}

// 8. friends who are not signed in see no shopping list
{
  const page = await newPage();
  await page.goto(`${BASE}/#/r/01%20Breakfast/crepes`);
  await page.waitForSelector('.ing-row');
  ok(!(await page.isVisible('#add-list')) && !(await page.isVisible('.icon-link')), 'no shopping list without signing in');
  await page.goto(`${BASE}/#/list`);
  ok(await page.isVisible('text=Sign in to use the shopping list'), 'list page asks to sign in');
  await page.close();
}

// 10. on a wide screen the list sits in a side panel
{
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, serviceWorkers: 'block' });
  await ctx.addInitScript(() => {
    if (localStorage.getItem('test.seeded')) return;
    localStorage.setItem('test.seeded', '1');
    localStorage.setItem('recipes.session', JSON.stringify({ token: 'fake', expires: Date.now() + 3600e3, email: 'jens@example.com', name: 'Jens Olemans' }));
    localStorage.setItem('recipes.email', 'jens@example.com');
  });
  await ctx.route('https://www.googleapis.com/**', driveRoute);
  await ctx.route('https://accounts.google.com/gsi/client', fakeGis);
  await ctx.route('**/data/recipes.json', fakeConfig);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  const shot = (name) => (process.env.SHOT_DIR ? page.screenshot({ path: `${process.env.SHOT_DIR}/${name}.png` }) : null);
  const mainRight = () => page.$eval('#main', (m) => m.getBoundingClientRect().right);

  await page.goto(`${BASE}/#/`);
  await page.waitForSelector('a[href="#/new"]', { timeout: 15000 });
  ok(await page.isVisible('#rail') && !(await page.isVisible('.account .icon-link')), 'closed list is a rail on the right, not a top bar icon');
  await shot('panel-rail');

  await page.goto(`${BASE}/#/r/01%20Breakfast/crepes`);
  await page.waitForSelector('#add-list');
  await page.click('#add-list');
  await page.waitForSelector('.side .shop-row');
  ok(true, 'the first add opens the panel by itself');
  ok(await page.locator('.side .shop-row.is-new').count() > 3, 'the new lines light up');
  await page.waitForTimeout(900);
  const delays = await page.$$eval('.side .shop-row.is-new', (rows) => rows.map((r) => -parseFloat(r.style.animationDelay)));
  ok(delays.length > 0 && Math.min(...delays) >= 300, `a redraw after saving carries on the same flash instead of starting again (${Math.round(Math.min(...delays))} ms in)`);
  ok(await page.isVisible('.toast-btn:has-text("Undo")'), 'adding offers Undo');
  ok(await mainRight() <= 1400 - 340, 'the recipe makes room for the panel');
  await page.waitForTimeout(800);
  await shot('panel-open-recipe');

  await page.click('#side-close');
  await page.waitForSelector('#rail');
  await page.goto(`${BASE}/#/r/05%20Mains/Pasta/lasagna`);
  await page.waitForSelector('#add-list');
  await page.click('#add-list');
  await page.waitForTimeout(400);
  ok(await page.isVisible('#rail') && !(await page.isVisible('.side .shop-panel')), 'after closing it, adding keeps it closed');
  ok(Number(await page.textContent('#rail .badge')) > 10, 'the rail counts what is left to buy');

  await page.keyboard.press('l');
  await page.waitForSelector('.side .shop-panel');
  ok(true, 'L opens it');
  await page.reload();
  await page.waitForSelector('.side .shop-row', { timeout: 15000 });
  ok(true, 'it stays open after a reload');
  await page.fill('#shop-new', 'frozen fries');
  await page.keyboard.press('l');
  ok(await page.isVisible('.side .shop-panel'), 'typing an L in the add box does not close it');
  await page.press('#shop-new', 'Enter');
  await page.waitForSelector('.side .shop-name:has-text("frozen fries")');
  ok(true, 'items can be added from the panel');
  await page.click('.side .seg [data-view="recipe"]');
  await page.waitForSelector('.side .shop-recipe-head');
  await shot('panel-open-home');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`${BASE}/#/`);
  await page.waitForSelector('.side .shop-row');
  await shot('panel-open-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  await page.goto(`${BASE}/#/edit/01%20Breakfast/crepes`);
  await page.waitForSelector('#src');
  ok(await page.isVisible('#rail') && !(await page.isVisible('.side .shop-panel')), 'the editor keeps it as a rail');
  await page.click('.editor-x');
  await page.waitForSelector('.side .shop-panel');
  ok(true, 'and it comes back after the editor');
  await page.goto(`${BASE}/#/list`);
  await page.waitForSelector('#main .shop-row');
  ok(!(await page.isVisible('#side')) && (await page.$$('#shop-body')).length === 1, 'the list page shows the list once, without the panel');
  await page.locator('#main .shop-row', { hasText: 'milk' }).first().locator('[data-more]').click();
  await page.waitForSelector('#item.is-wide[open]');
  ok(await page.locator('#item .item-uses li').count() === 3, 'the item card lists each recipe it is for');
  await page.waitForTimeout(300);
  await shot('item-card-wide');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await shot('item-card-wide-dark');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.click('#item [data-close]');
  await page.goto(`${BASE}/#/`);
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.waitForTimeout(300);
  ok(!(await page.isVisible('#side')) && await page.isVisible('#tabbar'), 'narrower than 1100 px the panel gives way to the tab bar');
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok(over <= 0, `no sideways scroll at 1000 px (${over}px)`);
  await ctx.close();
}

// 11. a new recipe from Claude's reply, with a pasted or linked photo
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', permissions: ['clipboard-read', 'clipboard-write'] });
  await ctx.addInitScript(() => {
    localStorage.setItem('recipes.session', JSON.stringify({ token: 'fake', expires: Date.now() + 3600e3, email: 'jens@example.com', name: 'Jens Olemans' }));
    localStorage.setItem('recipes.email', 'jens@example.com');
  });
  await ctx.route('https://www.googleapis.com/**', driveRoute);
  await ctx.route('https://accounts.google.com/gsi/client', fakeGis);
  await ctx.route('**/data/recipes.json', fakeConfig);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  // One photo site lets other sites download its photos, the other does not.
  await ctx.route('https://photos.example.test/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: png }));
  // Playwright answers routed requests without the browser's cross-site check, so
  // the blocked site is a refused request, which reaches the page the same way.
  await ctx.route('https://closed.example.test/**', (r) => r.abort('accessdenied'));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/#/`);
  await page.waitForSelector('a[href="#/new"]', { timeout: 15000 });
  await page.goto(`${BASE}/#/new`);
  await page.waitForSelector('#src');

  const reply = (title, course, tags) => `Here is the recipe in Cooklang:\n\n\`\`\`cooklang\n---\ntitle: ${title}\ndescription: A test.\ncourse: ${course}\ncuisine: indian\ndiet: meat\ntags: [${tags}]\nservings: 4\n---\n\nFry the @chicken thighs{500%g} with @garam masala{2%tsp}.\n\`\`\`\n\n**Conversion notes**\n- Converted cups to grams.\n`;
  await page.evaluate((text) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    document.querySelector('#src').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, reply('Chicken Tikka Test', 'main', 'chicken, curry'));
  const src = await page.inputValue('#src');
  ok(src.startsWith('---') && src.includes('@chicken thighs') && !src.includes('Conversion notes') && !src.includes('```'), 'pasting Claude\'s reply keeps only the recipe');
  ok((await page.textContent('#toast')).includes("Took the recipe out of Claude's reply"), 'and says so');
  ok(await page.inputValue('#folder') === '05 Mains/Curry', `the category follows the course and tags (${await page.inputValue('#folder')})`);
  ok(await page.inputValue('#file') === 'chicken_tikka_test', 'the file name follows the title');

  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'photo.png', { type: 'image/png' }));
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, png.toString('base64'));
  ok(await page.waitForSelector('#photo-thumb img', { timeout: 3000 }).then(() => true, () => false), 'a pasted photo becomes the recipe photo');

  await page.click('#photo-link');
  await page.fill('#ask-text', 'https://closed.example.test/dish.png');
  await page.click('dialog button:has-text("Add")');
  ok(await until2(page, () => page.textContent('#toast').then((t) => t.includes('use Paste photo instead'))), 'a site that blocks downloads says to paste the photo instead');
  await page.click('#photo-link');
  await page.fill('#ask-text', 'https://photos.example.test/dish.png');
  await page.click('dialog button:has-text("Add")');
  ok(await until2(page, () => page.textContent('#toast').then((t) => t.includes('Photo added'))), 'a photo link from a site that allows it is added');

  // The Paste recipe button reads the clipboard and asks before replacing.
  await page.evaluate((text) => navigator.clipboard.writeText(text), reply('Lentil Soup Test', 'soup', 'lentils'));
  await page.click('#paste-recipe');
  await page.click('dialog button:has-text("Replace")');
  ok(await until2(page, () => page.inputValue('#src').then((v) => v.includes('title: Lentil Soup Test') && !v.includes('Chicken Tikka'))), 'Paste recipe replaces the text after asking');
  ok(await page.inputValue('#folder') === '03 Soups' && await page.inputValue('#file') === 'lentil_soup_test', 'and the category and file name follow the new recipe');
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/editor-paste.png` });

  await page.click('#save');
  await page.waitForSelector('.recipe[data-path="03 Soups/lentil_soup_test"]', { timeout: 8000 });
  const soups = byName('ROOT', '03 Soups').id;
  ok(Boolean(byName(soups, 'lentil_soup_test.cook')) && Boolean(byName(soups, 'lentil_soup_test.jpg')), 'saving puts the recipe and its photo in the chosen category');
  await page.goto(`${BASE}/#/edit/03%20Soups/lentil_soup_test`);
  await page.waitForSelector('#del');
  await page.click('#del');
  await page.click('dialog button:has-text("Move to trash")');
  await page.waitForSelector('.home');
  await ctx.close();
}

// 9. installable, and opens without a connection
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/#/`);
  await page.waitForSelector('.card');
  const man = await page.evaluate(async () => {
    const m = await fetch(document.querySelector('link[rel=manifest]').href).then((r) => r.json());
    const icons = await Promise.all(m.icons.map((i) => fetch(i.src).then((r) => r.ok && r.headers.get('content-type').includes('png'))));
    const title = await fetch('data/recipes.json').then((r) => r.json()).then((d) => d.config.title);
    return { name: m.name, display: m.display, icons, title, maskable: m.icons.some((i) => i.purpose === 'maskable') };
  });
  ok(man.name === man.title && man.display === 'standalone', `manifest names the app after the site (${man.name})`);
  ok(man.icons.every(Boolean) && man.maskable, 'app icons load, with a maskable one for Android');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForSelector('.card');
  ok(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)), 'offline helper is running');
  const online = (await page.$$('.card')).length;
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForSelector('.card', { timeout: 8000 });
  ok((await page.$$('.card')).length === online, `home opens without a connection (${online} recipes)`);
  await page.evaluate(() => { location.hash = '#/r/05%20Mains/Pasta/lasagna?s=4'; });
  ok(await page.waitForSelector('.recipe .step', { timeout: 8000 }).then(() => true, () => false), 'a recipe opens and scales without a connection');
  await ctx.close();
}

// 10. signed in for good through the recipes Worker
{
  const AUTH = 'https://auth.test';
  const worker = { tokens: 0, redeems: 0, signouts: 0, pass: 'p'.repeat(43) };
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  await ctx.route('https://www.googleapis.com/**', driveRoute);
  await ctx.route('https://accounts.google.com/gsi/client', fakeGis);
  await ctx.route('**/data/recipes.json', async (route) => {
    const res = await route.fetch();
    const data = await res.json();
    data.config = { ...data.config, folderId: 'ROOT', clientId: 'test-client', authUrl: AUTH };
    return route.fulfill({ response: res, json: data });
  });
  await ctx.route(`${AUTH}/**`, (route) => {
    const p = new URL(route.request().url()).pathname;
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });
    if (p === '/auth/start') return route.fulfill({ contentType: 'text/html', body: '<h1>Signed in</h1>' });
    // The first ask comes before Google is done.
    if (p === '/auth/redeem') return ++worker.redeems < 2 ? json({ waiting: true }, 202) : json({ pass: worker.pass, email: 'jens@example.com', name: 'Jens Olemans' });
    if (p === '/auth/token') return json({ access_token: `w${++worker.tokens}`, expires_in: 3600, email: 'jens@example.com', name: 'Jens Olemans' });
    if (p === '/auth/signout') { worker.signouts++; return json({ ok: true }); }
    return route.fulfill({ status: 404 });
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/#/`);
  await page.waitForSelector('#signin');
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.click('#signin')]);
  ok(popup.url().startsWith(`${AUTH}/auth/start?login=`), 'sign-in opens the Worker in a new window');
  await page.waitForSelector('.btn-new', { timeout: 10000 });
  ok(await page.evaluate(() => localStorage.getItem('recipes.pass')) === worker.pass, 'signed in through the Worker, pass kept on this device');
  ok(worker.tokens === 1, 'one token after sign-in');

  // The hour runs out while the page is closed: it comes back signed in, no window.
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('recipes.session'));
    localStorage.setItem('recipes.session', JSON.stringify({ ...s, expires: Date.now() - 1000 }));
  });
  await page.reload();
  await page.waitForSelector('.btn-new', { timeout: 10000 });
  ok(worker.tokens === 2 && !(await page.$('#signin')), 'an hour later it renews quietly, no Renew sign-in');

  // With the connector, New and Edit open Claude with the request typed in.
  const newHref = await page.getAttribute('.btn-new', 'href');
  ok(newHref.startsWith('https://claude.ai/new?q=') && await page.getAttribute('.btn-new', 'target') === '_blank', 'New opens Claude in a new tab');
  ok(await page.$('.menu-pop a[href="#/new"]'), 'the account menu keeps New blank recipe for the editor');
  await page.click('a.card');
  await page.waitForSelector('#edit-btn');
  const recipePath = decodeURIComponent(await page.evaluate(() => location.hash)).replace(/^#\/r\//, '').replace(/\?.*$/, '');
  ok(decodeURIComponent(await page.getAttribute('#edit-btn', 'href')) === `https://claude.ai/new?q=Change my recipe ${recipePath}.cook: `, 'Edit opens Claude with the recipe path');
  ok(await page.$(`.recipe-more a[href="#/edit/${recipePath.split('/').map(encodeURIComponent).join('/')}"]`), 'Edit file in the ⋯ menu opens the editor');
  await page.context().setOffline(true);
  await page.click('#edit-btn');
  await page.waitForSelector('.editor');
  ok((await page.textContent('#toast')).includes("You're offline"), 'offline, Edit opens the editor and says why');
  await page.context().setOffline(false);
  await page.goto(`${BASE}/#/`);
  await page.waitForSelector('.btn-new', { timeout: 10000 });
  const pages = ctx.pages().length;
  await page.click('summary.avatar');
  await page.click('[data-action="signout"]');
  await page.waitForSelector('#signin');
  ok(worker.signouts === 1 && await page.evaluate(() => !localStorage.getItem('recipes.pass')), 'sign out forgets the pass on this device only');
  ok(ctx.pages().length === pages, 'no extra sign-in windows');
  await ctx.close();
}

ok(errors.length === 0, `no page errors ${errors.length ? JSON.stringify(errors.slice(0, 5)) : ''}`);
await browser.close();
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
