// Neon Bastion v0.1.0 — 3D neon tower defense (Three.js 0.160.0).
// Enemies stream along glowing paths toward the core; place towers on
// grid pads, upgrade and sell them, manage a tight credit economy.
// No auto-place, no "best tower" hint, no assist of any kind —
// placement IS the skill.
import * as THREE from 'three';
import {
  VERSION, MAPS, mapById, mapGeometry, pathPosition, padCoverage,
  GRID_COLS, GRID_ROWS, CELL, START_CREDITS, CORE_LIVES,
  TOWER_DEFS, TOWER_ORDER, towerStats, upgradeCost, sellValue,
  ENEMY_DEFS, FEEDBACK, FEEDBACK_LAYERS, isMapUnlocked,
  createRun, startRun as physicsStartRun, placeTower, upgradeTower, sellTower,
  startWave as physicsStartWave, stepRun, decisionBuild, decisionMidWave,
  PERF_LEVELS, PERF_FPS_THRESHOLD, PERF_LOW_MS, perfGuardStep,
  defaultSave, serializeSave, parseSave, recordBest, clamp,
} from './physics.js';

const $ = (id) => document.getElementById(id);
const SAVE_KEY = 'neon-bastion-save-v1';
const DT = 1 / 60;

// ---------- save ----------
let save = parseSave(localStorage.getItem(SAVE_KEY));
function persistSave() {
  try { localStorage.setItem(SAVE_KEY, serializeSave(save)); } catch { /* storage unavailable */ }
}
function reduceFlashingOn() {
  if (save.reduceFlashing !== null) return save.reduceFlashing;
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ---------- accessibility ----------
function applyAccessibility() {
  document.documentElement.style.fontSize = `${Math.round(save.textSize * 100)}%`;
  document.body.classList.toggle('high-contrast', !!save.highContrast);
}

// ---------- FPS guard ----------
let perfLevel = 0;
let lowFpsSince = null;
function fullPixelRatio() { return Math.min(window.devicePixelRatio || 1, 2); }
function applyPerfLevel(level, { silent = false } = {}) {
  perfLevel = clamp(Math.floor(level) || 0, 0, PERF_LEVELS.length - 1);
  // PERF_LEVELS are scale factors of the full pixel ratio (see
  // physics.js) — level 0 is full resolution, deeper levels render
  // at 75% / 60% / 50% of it.
  if (renderer) renderer.setPixelRatio(fullPixelRatio() * PERF_LEVELS[perfLevel]);
  if (!silent && perfLevel > 0) toast('Performance mode — lowered detail to keep the action smooth');
}
function resetPerf() {
  perfLevel = 0;
  lowFpsSince = null;
  if (renderer) renderer.setPixelRatio(fullPixelRatio());
}

// ---------- audio (Web Audio synth SFX + generative music) ----------
let audioCtx = null, masterGain = null, sfxGain = null, musicGain = null;
let noiseBuf = null;
let musicTimer = null, musicStep = 0, nextStepTime = 0;
let musicLeadOn = false;
const MUSIC_BPM = 112;
const BASS_LINE = [55, 0, 55, 65.41, 0, 55, 0, 49, 55, 0, 55, 65.41, 82.41, 0, 65.41, 49];
const LEAD_LINE = [440, 0, 523.25, 659.25, 0, 523.25, 0, 440, 392, 0, 440, 523.25, 659.25, 0, 587.33, 523.25];
function ensureAudio() {
  if (audioCtx) {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return;
  }
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = save.muted ? 0 : save.volume;
    masterGain.connect(audioCtx.destination);
    sfxGain = audioCtx.createGain(); sfxGain.gain.value = 1; sfxGain.connect(masterGain);
    musicGain = audioCtx.createGain(); musicGain.gain.value = 0.3; musicGain.connect(masterGain);
    noiseBuf = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.5, audioCtx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    startMusic();
  } catch { audioCtx = null; }
}
function tone({ freq = 440, freqEnd = null, dur = 0.1, type = 'square', vol = 0.2, when = 0 }) {
  if (!audioCtx || !save.sfx) return;
  const t0 = audioCtx.currentTime + when;
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (freqEnd !== null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t0 + dur);
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  osc.connect(g); g.connect(sfxGain);
  osc.start(t0); osc.stop(t0 + dur + 0.02);
}
function noise({ dur = 0.1, vol = 0.2, freq = 1000, when = 0, type = 'bandpass' }) {
  if (!audioCtx || !save.sfx) return;
  const t0 = audioCtx.currentTime + when;
  const src = audioCtx.createBufferSource();
  src.buffer = noiseBuf;
  const filter = audioCtx.createBiquadFilter();
  filter.type = type; filter.frequency.value = freq;
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  src.connect(filter); filter.connect(g); g.connect(sfxGain);
  src.start(t0); src.stop(t0 + dur + 0.02);
}
let lastZapAt = 0;
function sfx(name) {
  if (!audioCtx || !save.sfx) return;
  switch (name) {
    case 'tick': tone({ freq: 1200, dur: 0.03, type: 'sine', vol: 0.07 }); break;
    case 'zap': { // tower fire — frequent, so throttled and quiet
      const now = performance.now();
      if (now - lastZapAt < 70) return;
      lastZapAt = now;
      tone({ freq: 980, freqEnd: 620, dur: 0.05, type: 'square', vol: 0.05 });
      break;
    }
    case 'pulseFire': tone({ freq: 320, freqEnd: 120, dur: 0.12, type: 'sine', vol: 0.08 }); break;
    case 'frostFire': tone({ freq: 1400, freqEnd: 2100, dur: 0.08, type: 'sine', vol: 0.05 }); break;
    case 'place': tone({ freq: 520, dur: 0.07, type: 'triangle', vol: 0.16 }); tone({ freq: 780, dur: 0.09, type: 'triangle', vol: 0.14, when: 0.05 }); break;
    case 'upgrade': [660, 880, 1320].forEach((f, i) => tone({ freq: f, dur: 0.1, type: 'triangle', vol: 0.15, when: i * 0.06 })); break;
    case 'sell': tone({ freq: 660, freqEnd: 330, dur: 0.12, type: 'triangle', vol: 0.13 }); break;
    case 'kill': noise({ dur: 0.1, vol: 0.16, freq: 1800 }); tone({ freq: 520, freqEnd: 140, dur: 0.12, type: 'square', vol: 0.10 }); break;
    case 'bossKill': noise({ dur: 0.3, vol: 0.28, freq: 900 }); [392, 523, 784].forEach((f, i) => tone({ freq: f, dur: 0.18, type: 'triangle', vol: 0.16, when: i * 0.07 })); break;
    case 'leak': tone({ freq: 140, freqEnd: 55, dur: 0.3, type: 'sine', vol: 0.35 }); noise({ dur: 0.25, vol: 0.25, freq: 400 }); break;
    case 'waveStart': tone({ freq: 392, dur: 0.12, type: 'triangle', vol: 0.16 }); tone({ freq: 587, dur: 0.18, type: 'triangle', vol: 0.16, when: 0.1 }); break;
    case 'waveClear': [523, 659, 784, 1047].forEach((f, i) => tone({ freq: f, dur: 0.14, type: 'triangle', vol: 0.16, when: i * 0.07 })); break;
    case 'mapClear': [523, 659, 784, 1047, 1319, 1568].forEach((f, i) => tone({ freq: f, dur: 0.22, type: 'triangle', vol: 0.17, when: i * 0.09 })); break;
    case 'mapLost': [392, 330, 262, 196].forEach((f, i) => tone({ freq: f, dur: 0.32, type: 'sawtooth', vol: 0.13, when: i * 0.15 })); break;
    case 'launch': tone({ freq: 220, freqEnd: 660, dur: 0.3, type: 'sawtooth', vol: 0.11 }); break;
    case 'deny': tone({ freq: 180, dur: 0.09, type: 'square', vol: 0.10 }); break;
    default: break;
  }
}
function musicNote(freq, t0, dur, vol = 0.2, type = 'triangle') {
  if (!audioCtx || !save.music) return;
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + 0.02);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  osc.connect(g); g.connect(musicGain);
  osc.start(t0); osc.stop(t0 + dur + 0.02);
}
function startMusic() {
  if (!audioCtx || musicTimer) return;
  musicStep = 0;
  nextStepTime = audioCtx.currentTime + 0.1;
  const stepDur = 60 / MUSIC_BPM / 4; // 16th notes
  musicTimer = setInterval(() => {
    if (!audioCtx || !save.music) return;
    while (nextStepTime < audioCtx.currentTime + 0.2) {
      const i = musicStep % 16;
      const bass = BASS_LINE[i];
      if (bass) musicNote(bass, nextStepTime, stepDur * 1.8, 0.22, 'sawtooth');
      if (musicStep % 32 >= 16) {
        const lead = LEAD_LINE[i];
        if (lead) { musicNote(lead, nextStepTime, stepDur * 1.4, 0.10, 'triangle'); musicLeadOn = true; }
      }
      musicStep++;
      nextStepTime += stepDur;
    }
  }, 90);
}

// ---------- game state ----------
let phase = 'menu'; // 'menu' | 'run'
let paused = false;
let map = MAPS[0];
let selectedMapId = 1;
let run = null;
let demoRun = physicsStartRun(MAPS[0]);
let renderRun = demoRun; // what the scene renders: demo in menu, run in play
let selectedType = 'bolt';
let selectedPadId = null;
let speedMul = 1;
let seedUnlocked = false; // ?map= param bypasses the menu gates (playtests)
let trauma = 0;
let hitStopUntil = 0;
let slowMoUntil = 0, slowMoScale = 1;
let timeScale = 1;
let shakeStrength = save.shake;
let glowPulse = 0;
let fovCurrent = 50, fovPulse = 0;
let coreFlashT = 0;
let fpsEma = 60;
let lastFrameT = performance.now();
let lastHudAt = 0;
let accumulator = 0;
let midWaveTimer = 0;
let autoPilot = false;
let demoRestartAt = 0;
const feedbackLog = [];
function logFeedback(type, layers) {
  feedbackLog.push({ type, layers: [...layers], at: performance.now() });
  if (feedbackLog.length > 20) feedbackLog.shift();
}
function addTrauma(amount) { trauma = Math.min(1, trauma + amount); }
function doHitStop(seconds) {
  const until = performance.now() / 1000 + seconds;
  if (until > hitStopUntil) hitStopUntil = until; // newest hit-stop owns the restore
}
function doSlowMo(seconds, scale) {
  slowMoUntil = performance.now() / 1000 + seconds;
  slowMoScale = scale;
}

// ---------- three.js setup ----------
let renderer = null;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(fullPixelRatio());
  renderer.setSize(window.innerWidth, window.innerHeight);
  $('game-container').appendChild(renderer.domElement);
} catch { renderer = null; }

const scene = new THREE.Scene();
scene.background = new THREE.Color('#050514');
scene.fog = new THREE.FogExp2('#050514', 0.012);
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 300);
const CAM_BASE = new THREE.Vector3(0, 25, 21);
const CAM_LOOK = new THREE.Vector3(0, 0, 0.5);
camera.position.copy(CAM_BASE);
camera.lookAt(CAM_LOOK);

const hemi = new THREE.HemisphereLight('#8b9cf9', '#0a0618', 0.9);
scene.add(hemi);
const dirLight = new THREE.DirectionalLight('#cfe8ff', 1.4);
dirLight.position.set(12, 24, 8);
scene.add(dirLight);
const coreLight = new THREE.PointLight('#22d3ee', 1.2, 30);
scene.add(coreLight);

// Shared geometries / materials (reused, never per-entity).
const GEO = {
  pad: new THREE.CylinderGeometry(0.95, 1.05, 0.28, 24),
  padRim: new THREE.TorusGeometry(0.95, 0.06, 8, 32),
  pathSeg: new THREE.BoxGeometry(1, 0.08, 1),
  towerBase: new THREE.CylinderGeometry(0.62, 0.78, 0.5, 12),
  boltHead: new THREE.BoxGeometry(0.5, 0.34, 0.5),
  boltBarrel: new THREE.CylinderGeometry(0.09, 0.09, 0.85, 8),
  pulseHead: new THREE.SphereGeometry(0.42, 16, 12),
  frostHead: new THREE.ConeGeometry(0.42, 0.9, 6),
  grunt: new THREE.OctahedronGeometry(0.55, 0),
  runner: new THREE.TetrahedronGeometry(0.55, 0),
  armored: new THREE.BoxGeometry(0.95, 0.95, 0.95),
  boss: new THREE.IcosahedronGeometry(1.0, 0),
  core: new THREE.OctahedronGeometry(1.1, 0),
  portal: new THREE.TorusGeometry(1.1, 0.12, 10, 32),
  flowDot: new THREE.SphereGeometry(0.16, 8, 8),
  tracer: new THREE.BoxGeometry(0.12, 0.12, 1),
  ring: new THREE.RingGeometry(0.4, 0.55, 32),
  barBg: new THREE.PlaneGeometry(1.1, 0.14),
  barFg: new THREE.PlaneGeometry(1.06, 0.1),
  cityBox: new THREE.BoxGeometry(1, 1, 1),
};
const MAT = {
  ground: new THREE.MeshStandardMaterial({ color: '#0a0a24', roughness: 0.95, metalness: 0.1 }),
  gridLine: new THREE.LineBasicMaterial({ color: '#1c2a5e', transparent: true, opacity: 0.6 }),
  pad: new THREE.MeshStandardMaterial({ color: '#151238', roughness: 0.6, metalness: 0.4, emissive: '#241a5e', emissiveIntensity: 0.5 }),
  padRim: new THREE.MeshStandardMaterial({ color: '#241a5e', emissive: '#7c5cff', emissiveIntensity: 0.9, roughness: 0.4 }),
  padHover: new THREE.MeshStandardMaterial({ color: '#241a5e', emissive: '#22d3ee', emissiveIntensity: 1.6, roughness: 0.4 }),
  path: new THREE.MeshStandardMaterial({ color: '#0e7490', emissive: '#22d3ee', emissiveIntensity: 0.85, roughness: 0.3 }),
  core: new THREE.MeshStandardMaterial({ color: '#fef3c7', emissive: '#fbbf24', emissiveIntensity: 1.6, roughness: 0.2, metalness: 0.3 }),
  portal: new THREE.MeshStandardMaterial({ color: '#9d174d', emissive: '#f472b6', emissiveIntensity: 1.4, roughness: 0.3 }),
  towerBase: new THREE.MeshStandardMaterial({ color: '#1a1440', roughness: 0.5, metalness: 0.6 }),
  barBg: new THREE.MeshBasicMaterial({ color: '#1a0b1e', transparent: true, opacity: 0.85, depthWrite: false }),
  barFg: new THREE.MeshBasicMaterial({ color: '#fb7185', transparent: true, opacity: 0.95, depthWrite: false }),
  tracer: new THREE.MeshBasicMaterial({ color: '#a5f3fc', transparent: true, opacity: 0.95, depthWrite: false }),
  ringPulse: new THREE.MeshBasicMaterial({ color: '#f472b6', transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }),
  frostRing: new THREE.MeshBasicMaterial({ color: '#a78bfa', transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }),
};
function towerColor(type) { return TOWER_DEFS[type].color; }
function towerMaterial(type) {
  return new THREE.MeshStandardMaterial({
    color: '#0d0a24', emissive: towerColor(type), emissiveIntensity: 1.1, roughness: 0.35, metalness: 0.5,
  });
}
function enemyMaterial(type) {
  const def = ENEMY_DEFS[type];
  return new THREE.MeshStandardMaterial({
    color: '#160a18', emissive: def.color, emissiveIntensity: 1.2, roughness: 0.35, metalness: 0.4,
  });
}

// ---------- static scene: ground, void city, stars ----------
const ground = new THREE.Mesh(new THREE.PlaneGeometry(220, 220), MAT.ground);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -8;
scene.add(ground);
// Void city: distant glowing towers below and around the grid.
{
  const cityMat = new THREE.MeshStandardMaterial({ color: '#0b0b20', emissive: '#312e81', emissiveIntensity: 0.7, roughness: 0.8 });
  const cityMat2 = new THREE.MeshStandardMaterial({ color: '#0b0b20', emissive: '#831843', emissiveIntensity: 0.55, roughness: 0.8 });
  for (let i = 0; i < 46; i++) {
    const a = (i / 46) * Math.PI * 2 + (i % 5) * 0.13;
    const r = 26 + (i % 7) * 4;
    const h = 4 + (i % 9) * 2.2;
    const box = new THREE.Mesh(GEO.cityBox, i % 2 ? cityMat : cityMat2);
    box.position.set(Math.cos(a) * r, -8 + h / 2, Math.sin(a) * r);
    box.scale.set(2 + (i % 3), h, 2 + ((i + 1) % 3));
    scene.add(box);
  }
}
// Stars.
{
  const starGeo = new THREE.BufferGeometry();
  const starPos = new Float32Array(600 * 3);
  for (let i = 0; i < 600; i++) {
    const a = Math.random() * Math.PI * 2;
    const e = Math.random() * Math.PI * 0.45 + 0.08;
    const r = 120;
    starPos[i * 3] = Math.cos(a) * Math.cos(e) * r;
    starPos[i * 3 + 1] = Math.sin(e) * r;
    starPos[i * 3 + 2] = Math.sin(a) * Math.cos(e) * r;
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: '#c7d2fe', size: 0.7, sizeAttenuation: false }));
  scene.add(stars);
}

// ---------- per-map scene ----------
const mapGroup = new THREE.Group();
scene.add(mapGroup);
let padMeshes = []; // { mesh, rim, padId }
let towerMeshes = new Map(); // padId -> { group, head, barrel?, muzzle }
let enemyMeshes = new Map(); // enemy id -> { group, body, barBg, barFg }
let coreMesh = null, coreBaseY = 0;
let flowDots = [];
let pathGlowMat = MAT.path;
function clearMapGroup() {
  while (mapGroup.children.length) {
    const child = mapGroup.children.pop();
    mapGroup.remove(child);
  }
  padMeshes = [];
  towerMeshes.clear();
  enemyMeshes.clear();
  flowDots = [];
  coreMesh = null;
}
function buildMapScene(m) {
  clearMapGroup();
  const geo = mapGeometry(m);
  // Grid lines over the playfield.
  const halfW = (GRID_COLS * CELL) / 2, halfH = (GRID_ROWS * CELL) / 2;
  const linePts = [];
  for (let c = 0; c <= GRID_COLS; c++) {
    const x = -halfW + c * CELL;
    linePts.push(new THREE.Vector3(x, 0.02, -halfH), new THREE.Vector3(x, 0.02, halfH));
  }
  for (let r = 0; r <= GRID_ROWS; r++) {
    const z = -halfH + r * CELL;
    linePts.push(new THREE.Vector3(-halfW, 0.02, z), new THREE.Vector3(halfW, 0.02, z));
  }
  const gridGeo = new THREE.BufferGeometry().setFromPoints(linePts);
  mapGroup.add(new THREE.LineSegments(gridGeo, MAT.gridLine));
  // Playfield slab.
  const slab = new THREE.Mesh(
    new THREE.BoxGeometry(GRID_COLS * CELL + 1.6, 0.3, GRID_ROWS * CELL + 1.6),
    new THREE.MeshStandardMaterial({ color: '#0b0f2c', roughness: 0.85, metalness: 0.2 }),
  );
  slab.position.y = -0.18;
  mapGroup.add(slab);
  // Glowing path: one box per segment, slightly raised, plus a
  // waypoint pulse at each turn.
  pathGlowMat = new THREE.MeshStandardMaterial({
    color: '#0e7490', emissive: m.theme.ring, emissiveIntensity: 0.9, roughness: 0.3,
  });
  for (let i = 0; i < geo.waypoints.length - 1; i++) {
    const a = geo.waypoints[i], b = geo.waypoints[i + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const seg = new THREE.Mesh(GEO.pathSeg, pathGlowMat);
    seg.scale.set(1.5, 1, len + 1.2);
    seg.position.set((a.x + b.x) / 2, 0.05, (a.z + b.z) / 2);
    // The box is long in local Z: rotate it onto world X for segments
    // that run along X, leave it on Z for segments that run along Z.
    seg.rotation.y = Math.abs(b.x - a.x) > 0.01 ? Math.PI / 2 : 0;
    mapGroup.add(seg);
  }
  for (const wp of geo.waypoints) {
    const dot = new THREE.Mesh(GEO.flowDot, new THREE.MeshBasicMaterial({ color: m.theme.ring }));
    dot.position.set(wp.x, 0.12, wp.z);
    dot.scale.setScalar(2.2);
    mapGroup.add(dot);
  }
  // Entry portal.
  const portal = new THREE.Mesh(GEO.portal, MAT.portal);
  portal.position.set(geo.waypoints[0].x, 0.9, geo.waypoints[0].z);
  portal.rotation.y = Math.PI / 2;
  mapGroup.add(portal);
  // Core crystal at the path end.
  coreMesh = new THREE.Mesh(GEO.core, MAT.core.clone());
  const end = geo.waypoints[geo.waypoints.length - 1];
  coreBaseY = 1.0;
  coreMesh.position.set(end.x, coreBaseY, end.z);
  mapGroup.add(coreMesh);
  coreLight.position.set(end.x, 4, end.z);
  coreLight.color.set(m.theme.ring);
  // Pads.
  for (const pad of m.pads.map(([c, r], i) => ({ id: i, c, r }))) {
    const w = { x: (pad.c - (GRID_COLS - 1) / 2) * CELL, z: (pad.r - (GRID_ROWS - 1) / 2) * CELL };
    const mesh = new THREE.Mesh(GEO.pad, MAT.pad);
    mesh.position.set(w.x, 0.14, w.z);
    mesh.userData.padId = pad.id;
    const rim = new THREE.Mesh(GEO.padRim, MAT.padRim.clone());
    rim.rotation.x = -Math.PI / 2;
    rim.position.set(w.x, 0.3, w.z);
    rim.userData.padId = pad.id;
    mapGroup.add(mesh, rim);
    padMeshes.push({ mesh, rim, padId: pad.id });
  }
  // Flow dots travelling the path.
  for (let i = 0; i < 12; i++) {
    const dot = new THREE.Mesh(GEO.flowDot, new THREE.MeshBasicMaterial({ color: m.theme.accent }));
    mapGroup.add(dot);
    flowDots.push({ mesh: dot, s: (geo.length / 12) * i });
  }
}

// ---------- tracers / rings (pooled) ----------
const tracers = [];
for (let i = 0; i < 24; i++) {
  const t = new THREE.Mesh(GEO.tracer, MAT.tracer.clone());
  t.visible = false;
  scene.add(t);
  tracers.push({ mesh: t, life: 0 });
}
const rings = [];
for (let i = 0; i < 10; i++) {
  const r = new THREE.Mesh(GEO.ring, MAT.ringPulse.clone());
  r.visible = false;
  r.rotation.x = -Math.PI / 2;
  scene.add(r);
  rings.push({ mesh: r, life: 0, max: 1 });
}
function fireTracer(from, to, color) {
  const t = tracers.find((x) => x.life <= 0) || tracers[0];
  const dx = to.x - from.x, dz = to.z - from.z;
  const len = Math.hypot(dx, dz) || 1;
  t.mesh.position.set((from.x + to.x) / 2, 0.9, (from.z + to.z) / 2);
  t.mesh.scale.set(1, 1, len);
  t.mesh.rotation.y = Math.atan2(dx, dz);
  t.mesh.material.color.set(color);
  t.mesh.material.opacity = 0.95;
  t.mesh.visible = true;
  t.life = 0.12;
}
function fireRing(x, z, color, maxR) {
  const r = rings.find((x2) => x2.life <= 0) || rings[0];
  r.mesh.position.set(x, 0.15, z);
  r.mesh.material.color.set(color);
  r.mesh.material.opacity = 0.9;
  r.mesh.visible = true;
  r.life = 0.32;
  r.max = maxR;
}

// ---------- tower range preview ----------
// One shared ring showing the reach of the tower that would be placed
// on the hovered / selected pad — or the reach of the tower already
// there. Standard TD UI: it shows range, never which pad is best.
const rangeRingMat = new THREE.MeshBasicMaterial({ color: '#22d3ee', transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false });
const rangeRing = new THREE.Mesh(new THREE.RingGeometry(0.96, 1.0, 48), rangeRingMat);
rangeRing.rotation.x = -Math.PI / 2;
rangeRing.visible = false;
scene.add(rangeRing);
function updateRangeRing() {
  if (phase !== 'run' || !run || run.done || paused) { rangeRing.visible = false; return; }
  const padId = hoveredPadId !== null ? hoveredPadId : selectedPadId;
  if (padId === null) { rangeRing.visible = false; return; }
  const pad = run.pads.find((p) => p.id === padId);
  if (!pad) { rangeRing.visible = false; return; }
  let range, color;
  if (pad.tower) {
    range = towerStats(pad.tower.type, pad.tower.level).range;
    color = TOWER_DEFS[pad.tower.type].color;
  } else {
    range = towerStats(selectedType, 1).range;
    color = TOWER_DEFS[selectedType].color;
  }
  const r = range * CELL;
  rangeRing.position.set(pad.x, 0.32, pad.z);
  rangeRing.scale.set(r, r, 1);
  rangeRing.material.color.set(color);
  rangeRing.visible = true;
}

// ---------- particles (pooled THREE.Points) ----------
const PARTICLE_MAX = 400;
const pGeo = new THREE.BufferGeometry();
const pPos = new Float32Array(PARTICLE_MAX * 3);
const pCol = new Float32Array(PARTICLE_MAX * 3);
pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
const points = new THREE.Points(pGeo, new THREE.PointsMaterial({
  size: 0.28, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false,
}));
points.frustumCulled = false;
scene.add(points);
const particles = [];
for (let i = 0; i < PARTICLE_MAX; i++) {
  particles.push({ life: 0, max: 1, vx: 0, vy: 0, vz: 0 });
  pPos[i * 3 + 1] = -999;
}
function spawnBurst(x, z, colorHex, n, speed = 6, up = 4) {
  const col = new THREE.Color(colorHex);
  let spawned = 0;
  for (let i = 0; i < PARTICLE_MAX && spawned < n; i++) {
    const p = particles[i];
    if (p.life > 0) continue;
    const a = Math.random() * Math.PI * 2;
    const sp = speed * (0.4 + Math.random() * 0.8);
    p.vx = Math.cos(a) * sp;
    p.vz = Math.sin(a) * sp;
    p.vy = up * (0.4 + Math.random() * 0.8);
    p.life = p.max = 0.5 + Math.random() * 0.4;
    pPos[i * 3] = x; pPos[i * 3 + 1] = 0.6; pPos[i * 3 + 2] = z;
    pCol[i * 3] = col.r; pCol[i * 3 + 1] = col.g; pCol[i * 3 + 2] = col.b;
    spawned++;
  }
  pGeo.attributes.position.needsUpdate = true;
  pGeo.attributes.color.needsUpdate = true;
}
function updateParticles(dt) {
  for (let i = 0; i < PARTICLE_MAX; i++) {
    const p = particles[i];
    if (p.life <= 0) continue;
    p.life -= dt;
    if (p.life <= 0) { pPos[i * 3 + 1] = -999; continue; }
    p.vy -= 12 * dt;
    pPos[i * 3] += p.vx * dt;
    pPos[i * 3 + 1] += p.vy * dt;
    pPos[i * 3 + 2] += p.vz * dt;
    if (pPos[i * 3 + 1] < 0.05) { pPos[i * 3 + 1] = 0.05; p.vy = Math.abs(p.vy) * 0.4; }
  }
  pGeo.attributes.position.needsUpdate = true;
}

// ---------- feedback: pops, toast, flash ----------
function showPop(worldX, worldZ, text, cls = '') {
  const layer = $('pops');
  const divs = layer.querySelectorAll('.pop');
  let div = null;
  for (const d of divs) {
    if (d.dataset.busy !== '1') { div = d; break; }
  }
  if (!div) {
    if (divs.length >= 14) return;
    div = document.createElement('div');
    div.className = 'pop';
    layer.appendChild(div);
  }
  const sp = projectToScreen(worldX, 0.8, worldZ);
  div.style.left = `${sp.x}px`;
  div.style.top = `${sp.y}px`;
  div.textContent = text;
  div.className = `pop ${cls}`;
  div.dataset.busy = '1';
  void div.offsetWidth;
  div.classList.add('show');
  setTimeout(() => { div.classList.remove('show'); div.dataset.busy = '0'; }, 900);
}
let toastTimer = null;
function toast(msg) {
  const el = $('hud-toast');
  el.textContent = msg;
  el.classList.add('show');
  $('sr-status').textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}
function hideToast() {
  $('hud-toast').classList.remove('show');
  clearTimeout(toastTimer);
}
function flashCoreHit() {
  if (reduceFlashingOn()) return;
  const el = $('hit-flash');
  el.classList.remove('on');
  void el.offsetWidth;
  el.classList.add('on');
}

// One feedback call per event: the whole bundle (sound, particles,
// shake, hit-stop, slow-mo, flash, pop, toast, FOV pulse) fires
// together, within one frame.
function handleEvents(events) {
  for (const ev of events) {
    switch (ev.type) {
      case 'towerFire': {
        if (ev.kind === 'bolt') { sfx('zap'); fireTracer(ev.from, ev.to, '#a5f3fc'); }
        else if (ev.kind === 'pulse') { sfx('pulseFire'); fireRing(ev.to.x, ev.to.z, '#f472b6', ev.aoe || 3); spawnBurst(ev.to.x, ev.to.z, '#f472b6', 6, 4, 2); }
        else if (ev.kind === 'frost') { sfx('frostFire'); fireTracer(ev.from, ev.to, '#c4b5fd'); }
        break;
      }
      case 'spawn':
        spawnBurst(ev.x, ev.z, ENEMY_DEFS[ev.kind].color, 4, 2, 2);
        break;
      case 'kill': {
        sfx('kill');
        addTrauma(FEEDBACK.kill.trauma);
        spawnBurst(ev.x, ev.z, ENEMY_DEFS[ev.kind].color, ev.kind === 'boss' ? 26 : 10, 6, 4);
        showPop(ev.x, ev.z, `+${ev.reward}`, 'credit');
        logFeedback('kill', FEEDBACK_LAYERS.kill);
        break;
      }
      case 'bossKill':
        sfx('bossKill');
        addTrauma(0.3);
        spawnBurst(ev.x, ev.z, '#e879f9', 30, 9, 6);
        showPop(ev.x, ev.z, 'BOSS DOWN', 'heal');
        break;
      case 'waveClear': {
        sfx('waveClear');
        addTrauma(FEEDBACK.waveClear.trauma);
        doHitStop(FEEDBACK.waveClear.hitStop);
        fovPulse = 1;
        spawnBurst(0, 0, '#22d3ee', 24, 8, 5);
        showPop(0, 0, `Wave ${ev.wave} clear  +${ev.bonus}c`, 'heal');
        toast(`Wave ${ev.wave} clear — +${ev.bonus} credits`);
        logFeedback('waveClear', FEEDBACK_LAYERS.waveClear);
        break;
      }
      case 'leak': {
        sfx('leak');
        addTrauma(FEEDBACK.leak.trauma);
        doHitStop(FEEDBACK.leak.hitStop);
        doSlowMo(0.5, 0.35);
        flashCoreHit();
        coreFlashT = 0.5;
        const core = renderRun ? renderRun.core : null;
        if (core) spawnBurst(core.x, core.z, '#fb7185', 22, 8, 5);
        showPop(core ? core.x : 0, core ? core.z : 0, `-${ev.damage} core`, 'damage');
        toast(ev.damage >= 5 ? 'The boss broke through — the core is burning' : 'An enemy reached the core');
        logFeedback('leak', FEEDBACK_LAYERS.leak);
        break;
      }
      case 'mapClear': {
        sfx('mapClear');
        addTrauma(FEEDBACK.mapClear.trauma);
        doHitStop(FEEDBACK.mapClear.hitStop);
        fovPulse = 1;
        const core = renderRun ? renderRun.core : null;
        if (core) spawnBurst(core.x, core.z, '#fbbf24', 40, 10, 7);
        logFeedback('mapClear', FEEDBACK_LAYERS.mapClear);
        break;
      }
      case 'mapLost': {
        sfx('mapLost');
        addTrauma(FEEDBACK.mapLost.trauma);
        doHitStop(FEEDBACK.mapLost.hitStop);
        doSlowMo(0.9, 0.3);
        flashCoreHit();
        logFeedback('mapLost', FEEDBACK_LAYERS.mapLost);
        break;
      }
      default: break;
    }
  }
}
function placeFeedback(padId, type) {
  sfx('place');
  addTrauma(FEEDBACK.place.trauma);
  glowPulse = 1;
  const pad = renderRun ? renderRun.pads.find((p) => p.id === padId) : null;
  if (pad) {
    spawnBurst(pad.x, pad.z, towerColor(type), 14, 5, 4);
    showPop(pad.x, pad.z, TOWER_DEFS[type].name, 'heal');
  }
  logFeedback('place', FEEDBACK_LAYERS.place);
}
function upgradeFeedback(padId) {
  sfx('upgrade');
  addTrauma(FEEDBACK.upgrade.trauma);
  glowPulse = 1;
  const pad = renderRun ? renderRun.pads.find((p) => p.id === padId) : null;
  if (pad) {
    spawnBurst(pad.x, pad.z, '#fbbf24', 16, 6, 5);
    fireRing(pad.x, pad.z, '#fbbf24', 2.5);
    showPop(pad.x, pad.z, 'UPGRADED', 'heal');
  }
  logFeedback('upgrade', FEEDBACK_LAYERS.upgrade);
}
function sellFeedback(padId, value) {
  sfx('sell');
  addTrauma(FEEDBACK.sell.trauma);
  const pad = renderRun ? renderRun.pads.find((p) => p.id === padId) : null;
  if (pad) {
    spawnBurst(pad.x, pad.z, '#9db8d6', 10, 4, 3);
    showPop(pad.x, pad.z, `+${value}c`, 'credit');
  }
  logFeedback('sell', FEEDBACK_LAYERS.sell);
}

// ---------- screens (stack) ----------
const screenStack = [];
function showScreen(id) {
  for (const s of ['menu', 'howto', 'settings', 'complete', 'maplost', 'pause']) {
    if (s !== id) $(s).classList.add('hidden');
  }
  $(id).classList.remove('hidden');
  const panel = $(id).querySelector('.panel');
  if (panel) { panel.style.animation = 'none'; void panel.offsetWidth; panel.style.animation = ''; }
  const focusTarget = $(id).querySelector('.btn.primary') || $(id).querySelector('.btn') || $(id).querySelector('input, button');
  if (focusTarget) focusTarget.focus();
}
function pushScreen(id) {
  const top = screenStack[screenStack.length - 1];
  if (top === id) return;
  hideToast();
  if (top) $(top).classList.add('hidden');
  screenStack.push(id);
  showScreen(id);
}
function popScreen() {
  const id = screenStack.pop();
  if (id) $(id).classList.add('hidden');
  const top = screenStack[screenStack.length - 1];
  if (top) showScreen(top);
  return id;
}
function clearScreens() {
  hideToast();
  while (screenStack.length) popScreen();
  for (const s of ['menu', 'howto', 'settings', 'complete', 'maplost', 'pause']) $(s).classList.add('hidden');
}

// ---------- projection helpers (screen space) ----------
function projectToScreen(x, y, z) {
  const v = new THREE.Vector3(x, y, z).project(camera);
  return {
    x: (v.x * 0.5 + 0.5) * window.innerWidth,
    y: (-v.y * 0.5 + 0.5) * window.innerHeight,
    behind: v.z > 1,
  };
}
function screenToWorld(sx, sy) {
  const ndc = new THREE.Vector2((sx / window.innerWidth) * 2 - 1, -(sy / window.innerHeight) * 2 + 1);
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndc, camera);
  const t = -ray.ray.origin.y / ray.ray.direction.y;
  if (!Number.isFinite(t) || t < 0) return null;
  const p = ray.ray.origin.clone().add(ray.ray.direction.clone().multiplyScalar(t));
  return { x: p.x, z: p.z };
}

// ---------- HUD / build bar ----------
function refreshMapSelect() {
  const el = $('map-select');
  el.innerHTML = '';
  for (const m of MAPS) {
    const best = save.best[m.id];
    const unlocked = isMapUnlocked(save.best, m.id) || seedUnlocked;
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'map-card' + (m.id === selectedMapId ? ' selected' : '') + (unlocked ? '' : ' locked');
    card.style.setProperty('--card-accent', m.theme.ring);
    card.innerHTML = `<span class="map-name">${m.id}. ${m.name}</span>`
      + `<span class="map-meta">${m.waves.length} waves &middot; ${m.waves.reduce((n, w) => n + w.groups.reduce((a, g) => a + g.count, 0), 0)} enemies &middot; ${mapGeometry(m).lengthCells} cells of path</span>`
      + (!unlocked
        ? `<span class="map-best map-locked">Clear Map ${m.id - 1} to unlock</span>`
        : best ? `<span class="map-best">Best ${best.score.toLocaleString()} &middot; ${best.waves}/${m.waves.length} waves</span>` : '<span class="map-best">Not cleared yet</span>');
    card.addEventListener('click', () => {
      ensureAudio(); sfx('tick');
      if (!unlocked) {
        toast(`Clear Map ${m.id - 1} to unlock ${m.name}`);
        $('map-hint').textContent = `Locked — clear ${MAPS[m.id - 2].name} first.`;
        return;
      }
      selectedMapId = m.id;
      refreshMapSelect();
      $('map-hint').textContent = m.hint;
    });
    el.appendChild(card);
  }
  const m = mapById(selectedMapId);
  $('map-hint').textContent = m ? m.hint : '';
  const best = save.best[selectedMapId];
  $('menu-best').textContent = best ? `Best on ${mapById(selectedMapId).name}: ${best.score.toLocaleString()} (${best.waves}/${mapById(selectedMapId).waves.length} waves)` : '';
}
function buildTowerCards() {
  const el = $('tower-cards');
  el.innerHTML = '';
  TOWER_ORDER.forEach((type, i) => {
    const def = TOWER_DEFS[type];
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'tower-card';
    card.dataset.type = type;
    card.style.setProperty('--card-accent', def.color);
    card.innerHTML = `<span class="tc-name">${def.name}</span>`
      + `<span class="tc-cost">${def.cost} credits</span>`
      + `<span class="tc-key">${i + 1} — ${def.desc}</span>`;
    card.addEventListener('click', () => {
      ensureAudio(); sfx('tick');
      selectType(type);
    });
    el.appendChild(card);
  });
  refreshTowerCards();
}
function refreshTowerCards() {
  for (const card of document.querySelectorAll('.tower-card')) {
    const type = card.dataset.type;
    card.classList.toggle('selected', type === selectedType);
    card.classList.toggle('cant-afford', !!(run && run.credits < TOWER_DEFS[type].cost));
  }
}
function selectType(type) {
  if (!TOWER_DEFS[type]) return;
  selectedType = type;
  refreshTowerCards();
}
function updateHUD() {
  if (!run) return;
  $('hud-map').textContent = `Map ${map.id} — ${map.name}`;
  $('hud-wave').textContent = run.done
    ? `Wave ${run.wavesCleared}/${map.waves.length}`
    : `Wave ${Math.min(run.waveIndex + 1, map.waves.length)}/${map.waves.length}${run.phase === 'build' ? ' — build' : ''}`;
  const livesEl = $('hud-lives');
  livesEl.textContent = `Core ${run.lives}/${run.maxLives}`;
  livesEl.classList.toggle('low', run.lives <= 5);
  $('hud-credits').textContent = `Credits ${run.credits}`;
  $('hud-score').textContent = `Score ${run.score.toLocaleString()}`;
  $('low-lives').classList.toggle('on', run.lives <= 5 && !run.done);
  const waveBtn = $('btn-wave');
  if (run.done) {
    waveBtn.disabled = true;
    waveBtn.textContent = run.reason === 'complete' ? 'Map Held' : 'Core Breached';
  } else if (run.phase === 'build') {
    waveBtn.disabled = false;
    waveBtn.textContent = `Start Wave ${run.waveIndex + 1} (Space)`;
  } else {
    waveBtn.disabled = true;
    waveBtn.textContent = `Wave ${run.waveIndex + 1} running…`;
  }
  $('btn-speed').textContent = `Speed ${speedMul}x`;
  refreshTowerCards();
  refreshSelectedPanel();
  updateRangeRing();
}
function refreshSelectedPanel() {
  const panel = $('selected-panel');
  if (selectedPadId === null || !run) { panel.classList.add('hidden'); return; }
  const pad = run.pads.find((p) => p.id === selectedPadId);
  if (!pad || !pad.tower) { panel.classList.add('hidden'); return; }
  const t = pad.tower;
  const def = TOWER_DEFS[t.type];
  panel.classList.remove('hidden');
  $('selected-name').textContent = `${def.name} Tower`;
  $('selected-level').textContent = `Level ${t.level} · ${t.kills} kills`;
  const upBtn = $('btn-upgrade');
  const cost = upgradeCost(t.type, t.level);
  if (cost === null) { upBtn.disabled = true; upBtn.textContent = 'Max level'; }
  else {
    upBtn.disabled = run.credits < cost;
    upBtn.textContent = `Upgrade — ${cost}c (U)`;
  }
  $('btn-sell').textContent = `Sell — ${sellValue(t.type, t.level)}c (X)`;
}
function updateMuteLabels() {
  const label = save.muted ? 'Sound: Off' : 'Sound: On';
  for (const id of ['btn-mute-hud', 'btn-mute-menu', 'btn-mute-pause']) {
    const el = $(id);
    if (el) el.textContent = label;
  }
}
function applySettingsToUI() {
  applyAccessibility();
  $('volume-range').value = Math.round(save.volume * 100);
  $('volume-value').textContent = `${Math.round(save.volume * 100)}%`;
  $('shake-range').value = Math.round(save.shake * 100);
  $('shake-value').textContent = `${Math.round(save.shake * 100)}%`;
  $('shake-range-pause').value = Math.round(save.shake * 100);
  $('shake-value-pause').textContent = `${Math.round(save.shake * 100)}%`;
  $('music-toggle').checked = save.music;
  $('sfx-toggle').checked = save.sfx;
  $('reduce-flashing').checked = !!save.reduceFlashing;
  $('text-size-select').value = String(save.textSize);
  $('high-contrast-toggle').checked = !!save.highContrast;
  shakeStrength = save.shake;
  if (masterGain) masterGain.gain.value = save.muted ? 0 : save.volume;
  updateMuteLabels();
}

// ---------- entity sync (sim -> meshes) ----------
function syncTowers() {
  if (!renderRun) return;
  const seen = new Set();
  for (const t of renderRun.towers) {
    seen.add(t.padId);
    let entry = towerMeshes.get(t.padId);
    if (!entry) {
      const group = new THREE.Group();
      const base = new THREE.Mesh(GEO.towerBase, MAT.towerBase);
      base.position.y = 0.45;
      group.add(base);
      const mat = towerMaterial(t.type);
      let head;
      if (t.type === 'bolt') {
        head = new THREE.Group();
        const box = new THREE.Mesh(GEO.boltHead, mat);
        box.position.y = 0.95;
        const barrel = new THREE.Mesh(GEO.boltBarrel, mat);
        barrel.rotation.x = Math.PI / 2;
        barrel.position.set(0, 0.95, 0.5);
        head.add(box, barrel);
        head.userData.barrel = barrel;
      } else if (t.type === 'pulse') {
        head = new THREE.Group();
        const sphere = new THREE.Mesh(GEO.pulseHead, mat);
        sphere.position.y = 1.0;
        head.add(sphere);
      } else {
        head = new THREE.Group();
        const cone = new THREE.Mesh(GEO.frostHead, mat);
        cone.position.y = 1.0;
        head.add(cone);
      }
      group.add(head);
      // Level pips: small glowing spheres that appear per level.
      const pips = [];
      for (let i = 0; i < 3; i++) {
        const pip = new THREE.Mesh(
          new THREE.SphereGeometry(0.09, 8, 8),
          new THREE.MeshBasicMaterial({ color: towerColor(t.type) }),
        );
        pip.position.set(-0.3 + i * 0.3, 0.28, 0.75);
        pip.visible = false;
        group.add(pip);
        pips.push(pip);
      }
      group.position.set(t.x, 0, t.z);
      group.userData.padId = t.padId;
      mapGroup.add(group);
      entry = { group, head, pips, type: t.type, level: t.level };
      towerMeshes.set(t.padId, entry);
    }
    // Aim the head at the tower's current target (furthest enemy in
    // range), and show the level pips.
    let target = null;
    const stats = towerStats(t.type, t.level);
    const range = stats.range * CELL;
    for (const e of renderRun.enemies) {
      const d2 = (e.x - t.x) * (e.x - t.x) + (e.z - t.z) * (e.z - t.z);
      if (d2 <= range * range && (!target || e.s > target.s)) target = e;
    }
    if (target) entry.head.rotation.y = Math.atan2(target.x - t.x, target.z - t.z);
    entry.pips.forEach((pip, i) => { pip.visible = i < t.level; });
    entry.level = t.level;
  }
  for (const [padId, entry] of [...towerMeshes]) {
    if (!seen.has(padId)) {
      mapGroup.remove(entry.group);
      towerMeshes.delete(padId);
    }
  }
}
function syncEnemies() {
  if (!renderRun) return;
  const seen = new Set();
  for (const e of renderRun.enemies) {
    seen.add(e.id);
    let entry = enemyMeshes.get(e.id);
    if (!entry) {
      const group = new THREE.Group();
      const body = new THREE.Mesh(GEO[e.type], enemyMaterial(e.type));
      body.position.y = 0.7;
      group.add(body);
      const barBg = new THREE.Mesh(GEO.barBg, MAT.barBg);
      barBg.position.y = 1.7;
      const barFg = new THREE.Mesh(GEO.barFg, MAT.barFg.clone());
      barFg.position.set(0, 1.7, 0.01);
      group.add(barBg, barFg);
      group.position.set(e.x, 0, e.z);
      mapGroup.add(group);
      entry = { group, body, barBg, barFg };
      enemyMeshes.set(e.id, entry);
    }
    entry.group.position.set(e.x, 0, e.z);
    const slowed = renderRun.time < e.slowUntil;
    entry.body.material.emissive.set(slowed ? '#818cf8' : ENEMY_DEFS[e.type].color);
    entry.body.rotation.y += 0.03;
    entry.body.position.y = 0.7 + Math.sin(renderRun.time * 6 + e.id) * 0.08;
    const frac = Math.max(0, e.hp / e.maxHp);
    entry.barFg.scale.x = frac;
    entry.barFg.position.x = -(1 - frac) * 0.53;
    entry.barFg.visible = e.hp < e.maxHp;
    entry.barBg.visible = e.hp < e.maxHp;
    // Health bars face the camera.
    entry.barBg.lookAt(camera.position);
    entry.barFg.lookAt(camera.position);
    // Bosses read bigger.
    const s = e.type === 'boss' ? 1.5 : 1;
    entry.body.scale.setScalar(s);
  }
  for (const [id, entry] of [...enemyMeshes]) {
    if (!seen.has(id)) {
      mapGroup.remove(entry.group);
      enemyMeshes.delete(id);
    }
  }
}

// ---------- picking (raycast — the pad clicked on screen is the pad that gets the tower) ----------
const raycaster = new THREE.Raycaster();
function pickAt(sx, sy) {
  if (!renderer) return null;
  const ndc = new THREE.Vector2((sx / window.innerWidth) * 2 - 1, -(sy / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const targets = [];
  for (const p of padMeshes) targets.push(p.mesh, p.rim);
  for (const [, entry] of towerMeshes) entry.group.traverse((o) => { if (o.isMesh) targets.push(o); });
  const hits = raycaster.intersectObjects(targets, false);
  for (const h of hits) {
    let o = h.object;
    while (o) {
      if (o.userData && o.userData.padId !== undefined) return o.userData.padId;
      o = o.parent;
    }
  }
  return null;
}
let hoveredPadId = null;
function setHover(padId) {
  if (hoveredPadId === padId) return;
  for (const p of padMeshes) {
    if (p.padId === hoveredPadId) p.rim.material = p.rim.userData.baseMat;
  }
  hoveredPadId = padId;
  if (padId !== null) {
    const entry = padMeshes.find((p) => p.padId === padId);
    if (entry) {
      if (!entry.rim.userData.baseMat) entry.rim.userData.baseMat = entry.rim.material;
      entry.rim.material = MAT.padHover;
    }
  }
  document.body.style.cursor = padId !== null ? 'pointer' : '';
  updateRangeRing();
}
// One click path, used by real pointer events AND the test hooks:
// the pad under the cursor is the pad that acts.
function clickAt(sx, sy) {
  if (phase !== 'run' || paused || !run || run.done) return { ok: false, reason: 'not in a run' };
  const padId = pickAt(sx, sy);
  if (padId === null) { selectedPadId = null; refreshSelectedPanel(); return { ok: false, reason: 'no pad' }; }
  const pad = run.pads.find((p) => p.id === padId);
  if (!pad) return { ok: false, reason: 'no pad' };
  if (pad.tower) {
    selectedPadId = padId;
    refreshSelectedPanel();
    sfx('tick');
    return { ok: true, action: 'select', padId };
  }
  const res = doPlace(padId, selectedType);
  return { ...res, action: 'place', padId };
}

// ---------- actions (player + hooks share these) ----------
function doPlace(padId, type) {
  if (!run || run.done) return { ok: false, reason: 'run over' };
  const res = placeTower(run, padId, type);
  if (res.ok) {
    selectedPadId = null;
    placeFeedback(padId, type);
    updateHUD();
  } else {
    sfx('deny');
    toast(res.reason === 'not enough credits' ? 'Not enough credits' : res.reason);
  }
  return res;
}
function doUpgrade(padId) {
  if (!run || run.done || padId === null) return { ok: false, reason: 'no tower selected' };
  const res = upgradeTower(run, padId);
  if (res.ok) {
    upgradeFeedback(padId);
    updateHUD();
  } else {
    sfx('deny');
    toast(res.reason === 'max level' ? 'Tower is at max level' : res.reason === 'not enough credits' ? 'Not enough credits' : res.reason);
  }
  return res;
}
function doSell(padId) {
  if (!run || run.done || padId === null) return { ok: false, reason: 'no tower selected' };
  const res = sellTower(run, padId);
  if (res.ok) {
    selectedPadId = null;
    sellFeedback(padId, res.value);
    updateHUD();
  } else {
    sfx('deny');
    toast(res.reason);
  }
  return res;
}
function doStartWave() {
  if (!run || run.done) return { ok: false, reason: 'run over' };
  const res = physicsStartWave(run);
  if (res.ok) {
    sfx('waveStart');
    addTrauma(FEEDBACK.waveStart.trauma);
    fovPulse = 1;
    toast(`Wave ${res.wave} incoming`);
    logFeedback('waveStart', FEEDBACK_LAYERS.waveStart);
    updateHUD();
  } else {
    sfx('deny');
    toast(res.reason);
  }
  return res;
}
function toggleSpeed() {
  speedMul = speedMul === 1 ? 2 : 1;
  sfx('tick');
  updateHUD();
}
function toggleMute() {
  save.muted = !save.muted;
  persistSave();
  if (masterGain) masterGain.gain.value = save.muted ? 0 : save.volume;
  updateMuteLabels();
}

// ---------- game flow ----------
let endHandled = false;
function startMap(mapId) {
  const m = mapById(mapId);
  if (!m) return;
  ensureAudio();
  map = m;
  selectedMapId = m.id;
  run = physicsStartRun(m);
  renderRun = run;
  endHandled = false;
  buildMapScene(m);
  phase = 'run';
  paused = false;
  selectedPadId = null;
  selectedType = 'bolt';
  speedMul = 1;
  accumulator = 0;
  midWaveTimer = 0;
  resetPerf();
  clearScreens();
  $('hud').classList.remove('hidden');
  $('build-bar').classList.remove('hidden');
  $('low-lives').classList.remove('on');
  save.totalRuns++;
  persistSave();
  updateHUD();
  refreshTowerCards();
  sfx('launch');
  toast(`${m.name} — place your towers, then start wave 1`);
}
function onRunEnd() {
  if (!run || !run.done || endHandled) return;
  endHandled = true;
  const best = recordBest(save, map.id, run.score, run.wavesCleared);
  persistSave();
  $('build-bar').classList.add('hidden');
  if (run.reason === 'complete') {
    $('complete-score').textContent = `Score ${run.score.toLocaleString()}`;
    $('complete-detail').textContent = `${map.name} held — ${run.wavesCleared}/${map.waves.length} waves, ${run.lives}/${run.maxLives} core lives left, ${run.kills} kills.`;
    $('complete-best').textContent = `Best on ${map.name}: ${best.score.toLocaleString()} (${best.waves}/${map.waves.length} waves)`;
    $('btn-next').classList.toggle('hidden', map.id >= MAPS.length);
    $('btn-next').textContent = map.id < MAPS.length ? `Next Map — ${MAPS[map.id].name}` : 'Next Map';
    pushScreen('complete');
  } else {
    $('maplost-text').textContent = `The swarm broke through on wave ${run.wavesCleared + 1}.`;
    $('maplost-stats').textContent = `${run.kills} kills · ${run.leaked} leaked · score ${run.score.toLocaleString()}`;
    $('maplost-best').textContent = best.waves ? `Best on ${map.name}: ${best.score.toLocaleString()} (${best.waves}/${map.waves.length} waves)` : '';
    pushScreen('maplost');
  }
}
function quitToMenu() {
  phase = 'menu';
  paused = false;
  run = null;
  selectedPadId = null;
  resetPerf();
  updateRangeRing();
  clearScreens();
  $('hud').classList.add('hidden');
  $('build-bar').classList.add('hidden');
  $('low-lives').classList.remove('on');
  refreshMenuScene();
  refreshMapSelect();
  pushScreen('menu');
}
function refreshMenuScene() {
  map = mapById(selectedMapId) || MAPS[0];
  demoRun = physicsStartRun(map);
  renderRun = demoRun;
  buildMapScene(map);
}
function pauseGame() {
  if (phase !== 'run' || !run || run.done || paused) return;
  paused = true;
  pushScreen('pause');
}
function resumeGame() {
  if (!paused) return;
  paused = false;
  popScreen();
}
function restartCurrentRun() {
  if (!map) return;
  paused = false;
  startMap(map.id);
}

// ---------- autopilot (decision bot through the public hooks) ----------
function driveAutopilot(r) {
  if (!r || r.done) return;
  if (r.phase === 'build') {
    decisionBuild(r);
    midWaveTimer = 0;
  }
}
function driveMidWave(r, dt) {
  if (!r || r.done || r.phase !== 'fight') return;
  midWaveTimer += dt;
  if (midWaveTimer >= 2) {
    midWaveTimer = 0;
    decisionMidWave(r);
  }
}

// ---------- input: pointer ----------
let pointerDown = null;
if (renderer) {
  const canvas = renderer.domElement;
  canvas.addEventListener('pointerdown', (e) => {
    pointerDown = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!pointerDown) return;
    const dx = e.clientX - pointerDown.x, dy = e.clientY - pointerDown.y;
    pointerDown = null;
    if (Math.hypot(dx, dy) > 8) return; // it was a drag, not a click
    ensureAudio();
    clickAt(e.clientX, e.clientY);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (phase !== 'run' || paused || !run || run.done) { setHover(null); return; }
    setHover(pickAt(e.clientX, e.clientY));
  });
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    paused = true;
    toast('Graphics paused — the 3D context was lost. It will resume when restored.');
  });
  canvas.addEventListener('webglcontextrestored', () => {
    paused = false;
    toast('Graphics restored.');
  });
}

// ---------- input: keyboard ----------
document.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
    if (e.key !== 'Escape') return;
  }
  if (e.key === 'Escape') {
    if (screenStack.length > 1) { popScreen(); return; }
    if (selectedPadId !== null) { selectedPadId = null; refreshSelectedPanel(); return; }
    if (phase === 'run') pauseGame();
    return;
  }
  if (phase === 'menu') {
    if (e.key === 'Enter' && screenStack[screenStack.length - 1] === 'menu') {
      ensureAudio();
      startMap(selectedMapId);
    }
    return;
  }
  if (phase !== 'run') return;
  switch (e.key) {
    case '1': ensureAudio(); selectType('bolt'); break;
    case '2': ensureAudio(); selectType('pulse'); break;
    case '3': ensureAudio(); selectType('frost'); break;
    case 'u': case 'U': ensureAudio(); doUpgrade(selectedPadId); break;
    case 'x': case 'X': ensureAudio(); doSell(selectedPadId); break;
    case ' ': e.preventDefault(); ensureAudio(); if (!paused) doStartWave(); break;
    case 'f': case 'F': toggleSpeed(); break;
    case 'p': case 'P': paused ? resumeGame() : pauseGame(); break;
    case 'm': case 'M': toggleMute(); break;
    case 'r': case 'R': restartCurrentRun(); break;
    default: break;
  }
});

// ---------- UI wiring ----------
function wire(id, fn) { const el = $(id); if (el) el.addEventListener('click', () => { ensureAudio(); fn(); }); }
wire('btn-play', () => { sfx('launch'); startMap(selectedMapId); });
wire('btn-howto', () => pushScreen('howto'));
wire('btn-howto-close', () => popScreen());
wire('btn-settings', () => pushScreen('settings'));
wire('btn-settings-close', () => popScreen());
wire('btn-next', () => startMap(map.id + 1));
wire('btn-replay', () => startMap(map.id));
wire('btn-retry', () => startMap(map.id));
wire('btn-menu-complete', () => quitToMenu());
wire('btn-menu-maplost', () => quitToMenu());
wire('btn-resume', () => resumeGame());
wire('btn-restart', () => restartCurrentRun());
wire('btn-quit', () => quitToMenu());
wire('btn-pause', () => pauseGame());
wire('btn-speed', () => toggleSpeed());
wire('btn-wave', () => doStartWave());
wire('btn-upgrade', () => doUpgrade(selectedPadId));
wire('btn-sell', () => doSell(selectedPadId));
wire('btn-mute-hud', () => toggleMute());
wire('btn-mute-menu', () => toggleMute());
wire('btn-mute-pause', () => toggleMute());
// Hover tick on every button (throttled).
let lastTickAt = 0;
document.addEventListener('mouseover', (e) => {
  if (!e.target.closest || !e.target.closest('.btn, .map-card, .tower-card, .icon-btn')) return;
  const now = performance.now();
  if (now - lastTickAt < 60) return;
  lastTickAt = now;
  sfx('tick');
});
// Settings inputs.
$('volume-range').addEventListener('input', (e) => {
  save.volume = clamp(Number(e.target.value) / 100, 0, 1);
  persistSave(); applySettingsToUI();
});
$('shake-range').addEventListener('input', (e) => {
  save.shake = clamp(Number(e.target.value) / 100, 0, 1);
  persistSave(); applySettingsToUI();
});
$('shake-range-pause').addEventListener('input', (e) => {
  save.shake = clamp(Number(e.target.value) / 100, 0, 1);
  persistSave(); applySettingsToUI();
});
$('music-toggle').addEventListener('change', (e) => { save.music = e.target.checked; persistSave(); });
$('sfx-toggle').addEventListener('change', (e) => { save.sfx = e.target.checked; persistSave(); });
$('reduce-flashing').addEventListener('change', (e) => { save.reduceFlashing = e.target.checked; persistSave(); });
$('text-size-select').addEventListener('change', (e) => { save.textSize = Number(e.target.value); persistSave(); applySettingsToUI(); });
$('high-contrast-toggle').addEventListener('change', (e) => { save.highContrast = e.target.checked; persistSave(); applySettingsToUI(); });

// ---------- frame loop ----------
function frame(t) {
  requestAnimationFrame(frame);
  const now = performance.now();
  const realDt = Math.min((now - lastFrameT) / 1000, 0.1);
  lastFrameT = now;
  if (realDt > 0) fpsEma = fpsEma * 0.95 + (1 / realDt) * 0.05;

  // FPS guard (run phase only).
  if (phase === 'run' && !paused && run && !run.done) {
    if (fpsEma < PERF_FPS_THRESHOLD) {
      if (lowFpsSince === null) lowFpsSince = now;
      else if (now - lowFpsSince >= PERF_LOW_MS) {
        applyPerfLevel(perfLevel + 1);
        lowFpsSince = null;
      }
    } else lowFpsSince = null;
  }

  // Trauma / pulses decay with real time, so shake settles during hit-stop.
  trauma = Math.max(0, trauma - realDt * 1.4);
  fovPulse = Math.max(0, fovPulse - realDt * 1.8);
  glowPulse = Math.max(0, glowPulse - realDt * 2);
  coreFlashT = Math.max(0, coreFlashT - realDt);

  const slowActive = now / 1000 < slowMoUntil;
  timeScale = slowActive ? slowMoScale : 1;
  const hitStop = now / 1000 < hitStopUntil;

  // Step the sim (demo in the menu, run in play).
  const activeRun = phase === 'menu' ? demoRun : run;
  if (renderer && activeRun && !paused && !hitStop) {
    const rate = phase === 'menu' ? 1 : speedMul;
    accumulator += realDt * timeScale * rate;
    let steps = 0;
    // Catch-up cap: the sim is cheap next to rendering, so a slow
    // frame may run up to 30 fixed steps (0.5s of sim) instead of
    // falling behind real time — otherwise a software renderer
    // throttles the game itself. realDt is clamped to 0.1s above, so
    // this can never spiral: at most 0.1s * 4x speed = 24 steps.
    while (accumulator >= DT && steps < 30) {
      accumulator -= DT;
      steps++;
      if (phase === 'menu') {
        driveAutopilot(demoRun);
        driveMidWave(demoRun, DT);
        const evs = stepRun(demoRun, DT);
        handleEvents(evs);
        if (demoRun.done) {
          demoRun = physicsStartRun(map);
          renderRun = demoRun;
        }
      } else {
        if (autoPilot) {
          driveAutopilot(run);
          driveMidWave(run, DT);
        }
        const evs = stepRun(run, DT);
        handleEvents(evs);
        if (run.done) onRunEnd();
      }
    }
    if (steps === 30) accumulator = 0;
  }

  // Camera: slow orbit in the menu, fixed + trauma shake in a run.
  if (renderer) {
    if (phase === 'menu') {
      const a = t * 0.00004;
      camera.position.set(Math.sin(a) * 26, 22, Math.cos(a) * 26);
      camera.lookAt(0, 0, 0);
    } else {
      const amp = trauma * trauma * 0.55 * shakeStrength;
      const shX = amp * Math.sin(t * 0.09);
      const shY = amp * Math.cos(t * 0.113);
      camera.position.set(CAM_BASE.x + shX, CAM_BASE.y + shY, CAM_BASE.z);
      camera.lookAt(CAM_LOOK);
    }
    const targetFov = 50 + fovPulse * 4;
    if (Math.abs(fovCurrent - targetFov) > 0.05) {
      fovCurrent = targetFov;
      camera.fov = fovCurrent;
      camera.updateProjectionMatrix();
    }
  }

  // Animate the scene: core, path flow, flow dots, tracers, rings.
  const timeS = t / 1000;
  if (coreMesh) {
    coreMesh.rotation.y += realDt * 0.8;
    const pulse = 1 + Math.sin(timeS * 2.2) * 0.08;
    coreMesh.scale.setScalar(pulse);
    coreMesh.material.emissive.set(coreFlashT > 0 ? '#fb7185' : '#fbbf24');
    coreMesh.material.emissiveIntensity = coreFlashT > 0 ? 2.2 : 1.6;
    coreMesh.position.y = coreBaseY + Math.sin(timeS * 1.6) * 0.12;
  }
  if (pathGlowMat) pathGlowMat.emissiveIntensity = 0.85 + Math.sin(timeS * 2) * 0.2;
  const geo = map ? mapGeometry(map) : null;
  if (geo) {
    for (const fd of flowDots) {
      fd.s += realDt * 3.2;
      if (fd.s > geo.length) fd.s -= geo.length;
      const pos = pathPosition(map, fd.s);
      fd.mesh.position.set(pos.x, 0.25, pos.z);
    }
  }
  for (const tr of tracers) {
    if (tr.life <= 0) continue;
    tr.life -= realDt;
    if (tr.life <= 0) tr.mesh.visible = false;
    else tr.mesh.material.opacity = Math.max(0, tr.life / 0.12) * 0.95;
  }
  for (const rg of rings) {
    if (rg.life <= 0) continue;
    rg.life -= realDt;
    if (rg.life <= 0) { rg.mesh.visible = false; continue; }
    const frac = 1 - rg.life / 0.32;
    rg.mesh.scale.setScalar(0.5 + frac * rg.max);
    rg.mesh.material.opacity = (1 - frac) * 0.9;
  }
  updateParticles(realDt);
  syncTowers();
  syncEnemies();
  if (phase === 'run' && now - lastHudAt > 100) { lastHudAt = now; updateHUD(); }

  if (renderer) renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  if (!renderer) return;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- public hooks (bot + render check drive the game through these) ----------
window.__bastion = {
  get version() { return VERSION; },
  get state() {
    return {
      phase, paused,
      mapId: map ? map.id : null,
      selectedMapId,
      credits: run ? run.credits : null,
      lives: run ? run.lives : null,
      score: run ? run.score : null,
      waveIndex: run ? run.waveIndex : null,
      waves: map ? map.waves.length : null,
      runPhase: run ? run.phase : null,
      done: run ? run.done : null,
      reason: run ? run.reason : null,
      perf: { fps: Math.round(fpsEma), pixelRatio: renderer ? renderer.getPixelRatio() : null, level: perfLevel },
    };
  },
  maps() {
    return MAPS.map((m) => ({
      id: m.id, name: m.name, waves: m.waves.length,
      best: save.best[m.id] || null,
      unlocked: isMapUnlocked(save.best, m.id) || seedUnlocked,
    }));
  },
  unlocks() {
    return { maps: Object.fromEntries(MAPS.map((m) => [m.id, isMapUnlocked(save.best, m.id) || seedUnlocked])) };
  },
  info() {
    const r = run || (phase === 'menu' ? demoRun : null);
    if (!r) return null;
    return {
      mapId: map.id, mapName: map.name, waves: map.waves.length,
      phase: r.phase, waveIndex: r.waveIndex,
      credits: r.credits, lives: r.lives, maxLives: r.maxLives,
      score: r.score, kills: r.kills, leaked: r.leaked,
      towersPlaced: r.towersPlaced, upgradesBought: r.upgradesBought,
      towers: r.towers.map((t) => ({
        padId: t.padId, type: t.type, level: t.level, x: t.x, z: t.z, kills: t.kills,
        screen: projectToScreen(t.x, 0.8, t.z),
      })),
      enemies: r.enemies.map((e) => ({
        id: e.id, type: e.type, x: e.x, z: e.z, hp: e.hp, maxHp: e.maxHp, s: e.s,
        screen: projectToScreen(e.x, 0.7, e.z),
      })),
      pads: r.pads.map((p) => ({
        id: p.id, col: p.col, row: p.row, x: p.x, z: p.z,
        occupied: !!p.tower, type: p.tower ? p.tower.type : null, level: p.tower ? p.tower.level : null,
        screen: projectToScreen(p.x, 0.3, p.z),
        coverage: padCoverage(map, [p.col, p.row], 2.9).ratio,
      })),
      core: { x: r.core.x, z: r.core.z, screen: projectToScreen(r.core.x, 1, r.core.z) },
      selectedType, selectedPadId,
      done: r.done, reason: r.reason,
      trauma, timeScale, fov: fovCurrent, fovPulse,
      shakeAmp: trauma * trauma * shakeStrength,
      perf: { fps: Math.round(fpsEma), pixelRatio: renderer ? renderer.getPixelRatio() : null, level: perfLevel },
      feedback: feedbackLog.map((f) => ({ type: f.type, layers: [...f.layers] })),
      audio: audioCtx
        ? { state: audioCtx.state, music: !!musicTimer, musicStep, lead: musicLeadOn, sfxOn: save.sfx, musicOn: save.music }
        : null,
    };
  },
  start(mapId) { startMap(mapId ?? selectedMapId); },
  restart() { restartCurrentRun(); },
  pause() { pauseGame(); },
  resume() { resumeGame(); },
  quitToMenu() { quitToMenu(); },
  selectMap(id) { selectedMapId = id; refreshMapSelect(); refreshMenuScene(); },
  selectType(type) { selectType(type); },
  place(padId, type) { return doPlace(padId, type ?? selectedType); },
  upgrade(padId) { return doUpgrade(padId); },
  sell(padId) { return doSell(padId); },
  startWave() { return doStartWave(); },
  setSpeed(mul) { speedMul = [1, 2, 4].includes(mul) ? mul : 1; updateHUD(); },
  padScreen(padId) {
    const r = run || demoRun;
    const pad = r ? r.pads.find((p) => p.id === padId) : null;
    if (!pad) return null;
    return projectToScreen(pad.x, 0.3, pad.z);
  },
  selectPadAtScreen(sx, sy) { return pickAt(sx, sy); },
  clickAt(sx, sy) { return clickAt(sx, sy); },
  autopilot(on) { autoPilot = !!on; },
  setShake(v) { save.shake = clamp(v, 0, 1); shakeStrength = save.shake; persistSave(); applySettingsToUI(); },
  setReduceFlashing(b) { save.reduceFlashing = !!b; persistSave(); applySettingsToUI(); },
  setTextSize(v) {
    save.textSize = [1, 1.2, 1.4].includes(v) ? v : 1;
    persistSave(); applySettingsToUI();
  },
  setHighContrast(b) { save.highContrast = !!b; persistSave(); applySettingsToUI(); },
  debugPerfSetLevel(level) {
    applyPerfLevel(level, { silent: true });
    return renderer ? renderer.getPixelRatio() : null;
  },
  get shake() { return shakeStrength; },
  get reduceFlashing() { return reduceFlashingOn(); },
  save() { return JSON.parse(JSON.stringify(save)); },
};

// ---------- boot ----------
{
  // Seed path (Apex lesson): ?map=N selects that map directly,
  // bypassing the menu gates, so playtests can reach every map.
  // It is not shown anywhere in the player-facing UI.
  const params = new URLSearchParams(window.location.search);
  const seedMap = Number(params.get('map'));
  if (Number.isInteger(seedMap) && seedMap >= 1 && seedMap <= MAPS.length) {
    selectedMapId = seedMap;
    seedUnlocked = true;
  }
}
buildTowerCards();
refreshMapSelect();
applySettingsToUI();
updateMuteLabels();
refreshMenuScene();
if (renderer) {
  pushScreen('menu');
  requestAnimationFrame((t) => { lastFrameT = t; requestAnimationFrame(frame); });
} else {
  $('menu').classList.remove('hidden');
  $('webgl-error').classList.remove('hidden');
}
