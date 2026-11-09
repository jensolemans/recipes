# How the recipe site fits together

The detail behind `CLAUDE.md`: what each part does and how it behaves. Read
the section for the part you are changing. Each JavaScript module also opens
with a short comment saying what it holds.

## The big picture

Jens's Cooklang recipe collection as a website on GitHub Pages
(https://jensolemans.github.io/recipes/). Friends browse, filter and scale
recipes read-only; Jens signs in with Google to add, edit, move and delete
recipes, which writes straight to the Google Drive folder "Cooklang Recipes".
That Drive folder is the only database. The Cooklang phone app and desktop
folders use the same files.

- `app/` is the whole website: plain HTML, CSS and ES modules, no build step,
  no framework, no npm dependencies at runtime. `scripts/build.py` turns it
  and the Drive folder into the published site.
- `connector/` is a free Cloudflare Worker that keeps the site signed in and
  is Claude's recipes connector.
- `.github/workflows/` tests, builds and publishes.

## The website (`app/`)

`index.html` is the one page; every view is a `#hash` route. The styles are
in `app/css/`, one file per part, linked in order (later files build on
earlier ones; `responsive.css` and `print.css` come last). The modules are in
`app/js/`.

### Modules

| Module | What it holds |
|---|---|
| `app.js` | Entry point: boot, routing, theme toggle, account bar |
| `util.js` | `$`, `esc`, folding, per-device storage (`saved`), breakpoints |
| `state.js` | The shared state `S` and `makeEntry` (index entry to recipe) |
| `ui.js` | Menus, toast, modal questions (`ask`, `askText`, `pick`, `chooseParts`) |
| `icons.js` | Every inline SVG icon |
| `lazy.js` | Loaders for the views that load on first use |
| `choose.js` | New and Edit: Ask Claude or the editor |
| `live.js` | Signed in: recipes and photos live from Drive |
| `home.js` | Home: search, sort, cards, the folder button and filter bar |
| `recipe.js` | The recipe page and the ingredient helpers others share |
| `share.js` | Share sheet and QR card (lazy) |
| `cook.js` | Cook mode (lazy) |
| `list.js` | The shopping list view |
| `planner.js` | Meal plan state and changes |
| `planner-view.js` | Meal plan drawing, pickers, dragging (lazy) |
| `side.js` | Side panel (wide) and tab bar (narrow) |
| `timers.js` | Timers |
| `editor.js` | The editor (lazy) |
| `cooklang.js` | The Cooklang parser and quantity formatting |
| `drive.js` | Google sign-in and Drive REST calls |
| `shopping.js` | Shopping list data, rules and sync with Drive |
| `plan.js` | Meal plan data and rules |
| `qr.js` | QR code maker |

Lazy views: friends never need the editor or the plan, and most visits never
open cook mode or share, so these load on first use (`lazy.js`). Signed in,
the plan loads as soon as it shows anywhere, and the editor and cook mode
load right after start, so they also open offline. A view that cannot load
says so instead of leaving the page blank.

### Routing and views (`app.js`)

Routes: `#/` home, `#/r/<path>` recipe, `#/cook/<path>` cook mode,
`#/edit/<path>` editor, `#/new` editor for a new recipe, `#/list` shopping
list, `#/plan` meal plan.

### Home (`home.js`)

Search, then the folder button (firmer outline, the folder's name in bold:
it is the first thing to pick) and beside it the filter bar: Diet, Time,
Difficulty and More (course, cuisine, tags). Each part says what is picked.
On bigger screens each opens a panel under it: the folders in flowing columns
with subfolders as chips, Diet as a checklist (pick several; vegetarian takes
vegan along; `pescatarian` counts as fish), Time as a slider with two ends
over a small chart of how long the recipes take (every 15 minutes up to an
hour, then 1 h 30, 2 h, 2 h+), Difficulty as a checklist too (two of three
reads "Not hard"). While the search would be narrower than the folder
button, bar and sort together, it gets a row of its own and the folder
button stretches to fill the row below (`fitRow`). Escape or a click
outside closes it. On phones the bar is not on the page: the folder button
opens one sheet with the same filter bar in a grey band on top (the open
filter under it) and the folder list below, a folder with subfolders opening
in place; the filters that are on show as chips under the search. Sort is a
round icon button at the end of the row. On a very narrow phone, once the
search would be narrower than the folder button, that button is just its
folder icon (`fitRow`).

### New and Edit (`choose.js`)

New and Edit ask how (a bottom sheet on phones, a small menu by the button on
bigger screens): Ask Claude is a `claude.ai/new?q=` link with the start of
the request typed in (the folder being browsed, or the recipe's path); Claude
writes with the cooklang-recipe skill and saves through the connector. Start
blank / Edit the file opens the editor. Offline, or when the connector does
not answer, the editor comes first and Ask Claude says why it is out; without
`authUrl` they open the editor straight away. Edit on a recipe also has
Change photo (signed in, with Drive): the picked photo shows dimmed with a
spinner on the page while it saves. The recipe's buttons stay on one row
(`fitActions` in `recipe.js`): the last ones that do not fit go under ⋯,
which only shows then. The editor keeps unsaved work as a draft on the
device.

Ingredients "As written" on a recipe with two or more `== Section ==`
chapters that use ingredients are listed per chapter under its name
(`ingChapters` in `recipe.js`), on the recipe page and in the mise en place.
An ingredient used twice in one chapter is added up there; one used in two
chapters shows in both. "By aisle" stays one merged list.

### Cook mode (`cook.js`)

The recipe page's chef hat button opens it. Step 0 is the mise en place
(servings, ingredients and tools as ticks, shared with the recipe page), then
one step at a time (swipe or buttons, arrow keys) or all steps in one column,
where the current step snaps to the top with the next one half faded below
(tap any step to glide to it; snapping is off during the glide for Safari);
the pick and "keep the screen on" (Wake Lock) are saved per device. The bar
at the bottom has a pill per step, grouped and labelled by `== Section ==`
chapters. From 900 px a list beside the step ticks off what is behind you.
`s`, `x` and `step` stay in the link.

### Parsing (`cooklang.js`)

Loads the official Cooklang WASM parser from `app/vendor/cooklang/`
(@cooklang/cooklang 0.19.1) and formats quantities. The parser runs with
`load_units = false` so units stay exactly as written (no conversion to
cups). Scaling is `parser.parse(src, factor)`, which respects fixed
quantities like `@salt{=1%tsp}`. `cooklang_wasm_bg.d.ts` next to it only
describes it for the type check.

### Share (`share.js`, `qr.js`)

The recipe page's share button opens a bottom sheet on phones (share link,
copy ingredients, share the whole recipe as plain text) and a centred card
with a QR code on bigger screens. The link carries the scale, so all of it
opens at the current servings. `qr.js` is a small hand-written QR code maker
(byte mode, level M).

### Google sign-in and Drive (`drive.js`)

Google sign-in (Google Identity Services token flow, scope `drive`) and Drive
REST calls. Runs in the browser with the user's token. With `authUrl` set,
sign-in goes through the connector Worker instead (see below).

### Shopping list (`shopping.js`, `list.js`, `side.js`)

The signed-in shopping list (`#/list`). Stored in Drive as
`config/shopping_list.json` (recipes with their scale and chosen parts, i.e.
`== Section ==` headings, own items, checked and removed lines); the list
itself is worked out from that with `config/aisle.conf` (store order,
spellings) and `config/pantry.conf` ("Probably have"). Changes queue in
localStorage and replay on top of the newest Drive version, so offline ticks
and two devices both work. The list page checks Drive every 15 s and when the
tab comes back. From 1100 px wide the list also sits on the right as a side
panel (`#side`): a rail when closed, open or closed remembered per device, L
toggles it, the editor keeps it a rail and the list page hides it. Narrower
than that, signed in, a bottom tab bar (`#tabbar`: Recipes, Plan, List, New)
takes its place, with Add to shopping list pinned above it on recipes.

### Meal plan (`plan.js`, `planner.js`, `planner-view.js`)

Saved recipes and the days ahead, in Drive as `config/plan.json`, synced the
same way as the list. It shows in three places: the side panel beside the
recipes on wide screens, `#/plan` (a real week on wide screens, the Plan tab
on phones), and Today on top of the home page. The plan and the shopping
list stay in step (what is on the list or bought shows on the plan).

### Offline and installable (`sw.js`, `manifest.webmanifest`, `icons/`)

An installable home-screen app that opens without a connection. The service
worker serves the site from its cache and refreshes it in the background
(network first on localhost). The recipe index tries the network first for
3 seconds. Photos are kept once seen and dropped once the index no longer
names them. `build.py` fills in `SITE` (every file in `app/`, so nothing new
is ever missing offline) and stamps `CACHE` with a fingerprint of the site
files, so each release installs as a whole and open pages offer a reload.
`build.py` also names the app after the site title.

### Security

`index.html` sets a Content Security Policy: only the site's own scripts and
Google sign-in may run, so text in a recipe can never run as code. The one
inline script (the theme, before first paint) is allowed by its hash: change
the script, change the hash. Any https address may be fetched and shown,
for photo links.

### Fonts (`fonts/`)

Self-hosted Bricolage Grotesque (UI, headings) and Newsreader (method text,
descriptions).

## The build (`scripts/build.py`)

`scripts/build.py RECIPES APP OUT [--keep-photos]` copies `app/` to OUT and
writes `data/recipes.json` (path, source, md5, mtime, photo id per recipe,
plus the site config and `config/aisle.conf`, so friends can sort a recipe's
ingredients "By aisle" on the recipe page and in the mise en place too) and
resized photos in `img/` and `thumb/`. The md5 equals Drive's md5Checksum,
so the signed-in app only downloads files that changed since the last build.

`data/recipes.json` is the public index: the site is static, and friends are
not signed in to Drive, so every recipe's text is baked into this one file.
Signed in, it is the starting point: only recipes whose md5 changed in Drive
since are downloaded.

With `--keep-photos`, resized photos already in OUT stay and only new ones
are made; ones no recipe uses are removed. `version.txt` is a fingerprint of
everything except the build time, so the hourly publish can tell nothing
changed.

## Local preview (`scripts/dev.py`)

Local preview at http://localhost:8000. Serves `app/` live and rebuilds the
data from the synced Drive folder when a recipe, photo or `aisle.conf` is
added, removed, renamed, moved or edited. Settings in `local.json`
(gitignored). Started by the desktop app's Browser pane through
`.claude/launch.json`. The tests start their own copy with `RECIPES_DIR`,
`DEV_OUT` and `PORT`.

## Importing recipes

`.claude/skills/import-recipe/` is the `/import-recipe` command for Claude
Code on the laptop. Takes a link, pasted text or a cookbook photo, converts
it with Jens's `cooklang-recipe` skill, and saves it with its photo through
the recipes connector (`save_recipe`, `set_photo`), the same path Claude on
the phone and the web takes. In the site's editor, pasting Claude's whole
reply keeps only the recipe, the category follows the course and tags, and
Paste photo / Photo link add the photo.

## Publishing (`.github/workflows/`)

`publish.yml`: hourly (and on push to main) downloads the recipes and
`config/aisle.conf` with rclone (service account, read only), runs build.py
and deploys to GitHub Pages. A push to main runs the tests first
(`test.yml`) and only goes live when they pass. The hourly run keeps the
download and the resized photos from the run before (GitHub's cache), so it
only fetches and resizes what changed, and it publishes nothing when the
fingerprint matches the live `version.txt`. Repo variables:
`GDRIVE_FOLDER_ID`, `GOOGLE_CLIENT_ID`, `SITE_TITLE`, `AUTH_URL`; secret:
`GDRIVE_SERVICE_ACCOUNT`.

`test.yml`: on every other branch and pull request (and called by
publish.yml): the type check, the browser tests on the fixture recipes, and
the connector tests.

## The connector (`connector/`)

A Cloudflare Worker (free plan, its own `package.json` with wrangler; the
site itself stays dependency-free). Keeps the site signed in to Google: sign
in once per device, the Worker holds Google's refresh token (encrypted in KV)
and trades the device's pass for one-hour tokens. The site uses it when
`authUrl` is set (repo variable `AUTH_URL`), else the one-hour token flow.

It is also the recipes connector for Claude (MCP at `/mcp`, `src/mcp.js`):
Claude connects with OAuth (an Allow page, then Google; only Jens and
accounts the Drive folder is shared with as editors, only Claude's
addresses) and gets list_folders, find_recipes, read_recipe, save_recipe (in
place, refused when the version changed or the house style fails:
`src/lint.js` ports cooklint and reads its word lists from
`tools/cooklint.py` in Drive), move_recipe and set_photo (`src/photo.js`,
resized by the Images binding). Setup in `connector/README.md`.

## Tests

- `tests/run.mjs`: Playwright tests in a real browser, one file per area
  (`viewer`, `cook`, `editor`, `signin`, `list`, `plan`), sharing
  `tests/lib.mjs`: the checks and an in-memory fake of the Google Drive API.
  It starts its own `dev.py` on a free port with `tests/fixtures/recipes/`,
  and every area starts from a fresh fake Drive, so areas run on their own.
  `--recipes <dir>` runs them on another folder, `--url` against a running
  site. Every page counts Content Security Policy violations as errors.
- `tests/fixtures/recipes/`: a few real recipes, `config/aisle.conf` and a
  copy of `tools/cooklint.py`, shared with the connector tests.
- `connector/test/`: the Worker against a fake Google; uses the synced
  `tools/cooklint.py` when there is one, else the fixture copy.
- `jsconfig.json`: the type check of `app/js` (`tsc -p jsconfig.json`).
  `app/js/types.d.ts` describes the browser extras the site uses.
