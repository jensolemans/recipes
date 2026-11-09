// Cook mode: mise en place, one step at a time, chapters, scroll mode.
import fs from 'fs';
import path from 'path';
import { t, ok, until2, untilOn, watch, newPage, signedIn, files, byName, driveRoute, fakeGis, fakeConfig, recipesJson, hashPath, PNG } from './lib.mjs';

export default async function () {
  const { BASE, RECIPES, browser } = t;
  const crepesFolder = byName('ROOT', '01 Breakfast').id;

  // 12. cook mode: mise en place, one step at a time, chapters, scroll mode
  {
    const page = await newPage();
    await page.goto(`${BASE}/#/r/01%20Breakfast/crepes`);
    await page.waitForSelector('#cook-btn');
    const order = await page.$$eval('.recipe-actions > *, #action-btns > *', (els) => els.map((e) => e.id || e.className));
    ok(order[0] === 'scaler' && order[2] === 'cook-btn', `cook mode sits right after the servings (${order.join(', ')})`);
    await page.click('[data-d="1"]');
    await page.click('#cook-btn');
    await page.waitForSelector('.cook-mise');
    ok(page.url().includes('#/cook/') && page.url().includes('s=5'), 'cook mode opens with the servings from the recipe');
    ok(await page.$eval('.topbar', (el) => getComputedStyle(el).display === 'none'), 'the site top bar is hidden');
    ok((await page.textContent('.cook-where')) === 'Before you start', 'it starts with the mise en place');
    const count = () => page.textContent('#mise-count');
    const before = await count();
    await page.click('.cook-mise .ing-row .ing-name');
    ok((await count()) !== before, `ticking an ingredient counts it (${before} to ${await count()})`);
    await page.click('#cook-next');
    await page.waitForSelector('.cook-text');
    ok((await page.textContent('.cook-where')).startsWith('1 of '), 'Next goes to step 1');
    ok(page.url().includes('step=1'), 'the step is kept in the link');
    ok(Boolean(await page.$('.cook-sum li')), 'the step lists what it uses');
    await page.keyboard.press('ArrowRight');
    ok((await page.textContent('.cook-where')).startsWith('2 of '), 'the right arrow key goes on');
    await page.keyboard.press('ArrowLeft');
    ok((await page.textContent('.cook-where')).startsWith('1 of '), 'the left arrow key goes back');
    await page.click('.cb-pill[data-at="0"]');
    ok(Boolean(await page.$('.cook-mise .ing-row.is-checked')), 'the tick is still there when you come back');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.recipe');
    ok(page.url().includes('#/r/') && page.url().includes('s=5'), 'Esc goes back to the recipe at the same servings');

    // A recipe with == Section == chapters labels the bar with them.
    const withChapters = await page.evaluate(() => fetch('data/recipes.json').then((r) => r.json()).then((d) => d.recipes.find((r) => /^==[^=\n]+==\s*$/m.test(r.src))?.path));
    if (withChapters) {
      await page.goto(`${BASE}/#/cook/${withChapters.split('/').map(encodeURIComponent).join('/')}?step=1`);
      await page.waitForSelector('.cook-text');
      const labels = await page.$$eval('.cb-label', (els) => els.map((e) => e.textContent).filter(Boolean));
      ok(labels.length > 0, `the bar is labelled by chapter (${withChapters}: ${labels.join(', ')})`);
    }
    await page.goto(`${BASE}/#/cook/01%20Breakfast/crepes?step=2`);
    await page.waitForSelector('.cook-text');
    await page.click('#cook-mode');
    await page.waitForSelector('.cook-flow');
    const nowStep = () => page.$eval('.cf-step.is-now', (el) => el.dataset.at);
    ok((await nowStep()) === '2' && (await page.$$('.cf-step.is-done')).length === 2, 'scroll mode opens on the current step, the ones before are done');
    const atTop = () => page.$eval('.cf-step.is-now', (el) => Math.abs(el.getBoundingClientRect().top - document.querySelector('.cook-top').offsetHeight));
    ok((await atTop()) < 4, `the current step sits at the top (${Math.round(await atTop())}px off)`);
    ok((await page.$eval('.cf-step.is-next', (el) => el.dataset.at)) === '3', 'the next step is marked below it');
    await page.mouse.wheel(0, 300);
    await page.waitForFunction(() => document.querySelector('.cf-step.is-now')?.dataset.at === '3', null, { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(800); // let the snap settle
    ok((await nowStep()) === '3' && page.url().includes('step=3'), 'scrolling down makes the next step the current one');
    ok((await atTop()) < 4, `and it snaps to the top (${Math.round(await atTop())}px off)`);
    await page.click('.cf-step[data-at="1"] .cook-text');
    await page.waitForFunction(() => document.querySelector('.cf-step.is-now')?.dataset.at === '1', null, { timeout: 3000 }).catch(() => {});
    ok((await nowStep()) === '1', 'tapping a faded step brings it to the top');
    await page.waitForTimeout(800); // let the glide land
    await page.click('.cf-step.is-next .cook-text');
    await page.waitForFunction(() => document.querySelector('.cf-step.is-now')?.dataset.at === '2' && !document.querySelector('.cook.is-gliding'), null, { timeout: 3000 }).catch(() => {});
    ok((await nowStep()) === '2' && (await atTop()) < 4, `tapping the next step scrolls it to the top (now ${await nowStep()}, ${Math.round(await atTop())}px off)`);
    await page.click('.cf-step[data-at="1"] .cook-text');
    await page.waitForFunction(() => document.querySelector('.cf-step.is-now')?.dataset.at === '1', null, { timeout: 3000 }).catch(() => {});
    await page.click('#cook-next');
    await page.waitForFunction(() => document.querySelector('.cf-step.is-now')?.dataset.at === '2', null, { timeout: 3000 }).catch(() => {});
    ok((await nowStep()) === '2' && (await page.textContent('.cook-where')).startsWith('2 of '), 'Next scrolls to the next step');
    const skipped = await page.evaluate(async () => {
      const bar = document.querySelector('.cook-top').offsetHeight, wrong = [];
      for (const li of document.querySelectorAll('.cf-step')) {
        window.scrollTo(0, scrollY + li.getBoundingClientRect().top - bar);
        await new Promise((r) => setTimeout(r, 150));
        const now = document.querySelector('.cf-step.is-now')?.dataset.at;
        if (now !== li.dataset.at) wrong.push(`${li.dataset.at} showed ${now}`);
      }
      return wrong;
    });
    ok(!skipped.length, `the step at the top is always the current one${skipped.length ? ` (${skipped.join(', ')})` : ''}`);
    const last = await page.$$eval('.cf-step', (els) => els.length - 1);
    await page.click(`.cb-pill[data-at="${last}"]`);
    await page.waitForFunction((n) => document.querySelector('.cf-step.is-now')?.dataset.at === String(n), last, { timeout: 3000 }).catch(() => {});
    ok((await page.textContent('#cook-next')).includes('Finish'), 'on the last step Next becomes Finish');
    await page.click('#cook-mode'); // leave it in steps mode for the next test
    await page.close();

    const phone = await newPage({ viewport: { width: 375, height: 800 } });
    await phone.goto(`${BASE}/#/cook/01%20Breakfast/crepes`);
    await phone.waitForSelector('.cook-mise');
    await phone.click('#cook-next');
    await phone.waitForTimeout(50); // halfway through the slide-in
    const over = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok(over <= 0, `no sideways scroll while a step slides in on a phone (${over}px)`);
    const nav = await phone.$eval('.cook-where', (el) => { const r = el.getBoundingClientRect(); return Math.abs(r.left + r.width / 2 - innerWidth / 2); });
    ok(nav < 4, `the step count is centred on a phone (${Math.round(nav)}px off)`);
    await phone.close();
  }
}
