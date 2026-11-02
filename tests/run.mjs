// End-to-end tests in a real browser, split by feature.
//
//   node tests/run.mjs                    every area, on the fixture recipes
//   node tests/run.mjs list plan          only those areas
//   node tests/run.mjs --recipes "<dir>"  on another recipe folder (your own)
//   node tests/run.mjs --url http://localhost:8000 --recipes "<dir>"
//                                         against a site that is already running
//
// Without --url it starts scripts/dev.py on a free port, serving the site
// built from the recipe folder. Every area starts from a fresh fake Google
// Drive with the same recipes, so areas can run on their own and in any
// order. Nothing ever reaches the real Drive.
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import { fileURLToPath } from 'url';
import { t, ok, chromium, resetDrive } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const AREAS = ['viewer', 'cook', 'editor', 'signin', 'list', 'plan'];

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? null : args.splice(i, 2)[1]; };
let url = opt('--url');
t.RECIPES = path.resolve(opt('--recipes') || path.join(HERE, 'fixtures', 'recipes'));
const only = args.length ? args : AREAS;
const unknown = only.filter((a) => !AREAS.includes(a));
if (unknown.length) { console.error(`Unknown area ${unknown.join(', ')}. Areas: ${AREAS.join(', ')}`); process.exit(2); }

const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => res(port)); }); });

let server = null;
if (!url) {
  const port = await freePort();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'recipes-test-'));
  const python = process.platform === 'win32' ? 'python' : 'python3';
  server = spawn(python, [path.join(ROOT, 'scripts', 'dev.py')], {
    env: { ...process.env, RECIPES_DIR: t.RECIPES, DEV_OUT: out, PORT: String(port), PYTHONUNBUFFERED: '1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((res, rej) => {
    server.stdout.on('data', (d) => { if (String(d).includes('running at')) res(); });
    server.on('exit', (code) => { console.log(`dev.py stopped (${code})`); rej(new Error(`dev.py stopped (${code})`)); });
  });
  url = `http://localhost:${port}`;
  process.on('exit', () => { server.kill(); fs.rmSync(out, { recursive: true, force: true }); });
}
t.BASE = url.replace(/\/$/, '');
console.log(`Testing ${t.BASE} with ${t.RECIPES}\n`);

t.browser = await chromium.launch();
let crashed = false;
for (const area of only) {
  console.log(`---- ${area}`);
  resetDrive();
  try {
    await (await import(`./${area}.mjs`)).default();
  } catch (e) {
    // One area going wrong should not hide what the others find.
    ok(false, `${area} stopped: ${e.message.split('\n')[0]}`);
    console.log(e.stack);
    crashed = true;
  }
}
ok(t.errors.length === 0, `no page errors ${t.errors.length ? JSON.stringify(t.errors.slice(0, 5)) : ''}`);
await t.browser.close();
console.log(t.failures ? `\n${t.failures} FAILED${crashed ? ' (an area stopped early)' : ''}` : '\nALL PASSED');
process.exit(t.failures ? 1 : 0);
