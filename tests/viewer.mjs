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
    await page.click('#browse [data-pick="01 Breakfast"]');
    const breakfast = await page.evaluate(() => fetch('data/recipes.json').then((r) => r.json()).then((d) => d.recipes.filter((r) => r.path.startsWith('01 Breakfast/')).length));
    ok((await page.$$('.card')).length === breakfast, `Breakfast folder shows all ${breakfast}`);
    ok(!(await page.$eval('#browse', (d) => d.open)), 'picking a folder closes the panel');
    ok((await page.textContent('#place')).includes('Breakfast'), 'the folder button says where you are');
    await page.click('#place');
    await page.click('#browse [data-pick="05 Mains/Pasta"]');
    const where = await page.$$eval('.card', (els) => [...new Set(els.map((a) => decodeURIComponent(a.getAttribute('href')).split('/').slice(2, -1).join('/')))]);
    ok(where.length === 1 && where[0] === '05 Mains/Pasta', `picking Pasta under Mains shows only pasta (${where.join(', ')})`);
    await page.click('#place');
    ok(await page.$eval('#browse [data-pick="05 Mains/Pasta"]', (b) => b.classList.contains('is-here')), 'the panel opens with the current folder marked');
    const hasRecipes = (d) => fs.readdirSync(d, { withFileTypes: true }).some((x) => (x.isDirectory() ? hasRecipes(path.join(d, x.name)) : x.name.endsWith('.cook')));
    const mainsSubs = fs.readdirSync(path.join(RECIPES, '05 Mains'), { withFileTypes: true }).filter((x) => x.isDirectory() && hasRecipes(path.join(RECIPES, '05 Mains', x.name))).length;
    const subs = await page.$$eval('#browse .tree-leaf[data-pick^="05 Mains/"]', (els) => els.length);
    ok(subs === mainsSubs, `on desktop every subfolder of Mains is listed (${subs} of ${mainsSubs})`);
    await page.click('#browse [data-pick=""]');
    const total = (await page.$$('.card')).length;
    await page.click('#place');
    await page.click('#browse .opt[data-key="diet"][data-val="vegan"]');
    await page.click('#b-show');
    const n = (await page.$$('.card')).length;
    ok(n > 0 && n < total, `vegan filter narrows the list (${n})`);
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
    await page.click('#place');
    ok(await page.$eval('#browse', (d) => !d.querySelector('.opt') && Boolean(d.querySelector('[data-tab="filters"]'))), 'on a phone the panel opens on the folders tab');
    await page.click('#browse [data-open="05 Mains"]');
    ok((await page.textContent('#browse h2')).replace(/\s+/g, ' ').trim() === 'All recipes / Mains', 'a folder with subfolders opens, with the path on top');
    await page.click('#browse [data-pick="05 Mains/Pasta"]');
    await page.click('#place');
    ok(await page.$eval('#browse [data-pick="05 Mains/Pasta"]', (b) => b.classList.contains('is-here')), 'reopening shows the level you are on');
    await page.click('#browse [data-up=""]');
    ok(Boolean(await page.$('#browse [data-open="05 Mains"]')), 'tapping All recipes in the path goes back up');
    await page.click('#browse [data-tab="filters"]');
    ok(Boolean(await page.$('#browse .opt')) && Boolean(await page.$('#b-show')), 'and the filters tab has the filters');
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
