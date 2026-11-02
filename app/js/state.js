// The app's shared state (S) and how a recipe from the index becomes an
// entry with its frontmatter, times, tags and search text.

import { ingredientNames, parseDuration, readFrontmatter } from './cooklang.js';
import { fold, folderLabel, lc, prettifyFile, saved } from './util.js';

export const S = {
  config: {},
  built: 0,
  recipes: new Map(), // path -> entry
  folders: [],
  live: 'off', // off | loading | on
  drive: null, // { folders: Map, files: Map }
  filters: { chapter: '', sub: '', q: '', course: new Set(), cuisine: new Set(), diet: new Set(), difficulty: new Set(), time: new Set(), tags: new Set() },
  sort: saved.get('sort', 'recent'),
  browse: { at: '', tab: 'folders' }, // phone browse sheet: folder being shown, open tab
  dirty: false,
  currentHash: '',
  checked: new Map(), // path -> Set of checked ingredient keys
  shop: null, // shopping list sync, when sign-in is set up
  plan: null, // meal plan sync, the same way
  conf: { aisle: saved.get('conf.aisle', null), pantry: saved.get('conf.pantry', null) }, // { id, md5, text }
  parserReady: false,
};

export function makeEntry(r) {
  const fm = readFrontmatter(r.src);
  const parts = r.path.split('/');
  const file = parts.pop();
  const prep = parseDuration(fm['prep time']);
  const cook = parseDuration(fm['cook time']);
  let time = parseDuration(fm.time);
  if (time == null && (prep != null || cook != null)) time = (prep || 0) + (cook || 0);
  const tags = (Array.isArray(fm.tags) ? fm.tags : String(fm.tags || '').split(',')).map(lc).filter(Boolean);
  const e = {
    ...r,
    file,
    folder: parts.join('/'),
    chapter: parts[0] || '',
    sub: parts.slice(1).join('/'),
    fm,
    title: fm.title || prettifyFile(file),
    description: fm.description || '',
    course: lc(fm.course),
    cuisine: lc(fm.cuisine),
    diet: lc(fm.diet),
    difficulty: lc(fm.difficulty),
    tags,
    time,
    prep,
    cook,
    imageUrl: r.image ? `img/${r.image}.jpg` : (r.imageUrl || null),
    thumbUrl: r.image ? `thumb/${r.image}.jpg` : (r.imageUrl || null),
  };
  e.search = fold([e.title, e.description, e.cuisine, e.course, e.diet, tags.join(' '), ingredientNames(r.src).join(' '), folderLabel(e.folder)].join(' '));
  return e;
}
