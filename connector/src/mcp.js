// The recipes connector for Claude: MCP over plain HTTP POST (JSON in, JSON
// out, no streaming), at /mcp behind the OAuth library. The tools read and
// save Jens's recipe folder in Google Drive with his own Google key.

import { lint, rulesFrom } from './lint.js';
import { getPhoto } from './photo.js';

const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FILE_FIELDS = 'id,name,parents,md5Checksum,modifiedTime';
const FOLDER = 'application/vnd.google-apps.folder';
const PROTOCOLS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];
const SKIP_TOP = new Set(['config', 'tools']);
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];

const INSTRUCTIONS = `Jens's Cooklang recipe collection, in his Google Drive. Each recipe is a .cook file (Cooklang with YAML frontmatter) in a folder by course, sometimes with a subfolder (for example "05 Mains/Curry"). A photo with the same name sits next to it.

Whenever you write, convert or change a recipe, use the cooklang-recipe skill and follow it completely: it holds Jens's style, units and frontmatter rules. Read the current recipe with read_recipe before changing it, and keep everything the request does not ask to change.

Saving: save_recipe checks the recipe against the house style (tools/cooklint.py) and refuses it with a list of problems; fix them and save again. For a change to an existing recipe, pass the version read_recipe gave. For a new recipe, pick the folder with list_folders and name the file after the title in snake_case; if that name is taken, ask Jens whether to replace it, use another name or skip. After saving, give Jens the link to the recipe.

Photos: every recipe needs one. For a recipe from a web page, add the page's photo with set_photo and the page address, right after saving. For a cookbook page or anything else without a photo link, give Jens the "Add photo" link that save_recipe returns, where he can paste or pick one. A photo of a cookbook page is never the dish photo.`;

const TOOLS = [
  {
    name: 'list_folders',
    title: 'List recipe folders',
    description: 'The recipe folders with how many recipes each holds, and which folder each course goes in. Use it to pick the folder for a new recipe.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'find_recipes',
    title: 'Find recipes',
    description: 'Search the recipes by words in the name or anywhere in the text (ingredients, tags, cuisine). Without a query it lists every recipe, optionally only in one folder. Returns paths for read_recipe.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to look for, for example "dal" or "leek feta".' },
        folder: { type: 'string', description: 'Only this folder and its subfolders, for example "05 Mains".' },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'read_recipe',
    title: 'Read a recipe',
    description: 'The full text of one recipe, with whether it has a photo and its link on the recipe site. Takes a path from find_recipes ("05 Mains/Curry/dal"), with or without .cook, or a link to the recipe on the site.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'For example "05 Mains/Curry/dal".' } },
      required: ['path'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'save_recipe',
    title: 'Save a recipe',
    description: 'Saves a recipe to Drive: a new one, or a change to an existing one (in place, so Drive keeps the old version in its history). Checks the house style first and refuses with a list of problems if it does not pass. Write the text with the cooklang-recipe skill.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Folder and snake_case file name without .cook, for example "05 Mains/Curry/dal_tadka". The folder must exist.' },
        text: { type: 'string', description: 'The whole recipe: YAML frontmatter and Cooklang.' },
        version: { type: 'string', description: 'For a change to an existing recipe: the version read_recipe gave. Leave out for a new recipe.' },
      },
      required: ['path', 'text'],
    },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'move_recipe',
    title: 'Move or rename a recipe',
    description: 'Moves a recipe to another folder and/or gives it a new file name. Its photo moves along.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The recipe now, for example "05 Mains/dal".' },
        to: { type: 'string', description: 'A folder ("05 Mains/Curry") or a folder and new name ("05 Mains/Curry/dal_tadka").' },
      },
      required: ['path', 'to'],
    },
    annotations: { destructiveHint: false },
  },
  {
    name: 'set_photo',
    title: 'Add the dish photo',
    description: 'Saves the dish photo of a recipe from a web address: a recipe page (the photo is found in its recipe data or share image) or a direct image link. Saved next to the recipe as a JPEG of at most 1600 px and under 1 MB.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The recipe, for example "05 Mains/Curry/dal_tadka".' },
        url: { type: 'string', description: 'The recipe page or the image itself.' },
        replace: { type: 'boolean', description: 'Replace the photo the recipe already has. Only after Jens said so.' },
      },
      required: ['path', 'url'],
    },
    annotations: { destructiveHint: false, openWorldHint: true },
  },
];

export async function mcp(req, env, ctx, access) {
  if (req.method !== 'POST') {
    return new Response('Use POST.\n', { status: 405, headers: { Allow: 'POST' } });
  }
  let msg;
  try { msg = await req.json(); } catch { return rpc(null, null, { code: -32700, message: 'Not JSON.' }); }
  const email = ctx.props?.email;
  const drive = new Drive(env, () => access(env, email));
  if (Array.isArray(msg)) {
    const out = (await Promise.all(msg.map((m) => handle(m, drive, env)))).filter(Boolean);
    return out.length ? Response.json(out) : new Response(null, { status: 202 });
  }
  const out = await handle(msg, drive, env);
  return out ? Response.json(out) : new Response(null, { status: 202 });
}

const rpc = (id, result, error) => Response.json(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result });

async function handle(msg, drive, env) {
  const { id, method, params = {} } = msg || {};
  if (id === undefined || id === null) return null; // a notification: nothing to answer
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  switch (method) {
    case 'initialize': return ok({
      protocolVersion: PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
      capabilities: { tools: {} },
      serverInfo: { name: 'recipes', title: "Jens's recipes", version: '1.0.0' },
      instructions: INSTRUCTIONS,
    });
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: TOOLS });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return fail(-32602, `Unknown tool ${params.name}.`);
      try {
        const text = await RUN[tool.name](params.arguments || {}, drive, env);
        return ok({ content: [{ type: 'text', text }] });
      } catch (e) {
        if (!e.user) console.error(tool.name, e);
        return ok({ content: [{ type: 'text', text: e.user ? e.message : `Google Drive did not answer (${e.message}). Try again.` }], isError: true });
      }
    }
    default: return fail(-32601, `Unknown method ${method}.`);
  }
}

// A message Claude should pass on, not a crash.
const userError = (message) => Object.assign(new Error(message), { user: true });

// ---------------------------------------------------------------- tools

const RUN = {
  async list_folders(_, drive) {
    const idx = await drive.index();
    const counts = new Map();
    for (const r of idx.recipes.values()) counts.set(r.folder, (counts.get(r.folder) || 0) + 1);
    const lines = [...idx.folders.keys()].filter((p) => p).sort(byName)
      .map((p) => `${'  '.repeat(p.split('/').length - 1)}${p.split('/').pop()}/  (${plural(counts.get(p) || 0, 'recipe')})`);
    const courses = await drive.courses(idx);
    const map = Object.entries(courses).map(([c, f]) => `${c}: ${f}`).join('\n');
    return `Recipe folders:\n${lines.join('\n')}\n\nCourse to folder (from tools/cooklint.py):\n${map || '(not found)'}\n\nIf a course folder has subfolders, pick the one that fits best by the recipes already in it; when two fit equally or none fits, ask Jens.`;
  },

  async find_recipes({ query = '', folder = '' }, drive) {
    const idx = await drive.index();
    const root = clean(folder);
    if (root && !idx.folders.has(root)) throw userError(`There is no folder "${folder}". Use list_folders to see them.`);
    let hits = [...idx.recipes.values()].filter((r) => !root || r.folder === root || r.folder.startsWith(`${root}/`));
    const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length) {
      const inText = await drive.search(words, idx);
      hits = hits.filter((r) => inText.has(r.id) || words.every((w) => r.path.toLowerCase().replace(/_/g, ' ').includes(w)));
    }
    if (!hits.length) return `No recipes found${words.length ? ` for "${query}"` : ''}${root ? ` in ${root}` : ''}.`;
    hits.sort((a, b) => byName(a.path, b.path));
    const shown = hits.slice(0, 200);
    return `${hits.length} recipe${hits.length === 1 ? '' : 's'}:\n${shown.map((r) => `${r.path}${r.photo ? '' : '  (no photo)'}`).join('\n')}${hits.length > shown.length ? `\n... and ${hits.length - shown.length} more; narrow the search.` : ''}`;
  },

  async read_recipe({ path }, drive, env) {
    const idx = await drive.index();
    const r = findRecipe(idx, path);
    const text = await drive.text(r.id);
    return `Path: ${r.path}.cook\nSite: ${siteLink(env, r.path)}\nPhoto: ${r.photo ? r.photo : 'none yet'}\nVersion: ${r.md5}\n\n${text}`;
  },

  async save_recipe({ path, text, version }, drive, env) {
    const idx = await drive.index();
    const p = clean(fromSiteLink(String(path || ''))).replace(/\.cook$/i, '');
    const folder = p.split('/').slice(0, -1).join('/');
    const name = p.split('/').pop();
    if (!folder || !idx.folders.has(folder)) throw userError(`There is no folder "${folder}". Pick one with list_folders; this tool does not make folders.`);
    if (!/^[a-z0-9_]+$/.test(name)) throw userError(`"${name}" is not a snake_case file name. Use the title in lowercase with underscores, for example "dal_tadka".`);
    let body = String(text || '').replace(/\r\n/g, '\n');
    if (!body.trim()) throw userError('The recipe text is empty.');
    if (!body.endsWith('\n')) body += '\n';

    const existing = idx.recipes.get(p);
    if (existing && !version) {
      throw userError(`A recipe already exists at ${p}. For a change to it, read it with read_recipe and pass its version. For a new recipe, ask Jens whether to replace it, use another name, or skip.`);
    }
    if (existing && version !== existing.md5) {
      throw userError(`${p} changed since you read it (maybe on the site or the phone). Read it again with read_recipe and make the change on the new version.`);
    }
    if (!existing && version) throw userError(`There is no recipe at ${p} any more; it may have been moved or renamed. Look it up with find_recipes.`);
    const twin = !existing && [...idx.recipes.values()].find((r) => r.path.split('/').pop() === name);
    if (twin) throw userError(`A recipe called ${name} is already in ${twin.folder}. Ask Jens whether this is the same recipe; if it is a different one, pick another name.`);

    const rules = await drive.rules(idx);
    const check = rules
      ? lint(body, p, rules, (ref) => idx.recipes.has(ref))
      : { errors: [], warnings: ['tools/cooklint.py was not found, so the house style was not checked'] };
    const bullets = (xs) => xs.map((x) => `- ${x}`).join('\n');
    if (check.errors.length) {
      throw userError(`Not saved. Fix these house style problems and save again:\n${bullets(check.errors)}${check.warnings.length ? `\n\nAlso worth fixing:\n${bullets(check.warnings)}` : ''}`);
    }
    const saved = existing ? await drive.update(existing.id, body) : await drive.create(`${name}.cook`, idx.folders.get(folder), body);
    const lines = [
      `${existing ? 'Saved the change to' : 'Saved the new recipe'} ${p}.cook.`,
      `Site: ${siteLink(env, p)}`,
      `Version: ${saved.md5Checksum}`,
      existing?.photo ? `Photo: ${existing.photo}` : `Photo: none yet. Add photo: ${siteLink(env, p, 'edit')}`,
    ];
    if (check.warnings.length) lines.push('', 'House style notes (saved anyway):', bullets(check.warnings));
    return lines.join('\n');
  },

  async move_recipe({ path, to }, drive, env) {
    const idx = await drive.index();
    const r = findRecipe(idx, path);
    const dest = clean(fromSiteLink(String(to || ''))).replace(/\.cook$/i, '');
    const intoFolder = idx.folders.has(dest);
    const toFolder = intoFolder ? dest : dest.split('/').slice(0, -1).join('/');
    const name = intoFolder ? r.path.split('/').pop() : dest.split('/').pop();
    if (!toFolder || !idx.folders.has(toFolder)) throw userError(`There is no folder "${toFolder || dest}". Pick one with list_folders.`);
    if (!/^[a-z0-9_]+$/.test(name)) throw userError(`"${name}" is not a snake_case file name.`);
    const np = `${toFolder}/${name}`;
    if (np === r.path) return `${r.path} is already there.`;
    if (idx.recipes.has(np)) throw userError(`There is already a recipe at ${np}. Ask Jens what to do.`);
    const from = idx.folders.get(r.folder);
    const into = idx.folders.get(toFolder);
    await drive.move(r.id, { name: `${name}.cook`, from, to: into });
    if (r.photoId) await drive.move(r.photoId, { name: name + r.photo.slice(r.photo.lastIndexOf('.')), from, to: into });
    return `Moved ${r.path}.cook to ${np}.cook${r.photoId ? ', with its photo' : ''}.\nSite: ${siteLink(env, np)}`;
  },

  async set_photo({ path, url, replace }, drive, env) {
    const idx = await drive.index();
    const r = findRecipe(idx, path);
    if (r.photo && !replace) {
      throw userError(`${r.path} already has a photo (${r.photo}). Ask Jens whether to replace it; if so, call again with replace: true.`);
    }
    const photo = await getPhoto(env, String(url || ''));
    const name = `${r.path.split('/').pop()}.jpg`;
    if (r.photoId) {
      await drive.update(r.photoId, photo.bytes, 'image/jpeg');
      const here = idx.folders.get(r.folder);
      if (r.photo !== name) await drive.move(r.photoId, { name, from: here, to: here });
    } else {
      await drive.create(name, idx.folders.get(r.folder), photo.bytes, 'image/jpeg');
    }
    const size = photo.width ? `${photo.width} x ${photo.height}, ` : '';
    return `Saved the photo for ${r.path} as ${name} (${size}${Math.round(photo.bytes.length / 1024)} KB) from ${photo.source}.\nSite: ${siteLink(env, r.path)}`;
  },
};

// ---------------------------------------------------------------- Drive

class Drive {
  constructor(env, access) {
    this.env = env;
    this.access = access;
    this.api = env.DRIVE_API || DRIVE;
    this.upload = env.DRIVE_UPLOAD || UPLOAD;
  }

  async get(path, params = {}, raw = false) {
    const { token } = await this.access();
    const res = await fetch(`${this.api}${path}?${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Drive ${res.status}`);
    return raw ? res : res.json();
  }

  async list(q, fields) {
    const out = [];
    let pageToken = '';
    do {
      const r = await this.get('/files', { q, fields: `nextPageToken,files(${fields})`, pageSize: '1000', ...(pageToken ? { pageToken } : {}) });
      out.push(...(r.files || []));
      pageToken = r.nextPageToken || '';
    } while (pageToken);
    return out;
  }

  /**
   * The whole collection in a few calls: every folder in Drive (to find the
   * tree under the recipe folder), then the files in those folders.
   * Returns { folders: Map(path -> id), recipes: Map(path -> recipe), byId }.
   */
  async index() {
    if (this.cached) return this.cached;
    const all = await this.list(`mimeType = '${FOLDER}' and trashed = false`, 'id,name,parents');
    const kids = new Map();
    for (const f of all) for (const p of f.parents || []) (kids.get(p) || kids.set(p, []).get(p)).push(f);
    const folders = new Map([['', this.env.GDRIVE_FOLDER_ID]]);
    const extra = new Map(); // config and tools: not recipes, but tools/cooklint.py lives there
    const walk = (id, path) => {
      for (const f of kids.get(id) || []) {
        const p = path ? `${path}/${f.name}` : f.name;
        if (!path && SKIP_TOP.has(f.name)) { extra.set(p, f.id); continue; }
        folders.set(p, f.id);
        walk(f.id, p);
      }
    };
    walk(this.env.GDRIVE_FOLDER_ID, '');
    const pathOf = new Map([...folders].map(([p, id]) => [id, p]));
    const files = [];
    const ids = [...folders.values()];
    for (let i = 0; i < ids.length; i += 40) {
      const parents = ids.slice(i, i + 40).map((id) => `'${id}' in parents`).join(' or ');
      files.push(...await this.list(`(${parents}) and trashed = false and mimeType != '${FOLDER}'`, FILE_FIELDS));
    }
    const recipes = new Map();
    const images = new Map();
    for (const f of files) {
      const folder = pathOf.get((f.parents || []).find((p) => pathOf.has(p)));
      if (folder === undefined) continue;
      const lower = f.name.toLowerCase();
      const at = (base) => (folder ? `${folder}/${base}` : base);
      if (lower.endsWith('.cook')) {
        const path = at(f.name.slice(0, -5));
        recipes.set(path, { id: f.id, path, folder, md5: f.md5Checksum, modified: f.modifiedTime, photo: '' });
      } else {
        const ext = IMAGE_EXTS.find((e) => lower.endsWith(e));
        if (ext) images.set(at(f.name.slice(0, -ext.length)), f);
      }
    }
    for (const r of recipes.values()) {
      const img = images.get(r.path);
      r.photo = img?.name || '';
      r.photoId = img?.id || '';
    }
    this.cached = { folders, recipes, extra, byId: new Map([...recipes.values()].map((r) => [r.id, r])) };
    return this.cached;
  }

  /** Ids of recipes whose text has every word, by Drive's own search. */
  async search(words, idx) {
    const q = words.map((w) => `fullText contains '${w.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`).join(' and ');
    const hits = await this.list(`${q} and trashed = false and mimeType != '${FOLDER}'`, 'id');
    return new Set(hits.map((f) => f.id).filter((id) => idx.byId.has(id)));
  }

  async send(url, method, body, type) {
    const { token } = await this.access();
    const res = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': type }, body });
    if (!res.ok) throw new Error(`Drive ${res.status}`);
    this.cached = null;
    return res.json();
  }

  /** A new file: text (a recipe) or bytes (a photo). */
  create(name, parent, content, type = 'text/plain; charset=UTF-8') {
    const boundary = `recipe${crypto.randomUUID()}`;
    const meta = JSON.stringify({ name, parents: [parent], mimeType: type.split(';')[0] });
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${type}\r\n\r\n`,
      content,
      `\r\n--${boundary}--`,
    ]);
    return this.send(`${this.upload}/files?uploadType=multipart&fields=${FILE_FIELDS}`, 'POST', body, `multipart/related; boundary=${boundary}`);
  }

  update(id, content, type = 'text/plain; charset=UTF-8') {
    return this.send(`${this.upload}/files/${id}?uploadType=media&fields=${FILE_FIELDS}`, 'PATCH', content, type);
  }

  move(id, { name, from, to }) {
    const q = new URLSearchParams({ fields: FILE_FIELDS });
    if (to !== from) { q.set('addParents', to); q.set('removeParents', from); }
    return this.send(`${this.api}/files/${id}?${q}`, 'PATCH', JSON.stringify({ name }), 'application/json');
  }

  /** The house style word lists, from tools/cooklint.py. */
  async rules(idx) {
    const src = await this.lintSource(idx);
    return src ? rulesFrom(src) : null;
  }

  async lintSource(idx) {
    const tools = idx.extra.get('tools');
    if (!tools) return '';
    const [file] = await this.list(`'${tools}' in parents and name = 'cooklint.py' and trashed = false`, 'id');
    return file ? this.text(file.id) : '';
  }

  async text(id) {
    const res = await this.get(`/files/${id}`, { alt: 'media' }, true);
    return res.text();
  }

  /** The course to folder map, read from FOLDER_FOR_COURSE in tools/cooklint.py. */
  async courses(idx) {
    const src = await this.lintSource(idx);
    const block = src.match(/FOLDER_FOR_COURSE\s*=\s*\{([\s\S]*?)\}/);
    const out = {};
    for (const [, c, f] of (block?.[1] || '').matchAll(/'([^']+)'\s*:\s*'([^']+)'/g)) out[c] = f;
    return out;
  }
}

// ---------------------------------------------------------------- helpers

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const byName = (a, b) => collator.compare(a, b);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "/05 Mains/dal/" -> "05 Mains/dal" */
const clean = (p) => String(p || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

/** A link to the site ("...#/r/05%20Mains/dal?s=2") becomes its path. */
function fromSiteLink(s) {
  const m = s.match(/#\/(?:r|edit|cook)\/([^?#]+)/);
  if (!m) return s;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

const siteLink = (env, path, view = 'r') => `${String(env.SITE_URL || '').replace(/\/?$/, '/')}#/${view}/${path.split('/').map(encodeURIComponent).join('/')}`;

/** A recipe by path, site link or (if unique) just its file name. */
function findRecipe(idx, path) {
  const want = clean(fromSiteLink(String(path || ''))).replace(/\.cook$/i, '');
  const r = idx.recipes.get(want);
  if (r) return r;
  const same = [...idx.recipes.values()].filter((x) => x.path.split('/').pop() === want.split('/').pop());
  if (same.length === 1) return same[0];
  throw userError(`No recipe at "${path}".${same.length ? ` Did you mean: ${same.map((x) => x.path).join(', ')}?` : ' Use find_recipes to look it up.'}`);
}
