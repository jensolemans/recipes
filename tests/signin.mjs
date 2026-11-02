// Signing in: the one-hour Google sign-in that renews in place, and signed
// in for good through the recipes Worker (with Ask Claude for New and Edit).
import fs from 'fs';
import path from 'path';
import { t, ok, until2, untilOn, watch, newPage, signedIn, files, byName, driveRoute, fakeGis, fakeConfig, recipesJson, hashPath, PNG } from './lib.mjs';

export default async function () {
  const { BASE, RECIPES, browser } = t;
  const crepesFolder = byName('ROOT', '01 Breakfast').id;

  // 6. sign-in survives closing the tab, and renews in place when the hour ends
  {
    const ctx = await signedIn({ viewport: { width: 390, height: 844 } }, { once: true });
    const first = await ctx.newPage();
    await first.goto(`${BASE}/#/`);
    await first.waitForSelector('a[href="#/new"]', { timeout: 15000 });
    await first.close();

    const page = await ctx.newPage();
    watch(page);
    await page.goto(`${BASE}/#/edit/01%20Breakfast/crepes`);
    await page.waitForSelector('#src', { timeout: 15000 });
    ok(await page.isVisible('a[href="#/new"]'), 'sign-in survives closing the tab');

    // Let the hour run out while editing.
    await page.fill('#src', (await page.inputValue('#src')) + '\n> Saved after renewing\n');
    const expire = () => page.evaluate(async () => {
      const d = await import(new URL('js/drive.js', location.href).href);
      d.user().expires = Date.now() - 1;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expire();
    await page.waitForSelector('#signin:has-text("Renew sign-in")');
    ok((await page.textContent('#toast')).includes('changes are kept'), 'says the sign-in ran out and the changes are kept');
    ok((await page.inputValue('#src')).includes('Saved after renewing'), 'editor stays open with the changes');

    await page.click('#save');
    await page.waitForSelector('.recipe', { timeout: 8000 });
    ok(await page.evaluate(() => window.__gis.calls) === 1, 'Save renews the sign-in with one Google window');
    ok(await page.evaluate(() => window.__gis.prompt) === '', 'renewal skips the account picker');
    ok(byName(crepesFolder, 'crepes.cook').content.toString().includes('Saved after renewing'), 'save after renewing reaches Drive');

    await expire();
    await page.click('#signin:has-text("Renew sign-in")');
    await page.waitForSelector('summary.avatar');
    ok(page.url().includes('#/r/'), 'Renew sign-in keeps you on the same page');
    await ctx.close();
  }

  // 10. signed in for good through the recipes Worker
  {
    const AUTH = 'https://auth.test';
    const worker = { tokens: 0, redeems: 0, signouts: 0, pass: 'p'.repeat(43) };
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    await ctx.route('https://www.googleapis.com/**', driveRoute);
    await ctx.route('https://accounts.google.com/gsi/client', fakeGis);
    await ctx.route('**/data/recipes.json', async (route) => {
      const res = await route.fetch();
      const data = await res.json();
      data.config = { ...data.config, folderId: 'ROOT', clientId: 'test-client', authUrl: AUTH };
      return route.fulfill({ response: res, json: data });
    });
    await ctx.route(`${AUTH}/**`, (route) => {
      const p = new URL(route.request().url()).pathname;
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });
      if (p === '/auth/start') return route.fulfill({ contentType: 'text/html', body: '<h1>Signed in</h1>' });
      // The first ask comes before Google is done.
      if (p === '/auth/redeem') return ++worker.redeems < 2 ? json({ waiting: true }, 202) : json({ pass: worker.pass, email: 'jens@example.com', name: 'Jens Olemans' });
      if (p === '/auth/token') return json({ access_token: `w${++worker.tokens}`, expires_in: 3600, email: 'jens@example.com', name: 'Jens Olemans' });
      if (p === '/auth/signout') { worker.signouts++; return json({ ok: true }); }
      return route.fulfill({ status: 404 });
    });
    const page = await ctx.newPage();
    watch(page);
    await page.goto(`${BASE}/#/`);
    await page.waitForSelector('#signin');
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.click('#signin')]);
    ok(popup.url().startsWith(`${AUTH}/auth/start?login=`), 'sign-in opens the Worker in a new window');
    await page.waitForSelector('.btn-new', { timeout: 10000 });
    ok(await page.evaluate(() => localStorage.getItem('recipes.pass')) === worker.pass, 'signed in through the Worker, pass kept on this device');
    ok(worker.tokens === 1, 'one token after sign-in');

    // The hour runs out while the page is closed: it comes back signed in, no window.
    await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('recipes.session'));
      localStorage.setItem('recipes.session', JSON.stringify({ ...s, expires: Date.now() - 1000 }));
    });
    await page.reload();
    await page.waitForSelector('.btn-new', { timeout: 10000 });
    ok(worker.tokens === 2 && !(await page.$('#signin')), 'an hour later it renews quietly, no Renew sign-in');

    // With the connector, New and Edit ask how: Claude with the request typed in, or the editor.
    await page.click('.btn-new');
    await page.waitForSelector('#choose[open]');
    const newHref = await page.getAttribute('#choose [data-pick="claude"]', 'href');
    ok(newHref.startsWith('https://claude.ai/new?q=') && await page.getAttribute('#choose [data-pick="claude"]', 'target') === '_blank', 'New offers Claude in a new tab');
    ok(await page.$('#choose a[href="#/new"]'), 'New offers a blank recipe in the editor');
    await page.keyboard.press('Escape');
    await page.click('a.card');
    await page.waitForSelector('#edit-btn');
    const recipePath = decodeURIComponent(await page.evaluate(() => location.hash)).replace(/^#\/r\//, '').replace(/\?.*$/, '');
    await page.click('#edit-btn');
    await page.waitForSelector('#choose[open]');
    ok(decodeURIComponent(await page.getAttribute('#choose [data-pick="claude"]', 'href')) === `https://claude.ai/new?q=Change my recipe ${recipePath}.cook: `, 'Edit offers Claude with the recipe path');
    await page.keyboard.press('Escape');
    ok(decodeURIComponent(await page.getAttribute('.cooked a', 'href')).includes(`I just cooked my recipe ${recipePath}.cook.`), 'the end of the method asks what to change after cooking');

    // Finishing cook mode asks what to improve, with Just finish first.
    await page.goto(`${BASE}/#/cook/${recipePath.split('/').map(encodeURIComponent).join('/')}?step=999`);
    await page.waitForSelector('#cook-next');
    await page.click('#cook-next');
    await page.waitForSelector('#choose[open]');
    ok((await page.textContent('#choose .choose-opt.is-main')).includes('Just finish') && await page.$('#choose [data-pick="claude"]'), 'Finish asks how it went, Just finish first');
    await page.click('#choose [data-pick="done"]');
    await page.waitForFunction(() => location.hash.startsWith('#/r/'));
    ok(!(await page.isVisible('#choose')), 'Just finish goes back to the recipe');
    await page.waitForSelector('#edit-btn');
    await page.context().setOffline(true);
    await page.click('#edit-btn');
    await page.waitForSelector('#choose[open]');
    ok((await page.textContent('#choose .is-off')).includes("You're offline") && !(await page.$('#choose [data-pick="claude"]')), 'offline, Edit says why Claude is out');
    await page.click(`#choose a[href="#/edit/${recipePath.split('/').map(encodeURIComponent).join('/')}"]`);
    await page.waitForSelector('.editor');
    ok(!(await page.isVisible('#choose')), 'Edit the file opens the editor');
    await page.context().setOffline(false);
    await page.goto(`${BASE}/#/`);
    await page.waitForSelector('.btn-new', { timeout: 10000 });
    const pages = ctx.pages().length;
    await page.click('summary.avatar');
    await page.click('[data-action="signout"]');
    await page.waitForSelector('#signin');
    ok(worker.signouts === 1 && await page.evaluate(() => !localStorage.getItem('recipes.pass')), 'sign out forgets the pass on this device only');
    ok(ctx.pages().length === pages, 'no extra sign-in windows');
    await ctx.close();
  }
}
