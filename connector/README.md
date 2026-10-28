# Recipes Worker

A small Cloudflare Worker (free plan) next to the static site. For now it
keeps the site signed in to Google: sign in once per device and it never runs
out. Later it also becomes the recipes connector for Claude.

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
  committed). `GOOGLE_AUTH_URL` and `GOOGLE_TOKEN_URL` there point it at a
  fake Google for testing.
