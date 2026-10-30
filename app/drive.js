// Google sign-in and the Google Drive calls the editor needs. The Drive calls
// run in the browser with the signed-in user's own token, so only someone who
// can edit the Drive folder can change anything.
//
// Two ways to sign in:
// - With `authUrl` (the recipes Worker in connector/): sign in once per
//   device. The Worker keeps Google's long-lasting key and this device keeps a
//   pass that it trades for a fresh one-hour token whenever it needs one, so
//   the sign-in never runs out.
// - Without it: Google Identity Services token flow, one hour at a time.

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const SCOPE = 'https://www.googleapis.com/auth/drive';
const FOLDER = 'application/vnd.google-apps.folder';
const FILE_FIELDS = 'id,name,mimeType,md5Checksum,modifiedTime,parents,trashed,thumbnailLink';
const STORE_KEY = 'recipes.session';

const PASS_KEY = 'recipes.pass';

let clientId = '';
let authUrl = '';
let tokenClient = null;
let session = null; // { token, expires, email, name }
let pass = ''; // this device's pass for the Worker, if signed in through it

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

const passStore = {
  get() { try { return localStorage.getItem(PASS_KEY) || ''; } catch { return ''; } },
  set(v) { try { v ? localStorage.setItem(PASS_KEY, v) : localStorage.removeItem(PASS_KEY); } catch { /* private mode */ } },
};

export function configure(id, auth = '') {
  clientId = id || '';
  authUrl = (auth || '').replace(/\/+$/, '');
  pass = authUrl ? passStore.get() : '';
  const saved = store.get();
  // With a pass an old token is still worth keeping for the name and email:
  // the first Drive call trades the pass for a fresh one.
  if (saved && (pass || saved.expires > Date.now() + 60_000)) session = saved;
  else store.set(null);
  if (pass && !session) session = { token: '', expires: 0, email: hint.get(), name: '' };
  // Load Google's script early for a returning user, so a renewal tap opens
  // the sign-in window straight away and the browser does not block it.
  if (clientId && !authUrl && hint.get()) loadGis().catch(() => {});
}

export const enabled = () => Boolean(clientId || authUrl);
export const signedIn = () => Boolean(pass || (session && session.expires > Date.now()));
export const user = () => session;
export const wasSignedIn = () => Boolean(hint.get() || pass);
/** Signed in for good on this device, through the Worker. */
export const lasting = () => Boolean(pass);
export const expiresAt = () => (pass ? Infinity : session?.expires || 0);

/**
 * Renews the sign-in if it has ended or ends within `margin` ms. Call it
 * straight from a tap, before any other await: browsers only allow the
 * Google window to open in direct response to a tap. With a pass it renews
 * quietly and never needs the tap.
 */
export async function renewIfNeeded(margin = 5 * 60_000) {
  if (session?.token && session.expires > Date.now() + margin) return;
  if (pass) { await refresh(); return; }
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
  if (authUrl) return signInWorker();
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
        // Ask every time: another Google account may have been picked.
        try {
          const about = await call(`${API}/about?fields=user(emailAddress,displayName)`);
          session.email = about.user?.emailAddress || '';
          session.name = about.user?.displayName || '';
          hint.set(session.email);
        } catch { /* not essential: keep the last known name */ }
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

// Sign-in through the Worker. The window goes to Google and back to the
// Worker, which leaves a pass for this login id; this page asks for it every
// couple of seconds. No cookies or window.opener, so it also works in Safari
// and the home-screen app.
let waiting = null; // the login in progress: { login, reject }

async function signInWorker() {
  const login = randomId();
  const q = new URLSearchParams({ login, origin: location.origin });
  if (hint.get()) q.set('hint', hint.get());
  // Open the window before anything else: only a tap may open it.
  const win = window.open(`${authUrl}/auth/start?${q}`, 'recipes-signin', 'width=480,height=640');
  if (!win) throw new Error('Your browser blocked the Google sign-in window. Tap again to try once more.');
  // A second tap starts over; the first one stops quietly.
  waiting?.reject(Object.assign(new Error('Sign-in started again.'), { quiet: true }));
  let stop;
  const stopped = new Promise((_, reject) => { stop = reject; });
  stopped.catch(() => {}); // only ever read through the race below
  waiting = { login, reject: stop };
  try {
    const until = Date.now() + 5 * 60_000;
    let got = null;
    while (!got) {
      await Promise.race([stopped, new Promise((r) => setTimeout(r, 1500))]);
      if (Date.now() > until) throw Object.assign(new Error('Sign-in timed out. Tap Sign in to try again.'), { quiet: true });
      let res;
      try { res = await fetch(`${authUrl}/auth/redeem`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login }) }); } catch { continue; } // offline for a moment
      if (res.status === 200) got = await res.json();
    }
    pass = got.pass;
    passStore.set(pass);
    hint.set(got.email);
    session = { token: '', expires: 0, email: got.email, name: got.name };
    await refresh();
    try { win.close(); } catch { /* not ours to close any more */ }
    return session;
  } finally {
    if (waiting?.login === login) waiting = null;
  }
}

// Trades the pass for a fresh one-hour token. Calls at the same time share one trip.
let refreshing = null;
function refresh() {
  refreshing ||= (async () => {
    const res = await fetch(`${authUrl}/auth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pass }) });
    const t = await res.json().catch(() => ({}));
    if (res.status === 401) {
      pass = ''; passStore.set(null);
      session = null; store.set(null);
      throw Object.assign(new Error(`${t.message || 'Your Google sign-in ended.'} Tap Sign in at the top.`), { code: 401 });
    }
    if (!res.ok) throw Object.assign(new Error(t.message || 'Could not renew the Google sign-in.'), { code: res.status });
    session = { token: t.access_token, expires: Date.now() + (Number(t.expires_in) || 3600) * 1000, email: t.email, name: t.name };
    store.set(session);
    return session;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

function randomId() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function signOut() {
  if (pass) {
    // Only this device: revoking Google's token would sign out every device.
    fetch(`${authUrl}/auth/signout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pass }), keepalive: true }).catch(() => {});
  } else if (session?.token && window.google?.accounts?.oauth2) {
    try { window.google.accounts.oauth2.revoke(session.token, () => {}); } catch { /* ignore */ }
  }
  pass = '';
  passStore.set(null);
  session = null;
  store.set(null);
  hint.set('');
}

const expired = () => Object.assign(new Error('Your Google sign-in ran out. Tap the sign-in button at the top, then try again.'), { code: 401 });

// Never opens the sign-in window by itself: outside a tap the browser would
// block it. Taps renew first with renewIfNeeded(). With a pass it renews
// quietly a minute before the hour is up.
async function ensureToken() {
  if (!pass) { if (!signedIn()) throw expired(); return; }
  if (session?.token && session.expires > Date.now() + 60_000) return;
  await refresh();
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
  try {
    return await call(url, opts, raw);
  } catch (e) {
    // Google turned the token down early: with a pass, get a new one and try once more.
    if (e.code !== 401 || !pass) throw e;
    await refresh();
    return call(url, opts, raw);
  }
}

/** Can the signed-in user edit the recipe folder? */
export async function checkFolder(folderId) {
  const f = await authed(`${API}/files/${folderId}?fields=id,name,capabilities(canEdit)`);
  return { name: f.name, canEdit: Boolean(f.capabilities?.canEdit) };
}

/** Everything directly inside any of these folders, in as few requests as Drive allows. */
async function listIn(folderIds) {
  const batches = [];
  for (let i = 0; i < folderIds.length; i += 40) batches.push(folderIds.slice(i, i + 40));
  const lists = await Promise.all(batches.map(async (ids) => {
    const out = [];
    let pageToken = '';
    do {
      const q = encodeURIComponent(`(${ids.map((id) => `'${id}' in parents`).join(' or ')}) and trashed = false`);
      const url = `${API}/files?q=${q}&fields=nextPageToken,files(${FILE_FIELDS})&pageSize=1000${pageToken ? `&pageToken=${pageToken}` : ''}`;
      const r = await authed(url);
      out.push(...(r.files || []));
      pageToken = r.nextPageToken || '';
    } while (pageToken);
    return out;
  }));
  return lists.flat();
}

// The folder IDs found last time, so the next walk asks for all of them at
// once instead of one level of folders after the other.
const knownFolders = {
  key: (rootId) => `recipes.folders.${rootId}`,
  get(rootId) { try { return JSON.parse(localStorage.getItem(this.key(rootId)) || '[]'); } catch { return []; } },
  set(rootId, ids) { try { localStorage.setItem(this.key(rootId), JSON.stringify(ids)); } catch { /* private mode */ } },
};

/**
 * Walks the whole recipe folder.
 * Returns { folders: Map(path -> id), files: Map(path -> file) } where path is
 * relative to the root ("" is the root folder itself).
 *
 * Asks for the contents of every folder seen last time in one go, then only
 * for folders that are new since. Folders that were moved out or deleted
 * are not reachable from the root any more, so they drop out.
 */
export async function walk(rootId) {
  const kids = new Map(); // folder ID -> what is directly inside it
  const asked = new Set();
  let ask = [...new Set([rootId, ...knownFolders.get(rootId)])];
  while (ask.length) {
    ask.forEach((id) => { asked.add(id); kids.set(id, []); });
    let found;
    try { found = await listIn(ask); } catch (e) {
      // A remembered folder Drive no longer knows: start over from the root.
      if (asked.size === 1 || e.code === 401) throw e;
      knownFolders.set(rootId, []);
      return walk(rootId);
    }
    for (const f of found) {
      for (const p of f.parents || []) kids.get(p)?.push(f);
    }
    ask = [];
    const stack = [rootId];
    while (stack.length) {
      for (const f of kids.get(stack.pop()) || []) {
        if (f.mimeType !== FOLDER) continue;
        if (asked.has(f.id)) stack.push(f.id);
        else ask.push(f.id);
      }
    }
  }

  const folders = new Map([['', rootId]]);
  const files = new Map();
  const stack = [['', rootId]];
  while (stack.length) {
    const [parentPath, id] = stack.pop();
    for (const f of kids.get(id) || []) {
      const path = parentPath ? `${parentPath}/${f.name}` : f.name;
      if (f.mimeType === FOLDER) { folders.set(path, f.id); stack.push([path, f.id]); }
      else files.set(path, f);
    }
  }
  knownFolders.set(rootId, [...folders.values()].filter((id) => id !== rootId));
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

/**
 * A photo resized by Google to at most `size` px, so a phone photo of several
 * MB comes down as a small JPEG. Falls back to the whole file when Drive gives
 * no thumbnail (yet) or the link has run out.
 */
export async function readPhotoUrl(file, size) {
  if (file.thumbnailLink) {
    try {
      await ensureToken();
      const res = await fetch(file.thumbnailLink.replace(/=s\d+$/, `=s${size}`), { headers: { Authorization: `Bearer ${session?.token}` } });
      if (res.ok) return URL.createObjectURL(await res.blob());
    } catch { /* use the whole file */ }
  }
  return readBlobUrl(file.id);
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
