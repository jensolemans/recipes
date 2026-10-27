# Recipe site

Jens's Cooklang recipe collection as a website on GitHub Pages
(https://jensolemans.github.io/recipes/). Friends browse, filter and scale
recipes read-only; Jens signs in with Google to add, edit, move and delete
recipes, which writes straight to the Google Drive folder "Cooklang Recipes".
That Drive folder is the only database. The Cooklang phone app and desktop
folders use the same files.

## How it fits together

- `app/` is the whole website: plain HTML, CSS and ES modules, no build step,
  no framework, no npm dependencies at runtime.
  - `app.js`: routing (`#/`, `#/r/<path>`, `#/edit/<path>`, `#/new`), home with
    search and a folder button that says where you are and opens one panel
    with the Drive folders (a path on top to go back up; one level at a time
    on phones, each folder with its subfolders on bigger screens) and the filters:
    a bottom sheet with two tabs on phones, a wide panel with both side by
    side on bigger screens, recipe view with scaling and timers,
    cook mode (`#/cook/<path>`), editor.
  - Cook mode: the recipe page's chef hat button opens it. Step 0 is the mise
    en place (servings, ingredients and tools as ticks, shared with the
    recipe page), then one step at a time (swipe or buttons, arrow keys) or
    all steps in one column; the pick and "keep the screen on" (Wake Lock)
    are saved per device. The bar at the bottom has a pill per step, grouped
    and labelled by `== Section ==` chapters. From 900 px a list beside the
    step ticks off what is behind you. `s`, `x` and `step` stay in the link.
  - `cooklang.js`: loads the official Cooklang WASM parser from
    `app/vendor/cooklang/` (@cooklang/cooklang 0.19.1) and formats quantities.
    The parser runs with `load_units = false` so units stay exactly as written
    (no conversion to cups). Scaling is `parser.parse(src, factor)`, which
    respects fixed quantities like `@salt{=1%tsp}`.
  - `drive.js`: Google sign-in (Google Identity Services token flow, scope
    `drive`) and Drive REST calls. Runs in the browser with the user's token.
  - `shopping.js`: the signed-in shopping list (`#/list`). Stored in Drive as
    `config/shopping_list.json` (recipes with their scale and chosen parts, i.e.
    `== Section ==` headings, own items, checked
    and removed lines); the list itself is worked out from that with
    `config/aisle.conf` (store order, spellings) and `config/pantry.conf`
    ("Probably have"). Changes queue in localStorage and replay on top of the
    newest Drive version, so offline ticks and two devices both work. The list
    page checks Drive every 15 s and when the tab comes back. From 1100 px
    wide the list also sits on the right as a side panel (`#side`): a rail
    when closed, open or closed remembered per device, L toggles it, the
    editor keeps it a rail and the list page hides it. Narrower than that,
    signed in, a bottom tab bar (`#tabbar`: Recipes, Shopping list, New)
    takes its place, with Add to shopping list pinned above it on recipes.
  - `sw.js` + `manifest.webmanifest` + `icons/`: installable home-screen app
    that opens without a connection. The service worker serves the site from
    its cache and refreshes it in the background (network first on
    localhost). build.py stamps `CACHE` in `sw.js` with a fingerprint of the
    site files, so each release installs as a whole and open pages offer a
    reload; add new site files to `SITE` in `sw.js`. build.py also names the
    app after the site title.
  - `fonts/`: self-hosted Bricolage Grotesque (UI, headings) and Newsreader
    (method text, descriptions).
- `scripts/build.py RECIPES APP OUT`: copies `app/` to OUT and writes
  `data/recipes.json` (path, source, md5, mtime, photo id per recipe, plus the
  site config) and resized photos in `img/` and `thumb/`. The md5 equals
  Drive's md5Checksum, so the signed-in app only downloads files that changed
  since the last build.
- `scripts/dev.py`: local preview at http://localhost:8000. Serves `app/` live
  and rebuilds the data from the synced Drive folder when recipes change.
  Settings in `local.json` (gitignored). Started by the desktop app's Browser
  pane through `.claude/launch.json`.
- `.claude/skills/import-recipe/`: the `/import-recipe` command for Claude
  Code on the laptop. Takes a link, pasted text or a cookbook photo, converts
  it with Jens's `cooklang-recipe` skill, saves the `.cook` file in the right
  folder of the synced Drive folder, adds the dish photo with
  `scripts/fetch_photo.py` and runs `tools/cooklint.py`. In the site's editor,
  pasting Claude's whole reply keeps only the recipe, the category follows
  the course and tags, and Paste photo / Photo link add the photo.
- `.github/workflows/publish.yml`: hourly (and on push to main) downloads the
  recipes with rclone (service account, read only), runs build.py and deploys
  to GitHub Pages. Repo variables: `GDRIVE_FOLDER_ID`, `GOOGLE_CLIENT_ID`,
  `SITE_TITLE`; secret: `GDRIVE_SERVICE_ACCOUNT`.
- `tests/e2e.mjs`: Playwright tests against a running site, with an in-memory
  fake of the Google Drive API for the editor.

## Working on it

- While building: make the change and show it in the preview ("Recipe site" in
  the Browser pane, or `python scripts/dev.py`), in one view only. Check with
  page text and the console; take a screenshot only when the change is visual.
  No full screenshot pass and no tests after each change.
- When Jens is happy and wants to commit: one full check on desktop and phone
  width (390 px), light and dark mode, then run the tests, then commit.
- Tests: with the preview running,
  `node tests/e2e.mjs http://localhost:8000 "<recipesDir from local.json>"`
  (needs `npm i -g playwright` once). They must pass before every commit.
- Never write to the real Drive folder while testing; the tests use the fake.
- `ROADMAP.md` lists the features still to build, in order. Tick an item off
  in the same commit that ships it.
- Pushing to `main` publishes the site within about a minute. Do larger
  changes on a branch first.

## Conventions

- Recipes: metric units, YAML frontmatter with title, description, author,
  source, course, cuisine, diet, difficulty, servings, time, prep time,
  cook time, tags (yield optional). File names are snake_case.
- Interface text: plain English, sentence case, short. No em dashes anywhere
  (UI copy, docs, commit messages).
- Design: minimal and neutral, white and black (#FAFAFA / #0E0E0E pages).
  The Cooklang orange (#E77B54) is used sparingly, only where an accent helps:
  the full-height ingredient highlighter in method steps, the current folder in the folder panel, focus
  rings and a finished timer. Buttons and selected chips are black (white in
  dark). Keep it that way unless asked; colours are CSS variables in
  `app/style.css`. The top bar toggle switches light and dark; it starts from
  the device setting (dark when there is none) and a pick is saved per device.
- Keep the site dependency-free and static so it stays free to host.
