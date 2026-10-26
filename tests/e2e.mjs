// End-to-end test: viewer on every recipe, scaling, filters, and the editor
// against an in-memory fake of the Google Drive API.
// Usage: node tests/e2e.mjs <site-url> <recipes-dir>
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
const { chromium } = createRequire(import.meta.url)('playwright');

const [, , BASE, RECIPES] = process.argv;
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failures++; };

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
const pub = (f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, parents: f.parents, modifiedTime: f.modifiedTime, ...(f.content ? { md5Checksum: md5(f.content) } : {}) });
const byName = (parent, name) => [...files.values()].find((f) => f.parents.includes(parent) && f.name === name && !f.trashed);

// Change one recipe in "Drive" so the live sync has something to pick up.
const crepesFolder = byName('ROOT', '1 Breakfast').id;
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
  p.on('console', (msg) => { if (msg.type() === 'error' && !/favicon/.test(msg.text())) errors.push(msg.text()); });
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
  await page.goto(`${BASE}/#/r/1%20Breakfast/crepes`);
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
  await page.click('.chapter[data-ch="1 Breakfast"]');
  ok((await page.$$('.card')).length === 5, 'Breakfast chapter shows 5');
  await page.click('.chapter[data-ch=""]');
  await page.click('#toggle-filters');
  await page.click('.opt[data-key="diet"][data-val="vegan"]');
  const n = (await page.$$('.card')).length;
  ok(n > 0 && n < 155, `vegan filter narrows the list (${n})`);
  await page.close();
}

// 4. mobile layout has no horizontal scroll
{
  const page = await newPage({ viewport: { width: 375, height: 800 } });
  for (const h of ['#/', '#/r/3%20Mains/Pasta/lasagna']) {
    await page.goto(`${BASE}/${h}`);
    await page.waitForTimeout(800);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok(over <= 0, `no sideways scroll on phone for ${h} (${over}px)`);
  }
  await page.close();
}

// 5. editor against fake Drive
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(() => {
    localStorage.setItem('recipes.session', JSON.stringify({ token: 'fake', expires: Date.now() + 3600e3, email: 'jens@example.com', name: 'Jens Olemans' }));
    localStorage.setItem('recipes.email', 'jens@example.com');
  });
  await ctx.route('https://www.googleapis.com/**', driveRoute);
  await ctx.route('https://accounts.google.com/gsi/client', fakeGis);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/#/`);
  await page.waitForSelector('a[href="#/new"]', { timeout: 15000 });
  ok(true, 'signed-in session goes live');
  ok(await page.isVisible('text=Crêpes (from Drive)'), 'change made in Drive shows up live');

  // edit crepes
  await page.goto(`${BASE}/#/edit/1%20Breakfast/crepes`);
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
  await page.goto(`${BASE}/#/edit/1%20Breakfast/crepes`);
  await page.waitForSelector('#src');
  byName(crepesFolder, 'crepes.cook').content = Buffer.from(saved + '\n> Edited on phone\n');
  await page.fill('#src', (await page.inputValue('#src')) + '\n> Edited on web\n');
  await page.click('#save');
  await page.waitForSelector('dialog[open]');
  ok((await page.textContent('dialog')).includes('changed in Google Drive'), 'warns when the file changed elsewhere');
  await page.click('dialog button:has-text("Cancel")');
  ok(byName(crepesFolder, 'crepes.cook').content.toString().includes('Edited on phone'), 'cancel keeps the Drive version');

  // unsaved-changes guard
  await page.click('a.link-btn:has-text("Cancel")');
  await page.waitForSelector('dialog[open]');
  await page.click('dialog button:has-text("Discard changes")');
  await page.waitForSelector('.recipe');
  ok(true, 'leaving with unsaved changes asks first');

  // new recipe with photo
  await page.goto(`${BASE}/#/new`);
  await page.waitForSelector('#src');
  await page.selectOption('#folder', '7 Drinks');
  await page.fill('#src', '---\ntitle: Test Spritz\nservings: 2\ntime: 5m\n---\n\nPour @prosecco{90%ml} over @ice{} in a #wine glass{}.\n');
  await page.waitForTimeout(400);
  ok(await page.inputValue('#file') === 'test_spritz', 'file name follows the title');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await page.setInputFiles('#photo', { name: 'photo.png', mimeType: 'image/png', buffer: png });
  await page.waitForTimeout(500);
  await page.click('#save');
  await page.waitForSelector('.recipe[data-path="7 Drinks/test_spritz"]');
  const drinks = byName('ROOT', '7 Drinks').id;
  ok(Boolean(byName(drinks, 'test_spritz.cook')), 'new recipe created in Drive');
  const photo = byName(drinks, 'test_spritz.jpg');
  ok(Boolean(photo) && photo.content[0] === 0xff && photo.content[1] === 0xd8, 'photo uploaded as JPEG next to it');

  // move + rename
  await page.goto(`${BASE}/#/edit/7%20Drinks/test_spritz`);
  await page.waitForSelector('#src');
  await page.selectOption('#folder', '5 Sauces and Basics');
  await page.fill('#file', 'spritz_test');
  await page.click('#save');
  await page.waitForSelector('.recipe[data-path="5 Sauces and Basics/spritz_test"]');
  const sauces = byName('ROOT', '5 Sauces and Basics').id;
  ok(Boolean(byName(sauces, 'spritz_test.cook')) && Boolean(byName(sauces, 'spritz_test.jpg')), 'move and rename keeps the photo with the recipe');

  // delete
  await page.goto(`${BASE}/#/edit/5%20Sauces%20and%20Basics/spritz_test`);
  await page.waitForSelector('#del');
  await page.click('#del');
  await page.click('dialog button:has-text("Move to trash")');
  await page.waitForSelector('.home');
  ok(!byName(sauces, 'spritz_test.cook') && !byName(sauces, 'spritz_test.jpg'), 'delete moves recipe and photo to trash');
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/live-home.png` });
  await page.goto(`${BASE}/#/edit/3%20Mains/Curry/aloo_gobi`);
  await page.waitForSelector('#preview .step');
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/editor.png` });
  await ctx.close();
}

// 6. sign-in survives closing the tab, and renews in place when the hour ends
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(() => {
    if (localStorage.getItem('test.seeded')) return;
    localStorage.setItem('test.seeded', '1');
    localStorage.setItem('recipes.session', JSON.stringify({ token: 'fake', expires: Date.now() + 3600e3, email: 'jens@example.com', name: 'Jens Olemans' }));
    localStorage.setItem('recipes.email', 'jens@example.com');
  });
  await ctx.route('https://www.googleapis.com/**', driveRoute);
  await ctx.route('https://accounts.google.com/gsi/client', fakeGis);
  const first = await ctx.newPage();
  await first.goto(`${BASE}/#/`);
  await first.waitForSelector('a[href="#/new"]', { timeout: 15000 });
  await first.close();

  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/#/edit/1%20Breakfast/crepes`);
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

ok(errors.length === 0, `no page errors ${errors.length ? JSON.stringify(errors.slice(0, 5)) : ''}`);
await browser.close();
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
