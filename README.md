# Recipes site

A recipe website built on the Cooklang files in the Google Drive folder **Cooklang Recipes**.

- **Friends** browse, search, filter and scale every recipe. No account needed, read only.
- **You** sign in with Google to add, edit, move, rename and delete recipes and photos. Changes are written straight to the Drive folder, so the Cooklang app and your desktop folders stay in sync.
- **Free**: GitHub Pages hosting, GitHub Actions for the hourly rebuild, and Google's free APIs.

## How it works

| Who | Sees | Updated |
|---|---|---|
| Friends | A snapshot of the Drive folder | Every hour, or right away with **Actions → Publish recipes → Run workflow** |
| You, signed in | The live Drive folder | Instantly |

There is no server. Editing happens in your browser with your own Google sign-in, so only Google accounts that can edit the Drive folder can change anything. Anyone else who signs in stays read only.

Deleting moves the recipe and its photo to the Google Drive trash, so you can restore them for 30 days. If a recipe was changed elsewhere (in the Cooklang app, say) while you were editing it, the site warns you before overwriting.

## Files

```
app/                     the website (HTML, CSS, JavaScript)
app/vendor/cooklang/     official Cooklang parser (@cooklang/cooklang 0.19.1, MIT)
app/fonts/               Bricolage Grotesque and Newsreader (SIL Open Font License)
scripts/build.py         turns the Drive download into the site's data and photos
scripts/dev.py           local preview at http://localhost:8000 from your synced Drive folder
tests/e2e.mjs            browser tests, run against a fake Google Drive
CLAUDE.md                project notes for Claude Code
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
- **Categories** are your Drive folders. To add a category, create the folder in Drive and reload the site while signed in.
- **Scaling** uses the official Cooklang rules: amounts marked fixed, like `@salt{=1%tsp}`, never change. Units stay as you wrote them.
- **Local preview**: `python scripts/dev.py`, then open http://localhost:8000. The first run creates `local.json`; check that `recipesDir` points to your synced recipe folder.
- **Tests**: see `tests/README.md`.
