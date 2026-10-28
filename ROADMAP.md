# Roadmap

What the site still needs to be on par with the best recipe apps: Paprika 3,
Mealie, the Cooklang app, Samsung Food, ReciMe, Mela, Crouton and NYT Cooking.

Tick an item off in the same commit that ships it. Items are in the order to
build them. Anything that needs a server must be free to run and easy to
maintain (a Cloudflare Worker is the default choice).

## Now: recipes with Claude

Every recipe goes through Claude with Jens's `cooklang-recipe` skill, which
holds his style and preferences. Today that means copying between the Claude
chat and the editor for every import and every edit. The goal: Claude reads
and saves the recipes itself, from any chat on the phone or the laptop.

How it will work:
- **Import.** Share a recipe page to the Claude app (or attach a cookbook
  photo) and say "import". Claude writes it with the skill, picks the folder
  from the course, saves it, adds the dish photo and replies with the link.
- **Edit.** "Edit with Claude" on a recipe opens Claude with the recipe's path
  typed in. Say what to change; Claude reads the file, rewrites it in Jens's
  style and saves it in place.
- **After cooking.** "I made the dal, too salty, do the tempering first."
  Claude finds the recipe itself.
- **By hand** stays possible: the current editor becomes "Edit by hand" for
  typos and photos from the camera roll.

Built as a recipes connector (MCP server) for Claude on the same free
Cloudflare Worker that keeps the site signed in (`connector/`). Claude's
built-in Google Drive connector was tried first: it can find, read and create
files, but it cannot change a file's text (an edit would leave two files with
the same name) and it cannot save photos.

- [x] **Stay signed in.** Sign in once per device; the Worker keeps Google's
  long-lasting key, encrypted, and hands out one-hour keys. Google app set to
  In production (unverified, no logo, so no review needed).
- [x] **Connector, reading.** Claude signs in with Google once (only Jens's
  account). Tools: `list_folders` (folder tree and course to folder),
  `find_recipes` (title, tag, text), `read_recipe` (text, has a photo, site
  link). The connector's instructions tell Claude to always use the
  `cooklang-recipe` skill, so any chat works without a Project.
- [x] **Connector, saving.** `save_recipe` for new recipes and edits in place
  (same file, so Drive keeps its version history), refused when the file
  changed since Claude read it, checked first with the `cooklint` rules
  (ported to JavaScript, word lists read from `tools/cooklint.py`). `move_recipe` moves the photo along. No delete:
  that stays in the app.
- [x] **Connector, photos.** `set_photo` from a recipe page (its recipe
  data, then og:image) or an image link, saved as `<same name>.jpg`, at most
  1600 px and under 1 MB, like `scripts/fetch_photo.py`. Resized by
  Cloudflare's Images binding (free up to 5,000 a month), since the Worker
  has too little CPU time. Photos attached in the chat cannot reach the
  connector: Claude gives the "Add photo" link to the site's editor.
- [x] **Claude buttons in the app.** New and Edit open Claude
  (`claude.ai/new?q=...`) with the request typed in: the folder you are in, or
  the recipe's path. The recipe page keeps Cook, Add to list and Edit; Share,
  Print, Change photo and Edit file sit behind ⋯. New blank recipe is in the
  account menu. Offline or with the connector down, New and Edit open the
  editor, which keeps a draft on the device. Claude warns about prefilled
  prompts from links; kept for now (copy and open an empty chat avoids it).
- [ ] **Share to the app.** Share a link from the phone's share sheet straight
  into the app (Web Share Target in the manifest), for links that should go
  in by hand. *Mela, Crouton, ReciMe.*
- [ ] **Recipes without a photo.** A filter or badge, so every recipe gets
  one.
- [x] **Connector tests.** `npm test` in `connector/`, against a fake Google,
  Drive and recipe website.
- [ ] **Deploy from GitHub.** Deploy the Worker from GitHub Actions when
  `connector/` changes on main (needs a Cloudflare API token as a secret).
  Only needed once the connector is changed from somewhere else than the
  laptop.

Covers what used to be planned here as import from a link, from social media
and from a photo in the browser: Claude reads those itself.

## Next

Mostly front end, quick wins, used every week.

- [x] **Cook mode.** Full screen, one step at a time, large text, with that
  step's ingredients and timers shown alongside. Swipe or tap to move on.
  Keeps the screen on by itself. *Crouton, Mela, Samsung Food, Cooklang.*
  Steps already know their ingredients, so this is mainly a new view.
- [x] **Share and print.** A share button between print and edit. On phones a
  menu: share link, copy ingredients (plain text bullets), share the whole
  recipe as plain text, each through the system share sheet. On bigger
  screens a card with the same options and a QR code to open the recipe on
  any phone. Links and text keep the current scale. Plus a print layout:
  one page, no top bar or side panel, ingredients beside the method, at the
  current scale. *Paprika, Mela, Mealie, NYT Cooking.*

## Then

The planning features, built the same way as the shopping list.

- [ ] **Meal planner.** For meal prep weeks: pick recipes first, put them on
  days after. *Mealime, Plan to Eat, Paprika, Samsung Food.*
  - **Unplanned.** "Add to plan" on every recipe puts it in Unplanned, a
    list without dates. A recipe leaves Unplanned once it is put on a day.
  - **Menu.** Has a start and end date (native date inputs, 1 and 2 week
    shortcuts). Days go down, Breakfast, Lunch, Dinner and Snacks across.
    One servings number scales the whole menu. Old menus are kept; a
    switcher opens the one that covers today.
  - **Plan page** (`#/plan`), in the top bar and as a phone tab. Desktop:
    the normal recipe list on the left, the calendar on the right with
    Unplanned as a tray. Drag from the tray or straight from the recipe
    list into a slot, and between slots. Phone: the calendar with the tray
    at the bottom; tap a tray recipe to pick it up, then tap slots to place
    it.
  - **Slots** hold recipes and ingredients (a + per slot, like "apples 4"),
    no notes. Clicking a recipe opens it.
  - **Add to shopping list** sends the menu into the existing list.
  - **Storage.** Each menu is a Cooklang `.menu` file in Drive
    (`Plans/2026-11-02.menu`, days as `== 2026-11-02 ==`), Unplanned is
    `config/unplanned.json`, both with the shopping list's offline queue.
    Check the `.menu` syntax against cooklang.org first, and keep build.py
    from reading `.menu` files as recipes.
- [ ] **Favourites and collections.** Hand-picked, ordered lists across
  folders, like "Weeknight", "Christmas" or "To try". Shown as a filter on
  the home page. *NYT Cooking (recipe box), Mealie and Paprika (cookbooks).*
  Stored in Drive as `config/collections.json`; public collections go into
  `recipes.json` at build time so friends see them too.
- [ ] **Search by ingredient.** "What can I make with leek and feta", with
  "without" for things to leave out. *Mealie, Samsung Food, Paprika.* The
  parsed recipes already list their ingredients.
- [ ] **What to cook tonight.** A random pick within the current filters.
  *Paprika, Mela, Samsung Food.*

## Later

Useful, but lower priority.

- [ ] **Nutrition per serving.** Calories, protein, carbs and fat. Simplest:
  have Claude add it to the frontmatter at import time and show it.
  *Samsung Food, ReciMe, Mealie.*
- [ ] **Unit conversion on request.** A toggle for imported recipes in cups or
  °F. Units stay as written by default. *Paprika, Crouton.* The Cooklang
  parser can already convert.
- [ ] **Pantry stock.** What is actually in the house, used to skip shopping
  list items and for "what can I make now". *Samsung Food, Paprika.*
- [ ] **Shopping list extras.** Lists per store, adding items by voice, and
  sharing the list with someone else in the house. *Paprika, Samsung Food.*
- [ ] **Photos in steps and more than one photo per recipe.**
  *Mela, Mealie, Crouton.*
- [ ] **Scale to what you have.** "I have 600 g chicken" scales the whole
  recipe to match. *Crouton, Paprika.*
- [ ] **Timers that survive.** Keep running across pages and restarts, with a
  notification when done.
- [ ] **Serve with.** Link a recipe to sides, sauces or dessert, and show a
  "make ahead" part.
- [ ] **Hands-free.** "Next step" and "start timer" by voice in cook mode.
  *Crouton, Samsung Food.*
- [ ] **Export.** All recipes as a zip, or a printable PDF cookbook.
  *Mealie, Paprika.*
- [ ] **Easier sharing with friends.** Send a recipe so it lands well on the
  other side: the `.cook` file with its photo (two files through the share
  sheet on phones, a zip on bigger screens) for friends who use Cooklang,
  and link previews that show the recipe's photo and title in chats (needs
  a small page per recipe from build.py, since `#/r/...` never reaches the
  server). Needs more groundwork first: how a friend gets the files into
  their own app.
- [ ] **Friends' favourites and notes.** Friends keep their own favourites in
  their browser, without editing rights. *NYT Cooking, Samsung Food.*
- [ ] **"I made this" notes from friends.** Comments on recipes, which needs a
  free backend. *NYT Cooking.*
- [ ] **In season.** Suggest recipes that fit the current season.
- [ ] **Recipe helper.** "Make this vegetarian" or "what can I use instead of
  crème fraîche", with Claude behind a small backend.
  *Samsung Food, ReciMe.*
- [ ] **Cost per serving and drink pairing.** *Paprika, Samsung Food.*

## Already done

- [x] Search, folder browsing, filters and sort
- [x] Scaling that respects fixed quantities
- [x] Step timers with sound and notification
- [x] Tick off ingredients and equipment while cooking
- [x] Recipe references (recipes inside recipes)
- [x] Shopping list from recipes and parts, sorted by aisle, with pantry
  items, offline changes and sync between devices
- [x] Installable app that works offline
- [x] Dish photos, light and dark mode
- [x] Editor with live preview, lint, and paste from Claude
- [x] Import from a link, text or photo through `/import-recipe` on the laptop
