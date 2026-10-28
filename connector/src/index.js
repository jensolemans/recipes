// The recipes Worker. For now it does one job: it keeps the site signed in to
// Google. Jens signs in once per device; the Worker keeps Google's long-lasting
// key (the refresh token) and hands the site a fresh one-hour access key
// whenever it asks. Later steps add the connector for Claude on top.
//
// Sign-in works without cookies or window.opener, so it survives Safari's
// tracking rules and the home-screen app:
//   1. The site makes a random login id, opens /auth/start?login=<id> in a new
//      window and asks /auth/redeem every few seconds.
//   2. Google sends the window back to /auth/callback, which stores Google's
//      key and leaves a device pass for that login id.
//   3. /auth/redeem hands the pass to the site once. The site keeps it and
//      trades it for access keys at /auth/token.
//
// KV (binding AUTH):
//   state:<state>   -> login id, while Google's page is open (10 min)
//   login:<id>      -> { pass, email, name } until the site picks it up (10 min)
//   user:<email>    -> Google's refresh token, encrypted with TOKEN_KEY
//   pass:<sha256>   -> { email, name, created } per signed-in device

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const SCOPE = 'openid email profile https://www.googleapis.com/auth/drive';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const TEN_MIN = 600;
const ID_RE = /^[A-Za-z0-9_-]{32,64}$/;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    try {
      if (req.method === 'OPTIONS') return cors(env, origin, new Response(null, { status: 204 }));
      switch (`${req.method} ${url.pathname}`) {
        case 'GET /': return new Response('Recipes connector\n');
        case 'GET /privacy': return privacy(env);
        case 'GET /auth/start': return await start(url, env);
        case 'GET /auth/callback': return await callback(url, env);
        case 'POST /auth/redeem': return cors(env, origin, await redeem(req, env));
        case 'POST /auth/token': return cors(env, origin, await token(req, env));
        case 'POST /auth/signout': return cors(env, origin, await signout(req, env));
        default: return new Response('Not found\n', { status: 404 });
      }
    } catch (e) {
      console.error(e);
      return cors(env, origin, json({ error: 'server', message: 'Something went wrong on the recipes server.' }, 500));
    }
  },
};

// ---------------------------------------------------------------- sign-in

async function start(url, env) {
  const login = url.searchParams.get('login') || '';
  const origin = url.searchParams.get('origin') || '';
  if (!ID_RE.test(login)) return page('Sign-in link is broken', 'Go back to the recipes and tap Sign in again.', 400);
  if (!allowedOrigins(env).includes(origin)) return page('Unknown site', 'This sign-in only works from the recipes site.', 400);
  const state = randomId();
  await env.AUTH.put(`state:${state}`, login, { expirationTtl: TEN_MIN });
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${url.origin}/auth/callback`,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    // Always ask, so Google always hands out a refresh token.
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  const hint = url.searchParams.get('hint');
  if (hint) q.set('login_hint', hint);
  return Response.redirect(`${env.GOOGLE_AUTH_URL || GOOGLE_AUTH}?${q}`, 302);
}

async function callback(url, env) {
  const state = url.searchParams.get('state') || '';
  const login = ID_RE.test(state) ? await env.AUTH.get(`state:${state}`) : null;
  if (!login) return page('Sign-in expired', 'Go back to the recipes and tap Sign in again.', 400);
  await env.AUTH.delete(`state:${state}`);
  if (url.searchParams.get('error')) return page('Sign-in cancelled', 'Nothing changed. Go back to the recipes to try again.');

  const res = await fetch(env.GOOGLE_TOKEN_URL || GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: url.searchParams.get('code') || '',
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${url.origin}/auth/callback`,
      grant_type: 'authorization_code',
    }),
  });
  const t = await res.json().catch(() => ({}));
  if (!res.ok || !t.refresh_token || !t.id_token) {
    console.error('code exchange failed', res.status, t.error);
    return page('Sign-in failed', 'Google did not finish the sign-in. Go back to the recipes and try again.', 502);
  }
  // Straight from Google over HTTPS, so the id token needs no signature check.
  const who = decodeJwt(t.id_token);
  const email = String(who.email || '').toLowerCase();
  if (!who.email_verified || !allowedEmails(env).includes(email)) {
    return page('Not allowed', `${email || 'This account'} cannot sign in here. Only the owner of the recipes can.`, 403);
  }
  if (!String(t.scope || '').split(' ').includes(DRIVE_SCOPE)) {
    return page('Google Drive access is needed', 'Sign in again and leave the Google Drive box ticked, so the site can open your recipes.', 400);
  }
  await env.AUTH.put(`user:${email}`, await seal(env, t.refresh_token));
  const pass = randomId();
  const name = String(who.name || '');
  await env.AUTH.put(`pass:${await sha256(pass)}`, JSON.stringify({ email, name, created: Date.now() }));
  await env.AUTH.put(`login:${login}`, JSON.stringify({ pass, email, name }), { expirationTtl: TEN_MIN });
  return page('Signed in', 'You can close this window and go back to the recipes.', 200, true);
}

/** The site asks here until the sign-in window is done. Hands the pass out once. */
async function redeem(req, env) {
  const { login } = await body(req);
  if (!ID_RE.test(login || '')) return json({ error: 'bad_request' }, 400);
  const found = await env.AUTH.get(`login:${login}`);
  if (!found) return json({ waiting: true }, 202);
  await env.AUTH.delete(`login:${login}`);
  return json(JSON.parse(found));
}

/** Trades a device pass for a fresh one-hour Google access key. */
async function token(req, env) {
  const device = await passInfo(req, env);
  if (!device) return json({ error: 'signin', message: 'This device is signed out. Sign in again.' }, 401);
  const sealed = await env.AUTH.get(`user:${device.email}`);
  if (!sealed) return json({ error: 'signin', message: 'Sign in again.' }, 401);
  const res = await fetch(env.GOOGLE_TOKEN_URL || GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: await unseal(env, sealed),
      grant_type: 'refresh_token',
    }),
  });
  const t = await res.json().catch(() => ({}));
  if (t.error === 'invalid_grant') {
    // Revoked in the Google account, or unused for six months.
    await env.AUTH.delete(`user:${device.email}`);
    return json({ error: 'signin', message: 'Google ended the sign-in. Sign in again.' }, 401);
  }
  if (!res.ok || !t.access_token) {
    console.error('refresh failed', res.status, t.error);
    return json({ error: 'google', message: 'Google did not answer. Try again in a moment.' }, 502);
  }
  return json({ access_token: t.access_token, expires_in: t.expires_in || 3600, email: device.email, name: device.name });
}

async function signout(req, env) {
  const { pass } = await body(req);
  if (typeof pass === 'string' && pass) await env.AUTH.delete(`pass:${await sha256(pass)}`);
  return json({ ok: true });
}

async function passInfo(req, env) {
  const { pass } = await body(req);
  if (typeof pass !== 'string' || !ID_RE.test(pass)) return null;
  const v = await env.AUTH.get(`pass:${await sha256(pass)}`);
  return v ? JSON.parse(v) : null;
}

// Google asks for a privacy policy before the sign-in may leave Testing.
function privacy(env) {
  const owner = allowedEmails(env)[0] || '';
  return page('Privacy', `This is a personal recipe site. Only its owner (${owner}) can sign in. `
    + 'Signing in lets the site read and change the recipe files in the owner\'s own Google Drive. '
    + 'The sign-in key is stored encrypted on this server only to keep the owner signed in, and is never shared or used for anything else. '
    + 'Visitors who do not sign in are not tracked and nothing about them is stored.');
}

// ---------------------------------------------------------------- helpers

const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const allowedOrigins = (env) => list(env.ALLOWED_ORIGINS);
const allowedEmails = (env) => list(env.ALLOWED_EMAILS).map((e) => e.toLowerCase());

function cors(env, origin, res) {
  if (!allowedOrigins(env).includes(origin)) return res;
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', origin);
  h.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type');
  h.set('Access-Control-Max-Age', '86400');
  h.set('Vary', 'Origin');
  return new Response(res.body, { status: res.status, headers: h });
}

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

async function body(req) {
  try { return await req.json(); } catch { return {}; }
}

function page(title, text, status = 200, close = false) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:17px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#FAFAFA;color:#0E0E0E}
main{max-width:22rem;padding:24px}h1{font-size:1.4rem;margin:0 0 .4rem}p{margin:0;color:#555}
@media (prefers-color-scheme:dark){body{background:#0E0E0E;color:#FAFAFA}p{color:#aaa}}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(text)}</p></main>${close ? '<script>setTimeout(()=>window.close(),800)</script>' : ''}</body></html>`, {
    status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function randomId() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return b64url(b);
}

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function decodeJwt(jwt) {
  try { return JSON.parse(new TextDecoder().decode(unb64url(jwt.split('.')[1]))); } catch { return {}; }
}

async function sha256(s) {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
}

// Google's refresh token is stored encrypted (AES-GCM) with TOKEN_KEY, a
// Worker secret, so the KV store alone does not give access to Drive.
let keyCache;
function key(env) {
  keyCache ||= crypto.subtle.importKey('raw', unb64url(env.TOKEN_KEY), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return keyCache;
}

async function seal(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(env), new TextEncoder().encode(text)));
  return `${b64url(iv)}.${b64url(data)}`;
}

async function unseal(env, sealed) {
  const [iv, data] = sealed.split('.').map(unb64url);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await key(env), data));
}
