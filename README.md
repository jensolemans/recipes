# Recipes site

Publishes the Cooklang recipes from the Google Drive folder **Cooklang Recipes** as a read-only website on GitHub Pages.

Every night the workflow downloads the recipes from Drive, runs `cook build web` and publishes the result. Keep adding and editing recipes in Drive as usual; the site follows by itself.

Want a change online right away? GitHub → this repo → **Actions** → **Publish recipes** → **Run workflow**. This also works from the GitHub mobile app.

Only `.cook`, `.menu`, image files and the `config` folder are downloaded. The zip and the `tools` folder stay private.

## One-time setup (about 15 minutes)

### 1. Google: give the workflow read access to the recipe folder

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a new project, e.g. `recipes-site`.
2. In that project, open **APIs & Services → Library**, search for **Google Drive API** and click **Enable**.
3. Open **IAM & Admin → Service Accounts → Create service account**. Name it `recipes-reader`. Skip the optional role and access steps.
4. Click the new service account → **Keys** → **Add key → Create new key → JSON**. A `.json` file downloads. Treat it like a password.
5. Copy the service account's email address (looks like `recipes-reader@recipes-site.iam.gserviceaccount.com`).
6. In Google Drive, right-click **Cooklang Recipes** → **Share**, paste that email, set it to **Viewer**, untick "Notify people", and share.
7. Open the **Cooklang Recipes** folder in your browser and copy the folder ID from the address bar: the part after `/folders/`.

The service account can only see this one folder, read-only.

### 2. GitHub: create the repo

1. Create a new **public** repository, e.g. `recipes` (free GitHub Pages needs a public repo; the recipes themselves are not stored in it).
2. **Add file → Create new file**, name it `.github/workflows/publish.yml`, paste the contents of `publish.yml` and commit. Do the same for this README if you like.
3. **Settings → Secrets and variables → Actions**:
   - **Secrets** tab → **New repository secret**: name `GDRIVE_SERVICE_ACCOUNT`, value: the entire contents of the downloaded `.json` file.
   - **Variables** tab → **New repository variable**: name `GDRIVE_FOLDER_ID`, value: the folder ID from step 1.7.
4. **Settings → Pages → Build and deployment → Source: GitHub Actions**.
5. **Actions → Publish recipes → Run workflow**. After 1 to 2 minutes the site is live at `https://<your-username>.github.io/recipes/`.

Share that link with your friends. Delete the downloaded `.json` file from your computer once the secret is saved.

## Good to know

- **Cost:** free. GitHub Actions minutes are unlimited for public repos, and the site (about 35 MB) is far below the 1 GB Pages limit.
- **The site is public:** anyone with the link can view it. It is not listed anywhere, but search engines may find it eventually.
- **Not on the site:** recipe scaling, shopping list and pantry. Those still work in the Cooklang app on your phone.
- **Nightly run paused?** GitHub pauses scheduled runs in repos without commits for 60 days. The `keepalive` job re-enables it every night, so this should not happen. If it does, GitHub sends an email and one click on **Enable workflow** fixes it.
- **A run failed?** GitHub emails you. The most common cause is a changed folder share or a deleted service account key.
