// What every test file shares: the checks, the browser, and an in-memory
// fake of the Google Drive API so nothing ever touches the real folder.
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';

// Use a local install if there is one, else the global one from `npm i -g playwright`.
const load = (from) => createRequire(from)('playwright');
let pw;
try { pw = load(import.meta.url); } catch { pw = load(path.join(execSync('npm root -g', { shell: true }).toString().trim(), 'noop.js')); }
export const { chromium } = pw;

export const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

export const t = {
  BASE: '',
  RECIPES: '',
  browser: null,
  failures: 0,
  errors: [], // page errors and console errors, checked once at the end
};

export const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) t.failures++; };

/** Waits up to 5 s for fn() to be true. */
export const until2 = async (page, fn) => {
  for (let i = 0; i < 50; i++) { try { if (await fn()) return true; } catch { /* not yet */ } await page.waitForTimeout(100); }
  return false;
};

/** Waits up to 6 s for fn() to be true, and says what it waited for if it never is. */
export const untilOn = (page) => async (fn, what) => {
  for (let i = 0; i < 60; i++) { try { if (await fn()) return true; } catch { /* not yet */ } await page.waitForTimeout(100); }
  console.log('timed out waiting for', what);
  return false;
};

export const shotsOn = (page) => (name) => (process.env.SHOT_DIR ? page.screenshot({ path: `${process.env.SHOT_DIR}/${name}.png` }) : null);

/** Counts the page's errors and blocked requests (with `console`, all its console errors). */
export const watch = (p, { console: logs = false } = {}) => {
  p.on('pageerror', (e) => t.errors.push(e.message));
  p.on('console', (msg) => {
    if (msg.type() !== 'error' || /favicon/.test(msg.text())) return;
    // Something the Content Security Policy blocked always counts.
    if (logs || /Content Security Policy/.test(msg.text())) t.errors.push(`${msg.text()} ${msg.location().url || ''}`.trim());
  });
  return p;
};

/** A signed-out page, as a friend sees the site. Console errors count too. */
export const newPage = async (opts = {}) => watch(await t.browser.newPage({ viewport: { width: 1280, height: 900 }, ...opts }), { console: true });

// ---------- fake Drive ----------
// Starts as a copy of the recipe folder, fresh for every test file, so each
// one can run on its own.

const FOLDER = 'application/vnd.google-apps.folder';
export const files = new Map(); // id -> {id,name,mimeType,parents,content:Buffer,trashed}
let nextId = 1;

function add(name, parent, content = null) {
  const id = name === '__root' ? 'ROOT' : `f${nextId++}`;
  files.set(id, { id, name: name === '__root' ? 'Cooklang Recipes' : name, mimeType: content ? 'text/plain' : FOLDER, parents: parent ? [parent] : [], content, trashed: false, modifiedTime: new Date().toISOString() });
  return id;
}

export const byName = (parent, name) => [...files.values()].find((f) => f.parents.includes(parent) && f.name === name && !f.trashed);
export const configFile = (name) => byName(byName('ROOT', 'config').id, name);
export const configJson = (name) => JSON.parse(configFile(name).content.toString());

export function resetDrive() {
  files.clear();
  nextId = 1;
  (function walk(dir, parent) {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p, add(d.name, parent));
      else add(d.name, parent, fs.readFileSync(p));
    }
  })(t.RECIPES, add('__root', null));
  if (!byName('ROOT', 'config')) add('config', 'ROOT');
  // Start the shopping list and plan from nothing, whatever the folder holds.
  for (const f of files.values()) if (['shopping_list.json', 'pantry.conf', 'plan.json'].includes(f.name)) files.delete(f.id);
  // Change one recipe in "Drive" so the live sync has something to pick up.
  const crepes = byName(byName('ROOT', '01 Breakfast').id, 'crepes.cook');
  crepes.content = Buffer.from(crepes.content.toString().replace('title: Crêpes', 'title: Crêpes (from Drive)'));
}

const pub = (f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, parents: f.parents, modifiedTime: f.modifiedTime, ...(f.content ? { md5Checksum: md5(f.content) } : {}) });

export async function driveRoute(route) {
  const req = route.request();
  const url = new URL(req.url());
  const m = req.method();
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const idMatch = url.pathname.match(/\/files\/([^/]+)$/);
  const id = idMatch?.[1];
  if (url.pathname.endsWith('/about')) return json({ user: { emailAddress: 'jens@example.com', displayName: 'Jens Olemans' } });
  if (url.pathname.startsWith('/drive/v3/files') && m === 'GET' && !id) {
    const parents = [...url.searchParams.get('q').matchAll(/'([^']+)' in parents/g)].map((x) => x[1]);
    return json({ files: [...files.values()].filter((f) => f.parents.some((p) => parents.includes(p)) && !f.trashed).map(pub) });
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
    const addP = url.searchParams.get('addParents'), rem = url.searchParams.get('removeParents');
    if (addP) f.parents = f.parents.filter((p) => p !== rem).concat(addP);
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

// Fake Google sign-in: hands out a token at once, as Google does for someone
// who already allowed access.
export const fakeGis = (route) => route.fulfill({ contentType: 'text/javascript', body: `
  window.__gis = { calls: 0, prompt: null };
  window.google = { accounts: { oauth2: {
    initTokenClient: (o) => ({ requestAccessToken: (p) => {
      window.__gis.calls++; window.__gis.prompt = p && p.prompt;
      setTimeout(() => o.callback({ access_token: 'fake' + window.__gis.calls, expires_in: 3600 }), 50);
    } }),
    revoke: () => {},
  } } };` });

// Points the site at the fake Drive's root folder, whatever the build says,
// so the tests never see the real folder ID or the real Worker.
export async function fakeConfig(route, extra = {}) {
  const res = await route.fetch();
  const data = await res.json();
  data.config = { ...data.config, folderId: 'ROOT', clientId: data.config?.clientId || 'test-client', authUrl: '', ...extra };
  return route.fulfill({ response: res, json: data });
}

/**
 * A browser context signed in to the fake Drive. With `once`, the sign-in is
 * only seeded in the first page, so a later page shows what was kept.
 */
export async function signedIn(opts = {}, { once = false } = {}) {
  const ctx = await t.browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', ...opts });
  await ctx.addInitScript((seedOnce) => {
    if (seedOnce && localStorage.getItem('test.seeded')) return;
    localStorage.setItem('test.seeded', '1');
    localStorage.setItem('recipes.session', JSON.stringify({ token: 'fake', expires: Date.now() + 3600e3, email: 'jens@example.com', name: 'Jens Olemans' }));
    localStorage.setItem('recipes.email', 'jens@example.com');
  }, once);
  await ctx.route('https://www.googleapis.com/**', driveRoute);
  await ctx.route('https://accounts.google.com/gsi/client', fakeGis);
  await ctx.route('**/data/recipes.json', (r) => fakeConfig(r));
  return ctx;
}

export const recipesJson = (page) => page.evaluate(() => fetch('data/recipes.json').then((r) => r.json()));
export const hashPath = (p) => p.split('/').map(encodeURIComponent).join('/');
