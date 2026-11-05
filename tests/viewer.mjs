// Signed out, as friends see it: every recipe renders, scaling, search and
// filters, the phone layout, ingredients by aisle, no list without signing
// in, and the installable app that opens without a connection.
import fs from 'fs';
import path from 'path';
import { t, ok, until2, untilOn, watch, newPage, signedIn, files, byName, driveRoute, fakeGis, fakeConfig, recipesJson, hashPath, PNG } from './lib.mjs';

export default async function () {
  const { BASE, RECIPES, browser } = t;
  const crepesFolder = byName('ROOT', '01 Breakfast').id;

  // 1. every recipe renders
  {
    const page = await newPage();
    await page.goto(`${BASE}/#/`);
    await page.waitForSelector('.card');
    const data = await page.evaluate(() => fetch('data/recipes.json').then((r) => r.json()));
    let bad = [];
    for (const r of data.recipes) {
      await page.evaluate((h) => { location.hash = h; }, `#/r/${r.path.split('/').map(encodeURIComponent).join('/')}`);
      try {
        await page.waitForSelector(`.recipe[data-path="${r.path.replace(/"/g, '\\"')}"] .step`, { timeout: 4000 });
      } catch { bad.push(r.path); }
    }
    ok(bad.length === 0, `all ${data.recipes.length} recipes render with steps ${bad.length ? JSON.stringify(bad) : ''}`);
    await page.close();
  }

  // 2. scaling
  {
    const page = await newPage();
    await page.goto(`${BASE}/#/r/01%20Breakfast/crepes`);
    await page.waitForSelector('.ing-row');
    const qty = async (name) => page.$eval(`.ing-list`, (ul, n) => [...ul.querySelectorAll('.ing-row')].find((r) => r.querySelector('.ing-name').textContent.trim().startsWith(n))?.querySelector('.ing-qty').textContent, name);
    ok(await qty('whole milk') === '500 ml', 'crepes: 500 ml milk at 4 servings');
    await page.click('[data-d="1"]'); await page.click('[data-d="1"]'); await page.click('[data-d="1"]'); await page.click('[data-d="1"]');
    ok(await qty('whole milk') === '1 l', `crepes: 1 l milk at 8 servings (got ${await qty('whole milk')})`);
    ok(await qty('egg') === '6', 'crepes: 6 eggs at 8 servings');
    ok(page.url().includes('?s=8'), 'servings kept in the link');
    const stepText = await page.$eval('.method', (el) => el.textContent);
    ok(stepText.includes('1 l'), 'method shows the scaled amount too');
    // fixed quantity
    await page.goto(`${BASE}/#/`);
    const fixed = await page.evaluate(() => fetch('data/recipes.json').then((r) => r.json()).then((d) => d.recipes.find((r) => /@salt\{=1%tsp\}/.test(r.src))?.path));
    if (fixed) {
      await page.goto(`${BASE}/#/r/${fixed.split('/').map(encodeURIComponent).join('/')}?s=40`);
      await page.waitForSelector('.ing-row');
      ok(await qty('salt') === '1 tsp', `fixed salt stays 1 tsp when scaled (${fixed})`);
    }
    await page.close();
  }

  // 3. search + filters
  {
    const page = await newPage();
    await page.goto(`${BASE}/#/`);
    await page.waitForSelector('.card');
    await page.fill('#q', 'crepe');
    await page.waitForTimeout(300);
    const titles = await page.$$eval('.card-title', (els) => els.map((e) => e.textContent));
    ok(titles.includes('Crêpes'), `search "crepe" finds Crêpes (${titles.join(', ')})`);
    await page.fill('#q', '');
    await page.waitForTimeout(300);
    await page.click('#place');
    await page.click('#pop [data-pick="01 Breakfast"]');
    const breakfast = await page.evaluate(() => fetch('data/recipes.json').then((r) => r.json()).then((d) => d.recipes.filter((r) => r.path.startsWith('01 Breakfast/')).length));
    ok((await page.$$('.card')).length === breakfast, `Breakfast folder shows all ${breakfast}`);
    ok(await page.$eval('#pop', (p) => p.hidden), 'picking a folder closes the panel');
    ok((await page.textContent('#place')).includes('Breakfast'), 'the folder button says where you are');
    await page.click('#place');
    await page.click('#pop [data-pick="05 Mains/Pasta"]');
    const where = await page.$$eval('.card', (els) => [...new Set(els.map((a) => decodeURIComponent(a.getAttribute('href')).split('/').slice(2, -1).join('/')))]);
    ok(where.length === 1 && where[0] === '05 Mains/Pasta', `picking Pasta under Mains shows only pasta (${where.join(', ')})`);
    await page.click('#place');
    ok(await page.$eval('#pop [data-pick="05 Mains/Pasta"]', (b) => b.classList.contains('is-here')), 'the panel opens with the current folder marked');
    const hasRecipes = (d) => fs.readdirSync(d, { withFileTypes: true }).some((x) => (x.isDirectory() ? hasRecipes(path.join(d, x.name)) : x.name.endsWith('.cook')));
    const mainsSubs = fs.readdirSync(path.join(RECIPES, '05 Mains'), { withFileTypes: true }).filter((x) => x.isDirectory() && hasRecipes(path.join(RECIPES, '05 Mains', x.name))).length;
    const subs = await page.$$eval('#pop .fp-sub[data-pick^="05 Mains/"]', (els) => els.length);
    ok(subs === mainsSubs, `on desktop every subfolder of Mains is listed (${subs} of ${mainsSubs})`);
    await page.click('#pop [data-pick=""]');
    const total = (await page.$$('.card')).length;
    await page.click('#fbar [data-pop="diet"]');
    await page.click('#pop [data-diet="vegan"]');
    await page.keyboard.press('Escape');
    const n = (await page.$$('.card')).length;
    ok(n > 0 && n < total, `vegan filter narrows the list (${n})`);
    ok((await page.textContent('#fbar [data-pop="diet"]')).includes('Vegan'), 'the bar says which diet is on');
    await page.click('#fbar [data-pop="diet"]');
    await page.click('#pop [data-diet="vegetarian"]');
    ok(await page.$eval('#pop [data-diet="vegan"]', (b) => b.getAttribute('aria-pressed') === 'true'), 'vegetarian keeps vegan picked');
    await page.click('#pop [data-diet="vegetarian"]');
    ok(await page.$eval('#pop [data-diet="vegan"]', (b) => b.getAttribute('aria-pressed') === 'false'), 'and takes it off again');
    await page.keyboard.press('Escape');
    // time: bring the top end down to 30 min with the keyboard
    await page.click('#fbar [data-pop="time"]');
    await page.focus('#pop input[data-end="hi"]');
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft');
    ok((await page.textContent('#fbar [data-pop="time"]')).includes('Up to 30 min'), 'the time slider sets "Up to 30 min"');
    const times = await page.$$eval('.card', (els) => els.map((a) => a.querySelector('.card-facts span')?.textContent || ''));
    ok(times.length > 0 && times.every((t) => /^\d+ min$/.test(t) && parseInt(t, 10) <= 30), `and only quick recipes are left (${times.join(', ')})`);
    await page.keyboard.press('Escape');
    await page.click('#fbar [data-pop="difficulty"]');
    await page.click('#pop [data-diff="easy"]');
    await page.click('#pop [data-diff="medium"]');
    ok((await page.textContent('#fbar [data-pop="difficulty"]')).includes('Not hard'), 'difficulty takes several, and two of three reads "Not hard"');
    ok(await page.$eval('#pop', (p) => !p.hidden), 'and its panel stays open while you tick');
    await page.close();
  }

  // 4. mobile layout has no horizontal scroll
  {
    const page = await newPage({ viewport: { width: 375, height: 800 } });
    for (const h of ['#/', '#/r/05%20Mains/Pasta/lasagna']) {
      await page.goto(`${BASE}/${h}`);
      await page.waitForTimeout(800);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      ok(over <= 0, `no sideways scroll on phone for ${h} (${over}px)`);
    }
    await page.goto(`${BASE}/#/`);
    ok(!(await page.isVisible('#fbar')), 'on a phone the filter bar is not on the page');
    await page.click('#place');
    ok(await page.$eval('#browse', (d) => d.open && Boolean(d.querySelector('[data-pill="diet"]'))), 'the folder button opens one sheet with the filters on top');
    ok(!(await page.$('#browse [data-pick="05 Mains/Pasta"]')), 'subfolders start closed');
    await page.click('#browse [data-pick="05 Mains"]');
    ok(await page.$eval('#browse', (d) => d.open), 'picking a folder keeps the sheet open');
    await page.click('#browse [data-pick="05 Mains/Pasta"]');
    ok(await page.$eval('#browse [data-pick="05 Mains/Pasta"]', (b) => b.classList.contains('is-here')), 'a folder with subfolders opens in place, and a subfolder can be picked');
    await page.click('#browse [data-pill="diet"]');
    await page.click('#browse [data-diet="meat"]');
    await page.click('#b-show');
    ok(!(await page.$eval('#browse', (d) => d.open)), 'Show closes the sheet');
    ok((await page.textContent('#active')).includes('Meat'), 'the diet shows as a chip under the search');
    const where = await page.$$eval('.card', (els) => [...new Set(els.map((a) => decodeURIComponent(a.getAttribute('href')).split('/').slice(2, -1).join('/')))]);
    ok(where.length === 1 && where[0] === '05 Mains/Pasta', `and the cards are from Pasta only (${where.join(', ')})`);
    await page.click('#place');
    ok(await page.$eval('#browse [data-pick="05 Mains/Pasta"]', (b) => b.classList.contains('is-here')), 'reopening shows the folder you are in');
    await page.close();
  }

  // 11b. ingredients by aisle, signed out, on the recipe page and in the mise en place
  {
    const page = await newPage();
    await page.goto(`${BASE}/#/r/01%20Breakfast/crepes`);
    await page.waitForSelector('.ing-sort');
    const data = await page.evaluate(() => fetch('data/recipes.json').then((r) => r.json()));
    const store = [...data.aisle.matchAll(/^\[(.+)\]\s*$/gm)].map((m) => m[1].trim().toLowerCase());
    ok(store.length > 0, 'the build ships aisle.conf for friends');
    ok(!(await page.$('.ingredients .ing-sec')), 'ingredients start as written');
    await page.click('.ingredients .ing-row .tick');
    const ticked = await page.textContent('.ingredients .ing-row.is-checked .ing-name');
    await page.click('.ing-sort [data-sort="aisle"]');
    const secs = (await page.$$eval('.ingredients .ing-sec', (els) => els.map((e) => e.textContent.trim().toLowerCase())));
    const known = secs.filter((s) => s !== 'other' && s !== 'made at home');
    ok(secs.length > 0 && known.every((s, i) => i === 0 || store.indexOf(known[i - 1]) < store.indexOf(s)), `By aisle groups them in store order (${secs.join(' | ')})`);
    ok((await page.textContent('.ingredients .ing-row.is-checked .ing-name')) === ticked, 'the tick stays when you switch');
    await page.click('#cook-btn');
    await page.waitForSelector('.cook-mise');
    ok((await page.$$('.cook-mise .ing-sec')).length === secs.length, 'the mise en place opens by aisle too');
    await page.click('.cook-mise .ing-sort [data-sort="recipe"]');
    ok(!(await page.$('.cook-mise .ing-sec')) && (await page.$$('.cook-mise .ing-lines .ing-row')).length > 0, 'As written puts the flat list back');
    await page.close();
  }

  // 8. friends who are not signed in see no shopping list
  {
    const page = await newPage();
    await page.goto(`${BASE}/#/r/01%20Breakfast/crepes`);
    await page.waitForSelector('.ing-row');
    ok(!(await page.isVisible('#add-list')) && !(await page.isVisible('.icon-link')), 'no shopping list without signing in');
    await page.goto(`${BASE}/#/list`);
    ok(await page.isVisible('text=Sign in to use the shopping list'), 'list page asks to sign in');
    await page.close();
  }

  // 9. installable, and opens without a connection
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    watch(page);
    await page.goto(`${BASE}/#/`);
    await page.waitForSelector('.card');
    const man = await page.evaluate(async () => {
      const m = await fetch(document.querySelector('link[rel=manifest]').href).then((r) => r.json());
      const icons = await Promise.all(m.icons.map((i) => fetch(i.src).then((r) => r.ok && r.headers.get('content-type').includes('png'))));
      const title = await fetch('data/recipes.json').then((r) => r.json()).then((d) => d.config.title);
      return { name: m.name, display: m.display, icons, title, maskable: m.icons.some((i) => i.purpose === 'maskable') };
    });
    ok(man.name === man.title && man.display === 'standalone', `manifest names the app after the site (${man.name})`);
    ok(man.icons.every(Boolean) && man.maskable, 'app icons load, with a maskable one for Android');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await page.waitForSelector('.card');
    ok(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)), 'offline helper is running');
    const online = (await page.$$('.card')).length;
    await ctx.setOffline(true);
    await page.reload();
    await page.waitForSelector('.card', { timeout: 8000 });
    ok((await page.$$('.card')).length === online, `home opens without a connection (${online} recipes)`);
    await page.evaluate(() => { location.hash = '#/r/05%20Mains/Pasta/lasagna?s=4'; });
    ok(await page.waitForSelector('.recipe .step', { timeout: 8000 }).then(() => true, () => false), 'a recipe opens and scales without a connection');
    await ctx.close();
  }
}
