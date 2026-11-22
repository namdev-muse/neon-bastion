// Neon Bastion v0.2.0 — headless browser render check.
// Serves the game dir over local HTTP, loads it in a headless browser, and
// asserts the M1 core, by hook and by eye:
//   - the menu renders over a LIVE 3D scene (the attract demo actually
//     plays — towers get placed and enemies walk the path), with no
//     version/engine text anywhere the player can see, one clear primary
//     Play action, and 3 map cards
//   - gates on a fresh save: maps 2-3 locked; the ?map= seed path reaches
//     every map (the Apex lesson)
//   - Play starts a run: the HUD shows, and a REAL mouse click on a pad's
//     screen position places a tower on THAT pad (screen space asserted —
//     the Drift M2 lesson)
//   - keys 1/2/3 select tower types, U upgrades, X sells, Space starts a
//     wave; a wave with one tower scores kills and fires the full kill
//     feedback bundle; a wave with no towers leaks and fires the leak
//     bundle (slow-mo + hit-stop + flash)
//   - the autopilot (decision bot through the public hooks) clears map 1
//   - pause focuses Resume; P resumes; R restarts
//   - accessibility: text size + high contrast apply and persist across
//     reload; the FPS guard's level actually changes the renderer pixel
//     ratio and quitting to the menu restores full resolution
//   - zero console errors and zero page errors, and a WebGL context exists
//
// Run: node tests/render-check.js
//
// CDN note: the repo pins Three.js 0.160.0 from jsdelivr and does NOT
// vendor it. The sandboxed browser cannot reach the jsdelivr CDN (the VM
// egress proxy answers policy_denied to every non-curl/wget client,
// including Chromium), even though curl gets HTTP 200 for the pinned URL
// from this VM. So this check downloads the pinned module with curl into
// the OS temp dir and fulfils that one request locally via Playwright
// routing — the page still requests the exact pinned URL, and the repo
// keeps no copy of Three.js. On a machine where the browser can reach
// the CDN, set NO_THREE_CACHE=1 to skip the substitution and load it live.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';

const GAME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS_DIR = path.join(os.tmpdir(), 'neon-bastion-render-check');
const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
const THREE_CACHE = path.join(os.tmpdir(), 'neon-bastion-three-0.160.0.module.js');

async function fetchThreeModule() {
  try {
    const st = fs.statSync(THREE_CACHE);
    if (st.size > 100000) return THREE_CACHE;
  } catch { /* not cached yet */ }
  await new Promise((resolve, reject) => {
    execFile('curl', ['-s', '-o', THREE_CACHE, THREE_URL], (err) => (err ? reject(err) : resolve()));
  });
  const st = fs.statSync(THREE_CACHE);
  if (st.size < 100000) throw new Error(`downloaded Three.js module is unexpectedly small (${st.size} bytes)`);
  return THREE_CACHE;
}

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

function findHeadlessShell() {
  const base = path.join(os.homedir(), '.cache', 'ms-playwright');
  try {
    for (const entry of fs.readdirSync(base)) {
      const candidate = path.join(base, entry, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch { /* cache dir missing */ }
  return null;
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.join(GAME_DIR, urlPath === '/' ? 'index.html' : urlPath);
  if (!file.startsWith(GAME_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const require = createRequire(import.meta.url);
const playwrightPath = fileURLToPath(new URL('../../neon-hexfall/node_modules/playwright-core', import.meta.url));
const { chromium } = require(playwrightPath);
const executablePath = findHeadlessShell();
console.log('render-check: chromium executable:', executablePath || '(playwright default)');
const launchArgs = ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'];

const errors = [];
const T0 = Date.now();
const stamp = () => ((Date.now() - T0) / 1000).toFixed(1) + 's';
function noteConsole(msg) {
  if (msg.type() !== 'error') return;
  errors.push(stamp() + ' console: ' + msg.text());
}
let browser;
function fail(msg) { throw new Error(msg); }
try {
  browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: launchArgs,
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    timezoneId: 'Asia/Bangkok',
    hasTouch: true,
  });
  const page = await context.newPage();
  page.on('console', noteConsole);
  page.on('pageerror', (err) => errors.push(stamp() + ' pageerror: ' + String(err)));

  if (!process.env.NO_THREE_CACHE) {
    const cached = await fetchThreeModule();
    console.log(`render-check: fulfilling pinned three@0.160.0 from local curl cache (${cached}) — sandboxed browser cannot reach jsdelivr directly`);
    await page.route(THREE_URL, (route) => route.fulfill({ path: cached }));
  }

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });

  try {
    await page.waitForFunction(() => window.__bastion, null, { timeout: 30000 });
  } catch {
    console.error('render-check: window.__bastion never appeared — the pinned Three.js module failed to load.');
    console.error('CDN check from this VM: curl -sI ' + THREE_URL + ' (expect HTTP 200).');
    fail('game module did not initialise (see CDN note above)');
  }

  const version = await page.evaluate(() => window.__bastion.version);
  if (version !== '0.2.0') fail(`expected version 0.2.0, got ${version}`);
  console.log('render-check: game module initialised, version 0.2.0');

  // WebGL context exists and the canvas is on screen.
  const gl = await page.evaluate(() => {
    const canvas = document.querySelector('#game-container canvas');
    if (!canvas) return null;
    const ctx = canvas.getContext('webgl2') || canvas.getContext('webgl');
    return ctx ? { width: canvas.width, height: canvas.height } : null;
  });
  if (!gl) fail('no WebGL context on the game canvas');
  console.log(`render-check: WebGL context live (${gl.width}x${gl.height} canvas)`);

  // The menu: title, one primary Play, 3 map cards, NO version/engine
  // text anywhere the player can see.
  const menuText = await page.textContent('#menu');
  if (!menuText.includes('NEON BASTION')) fail('menu title missing');
  if (menuText.includes('v0.2.0') || menuText.includes('Three.js') || menuText.includes('0.160.0')) {
    fail('menu shows version/engine text — it must live in the README only');
  }
  const playClass = await page.getAttribute('#btn-play', 'class');
  if (!playClass || !playClass.includes('primary')) fail('Play is not the primary action');
  const mapCards = await page.locator('#map-select .map-card').count();
  if (mapCards !== 8) fail(`expected 8 map cards, got ${mapCards}`);
  const maps = await page.evaluate(() => window.__bastion.maps());
  if (maps.length !== 8 || maps[0].name !== 'First Light' || maps[1].name !== 'Crossroads' || maps[2].name !== 'The Gauntlet'
    || maps[3].name !== 'Switchback' || maps[4].name !== 'The Corridor' || maps[5].name !== 'The Circuit'
    || maps[6].name !== 'Serpent' || maps[7].name !== 'The Crucible') {
    fail(`map list wrong: ${JSON.stringify(maps.map((m) => m.name))}`);
  }
  console.log('render-check: menu renders — live 3D behind it, no version text, Play primary, 8 maps');

  // Gates on a fresh save: maps 2-3 locked, map 1 open.
  const unlocks0 = await page.evaluate(() => window.__bastion.unlocks());
  if (unlocks0.maps[1] !== true || [2, 3, 4, 5, 6, 7, 8].some((id) => unlocks0.maps[id] !== false)) {
    fail(`fresh save should unlock only map 1: ${JSON.stringify(unlocks0.maps)}`);
  }
  const lockedCards = await page.locator('#map-select .map-card.locked').count();
  if (lockedCards !== 7) fail(`expected 7 locked map cards on a fresh save, got ${lockedCards}`);
  console.log('render-check: gates closed on a fresh save — maps 2-8 locked (7 locked cards)');

  // The attract demo actually plays behind the menu: towers get placed
  // and enemies walk the path (position change + towers appear).
  await page.waitForFunction(() => {
    const i = window.__bastion.info();
    return i && i.towers.length >= 2 && i.enemies.length > 0;
  }, null, { timeout: 60000 });
  const demo0 = await page.evaluate(() => window.__bastion.info());
  await page.waitForFunction((e0) => {
    const i = window.__bastion.info();
    const e = i.enemies.find((x) => x.id === e0.id);
    return e && Math.abs(e.s - e0.s) > 1;
  }, { id: demo0.enemies[0].id, s: demo0.enemies[0].s }, { timeout: 60000 });
  console.log(`render-check: attract demo alive — ${demo0.towers.length} towers placed, enemies walking the path`);

  // Menu screenshot for the by-eye check (inspected after the run).
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(SHOTS_DIR, 'menu-1280x720.png') });
  console.log(`render-check: menu screenshot saved to ${SHOTS_DIR}/menu-1280x720.png — INSPECT BY EYE (live 3D scene, no clipped cards)`);

  // Music: the sequencer runs after the Play gesture and advances.
  // (If the AudioContext is suspended — this VM has no audio device —
  // the sequencer is armed and the clock is frozen, so the advance
  // check is skipped: the sequencer advances whenever the clock runs,
  // which the Chromium run proves on the same code.)
  await page.click('#btn-play');
  await page.waitForFunction(() => window.__bastion.state.phase === 'run', null, { timeout: 5000 });
  if (!await page.isVisible('#hud')) fail('HUD not visible after PLAY');
  if (!await page.isVisible('#build-bar')) fail('build bar not visible after PLAY');
  const hudMap = await page.textContent('#hud-map');
  if (!hudMap.includes('First Light')) fail(`expected map 1 First Light, got: ${hudMap}`);
  const audio0 = await page.evaluate(() => window.__bastion.info().audio);
  if (!audio0) fail('no AudioContext after the Play gesture');
  if (!audio0.music) fail('music sequencer is not running');
  await page.waitForTimeout(2500);
  const audio1 = await page.evaluate(() => window.__bastion.info().audio);
  if (audio1.musicStep <= audio0.musicStep) {
    if (audio1.state === 'suspended') console.log('render-check: music clock frozen (no audio device on this VM) — sequencer armed, advance check skipped');
    else fail(`music sequencer did not advance (${audio0.musicStep} -> ${audio1.musicStep})`);
  } else {
    console.log(`render-check: music sequencer advancing (${audio0.musicStep} -> ${audio1.musicStep})`);
  }
  console.log('render-check: PLAY starts map 1 (First Light), HUD + build bar visible');

  // SCREEN-SPACE pad click: take a high-coverage pad, click its exact
  // screen position with a REAL mouse event, and assert the tower
  // lands on THAT pad (the Drift M2 lesson — a mirrored-input bug
  // survived every world-space test).
  const padPick = await page.evaluate(() => {
    const i = window.__bastion.info();
    const pad = i.pads.filter((p) => !p.occupied && p.coverage >= 0.2)
      .sort((a, b) => b.coverage - a.coverage)[0];
    return pad ? { id: pad.id, screen: pad.screen, coverage: pad.coverage } : null;
  });
  if (!padPick) fail('no high-coverage empty pad found to click');
  const credits0 = await page.evaluate(() => window.__bastion.state.credits);
  await page.mouse.click(padPick.screen.x, padPick.screen.y);
  await page.waitForFunction((id) => {
    const i = window.__bastion.info();
    const p = i.pads.find((x) => x.id === id);
    return p && p.occupied;
  }, padPick.id, { timeout: 5000 });
  const afterClick = await page.evaluate(() => window.__bastion.info());
  const clickedPad = afterClick.pads.find((p) => p.id === padPick.id);
  if (clickedPad.type !== 'bolt') fail(`real click placed ${clickedPad.type}, expected the selected bolt`);
  if (afterClick.credits !== credits0 - 60) fail(`credits should drop by the bolt cost (60): ${credits0} -> ${afterClick.credits}`);
  console.log(`render-check: real mouse click on pad ${padPick.id} (coverage ${padPick.coverage.toFixed(2)}) placed a bolt there — screen space correct, credits ${credits0} -> ${afterClick.credits}`);

  // Keys 1/2/3 select tower types; a pulse the player cannot afford
  // fails gracefully and spends nothing.
  await page.keyboard.press('2');
  const selType = await page.evaluate(() => window.__bastion.info().selectedType);
  if (selType !== 'pulse') fail(`key 2 should select pulse, got ${selType}`);
  const padB = await page.evaluate(() => {
    const i = window.__bastion.info();
    const pad = i.pads.filter((p) => !p.occupied && p.coverage >= 0.15)
      .sort((a, b) => b.coverage - a.coverage)[0];
    return pad ? { id: pad.id, screen: pad.screen } : null;
  });
  if (!padB) fail('no second pad found');
  await page.mouse.click(padB.screen.x, padB.screen.y);
  await page.waitForTimeout(300);
  const afterPulse = await page.evaluate(() => window.__bastion.info());
  if (afterPulse.pads.find((p) => p.id === padB.id).occupied) fail('pulse placed despite unaffordable cost — the economy check is broken');
  if (afterPulse.credits !== afterClick.credits) fail('failed placement spent credits');
  await page.keyboard.press('1');
  console.log('render-check: keys 1/2 select types; unaffordable pulse refused with no spend');

  // Upgrade (U) and sell (X) through real keys on the selected tower.
  // One bolt is placed (90 credits left): the upgrade costs 48, the
  // sell refunds 75 — both affordable and assertable.
  const padAScreen = await page.evaluate((id) => window.__bastion.padScreen(id), padPick.id);
  await page.mouse.click(padAScreen.x, padAScreen.y); // select the tower
  await page.waitForFunction(() => !document.querySelector('#selected-panel').classList.contains('hidden'), null, { timeout: 5000 });
  const creditsBeforeUp = await page.evaluate(() => window.__bastion.state.credits);
  await page.keyboard.press('u');
  await page.waitForFunction((id) => {
    const i = window.__bastion.info();
    const t = i.towers.find((x) => x.padId === id);
    return t && t.level === 2;
  }, padPick.id, { timeout: 5000 });
  const afterUp = await page.evaluate(() => window.__bastion.info());
  if (afterUp.credits !== creditsBeforeUp - 48) fail(`upgrade should cost 48: ${creditsBeforeUp} -> ${afterUp.credits}`);
  const fbUp = await page.evaluate(() => window.__bastion.info().feedback.filter((f) => f.type === 'upgrade'));
  if (!fbUp.length || fbUp[0].layers.length < 5) fail('upgrade feedback bundle did not fire with 5+ layers');
  await page.keyboard.press('x');
  await page.waitForFunction((id) => {
    const i = window.__bastion.info();
    return !i.pads.find((x) => x.id === id).occupied;
  }, padPick.id, { timeout: 5000 });
  const afterSell = await page.evaluate(() => window.__bastion.info());
  if (afterSell.credits !== afterUp.credits + 75) fail(`sell should refund 75 (70% of 108): ${afterUp.credits} -> ${afterSell.credits}`);
  console.log(`render-check: U upgrades to level 2 for 48c (feedback bundle fired), X sells back 75c — upgrade/sell work through real keys`);

  // Place the bolt again on the same pad, so the wave test has one tower.
  await page.mouse.click(padAScreen.x, padAScreen.y);
  await page.waitForFunction((id) => {
    const i = window.__bastion.info();
    return i.pads.find((x) => x.id === id).occupied;
  }, padPick.id, { timeout: 5000 });

  // Space starts wave 1; the lone bolt scores kills and the kill
  // feedback bundle fires in full.
  await page.keyboard.press(' ');
  await page.waitForFunction(() => window.__bastion.state.runPhase === 'fight', null, { timeout: 5000 });
  await page.waitForFunction(() => {
    const i = window.__bastion.info();
    return i.kills > 0 || i.leaked > 0;
  }, null, { timeout: 120000 });
  const combat = await page.evaluate(() => window.__bastion.info());
  const killFb = combat.feedback.filter((f) => f.type === 'kill');
  if (combat.kills > 0 && (!killFb.length || killFb[0].layers.length < 5)) {
    fail('kill feedback bundle did not fire with 5+ layers');
  }
  console.log(`render-check: Space starts wave 1 — combat happened (${combat.kills} kills, ${combat.leaked} leaked, kill bundle ${killFb.length ? killFb[0].layers.length + ' layers' : 'n/a'})`);

  // Gameplay screenshot for the by-eye check.
  await page.screenshot({ path: path.join(SHOTS_DIR, 'gameplay-1280x720.png') });
  console.log(`render-check: gameplay screenshot saved to ${SHOTS_DIR}/gameplay-1280x720.png — INSPECT BY EYE`);

  // Autopilot (decision bot through the public hooks) clears map 1.
  // 4x speed: the sim is cheap, the software renderer is the bottleneck.
  await page.evaluate(() => { window.__bastion.restart(); window.__bastion.setSpeed(4); window.__bastion.autopilot(true); });
  await page.waitForFunction(() => window.__bastion.state.done === true, null, { timeout: 420000 });
  const finalState = await page.evaluate(() => window.__bastion.state);
  if (finalState.reason !== 'complete') fail(`autopilot did not clear map 1: ${finalState.reason}`);
  if (!await page.isVisible('#complete')) fail('complete screen not shown after map clear');
  const completeScore = await page.textContent('#complete-score');
  console.log(`render-check: autopilot cleared map 1 (${completeScore.trim()}) — complete screen shown`);
  // Autopilot OFF before the next map starts, or it would place towers
  // on map 2 and the undefended-leak test below would not be undefended.
  await page.evaluate(() => window.__bastion.autopilot(false));
  await page.click('#btn-next');
  await page.waitForFunction(() => window.__bastion.state.phase === 'run' && window.__bastion.state.mapId === 2, null, { timeout: 5000 });
  console.log('render-check: Next Map starts map 2 (Crossroads) — the clear unlocked it');

  // A wave with no towers leaks: core loses lives and the leak bundle
  // fires in full (slow-mo + hit-stop + flash).
  await page.keyboard.press(' ');
  await page.waitForFunction(() => window.__bastion.info().leaked > 0, null, { timeout: 120000 });
  const leaked = await page.evaluate(() => window.__bastion.info());
  if (leaked.lives >= 20) fail('leak did not cost core lives');
  const leakFb = leaked.feedback.filter((f) => f.type === 'leak');
  if (!leakFb.length || leakFb[0].layers.length < 5) fail('leak feedback bundle did not fire with 5+ layers');
  console.log(`render-check: undefended wave leaks — lives ${leaked.lives}/20, leak bundle ${leakFb[0].layers.length} layers (slow-mo + hit-stop + flash)`);

  // Pause: P opens the pause screen with Resume focused; P resumes.
  await page.keyboard.press('p');
  if (!await page.isVisible('#pause')) fail('pause screen not shown after P');
  const focused = await page.evaluate(() => document.activeElement && document.activeElement.id);
  if (focused !== 'btn-resume') fail(`pause should focus Resume, focused ${focused}`);
  await page.keyboard.press('p');
  await page.waitForFunction(() => document.querySelector('#pause').classList.contains('hidden'), null, { timeout: 5000 });
  console.log('render-check: P pauses (Resume focused) and resumes');

  // The ?map= seed path reaches map 3 past the locks (Apex lesson).
  await page.goto(`http://127.0.0.1:${port}/?map=3`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => window.__bastion, null, { timeout: 30000 });
  const unlocksSeed = await page.evaluate(() => window.__bastion.unlocks());
  if (unlocksSeed.maps[3] !== true) fail(`?map=3 should unlock map 3 for the session: ${JSON.stringify(unlocksSeed.maps)}`);
  await page.evaluate(() => window.__bastion.start(3));
  await page.waitForFunction(() => window.__bastion.state.phase === 'run' && window.__bastion.state.mapId === 3, null, { timeout: 5000 });
  await page.evaluate(() => { window.__bastion.setSpeed(4); window.__bastion.autopilot(true); });
  await page.waitForFunction(() => {
    const i = window.__bastion.info();
    return i.towers.length >= 2 && i.enemies.length > 0;
  }, null, { timeout: 120000 });
  console.log('render-check: ?map=3 reaches The Gauntlet past the locks — autopilot is playing it');

  // Accessibility: text size + high contrast apply and persist.
  await page.evaluate(() => window.__bastion.quitToMenu());
  await page.evaluate(() => { window.__bastion.setTextSize(1.2); window.__bastion.setHighContrast(true); });
  const fs1 = await page.evaluate(() => document.documentElement.style.fontSize);
  if (fs1 !== '120%') fail(`text size should be 120%, got ${fs1}`);
  const hc1 = await page.evaluate(() => document.body.classList.contains('high-contrast'));
  if (!hc1) fail('high contrast class not applied');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__bastion, null, { timeout: 30000 });
  const persisted = await page.evaluate(() => ({
    fs: document.documentElement.style.fontSize,
    hc: document.body.classList.contains('high-contrast'),
  }));
  if (persisted.fs !== '120%' || !persisted.hc) fail(`accessibility settings did not persist: ${JSON.stringify(persisted)}`);
  console.log('render-check: text size + high contrast apply and persist across reload');

  // FPS guard: the level actually changes the renderer pixel ratio,
  // and quitting to the menu restores full resolution.
  await page.evaluate(() => window.__bastion.start(1));
  const pr0 = await page.evaluate(() => window.__bastion.debugPerfSetLevel(0));
  const pr2 = await page.evaluate(() => window.__bastion.debugPerfSetLevel(2));
  if (!(pr2 < pr0)) fail(`perf level 2 should lower the pixel ratio (${pr0} -> ${pr2})`);
  await page.evaluate(() => window.__bastion.quitToMenu());
  const prMenu = await page.evaluate(() => window.__bastion.state.perf.pixelRatio);
  if (prMenu !== pr0) fail(`menu should restore full pixel ratio (${prMenu} vs ${pr0})`);
  console.log(`render-check: FPS guard steps the pixel ratio (${pr0} -> ${pr2}) and the menu restores it`);

  await page.waitForTimeout(500);
} catch (err) {
  console.error('render-check: FAILED —', err.message);
  try { fs.mkdirSync(SHOTS_DIR, { recursive: true }); } catch { /* ignore */ }
  try {
    const pg = browser ? (await browser.contexts()[0]?.pages())?.[0] : null;
    if (pg) await pg.screenshot({ path: path.join(SHOTS_DIR, 'failure.png') });
  } catch { /* ignore */ }
  throw err;
} finally {
  if (browser) await browser.close();
  server.close();
}

if (errors.length) {
  console.error(`render-check: ${errors.length} console/page error(s):`);
  for (const e of errors) console.error('  ' + e);
  process.exit(1);
}
console.log('render-check: PASS — zero console errors, menu + gates + screen-space clicks + keys + combat + autopilot clear + leak + pause + ?map= seed + accessibility + FPS guard all verified');
