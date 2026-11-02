---
name: import-recipe
description: Import a recipe into Jens's collection from a web address, pasted text or a photo of a cookbook page. Converts it with the cooklang-recipe skill, saves it in the right folder through the recipes connector, adds the dish photo and gives the link. Use when Jens says import, add or save a recipe, or pastes a recipe link.
argument-hint: <recipe link, pasted recipe, or photo>
---

# Import a recipe

Turn one recipe into a finished entry in the collection: a `.cook` file in the
right folder of the Google Drive folder, with its photo next to it. It goes
through the recipes connector, the same way Claude on the phone or the web
imports a recipe, so there is one way in: the connector checks the house
style, picks up the photo and the site, the Cooklang app and the synced
folder all see the result.

The input is in the arguments: a web address, pasted recipe text, or an
attached photo of a cookbook page. If there is nothing, ask for it. If there
are several recipes, do them one by one with this whole procedure.

## 1. The connector

Use the recipes connector's tools: `list_folders`, `find_recipes`,
`read_recipe`, `save_recipe`, `set_photo`. Follow its own instructions
(how to name files, what to do when a name is taken, photos). If its tools
are not available in this session, stop and tell Jens to connect the
recipes connector (setup in `connector/README.md`); do not write into the
synced folder by hand.

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

## 4. Choose the folder

`list_folders` gives the folders and which folder each course goes to. If
that folder has subfolders, pick the one that fits best by the recipes
already in it (`find_recipes` helps): a chicken curry goes to `Curry`, a
vegetarian traybake to `Vegetarian`. When two fit equally well or none fits,
ask Jens with the options instead of guessing. If the same recipe clearly
exists already, stop and ask: replace it, keep both under another name, or
skip.

## 5. Save it and add the photo

Save with `save_recipe`. When it refuses the recipe with house-style
problems, fix them and save again. Then add the photo with `set_photo` and
the web address. Without a web address (pasted text, cookbook photo), or
when the site blocks the download, give Jens the "Add photo" link that
`save_recipe` returned.

## 6. Report

Keep it short:

- Title and where it was saved (folder and file name), and whether the photo
  was added.
- The link `save_recipe` gave. Signed in, the live site shows it at once;
  friends see it after the next hourly update.
- The skill's summary of conversion decisions.
- Any warnings left, and any choice Jens may want to change (folder,
  servings, a substitution).

Recipes live in Google Drive, not in this git repository: do not commit
anything.
