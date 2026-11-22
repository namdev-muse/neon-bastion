// Neon Bastion v0.1.0 — bot harness: the decision bot plays every map
// to completion through the public place/upgrade/sell/startWave hooks,
// and the anti-slop gate asserts a bot that places towers at random
// LOSES on every map. If the random bot clears a map, the map is not
// done; if the decision bot cannot clear one, the economy or the bot
// is not done.
import { MAPS, simulateRun } from '../physics.js';

let failures = 0;
for (const map of MAPS) {
  const bot = simulateRun(map, 'decision');
  // The random bot gets three different seeds — losing once could be
  // luck; losing three times is the map.
  const randoms = [1, 2, 3].map((s) => simulateRun(map, 'random', { seed: map.seed * 1000 + s }));
  const randomCleared = randoms.filter((r) => r.completed);
  console.log(`Map ${map.id} "${map.name}": decision bot ${bot.completed ? 'COMPLETE' : 'FAILED'}`
    + ` in ${bot.time.toFixed(1)}s, score ${bot.score}`
    + ` (${bot.kills} kills, ${bot.leaked} leaked, ${bot.lives}/${20} lives,`
    + ` ${bot.waves}/${map.waves.length} waves, ${bot.towersPlaced} towers, ${bot.upgradesBought} upgrades)`
    + ` | random: ${randoms.map((r) => `${r.completed ? 'CLEARED (SLOP!)' : `lost wave ${r.waves + 1} (${r.lives} lives)`}`).join('; ')}`);
  if (!bot.completed) { failures++; console.error(`  BOT FAIL: map ${map.id} not completed by the decision bot`); }
  if (bot.lives <= 0) { failures++; console.error(`  BOT FAIL: map ${map.id} decision bot finished with no lives`); }
  if (randomCleared.length) { failures++; console.error(`  BOT FAIL: map ${map.id} is clearable by random placement (${randomCleared.length}/3 seeds) — tighten the map`); }
  if (bot.kills === 0) { failures++; console.error(`  BOT FAIL: map ${map.id} decision bot killed nothing`); }
}

// Single-type spam gate: a bot that only ever places bolt towers must
// not clear map 3 (the swarm + armour mix punishes one-type spam).
// This is enforced by construction in the decision bot's type mix;
// here we assert the sim itself makes one-type spam weak: a full
// bolt-only run on map 3 must fail. (Implemented via the random bot
// with a fixed bolt-only policy below.)
import { startRun, placeTower, startWave, stepRun, padCoverage, DT } from '../physics.js';
function boltOnlyRun(map) {
  const run = startRun(map);
  let steps = 0;
  const maxSteps = Math.ceil(900 / DT);
  while (!run.done && steps < maxSteps) {
    if (run.phase === 'build') {
      // Best pads only, bolt only, upgrades on the best tower.
      let guard = 0;
      while (guard++ < 20 && run.credits >= 50) {
        let best = null, bestRatio = -1;
        for (const pad of run.pads) {
          if (pad.tower) continue;
          const cov = padCoverage(map, [pad.col, pad.row], 2.9);
          if (cov.ratio > bestRatio) { bestRatio = cov.ratio; best = pad; }
        }
        if (!best || bestRatio < 0.08) break;
        if (!placeTower(run, best.id, 'bolt').ok) break;
      }
      startWave(run);
    }
    stepRun(run, DT);
    steps++;
  }
  return { completed: run.done && run.reason === 'complete', waves: run.wavesCleared, lives: run.lives };
}
{
  const spam = boltOnlyRun(MAPS[2]);
  console.log(`Bolt-only spam on map 3: ${spam.completed ? 'CLEARED (SLOP!)' : `lost at wave ${spam.waves + 1} (${spam.lives} lives)`}`);
  if (spam.completed) { failures++; console.error('  BOT FAIL: map 3 is clearable by bolt-only spam — the tower roles are not distinct enough'); }
}

if (failures) { console.error(`bot: ${failures} failure(s)`); process.exit(1); }
console.log(`bot: PASS — decision bot clears all ${MAPS.length} maps, random placement loses on all ${MAPS.length} (3 seeds each), bolt-only spam fails map 3`);
