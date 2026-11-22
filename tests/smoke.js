// Neon Bastion v0.1.0 — Node smoke tests for physics.js (no DOM, no Three.js).
import {
  VERSION, MAPS, mapById, mapGeometry, pathPosition, padCoverage,
  totalEnemiesInMap, mapThreat, waveBonus,
  GRID_COLS, GRID_ROWS, CELL, START_CREDITS, CORE_LIVES, MAX_TOWER_LEVEL,
  SELL_REFUND, TOWER_DEFS, TOWER_ORDER, towerStats, upgradeCost, towerInvested, sellValue,
  ENEMY_DEFS, FEEDBACK, FEEDBACK_TIERS, FEEDBACK_LAYERS,
  isMapUnlocked, createRun, startRun, placeTower, upgradeTower, sellTower,
  startWave, stepRun, simulateRun, decisionBuild, randomBuild,
  PERF_LEVELS, PERF_FPS_THRESHOLD, PERF_LOW_MS, perfGuardStep,
  mulberry32, clamp, cellToWorld, worldToCell,
  defaultSave, serializeSave, parseSave, recordBest, SAVE_VERSION,
} from '../physics.js';

let passed = 0, failed = 0;
const failures = [];
function check(name, cond) {
  if (cond) passed++;
  else { failed++; failures.push(name); console.error('FAIL:', name); }
}

check('physics version is 0.2.0', VERSION === '0.2.0');
check('8 maps defined', MAPS.length === 8);
check('map ids are 1..8 in order', MAPS.every((m, i) => m.id === i + 1));
check('every map has a name and a hint', MAPS.every((m) => m.name && m.hint));
check('every map has a distinct theme ring', new Set(MAPS.map((m) => m.theme.ring)).size === 8);
check('every map has a distinct theme disc', new Set(MAPS.map((m) => m.theme.disc)).size === 8);
check('every map has 6 waves', MAPS.every((m) => m.waves.length === 6));
check('every map is dense (40+ enemies)', MAPS.every((m) => totalEnemiesInMap(m) >= 40));
check('threat grows with difficulty', MAPS.every((m, i) => i === 0 || mapThreat(m) > mapThreat(MAPS[i - 1])));
check('mapById finds map 2', mapById(2) && mapById(2).name === 'Crossroads');
check('mapById returns null for unknown id', mapById(99) === null);
check('every wave has at least one spawn group', MAPS.every((m) => m.waves.every((w) => w.groups.length >= 1)));
check('map 1 wave 1 teaches: grunts only', MAPS[0].waves[0].groups.every((g) => g.type === 'grunt'));
check('every map ends with a boss wave', MAPS.every((m) => m.waves[5].groups.some((g) => g.type === 'boss')));

// --- map geometry ---
for (const map of MAPS) {
  const geo = mapGeometry(map);
  check(`map ${map.id} path has 5+ waypoints`, map.path.length >= 5);
  check(`map ${map.id} path is axis-aligned (no diagonals)`, map.path.every((p, i) => i === 0
    || p[0] === map.path[i - 1][0] || p[1] === map.path[i - 1][1]));
  check(`map ${map.id} path stays in the grid`, map.path.every(([c, r]) => c >= 0 && c < GRID_COLS && r >= 0 && r < GRID_ROWS));
  check(`map ${map.id} path starts and ends on an edge`, (() => {
    const [c0, r0] = map.path[0];
    const [c1, r1] = map.path[map.path.length - 1];
    const edge = ([c, r]) => c === 0 || c === GRID_COLS - 1 || r === 0 || r === GRID_ROWS - 1;
    return edge([c0, r0]) && edge([c1, r1]);
  })());
  check(`map ${map.id} path is 25+ cells long`, geo.lengthCells >= 25);
  check(`map ${map.id} has 15+ pads`, map.pads.length >= 15);
  check(`map ${map.id} pads are in the grid`, map.pads.every(([c, r]) => c >= 0 && c < GRID_COLS && r >= 0 && r < GRID_ROWS));
  check(`map ${map.id} no pad sits on the path`, (() => {
    const pathSet = new Set(geo.cells.map(([c, r]) => `${c},${r}`));
    return map.pads.every(([c, r]) => !pathSet.has(`${c},${r}`));
  })());
  check(`map ${map.id} no duplicate pads`, new Set(map.pads.map(([c, r]) => `${c},${r}`)).size === map.pads.length);
  check(`map ${map.id} has pads with real coverage and pads with almost none`, (() => {
    const ratios = map.pads.map((p) => padCoverage(map, p, 3.2).ratio);
    return Math.max(...ratios) >= 0.2 && Math.min(...ratios) <= 0.08;
  })());
  check(`map ${map.id} pathPosition starts at the entry`, (() => {
    const p0 = pathPosition(map, 0);
    const e = cellToWorld(map.path[0][0], map.path[0][1]);
    return Math.abs(p0.x - e.x) < 1e-9 && Math.abs(p0.z - e.z) < 1e-9;
  })());
  check(`map ${map.id} pathPosition ends at the core`, (() => {
    const p1 = pathPosition(map, geo.length);
    const e = cellToWorld(map.path[map.path.length - 1][0], map.path[map.path.length - 1][1]);
    return Math.abs(p1.x - e.x) < 1e-9 && Math.abs(p1.z - e.z) < 1e-9;
  })());
}

// --- grid helpers ---
check('cellToWorld centres the grid', (() => {
  const c = cellToWorld(0, 0);
  return c.x === -(GRID_COLS - 1) / 2 * CELL && c.z === -(GRID_ROWS - 1) / 2 * CELL;
})());
check('worldToCell round-trips', (() => {
  const w = cellToWorld(7, 4);
  const c = worldToCell(w.x, w.z);
  return c.col === 7 && c.row === 4;
})());

// --- tower defs: three distinct roles, not reskins ---
check('three tower types defined', Object.keys(TOWER_DEFS).length === 3 && TOWER_ORDER.length === 3);
for (const [type, def] of Object.entries(TOWER_DEFS)) {
  check(`${type} has 3 levels`, def.levels.length === 3);
  check(`${type} damage grows with level`, def.levels[0].damage < def.levels[1].damage && def.levels[1].damage < def.levels[2].damage);
  check(`${type} range grows with level`, def.levels[0].range < def.levels[2].range);
}
check('bolt is the fastest firing tower', TOWER_DEFS.bolt.levels[0].rate > TOWER_DEFS.pulse.levels[0].rate && TOWER_DEFS.bolt.levels[0].rate > TOWER_DEFS.frost.levels[0].rate);
check('bolt is the longest range tower', TOWER_DEFS.bolt.levels[0].range > TOWER_DEFS.pulse.levels[0].range && TOWER_DEFS.bolt.levels[0].range > TOWER_DEFS.frost.levels[0].range);
check('pulse is the only AoE tower', TOWER_DEFS.pulse.levels[0].aoe > 0 && !TOWER_DEFS.bolt.levels[0].aoe && !TOWER_DEFS.frost.levels[0].aoe);
check('frost is the only slowing tower', TOWER_DEFS.frost.levels[0].slow > 0 && !TOWER_DEFS.bolt.levels[0].slow && !TOWER_DEFS.pulse.levels[0].slow);
check('pulse costs the most (swarm power is expensive)', TOWER_DEFS.pulse.cost > TOWER_DEFS.bolt.cost && TOWER_DEFS.pulse.cost > TOWER_DEFS.frost.cost);
check('bolt is the cheapest tower', TOWER_DEFS.bolt.cost < TOWER_DEFS.frost.cost);
check('starting credits buy a real opening (two bolts, with change)', START_CREDITS >= 2 * TOWER_DEFS.bolt.cost);
check('upgrade cost is null at max level', upgradeCost('bolt', 3) === null);
check('upgrade cost grows with level', upgradeCost('bolt', 1) < upgradeCost('bolt', 2));
check('sell refunds 70% of invested', sellValue('bolt', 1) === Math.floor(TOWER_DEFS.bolt.cost * SELL_REFUND));
check('towerStats returns level stats', towerStats('pulse', 2).damage === 8 && towerStats('pulse', 2).aoe === 1.6);
check('towerStats returns null for unknown type', towerStats('nope', 1) === null);

// --- enemy defs ---
check('four enemy types defined', Object.keys(ENEMY_DEFS).length === 4);
check('runner is faster than grunt', ENEMY_DEFS.runner.speed > ENEMY_DEFS.grunt.speed);
check('armored is tougher than grunt', ENEMY_DEFS.armored.hp > ENEMY_DEFS.grunt.hp);
check('boss is the toughest and costs the most lives', ENEMY_DEFS.boss.hp > ENEMY_DEFS.armored.hp && ENEMY_DEFS.boss.damage === 5);
check('boss reward is the biggest', ENEMY_DEFS.boss.reward > ENEMY_DEFS.armored.reward);

// --- feedback contract ---
for (const [name, fb] of Object.entries(FEEDBACK)) {
  const tier = FEEDBACK_TIERS[fb.tier];
  check(`feedback ${name} trauma is inside its tier`, fb.trauma >= tier.traumaMin && fb.trauma <= tier.traumaMax);
  check(`feedback ${name} hit-stop is inside its tier`, fb.hitStop >= tier.stopMin && fb.hitStop <= tier.stopMax);
  check(`feedback ${name} carries 5+ layers`, (FEEDBACK_LAYERS[name] || []).length >= 5);
}
check('leak is a large event (slow-mo + hit-stop)', FEEDBACK.leak.tier === 'large' && FEEDBACK.leak.hitStop >= 0.10);
check('mapLost is a large event', FEEDBACK.mapLost.tier === 'large');

// --- run state + placement ---
{
  const run = startRun(MAPS[0]);
  check('run starts with start credits', run.credits === START_CREDITS);
  check('run starts with full core lives', run.lives === CORE_LIVES);
  check('run starts in the build phase', run.phase === 'build');
  check('run starts on wave 1', run.waveIndex === 0);
  check('run is not done at start', !run.done);
  check('run has one pad per map pad', run.pads.length === MAPS[0].pads.length);
  const pad = run.pads[0];
  const r1 = placeTower(run, pad.id, 'bolt');
  check('placing a bolt tower succeeds', r1.ok);
  check('placing spends the cost', run.credits === START_CREDITS - TOWER_DEFS.bolt.cost);
  check('tower is on the pad', pad.tower && pad.tower.type === 'bolt' && pad.tower.level === 1);
  check('placing on an occupied pad fails', !placeTower(run, pad.id, 'bolt').ok);
  check('placing an unknown type fails', !placeTower(run, run.pads[1].id, 'nope').ok);
  check('placing on an unknown pad fails', !placeTower(run, 999, 'bolt').ok);
  run.credits = 1000; // upgrades are exercised here, not the economy
  const r2 = upgradeTower(run, pad.id);
  check('upgrading succeeds', r2.ok && pad.tower.level === 2);
  check('upgrading spends the upgrade cost', run.credits === 1000 - upgradeCost('bolt', 1));
  upgradeTower(run, pad.id);
  check('upgrading to max level succeeds', pad.tower.level === 3);
  check('upgrading past max fails', !upgradeTower(run, pad.id).ok);
  const invested = towerInvested('bolt', 3);
  const r3 = sellTower(run, pad.id);
  check('selling succeeds and refunds 70%', r3.ok && r3.value === Math.floor(invested * SELL_REFUND));
  check('selling frees the pad', pad.tower === null && run.towers.length === 0);
  check('selling an empty pad fails', !sellTower(run, pad.id).ok);
  check('upgrading an empty pad fails', !upgradeTower(run, pad.id).ok);
}
{
  // Not enough credits.
  const run = startRun(MAPS[0]);
  run.credits = 10;
  check('placing without credits fails', !placeTower(run, run.pads[0].id, 'bolt').ok);
  check('failed place does not spend', run.credits === 10);
}

// --- waves ---
{
  const run = startRun(MAPS[0]);
  check('starting a wave from the build phase succeeds', startWave(run).ok);
  check('wave is now fighting', run.phase === 'fight');
  check('starting a wave twice fails', !startWave(run).ok);
  check('spawn queue is built from wave 1', run.spawnQueue.length === 6 && run.spawnQueue.every((s) => s.type === 'grunt'));
  // Step until the wave clears with no towers: enemies leak, lives drop.
  const lives0 = run.lives;
  let steps = 0;
  while (run.phase === 'fight' && steps < 60 * 120) { stepRun(run, 1 / 60); steps++; }
  check('an undefended wave leaks and ends the build phase again', run.phase === 'build' || run.done);
  check('leaks cost lives', run.lives < lives0);
  check('wave 1 undefended costs exactly 6 lives', run.lives === lives0 - 6);
  check('no kills without towers', run.kills === 0);
}
{
  // A single bolt tower on the best pad kills wave-1 grunts.
  const run = startRun(MAPS[0]);
  let best = null, bestRatio = -1;
  for (const pad of run.pads) {
    const cov = padCoverage(MAPS[0], [pad.col, pad.row], 3.2);
    if (cov.ratio > bestRatio) { bestRatio = cov.ratio; best = pad; }
  }
  placeTower(run, best.id, 'bolt');
  placeTower(run, run.pads.find((p) => p.id !== best.id && padCoverage(MAPS[0], [p.col, p.row], 3.2).ratio > 0.2).id, 'bolt');
  startWave(run);
  let steps = 0;
  while (run.phase === 'fight' && steps < 60 * 120) { stepRun(run, 1 / 60); steps++; }
  check('two bolt towers clear wave 1 with no leaks', run.wavesCleared === 1 && run.lives === CORE_LIVES);
  check('wave clear pays the wave bonus in credits', run.credits >= START_CREDITS - 2 * TOWER_DEFS.bolt.cost + 6 * ENEMY_DEFS.grunt.reward + waveBonus(0));
}

// --- leak / loss ---
{
  const run = startRun(MAPS[0]);
  run.lives = 1;
  startWave(run);
  let steps = 0;
  while (!run.done && steps < 60 * 120) { stepRun(run, 1 / 60); steps++; }
  check('core at 0 ends the run as lost', run.done && run.reason === 'lost');
  check('no actions after the run ends', !placeTower(run, run.pads[0].id, 'bolt').ok && !startWave(run).ok);
}

// --- unlock gates ---
check('map 1 is always unlocked', isMapUnlocked({}, 1));
check('map 2 locks until map 1 is cleared', !isMapUnlocked({}, 2) && !isMapUnlocked({ 1: { score: 1, waves: 5 } }, 2));
check('map 2 unlocks when map 1 is cleared', isMapUnlocked({ 1: { score: 1, waves: 6 } }, 2));
check('map 3 unlocks when map 2 is cleared', isMapUnlocked({ 1: { score: 1, waves: 6 }, 2: { score: 1, waves: 6 } }, 3));

// --- perf guard ---
check('perf guard steps down after sustained low fps', perfGuardStep(0, 30, 3000) === 1);
check('perf guard holds at the bottom rung', perfGuardStep(3, 30, 99999) === 3);
check('perf guard does not step down on good fps', perfGuardStep(0, 60, 99999) === 0);
check('perf guard does not step down on a brief dip', perfGuardStep(0, 30, 1000) === 0);

// --- save round-trip ---
{
  const save = defaultSave();
  save.best[1] = { score: 1234, waves: 6 };
  const back = parseSave(serializeSave(save));
  check('save round-trips the best result', back.best[1].score === 1234 && back.best[1].waves === 6);
  check('corrupt save falls back to defaults', parseSave('not json').version === SAVE_VERSION);
  const rec = recordBest(back, 1, 2000, 4);
  check('recordBest keeps the max score', rec.score === 2000 && rec.waves === 6);
  check('recordBest keeps the max waves', recordBest(back, 1, 100, 6).waves === 6);
}

if (failed) { console.error(`smoke: ${failed} failure(s) out of ${passed + failed}`); process.exit(1); }
console.log(`smoke: PASS — ${passed} checks`);
