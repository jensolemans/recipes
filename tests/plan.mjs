// The meal plan: Saved and the calendar, cooked on purpose, shopping for
// the plan, dragging, and the week.
import fs from 'fs';
import path from 'path';
import { t, ok, until2, untilOn, watch, newPage, signedIn, files, byName, driveRoute, fakeGis, fakeConfig, recipesJson, hashPath, PNG } from './lib.mjs';

export default async function () {
  const { BASE, RECIPES, browser } = t;
  const crepesFolder = byName('ROOT', '01 Breakfast').id;

  // 13. the meal plan: Saved and the calendar, cooked on purpose, shopping for the plan
  {
    const config = byName('ROOT', 'config').id;
    const planFile = () => byName(config, 'plan.json');
    const planJson = () => JSON.parse(planFile().content.toString());
    const listJson = () => JSON.parse(byName(config, 'shopping_list.json').content.toString());
    for (const f of files.values()) if (['plan.json', 'shopping_list.json'].includes(f.name)) files.delete(f.id);
    const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const lasagnaOn = (n) => planJson().meals.find((m) => m.day === day(n) && m.path?.endsWith('lasagna') && !String(m.id).startsWith('old'));
    const DAYS = '.plan-page .pcal > .pdays > .pday';
    const TODAY = `${DAYS}:not(.is-late) >> nth=0`;

    // phone
    const ctx = await signedIn({ viewport: { width: 390, height: 844 }, hasTouch: true }, { once: true });
    const page = await ctx.newPage();
    watch(page);
    const until = async (fn, what) => {
      for (let i = 0; i < 60; i++) { try { if (await fn()) return true; } catch { /* not yet */ } await page.waitForTimeout(100); }
      console.log('timed out waiting for', what);
      return false;
    };
    const shot = (name) => (process.env.SHOT_DIR ? page.screenshot({ path: `${process.env.SHOT_DIR}/${name}.png` }) : null);

    await page.goto(`${BASE}/#/r/01%20Breakfast/crepes`);
    await page.waitForSelector('#save-btn', { timeout: 15000 });
    await page.click('#save-btn');
    ok((await page.textContent('#toast')).includes('for 4'), 'Save puts the recipe in Saved for 4, no questions');
    ok(await until(() => planJson().saved.length === 1, 'saved'), 'and writes config/plan.json');
    ok(await page.$eval('#save-btn', (b) => b.dataset.state === 'saved'), 'the bookmark then shows it is saved');
    const row = await page.$$eval('.recipe-actions > *:not(.row-break):not(.scaler)', (els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
    ok(new Set(row).size === 1, `on a phone Save sits in the row with cook mode (${row.join(', ')})`);

    await page.click('#tabbar .tab:has-text("Plan")');
    await page.waitForSelector(`${DAYS}`);
    ok(await page.isVisible('.plan-page .psaved .pchip') && await page.isVisible('.plan-page .pcal'), 'the phone plan shows Saved above the calendar on one page');
    ok(await page.locator(DAYS).count() === 4, 'the calendar shows today and 3 days ahead');
    ok((await page.textContent(`${DAYS} >> nth=0 >> .pday-head b`)) === 'Today', 'starting with today');
    ok(await page.locator('.plan-page .pslot.is-empty:visible').count() === 0, 'empty meals stay hidden');
    await page.click('[data-act="add-day"]');
    ok(await until(() => page.locator(DAYS).count().then((n) => n === 5), 'add day'), 'the ghost day adds one more day');
    await page.click(`${TODAY} >> [data-add-day]`);
    await page.click('#choose [data-pick="free"]');
    await page.fill('#ask-line', 'Eating out');
    await page.click('#modal .pmeals [data-meal="lunch"]');
    await page.click('#modal button[value="ok"]');
    ok(await until(() => page.locator(`${TODAY} >> .pslot[data-meal="lunch"] .pchip`).count().then((n) => n === 1), 'free'), 'a meal without a recipe goes on today, lunch');
    await page.click('.psaved .pchip');
    await page.waitForSelector('#meal[open]');
    if (process.env.SHOT_DIR) await page.waitForTimeout(300);
    await shot('plan-sheet-saved-phone');
    await page.click('#meal [data-act="plan"]');
    await page.click(`#modal .pdaybtn[data-day="${day(1)}"]`);
    await page.click('#modal button[value="ok"]');
    ok(await until(() => planJson().meals.some((m) => m.day === day(1) && m.meal === 'dinner' && m.path?.endsWith('crepes')) && !planJson().saved.length, 'planned'), 'planning a saved recipe moves it out of Saved onto the day');
    await page.click(`${TODAY} >> [data-add-day]`);
    await page.click('#choose [data-pick="recipe"]');
    await page.fill('#ppick-q', 'lasagna');
    await page.click('#planpick .ppick-row[data-path$="lasagna"]');
    ok(await until(() => lasagnaOn(0), 'recipe'), 'the + on a day adds a recipe from a search');

    // the servings bubble: quiet while it follows Cooking for, filled when set by hand
    const bubble = `${TODAY} >> .pslot[data-meal="dinner"] .pchip .pbubble`;
    await page.waitForSelector(bubble);
    ok((await page.textContent(bubble)) === '4' && !(await page.getAttribute(bubble, 'class')).includes('is-own'), 'a planned recipe shows its servings in a quiet bubble');
    await page.click(`${TODAY} >> .pslot[data-meal="dinner"] .pchip`);
    await page.click('#meal [data-act="servings"][data-d="1"]');
    ok(await until(() => page.getAttribute(bubble, 'class').then((c) => c.includes('is-own')), 'own'), 'changed by hand, the bubble is filled');
    await page.click('#meal [data-act="reset"]');
    ok(await until(() => lasagnaOn(0) && lasagnaOn(0).servings == null, 'reset'), 'and Reset makes it follow Cooking for again');

    // Also eat on: one recipe on more days, cooked once
    await page.click(`#meal [data-act="also"][data-day="${day(1)}"]`);
    ok(await until(() => lasagnaOn(1) && lasagnaOn(1).batch === lasagnaOn(0).batch, 'also'), 'Also eat on puts it on tomorrow too, as one batch');
    ok(await page.isVisible('#meal [data-act="each"][aria-checked="true"]'), 'cooked once, on the first day');
    ok((await page.textContent('#meal [data-act="each"]')).includes('makes 8 for 2 days'), 'and cook mode makes the servings of both days');
    await shot('plan-sheet-also-phone');
    await page.click('#meal [data-close]');
    await shot('plan-days-phone');

    // Today on the home page; only Done or cook mode tick it
    await page.goto(`${BASE}/#/`);
    await page.waitForSelector('.today .today-row');
    ok(await page.locator('.today-row').count() === 2, 'Today on top of the home page shows lunch and dinner');
    ok(/plan=/.test(await page.getAttribute('.today-row a.btn-primary', 'href')), 'Cook opens cook mode for that meal');
    await shot('today-phone');
    await page.click('.today-row [data-done]');
    ok(await until(() => lasagnaOn(0)?.cooked === day(0) && lasagnaOn(1)?.cooked, 'done'), 'Done ticks it as cooked, for both days of the batch');
    await page.click('.today-row [data-done]');
    ok(await until(() => !lasagnaOn(0)?.cooked && !lasagnaOn(1)?.cooked, 'undone'), 'and a second tap unticks it');

    // hold a recipe card: where it goes
    const card = page.locator('.grid a.card').first();
    const box = await card.boundingBox();
    await card.dispatchEvent('pointerdown', { pointerType: 'touch', clientX: box.x + 20, clientY: box.y + 20, isPrimary: true });
    await page.waitForSelector('#choose[open] .pdrop-day', { timeout: 3000 });
    ok(true, 'holding a recipe card opens where it goes');
    if (process.env.SHOT_DIR) await page.waitForTimeout(300);
    await shot('drop-sheet-phone');
    await page.click(`#choose [data-day="${day(3)}"][data-meal="breakfast"]`);
    await card.dispatchEvent('pointerup', { pointerType: 'touch' });
    ok(await until(() => planJson().meals.some((m) => m.day === day(3) && m.meal === 'breakfast'), 'drop'), 'a tap on a meal plans it there');
    ok(page.url().endsWith('#/'), 'and the card does not open the recipe');

    // a day gone by with a recipe not ticked as cooked stays, with a warning
    await page.goto(`${BASE}/#/plan`);
    await page.waitForSelector(DAYS);
    const remote = planJson();
    remote.meals.push({ id: 'old1', day: day(-1), meal: 'dinner', kind: 'recipe', path: '05 Mains/Pasta/lasagna', title: 'Lasagna' });
    remote.meals.push({ id: 'old2', day: day(-2), meal: 'dinner', kind: 'recipe', path: '01 Breakfast/crepes', title: 'Crêpes', cooked: day(-2) });
    planFile().content = Buffer.from(JSON.stringify(remote));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    ok(await until(() => page.locator('.plan-page .pday.is-late').count().then((n) => n === 1), 'late'), 'yesterday shows, warned, with its uncooked meal');
    ok(planJson().meals.find((m) => m.id === 'old1').day === day(-1), 'the meal stays on its day');

    // shopping for the plan: one row per recipe, its days below it
    await page.click('.plan-page [data-act="shop"]');
    await page.waitForSelector('#planpick[open] .pshop-row');
    const rows = await page.$$eval('#planpick .pshop-row:not(.is-off) > span > b', (bs) => bs.map((b) => b.textContent));
    ok(rows.length >= 2 && !rows.includes('Eating out') && rows.filter((r) => r === 'Lasagna').length === 1, `the check lists each recipe once, not meals without a recipe (${rows.join(', ')})`);
    ok(await page.locator('#planpick .pshop-row:has-text("Lasagna") .pshop-when li').count() === 2, 'with the days it is on');
    if (process.env.SHOT_DIR) await page.waitForTimeout(300);
    await shot('plan-shop-phone');
    await page.click('#pshop-go');
    ok(await until(() => listJson().recipes.some((r) => r.path.endsWith('lasagna') && r.planIds?.length === 2), 'listed'), 'two lasagnas go on the list as one recipe');
    ok(listJson().recipes.find((r) => r.path.endsWith('lasagna')).servings === 8, 'at 4 + 4 servings');
    ok(await until(() => page.locator(`${TODAY} >> .pchip.is-list`).count().then((n) => n >= 1), 'state'), 'the plan shows they are on the list');
    await page.click('.plan-page [data-act="shop"]');
    await page.waitForSelector('#planpick[open]');
    ok(await page.locator('#planpick .pshop-row:not(.is-off)').count() === 0, 'a second check adds nothing twice');
    await page.click('#planpick [data-close]');

    // removing a planned meal takes it off the list too
    await page.click(`${TODAY} >> .pslot[data-meal="dinner"] .pchip`);
    await page.click('#meal [data-act="remove"]');
    ok(await until(() => listJson().recipes.find((r) => r.path.endsWith('lasagna'))?.servings === 4, 'unlink'), 'removing one lasagna takes its part off the list');
    await page.click('.toast-btn:has-text("Undo")');
    ok(await until(() => listJson().recipes.find((r) => r.path.endsWith('lasagna'))?.servings === 8, 'undo'), 'and Undo puts it back');

    // a finger drags a meal into the bin
    const cdp = await ctx.newCDPSession(page);
    const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    const free = await page.locator(`${TODAY} >> .pslot[data-meal="lunch"] .pchip`).boundingBox();
    await touch('touchStart', free.x + 40, free.y + 15);
    await page.waitForTimeout(500);
    const bin = await page.evaluate(() => { const r = document.querySelector('.pbin').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
    for (let i = 1; i <= 10; i++) { await touch('touchMove', free.x + 40 + ((bin[0] - free.x - 40) * i) / 10, free.y + 15 + ((bin[1] - free.y - 15) * i) / 10); await page.waitForTimeout(16); }
    await shot('plan-bin-phone');
    await touch('touchEnd');
    ok(await until(() => !planJson().meals.some((m) => m.kind === 'free'), 'bin'), 'holding a meal and dragging it to the bin removes it');
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok(over <= 0, `no sideways scroll on the plan on a phone (${over}px)`);
    if (process.env.SHOT_DIR) {
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.reload();
      await page.waitForSelector('.plan-page .pdays .pchip');
      await shot('plan-days-phone-dark');
      await page.emulateMedia({ colorScheme: 'light' });
    }
    await ctx.close();

    // wide screen: the side panel, dragging, and the week
    const wctx = await signedIn({ viewport: { width: 1400, height: 900 } }, { once: true });
    const wp = await wctx.newPage();
    watch(wp);
    const wshot = (name) => (process.env.SHOT_DIR ? wp.screenshot({ path: `${process.env.SHOT_DIR}/${name}.png` }) : null);
    // a drag by hand: Playwright's own drag misses the meals that open once it starts
    const dragTo = async (from, to) => {
      const a = await wp.locator(from).first().boundingBox();
      await wp.mouse.move(a.x + 30, a.y + 15);
      await wp.mouse.down();
      await wp.mouse.move(a.x + 40, a.y + 40, { steps: 4 });
      await wp.waitForTimeout(100);
      const b = await wp.locator(to).first().boundingBox();
      await wp.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
      await wp.mouse.move(b.x + b.width / 2 + 2, b.y + b.height / 2 + 2, { steps: 2 });
      await wp.mouse.up();
    };
    const P = '.side .plan-panel .pcal > .pdays > .pday';
    await wp.goto(`${BASE}/#/`);
    await wp.waitForSelector('#rail-plan', { timeout: 15000 });
    await wshot('plan-rail');
    await wp.click('#rail-plan');
    await wp.waitForSelector(P);
    ok(true, 'the rail opens the plan beside the recipes');
    const btnX = () => wp.$eval('.side-head a.icon-btn', (a) => Math.round(a.getBoundingClientRect().left));
    const x1 = await btnX();
    await wp.click('.side [data-side-tab="list"]');
    await wp.waitForSelector('.side .shop-panel');
    await wp.waitForTimeout(400);
    ok(x1 === await btnX(), 'the calendar and basket switch the panel, its buttons stay put');
    await wp.click('#side-close');
    await wp.click('#rail-open');
    ok(await wp.locator('.side .shop-panel').count() === 1, 'the toggle on the rail opens the panel as it was last');
    await wp.keyboard.press('p');
    await wp.waitForSelector('.side .plan-panel');
    ok(true, 'P switches to the plan');
    await wp.waitForTimeout(400);
    await wp.dragAndDrop('.grid a.card >> nth=2', '.side .psaved');
    ok(await until2(wp, () => wp.locator('.side .psaved .pchip').count().then((n) => n === 1)), 'dragging a recipe card onto Saved saves it');
    await dragTo('.side .psaved .pchip', `${P}:nth-child(2) .pslot[data-meal="lunch"] .pslot-items`);
    ok(await until2(wp, () => wp.locator(`${P}:nth-child(2) .pslot[data-meal="lunch"] .pchip`).count().then((n) => n === 1)), 'and on from Saved into a day');
    await dragTo(`${P}:nth-child(2) .pslot[data-meal="lunch"] .pchip`, `${P}:nth-child(3) .pslot[data-meal="dinner"] .pslot-items`);
    ok(await until2(wp, () => wp.locator(`${P}:nth-child(3) .pslot[data-meal="dinner"] .pchip`).count().then((n) => n >= 1)), 'a meal drags out of its day into another');
    const before = listJson().recipes.length;
    await dragTo('.grid a.card >> nth=4', '.side [data-side-tab="list"]');
    ok(await until2(wp, () => Promise.resolve(listJson().recipes.length === before + 1)), 'a recipe card dropped on the basket goes on the shopping list');
    const gone = await wp.getAttribute(`${P}:nth-child(3) .pslot[data-meal="dinner"] .pchip >> nth=0`, 'data-id');
    await dragTo(`.side .pchip[data-id="${gone}"]`, '.pbin');
    ok(await until2(wp, () => Promise.resolve(!planJson().meals.some((m) => m.id === gone))), 'and a meal dropped in the bin is removed');
    await wp.click(`${P}:nth-child(2) [data-fold-day]`);
    ok(await wp.locator(`${P}:nth-child(2).is-folded`).count() === 1, 'a day folds away');
    await wshot('plan-panel');
    await wp.click('.side a[href="#/plan"]');
    await wp.waitForSelector('.week-grid .wcell');
    ok(!(await wp.isVisible('#side')), 'full screen shows the plan as a week, without the panel');
    const cols = await wp.$$eval('.week-grid .whead', (hs) => hs.length);
    ok(cols >= 5, `a column per day (${cols})`);
    await wshot('plan-week');
    await wp.emulateMedia({ colorScheme: 'dark' });
    await wshot('plan-week-dark');
    await wp.emulateMedia({ colorScheme: 'light' });
    await wp.click('.week-head [data-act="to-side"]');
    await wp.waitForSelector('.side .plan-panel');
    ok(true, 'and steps back to the panel');
    await wctx.close();
  }
}
