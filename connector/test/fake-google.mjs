// Fake Google sign-in, Google Drive and a recipe website, for testing the
// Worker locally without touching the real Drive folder.
// Usage: node fake-google.mjs <path to cooklint.py>   (run.mjs starts it)
// Extra routes for the tests: /reset, /files, /set-email?e=.
import http from 'http';
import fs from 'fs';
import crypto from 'crypto';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
let email = process.env.FAKE_EMAIL || 'jens.olemans@gmail.com';
let refreshes = 0;

const FOLDER = 'application/vnd.google-apps.folder';
const lintSrc = process.argv[2] ? fs.readFileSync(process.argv[2], 'utf8') : "FOLDER_FOR_COURSE = {'main': '05 Mains',\n  'dessert': '09 Desserts'}\n";
let files;
let nextId;
function reset() {
  nextId = 1;
  files = [
    { id: 'F5', name: '05 Mains', mimeType: FOLDER, parents: ['ROOT'] },
    { id: 'F5C', name: 'Curry', mimeType: FOLDER, parents: ['F5'] },
    { id: 'F9', name: '09 Desserts', mimeType: FOLDER, parents: ['ROOT'] },
    { id: 'FT', name: 'tools', mimeType: FOLDER, parents: ['ROOT'] },
    { id: 'FX', name: 'Other', mimeType: FOLDER, parents: ['MYDRIVE'] },
    { id: 'R1', name: 'dal.cook', parents: ['F5C'], body: '---\ntitle: Dal\ntags: [lentils, vegan]\n---\n\nCook @red lentils{200%g}.\n' },
    { id: 'P1', name: 'dal.jpg', parents: ['F5C'], body: 'jpg' },
    { id: 'R2', name: 'lasagna.cook', parents: ['F5'], body: '---\ntitle: Lasagna\n---\n\nLayer @pasta sheets{12}.\n' },
    { id: 'P2', name: 'lasagna.jpg', parents: ['F5'], body: 'jpg2' },
    { id: 'L1', name: 'cooklint.py', parents: ['FT'], body: lintSrc },
    { id: 'X1', name: 'stray.cook', parents: ['FX'], body: 'lentils elsewhere' },
  ];
}
reset();
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const pub = ({ body, bin, ...f }) => ({ ...f, mimeType: f.mimeType || 'text/plain', ...(body != null ? { md5Checksum: md5(body) } : {}) });
const readBuf = async (req) => { const c = []; for await (const x of req) c.push(x); return Buffer.concat(c); };
const read = async (req) => (await readBuf(req)).toString('utf8');
// Text files keep body (a string); photos keep bin (a Buffer).
const store = (f, buf, type) => { if (/^image\//.test(type)) { f.bin = buf; f.body = buf.toString('latin1'); f.mimeType = type; } else { f.body = buf.toString('utf8'); delete f.bin; } };

async function drive(req, res, u) {
  res.setHeader('Content-Type', 'application/json');
  if (!/^Bearer fresh\d+$/.test(req.headers.authorization || '')) { res.statusCode = 401; return res.end('{}'); }
  if (u.pathname === '/upload/drive/v3/files' && req.method === 'POST') {
    const raw = (await readBuf(req)).toString('latin1');
    const boundary = req.headers['content-type'].match(/boundary=(.+)$/)[1];
    const parts = raw.split(`--${boundary}`).slice(1, -1);
    const head = (part) => part.slice(0, part.indexOf('\r\n\r\n'));
    const content = (part) => part.slice(part.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, '');
    const meta = JSON.parse(Buffer.from(content(parts[0]), 'latin1').toString('utf8'));
    const f = { id: `N${nextId++}`, name: meta.name, parents: meta.parents };
    store(f, Buffer.from(content(parts[1]), 'latin1'), (head(parts[1]).match(/Content-Type: ([^;\r\n]+)/i) || [])[1] || 'text/plain');
    files.push(f);
    return res.end(JSON.stringify(pub(f)));
  }
  const up = u.pathname.match(/^\/upload\/drive\/v3\/files\/([^/]+)$/);
  if (up && req.method === 'PATCH') {
    const f = files.find((x) => x.id === up[1]);
    store(f, await readBuf(req), req.headers['content-type'] || 'text/plain');
    return res.end(JSON.stringify(pub(f)));
  }
  const m = u.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
  if (m && req.method === 'PATCH') {
    const f = files.find((x) => x.id === m[1]);
    const meta = JSON.parse(await read(req) || '{}');
    if (meta.name) f.name = meta.name;
    const add = u.searchParams.get('addParents'), rem = u.searchParams.get('removeParents');
    if (add) f.parents = f.parents.filter((p) => p !== rem).concat(add);
    return res.end(JSON.stringify(pub(f)));
  }
  if (m) { const f = files.find((x) => x.id === m[1]); res.setHeader('Content-Type', f.mimeType || 'text/plain'); return res.end(f.bin || f.body); }
  const q = u.searchParams.get('q');
  const parents = [...q.matchAll(/'([^']+)' in parents/g)].map((x) => x[1]);
  const words = [...q.matchAll(/fullText contains '([^']+)'/g)].map((x) => x[1].toLowerCase());
  const name = q.match(/name = '([^']+)'/)?.[1];
  let out = files;
  if (/mimeType = '/.test(q)) out = out.filter((f) => f.mimeType === FOLDER);
  if (/mimeType != '/.test(q)) out = out.filter((f) => f.mimeType !== FOLDER);
  if (parents.length) out = out.filter((f) => f.parents.some((p) => parents.includes(p)));
  if (words.length) out = out.filter((f) => f.body && words.every((w) => f.body.toLowerCase().includes(w)));
  if (name) out = out.filter((f) => f.name === name);
  res.end(JSON.stringify({ files: out.map(pub) }));
}


// Test photos, made once with sharp (no image files in the repo).
const SITE = new URL('./.site/', import.meta.url);
const page = (images, og) => `<html><head>${og ? `<meta property="og:image" content="${og}">` : ''}
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage"},{"@type":"Recipe","name":"Dal","image":${JSON.stringify(images)}}]}</script></head><body>Dal</body></html>`;
function site(req, res, u) {
  const send = (type, body, status = 200) => { res.writeHead(status, { 'Content-Type': type }); res.end(body); };
  switch (u.pathname) {
    case '/site/recipe.html': return send('text/html', page([{ '@type': 'ImageObject', url: '/site/small.jpg' }, 'http://localhost:8799/site/big.jpg?w=300']));
    case '/site/og.html': return send('text/html', page([], '/site/tall.png'));
    case '/site/none.html': return send('text/html', '<html><body>No photo here</body></html>');
    case '/site/blocked.html': return send('text/html', 'no', 403);
    case '/site/big.jpg': return u.search ? send('image/jpeg', fs.readFileSync(new URL('small.jpg', SITE))) : send('image/jpeg', fs.readFileSync(new URL('big.jpg', SITE)));
    case '/site/small.jpg': return send('image/jpeg', fs.readFileSync(new URL('small.jpg', SITE)));
    case '/site/tall.png': return send('image/png', fs.readFileSync(new URL('tall.png', SITE)));
  }
  send('text/plain', 'not found', 404);
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/site/')) return site(req, res, u);
  if (u.pathname.startsWith('/drive/') || u.pathname.startsWith('/upload/')) return drive(req, res, u);
  if (u.pathname === '/auth') {
    res.writeHead(302, { Location: `${u.searchParams.get('redirect_uri')}?code=c123&state=${u.searchParams.get('state')}` });
    return res.end();
  }
  if (u.pathname === '/set-email') { email = u.searchParams.get('e'); return res.end('ok'); }
  if (u.pathname === '/reset') { reset(); return res.end('ok'); }
  if (u.pathname === '/files') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(files)); }
  if (u.pathname === '/token') {
    const p = new URLSearchParams(await read(req));
    res.setHeader('Content-Type', 'application/json');
    if (p.get('client_secret') !== 'test-secret') { res.statusCode = 401; return res.end('{"error":"invalid_client"}'); }
    if (p.get('grant_type') === 'authorization_code') {
      return res.end(JSON.stringify({ access_token: 'a0', refresh_token: 'r-secret', expires_in: 3600,
        scope: 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive',
        id_token: `x.${b64({ email, email_verified: true, name: 'Jens Olemans' })}.y` }));
    }
    if (p.get('refresh_token') !== 'r-secret') { res.statusCode = 400; return res.end('{"error":"invalid_grant"}'); }
    refreshes++;
    return res.end(JSON.stringify({ access_token: `fresh${refreshes}`, expires_in: 3600 }));
  }
  res.statusCode = 404; res.end();
}).listen(8799, () => console.log('fake google on 8799'));
