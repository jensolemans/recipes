// The editor against the fake Drive: edit, conflicts, unsaved changes,
// new, move, rename, delete, and a new recipe from Claude's reply.
import fs from 'fs';
import path from 'path';
import { t, ok, until2, untilOn, watch, newPage, signedIn, files, byName, driveRoute, fakeGis, fakeConfig, recipesJson, hashPath, PNG } from './lib.mjs';

export default async function () {
  const { BASE, RECIPES, browser } = t;
  const crepesFolder = byName('ROOT', '01 Breakfast').id;

  // 5. editor against fake Drive
  {
    const ctx = await signedIn({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    watch(page);
    await page.goto(`${BASE}/#/`);
    await page.waitForSelector('a[href="#/new"]', { timeout: 15000 });
    ok(true, 'signed-in session goes live');
    ok(await page.isVisible('text=Crêpes (from Drive)'), 'change made in Drive shows up live');

    // edit crepes
    await page.goto(`${BASE}/#/edit/01%20Breakfast/crepes`);
    await page.waitForSelector('#src');
    const src = await page.inputValue('#src');
    await page.fill('#src', src.replace('@egg{3}', '@egg{4}'));
    await page.waitForTimeout(300);
    ok((await page.textContent('#preview')).includes('egg'), 'preview renders');
    await page.click('#save');
    try { await page.waitForSelector('.recipe', { timeout: 8000 }); } catch { console.log('TOAST:', await page.textContent('#toast'), 'DIALOG:', await page.textContent('dialog')); throw new Error('save failed'); }
    const saved = byName(crepesFolder, 'crepes.cook').content.toString();
    ok(saved.includes('@egg{4}'), 'edit saved to Drive');
    ok(await page.$eval('.ing-list', (ul) => ul.textContent.includes('4')), 'recipe page shows the saved version');

    // conflict detection
    await page.goto(`${BASE}/#/edit/01%20Breakfast/crepes`);
    await page.waitForSelector('#src');
    byName(crepesFolder, 'crepes.cook').content = Buffer.from(saved + '\n> Edited on phone\n');
    await page.fill('#src', (await page.inputValue('#src')) + '\n> Edited on web\n');
    await page.click('#save');
    await page.waitForSelector('dialog[open]');
    ok((await page.textContent('dialog')).includes('changed in Google Drive'), 'warns when the file changed elsewhere');
    await page.click('dialog button:has-text("Cancel")');
    ok(byName(crepesFolder, 'crepes.cook').content.toString().includes('Edited on phone'), 'cancel keeps the Drive version');

    // unsaved-changes guard
    await page.click('.editor-x');
    await page.waitForSelector('dialog[open]');
    await page.click('dialog button:has-text("Keep editing")');
    ok(await page.isVisible('#src'), 'Keep editing stays in the editor');
    await page.click('.editor-x');
    ok(await page.waitForSelector('dialog[open]', { timeout: 3000 }).then(() => true, () => false), 'and the close button asks again the next time');
    await page.click('dialog button:has-text("Discard changes")');
    await page.waitForSelector('.recipe');
    ok(true, 'leaving with unsaved changes asks first');

    // new recipe with photo
    await page.goto(`${BASE}/#/new`);
    await page.waitForSelector('#src');
    await page.selectOption('#folder', '10 Drinks');
    await page.fill('#src', '---\ntitle: Test Spritz\nservings: 2\ntime: 5m\n---\n\nPour @prosecco{90%ml} over @ice{} in a #wine glass{}.\n');
    await page.waitForTimeout(400);
    ok(await page.inputValue('#file') === 'test_spritz', 'file name follows the title');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    await page.setInputFiles('#photo', { name: 'photo.png', mimeType: 'image/png', buffer: png });
    await page.waitForTimeout(500);
    await page.click('#save');
    await page.waitForSelector('.recipe[data-path="10 Drinks/test_spritz"]');
    const drinks = byName('ROOT', '10 Drinks').id;
    ok(Boolean(byName(drinks, 'test_spritz.cook')), 'new recipe created in Drive');
    const photo = byName(drinks, 'test_spritz.jpg');
    ok(Boolean(photo) && photo.content[0] === 0xff && photo.content[1] === 0xd8, 'photo uploaded as JPEG next to it');

    // move + rename
    await page.goto(`${BASE}/#/edit/10%20Drinks/test_spritz`);
    await page.waitForSelector('#src');
    await page.selectOption('#folder', '07 Basics');
    await page.fill('#file', 'spritz_test');
    await page.click('#save');
    await page.waitForSelector('.recipe[data-path="07 Basics/spritz_test"]');
    const sauces = byName('ROOT', '07 Basics').id;
    ok(Boolean(byName(sauces, 'spritz_test.cook')) && Boolean(byName(sauces, 'spritz_test.jpg')), 'move and rename keeps the photo with the recipe');

    // delete
    await page.goto(`${BASE}/#/edit/07%20Basics/spritz_test`);
    await page.waitForSelector('#del');
    await page.click('#del');
    await page.click('dialog button:has-text("Move to trash")');
    await page.waitForSelector('.home');
    ok(!byName(sauces, 'spritz_test.cook') && !byName(sauces, 'spritz_test.jpg'), 'delete moves recipe and photo to trash');
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/live-home.png` });
    await page.goto(`${BASE}/#/edit/05%20Mains/Curry/aloo_gobi`);
    await page.waitForSelector('#preview .step');
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/editor.png` });
    await ctx.close();
  }

  // 11. a new recipe from Claude's reply, with a pasted or linked photo
  {
    const ctx = await signedIn({ viewport: { width: 1280, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    // One photo site lets other sites download its photos, the other does not.
    await ctx.route('https://photos.example.test/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: png }));
    // Playwright answers routed requests without the browser's cross-site check, so
    // the blocked site is a refused request, which reaches the page the same way.
    await ctx.route('https://closed.example.test/**', (r) => r.abort('accessdenied'));
    const page = await ctx.newPage();
    watch(page);
    await page.goto(`${BASE}/#/`);
    await page.waitForSelector('a[href="#/new"]', { timeout: 15000 });
    await page.goto(`${BASE}/#/new`);
    await page.waitForSelector('#src');

    const reply = (title, course, tags) => `Here is the recipe in Cooklang:\n\n\`\`\`cooklang\n---\ntitle: ${title}\ndescription: A test.\ncourse: ${course}\ncuisine: indian\ndiet: meat\ntags: [${tags}]\nservings: 4\n---\n\nFry the @chicken thighs{500%g} with @garam masala{2%tsp}.\n\`\`\`\n\n**Conversion notes**\n- Converted cups to grams.\n`;
    await page.evaluate((text) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      document.querySelector('#src').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, reply('Chicken Tikka Test', 'main', 'chicken, curry'));
    const src = await page.inputValue('#src');
    ok(src.startsWith('---') && src.includes('@chicken thighs') && !src.includes('Conversion notes') && !src.includes('```'), 'pasting Claude\'s reply keeps only the recipe');
    ok((await page.textContent('#toast')).includes("Took the recipe out of Claude's reply"), 'and says so');
    ok(await page.inputValue('#folder') === '05 Mains/Curry', `the category follows the course and tags (${await page.inputValue('#folder')})`);
    ok(await page.inputValue('#file') === 'chicken_tikka_test', 'the file name follows the title');

    await page.evaluate((b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'photo.png', { type: 'image/png' }));
      document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, png.toString('base64'));
    ok(await page.waitForSelector('#photo-thumb img', { timeout: 3000 }).then(() => true, () => false), 'a pasted photo becomes the recipe photo');

    await page.click('#photo-link');
    await page.fill('#ask-text', 'https://closed.example.test/dish.png');
    await page.click('dialog button:has-text("Add")');
    ok(await until2(page, () => page.textContent('#toast').then((t) => t.includes('use Paste photo instead'))), 'a site that blocks downloads says to paste the photo instead');
    await page.click('#photo-link');
    await page.fill('#ask-text', 'https://photos.example.test/dish.png');
    await page.click('dialog button:has-text("Add")');
    ok(await until2(page, () => page.textContent('#toast').then((t) => t.includes('Photo added'))), 'a photo link from a site that allows it is added');

    // The Paste recipe button reads the clipboard and asks before replacing.
    await page.evaluate((text) => navigator.clipboard.writeText(text), reply('Lentil Soup Test', 'soup', 'lentils'));
    await page.click('#paste-recipe');
    await page.click('dialog button:has-text("Replace")');
    ok(await until2(page, () => page.inputValue('#src').then((v) => v.includes('title: Lentil Soup Test') && !v.includes('Chicken Tikka'))), 'Paste recipe replaces the text after asking');
    ok(await page.inputValue('#folder') === '03 Soups' && await page.inputValue('#file') === 'lentil_soup_test', 'and the category and file name follow the new recipe');
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/editor-paste.png` });

    await page.click('#save');
    await page.waitForSelector('.recipe[data-path="03 Soups/lentil_soup_test"]', { timeout: 8000 });
    const soups = byName('ROOT', '03 Soups').id;
    ok(Boolean(byName(soups, 'lentil_soup_test.cook')) && Boolean(byName(soups, 'lentil_soup_test.jpg')), 'saving puts the recipe and its photo in the chosen category');
    await page.goto(`${BASE}/#/edit/03%20Soups/lentil_soup_test`);
    await page.waitForSelector('#del');
    await page.click('#del');
    await page.click('dialog button:has-text("Move to trash")');
    await page.waitForSelector('.home');
    await ctx.close();
  }
}
