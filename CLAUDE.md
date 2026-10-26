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
    category tabs, search and filters, recipe view with scaling and timers,
    editor.
  - `cooklang.js`: loads the official Cooklang WASM parser from
    `app/vendor/cooklang/` (@cooklang/cooklang 0.19.1) and formats quantities.
    The parser runs with `load_units = false` so units stay exactly as written
    (no conversion to cups). Scaling is `parser.parse(src, factor)`, which
    respects fixed quantities like `@salt{=1%tsp}`.
  - `drive.js`: Google sign-in (Google Identity Services token flow, scope
    `drive`) and Drive REST calls. Runs in the browser with the user's token.
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
- `.github/workflows/publish.yml`: hourly (and on push to main) downloads the
  recipes with rclone (service account, read only), runs build.py and deploys
  to GitHub Pages. Repo variables: `GDRIVE_FOLDER_ID`, `GOOGLE_CLIENT_ID`,
  `SITE_TITLE`; secret: `GDRIVE_SERVICE_ACCOUNT`.
- `tests/e2e.mjs`: Playwright tests against a running site, with an in-memory
  fake of the Google Drive API for the editor.

## Working on it

- Preview: start "Recipe site" in the Browser pane (or `python scripts/dev.py`)
  and check every change there, on desktop and phone width (390 px), light and
  dark mode.
- Tests: with the preview running,
  `node tests/e2e.mjs http://localhost:8000 "<recipesDir from local.json>"`
  (needs `npm i -g playwright` once). Run them before pushing.
- Never write to the real Drive folder while testing; the tests use the fake.
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
  the full-height ingredient highlighter in method steps, the selected category, focus
  rings and a finished timer. Buttons and selected chips are black (white in
  dark). Keep it that way unless asked; colours are CSS variables in
  `app/style.css`. The top bar toggle cycles Auto, Light and Dark, saved per
  device.
- Keep the site dependency-free and static so it stays free to host.
