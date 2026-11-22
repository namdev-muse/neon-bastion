// Neon Bastion v0.2.0 — pure simulation core (no DOM, no Three.js).
// 3D neon tower defense: enemies stream along glowing paths toward the
// core; the player places, upgrades and sells towers on grid pads and
// manages a tight credit economy. Leaked enemies damage the core;
// core at 0 = map lost. Score from kills + waves cleared + lives left;
// best result saved per map.
//
// Anti-slop: no auto-place, no "best tower" hint, no placement preview
// that solves the map. The bot plays through the same public hooks
// (placeTower / upgradeTower / sellTower / startWave / stepRun) and
// must make real economy + positioning decisions: a bot that places
// towers at random LOSES on every map (see tests/bot.js).

export const VERSION = '0.2.0';
export const DT = 1 / 60;
export const GRID_COLS = 14;
export const GRID_ROWS = 9;
export const CELL = 2.2; // world units per grid cell
export const START_CREDITS = 150; // enough for a real opening (two bolts, or bolt + frost)
export const CORE_LIVES = 20;
export const MAX_TOWER_LEVEL = 3;
export const SELL_REFUND = 0.7; // 70% of total invested, back on sell
export const WAVE_CLEAR_BONUS = 250; // score
export const MAP_CLEAR_BONUS = 1000; // score
export const LIFE_BONUS = 50; // score per core life left on map clear
export const SAVE_VERSION = 1;

export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// Grid cell -> world position (grid centred on the origin).
export function cellToWorld(col, row) {
  return {
    x: (col - (GRID_COLS - 1) / 2) * CELL,
    z: (row - (GRID_ROWS - 1) / 2) * CELL,
  };
}
export function worldToCell(x, z) {
  return {
    col: Math.round(x / CELL + (GRID_COLS - 1) / 2),
    row: Math.round(z / CELL + (GRID_ROWS - 1) / 2),
  };
}

// --- towers ---
// bolt  — cheap single-target DPS: the workhorse. Fast shots, long reach.
// pulse — slow AoE burst: the swarm answer. Weak vs single armoured targets.
// frost — low damage, chills enemies (50-60% slow): the control tower.
// The three are distinct roles, not reskins: a map cleared by spamming
// one type is a map that is not done (the bot gate enforces this).
export const TOWER_DEFS = {
  bolt: {
    id: 'bolt', name: 'Bolt', cost: 60, color: '#22d3ee',
    desc: 'Fast single-target shots. Reliable damage at long range.',
    levels: [
      { damage: 6, rate: 1.3, range: 2.9 },
      { damage: 10, rate: 1.4, range: 3.2 },
      { damage: 14, rate: 1.5, range: 3.5 },
    ],
  },
  pulse: {
    id: 'pulse', name: 'Pulse', cost: 110, color: '#f472b6',
    desc: 'Slow burst that hits every enemy near the blast. Swarm control.',
    levels: [
      { damage: 5, rate: 0.7, range: 2.4, aoe: 1.4 },
      { damage: 8, rate: 0.75, range: 2.7, aoe: 1.6 },
      { damage: 12, rate: 0.8, range: 3.0, aoe: 1.9 },
    ],
  },
  frost: {
    id: 'frost', name: 'Frost', cost: 80, color: '#a78bfa',
    desc: 'Chills enemies, slowing them so other towers land more hits.',
    levels: [
      { damage: 3, rate: 1.0, range: 2.8, slow: 0.50, slowDur: 1.6 },
      { damage: 4, rate: 1.1, range: 3.1, slow: 0.55, slowDur: 1.9 },
      { damage: 6, rate: 1.2, range: 3.4, slow: 0.60, slowDur: 2.2 },
    ],
  },
};
export const TOWER_ORDER = ['bolt', 'pulse', 'frost'];
export function towerStats(type, level) {
  const def = TOWER_DEFS[type];
  if (!def) return null;
  return def.levels[clamp(Math.floor(level) - 1, 0, def.levels.length - 1)];
}
export function upgradeCost(type, level) {
  const def = TOWER_DEFS[type];
  if (!def || level >= MAX_TOWER_LEVEL) return null;
  // Level 2 costs 80% of base, level 3 costs 120% of base.
  return Math.round(def.cost * (level === 1 ? 0.8 : 1.2));
}
export function towerInvested(type, level) {
  const def = TOWER_DEFS[type];
  let total = def.cost;
  for (let l = 1; l < level; l++) total += upgradeCost(type, l);
  return total;
}
export function sellValue(type, level) {
  return Math.floor(towerInvested(type, level) * SELL_REFUND);
}

// --- enemies ---
// grunt   — the bulk: 1 hp-bar of steady pressure, 1 core damage on leak.
// runner  — fast, fragile: punishes slow towers and gaps in coverage.
// armored — slow, tough: punishes AoE spam; needs focused bolt fire.
// boss    — one per late wave: a wall of HP that costs 5 core lives.
export const ENEMY_DEFS = {
  grunt: { hp: 20, speed: 2.4, reward: 6, damage: 1, r: 0.55, score: 100, color: '#f472b6' },
  runner: { hp: 12, speed: 4.0, reward: 8, damage: 1, r: 0.45, score: 150, color: '#fb7185' },
  armored: { hp: 100, speed: 1.7, reward: 15, damage: 2, r: 0.7, score: 250, color: '#fbbf24' },
  boss: { hp: 650, speed: 1.2, reward: 60, damage: 5, r: 1.0, score: 1000, color: '#e879f9' },
};

// --- feedback tiers (game-feel skill: small 0.10-0.20 / no stop,
// medium 0.30-0.50 / 0.04-0.06s, large 0.70-1.00 / 0.10-0.15s) ---
export const FEEDBACK_TIERS = {
  small: { traumaMin: 0.10, traumaMax: 0.20, stopMin: 0, stopMax: 0 },
  medium: { traumaMin: 0.30, traumaMax: 0.50, stopMin: 0.04, stopMax: 0.06 },
  large: { traumaMin: 0.70, traumaMax: 1.00, stopMin: 0.10, stopMax: 0.15 },
};
export const FEEDBACK = {
  place: { tier: 'small', trauma: 0.12, hitStop: 0 },
  upgrade: { tier: 'small', trauma: 0.15, hitStop: 0 },
  sell: { tier: 'small', trauma: 0.10, hitStop: 0 },
  kill: { tier: 'small', trauma: 0.12, hitStop: 0 },
  waveStart: { tier: 'small', trauma: 0.15, hitStop: 0 },
  waveClear: { tier: 'medium', trauma: 0.40, hitStop: 0.05 },
  leak: { tier: 'large', trauma: 0.75, hitStop: 0.10 },
  mapClear: { tier: 'medium', trauma: 0.40, hitStop: 0.05 },
  mapLost: { tier: 'large', trauma: 0.90, hitStop: 0.12 },
};
// Feedback layers (game-feel skill: one satisfying event is 5-8 tiny
// responses firing together within ~100ms). Secondary events
// (towerFire, bossKill, spawn) ride on a primary bundle or fire at
// high frequency, so they get 2-3 deliberate channels each —
// documented in game.js handleEvents.
export const FEEDBACK_LAYERS = {
  place: ['sound', 'particles', 'shake', 'pop', 'glowPulse'],
  upgrade: ['sound', 'particles', 'shake', 'pop', 'glowPulse', 'ringPulse'],
  sell: ['sound', 'particles', 'shake', 'pop', 'glowPulse'],
  kill: ['sound', 'particles', 'shake', 'pop', 'glowPulse'],
  waveStart: ['sound', 'shake', 'fovPulse', 'toast', 'particles'],
  waveClear: ['sound', 'particles', 'shake', 'hitStop', 'pop', 'toast', 'fovPulse'],
  leak: ['sound', 'particles', 'shake', 'hitStop', 'flash', 'slowMo', 'toast', 'knockback'],
  mapClear: ['sound', 'particles', 'shake', 'hitStop', 'fovPulse', 'pop', 'toast'],
  mapLost: ['sound', 'particles', 'shake', 'hitStop', 'flash', 'slowMo', 'toast', 'squash'],
};

// --- maps ---
// A map is a hand-authored path (grid waypoints, entry at one edge,
// exit at another), a pad layout, and 6 escalating waves. Pads are
// grid cells NOT on the path. Some pads sit on choke points with long
// path coverage; some sit far from the path with almost none —
// placement is a decision, and a random placement wastes credits.
// Path cells are derived from the waypoints (every cell the polyline
// passes through), so a pad is never accidentally on the path.
function pathCells(path) {
  const cells = [];
  const seen = new Set();
  for (let i = 0; i < path.length - 1; i++) {
    const [c0, r0] = path[i];
    const [c1, r1] = path[i + 1];
    const dc = Math.sign(c1 - c0), dr = Math.sign(r1 - r0);
    let c = c0, r = r0;
    while (true) {
      const key = `${c},${r}`;
      if (!seen.has(key)) { seen.add(key); cells.push([c, r]); }
      if (c === c1 && r === r1) break;
      c += dc; r += dr;
    }
  }
  return cells;
}
function pathLengthCells(path) {
  let n = 0;
  for (let i = 0; i < path.length - 1; i++) {
    n += Math.abs(path[i + 1][0] - path[i][0]) + Math.abs(path[i + 1][1] - path[i][1]);
  }
  return n;
}

export const MAPS = [
  {
    id: 1, name: 'First Light', seed: 11,
    hint: 'The teaching map — bolts on the bends, frost at the choke.',
    theme: { ring: '#22d3ee', glow: '#0e7490', accent: '#f472b6', disc: '#0b1030', tint: '#67e8f9' },
    path: [[0, 4], [10, 4], [10, 1], [3, 1], [3, 7], [13, 7]],
    pads: [
      [9, 3], [9, 5], [11, 3], [8, 2], [6, 2], [5, 0], [4, 3], [4, 6],
      [6, 6], [8, 6], [11, 6], [12, 5], [1, 6], [12, 2], [0, 0], [13, 0], [0, 8],
    ],
    waves: [
      { groups: [{ type: 'grunt', count: 6, delay: 0, gap: 1.2 }] },
      { groups: [{ type: 'grunt', count: 10, delay: 0, gap: 0.9 }] },
      { groups: [{ type: 'grunt', count: 8, delay: 0, gap: 0.9 }, { type: 'runner', count: 4, delay: 4, gap: 0.7 }] },
      { groups: [{ type: 'runner', count: 6, delay: 0, gap: 0.7 }, { type: 'armored', count: 4, delay: 3, gap: 1.2 }] },
      { groups: [{ type: 'grunt', count: 8, delay: 0, gap: 0.8 }, { type: 'armored', count: 8, delay: 4, gap: 1.2 }, { type: 'boss', count: 1, delay: 9, gap: 1 }] },
      { groups: [{ type: 'grunt', count: 10, delay: 0, gap: 0.7 }, { type: 'runner', count: 10, delay: 3, gap: 0.6 }, { type: 'armored', count: 6, delay: 6, gap: 1.1 }, { type: 'boss', count: 3, delay: 11, gap: 2.5 }] },
    ],
  },
  {
    id: 2, name: 'Crossroads', seed: 22,
    hint: 'A short path that doubles back — the middle zigzag is the whole map.',
    theme: { ring: '#f472b6', glow: '#9d174d', accent: '#22d3ee', disc: '#1c0616', tint: '#f9a8d4' },
    path: [[0, 2], [9, 2], [9, 5], [4, 5], [4, 8], [13, 8]],
    pads: [
      [8, 3], [8, 1], [10, 3], [6, 3], [5, 4], [3, 4], [3, 6], [5, 6],
      [7, 7], [10, 7], [11, 6], [1, 4], [12, 3], [0, 0], [13, 0], [6, 7], [0, 6],
    ],
    waves: [
      { groups: [{ type: 'grunt', count: 6, delay: 0, gap: 1.1 }] },
      { groups: [{ type: 'grunt', count: 8, delay: 0, gap: 0.9 }, { type: 'runner', count: 3, delay: 4, gap: 0.7 }] },
      { groups: [{ type: 'runner', count: 10, delay: 0, gap: 0.7 }, { type: 'armored', count: 2, delay: 3, gap: 1.2 }] },
      { groups: [{ type: 'grunt', count: 6, delay: 0, gap: 0.8 }, { type: 'runner', count: 6, delay: 3, gap: 0.6 }, { type: 'armored', count: 6, delay: 6, gap: 1.1 }] },
      { groups: [{ type: 'armored', count: 8, delay: 0, gap: 1.2 }, { type: 'boss', count: 1, delay: 5, gap: 1 }, { type: 'runner', count: 6, delay: 8, gap: 0.6 }] },
      { groups: [{ type: 'grunt', count: 12, delay: 0, gap: 0.7 }, { type: 'runner', count: 10, delay: 3, gap: 0.6 }, { type: 'armored', count: 7, delay: 6, gap: 1.0 }, { type: 'boss', count: 3, delay: 11, gap: 2.5 }] },
    ],
  },
  {
    id: 3, name: 'The Gauntlet', seed: 33,
    hint: 'Four turns, one long road — and two bosses at the end.',
    theme: { ring: '#fbbf24', glow: '#b45309', accent: '#22d3ee', disc: '#1c1206', tint: '#fde68a' },
    path: [[0, 1], [12, 1], [12, 4], [2, 4], [2, 7], [13, 7]],
    pads: [
      [11, 2], [10, 0], [11, 3], [8, 2], [6, 3], [4, 2], [10, 5], [6, 5],
      [4, 6], [5, 6], [8, 6], [11, 6], [12, 5], [1, 3], [0, 5], [13, 0], [0, 8],
    ],
    waves: [
      { groups: [{ type: 'grunt', count: 6, delay: 0, gap: 1.0 }, { type: 'runner', count: 2, delay: 4, gap: 0.7 }] },
      { groups: [{ type: 'grunt', count: 10, delay: 0, gap: 0.8 }, { type: 'runner', count: 3, delay: 4, gap: 0.7 }] },
      { groups: [{ type: 'runner', count: 8, delay: 0, gap: 0.6 }, { type: 'armored', count: 2, delay: 3, gap: 1.1 }] },
      { groups: [{ type: 'grunt', count: 8, delay: 0, gap: 0.7 }, { type: 'runner', count: 7, delay: 3, gap: 0.6 }, { type: 'armored', count: 3, delay: 6, gap: 1.0 }] },
      { groups: [{ type: 'armored', count: 8, delay: 0, gap: 1.1 }, { type: 'boss', count: 2, delay: 5, gap: 2.5 }, { type: 'runner', count: 8, delay: 9, gap: 0.6 }] },
      { groups: [{ type: 'grunt', count: 14, delay: 0, gap: 0.6 }, { type: 'runner', count: 12, delay: 3, gap: 0.55 }, { type: 'armored', count: 9, delay: 6, gap: 1.0 }, { type: 'boss', count: 2, delay: 11, gap: 2.5 }] },
    ],
  },
  {
    id: 4, name: 'Switchback', seed: 44,
    hint: 'Five sharp turns — bolts on the bends, frost in the middle.',
    theme: { ring: '#a78bfa', glow: '#6d28d9', accent: '#22d3ee', disc: '#120b2e', tint: '#c4b5fd' },
    path: [[0, 2], [9, 2], [9, 6], [5, 6], [5, 1], [13, 1]],
    pads: [
      [8, 3], [10, 3], [10, 5], [6, 5], [4, 5], [4, 3], [3, 3], [6, 0],
      [7, 0], [10, 0], [12, 2], [13, 3], [13, 5], [0, 4], [0, 0], [2, 7], [11, 7],
    ],
    waves: [
      { groups: [{ type: 'grunt', count: 6, delay: 0, gap: 1.2 }] },
      { groups: [{ type: 'grunt', count: 8, delay: 0, gap: 0.9 }, { type: 'runner', count: 3, delay: 4, gap: 0.7 }] },
      { groups: [{ type: 'runner', count: 10, delay: 0, gap: 0.7 }, { type: 'armored', count: 2, delay: 3, gap: 1.2 }] },
      { groups: [{ type: 'grunt', count: 6, delay: 0, gap: 1.0 }, { type: 'runner', count: 6, delay: 3, gap: 0.8 }, { type: 'armored', count: 6, delay: 6, gap: 1.3 }] },
      { groups: [{ type: 'armored', count: 8, delay: 0, gap: 1.1 }, { type: 'boss', count: 2, delay: 5, gap: 2.5 }, { type: 'runner', count: 6, delay: 9, gap: 0.6 }] },
      { groups: [{ type: 'grunt', count: 14, delay: 0, gap: 0.6 }, { type: 'runner', count: 12, delay: 3, gap: 0.55 }, { type: 'armored', count: 8, delay: 6, gap: 1.0 }, { type: 'boss', count: 2, delay: 11, gap: 2.5 }] },
    ],
  },
  {
    id: 5, name: 'The Corridor', seed: 55,
    hint: 'Two long runs with a jog — the middle pads cover both.',
    theme: { ring: '#34d399', glow: '#047857', accent: '#fbbf24', disc: '#06180f', tint: '#6ee7b7' },
    path: [[0, 1], [13, 1], [13, 4], [10, 4], [10, 7], [0, 7]],
    pads: [
      [6, 2], [9, 2], [12, 2], [3, 3], [7, 3], [11, 3], [9, 5], [6, 6],
      [3, 6], [11, 6], [12, 5], [8, 5], [12, 0], [0, 3], [0, 5], [13, 6], [13, 8],
    ],
    waves: [
      { groups: [{ type: 'grunt', count: 6, delay: 0, gap: 1.1 }] },
      { groups: [{ type: 'grunt', count: 10, delay: 0, gap: 1.1 }, { type: 'runner', count: 3, delay: 5, gap: 0.7 }] },
      { groups: [{ type: 'runner', count: 12, delay: 0, gap: 0.9 }, { type: 'armored', count: 3, delay: 4, gap: 1.2 }] },
      { groups: [{ type: 'grunt', count: 8, delay: 0, gap: 0.8 }, { type: 'runner', count: 8, delay: 3, gap: 0.6 }, { type: 'armored', count: 6, delay: 6, gap: 1.1 }] },
      { groups: [{ type: 'armored', count: 8, delay: 0, gap: 1.1 }, { type: 'boss', count: 2, delay: 5, gap: 2.5 }, { type: 'runner', count: 8, delay: 9, gap: 0.6 }] },
      { groups: [{ type: 'grunt', count: 16, delay: 0, gap: 0.6 }, { type: 'runner', count: 12, delay: 3, gap: 0.55 }, { type: 'armored', count: 8, delay: 6, gap: 1.0 }, { type: 'boss', count: 2, delay: 11, gap: 2.5 }] },
    ],
  },
  {
    id: 6, name: 'The Circuit', seed: 66,
    hint: 'A full loop around the rim — inside pads see every side.',
    theme: { ring: '#fb923c', glow: '#c2410c', accent: '#a78bfa', disc: '#1c0e06', tint: '#fdba74' },
    path: [[0, 8], [0, 0], [13, 0], [13, 8], [4, 8]],
    pads: [
      [1, 1], [4, 1], [7, 1], [10, 1], [12, 1], [1, 4], [12, 4], [1, 7],
      [4, 7], [7, 7], [10, 7], [12, 7], [2, 2], [11, 2], [2, 6], [11, 6], [6, 4],
    ],
    waves: [
      { groups: [{ type: 'grunt', count: 8, delay: 0, gap: 1.5 }] },
      { groups: [{ type: 'grunt', count: 10, delay: 0, gap: 1.1 }, { type: 'runner', count: 4, delay: 5, gap: 0.7 }] },
      { groups: [{ type: 'runner', count: 12, delay: 0, gap: 0.9 }, { type: 'armored', count: 4, delay: 4, gap: 1.2 }] },
      { groups: [{ type: 'grunt', count: 10, delay: 0, gap: 0.8 }, { type: 'runner', count: 8, delay: 3, gap: 0.6 }, { type: 'armored', count: 7, delay: 6, gap: 1.1 }] },
      { groups: [{ type: 'armored', count: 10, delay: 0, gap: 1.1 }, { type: 'boss', count: 2, delay: 5, gap: 2.5 }, { type: 'runner', count: 8, delay: 9, gap: 0.6 }] },
      { groups: [{ type: 'grunt', count: 16, delay: 0, gap: 0.6 }, { type: 'runner', count: 14, delay: 3, gap: 0.55 }, { type: 'armored', count: 9, delay: 6, gap: 1.0 }, { type: 'boss', count: 2, delay: 11, gap: 2.5 }] },
    ],
  },
  {
    id: 7, name: 'Serpent', seed: 77,
    hint: 'The longest road — every row is a firing line.',
    theme: { ring: '#fb7185', glow: '#be123c', accent: '#34d399', disc: '#1c060b', tint: '#fda4af' },
    path: [[0, 1], [13, 1], [13, 3], [0, 3], [0, 5], [13, 5], [13, 7], [0, 7]],
    pads: [
      [2, 2], [6, 2], [10, 2], [3, 4], [7, 4], [11, 4], [2, 6], [6, 6],
      [10, 6], [1, 0], [5, 0], [9, 0], [12, 0], [4, 8], [8, 8], [12, 8], [0, 0],
    ],
    waves: [
      { groups: [{ type: 'grunt', count: 8, delay: 0, gap: 1.1 }, { type: 'runner', count: 2, delay: 4, gap: 0.7 }] },
      { groups: [{ type: 'grunt', count: 12, delay: 0, gap: 0.9 }, { type: 'runner', count: 4, delay: 4, gap: 0.7 }] },
      { groups: [{ type: 'runner', count: 14, delay: 0, gap: 0.8 }, { type: 'armored', count: 4, delay: 4, gap: 1.1 }] },
      { groups: [{ type: 'grunt', count: 12, delay: 0, gap: 1.0 }, { type: 'runner', count: 10, delay: 3, gap: 0.8 }, { type: 'armored', count: 10, delay: 7, gap: 1.1 }] },
      { groups: [{ type: 'armored', count: 10, delay: 0, gap: 1.1 }, { type: 'boss', count: 2, delay: 5, gap: 2.5 }, { type: 'runner', count: 16, delay: 9, gap: 0.6 }] },
      { groups: [{ type: 'grunt', count: 18, delay: 0, gap: 0.6 }, { type: 'runner', count: 24, delay: 3, gap: 0.55 }, { type: 'armored', count: 12, delay: 6, gap: 1.0 }, { type: 'boss', count: 3, delay: 11, gap: 2.5 }] },
    ],
  },
  {
    id: 8, name: 'The Crucible', seed: 88,
    hint: 'A winding maze, short on mercy — the final test. Hold the line.',
    theme: { ring: '#7dd3fc', glow: '#0369a1', accent: '#fb7185', disc: '#06121c', tint: '#bae6fd' },
    path: [[0, 4], [7, 4], [7, 0], [11, 0], [11, 6], [6, 6], [6, 8], [13, 8]],
    pads: [
      [6, 3], [8, 3], [6, 5], [8, 5], [9, 2], [10, 2], [12, 2], [12, 4],
      [9, 7], [10, 7], [12, 7], [5, 7], [4, 6], [3, 3], [2, 5], [0, 8], [13, 2],
    ],
    waves: [
      { groups: [{ type: 'grunt', count: 6, delay: 0, gap: 1.2 }] },
      { groups: [{ type: 'grunt', count: 8, delay: 0, gap: 1.1 }, { type: 'runner', count: 3, delay: 5, gap: 0.7 }] },
      { groups: [{ type: 'runner', count: 10, delay: 0, gap: 0.8 }, { type: 'armored', count: 3, delay: 4, gap: 1.1 }] },
      { groups: [{ type: 'grunt', count: 8, delay: 0, gap: 0.8 }, { type: 'runner', count: 6, delay: 3, gap: 0.6 }, { type: 'armored', count: 4, delay: 6, gap: 1.0 }] },
      { groups: [{ type: 'armored', count: 12, delay: 0, gap: 1.1 }, { type: 'boss', count: 2, delay: 5, gap: 2.5 }, { type: 'runner', count: 10, delay: 9, gap: 0.6 }] },
      { groups: [{ type: 'grunt', count: 24, delay: 0, gap: 0.6 }, { type: 'runner', count: 20, delay: 3, gap: 0.55 }, { type: 'armored', count: 12, delay: 6, gap: 1.0 }, { type: 'boss', count: 4, delay: 11, gap: 2.5 }] },
    ],
  },
];

export function mapById(id) {
  return MAPS.find((m) => m.id === id) || null;
}
// Derived map geometry, computed once per map and cached on the map
// object: world-space waypoints, cumulative segment lengths, total
// path length, and the set of path cells (for pad validation).
export function mapGeometry(map) {
  if (map._geo) return map._geo;
  const waypoints = map.path.map(([c, r]) => cellToWorld(c, r));
  const cum = [0];
  for (let i = 1; i < waypoints.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(waypoints[i].x - waypoints[i - 1].x, waypoints[i].z - waypoints[i - 1].z));
  }
  const geo = {
    waypoints, cum,
    length: cum[cum.length - 1],
    lengthCells: pathLengthCells(map.path),
    cells: pathCells(map.path),
  };
  map._geo = geo;
  return geo;
}
// Position on the path at distance s (world units) from the entry.
export function pathPosition(map, s) {
  const geo = mapGeometry(map);
  const clamped = clamp(s, 0, geo.length);
  let i = 1;
  while (i < geo.cum.length - 1 && geo.cum[i] < clamped) i++;
  const segLen = geo.cum[i] - geo.cum[i - 1] || 1;
  const t = (clamped - geo.cum[i - 1]) / segLen;
  return {
    x: geo.waypoints[i - 1].x + (geo.waypoints[i].x - geo.waypoints[i - 1].x) * t,
    z: geo.waypoints[i - 1].z + (geo.waypoints[i].z - geo.waypoints[i - 1].z) * t,
  };
}
// How many path sample points (every 0.25 cells) a tower of the given
// range (in cells) can hit from this pad — the placement-quality
// metric the decision bot uses, and the reason random placement
// loses: pads far from the path score near zero.
export function padCoverage(map, pad, rangeCells) {
  const geo = mapGeometry(map);
  const p = cellToWorld(pad[0], pad[1]);
  const range = rangeCells * CELL;
  let covered = 0, samples = 0;
  for (let s = 0; s <= geo.length; s += CELL * 0.25) {
    samples++;
    const pos = pathPosition(map, s);
    if (Math.hypot(pos.x - p.x, pos.z - p.z) <= range) covered++;
  }
  return { covered, samples, ratio: samples ? covered / samples : 0 };
}
export function totalEnemiesInMap(map) {
  let n = 0;
  for (const w of map.waves) for (const g of w.groups) n += g.count;
  return n;
}
export function mapThreat(map) {
  let t = 0;
  for (const w of map.waves) for (const g of w.groups) {
    const def = ENEMY_DEFS[g.type];
    t += g.count * def.hp * (g.type === 'runner' ? 1.3 : g.type === 'boss' ? 1.5 : 1);
  }
  return t;
}
export function waveBonus(waveIndex) {
  return 18 + 5 * (waveIndex + 1);
}

// --- unlock gates ---
// Map N+1 unlocks when map N is cleared (best waves == the map's wave
// count). The gates live in the menu only — startRun itself never
// enforces them, so the bot, the render check and the ?map= seed path
// can start any map through the public hooks.
export function isMapUnlocked(best, id) {
  if (id <= 1) return true;
  const prev = best ? best[id - 1] : null;
  const prevMap = MAPS[id - 2];
  return !!prev && prev.waves >= prevMap.waves.length;
}

// --- run state ---
export function createRun(map) {
  const geo = mapGeometry(map);
  return {
    map,
    time: 0,
    credits: START_CREDITS,
    lives: CORE_LIVES, maxLives: CORE_LIVES,
    score: 0,
    kills: 0, leaked: 0, livesLost: 0,
    towersPlaced: 0, towersSold: 0, upgradesBought: 0,
    creditsEarned: 0, creditsSpent: 0,
    waveIndex: 0, phase: 'build', // 'build' | 'fight' | 'done'
    waveTime: 0, spawnQueue: [], nextEnemyId: 1,
    enemies: [],
    towers: [], // { padId, type, level, x, z, cd, kills, invested }
    pads: map.pads.map(([c, r], i) => ({
      id: i, col: c, row: r,
      x: cellToWorld(c, r).x, z: cellToWorld(c, r).z,
      tower: null,
    })),
    core: geo.waypoints[geo.waypoints.length - 1],
    entry: geo.waypoints[0],
    wavesCleared: 0,
    done: false, reason: null, // 'complete' | 'lost'
  };
}
export function startRun(map) {
  return createRun(map);
}
export function padById(run, padId) {
  return run.pads.find((p) => p.id === padId) || null;
}
export function towerAt(run, padId) {
  const pad = padById(run, padId);
  return pad ? pad.tower : null;
}

// Place a tower on a pad. Returns { ok, reason? } — the game fires
// the place feedback only on ok, and shows the reason as a toast.
export function placeTower(run, padId, type) {
  if (run.done) return { ok: false, reason: 'run over' };
  const def = TOWER_DEFS[type];
  if (!def) return { ok: false, reason: 'unknown tower' };
  const pad = padById(run, padId);
  if (!pad) return { ok: false, reason: 'no such pad' };
  if (pad.tower) return { ok: false, reason: 'pad occupied' };
  if (run.credits < def.cost) return { ok: false, reason: 'not enough credits' };
  run.credits -= def.cost;
  run.creditsSpent += def.cost;
  const tower = {
    padId, type, level: 1, x: pad.x, z: pad.z, cd: 0,
    kills: 0, invested: def.cost,
  };
  pad.tower = tower;
  run.towers.push(tower);
  run.towersPlaced++;
  return { ok: true, tower };
}
export function upgradeTower(run, padId) {
  if (run.done) return { ok: false, reason: 'run over' };
  const tower = towerAt(run, padId);
  if (!tower) return { ok: false, reason: 'no tower here' };
  if (tower.level >= MAX_TOWER_LEVEL) return { ok: false, reason: 'max level' };
  const cost = upgradeCost(tower.type, tower.level);
  if (run.credits < cost) return { ok: false, reason: 'not enough credits' };
  run.credits -= cost;
  run.creditsSpent += cost;
  tower.invested += cost;
  tower.level++;
  run.upgradesBought++;
  return { ok: true, tower, cost };
}
export function sellTower(run, padId) {
  if (run.done) return { ok: false, reason: 'run over' };
  const pad = padById(run, padId);
  if (!pad || !pad.tower) return { ok: false, reason: 'no tower here' };
  const tower = pad.tower;
  const value = sellValue(tower.type, tower.level);
  run.credits += value;
  pad.tower = null;
  run.towers.splice(run.towers.indexOf(tower), 1);
  run.towersSold++;
  return { ok: true, value, type: tower.type };
}

// Start the next wave. Only from the build phase, only while the run
// is alive. The spawn queue is built from the wave's groups: each
// enemy spawns at delay + i*gap seconds into the wave.
export function startWave(run) {
  if (run.done) return { ok: false, reason: 'run over' };
  if (run.phase !== 'build') return { ok: false, reason: 'wave already running' };
  if (run.waveIndex >= run.map.waves.length) return { ok: false, reason: 'no more waves' };
  const wave = run.map.waves[run.waveIndex];
  run.spawnQueue = [];
  for (const g of wave.groups) {
    for (let i = 0; i < g.count; i++) {
      run.spawnQueue.push({ t: g.delay + i * (g.gap ?? 0.9), type: g.type });
    }
  }
  run.spawnQueue.sort((a, b) => a.t - b.t);
  run.waveTime = 0;
  run.phase = 'fight';
  return { ok: true, wave: run.waveIndex + 1 };
}

function spawnEnemy(run, type) {
  const def = ENEMY_DEFS[type];
  const pos = pathPosition(run.map, 0);
  const e = {
    id: run.nextEnemyId++, type,
    s: 0, x: pos.x, z: pos.z,
    hp: def.hp, maxHp: def.hp, r: def.r, speed: def.speed,
    slowUntil: -1, slowFactor: 1,
  };
  run.enemies.push(e);
  return e;
}

function killEnemy(run, e, events, killer) {
  const idx = run.enemies.indexOf(e);
  if (idx < 0) return;
  run.enemies.splice(idx, 1);
  const def = ENEMY_DEFS[e.type];
  run.kills++;
  run.credits += def.reward;
  run.creditsEarned += def.reward;
  run.score += def.score;
  if (killer) killer.kills++;
  events.push({ type: 'kill', kind: e.type, x: e.x, z: e.z, reward: def.reward, score: def.score });
  if (e.type === 'boss') events.push({ type: 'bossKill', x: e.x, z: e.z });
}

// One fixed step. Towers fire automatically (no input — placement IS
// the input). Returns the events fired this step (for juice / audio /
// particles). Placement actions go through placeTower / upgradeTower /
// sellTower / startWave, never through stepRun.
export function stepRun(run, dt = DT) {
  const events = [];
  if (run.done) return events;
  run.time += dt;

  if (run.phase === 'fight') {
    run.waveTime += dt;
    while (run.spawnQueue.length && run.spawnQueue[0].t <= run.waveTime) {
      const s = run.spawnQueue.shift();
      const e = spawnEnemy(run, s.type);
      events.push({ type: 'spawn', kind: s.type, x: e.x, z: e.z });
    }
  }

  // Towers: cooldown, pick the furthest-along enemy in range ("first"
  // targeting), fire. Bolt hits one target instantly; pulse hits every
  // enemy near the blast; frost damages and chills.
  for (const t of run.towers) {
    const stats = towerStats(t.type, t.level);
    const range = stats.range * CELL;
    t.cd -= dt;
    if (t.cd > 0) continue;
    let target = null;
    for (const e of run.enemies) {
      const d2 = (e.x - t.x) * (e.x - t.x) + (e.z - t.z) * (e.z - t.z);
      if (d2 <= range * range && (!target || e.s > target.s)) target = e;
    }
    if (!target) continue;
    t.cd = 1 / stats.rate;
    if (t.type === 'bolt') {
      target.hp -= stats.damage;
      events.push({ type: 'towerFire', kind: 'bolt', padId: t.padId, from: { x: t.x, z: t.z }, to: { x: target.x, z: target.z } });
      if (target.hp <= 0) killEnemy(run, target, events, t);
    } else if (t.type === 'pulse') {
      const aoe = stats.aoe * CELL;
      events.push({ type: 'towerFire', kind: 'pulse', padId: t.padId, from: { x: t.x, z: t.z }, to: { x: target.x, z: target.z }, aoe });
      for (const e of [...run.enemies]) {
        const d2 = (e.x - target.x) * (e.x - target.x) + (e.z - target.z) * (e.z - target.z);
        if (d2 <= aoe * aoe) {
          e.hp -= stats.damage;
          if (e.hp <= 0) killEnemy(run, e, events, t);
        }
      }
    } else if (t.type === 'frost') {
      target.hp -= stats.damage;
      target.slowUntil = run.time + stats.slowDur;
      target.slowFactor = 1 - stats.slow;
      events.push({ type: 'towerFire', kind: 'frost', padId: t.padId, from: { x: t.x, z: t.z }, to: { x: target.x, z: target.z } });
      if (target.hp <= 0) killEnemy(run, target, events, t);
    }
  }

  // Enemies: advance along the path (chilled enemies move slower),
  // leak at the end.
  const geo = mapGeometry(run.map);
  for (const e of [...run.enemies]) {
    const slowed = run.time < e.slowUntil;
    const speed = e.speed * (slowed ? e.slowFactor : 1);
    e.s += speed * CELL * dt;
    if (e.s >= geo.length) {
      run.enemies.splice(run.enemies.indexOf(e), 1);
      const def = ENEMY_DEFS[e.type];
      run.lives -= def.damage;
      run.livesLost += def.damage;
      run.leaked++;
      events.push({ type: 'leak', kind: e.type, damage: def.damage, lives: run.lives });
      if (run.lives <= 0) {
        run.lives = 0;
        run.done = true;
        run.reason = 'lost';
        events.push({ type: 'mapLost', score: run.score, waves: run.wavesCleared });
        return events;
      }
      continue;
    }
    const pos = pathPosition(run.map, e.s);
    e.x = pos.x; e.z = pos.z;
  }

  // Wave cleared: the queue is empty and the path is clear.
  if (run.phase === 'fight' && run.spawnQueue.length === 0 && run.enemies.length === 0) {
    run.wavesCleared++;
    const bonus = waveBonus(run.waveIndex);
    run.credits += bonus;
    run.creditsEarned += bonus;
    run.score += WAVE_CLEAR_BONUS;
    events.push({ type: 'waveClear', wave: run.waveIndex + 1, bonus, score: WAVE_CLEAR_BONUS });
    run.waveIndex++;
    if (run.waveIndex >= run.map.waves.length) {
      run.phase = 'done';
      run.done = true;
      run.reason = 'complete';
      run.score += MAP_CLEAR_BONUS + run.lives * LIFE_BONUS;
      events.push({ type: 'mapClear', score: run.score, waves: run.wavesCleared, lives: run.lives });
    } else {
      run.phase = 'build';
    }
  }

  return events;
}

// --- policies (the bot plays through the same public hooks) ---
// The decision bot's placement metric: pads ranked by how much of
// the path a bolt tower can cover from them. It spends every credit
// on coverage, buys the right tool for the next wave, and upgrades
// its best towers — real economy + positioning decisions.
function bestEmptyPad(run, rangeCells = 2.9) {
  let best = null, bestRatio = -1;
  for (const pad of run.pads) {
    if (pad.tower) continue;
    const cov = padCoverage(run.map, [pad.col, pad.row], rangeCells);
    if (cov.ratio > bestRatio) { bestRatio = cov.ratio; best = pad; }
  }
  return best ? { pad: best, ratio: bestRatio } : null;
}
function nextWaveComposition(run) {
  const wave = run.map.waves[run.waveIndex];
  if (!wave) return { grunt: 0, runner: 0, armored: 0, boss: 0 };
  const comp = { grunt: 0, runner: 0, armored: 0, boss: 0 };
  for (const g of wave.groups) comp[g.type] += g.count;
  return comp;
}
function towerCounts(run) {
  const c = { bolt: 0, pulse: 0, frost: 0 };
  for (const t of run.towers) c[t.type]++;
  return c;
}
// One build-phase decision pass: place, upgrade, then start the wave.
// Called by simulateRun whenever the run is in the build phase.
export function decisionBuild(run) {
  const counts = towerCounts(run);
  const comp = nextWaveComposition(run);
  // Place while we can afford a tower and a good pad exists. Type
  // choice follows the next wave: swarms want pulse, armour wants
  // bolt focus, and one frost early pays for itself all map long.
  let guard = 0;
  while (guard++ < 20) {
    const best = bestEmptyPad(run);
    if (!best || best.ratio < 0.08) break; // no pad worth the credits
    let type = 'bolt';
    // The first two towers are always bolts: cheap single-target DPS
    // is what kills the teaching waves. A pulse first cannot kill a
    // single 20-HP grunt before it walks out of range, and a frost
    // first has nothing to support. After the bolt pair, buy the tool
    // the next wave wants: frost for control, pulse for swarms, more
    // bolt for armour.
    if (run.towers.length < 2) type = 'bolt';
    else if (counts.frost === 0 && run.credits >= TOWER_DEFS.frost.cost) type = 'frost';
    else if (counts.pulse < 2 && (comp.grunt + comp.runner) >= 10 && run.credits >= TOWER_DEFS.pulse.cost) type = 'pulse';
    else if (comp.armored + comp.boss >= 3 && counts.bolt < 4 && run.credits >= TOWER_DEFS.bolt.cost) type = 'bolt';
    else if (run.credits >= TOWER_DEFS.pulse.cost && (comp.grunt + comp.runner) >= 10 && counts.pulse < 2) type = 'pulse';
    else if (run.credits >= TOWER_DEFS.bolt.cost) type = 'bolt';
    else break;
    // Keep a reserve for the next wave's upgrade if this is wave 1.
    if (run.waveIndex === 0 && run.towers.length >= 2 && run.credits - TOWER_DEFS[type].cost < 40) break;
    const res = placeTower(run, best.pad.id, type);
    if (!res.ok) break;
    counts[type]++;
  }
  // Upgrade the tower with the most kills (the one doing the work),
  // while credits remain and it is not maxed.
  let uguard = 0;
  while (uguard++ < 6) {
    let bestTower = null;
    for (const t of run.towers) {
      if (t.level >= MAX_TOWER_LEVEL) continue;
      const cost = upgradeCost(t.type, t.level);
      if (run.credits < cost) continue;
      if (!bestTower || t.kills > bestTower.kills) bestTower = t;
    }
    if (!bestTower) break;
    const res = upgradeTower(run, bestTower.padId);
    if (!res.ok) break;
  }
  startWave(run);
}
// Mid-wave opportunism: spend kill income as it arrives — place the
// tool the NEXT wave wants on the best free pad, or upgrade the tower
// doing the most work. Called every 2s during a fight, one action
// per call, so the bot builds continuously like a good player does.
export function decisionMidWave(run) {
  const counts = towerCounts(run);
  const comp = nextWaveComposition(run);
  const best = bestEmptyPad(run);
  if (best && best.ratio >= 0.15) {
    let type = null;
    if (run.towers.length < 2) type = 'bolt';
    else if (counts.frost === 0 && run.credits >= TOWER_DEFS.frost.cost) type = 'frost';
    else if (counts.pulse < 2 && (comp.grunt + comp.runner) >= 10 && run.credits >= TOWER_DEFS.pulse.cost) type = 'pulse';
    else if (run.credits >= TOWER_DEFS.bolt.cost) type = 'bolt';
    if (type && placeTower(run, best.pad.id, type).ok) return;
  }
  let bestTower = null;
  for (const t of run.towers) {
    if (t.level >= MAX_TOWER_LEVEL) continue;
    const cost = upgradeCost(t.type, t.level);
    if (run.credits < cost) continue;
    if (!bestTower || t.kills > bestTower.kills) bestTower = t;
  }
  if (bestTower) upgradeTower(run, bestTower.padId);
}

// Random placement: spends credits on random pads with random types,
// upgrades random towers, sometimes sells one — the anti-slop gate.
// It places towers (this is not a do-nothing bot), it just places
// them badly: far pads, wrong types for the wave, no upgrades on the
// towers doing the work, and it sells towers it needs.
export function randomBuild(run, rng) {
  const empty = run.pads.filter((p) => !p.tower);
  // Shuffle the pads, then buy until broke or out of pads.
  for (let i = empty.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [empty[i], empty[j]] = [empty[j], empty[i]];
  }
  for (const pad of empty) {
    if (run.credits < TOWER_DEFS.bolt.cost) break;
    if (rng() < 0.25) continue; // skips good pads, buys bad ones
    const type = TOWER_ORDER[Math.floor(rng() * TOWER_ORDER.length)];
    if (run.credits < TOWER_DEFS[type].cost) continue;
    placeTower(run, pad.id, type);
    // Sometimes upgrades a random tower instead of the one working.
    if (rng() < 0.3 && run.towers.length) {
      const t = run.towers[Math.floor(rng() * run.towers.length)];
      upgradeTower(run, t.padId);
    }
    // Sometimes sells a tower it just placed.
    if (rng() < 0.12 && run.towers.length) {
      const t = run.towers[Math.floor(rng() * run.towers.length)];
      sellTower(run, t.padId);
    }
  }
  startWave(run);
}
export function randomMidWave(run, rng) {
  if (rng() < 0.5) return;
  const empty = run.pads.filter((p) => !p.tower);
  if (!empty.length) return;
  const pad = empty[Math.floor(rng() * empty.length)];
  const type = TOWER_ORDER[Math.floor(rng() * TOWER_ORDER.length)];
  if (run.credits >= TOWER_DEFS[type].cost) placeTower(run, pad.id, type);
}

// Simulate a whole map. policy: 'decision' | 'random'.
// Returns the outcome.
export function simulateRun(map, policy, opts = {}) {
  const run = startRun(map);
  const seed = opts.seed ?? map.seed * 1000 + 7;
  const rng = mulberry32(seed);
  const maxSteps = Math.ceil(900 / DT); // 15 minutes of game time
  let steps = 0, midWaveTimer = 0;
  const events = [];
  while (!run.done && steps < maxSteps) {
    if (run.phase === 'build') {
      if (policy === 'decision') decisionBuild(run);
      else randomBuild(run, rng);
      midWaveTimer = 0;
    } else if (run.phase === 'fight') {
      midWaveTimer += DT;
      if (midWaveTimer >= 2) {
        midWaveTimer = 0;
        if (policy === 'decision') decisionMidWave(run);
        else randomMidWave(run, rng);
      }
    }
    const evs = stepRun(run, DT);
    events.push(...evs);
    steps++;
  }
  return {
    completed: run.done && run.reason === 'complete',
    reason: run.reason || (steps >= maxSteps ? 'timeout' : 'running'),
    score: run.score, waves: run.wavesCleared,
    kills: run.kills, leaked: run.leaked, lives: run.lives,
    creditsEarned: run.creditsEarned, creditsSpent: run.creditsSpent,
    towersPlaced: run.towersPlaced, towersSold: run.towersSold,
    upgradesBought: run.upgradesBought,
    time: run.time, steps,
    events: events.length,
  };
}

// Seeded RNG (mulberry32) — only the random bot uses it; the sim
// itself is fully deterministic.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- FPS guard (M5) ---
// Render-resolution ladder the game steps down when the frame rate
// sags. Each level is a scale factor applied to the full pixel ratio
// (min(devicePixelRatio, 2)) — relative, not absolute, so the guard
// actually lowers the render resolution on a DPR-1 display too, where
// an absolute ladder of [2, 1.5, 1.25, 1] would clamp to 1 at every
// rung and do nothing. Pure decision function so smoke tests can
// assert it.
export const PERF_LEVELS = [1, 0.75, 0.6, 0.5];
export const PERF_FPS_THRESHOLD = 45;
export const PERF_LOW_MS = 3000;
export function perfGuardStep(level, fps, lowMs) {
  const l = clamp(Math.floor(level) || 0, 0, PERF_LEVELS.length - 1);
  if (fps < PERF_FPS_THRESHOLD && lowMs >= PERF_LOW_MS && l < PERF_LEVELS.length - 1) return l + 1;
  return l;
}

// --- save (localStorage) ---
export function defaultSave() {
  return {
    version: SAVE_VERSION, best: {},
    totalRuns: 0, muted: false, shake: 1,
    reduceFlashing: null, music: true, sfx: true, volume: 0.6,
    textSize: 1, highContrast: false,
  };
}
export function serializeSave(save) { return JSON.stringify(save); }
export function parseSave(text) {
  const d = defaultSave();
  try {
    const s = JSON.parse(text);
    if (!s || typeof s !== 'object') return d;
    if (s.best && typeof s.best === 'object') {
      for (const [k, v] of Object.entries(s.best)) {
        if ((/^[1-9]$/.test(k) || /^[1-9][0-9]$/.test(k)) && v && typeof v === 'object'
          && Number.isFinite(v.score) && Number.isFinite(v.waves)) {
          d.best[k] = {
            score: clamp(Math.floor(v.score), 0, 10000000),
            waves: clamp(Math.floor(v.waves), 0, 60),
          };
        }
      }
    }
    if (Number.isInteger(s.totalRuns)) d.totalRuns = clamp(s.totalRuns, 0, 100000);
    if (typeof s.muted === 'boolean') d.muted = s.muted;
    if (typeof s.shake === 'number' && Number.isFinite(s.shake)) d.shake = clamp(s.shake, 0, 1);
    if (s.reduceFlashing === null || typeof s.reduceFlashing === 'boolean') d.reduceFlashing = s.reduceFlashing;
    if (typeof s.music === 'boolean') d.music = s.music;
    if (typeof s.sfx === 'boolean') d.sfx = s.sfx;
    if (typeof s.volume === 'number' && Number.isFinite(s.volume)) d.volume = clamp(s.volume, 0, 1);
    if ([1, 1.2, 1.4].includes(s.textSize)) d.textSize = s.textSize;
    if (typeof s.highContrast === 'boolean') d.highContrast = s.highContrast;
    return d;
  } catch { return d; }
}
export function recordBest(save, mapId, score, waves) {
  const prev = save.best[mapId];
  const best = {
    score: Math.max(prev ? prev.score : 0, score),
    waves: Math.max(prev ? prev.waves : 0, waves),
  };
  save.best[mapId] = best;
  return best;
}
