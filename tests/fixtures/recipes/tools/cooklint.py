#!/usr/bin/env python3
"""cooklint: house-style checker for the Cooklang recipe collection.

Usage
    python tools/cooklint.py                 check every .cook file in the collection
    python tools/cooklint.py "03 Soups/minestrone.cook"   check specific files
    python tools/cooklint.py --errors        show errors only (hide warnings)

Exit code is 1 when any error is found, so it can run before a sync or commit.
No dependencies beyond the Python standard library.

The vocabularies below mirror the cooklang-recipe skill. When you add a value
there, add it here too (and vice versa).
"""
import os, re, sys

# ---------------------------------------------------------------- vocabulary
COURSE = ['breakfast', 'starter', 'main', 'side', 'soup', 'salad', 'dessert',
          'baking', 'bread', 'sauce', 'basic', 'drink']
CUISINE = ['american', 'belgian', 'british', 'caribbean', 'chinese', 'dutch',
           'eastern european', 'filipino', 'french', 'german', 'greek', 'indian',
           'international', 'italian', 'japanese', 'korean', 'latin american',
           'mexican', 'middle eastern', 'north african', 'portuguese',
           'scandinavian', 'southeast asian', 'spanish', 'thai', 'turkish',
           'vietnamese', 'west african']
DIET = ['vegan', 'vegetarian', 'pescatarian', 'meat']
DIFFICULTY = ['easy', 'medium', 'hard']
BANNED_TAGS = {'easy', 'medium', 'hard', 'quick', 'classic', 'modern-classic',
               'healthy', 'luxury', 'michelin', 'fine-dining', 'comfort-food',
               'dinner', 'lunch', 'mains', 'main-course', 'main-dish',
               'side-dish', 'sides', 'cocktail', 'cocktails', 'drinks',
               'beverage', 'simple', 'best', 'delicious', 'weeknight'}
TITLE_FILLER = ['quick', 'best', 'classic', 'easy', 'ultimate', 'simple',
                'basic', 'homemade', 'traditional', 'luxurious', 'perfect',
                'authentic', 'michelin', 'amazing']
FOLDER_FOR_COURSE = {'breakfast': '01 Breakfast',
                     'starter': '02 Starters',
                     'soup': '03 Soups',
                     'salad': '04 Salads',
                     'main': '05 Mains',
                     'side': '06 Sides',
                     'sauce': '07 Basics', 'basic': '07 Basics',
                     'bread': '08 Dough',
                     'baking': '09 Desserts', 'dessert': '09 Desserts',
                     'drink': '10 Drinks'}

FIELDS = ['title', 'description', 'author', 'source', 'course', 'cuisine',
          'diet', 'difficulty', 'servings', 'yield', 'time', 'prep time',
          'cook time', 'tags', 'image', 'locale']
REQUIRED = ['title', 'description', 'author', 'course', 'cuisine', 'diet',
            'difficulty', 'servings', 'time', 'tags']
REQUIRED_NOT_DRINK = ['prep time', 'cook time']

TIME_RE = re.compile(r'^(?=\d)(\d+h)?(\d+m)?$')
YIELD_RE = re.compile(r'^\d+(\.\d+)?%\S.*$')
TAG_RE = re.compile(r'^[a-z0-9][a-z0-9-]*$')
TIMER_UNITS = {'second', 'seconds', 'minute', 'minutes', 'hour', 'hours', 'day', 'days'}
BAD_UNITS = {'Tbsp': 'tbsp', 'Tsp': 'tsp', 'TBSP': 'tbsp', 'grams': 'g', 'gram': 'g',
             'L': 'l', 'litre': 'l', 'liter': 'l', 'mins': 'minutes', 'min': 'minutes',
             'hrs': 'hours', 'hr': 'hours', 'unit': '(leave the unit empty)'}
IMPERIAL_UNITS = {'oz', 'ounce', 'ounces', 'lb', 'lbs', 'pound', 'pounds', 'cup',
                  'cups', 'quart', 'quarts', 'pint', 'pints', 'inch', 'inches',
                  'fl oz', 'stick', 'sticks'}
PREP_WORDS = re.compile(r'\b(minced|diced|chopped|sliced|grated|crushed|smashed|'
                        r'rinsed|peeled|halved|quartered|softened|melted|beaten|'
                        r'drained|shredded|julienned)\b', re.I)

# ---------------------------------------------------------------- helpers
def parse_frontmatter(text):
    m = re.match(r'^---\r?\n(.*?)\r?\n---\r?\n?', text, re.S)
    if not m:
        return None, text, 0
    fm = {}
    for line in m.group(1).splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        mm = re.match(r'^([A-Za-z][A-Za-z _.]*?)\s*:\s*(.*)$', line)
        if not mm:
            fm.setdefault('__bad__', []).append(line)
            continue
        k, v = mm.group(1), mm.group(2).strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in '"\'':
            v = v[1:-1]
        if v.startswith('[') and v.endswith(']'):
            v = [x.strip().strip('"\'') for x in v[1:-1].split(',') if x.strip()]
        fm[k] = v
    return fm, text[m.end():], m.group(0).count('\n')


def collection_root():
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.dirname(here) if os.path.basename(here) == 'tools' else here


def check(path, root):
    out = []
    def err(msg, line=None): out.append(('ERROR', line, msg))
    def warn(msg, line=None): out.append(('WARN', line, msg))

    name = os.path.basename(path)
    if not re.fullmatch(r'[a-z0-9_]+\.cook', name):
        err(f'filename is not snake_case ascii: {name}')
    text = open(path, encoding='utf-8').read()
    fm, body, offset = parse_frontmatter(text)

    # ---- frontmatter
    if fm is None:
        err('no YAML frontmatter block (--- ... ---) at the top of the file')
        fm = {}
    for bad in fm.pop('__bad__', []):
        err(f'unparseable frontmatter line: {bad}')
    for k in fm:
        if k not in FIELDS:
            hint = {'prep_time': 'prep time', 'cook_time': 'cook time', 'duration': 'time',
                    'yields': 'yield', 'dietary': 'diet'}.get(k)
            (err if hint else warn)(f'unknown field "{k}"' + (f', use "{hint}"' if hint else ''))
    if fm:
        keys = [k for k in fm if k in FIELDS]
        if keys != sorted(keys, key=FIELDS.index):
            warn('fields are not in house order: ' + ', '.join(FIELDS[:14]))
    course = fm.get('course')
    req = REQUIRED + ([] if course == 'drink' else REQUIRED_NOT_DRINK)
    for k in req:
        if not fm.get(k) and fm.get(k) != '0m':
            err(f'missing required field "{k}"')
    for k, allowed in (('course', COURSE), ('cuisine', CUISINE), ('diet', DIET), ('difficulty', DIFFICULTY)):
        v = fm.get(k)
        if v and v not in allowed:
            err(f'{k} "{v}" is not in the vocabulary: {", ".join(allowed)}')
    for k in ('time', 'prep time', 'cook time'):
        v = fm.get(k)
        if v and not TIME_RE.match(str(v)):
            err(f'{k} "{v}" should look like 1h30m, 45m or 2h')
    v = fm.get('servings')
    if v and not re.fullmatch(r'\d+', str(v)):
        err(f'servings "{v}" must be a whole number')
    v = fm.get('yield')
    if v and not YIELD_RE.match(str(v)):
        err(f'yield "{v}" should be number%unit, e.g. 12%cookies or 500%ml')
    if course == 'drink' and (fm.get('prep time') or fm.get('cook time')):
        warn('drinks only take "time", not prep/cook time')
    title = str(fm.get('title', ''))
    plain_title = re.sub(r'(?i)simple syrup', '', title)
    for w in TITLE_FILLER:
        if re.search(rf'\b{w}\b', plain_title, re.I):
            warn(f'title contains filler word "{w}"')
    tags = fm.get('tags')
    if isinstance(tags, str):
        err('tags must be a flow list: [a, b, c]')
    elif isinstance(tags, list):
        if not 2 <= len(tags) <= 6:
            warn(f'{len(tags)} tags; aim for 2 to 6')
        vocab = {x.replace(' ', '-') for x in COURSE + CUISINE + DIET}
        for t in tags:
            if not TAG_RE.match(t):
                err(f'tag "{t}" must be lowercase with hyphens, no spaces')
            if t in BANNED_TAGS:
                err(f'tag "{t}" is not allowed (subjective, or covered by another field)')
            elif t.replace(' ', '-') in vocab:
                err(f'tag "{t}" duplicates course/cuisine/diet; use that field instead')
        if len(set(tags)) != len(tags):
            warn('duplicate tags')
    if course in FOLDER_FOR_COURSE:
        folder = os.path.dirname(os.path.relpath(path, root)).replace('\\', '/')
        expected = FOLDER_FOR_COURSE[course]
        if folder and folder != expected and not folder.startswith(expected + '/'):
            warn(f'course "{course}" but file lives in {folder}/ (expected {expected}/)')

    # ---- body
    ems = body.count('—')
    if ems > 1:
        warn(f'{ems} em dashes in the steps; keep them to a minimum')
    for i, line in enumerate(body.splitlines(), start=offset + 1):
        s = line.strip()
        if s.startswith('>>'):
            err('legacy ">>" metadata or header line; use frontmatter or "= Section ="', i)
        if s.startswith('--') or s.startswith('[-'):
            continue  # comments are free text
        if re.search(r'\}\([^)]*[@~][^)]*\)', line):
            err('ingredient or timer inside a prep note (...); apps ignore markup there', i)
        if re.match(r'^\d+[.)]\s', s):
            err('numbered step; steps are plain paragraphs', i)
        if re.search(r'\*\*|^#{1,6}\s', s):
            err('markdown formatting inside a step', i)
        for m in re.finditer(r'([@#])(\?|&)?([^@#~{}\n]*?)\{([^}]*)\}', line):
            kind, _, nm, inner = m.groups()
            nm = nm.strip()
            if kind == '@':
                if not inner.strip():
                    err(f'@{nm}{{}} has no quantity (use a number or e.g. "to taste")', i)
                    continue
                if '(' in nm:
                    warn(f'parentheses in ingredient name "@{nm}"; put prep or notes after the braces: @x{{1}}(diced)', i)
                if nm.startswith('./') or nm.startswith('../'):
                    ref = os.path.normpath(os.path.join(root, nm + '.cook'))
                    if not os.path.exists(ref):
                        err(f'recipe reference "{nm}" does not resolve to a file', i)
            parts = inner.split('%')
            qty = parts[0].lstrip('=').strip()
            unit = parts[1].strip() if len(parts) > 1 else ''
            if len(parts) > 2:
                err(f'more than one % in {{{inner}}}', i)
            if re.fullmatch(r'\d+(\.\d+)?\s*-\s*\d+(\.\d+)?', qty):
                warn(f'range "{qty}" as a quantity; pick one value and mention the range in the text', i)
            if unit:
                if unit in BAD_UNITS:
                    err(f'unit "{unit}", use "{BAD_UNITS[unit]}"', i)
                if unit.lower() in IMPERIAL_UNITS:
                    err(f'imperial unit "{unit}"', i)
                if PREP_WORDS.search(unit):
                    err(f'preparation word in the unit "{unit}"; write @{nm}{{{qty}}}(prep) instead', i)
        for m in re.finditer(r'@[?&]?([^@#~\n]*)', line):
            if '{' not in m.group(1):
                word = (m.group(1).split() or [''])[0]
                err(f'@{word} has no braces, so no quantity', i)
        for m in re.finditer(r'~([^{\s]*)\{([^}]*)\}', line):
            inner = m.group(2)
            parts = inner.split('%')
            if len(parts) != 2:
                err(f'timer ~{{{inner}}} needs number%unit', i)
                continue
            q, u = parts[0].strip(), parts[1].strip()
            if '-' in q:
                err(f'timer range "{q}"; set the lower bound and put the range in the text', i)
            elif not re.fullmatch(r'\d+(\.\d+)?|\d+/\d+', q):
                err(f'timer quantity "{q}" must be a single number', i)
            if u not in TIMER_UNITS:
                err(f'timer unit "{u}", use seconds, minutes or hours', i)
        if re.search(r'\d\s*°\s*F\b|\d\s*ºF|\b\d{3}\s*F\b', line):
            err('Fahrenheit temperature', i)
        for m in re.finditer(r'(\d+)\s*([°º])?\s*C\b', line):
            if m.group(0) != f'{m.group(1)} °C' and (m.group(2) or re.search(r'\d+C\b', m.group(0))):
                warn(f'temperature "{m.group(0)}", write "{m.group(1)} °C"', i)
        if re.search(r'(?<![\w%])\d+(\.\d+)?\s*(oz|ounces?|lbs?|pounds?|cups?|inch(es)?|quarts?)\b', line):
            err('imperial measurement in the text', i)
        if not s.startswith('>') and re.search(r'(?<![~\w])(?:for|about|another|cook|bake|simmer|rest)\s+(\d+)\s+(seconds|minutes|hours)\b', line) and '~' not in line:
            warn('time in the text without a ~{} timer', i)

    # ---- image
    base = path[:-5]
    imgs = [ext for ext in ('.jpg', '.jpeg', '.png', '.webp') if os.path.exists(base + ext)]
    if not imgs:
        warn('no image')
    elif '.jpg' not in imgs:
        warn(f'image is {imgs[0]}, house format is .jpg')
    elif len(imgs) > 1:
        warn('more than one image: ' + ', '.join(imgs))
    for ext in imgs:
        if os.path.getsize(base + ext) > 1024 * 1024:
            warn(f'image {ext} is over 1 MB')
    return out


def main(argv):
    root = collection_root()
    errors_only = '--errors' in argv
    paths = [a for a in argv if not a.startswith('--')]
    files = []
    if paths:
        files = [os.path.abspath(p) for p in paths]
    else:
        for d, dirs, fs in os.walk(root):
            dirs[:] = [x for x in dirs if not x.startswith(('.', '_')) and x not in ('tools', 'config')]
            files += [os.path.join(d, f) for f in fs if f.endswith('.cook')]
        for d, dirs, fs in os.walk(root):
            dirs[:] = [x for x in dirs if not x.startswith(('.', '_')) and x not in ('tools', 'config')]
            for f in fs:
                if f.lower().endswith(('.jpg', '.jpeg', '.png', '.webp')):
                    if not os.path.exists(os.path.join(d, os.path.splitext(f)[0] + '.cook')):
                        print(f'WARN  {os.path.relpath(os.path.join(d, f), root)}: image without a recipe')
    n_err = n_warn = 0
    for f in sorted(files):
        res = check(f, root)
        shown = [r for r in res if not errors_only or r[0] == 'ERROR']
        n_err += sum(r[0] == 'ERROR' for r in res)
        n_warn += sum(r[0] == 'WARN' for r in res)
        for level, line, msg in shown:
            loc = os.path.relpath(f, root) + (f':{line}' if line else '')
            print(f'{level:5} {loc}: {msg}')
    print(f'\n{len(files)} recipes checked: {n_err} errors, {n_warn} warnings')
    return 1 if n_err else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
