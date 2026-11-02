Browser tests, one file per area, on the recipes in `fixtures/recipes/` and
an in-memory fake of Google Drive (nothing reaches the real one).

Once:

    npm i -g playwright typescript
    npx playwright install chromium

Then, from the repo root:

    node tests/run.mjs                 every area
    node tests/run.mjs list plan       only these areas
    node tests/run.mjs --recipes "C:/Users/<you>/My Drive/Cooklang Recipes"
                                       on your own collection
    tsc -p jsconfig.json               the type check

`run.mjs` starts its own local server on a free port. Areas: `viewer`,
`cook`, `editor`, `signin`, `list`, `plan`. Set `SHOT_DIR` to a folder to
also save screenshots.
