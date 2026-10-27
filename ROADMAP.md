# Roadmap

What the site still needs to be on par with the best recipe apps: Paprika 3,
Mealie, the Cooklang app, Samsung Food, ReciMe, Mela, Crouton and NYT Cooking.

Tick an item off in the same commit that ships it. Items are in the order to
build them. Anything that needs a server must be free to run and easy to
maintain (a Cloudflare Worker is the default choice).

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
- [ ] **Notes, rating and cook log.** Stars, "cooked on" dates and personal
  notes per recipe, for Jens only. Adds sorting by most cooked and by not
  made in a while. *Paprika, Mealie, NYT Cooking, Mela.* Stored in Drive as
  `config/recipe_notes.json`, keyed by recipe path, moved along when a
  recipe is moved.

## Then

The planning features, built the same way as the shopping list.

- [ ] **Meal planner.** A week view to put recipes (with a scale) on days, plus
  free text like "eating out". "Add this week to the shopping list" in one go.
  *Paprika, Mealie, Samsung Food, ReciMe, Mela, Crouton.* Stored in Drive as
  `config/meal_plan.json` with the same offline queue as the shopping list.
- [ ] **Favourites and collections.** Hand-picked, ordered lists across
  folders, like "Weeknight", "Christmas" or "To try". Shown as a filter on
  the home page. *NYT Cooking (recipe box), Mealie and Paprika (cookbooks).*
  Stored in Drive as `config/collections.json`; public collections go into
  `recipes.json` at build time so friends see them too.
- [ ] **Search by ingredient.** "What can I make with leek and feta", with
  "without" for things to leave out. *Mealie, Samsung Food, Paprika.* The
  parsed recipes already list their ingredients.
- [ ] **What to cook tonight.** A random pick within the current filters, or
  from recipes not cooked in a while (uses the cook log).
  *Paprika, Mela, Samsung Food.*

## After that

Importing without the laptop. Needs one small free server-side helper.

- [ ] **Import from a link in the browser.** Paste a URL in the editor and get
  a draft recipe. Read the schema.org Recipe data from the page through a
  Cloudflare Worker (browsers block reading other sites directly), then
  convert to Cooklang. *Every app listed above.*
- [ ] **Import from social media.** Instagram and TikTok links, from the
  caption or description. *ReciMe, Samsung Food.*
- [ ] **Import from a photo or PDF in the browser.** A cookbook page photo
  becomes a draft recipe, as `/import-recipe` does on the laptop.
  *Mela, Crouton, ReciMe.*
- [ ] **Share to the app.** Share a link from the phone's share sheet straight
  into the editor (Web Share Target in the manifest). *Mela, Crouton, ReciMe.*

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
