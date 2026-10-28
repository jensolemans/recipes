// The house-style checks of tools/cooklint.py, in JavaScript, so the connector
// can check a recipe before it saves it. The word lists (courses, cuisines,
// banned tags, units, folders) are read from cooklint.py itself, so that file
// stays the one place to change them. Image checks are left out: the photo is
// added separately.

const NAMES = ['COURSE', 'CUISINE', 'DIET', 'DIFFICULTY', 'BANNED_TAGS', 'TITLE_FILLER', 'FIELDS',
  'REQUIRED', 'REQUIRED_NOT_DRINK', 'TIMER_UNITS', 'IMPERIAL_UNITS'];
const TIME_RE = /^(?=\d)(\d+h)?(\d+m)?$/;
const YIELD_RE = /^\d+(\.\d+)?%\S.*$/;
const TAG_RE = /^[a-z0-9][a-z0-9-]*$/;
const PREP_WORDS = /\b(minced|diced|chopped|sliced|grated|crushed|smashed|rinsed|peeled|halved|quartered|softened|melted|beaten|drained|shredded|julienned)\b/i;
const HINTS = { prep_time: 'prep time', cook_time: 'cook time', duration: 'time', yields: 'yield', dietary: 'diet' };

/** Reads the word lists out of cooklint.py. Returns null when it has none. */
export function rulesFrom(src) {
  const block = (name) => {
    const m = src.match(new RegExp(`^${name}\\s*=\\s*([\\[{])`, 'm'));
    if (!m) return null;
    const close = m[1] === '[' ? ']' : '}';
    const start = m.index + m[0].length;
    return src.slice(start, src.indexOf(close, start));
  };
  const strings = (b) => [...b.matchAll(/'([^']*)'|"([^"]*)"/g)].map((x) => x[1] ?? x[2]);
  const pairs = (b) => Object.fromEntries([...b.matchAll(/'([^']*)'\s*:\s*'([^']*)'/g)].map((x) => [x[1], x[2]]));
  const rules = {};
  for (const n of NAMES) {
    const b = block(n);
    if (b == null) return null;
    rules[n] = strings(b);
  }
  const bad = block('BAD_UNITS');
  const folders = block('FOLDER_FOR_COURSE');
  if (bad == null || folders == null) return null;
  rules.BAD_UNITS = pairs(bad);
  rules.FOLDER_FOR_COURSE = pairs(folders);
  return rules;
}

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fm: null, body: text, offset: 0 };
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const mm = line.match(/^([A-Za-z][A-Za-z _.]*?)\s*:\s*(.*)$/);
    if (!mm) { (fm.__bad__ ||= []).push(line); continue; }
    let v = mm[2].trim();
    if (v.length >= 2 && v[0] === v.at(-1) && `"'`.includes(v[0])) v = v.slice(1, -1);
    if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    fm[mm[1]] = v;
  }
  return { fm, body: text.slice(m[0].length), offset: (m[0].match(/\n/g) || []).length };
}

/**
 * Checks one recipe. `path` is like "05 Mains/Curry/dal" (no .cook).
 * `exists(refPath)` says whether a referenced recipe is there.
 * Returns { errors: [], warnings: [] }, each a line of text.
 */
export function lint(text, path, R, exists = () => true) {
  const errors = [];
  const warnings = [];
  const at = (line) => (line ? `line ${line}: ` : '');
  const err = (msg, line) => errors.push(at(line) + msg);
  const warn = (msg, line) => warnings.push(at(line) + msg);

  const name = `${path.split('/').pop()}.cook`;
  if (!/^[a-z0-9_]+\.cook$/.test(name)) err(`file name is not snake_case ascii: ${name}`);
  let { fm, body, offset } = parseFrontmatter(text);

  // ---- frontmatter
  if (!fm) { err('no YAML frontmatter block (--- ... ---) at the top of the file'); fm = {}; }
  for (const bad of fm.__bad__ || []) err(`unparseable frontmatter line: ${bad}`);
  delete fm.__bad__;
  for (const k of Object.keys(fm)) {
    if (!R.FIELDS.includes(k)) (HINTS[k] ? err : warn)(`unknown field "${k}"${HINTS[k] ? `, use "${HINTS[k]}"` : ''}`);
  }
  const keys = Object.keys(fm).filter((k) => R.FIELDS.includes(k));
  if (keys.join() !== [...keys].sort((a, b) => R.FIELDS.indexOf(a) - R.FIELDS.indexOf(b)).join()) {
    warn(`fields are not in house order: ${R.FIELDS.slice(0, 14).join(', ')}`);
  }
  const course = fm.course;
  const empty = (v) => v == null || v === '' || (Array.isArray(v) && !v.length);
  for (const k of [...R.REQUIRED, ...(course === 'drink' ? [] : R.REQUIRED_NOT_DRINK)]) {
    if (empty(fm[k]) && fm[k] !== '0m') err(`missing required field "${k}"`);
  }
  for (const [k, allowed] of [['course', R.COURSE], ['cuisine', R.CUISINE], ['diet', R.DIET], ['difficulty', R.DIFFICULTY]]) {
    const v = fm[k];
    if (!empty(v) && !allowed.includes(v)) err(`${k} "${v}" is not in the vocabulary: ${allowed.join(', ')}`);
  }
  for (const k of ['time', 'prep time', 'cook time']) {
    const v = fm[k];
    if (!empty(v) && !TIME_RE.test(String(v))) err(`${k} "${v}" should look like 1h30m, 45m or 2h`);
  }
  if (!empty(fm.servings) && !/^\d+$/.test(String(fm.servings))) err(`servings "${fm.servings}" must be a whole number`);
  if (!empty(fm.yield) && !YIELD_RE.test(String(fm.yield))) err(`yield "${fm.yield}" should be number%unit, e.g. 12%cookies or 500%ml`);
  if (course === 'drink' && (fm['prep time'] || fm['cook time'])) warn('drinks only take "time", not prep/cook time');
  const plainTitle = String(fm.title || '').replace(/simple syrup/gi, '');
  for (const w of R.TITLE_FILLER) if (new RegExp(`\\b${w}\\b`, 'i').test(plainTitle)) warn(`title contains filler word "${w}"`);
  const tags = fm.tags;
  if (typeof tags === 'string' && tags) err('tags must be a flow list: [a, b, c]');
  else if (Array.isArray(tags)) {
    if (tags.length < 2 || tags.length > 6) warn(`${tags.length} tags; aim for 2 to 6`);
    const vocab = new Set([...R.COURSE, ...R.CUISINE, ...R.DIET].map((x) => x.replace(/ /g, '-')));
    for (const t of tags) {
      if (!TAG_RE.test(t)) err(`tag "${t}" must be lowercase with hyphens, no spaces`);
      if (R.BANNED_TAGS.includes(t)) err(`tag "${t}" is not allowed (subjective, or covered by another field)`);
      else if (vocab.has(t.replace(/ /g, '-'))) err(`tag "${t}" duplicates course/cuisine/diet; use that field instead`);
    }
    if (new Set(tags).size !== tags.length) warn('duplicate tags');
  }
  const expected = R.FOLDER_FOR_COURSE[course];
  if (expected) {
    const folder = path.split('/').slice(0, -1).join('/');
    if (folder && folder !== expected && !folder.startsWith(`${expected}/`)) warn(`course "${course}" but the file is in ${folder}/ (expected ${expected}/)`);
  }

  // ---- body
  const ems = (body.match(/—/g) || []).length;
  if (ems > 1) warn(`${ems} em dashes in the steps; keep them to a minimum`);
  body.split(/\r?\n/).forEach((line, n) => {
    const i = n + offset + 1;
    const s = line.trim();
    if (s.startsWith('>>')) err('legacy ">>" metadata or header line; use frontmatter or "= Section ="', i);
    if (s.startsWith('--') || s.startsWith('[-')) return; // comments are free text
    if (/\}\([^)]*[@~][^)]*\)/.test(line)) err('ingredient or timer inside a prep note (...); apps ignore markup there', i);
    if (/^\d+[.)]\s/.test(s)) err('numbered step; steps are plain paragraphs', i);
    if (/\*\*|^#{1,6}\s/.test(s)) err('markdown formatting inside a step', i);
    for (const m of line.matchAll(/([@#])(\?|&)?([^@#~{}\n]*?)\{([^}]*)\}/g)) {
      const [, kind, , rawName, inner] = m;
      const nm = rawName.trim();
      if (kind === '@') {
        if (!inner.trim()) { err(`@${nm}{} has no quantity (use a number or e.g. "to taste")`, i); continue; }
        if (nm.includes('(')) warn(`parentheses in ingredient name "@${nm}"; put prep or notes after the braces: @x{1}(diced)`, i);
        if (nm.startsWith('./') || nm.startsWith('../')) {
          const ref = resolve(nm);
          if (!ref || !exists(ref)) err(`recipe reference "${nm}" does not resolve to a file`, i);
        }
      }
      const parts = inner.split('%');
      const qty = parts[0].replace(/^=+/, '').trim();
      const unit = parts.length > 1 ? parts[1].trim() : '';
      if (parts.length > 2) err(`more than one % in {${inner}}`, i);
      if (/^\d+(\.\d+)?\s*-\s*\d+(\.\d+)?$/.test(qty)) warn(`range "${qty}" as a quantity; pick one value and mention the range in the text`, i);
      if (unit) {
        if (unit in R.BAD_UNITS) err(`unit "${unit}", use "${R.BAD_UNITS[unit]}"`, i);
        if (R.IMPERIAL_UNITS.includes(unit.toLowerCase())) err(`imperial unit "${unit}"`, i);
        if (PREP_WORDS.test(unit)) err(`preparation word in the unit "${unit}"; write @${nm}{${qty}}(prep) instead`, i);
      }
    }
    for (const m of line.matchAll(/@[?&]?([^@#~\n]*)/g)) {
      if (!m[1].includes('{')) err(`@${m[1].split(/\s+/)[0] || ''} has no braces, so no quantity`, i);
    }
    for (const m of line.matchAll(/~([^{\s]*)\{([^}]*)\}/g)) {
      const inner = m[2];
      const parts = inner.split('%');
      if (parts.length !== 2) { err(`timer ~{${inner}} needs number%unit`, i); continue; }
      const q = parts[0].trim();
      const u = parts[1].trim();
      if (q.includes('-')) err(`timer range "${q}"; set the lower bound and put the range in the text`, i);
      else if (!/^(\d+(\.\d+)?|\d+\/\d+)$/.test(q)) err(`timer quantity "${q}" must be a single number`, i);
      if (!R.TIMER_UNITS.includes(u)) err(`timer unit "${u}", use seconds, minutes or hours`, i);
    }
    if (/\d\s*°\s*F\b|\d\s*ºF|\b\d{3}\s*F\b/.test(line)) err('Fahrenheit temperature', i);
    for (const m of line.matchAll(/(\d+)\s*([°º])?\s*C\b/g)) {
      if (m[0] !== `${m[1]} °C` && (m[2] || /\d+C\b/.test(m[0]))) warn(`temperature "${m[0]}", write "${m[1]} °C"`, i);
    }
    if (/(?<![\w%])\d+(\.\d+)?\s*(oz|ounces?|lbs?|pounds?|cups?|inch(es)?|quarts?)\b/.test(line)) err('imperial measurement in the text', i);
    if (!s.startsWith('>') && /(?<![~\w])(?:for|about|another|cook|bake|simmer|rest)\s+(\d+)\s+(seconds|minutes|hours)\b/.test(line) && !line.includes('~')) {
      warn('time in the text without a ~{} timer', i);
    }
  });
  return { errors, warnings };
}

/** "./07 Basics/pesto": references start at the collection's root, as in cooklint.py. */
function resolve(ref) {
  const parts = [];
  for (const seg of ref.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(seg);
  }
  return parts.join('/');
}
