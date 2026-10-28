// The site's sign-in through the Worker: start, Google, redeem the pass,
// trade it for tokens, sign out, and who is refused. Run through run.mjs.
const W = 'http://127.0.0.1:8787', O = 'http://localhost:8000';
import crypto from 'crypto';
const rid = () => crypto.randomBytes(32).toString('base64url');
let fails = 0; const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) fails++; };
const post = (p, b, origin = O) => fetch(W + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(b) });
async function signIn(email) {
  await fetch(`http://localhost:8799/set-email?e=${email}`);
  const login = rid();
  let r = await post('/auth/redeem', { login });
  ok(r.status === 202, 'redeem waits before sign-in');
  ok(r.headers.get('access-control-allow-origin') === O, 'CORS for the site');
  r = await fetch(`${W}/auth/start?login=${login}&origin=${encodeURIComponent(O)}`, { redirect: 'manual' });
  const g = r.headers.get('location'); ok(r.status === 302 && g.startsWith('http://localhost:8799/auth'), 'start sends to Google');
  ok(new URL(g).searchParams.get('access_type') === 'offline', 'asks for a refresh token');
  r = await fetch(g, { redirect: 'manual' });
  r = await fetch(r.headers.get('location'));
  const html = await r.text();
  return { login, status: r.status, html };
}
let s = await signIn('jens.olemans@gmail.com');
ok(s.status === 200 && s.html.includes('Signed in'), 'callback says signed in');
let r = await post('/auth/redeem', { login: s.login }); const got = await r.json();
ok(r.status === 200 && got.pass && got.email === 'jens.olemans@gmail.com', 'redeem hands out the pass');
r = await post('/auth/redeem', { login: s.login }); ok(r.status === 202, 'pass handed out only once');
r = await post('/auth/token', { pass: got.pass }); let t = await r.json();
ok(r.status === 200 && t.access_token?.startsWith('fresh') && t.name === 'Jens Olemans', 'token from pass');
r = await post('/auth/token', { pass: got.pass }); let t2 = await r.json();
ok(t2.access_token !== t.access_token, 'each call gets a fresh token');
r = await post('/auth/token', { pass: rid() }); ok(r.status === 401, 'unknown pass refused');
r = await post('/auth/token', { pass: got.pass }, 'https://evil.example'); ok(!r.headers.get('access-control-allow-origin'), 'no CORS for other sites');
r = await fetch(`${W}/auth/start?login=${rid()}&origin=https://evil.example`, { redirect: 'manual' }); ok(r.status === 400, 'start refuses other sites');
r = await post('/auth/signout', { pass: got.pass }); ok(r.status === 200, 'sign out');
r = await post('/auth/token', { pass: got.pass }); ok(r.status === 401, 'pass dead after sign out');
s = await signIn('someone.else@gmail.com');
ok(s.status === 403 && s.html.includes('Not allowed'), 'other Google accounts refused');
r = await post('/auth/redeem', { login: s.login }); ok(r.status === 202, 'refused sign-in leaves no pass');
r = await fetch(`${W}/auth/callback?state=${rid()}&code=x`); ok(r.status === 400, 'callback with unknown state refused');
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
