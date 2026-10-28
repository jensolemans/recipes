// The dish photo for a recipe, as scripts/fetch_photo.py does on the laptop:
// from a recipe page (its recipe data, then og:image / twitter:image) or a
// direct image link, the largest candidate, saved as a JPEG of at most
// 1600 px on its longest side and under 1 MB. The resizing runs on
// Cloudflare's Images binding: the Worker itself has too little CPU time.

const MAX_SIDE = 1600;
const MAX_BYTES = 1024 * 1024;
const MAX_DOWNLOAD = 20 * 1024 * 1024;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,image/avif,image/webp,image/*,*/*;q=0.8',
  'Accept-Language': 'en,nl;q=0.8',
};

/** Throws errors with `user` set: messages for Claude to pass on. */
const fail = (message) => Object.assign(new Error(message), { user: true });

/**
 * Finds and downloads the photo. Returns { bytes, source, width, height }
 * in the house format.
 */
export async function getPhoto(env, url) {
  let u;
  try { u = new URL(url); } catch { throw fail(`"${url}" is not a web address.`); }
  if (!/^https?:$/.test(u.protocol)) throw fail('Only http and https addresses work.');
  const first = await download(u.href);
  let best;
  if (first.type.startsWith('image/')) {
    best = { ...first, ...(await info(env, first.bytes)), source: u.href };
  } else {
    const page = new TextDecoder().decode(first.bytes);
    const candidates = photosInPage(page).map((p) => { try { return new URL(p, first.url).href; } catch { return null; } }).filter(Boolean);
    if (!candidates.length) throw fail('No photo found on that page. Copy the photo and use Paste photo in the site\'s editor instead.');
    best = await biggest(env, candidates);
    if (!best) throw fail('The photos on that page could not be downloaded; the site may block it. Copy the photo and use Paste photo in the site\'s editor instead.');
  }
  return { ...(await toJpeg(env, best)), source: best.source };
}

async function download(url) {
  let res;
  try { res = await fetch(url, { headers: HEADERS, redirect: 'follow' }); } catch { throw fail(`Could not reach ${new URL(url).host}.`); }
  if (!res.ok) throw fail(`${new URL(url).host} answered ${res.status}${res.status === 403 ? ' (it blocks downloads like this one)' : ''}. Copy the photo and use Paste photo in the site's editor instead.`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_DOWNLOAD) throw fail('That file is too big to be a photo.');
  return { bytes, type: (res.headers.get('Content-Type') || '').toLowerCase(), url: res.url || url };
}

/** Width and height, from the Images binding. */
async function info(env, bytes) {
  try {
    const i = await env.IMAGES.info(stream(bytes));
    return { width: i.width || 0, height: i.height || 0, format: i.format || '' };
  } catch {
    return { width: 0, height: 0, format: '' };
  }
}

/** Downloads candidates and keeps the largest, stopping at a big enough one. */
async function biggest(env, urls) {
  let best = null;
  for (const url of urls.slice(0, 8)) {
    let got;
    try { got = await download(url); } catch { continue; }
    if (!got.type.startsWith('image/')) continue;
    const dims = await info(env, got.bytes);
    const area = dims.width * dims.height;
    if (!best || area > best.width * best.height) best = { ...got, ...dims, source: url };
    if (Math.max(dims.width, dims.height) >= 1200) break;
  }
  return best;
}

async function toJpeg(env, img) {
  const big = Math.max(img.width, img.height) > MAX_SIDE;
  for (const quality of [85, 78, 70, 60]) {
    let out;
    try {
      const result = await env.IMAGES.input(stream(img.bytes))
        .transform({ width: MAX_SIDE, height: MAX_SIDE, fit: 'scale-down' })
        .output({ format: 'image/jpeg', quality });
      out = new Uint8Array(await result.response().arrayBuffer());
    } catch (e) {
      console.error('image transform failed', e?.message);
      // Without resizing, a JPEG that already fits can go as it is.
      if (img.type.includes('jpeg') && !big && img.bytes.length <= MAX_BYTES) return { bytes: img.bytes, width: img.width, height: img.height };
      throw fail('The photo could not be converted. Copy it and use Paste photo in the site\'s editor instead.');
    }
    if (out.length <= MAX_BYTES || quality === 60) {
      const scale = big ? MAX_SIDE / Math.max(img.width, img.height) : 1;
      return { bytes: out, width: Math.round(img.width * scale), height: Math.round(img.height * scale) };
    }
  }
  throw fail('The photo could not be converted.');
}

const stream = (bytes) => new Response(bytes).body;

// ---------------------------------------------------------------- the page

/** Candidate photo addresses: the recipe data first, then the share image. */
export function photosInPage(page) {
  const found = [];
  for (const m of page.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(unescapeHtml(m[1].trim())); } catch { continue; }
    for (const node of recipeNodes(data)) found.push(...imageUrls(node.image));
  }
  for (const prop of ['og:image', 'twitter:image']) {
    const m = page.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']+)`, 'i'))
      || page.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop}["']`, 'i'));
    if (m) found.push(unescapeHtml(m[1]));
  }
  // Sites often add a resize to the address; without it is the original.
  const out = [];
  for (const u of found) {
    const bare = /[?&](resize|fit|w|h|width|height)=/.test(u) ? u.replace(/\?.*$/, '') : null;
    for (const c of [bare, u]) if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

function* recipeNodes(data) {
  if (Array.isArray(data)) { for (const d of data) yield* recipeNodes(d); return; }
  if (!data || typeof data !== 'object') return;
  const t = data['@type'];
  if (t === 'Recipe' || (Array.isArray(t) && t.includes('Recipe'))) yield data;
  for (const key of ['@graph', 'mainEntity']) if (key in data) yield* recipeNodes(data[key]);
}

function imageUrls(v) {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(imageUrls);
  if (v && typeof v === 'object') { const u = v.url || v.contentUrl; return u ? [u] : []; }
  return [];
}

function unescapeHtml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|#39);/gi, (_, e) => {
    const k = e.toLowerCase();
    if (k[0] === '#') return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[k] ?? `&${e};`;
  });
}
