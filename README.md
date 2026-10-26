# Jens's Recipes

**[jensolemans.github.io/recipes](https://jensolemans.github.io/recipes/)**

This is my own recipe web app. It is where I keep every recipe I cook, how I plan the week's shopping, and what sits on my phone next to the stove. It is a website anyone can open, and an app I can install on my phone and use without a connection.

The whole thing was vibe coded with [Claude Code](https://claude.com/claude-code): I described what I wanted, Claude wrote the code, and I used it in my kitchen and asked for changes until it felt right.

## What it does

- **Keep** all my recipes in one place, as plain [Cooklang](https://cooklang.org) files in a Google Drive folder. That folder is the only database: the Cooklang phone app, my laptop and this site all read and write the same files.
- **Share** them. Friends can browse, search and filter by category, course, cuisine, diet and time, without an account.
- **Cook** from them. Scale any recipe to the number of servings you need, see each step with its ingredients highlighted, and start timers straight from the method.
- **Edit** them. Signed in with Google, I add, edit, move, rename and delete recipes and photos right on the site, from any device. Changes land in Drive straight away.
- **Shop** for them. Add recipes (scaled, or just some parts of them) to a shopping list. It merges the ingredients, sorts them in the order of my store's aisles, sets aside what I probably have in the pantry, and syncs between my phone and laptop, also when I tick things off offline.
- **Import** them. With the `/import-recipe` command in Claude Code, I give Claude a link, some pasted text or a photo of a cookbook page, and it becomes a clean Cooklang recipe with a photo in the right folder. Or I paste Claude's reply into the site's editor.

## How it is built

- **No framework, no npm packages, no server.** Plain HTML, CSS and JavaScript, with the official Cooklang parser running in the browser.
- **Free to run.** GitHub Pages hosts it, a GitHub Action rebuilds it every hour from Drive, and editing uses Google's free APIs with my own sign-in in the browser.

## Who sees what

| Who | Sees | Updated |
|---|---|---|
| Friends | A snapshot of the Drive folder | Every hour, or right away with **Actions → Publish recipes → Run workflow** |
| Me, signed in | The live Drive folder | Instantly |

There is no server. Editing happens in the browser with my own Google sign-in, so only Google accounts that can edit the Drive folder can change anything. Anyone else who signs in stays read only.

Deleting moves the recipe and its photo to the Google Drive trash, so you can restore them for 30 days. If a recipe was changed elsewhere (in the Cooklang app, say) while you were editing it, the site warns you before overwriting.

## Files

```
app/                     the website (HTML, CSS, JavaScript)
app/shopping.js          the shopping list
app/sw.js                offline support and the installable app
app/vendor/cooklang/     official Cooklang parser (@cooklang/cooklang 0.19.1, MIT)
app/fonts/               Bricolage Grotesque and Newsreader (SIL Open Font License)
scripts/build.py         turns the Drive download into the site's data and photos
scripts/dev.py           local preview at http://localhost:8000 from your synced Drive folder
tests/e2e.mjs            browser tests, run against a fake Google Drive
CLAUDE.md                project notes for Claude Code
.claude/skills/import-recipe/   the /import-recipe command
.claude/launch.json      lets the Claude desktop app start the preview
.github/workflows/publish.yml   hourly download, build and publish
```

## One-time setup

The build already has read access to Drive through the `GDRIVE_SERVICE_ACCOUNT` secret and the `GDRIVE_FOLDER_ID` variable. Editing needs one more thing: a Google sign-in client for the website.

### 1. Create the Google sign-in client

In [console.cloud.google.com](https://console.cloud.google.com), open the same project you made for the service account.

1. Go to **APIs & Services → OAuth consent screen** (it may be called **Google Auth Platform**) and click **Get started**.
   - App name: `Recipes`. User support email: your Gmail.
   - Audience: **External**.
   - Contact email: your Gmail. Agree and click **Create**.
2. Open **Audience**. Under **Test users**, click **Add users** and add your own Gmail address. Leave the app in **Testing**: that keeps it private to you, and no Google review is needed.
3. Open **Data access** → **Add or remove scopes**, tick `.../auth/drive` (See, edit, create and delete all of your Google Drive files) and click **Update**, then **Save**.
4. Open **Clients** → **Create client**:
   - Application type: **Web application**. Name: `Recipes site`.
   - **Authorized JavaScript origins** → **Add URI**: `https://jensolemans.github.io`
   - Click **Create** and copy the **Client ID** (ends in `.apps.googleusercontent.com`). It is not a secret.

### 2. Add it to GitHub

In the repo: **Settings → Secrets and variables → Actions → Variables** tab:

| Name | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | the Client ID from step 1.4 |
| `SITE_TITLE` | the name shown at the top, e.g. `Jens's Recipes` (optional) |

For signing in on the local preview too, add `http://localhost:8000` as a second **Authorized JavaScript origin** in step 1.4, and put the Client ID and folder ID in `local.json`.

Then **Actions → Publish recipes → Run workflow**.

### 3. First sign-in

Open the site and click **Sign in** (top right). Google shows "Google hasn't verified this app": that is expected for your own app in Testing. Click **Continue**, allow access to Google Drive, and you are in. Next time it is one click.

## Good to know

- **Sign-in lasts an hour**, also after closing the tab. When it runs out, tap **Renew sign-in** at the top (or just **Save**): Google's window flashes and closes, and you stay on the page with your changes. Google gives browser-only sites one-hour sign-ins; staying signed in longer would need a small server.
- **Photos** you add on the site are resized to 1600 px and saved as `<file name>.jpg` next to the recipe in Drive.
- **Categories** are your Drive folders: top-level folders are the tabs, subfolders the chips below them. To add a category, create the folder in Drive and reload the site while signed in. Folders named `config` or `tools`, and anything starting with a dot, are hidden.
- **Moving or renaming a recipe**: on the site, the photo moves along. In Drive or the Cooklang app, move or rename the photo yourself (same file name next to the `.cook` file). Either way, other recipes that link to it with `@./path/to/recipe{}` need their link fixed, and old shared web addresses stop working, because both follow the file's path.
- **Light and dark**: the button next to **Sign in** switches between Auto (follows the device), Light and Dark, remembered per device.
- **Scaling** uses the official Cooklang rules: amounts marked fixed, like `@salt{=1%tsp}`, never change. Units stay as you wrote them.
- **Local preview**: `python scripts/dev.py`, then open http://localhost:8000. The first run creates `local.json`; check that `recipesDir` points to your synced recipe folder.
- **Shopping list**: lives in Drive as `config/shopping_list.json`. Store order and spellings come from `config/aisle.conf`, the "Probably have" list from `config/pantry.conf`.
- **On your phone**: open the site and choose **Add to Home screen**. It opens without a connection and updates itself when a new version is out.
- **Tests**: see `tests/README.md`.
