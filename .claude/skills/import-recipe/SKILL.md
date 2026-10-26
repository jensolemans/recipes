---
name: import-recipe
description: Import a recipe into Jens's collection from a web address, pasted text or a photo of a cookbook page. Converts it with the cooklang-recipe skill, saves the .cook file in the right category of the synced Google Drive folder, adds the dish photo, lints it and gives the link. Use when Jens says import, add or save a recipe, or pastes a recipe link.
argument-hint: <recipe link, pasted recipe, or photo>
---

# Import a recipe

Turn one recipe into a finished entry in the collection: a `.cook` file in the
right folder of the synced Google Drive folder, with its photo next to it.
Google Drive for desktop uploads it within seconds, so the website and the
Cooklang app see it without anything else to do.

The input is in the arguments: a web address, pasted recipe text, or an
attached photo of a cookbook page. If there is nothing, ask for it. If there
are several recipes, do them one by one with this whole procedure.

## 1. Where things are

- Read `local.json` in the repo root. `recipesDir` is the synced
  "Cooklang Recipes" folder. Everything below is relative to it.
- `tools/cooklint.py` in that folder is the house-style checker.
  `FOLDER_FOR_COURSE` near its top maps each course to its folder.
- List the existing folders (skip `config` and `tools`) to see the
  subfolders, for example `3 Mains/Curry`, `3 Mains/Vegetarian`.

## 2. Read the recipe

- Web address: fetch the page and work from its full recipe: ingredients,
  method, servings, times, author, notes. Keep the address for `source`.
- Pasted text: use it as it is.
- Photo of a cookbook page: read it. This photo is not the dish photo.

## 3. Convert it with the cooklang-recipe skill

Invoke the `cooklang-recipe` skill (it may be listed as
`anthropic-skills:cooklang-recipe`) with the recipe and follow it completely.
It holds all of Jens's preferences: metric units, frontmatter fields and
vocabularies, naming, tags and how steps are written. Do not restate or
override its rules here. Keep its summary of conversion decisions for the
report at the end.

## 4. Choose the folder and file name

- Folder: start from `FOLDER_FOR_COURSE` for the recipe's `course`. If that
  folder has subfolders, pick the one that fits best by looking at the
  recipes already in each (a chicken curry goes to `3 Mains/Curry`, a
  vegetarian traybake to `3 Mains/Vegetarian`). When two fit equally well or
  none fits, ask Jens with the options instead of guessing.
- File name: the title in snake_case, the way the skill names files (for
  example `swedish_meatballs.cook`).
- If a recipe with that name is already in that folder, or the same recipe
  clearly exists elsewhere in the collection, stop and ask: replace it, keep
  both under another name, or skip.

## 5. Save it

Write the `.cook` file in UTF-8. Only create this one recipe and its photo:
never change or move other recipes.

## 6. Add the dish photo

From the repo root run:

```
python scripts/fetch_photo.py "<web address>" "<recipesDir>/<folder>/<file name>.jpg"
```

It finds the recipe's main photo on the page (or takes a direct image link),
picks the largest version and saves it as a JPEG of at most 1600 px and
under 1 MB, which is the house format.

If it fails, the site blocks downloads, or there was no web address (pasted
text, cookbook photo), skip the photo and say so in the report: Jens can
paste one in the site's editor with Paste photo.

## 7. Check it

Run the checker on the new file:

```
python "<recipesDir>/tools/cooklint.py" "<recipesDir>/<folder>/<file name>.cook"
```

Fix every ERROR in the file and run it again. Fix warnings when the fix is
clear from the source; report the rest.

## 8. Report

Keep it short:

- Title and where it was saved (folder and file name), and whether the photo
  was added.
- Links: the local preview `http://localhost:8000/#/r/<path>` and the live
  site `https://jensolemans.github.io/recipes/#/r/<path>`, with `<path>` the
  folder and file name without `.cook`, each part URL-encoded. Signed in, the
  live site shows it as soon as Google Drive has synced; friends see it
  after the next hourly update.
- The skill's summary of conversion decisions.
- Any lint warnings left, and any choice Jens may want to change (folder,
  servings, a substitution).

Recipes live in Google Drive, not in this git repository: do not commit
anything.
