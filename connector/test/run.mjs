// Runs the connector tests: `npm test` in connector/.
// Starts the fake Google, Drive and recipe site (fake-google.mjs) and the
// Worker itself with `wrangler dev`, pointed at the fakes, with empty storage.
// Then runs signin.test.mjs and connector.test.mjs, and stops everything
// again, child processes included (on Windows, workerd outlives a plain kill).
// Never touches the real Drive folder. It only reads tools/cooklint.py from
// the synced folder (recipesDir in local.json), the one copy of the house style.
import { spawn, execSync } from 'child_process';
import { createRequire } from 'module';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONNECTOR = path.dirname(HERE);
const ROOT = path.dirname(CONNECTOR);
const WORKER = 'http://127.0.0.1:8787';
const FAKE = 'http://localhost:8799';
const kids = [];

function stopAll() {
  for (const p of kids) {
    if (p.exitCode !== null) continue;
    try {
      if (process.platform === 'win32') execSync(`taskkill /F /T /PID ${p.pid}`, { stdio: 'ignore' });
      else process.kill(-p.pid, 'SIGTERM');
    } catch { /* already gone */ }
  }
}
process.on('SIGINT', () => { stopAll(); process.exit(130); });

const portFree = (port) => new Promise((resolve) => {
  const s = net.createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true)));
  s.listen(port, '127.0.0.1');
});

async function waitFor(url, what, proc) {
  for (let i = 0; i < 120; i++) {
    if (proc.exitCode !== null) throw new Error(`${what} stopped before it was ready.`);
    try { await fetch(url, { signal: AbortSignal.timeout(1500) }); return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${what} did not start in time.`);
}

function start(cmd, args, opts = {}) {
  const p = spawn(cmd, args, { cwd: CONNECTOR, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  let log = '';
  p.stdout.on('data', (d) => { log += d; });
  p.stderr.on('data', (d) => { log += d; });
  p.log = () => log;
  kids.push(p);
  return p;
}

function runTest(file) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(HERE, file)], { stdio: 'inherit' });
    p.on('exit', (code) => resolve(code === 0));
  });
}

async function photos() {
  const dir = path.join(HERE, '.site');
  if (fs.existsSync(path.join(dir, 'tall.png'))) return;
  fs.mkdirSync(dir, { recursive: true });
  const sharp = createRequire(import.meta.url)('sharp');
  const make = (w, h, bg) => sharp({ create: { width: w, height: h, channels: 3, background: bg } })
    .composite([{ input: Buffer.from(`<svg width="${w}" height="${h}"><circle cx="${w / 2}" cy="${h / 2}" r="${h / 3}" fill="#E77B54"/></svg>`) }]);
  await make(2400, 1600, '#335').jpeg({ quality: 95 }).toFile(path.join(dir, 'big.jpg'));
  await make(600, 400, '#353').jpeg().toFile(path.join(dir, 'small.jpg'));
  await make(1000, 1400, '#533').png().toFile(path.join(dir, 'tall.png'));
}

let ok = false;
let store = '';
try {
  const settings = JSON.parse(fs.readFileSync(path.join(ROOT, 'local.json'), 'utf8'));
  const lint = path.join(settings.recipesDir, 'tools', 'cooklint.py');
  if (!fs.existsSync(lint)) throw new Error(`cooklint.py not found at ${lint}. Check recipesDir in local.json.`);
  for (const port of [8787, 8799]) {
    if (!(await portFree(port))) throw new Error(`Port ${port} is in use. Stop the other local Worker or fake first.`);
  }
  await photos();

  const fake = start(process.execPath, [path.join(HERE, 'fake-google.mjs'), lint]);
  await waitFor(`${FAKE}/files`, 'The fake Google', fake);

  const vars = {
    GOOGLE_CLIENT_SECRET: 'test-secret',
    TOKEN_KEY: crypto.randomBytes(32).toString('base64url'),
    GOOGLE_AUTH_URL: `${FAKE}/auth`,
    GOOGLE_TOKEN_URL: `${FAKE}/token`,
    DRIVE_API: `${FAKE}/drive/v3`,
    DRIVE_UPLOAD: `${FAKE}/upload/drive/v3`,
    GDRIVE_FOLDER_ID: 'ROOT',
    PUBLIC_URL: WORKER,
  };
  store = fs.mkdtempSync(path.join(os.tmpdir(), 'recipes-connector-test-'));
  const wrangler = path.join(CONNECTOR, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const worker = start(process.execPath, [wrangler, 'dev', '--port', '8787', '--ip', '127.0.0.1', '--persist-to', store,
    ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`])]);
  try {
    await waitFor(`${WORKER}/`, 'The local Worker', worker);
  } catch (e) {
    console.error(worker.log().slice(-2000));
    throw e;
  }

  const results = [];
  for (const file of ['signin.test.mjs', 'connector.test.mjs']) {
    console.log(`\n# ${file}`);
    await fetch(`${FAKE}/reset`);
    results.push(await runTest(file));
  }
  ok = results.every(Boolean);
} catch (e) {
  console.error(`\n${e.message}`);
} finally {
  stopAll();
  // After the Worker stopped: Windows keeps its files locked until then.
  if (store) fs.rmSync(store, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
console.log(ok ? '\nALL PASSED' : '\nFAILED');
process.exit(ok ? 0 : 1);
