# Recipes Worker

A small Cloudflare Worker (free plan) next to the static site. It keeps the
site signed in to Google (sign in once per device and it never runs out), and
it is the recipes connector for Claude: any Claude chat, on the phone or the
laptop, can find, read, save and move recipes in the Drive folder.

How it works is described at the top of `src/index.js`. The site uses it when
`authUrl` is set (repo variable `AUTH_URL`, or `authUrl` in `local.json`);
without it, the site signs in with Google for an hour at a time as before.

## Setup (once)

1. **Cloudflare.** Make a free account at dash.cloudflare.com. Then, in this
   folder:

   ```
   npm install
   npx wrangler login
   npx wrangler deploy
   ```

   The deploy creates the `AUTH` storage and prints the Worker's address,
   `https://recipes-connector.<your subdomain>.workers.dev`.

2. **Google Cloud**, in the project that holds the site's sign-in
   (Google Auth Platform, or APIs & Services):
   - Clients: open the site's web client and add the redirect URI
     `https://recipes-connector.<your subdomain>.workers.dev/auth/callback`.
     Copy its client secret, or add a new one.
   - Audience: set the publishing status to **In production**. In Testing,
     Google ends the sign-in after 7 days. Google shows an "unverified app"
     warning when you sign in; continue past it, it is your own app.

3. **Secrets.** In this folder:

   ```
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   ```

   (paste the client secret), and a random key to encrypt Google's key with:

   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))" | npx wrangler secret put TOKEN_KEY
   ```

   Changing `TOKEN_KEY` later signs every device out.

4. **The site.** Add the repo variable `AUTH_URL` (Settings, Secrets and
   variables, Actions, Variables) with the Worker's address, and the same as
   `"authUrl"` in `local.json`. Then sign in once on each device.

## Connect Claude

In claude.ai: Settings, Connectors, Add custom connector. Name `Recipes`,
URL `https://recipes-connector.recipes-connector.workers.dev/mcp`. Connect:
Allow, then Google. The phone app picks it up from the account.

Tools: `list_folders`, `find_recipes`, `read_recipe`, `save_recipe` (new
recipes and edits in place; refused when the recipe changed since Claude read
it, or when it fails the house style of `tools/cooklint.py`, whose rules
`src/lint.js` ports), `move_recipe` (the photo moves along), `set_photo`
(from a recipe page or image link; `src/photo.js` does what
`scripts/fetch_photo.py` does, with Cloudflare's Images binding for the
resizing, free up to 5,000 a month). No delete.
The connector's instructions tell Claude to use the cooklang-recipe skill.

## Day to day

- Deploy changes: `npx wrangler deploy` in this folder.
- Logs: `npx wrangler tail`.
- Sign out a lost phone: sign out on the site from another device does not
  reach it, so remove its pass:
  `npx wrangler kv key list --binding AUTH --remote` shows the `pass:` keys
  (each with the email and when it was made); delete one with
  `npx wrangler kv key delete --binding AUTH --remote "pass:..."`.
  To sign out everywhere, remove the app in your Google account's
  third-party access page.
- Local run: `npx wrangler dev`, with the secrets in `.dev.vars` (not
  committed). `GOOGLE_AUTH_URL`, `GOOGLE_TOKEN_URL`, `DRIVE_API`,
  `DRIVE_UPLOAD`, `GDRIVE_FOLDER_ID` and `PUBLIC_URL` there point it at a
  fake Google and Drive for testing. Never test against the real folder.
- On Windows, stopping `wrangler dev` from a background task can leave its
  `workerd` processes running on the port; stop the whole process tree.
