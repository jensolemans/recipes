# Recipe site

Jens's Cooklang recipe collection as a website on GitHub Pages
(https://jensolemans.github.io/recipes/). Friends browse read-only; Jens
signs in with Google to edit, which writes straight to the Google Drive
folder "Cooklang Recipes", the only database.

**How each part works is in `docs/ARCHITECTURE.md`.** Read the section for
the part you change; keep it up to date in the same commit.

## Map

- `app/index.html`: the one page. `app/css/`: styles, one file per part.
- `app/js/`: ES modules, no build step, no framework, no runtime
  dependencies. `app.js` boots and routes; each module opens with a comment
  saying what it holds; the table is in `docs/ARCHITECTURE.md`. Editor, cook
  mode, share and the plan view load on first use (`lazy.js`).
- `app/sw.js`: offline copy; build.py fills in its file list.
- `scripts/build.py`: app + Drive folder → published site.
  `scripts/dev.py`: local preview.
- `connector/`: Cloudflare Worker: keeps the site signed in, and is Claude's
  recipes connector (MCP).
- `tests/`: browser tests per area on `tests/fixtures/recipes/`.
- `.github/workflows/`: `test.yml` (branches, PRs), `publish.yml` (tests,
  then hourly build and deploy).
- `ROADMAP.md`: features still to build, in order. `ISSUES.md`: Jens's own
  list of bugs and annoyances.

## Working on it

- While building: make the change and show it in the preview ("Recipe site" in
  the Browser pane, or `python scripts/dev.py`), in one view only. Check with
  page text and the console; take a screenshot only when the change is visual.
  No full screenshot pass and no tests after each change.
- When Jens is happy and wants to commit: one full check on desktop and phone
  width (390 px), light and dark mode, then run the tests, then commit.
- Tests: `node tests/run.mjs` (or one area: `node tests/run.mjs list`). It
  starts its own server on the fixture recipes. Needs `npm i -g playwright`
  once. Type check: `tsc -p jsconfig.json` (needs `npm i -g typescript`).
  Both must pass before every commit; CI runs them too.
- Never write to the real Drive folder while testing; the tests use the fake.
- Connector (`connector/`): run `npm test` there before every
  `npx wrangler deploy`. Deploying changes what Claude sees at once, so do it
  only when the tests pass.
- Tick a `ROADMAP.md` item off in the same commit that ships it.
- `ISSUES.md`: Jens edits it by hand; only change it when asked, or to tick
  off an issue in the commit that fixes it.
- Pushing to `main` publishes the site within about a minute (after the
  tests pass). Do changes on a branch first.
- A new file in `app/` is picked up offline by itself. A new module that is
  not a lazy view is imported by whatever uses it.
- If you change the inline theme script in `index.html`, update its hash in
  the Content Security Policy above it.

## Conventions

- Recipes: metric units, YAML frontmatter with title, description, author,
  source, course, cuisine, diet, difficulty, servings, time, prep time,
  cook time, tags (yield optional). File names are snake_case.
- Interface text: plain English, sentence case, short. No em dashes anywhere
  (UI copy, docs, commit messages).
- Design: minimal and neutral, white and black (#FAFAFA / #0E0E0E pages).
  The Cooklang orange (#E77B54) is used sparingly, only where an accent helps:
  the full-height ingredient highlighter in method steps, the current folder in the folder panel, focus
  rings and a finished timer. Running timers stay black, white and grey: a grey pill with a clock in
  the method, whose clock becomes a ring that empties while it runs. Buttons and selected chips are
  black (white in dark). Keep it that way unless asked; colours are CSS variables in
  `app/css/base.css`. The top bar toggle switches light and dark; it starts from
  the device setting (dark when there is none) and a pick is saved per device.
- Keep the site dependency-free and static so it stays free to host.
