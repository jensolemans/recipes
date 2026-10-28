// The recipes Worker. Two jobs, both resting on one Google sign-in:
//
// 1. Keep the site signed in to Google. Jens signs in once per device; the
//    Worker keeps Google's long-lasting key (the refresh token) and hands the
//    site a fresh one-hour access key whenever it asks.
// 2. The recipes connector for Claude (MCP at /mcp, tools in mcp.js). Claude
//    signs in with OAuth: /authorize shows an Allow page, then Google, and
//    the library (@cloudflare/workers-oauth-provider) hands Claude its own
//    tokens. Only Jens's Google account gets through, and only to Claude.
//
// The site's sign-in works without cookies or window.opener, so it survives
// Safari's tracking rules and the home-screen app:
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
// KV (binding OAUTH_KV): Claude's clients, grants and tokens, run by the library.

import { OAuthProvider, AuthorizationError, CimdFetchError, authorizationErrorRedirect } from '@cloudflare/workers-oauth-provider';
import { mcp } from './mcp.js';

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const SCOPE = 'openid email profile https://www.googleapis.com/auth/drive';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const TEN_MIN = 600;
const ID_RE = /^[A-Za-z0-9_-]{32,64}$/;

const DAY = 86400;

const site = {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    try {
      if (req.method === 'OPTIONS') return cors(env, origin, new Response(null, { status: 204 }));
      switch (`${req.method} ${url.pathname}`) {
        case 'GET /': return new Response('Recipes connector\n');
        case 'GET /privacy': return privacy(env);
        case 'GET /authorize': return await authorize(req, env);
        case 'POST /authorize': return await authorizeAnswer(req, env);
        case 'GET /auth/start': return await start(url, env);
        case 'GET /auth/callback': return await callback(req, url, env);
        case 'POST /auth/redeem': return cors(env, origin, await redeem(req, env));
        case 'POST /auth/token': return cors(env, origin, await token(req, env));
        case 'POST /auth/signout': return cors(env, origin, await signout(req, env));
        default: return new Response('Not found\n', { status: 404 });
      }
    } catch (e) {
      if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
      if (e instanceof AuthorizationError) return page('Connecting stopped', `${e.description || 'This link expired or was already used.'} Start connecting again from Claude.`, 400);
      if (e instanceof CimdFetchError) return page('Unknown app', 'This app could not be checked. Start connecting again from Claude.', 400);
      console.error(e);
      return cors(env, origin, json({ error: 'server', message: 'Something went wrong on the recipes server.' }, 500));
    }
  },
};

// Made on the first request: the library needs the Worker's own address.
let provider;
export default {
  fetch(req, env, ctx) {
    provider ||= new OAuthProvider({
      apiRoute: '/mcp',
      apiHandler: { fetch: (req, env, ctx) => mcp(req, env, ctx, googleAccess) },
      defaultHandler: site,
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/oauth/token',
      clientRegistrationEndpoint: '/oauth/register',
      // Claude stays connected while it is used; half a year idle and it asks again.
      refreshTokenTTL: 180 * DAY,
      refreshTokenIdleTTL: 180 * DAY,
      resourceMetadata: { resource: `${env.PUBLIC_URL}/mcp`, authorization_servers: [env.PUBLIC_URL] },
    });
    return provider.fetch(req, env, ctx);
  },
};

// ---------------------------------------------------------------- Claude connects

// Where Claude's tokens may go: Claude on the web, the apps (which use the same
// address) and Claude Code on this laptop.
const redirectAllowed = (env, uri) => {
  try { return list(env.ALLOWED_REDIRECT_HOSTS).includes(new URL(uri).hostname); } catch { return false; }
};

async function authorize(req, env) {
  const oauth = env.OAUTH_PROVIDER;
  const request = await oauth.parseAuthRequest(req);
  if (!redirectAllowed(env, request.redirectUri)) {
    return page('Not allowed', 'Only Claude can connect to the recipes.', 403);
  }
  const details = await oauth.describeConsent(request);
  const consent = await oauth.beginConsent(request);
  consent.headers.set('Content-Type', 'text/html; charset=utf-8');
  return new Response(consentPage(details, consent.handle), { headers: consent.headers });
}

async function authorizeAnswer(req, env) {
  const oauth = env.OAUTH_PROVIDER;
  const form = await req.formData();
  const handle = String(form.get('handle') || '');
  if (form.get('decision') !== 'approve') {
    const denied = await oauth.denyConsent(req, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const approved = await oauth.approveConsent(req, handle);
  // Allowed: now on to Google, which proves it is Jens.
  const { state, headers } = await oauth.beginUpstream(approved.request, { headers: approved.headers });
  headers.set('Location', googleUrl(new URL(req.url), env, state));
  return new Response(null, { status: 302, headers });
}

function consentPage(d, handle) {
  const local = d.redirectIsLoopback
    ? '<p><strong>This connects an app on this computer.</strong> Continue only if you just started it, for example in Claude Code.</p>' : '';
  return pageHtml('Connect to your recipes', `
<p><strong>${esc(d.clientName || 'An app')}</strong> wants to read and change the recipes in your Google Drive.
Access goes to <strong>${esc(d.redirectHost)}</strong>.</p>${local}
<form method="post"><input type="hidden" name="handle" value="${esc(handle)}">
<p class="actions"><button name="decision" value="approve">Allow</button>
<button name="decision" value="deny" class="quiet">Cancel</button></p></form>
<p class="small">Next, Google asks you to sign in. Only the owner of the recipes can connect.</p>`);
}

// ---------------------------------------------------------------- sign-in

async function start(url, env) {
  const login = url.searchParams.get('login') || '';
  const origin = url.searchParams.get('origin') || '';
  if (!ID_RE.test(login)) return page('Sign-in link is broken', 'Go back to the recipes and tap Sign in again.', 400);
  if (!allowedOrigins(env).includes(origin)) return page('Unknown site', 'This sign-in only works from the recipes site.', 400);
  const state = randomId();
  await env.AUTH.put(`state:${state}`, login, { expirationTtl: TEN_MIN });
  return Response.redirect(googleUrl(url, env, state, url.searchParams.get('hint')), 302);
}

function googleUrl(url, env, state, hint) {
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
  if (hint) q.set('login_hint', hint);
  return `${env.GOOGLE_AUTH_URL || GOOGLE_AUTH}?${q}`;
}

// Google comes back here for both: the site's sign-in (its state is in AUTH)
// and Claude connecting (the library's state, bound to this browser).
async function callback(req, url, env) {
  const state = url.searchParams.get('state') || '';
  const login = ID_RE.test(state) ? await env.AUTH.get(`state:${state}`) : null;
  if (login) return siteCallback(url, env, state, login);
  return claudeCallback(req, url, env);
}

async function siteCallback(url, env, state, login) {
  await env.AUTH.delete(`state:${state}`);
  if (url.searchParams.get('error')) return page('Sign-in cancelled', 'Nothing changed. Go back to the recipes to try again.');
  const who = await googleSignIn(url, env, 'Go back to the recipes and try again.');
  if (who instanceof Response) return who;
  const pass = randomId();
  await env.AUTH.put(`pass:${await sha256(pass)}`, JSON.stringify({ email: who.email, name: who.name, created: Date.now() }));
  await env.AUTH.put(`login:${login}`, JSON.stringify({ pass, email: who.email, name: who.name }), { expirationTtl: TEN_MIN });
  return page('Signed in', 'You can close this window and go back to the recipes.', 200, true);
}

async function claudeCallback(req, url, env) {
  const oauth = env.OAUTH_PROVIDER;
  const { request, headers } = await oauth.finishUpstream(req);
  if (url.searchParams.get('error')) {
    headers.set('Location', authorizationErrorRedirect(request, 'access_denied'));
    return new Response(null, { status: 302, headers });
  }
  const who = await googleSignIn(url, env, 'Start connecting again from Claude.');
  if (who instanceof Response) return who;
  const { redirectTo } = await oauth.completeAuthorization({
    request,
    userId: who.email,
    metadata: {},
    scope: request.scope,
    props: { email: who.email },
  });
  headers.set('Location', redirectTo);
  return new Response(null, { status: 302, headers });
}

/**
 * Trades Google's code for its keys, checks it is the owner with Drive access,
 * and keeps the refresh token. Returns { email, name }, or an error page.
 */
async function googleSignIn(url, env, retry) {
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
    return page('Sign-in failed', `Google did not finish the sign-in. ${retry}`, 502);
  }
  // Straight from Google over HTTPS, so the id token needs no signature check.
  const who = decodeJwt(t.id_token);
  const email = String(who.email || '').toLowerCase();
  if (!who.email_verified || !allowedEmails(env).includes(email)) {
    return page('Not allowed', `${email || 'This account'} cannot sign in here. Only the owner of the recipes can.`, 403);
  }
  if (!String(t.scope || '').split(' ').includes(DRIVE_SCOPE)) {
    return page('Google Drive access is needed', 'Sign in again and leave the Google Drive box ticked, so your recipes can be opened.', 400);
  }
  await env.AUTH.put(`user:${email}`, await seal(env, t.refresh_token));
  accessCache.delete(email);
  return { email, name: String(who.name || '') };
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
  try {
    const t = await googleAccess(env, device.email, true);
    return json({ access_token: t.token, expires_in: Math.round((t.expires - Date.now()) / 1000), email: device.email, name: device.name });
  } catch (e) {
    if (e.code === 'signin') return json({ error: 'signin', message: `${e.message} Sign in again.` }, 401);
    console.error('refresh failed', e.message);
    return json({ error: 'google', message: 'Google did not answer. Try again in a moment.' }, 502);
  }
}

// One-hour Google keys per account, kept while this Worker instance lives.
const accessCache = new Map();

/**
 * A Google access key for this account, from its stored refresh token.
 * Throws { code: 'signin' } when Google ended the sign-in. `fresh` skips the
 * cache: each device gets its own key.
 */
export async function googleAccess(env, email, fresh = false) {
  const hit = accessCache.get(email);
  if (!fresh && hit && hit.expires > Date.now() + 120_000) return hit;
  const sealed = await env.AUTH.get(`user:${email}`);
  if (!sealed) throw Object.assign(new Error('Not signed in to Google.'), { code: 'signin' });
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
    await env.AUTH.delete(`user:${email}`);
    accessCache.delete(email);
    throw Object.assign(new Error('Google ended the sign-in.'), { code: 'signin' });
  }
  if (!res.ok || !t.access_token) throw new Error(`Google refresh failed: ${res.status} ${t.error || ''}`);
  const out = { token: t.access_token, expires: Date.now() + (t.expires_in || 3600) * 1000 };
  accessCache.set(email, out);
  return out;
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

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title, text, status = 200, close = false) {
  return new Response(pageHtml(title, `<p>${esc(text)}</p>${close ? '<script>setTimeout(()=>window.close(),800)</script>' : ''}`), {
    status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function pageHtml(title, inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:17px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#FAFAFA;color:#0E0E0E}
main{max-width:24rem;padding:24px}h1{font-size:1.4rem;margin:0 0 .4rem}p{margin:0 0 .8rem;color:#555}strong{color:inherit}
.small{font-size:.9rem}.actions{display:flex;gap:8px;margin-top:1.2rem}
button{font:inherit;border:0;border-radius:999px;padding:.6rem 1.3rem;background:#0E0E0E;color:#FAFAFA;cursor:pointer}
button.quiet{background:transparent;color:inherit;box-shadow:inset 0 0 0 1px #ccc}button:focus-visible{outline:2px solid #E77B54;outline-offset:2px}
@media (prefers-color-scheme:dark){body{background:#0E0E0E;color:#FAFAFA}p{color:#aaa}button{background:#FAFAFA;color:#0E0E0E}button.quiet{color:#FAFAFA;box-shadow:inset 0 0 0 1px #444}}</style></head>
<body><main><h1>${esc(title)}</h1>${inner}</main></body></html>`;
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
