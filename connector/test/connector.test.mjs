// Connects to the local Worker the way Claude does (register, Allow page,
// Google, tokens), then calls every tool against the fake Drive and the fake
// recipe site in fake-google.mjs. Run through run.mjs: `npm test`.
import crypto from 'crypto';
const W = 'http://127.0.0.1:8787';
let fails = 0;
const ok = (c, m, extra = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}${c ? '' : ' ' + extra}`); if (!c) fails++; };
const jar = new Map();
const keep = (res) => {
  for (const c of res.headers.getSetCookie()) {
    const [kv] = c.split(';'); const i = kv.indexOf('='); const v = kv.slice(i + 1);
    if (v && !/max-age=0/i.test(c)) jar.set(kv.slice(0, i), v); else jar.delete(kv.slice(0, i));
  }
  return res;
};
const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
const go = async (url, opts = {}) => keep(await fetch(url, { redirect: 'manual', ...opts, headers: { Cookie: cookie(), ...(opts.headers || {}) } }));
const form = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o) });

await fetch('http://localhost:8799/set-email?e=jens.olemans@gmail.com');
let r = await fetch(`${W}/mcp`, { method: 'POST', body: '{}' });
ok(r.status === 401, 'MCP needs a token');
const chal = r.headers.get('www-authenticate') || '';
ok(/resource_metadata=/.test(chal), 'points Claude at the sign-in', chal);
const prm = await fetch(chal.match(/resource_metadata="([^"]+)"/)[1]).then((x) => x.json());
const as = await fetch(`${prm.authorization_servers[0].replace(/\/$/, '')}/.well-known/oauth-authorization-server`).then((x) => x.json());
ok(as.registration_endpoint && as.authorization_endpoint, 'server metadata', JSON.stringify(as));

async function connect(redirect) {
  const reg = await fetch(as.registration_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) }).then((x) => x.json());
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'st1', resource: prm.resource });
  const res = await go(`${as.authorization_endpoint}?${q}`);
  return { reg, verifier, res, html: await res.text() };
}
const handleOf = (html) => html.match(/name="handle" value="([^"]+)"/)?.[1];

let c = await connect('https://evil.example/cb');
ok(c.res.status === 403 && c.html.includes('Only Claude'), 'other apps cannot connect', c.res.status);

c = await connect('https://claude.ai/api/mcp/auth_callback');
ok(c.res.status === 200 && c.html.includes('Allow') && c.html.includes('claude.ai'), 'Allow page names Claude and where access goes', c.html.slice(0, 300));
r = await go(as.authorization_endpoint, form({ handle: handleOf(c.html), decision: 'approve' }));
const g = r.headers.get('location') || '';
ok(r.status === 302 && g.startsWith('http://localhost:8799/auth'), 'Allow goes on to Google', `${r.status} ${g}`);
r = await go(g);
r = await go(r.headers.get('location'));
const back = new URL(r.headers.get('location') || 'http://x/');
ok(r.status === 302 && back.origin === 'https://claude.ai' && back.searchParams.get('code') && back.searchParams.get('state') === 'st1', 'Google sends Claude back with a code', `${r.status} ${back} ${r.status !== 302 ? await r.text() : ''}`);
const tok = await fetch(as.token_endpoint, form({ grant_type: 'authorization_code', code: back.searchParams.get('code'), redirect_uri: 'https://claude.ai/api/mcp/auth_callback', client_id: c.reg.client_id, code_verifier: c.verifier, resource: prm.resource })).then((x) => x.json());
ok(tok.access_token && tok.refresh_token, 'Claude gets its tokens', JSON.stringify(tok));

const call = async (method, params, id = 1) => {
  const res = await fetch(`${W}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${tok.access_token}` }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  return res.status === 202 ? null : res.json();
};
const text = (x) => x?.result?.content?.[0]?.text || JSON.stringify(x);
let m = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
ok(m.result?.protocolVersion === '2025-06-18' && m.result.instructions.includes('cooklang-recipe skill'), 'initialize, with the skill instruction', JSON.stringify(m));
r = await fetch(`${W}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok.access_token}` }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
ok(r.status === 202, 'notifications get 202');
m = await call('tools/list');
ok(m.result?.tools.map((t) => t.name).join() === 'list_folders,find_recipes,read_recipe,save_recipe,move_recipe,set_photo', 'six tools');
let t = text(await call('tools/call', { name: 'list_folders', arguments: {} }));
ok(t.includes('05 Mains/  (1 recipe)') && t.includes('  Curry/  (1 recipe)') && t.includes('main: 05 Mains') && !t.includes('tools/  (') && !t.includes('Other'), 'list_folders: tree, counts, course map', t);
t = text(await call('tools/call', { name: 'find_recipes', arguments: {} }));
ok(t.includes('05 Mains/Curry/dal') && t.includes('05 Mains/lasagna') && !t.includes('stray'), 'find_recipes lists all', t);
t = text(await call('tools/call', { name: 'find_recipes', arguments: { query: 'lentils' } }));
ok(t.startsWith('1 recipe:') && t.includes('dal'), 'find_recipes searches the text', t);
t = text(await call('tools/call', { name: 'find_recipes', arguments: { query: 'lasag' } }));
ok(t.includes('lasagna'), 'find_recipes matches part of the name', t);
t = text(await call('tools/call', { name: 'find_recipes', arguments: { folder: '11 Nowhere' } }));
ok(t.includes('no folder'), 'find_recipes names an unknown folder', t);
t = text(await call('tools/call', { name: 'read_recipe', arguments: { path: '05 Mains/Curry/dal.cook' } }));
ok(t.includes('Photo: dal.jpg') && t.includes('#/r/05%20Mains/Curry/dal') && t.includes('@red lentils{200%g}'), 'read_recipe: text, photo, site link', t);
t = text(await call('tools/call', { name: 'read_recipe', arguments: { path: 'https://jensolemans.github.io/recipes/#/r/05%20Mains/lasagna?s=2' } }));
ok(t.includes('Layer @pasta'), 'read_recipe takes a site link', t);
t = text(await call('tools/call', { name: 'read_recipe', arguments: { path: 'dal' } }));
ok(t.includes('Path: 05 Mains/Curry/dal.cook'), 'read_recipe finds a unique file name', t);
m = await call('tools/call', { name: 'read_recipe', arguments: { path: 'nope' } });
ok(m.result?.isError && text(m).includes('find_recipes'), 'unknown recipe is a helpful error', JSON.stringify(m));
// ---- saving
const fs = await import('fs');
const drv = () => fetch('http://localhost:8799/files').then((x) => x.json());
const good = fs.readFileSync(new URL('./fixtures/dal_tadka.cook', import.meta.url), 'utf8');
const save = async (args) => text(await call('tools/call', { name: 'save_recipe', arguments: args }));
t = await save({ path: '05 Mains/Curry/dal_tadka', text: good });
let made = (await drv()).find((f) => f.name === 'dal_tadka.cook');
ok(t.startsWith('Saved the new recipe 05 Mains/Curry/dal_tadka.cook') && made?.parents[0] === 'F5C' && made.body === good, 'save_recipe makes a new recipe in the folder', t);
ok(t.includes('Add photo: https://jensolemans.github.io/recipes/#/edit/05%20Mains/Curry/dal_tadka') && t.includes('time in the text without'), 'new recipe: Add photo link and style notes', t);
t = text(await call('tools/call', { name: 'find_recipes', arguments: { folder: '05 Mains/Curry' } }));
ok(t.includes('dal_tadka  (no photo)') && !t.includes('dal  (no photo)'), 'find_recipes notes a missing photo', t);
t = await save({ path: '05 Mains/Curry/dal_tadka', text: good });
ok(t.includes('already exists') && (await drv()).filter((f) => f.name === 'dal_tadka.cook').length === 1, 'no overwrite without the version', t);
const ver = text(await call('tools/call', { name: 'read_recipe', arguments: { path: '05 Mains/Curry/dal_tadka' } })).match(/Version: (\S+)/)[1];
const edited = good.replace('servings: 4', 'servings: 6');
t = await save({ path: '05 Mains/Curry/dal_tadka', text: edited, version: ver });
made = (await drv()).find((f) => f.name === 'dal_tadka.cook');
ok(t.startsWith('Saved the change to') && made.body.includes('servings: 6') && made.id.startsWith('N'), 'change saved in place, same file', t);
t = await save({ path: '05 Mains/Curry/dal_tadka', text: good, version: ver });
ok(t.includes('changed since you read it'), 'an old version is refused', t);
t = await save({ path: '05 Mains/bad_one', text: '---\ntitle: The Best Chili\ncourse: dinner\n---\n\n1. Brown @beef{1%lb} at 350 °F.\n' });
ok(t.startsWith('Not saved.') && t.includes('missing required field "cuisine"') && t.includes('imperial unit "lb"') && t.includes('numbered step') && !(await drv()).some((f) => f.name === 'bad_one.cook'), 'house style errors stop the save, with the list', t);
t = await save({ path: '11 Nowhere/x', text: good });
ok(t.includes('no folder'), 'unknown folder refused', t);
t = await save({ path: '05 Mains/Dal Tadka', text: good });
ok(t.includes('snake_case'), 'file name must be snake_case', t);
t = await save({ path: '09 Desserts/lasagna', text: good });
ok(t.includes('already in 05 Mains'), 'same name in another folder: ask first', t);

// ---- moving
const move = async (args) => text(await call('tools/call', { name: 'move_recipe', arguments: args }));
t = await move({ path: '05 Mains/lasagna', to: '05 Mains/Curry' });
let all = await drv();
ok(t.includes('with its photo') && all.find((f) => f.id === 'R2').parents[0] === 'F5C' && all.find((f) => f.id === 'P2').parents[0] === 'F5C', 'move to a folder takes the photo along', t);
t = await move({ path: 'lasagna', to: '05 Mains/lasagna_bolognese' });
all = await drv();
ok(all.find((f) => f.id === 'R2').name === 'lasagna_bolognese.cook' && all.find((f) => f.id === 'P2').name === 'lasagna_bolognese.jpg' && all.find((f) => f.id === 'R2').parents[0] === 'F5', 'move and rename, photo renamed too', t);
t = await move({ path: '05 Mains/lasagna_bolognese', to: '05 Mains/Curry/dal' });
ok(t.includes('already a recipe'), 'move onto another recipe refused', t);

// ---- photos
const { createRequire } = await import('module');
const sharp = createRequire(import.meta.url)('sharp');
const SITE = 'http://localhost:8799/site';
const photo = async (args) => text(await call('tools/call', { name: 'set_photo', arguments: args }));
const meta = async (name) => { const f = (await drv()).find((x) => x.name === name); return f && f.bin ? { ...(await sharp(Buffer.from(f.bin.data)).metadata()), size: f.bin.data.length, f } : null; };
t = await photo({ path: '05 Mains/Curry/dal_tadka', url: `${SITE}/recipe.html` });
let img = await meta('dal_tadka.jpg');
ok(t.includes('1600 x 1067') && t.includes('big.jpg') && img?.format === 'jpeg' && img.width === 1600 && img.height === 1067 && img.f.parents[0] === 'F5C', 'set_photo: biggest photo from the recipe data, resized to 1600 px JPEG', `${t} ${JSON.stringify(img && { w: img.width, h: img.height, format: img.format })}`);
t = await photo({ path: '05 Mains/Curry/dal', url: `${SITE}/og.html` });
ok(t.includes('already has a photo'), 'set_photo asks before replacing', t);
t = await photo({ path: '05 Mains/Curry/dal', url: `${SITE}/og.html`, replace: true });
img = await meta('dal.jpg');
ok(t.includes('1000 x 1400') && img?.format === 'jpeg' && img.height === 1400 && img.f.id === 'P1', 'replace: og:image PNG becomes the JPEG, same file', `${t} ${JSON.stringify(img && { w: img.width, h: img.height, format: img.format, id: img.f.id })}`);
t = await photo({ path: '05 Mains/lasagna_bolognese', url: `${SITE}/small.jpg`, replace: true });
img = await meta('lasagna_bolognese.jpg');
ok(t.includes('600 x 400') && img?.width === 600, 'a direct image link works, small stays small', t);
t = await photo({ path: '05 Mains/Curry/dal_tadka', url: `${SITE}/none.html`, replace: true });
ok(t.includes('No photo found') && t.includes('Paste photo'), 'a page without a photo says so', t);
t = await photo({ path: '05 Mains/Curry/dal_tadka', url: `${SITE}/blocked.html`, replace: true });
ok(t.includes('403') && t.includes('Paste photo'), 'a blocked site says so', t);
t = await photo({ path: '05 Mains/Curry/dal_tadka', url: 'file:///etc/passwd', replace: true });
ok(t.includes('Only http'), 'only web addresses', t);

const ref = await fetch(as.token_endpoint, form({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: c.reg.client_id })).then((x) => x.json());
ok(ref.access_token && ref.access_token !== tok.access_token, 'Claude renews its own token', JSON.stringify(ref));

// Another Google account: no tokens.
jar.clear();
await fetch('http://localhost:8799/set-email?e=someone@gmail.com');
c = await connect('https://claude.ai/api/mcp/auth_callback');
r = await go(as.authorization_endpoint, form({ handle: handleOf(c.html), decision: 'approve' }));
r = await go(r.headers.get('location'));
r = await go(r.headers.get('location'));
ok(r.status === 403, 'another Google account cannot connect', r.status);
c = await connect('https://claude.ai/api/mcp/auth_callback');
r = await go(as.authorization_endpoint, form({ handle: handleOf(c.html), decision: 'deny' }));
ok(r.status === 302 && new URL(r.headers.get('location')).searchParams.get('error') === 'access_denied', 'Cancel tells Claude no');
r = await fetch(`${W}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer nonsense' }, body: '{}' });
ok(r.status === 401, 'made-up token refused');
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
