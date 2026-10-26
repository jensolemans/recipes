// Google sign-in (Google Identity Services token flow) and the Google Drive
// calls the editor needs. Everything runs in the browser with the signed-in
// user's own token: no server, and only someone who can edit the Drive folder
// can change anything.

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const SCOPE = 'https://www.googleapis.com/auth/drive';
const FOLDER = 'application/vnd.google-apps.folder';
const FILE_FIELDS = 'id,name,mimeType,md5Checksum,modifiedTime,parents';
const STORE_KEY = 'recipes.session';

let clientId = '';
let tokenClient = null;
let session = null; // { token, expires, email, name }

// localStorage, so closing the tab (or the phone discarding it) keeps the
// sign-in for the rest of its hour.
const store = {
  get() { try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { return null; } },
  set(v) { try { v ? localStorage.setItem(STORE_KEY, JSON.stringify(v)) : localStorage.removeItem(STORE_KEY); } catch { /* private mode */ } },
};
const hint = {
  get() { try { return localStorage.getItem('recipes.email') || ''; } catch { return ''; } },
  set(v) { try { v ? localStorage.setItem('recipes.email', v) : localStorage.removeItem('recipes.email'); } catch { /* ignore */ } },
};

export function configure(id) {
  clientId = id || '';
  const saved = store.get();
  if (saved && saved.expires > Date.now() + 60_000) session = saved;
  else store.set(null);
  // Load Google's script early for a returning user, so a renewal tap opens
  // the sign-in window straight away and the browser does not block it.
  if (clientId && hint.get()) loadGis().catch(() => {});
}

export const enabled = () => Boolean(clientId);
export const signedIn = () => Boolean(session && session.expires > Date.now());
export const user = () => session;
export const wasSignedIn = () => Boolean(hint.get());
export const expiresAt = () => session?.expires || 0;

/**
 * Renews the sign-in if it has ended or ends within `margin` ms. Call it
 * straight from a tap, before any other await: browsers only allow the
 * Google window to open in direct response to a tap.
 */
export async function renewIfNeeded(margin = 5 * 60_000) {
  if (session && session.expires > Date.now() + margin) return;
  await signIn();
}

function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Could not load Google sign-in. Check your connection.'));
    document.head.appendChild(s);
  });
}

/** Opens the Google sign-in popup. Resolves with the session. */
export async function signIn() {
  await loadGis();
  return new Promise((resolve, reject) => {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      login_hint: hint.get() || undefined,
      callback: async (resp) => {
        if (resp.error) { reject(new Error(resp.error_description || resp.error)); return; }
        const prev = session || store.get() || {};
        session = { token: resp.access_token, expires: Date.now() + (Number(resp.expires_in) || 3600) * 1000, email: prev.email, name: prev.name };
        if (!session.email) try {
          const about = await call(`${API}/about?fields=user(emailAddress,displayName)`);
          session.email = about.user?.emailAddress || '';
          session.name = about.user?.displayName || '';
          hint.set(session.email);
        } catch { /* not essential */ }
        store.set(session);
        resolve(session);
      },
      error_callback: (err) => reject(new Error(
        err?.type === 'popup_closed' ? 'Sign-in was cancelled.'
          : err?.type === 'popup_failed_to_open' ? 'Your browser blocked the Google sign-in window. Tap again to try once more.'
            : (err?.message || 'Sign-in failed.'))),
    });
    tokenClient.requestAccessToken({ prompt: hint.get() ? '' : 'consent' });
  });
}

export function signOut() {
  if (session?.token && window.google?.accounts?.oauth2) {
    try { window.google.accounts.oauth2.revoke(session.token, () => {}); } catch { /* ignore */ }
  }
  session = null;
  store.set(null);
  hint.set('');
}

const expired = () => Object.assign(new Error('Your Google sign-in ran out. Tap the sign-in button at the top, then try again.'), { code: 401 });

// Never opens the sign-in window by itself: outside a tap the browser would
// block it. Taps renew first with renewIfNeeded().
async function ensureToken() {
  if (!signedIn()) throw expired();
}

async function call(url, opts = {}, raw = false) {
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${session?.token}`, ...(opts.headers || {}) },
  });
  if (res.status === 401) {
    if (session) session.expires = 0;
    store.set(null);
    throw expired();
  }
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { const j = await res.json(); msg = j.error?.message || msg; } catch { /* keep status */ }
    throw Object.assign(new Error(`Google Drive: ${msg}`), { code: res.status });
  }
  if (raw) return res;
  return res.status === 204 ? null : res.json();
}

async function authed(url, opts, raw) {
  await ensureToken();
  return call(url, opts, raw);
}

/** Can the signed-in user edit the recipe folder? */
export async function checkFolder(folderId) {
  const f = await authed(`${API}/files/${folderId}?fields=id,name,capabilities(canEdit)`);
  return { name: f.name, canEdit: Boolean(f.capabilities?.canEdit) };
}

async function listChildren(folderId) {
  const out = [];
  let pageToken = '';
  do {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
    const url = `${API}/files?q=${q}&fields=nextPageToken,files(${FILE_FIELDS})&pageSize=1000${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const r = await authed(url);
    out.push(...(r.files || []));
    pageToken = r.nextPageToken || '';
  } while (pageToken);
  return out;
}

/**
 * Walks the whole recipe folder.
 * Returns { folders: Map(path -> id), files: Map(path -> file) } where path is
 * relative to the root ("" is the root folder itself).
 */
export async function walk(rootId) {
  const folders = new Map([['', rootId]]);
  const files = new Map();
  let level = [['', rootId]];
  while (level.length) {
    const results = await Promise.all(level.map(([p, id]) => listChildren(id).then(c => [p, c])));
    level = [];
    for (const [parentPath, children] of results) {
      for (const f of children) {
        const path = parentPath ? `${parentPath}/${f.name}` : f.name;
        if (f.mimeType === FOLDER) { folders.set(path, f.id); level.push([path, f.id]); }
        else files.set(path, f);
      }
    }
  }
  return { folders, files };
}

export async function getMeta(id) {
  return authed(`${API}/files/${id}?fields=${FILE_FIELDS}`);
}

export async function readText(id) {
  const res = await authed(`${API}/files/${id}?alt=media`, {}, true);
  return res.text();
}

export async function readBlobUrl(id) {
  const res = await authed(`${API}/files/${id}?alt=media`, {}, true);
  return URL.createObjectURL(await res.blob());
}

export async function updateContent(id, body, mimeType = 'text/plain') {
  return authed(`${UPLOAD}/files/${id}?uploadType=media&fields=${FILE_FIELDS}`, {
    method: 'PATCH', headers: { 'Content-Type': mimeType }, body,
  });
}

export async function create(name, parentId, body, mimeType = 'text/plain') {
  const boundary = 'recipe' + Math.random().toString(36).slice(2);
  const meta = JSON.stringify({ name, parents: [parentId], mimeType });
  const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;
  const payload = new Blob([head, body, tail]);
  return authed(`${UPLOAD}/files?uploadType=multipart&fields=${FILE_FIELDS}`, {
    method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: payload,
  });
}

export async function createFolder(name, parentId) {
  return authed(`${API}/files?fields=${FILE_FIELDS}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, parents: [parentId], mimeType: FOLDER }),
  });
}

/** Rename and/or move a file. */
export async function moveRename(id, { name, fromParent, toParent }) {
  const params = new URLSearchParams({ fields: FILE_FIELDS });
  if (toParent && fromParent && toParent !== fromParent) { params.set('addParents', toParent); params.set('removeParents', fromParent); }
  return authed(`${API}/files/${id}?${params}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(name ? { name } : {}),
  });
}

/** Moves a file to the Drive trash (restorable for 30 days). */
export async function trash(id) {
  return authed(`${API}/files/${id}?fields=id`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }),
  });
}
