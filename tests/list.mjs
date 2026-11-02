// The shopping list in the fake Drive, on a phone and in the side panel on
// a wide screen.
import fs from 'fs';
import path from 'path';
import { t, ok, until2, untilOn, watch, newPage, signedIn, files, byName, driveRoute, fakeGis, fakeConfig, recipesJson, hashPath, PNG } from './lib.mjs';

export default async function () {
  const { BASE, RECIPES, browser } = t;
  const crepesFolder = byName('ROOT', '01 Breakfast').id;

  // 7. shopping list, saved in the fake Drive
  {
    const ctx = await signedIn({ viewport: { width: 390, height: 844 } }, { once: true });
    const page = await ctx.newPage();
    watch(page);
    const config = byName('ROOT', 'config').id;
    const listFile = () => byName(config, 'shopping_list.json');
    const listJson = () => JSON.parse(listFile().content.toString());
    const until = async (fn, what) => {
      for (let i = 0; i < 60; i++) { try { if (await fn()) return true; } catch { /* not yet */ } await page.waitForTimeout(100); }
      console.log('timed out waiting for', what);
      return false;
    };
    const row = (name) => page.locator('.shop-row', { has: page.locator('.shop-name', { hasText: new RegExp(`^${name}`) }) }).first();
    const qtyOf = async (name) => (await row(name).locator('.ing-qty').textContent()).trim();
    const sync = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

    await page.goto(`${BASE}/#/r/01%20Breakfast/crepes`);
    await page.waitForSelector('#add-list', { timeout: 15000 });
    await page.click('#add-list');
    ok((await page.textContent('#toast')).includes('Added Crêpes'), 'adding a recipe says so');
    ok(await until(() => page.$eval('#add-list', (b) => b.dataset.state === 'on'), 'basket on'), 'the basket then shows it is on the list');
    ok((await page.getAttribute('#add-list', 'aria-label')).includes('Tap to remove'), 'and says a tap removes it');
    await page.click('.toast-btn:has-text("Undo")');
    ok(await until(() => page.$eval('#add-list', (b) => b.dataset.state === 'add'), 'basket add'), 'Undo after adding takes it off again');
    await page.click('#add-list');
    await page.click('#add-list');
    ok(await until(() => page.textContent('#toast').then((t) => t.includes('Removed Crêpes')), 'removed'), 'a tap on the filled basket removes the recipe');
    await page.click('.toast-btn:has-text("Undo")');
    ok(await until(() => page.$eval('#add-list', (b) => b.dataset.state === 'on'), 'basket back'), 'and Undo puts it back');
    if (process.env.SHOT_DIR) await page.locator('.recipe-actions').screenshot({ path: `${process.env.SHOT_DIR}/basket-on.png` });
    await page.click('#scaler [data-d="1"]');
    ok(await page.$eval('#add-list', (b) => b.dataset.state === 'update' && b.title.startsWith('Update to')), 'at another size the basket offers to update');
    if (process.env.SHOT_DIR) await page.locator('.recipe-actions').screenshot({ path: `${process.env.SHOT_DIR}/basket-update.png` });
    await page.click('#add-list');
    ok(await until(() => page.textContent('#toast').then((t) => t.includes('is now')), 'updated'), 'and a tap updates the size');
    ok(await page.$eval('#add-list', (b) => b.dataset.state === 'on'), 'after which it is on the list at this size');
    await page.click('#scaler [data-reset]');
    await page.click('#add-list');
    await page.goto(`${BASE}/#/r/05%20Mains/Pasta/lasagna?s=4`);
    await page.waitForSelector('#add-list');
    await page.click('#add-list');
    ok(await until(() => listJson().recipes.length === 2, 'list file'), 'list file created in Drive config folder with both recipes');
    ok(listJson().recipes.find((r) => r.path.endsWith('lasagna')).servings === 4, 'the chosen servings are saved');

    await page.goto(`${BASE}/#/list`);
    await page.waitForSelector('.shop-row');
    // 3 eggs in the crêpes and 1½ in the lasagna
    ok(await qtyOf('eggs') === '4½', `eggs combine across spellings and recipes (${await qtyOf('eggs')})`);
    ok(await qtyOf('milk') === '850 ml', `milk and whole milk combine (${await qtyOf('milk')})`);
    const secs = await page.$$eval('.shop-sec h2', (hs) => hs.map((h) => h.textContent.trim()));
    ok(secs[0] === 'Produce' && secs.indexOf('Dairy & eggs') < secs.indexOf('Baking') && secs.indexOf('Baking') < secs.indexOf('Wine, beer & spirits'), `sections follow aisle.conf (${secs.join(' | ')})`);
    ok(await page.isVisible('.shop-have summary'), 'made-at-home things go under Probably have');
    const produce = await page.locator('.shop-sec', { hasText: 'Produce' }).locator('.shop-name').allTextContents();
    const at = (n) => produce.findIndex((t) => t.startsWith(n));
    ok(at('onion') < at('garlic') && at('garlic') < at('celery'), `items follow the aisle.conf order within an aisle (${produce.map((t) => t.split(/[A-Z]/)[0]).join(', ')})`);
    ok(await page.$eval('.brand', (b) => b.getBoundingClientRect().height < 30), 'site title stays on one line on a phone');
    const tabs = await page.$$eval('#tabbar .tab', (ts) => ts.map((t) => `${t.textContent.trim()}${t.getAttribute('aria-current') ? '*' : ''}`));
    ok(tabs.length === 4 && tabs[0] === 'Recipes' && tabs[1] === 'Plan' && /^List\d*\*$/.test(tabs[2]) && tabs[3] === 'New', `phone has a bottom tab bar with the list selected (${tabs.join(' | ')})`);
    ok(!(await page.isVisible('.account .icon-link')) && !(await page.isVisible('.btn-new')), 'the top bar leaves the list and New to the tab bar');
    const barTop = await page.$eval('#tabbar', (t) => t.getBoundingClientRect().top);
    ok(barTop > 844 - 80 && barTop < 844, 'the tab bar sits at the bottom of the screen');

    // offers to renew the sign-in before the hour runs out
    await page.evaluate(async () => {
      const d = await import(new URL('js/drive.js', location.href).href);
      d.user().expires = Date.now() + 5 * 60e3;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForSelector('#shop-renew');
    ok((await page.textContent('#shop-status')).includes('ends in 5 min'), 'says the sign-in ends soon');
    await page.click('#shop-renew');
    ok(await until(() => page.textContent('#shop-status').then((t) => t.includes('Saved in Google Drive')), 'renewed'), 'Renew now renews it in place');
    ok(await page.evaluate(() => window.__gis.calls) === 1, 'with one Google window');
    ok(await page.textContent('.shop-have').then((t) => t.includes('batter') && t.includes('water')), 'batter and water are under Probably have');

    // add items by hand
    await page.fill('#shop-new', 'frozen fries');
    await page.press('#shop-new', 'Enter');
    await page.fill('#shop-new', 'bagged lettuce');
    await page.press('#shop-new', 'Enter');
    await page.fill('#shop-new', '1 kg onions');
    await page.press('#shop-new', 'Enter');
    await page.waitForSelector('.shop-name:has-text("frozen fries")');
    ok((await qtyOf('onion')).startsWith('1 kg + ½'), `"1 kg onions" adds to the onion line (${await qtyOf('onion')})`);
    ok(await page.locator('.shop-sec', { hasText: 'Other' }).locator('.shop-name', { hasText: 'bagged lettuce' }).count() === 1, 'unknown items go under Other');

    // check off
    await row('eggs').locator('.tick').check();
    await page.waitForSelector('.shop-done .shop-name:has-text("eggs")');
    ok(await until(() => listJson().checked.includes('eggs'), 'checked'), 'checking an item saves to Drive');
    ok(/^1 of \d+$/.test(await page.textContent('#shop-count')), 'count shows what is checked');

    // change made on another device shows up
    const remote = listJson();
    remote.items.push({ id: 'phone1', name: 'bread', n: null, unit: '' });
    listFile().content = Buffer.from(JSON.stringify(remote));
    await sync();
    ok(await until(() => page.isVisible('.shop-name:has-text("bread")'), 'bread'), 'an item added on another device shows up');

    // offline-style merge: a local tick and a remote change both survive
    const remote2 = listJson();
    remote2.items.push({ id: 'phone2', name: 'cucumber', n: null, unit: '' });
    listFile().content = Buffer.from(JSON.stringify(remote2));
    await row('bread').locator('.tick').check();
    ok(await until(() => listJson().checked.includes('bread') && listJson().items.some((i) => i.name === 'cucumber'), 'merge'), 'a tick here and a change elsewhere are both kept');

    // by recipe: remove a whole recipe, then undo
    await page.click('.seg [data-view="recipe"]');
    await page.waitForSelector('.shop-recipe-head');
    ok(await page.locator('.shop-recipe-head h2').allTextContents().then((t) => t.includes('Crêpes (from Drive)') && t.includes('Added by you')), 'by recipe shows each recipe and your own items');
    ok((await page.textContent('.shop-recipe-head:has-text("Lasagna") > span')) === '4 servings', 'recipe shows its servings');
    const lasagna = page.locator('.shop-recipe', { hasText: 'Lasagna' });
    const first = (await lasagna.locator('.shop-row:not(.is-checked) .shop-name').first().textContent()).trim();
    await lasagna.locator('.shop-row', { has: page.locator('.shop-name', { hasText: first }) }).first().locator('.tick').click();
    ok(await page.isVisible('.shop-row.is-leaving'), 'a ticked row plays its way out first');
    const lasagnaRows = () => lasagna.locator('.shop-row').evaluateAll((rs) => rs.map((r) => [r.querySelector('.shop-name').textContent.trim(), r.classList.contains('is-checked')]));
    const after = (rs) => rs.findIndex(([n]) => n === first) > rs.findLastIndex(([, c]) => !c);
    ok(await until(() => lasagnaRows().then(after), 'moved'), 'by recipe, a ticked line moves below the lines still to buy');
    await lasagna.locator('.shop-row', { has: page.locator('.shop-name', { hasText: first }) }).first().locator('.tick').click();
    ok(await until(() => lasagnaRows().then((rs) => rs[0][0] === first && !rs[0][1]), 'back'), 'and unticked it goes back to its place');
    await page.click('.shop-recipe-head:has-text("Crêpes") [data-remove-recipe]');
    ok(await until(() => listJson().recipes.length === 1, 'remove recipe'), 'removing a recipe keeps the others');
    ok(await row('milk').locator('.ing-qty').textContent() === '350 ml', 'only the lasagna milk is left');
    await page.click('.toast-btn:has-text("Undo")');
    ok(await until(() => listJson().recipes.length === 2, 'undo'), 'undo brings the recipe back');

    // remove one line from one recipe
    await page.locator('.shop-recipe', { hasText: 'Lasagna' }).locator('.shop-row', { hasText: 'carrot' }).locator('[data-more]').click();
    await page.click('dialog button:has-text("Remove from Lasagna")');
    ok(await until(() => listJson().recipes.find((r) => r.path.endsWith('lasagna')).removed.includes('carrot'), 'line'), 'removing one ingredient from one recipe');

    // pantry and aisles
    await page.click('.seg [data-view="aisle"]');
    await row('olive oil').locator('[data-more]').click();
    await page.click('#item [role="switch"]:has-text("Always have this")');
    ok(await until(() => byName(config, 'pantry.conf')?.content.toString().includes('"olive oil" = {}'), 'pantry'), 'Always have this writes pantry.conf');
    ok(await until(() => page.locator('.shop-have .shop-name', { hasText: 'olive oil' }).count().then((n) => n === 1), 'have'), 'olive oil moves to Probably have');
    ok(await until(() => page.getAttribute('#item [role="switch"]', 'aria-checked').then((v) => v === 'true'), 'switch'), 'the switch stays on');
    await page.click('#item [data-close]');
    await row('bagged lettuce').locator('[data-more]').click();
    if (process.env.SHOT_DIR) {
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${process.env.SHOT_DIR}/item-card-phone.png` });
      await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
      await page.screenshot({ path: `${process.env.SHOT_DIR}/item-card-phone-dark.png` });
      await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    }
    await page.click('#item button:has-text("Add aisle")');
    await page.selectOption('#pick', { label: 'Produce' });
    await page.click('dialog button:has-text("Save")');
    ok(await until(() => /\[produce\][^[]*\nbagged lettuce\n/.test(byName(config, 'aisle.conf').content.toString()), 'aisle'), 'Choose aisle adds it to aisle.conf');
    ok(await until(() => page.locator('.shop-sec', { hasText: 'Produce' }).locator('.shop-name', { hasText: 'bagged lettuce' }).count().then((n) => n === 1), 'produce'), 'and the list sorts it there');
    ok(await until(() => page.textContent('#item .item-val').then((t) => t.trim() === 'Produce').catch(() => false), 'card aisle'), 'the card shows the new aisle');
    await page.click('#item [data-close]');

    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok(over <= 0, `no sideways scroll on the list on a phone (${over}px)`);
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/list-phone.png`, fullPage: true });

    // clear checked, then clear all
    await page.click('#clear-checked');
    ok(await until(() => !listJson().checked.length && !listJson().items.some((i) => i.name === 'bread'), 'clear checked'), 'Clear checked removes what is in the basket');
    ok(await page.locator('.shop-name', { hasText: /^eggs/ }).count() === 0, 'eggs are gone from both recipes');
    await page.click('#clear-all');
    await page.click('dialog button:has-text("Clear list")');
    ok(await until(() => !listJson().recipes.length && !listJson().items.length, 'clear all'), 'Clear shopping list empties it');
    await page.waitForSelector('.shop-empty');

    // phone: the servings on one line, the add button a round basket beside
    // cook mode under it, the editor hides the bar
    await page.goto(`${BASE}/#/r/01%20Breakfast/crepes`);
    await page.waitForSelector('#add-list');
    const add = await page.$eval('#add-list', (b) => b.getBoundingClientRect().toJSON());
    const cook = await page.$eval('#cook-btn', (s) => s.getBoundingClientRect().toJSON());
    const more = await page.$eval('.recipe-more', (s) => s.getBoundingClientRect().toJSON());
    ok(add.width < 60 && Math.abs(add.top - cook.top) < 10 && Math.abs(more.top - cook.top) < 10, 'on a recipe, Add to shopping list is a basket in the row with cook mode and ⋯');
    ok(await page.$eval('#tabbar .tab[aria-current]', (t) => t.textContent.trim()) === 'Recipes', 'Recipes is selected on a recipe');
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/tabbar-recipe.png` });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(`${BASE}/#/list`);
    await page.waitForSelector('.shop-body');
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/tabbar-list-dark.png` });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.click('#tabbar .tab:has-text("New")');
    await page.waitForSelector('#src');
    ok(!(await page.isVisible('#tabbar')) && await page.isVisible('.btn-new'), 'the editor hides the tab bar');
    await page.click('.editor-x');
    await page.waitForSelector('#tabbar .tab');

    // a recipe in parts asks which parts to shop for
    await page.goto(`${BASE}/#/r/05%20Mains/Meat/swedish_meatballs`);
    await page.waitForSelector('#add-list');
    await page.click('#add-list');
    await page.waitForSelector('dialog[open] .parts-list');
    const parts = await page.$$eval('.parts-list b', (bs) => bs.map((b) => b.textContent));
    ok(parts.join() === 'Meatballs,Browning,Gravy', `lists the parts of the recipe (${parts.join(', ')})`);
    ok((await page.textContent('.parts-list li:has-text("Gravy") small')).includes('beef stock'), 'each part shows its ingredients');
    await page.uncheck('.parts-list li:has-text("Gravy") input');
    await page.click('dialog button:has-text("Add to list")');
    ok(await until(() => page.textContent('#toast').then((t) => t.includes('only Meatballs and browning')), 'toast'), 'says which parts were added');
    ok(await until(() => listJson().recipes[0]?.parts?.join() === 'Meatballs,Browning', 'parts'), 'the chosen parts are saved');
    await page.goto(`${BASE}/#/list`);
    await page.waitForSelector('.shop-row');
    const names = await page.$$eval('.shop-name', (els) => els.map((e) => e.firstChild.textContent.trim()));
    ok(names.includes('ground beef') && !names.includes('beef stock') && !names.some((n) => n.includes('cream')), `only the ticked parts are on the list (${names.length} items)`);
    await page.click('.seg [data-view="recipe"]');
    ok((await page.textContent('.shop-parts')) === 'Only Meatballs and browning', 'by recipe says which parts');
    await page.goBack();
    await page.goto(`${BASE}/#/r/05%20Mains/Meat/swedish_meatballs`);
    await page.waitForSelector('#add-list');
    await page.click('#scaler [data-d="1"]');
    await page.click('#add-list');
    await page.waitForSelector('dialog[open] .parts-list');
    ok(!(await page.isChecked('.parts-list li:has-text("Gravy") input')), 'adding again starts from the earlier choice');
    await page.click('dialog button:has-text("Cancel")');
    ok(listJson().recipes.length === 1, 'cancel adds nothing');
    if (process.env.SHOT_DIR) {
      await page.click('#add-list');
      await page.waitForSelector('dialog[open] .parts-list');
      await page.screenshot({ path: `${process.env.SHOT_DIR}/parts-phone.png` });
      await page.click('dialog button:has-text("Cancel")');
    }
    await ctx.close();
  }

  // 10. on a wide screen the list sits in a side panel
  {
    const ctx = await signedIn({ viewport: { width: 1400, height: 900 } }, { once: true });
    const page = await ctx.newPage();
    watch(page);
    const shot = (name) => (process.env.SHOT_DIR ? page.screenshot({ path: `${process.env.SHOT_DIR}/${name}.png` }) : null);
    const mainRight = () => page.$eval('#main', (m) => m.getBoundingClientRect().right);

    await page.goto(`${BASE}/#/`);
    await page.waitForSelector('a[href="#/new"]', { timeout: 15000 });
    ok(await page.isVisible('#rail') && !(await page.isVisible('.account .icon-link')), 'closed list is a rail on the right, not a top bar icon');
    await shot('panel-rail');

    await page.goto(`${BASE}/#/r/01%20Breakfast/crepes`);
    await page.waitForSelector('#add-list');
    await page.click('#add-list');
    await page.waitForSelector('.side .shop-row');
    ok(true, 'the first add opens the panel by itself');
    ok(await page.locator('.side .shop-row.is-new').count() > 3, 'the new lines light up');
    await page.waitForTimeout(900);
    const delays = await page.$$eval('.side .shop-row.is-new', (rows) => rows.map((r) => -parseFloat(r.style.animationDelay)));
    ok(delays.length > 0 && Math.min(...delays) >= 300, `a redraw after saving carries on the same flash instead of starting again (${Math.round(Math.min(...delays))} ms in)`);
    ok(await page.isVisible('.toast-btn:has-text("Undo")'), 'adding offers Undo');
    ok(await mainRight() <= 1400 - 340, 'the recipe makes room for the panel');
    await page.waitForTimeout(800);
    await shot('panel-open-recipe');

    await page.click('#side-close');
    await page.waitForSelector('#rail');
    await page.goto(`${BASE}/#/r/05%20Mains/Pasta/lasagna`);
    await page.waitForSelector('#add-list');
    await page.click('#add-list');
    await page.waitForTimeout(400);
    ok(await page.isVisible('#rail') && !(await page.isVisible('.side .shop-panel')), 'after closing it, adding keeps it closed');
    ok(Number(await page.textContent('#rail .badge')) > 10, 'the rail counts what is left to buy');

    await page.keyboard.press('l');
    await page.waitForSelector('.side .shop-panel');
    ok(true, 'L opens it');
    await page.reload();
    await page.waitForSelector('.side .shop-row', { timeout: 15000 });
    ok(true, 'it stays open after a reload');
    await page.fill('#shop-new', 'frozen fries');
    await page.keyboard.press('l');
    ok(await page.isVisible('.side .shop-panel'), 'typing an L in the add box does not close it');
    await page.press('#shop-new', 'Enter');
    await page.waitForSelector('.side .shop-name:has-text("frozen fries")');
    ok(true, 'items can be added from the panel');
    await page.click('.side .seg [data-view="recipe"]');
    await page.waitForSelector('.side .shop-recipe-head');
    await shot('panel-open-home');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(`${BASE}/#/`);
    await page.waitForSelector('.side .shop-row');
    await shot('panel-open-dark');
    await page.emulateMedia({ colorScheme: 'light' });

    await page.goto(`${BASE}/#/edit/01%20Breakfast/crepes`);
    await page.waitForSelector('#src');
    ok(await page.isVisible('#rail') && !(await page.isVisible('.side .shop-panel')), 'the editor keeps it as a rail');
    await page.click('.editor-x');
    await page.waitForSelector('.side .shop-panel');
    ok(true, 'and it comes back after the editor');
    await page.goto(`${BASE}/#/list`);
    await page.waitForSelector('#main .shop-row');
    ok(!(await page.isVisible('#side')) && (await page.$$('#shop-body')).length === 1, 'the list page shows the list once, without the panel');
    await page.locator('#main .shop-row', { hasText: 'milk' }).first().locator('[data-more]').click();
    await page.waitForSelector('#item.is-wide[open]');
    ok(await page.locator('#item .item-uses li').count() === 3, 'the item card lists each recipe it is for');
    await page.waitForTimeout(300);
    await shot('item-card-wide');
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await shot('item-card-wide-dark');
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    const stepLink = page.locator('#item .item-step').first();
    ok(await stepLink.count() === 1 && /^#\/cook\/.+step=\d+$/.test(await stepLink.getAttribute('href')), 'the item card links to the steps that use it');
    const stepNo = (await stepLink.textContent()).replace(/\D/g, '');
    await stepLink.click();
    await page.waitForSelector('#cook');
    ok(!(await page.isVisible('#item')) && page.url().endsWith(`step=${stepNo}`), 'a step link opens cook mode at that step');
    await page.goto(`${BASE}/#/`);
    await page.setViewportSize({ width: 1000, height: 900 });
    await page.waitForTimeout(300);
    ok(!(await page.isVisible('#side')) && await page.isVisible('#tabbar'), 'narrower than 1100 px the panel gives way to the tab bar');
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok(over <= 0, `no sideways scroll at 1000 px (${over}px)`);
    await ctx.close();
  }
}
