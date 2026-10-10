import * as THREE from 'three';
import { Keyboard3D } from '../js/keyboard3d.js';
import { KEYS, KEY_BY_CODE, charToCode, codeToChar, keyLabel, FingerTracker, travel } from '../js/layout.js';
import { Stats, PAUSE_MS, isWordStart } from '../js/stats.js';
import { WORDS } from '../js/words.js';
import { LOCKED_HSL } from '../js/colors.js';
import { FREQ_BY_LETTER, LETTER_FREQUENCY } from './letter-frequency.js';
import {
  ITEMS, ITEM_ORDER, ENEMIES, MAX_LEVEL, POWER, LANE, START_GOLD, START_LIVES,
  upgradeCost, scrapValue, waveSpec, waveBonus, keyCostMult, keyPowerMult,
  OPENING_PICKS, OPENING_KEY_POOL, SKIP_GOLD, rerollCost,
  NON_OPENING, AMP_RANGE, MODS, BOSS_EVERY, BANES, BANE_WORD_SHARE, BOARD_GAP, setLanePlayers,
} from './defs.js';
import { GEO, hex, textSprite, buildItem, disposeTree, itemHSL, CardArt } from './models.js';
import { Room, MAX_PLAYERS } from './net.js';

const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const isLetterCode = c => /^Key[A-Z]$/.test(c);
const letterOf = code => codeToChar(code);
const goldNow = () => Math.floor(G.gold); // mines pay fractional gold on common keys
const BEST_KEY = 'keydefense.best';
const NAME_KEY = 'keydefense.name';
const LETTER_CODES = 'abcdefghijklmnopqrstuvwxyz'.split('').map(charToCode);
const COMMON_CODES = LETTER_FREQUENCY.slice(0, OPENING_KEY_POOL).map(f => charToCode(f.letter));

// Typing in the game feeds the same statistics (and daily goal) as the trainer.
const stats = new Stats();
const fingers = new FingerTracker();

// ---------- network role
// solo: no network. host: runs the official game (enemies, damage, lives) and relays.
// guest: mirrors the host's enemies and sends its keystrokes; keeps its own gold/drafts/upgrades.
const NET = { role: 'solo', room: null, me: 0, lobby: [], started: false };
const isAuth = () => NET.role !== 'guest';
const isMulti = () => NET.role !== 'solo';
const toHost = msg => NET.room?.send(msg);
const toGuests = (msg, except) => NET.room?.broadcast(msg, except);

// ---------- game state

// players: [{ name, id }] — id is the PeerJS id ('host' for the host), used to route guest messages.
function newGame(players) {
  return {
    phase: 'draft',  // 'lobby' | 'draft' | 'shop' | 'ready' (waiting for others) | 'wave' | 'over'
    draft: null,     // { towers, keys, tower, picksLeft, picksTotal, rerolls }
    wave: 1,
    gold: START_GOLD,     // this player's gold
    lives: START_LIVES,   // shared
    players: players.map(p => ({ name: p.name, id: p.id, items: new Map(), ready: false, slow: [], online: true })),
    totals: { words: 0, clean: 0, hits: 0, misses: 0, kills: 0, mined: 0 },
    streak: 0,        // this player's consecutive clean words
    keyTimes: {},     // this run's typing speed per letter key: code -> { sum, n }
    bane: null,       // active boss bane: { kind, letters: { [pid]: [l, l, l] } }
    lastBane: null,
    seenMods: {},
  };
}

let G = newGame([{ name: 'You', id: 'host' }]);
G.phase = 'lobby';
let enemies = [], fx = [], spawnQueue = [], spawnTimer = 0, spawnInterval = 1, nextEnemyId = 1, snapTimer = 0;
let time = 0, paused = false;
let selectedKey = null, hoverCard = -1, viewAll = false;
let wave = null; // this player's per-wave typing stats
let best = 0;
try { best = Number(localStorage.getItem(BEST_KEY)) || 0; } catch { /* storage unavailable */ }
const myItems = () => G.players[NET.me].items;
const PLAYER_COLORS = ['#ffd166', '#4fc3f7', '#b388ff', '#7ee06a'];

// ---------- 3D scene: one keyboard per player side by side, the lane behind all of them

const kb = new Keyboard3D($('#kb'), { onSelect: code => onKeyClick(code), onHover: hover });
const scene = kb.scene;
kb.controls.maxDistance = 140;

const BOARD_W = 18.25, KEY_Y = 0.53; // keyboard width and resting key height (from keyboard3d.js)
const slotX = (pid, n = G.players.length) => (pid - (n - 1) / 2) * BOARD_GAP;
const boards = []; // pid -> { root, keys: Map(code -> key state), own }
let boardLabels = [];

// Our own keyboard is the trainer's Keyboard3D (clickable); other players get visual clones.
function makeBoards(n) {
  for (const b of boards) {
    if (b.own) continue;
    scene.remove(b.root);
    for (const s of b.keys.values()) s.mat.dispose();
  }
  boards.length = 0;
  for (const s of boardLabels) { scene.remove(s); disposeTree(s); }
  boardLabels = [];
  for (let pid = 0; pid < n; pid++) {
    const x = slotX(pid, n) - BOARD_W / 2;
    if (pid === NET.me) {
      kb.root.position.x = x;
      boards.push({ root: kb.root, keys: kb.keys, own: true });
    } else {
      const root = kb.root.clone(true);
      root.position.x = x;
      const keys = new Map();
      root.traverse(o => {
        if (!o.isMesh || !o.userData.code) return;
        o.material = o.material.clone();
        o.parent.position.y = KEY_Y;
        keys.set(o.userData.code, { g: o.parent, mat: o.material, y: 0, pressUntil: 0 });
      });
      scene.add(root);
      boards.push({ root, keys, own: false });
    }
    if (n > 1) {
      const p = G.players[pid];
      const label = textSprite(pid === NET.me ? `${p.name} (you)` : p.name, pid === NET.me ? '#ffd166' : '#cfd3da');
      label.position.set(slotX(pid, n), 0.4, 4.3);
      label.scale.set(4.8, 1.2, 1);
      scene.add(label);
      boardLabels.push(label);
    }
  }
}

function keyTop(pid, code) {
  const k = KEY_BY_CODE[code];
  return boards[pid].root.localToWorld(new THREE.Vector3(k.x + k.w / 2, KEY_Y + 0.27, k.y + 0.5));
}

function pressKey(pid, code) {
  const b = boards[pid];
  if (!b) return;
  if (b.own) kb.press(code);
  else {
    const s = b.keys.get(code);
    if (s) s.pressUntil = performance.now() + 110;
  }
}

function setKeyColor(pid, code, hsl) {
  const b = boards[pid];
  if (!b) return;
  if (b.own) kb.setKeyColor(code, hsl);
  else b.keys.get(code)?.mat.color.setHSL(...hsl);
}

function animateClones(now) {
  for (const b of boards) {
    if (b.own) continue;
    for (const s of b.keys.values()) {
      const pressed = s.pressUntil > now;
      s.y += ((pressed ? -0.14 : 0) - s.y) * 0.4;
      s.g.position.y = KEY_Y + s.y;
      const v = pressed ? 0.25 : 0;
      s.mat.emissive.setRGB(v, v, v);
    }
  }
}

function fitView() {
  const cam = kb.camera, deg = THREE.MathUtils.degToRad;
  const n = G.players.length, all = viewAll || n === 1;
  const cx = all ? 0 : slotX(NET.me, n), halfW = all ? LANE.startX + 2 : 14;
  const vf = deg(cam.fov), hf = 2 * Math.atan(Math.tan(vf / 2) * cam.aspect);
  const dist = Math.max(halfW / Math.tan(hf / 2), 5.8 / Math.tan(vf / 2));
  const elev = deg(52), target = new THREE.Vector3(cx, 0.4, -1.4);
  kb.controls.target.copy(target);
  cam.position.set(target.x, target.y + Math.sin(elev) * dist, target.z + Math.cos(elev) * dist);
  kb.controls.update();
}
kb.resetView = fitView;
let userMoved = false;
const camAtStart = new THREE.Vector3();
kb.controls.addEventListener('start', () => camAtStart.copy(kb.camera.position));
kb.controls.addEventListener('end', () => {
  if (kb.camera.position.distanceTo(camAtStart) > 0.01) userMoved = true;
});
new ResizeObserver(() => { if (!userMoved) requestAnimationFrame(fitView); }).observe($('#kb'));
$('#kb').addEventListener('dblclick', () => { userMoved = false; fitView(); });
$('#viewBtn').addEventListener('click', () => {
  viewAll = !viewAll;
  userMoved = false;
  fitView();
  renderViewBtn();
});
function renderViewBtn() {
  const btn = $('#viewBtn');
  btn.hidden = G.players.length < 2 || G.phase === 'lobby';
  btn.textContent = viewAll ? 'View: everyone' : 'View: my keyboard';
}

let laneGroup = null;
function buildLane() {
  if (laneGroup) { scene.remove(laneGroup); disposeTree(laneGroup); }
  laneGroup = new THREE.Group();
  const len = LANE.startX - LANE.goalX, cx = (LANE.startX + LANE.goalX) / 2;
  const ground = new THREE.Mesh(
    new THREE.BoxGeometry(len, 0.12, LANE.width),
    new THREE.MeshStandardMaterial({ color: 0x1a2230, roughness: 0.9 }),
  );
  ground.position.set(cx, 0.2, LANE.z);
  laneGroup.add(ground);
  for (const side of [-1, 1]) {
    const rail = new THREE.Mesh(
      new THREE.BoxGeometry(len, 0.14, 0.1),
      new THREE.MeshStandardMaterial({ color: 0x2f7cf6, emissive: 0x1f5fd6, emissiveIntensity: 0.6 }),
    );
    rail.position.set(cx, 0.3, LANE.z + (side * LANE.width) / 2);
    laneGroup.add(rail);
  }
  const pad = (x, color, label) => {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(1.4, 0.3, 1.8),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.35, roughness: 0.5 }),
    );
    m.position.set(x, 0.3, LANE.z);
    laneGroup.add(m);
    const s = textSprite(label, hex(color));
    s.material.depthTest = false;
    s.position.set(x, 1.15, LANE.z - 1.3);
    laneGroup.add(s);
  };
  pad(LANE.startX + 0.7, 0x2f7cf6, 'START');
  pad(LANE.goalX - 0.7, 0xff6b5b, 'GOAL');
  scene.add(laneGroup);
}

// ---------- towers on keys

// ---- Amplifier aura: a soft pink glow over the keys it boosts, pulsing, flaring when typed.
const auras = new Set();
let auraTexture = null;
function getAuraTexture() {
  if (auraTexture) return auraTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.28)');
  grad.addColorStop(0.82, 'rgba(255,255,255,0.45)'); // brighter rim marks the edge of the boost
  grad.addColorStop(0.9, 'rgba(255,255,255,0.12)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  auraTexture = new THREE.CanvasTexture(c);
  return auraTexture;
}

function removeAura(it) {
  if (!it.aura) return;
  it.aura.parent?.remove(it.aura);
  it.aura.material.dispose();
  it.aura.geometry.dispose();
  auras.delete(it);
  it.aura = null;
}

function addAura(pid, code, it) {
  const k = KEY_BY_CODE[code], size = (AMP_RANGE + 0.55) * 2;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshBasicMaterial({
      map: getAuraTexture(), color: ITEMS.amp.color, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, opacity: 0.6,
    }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(k.x + k.w / 2, KEY_Y + 0.235, k.y + 0.5); // just above the key tops
  mesh.renderOrder = 2;
  boards[pid].root.add(mesh);
  it.aura = mesh;
  it.pulse = 0;
  auras.add(it);
}

function animateAuras(now) {
  for (const it of auras) {
    const flare = Math.max(0, 1 - (now - it.pulse) / 350);
    const base = 0.38 + 0.08 * it.level;
    it.aura.material.opacity = base + 0.12 * Math.sin(now / 420) + 0.5 * flare;
    it.aura.scale.setScalar(1 + 0.03 * Math.sin(now / 420) + 0.06 * flare);
  }
}

function mountItem(pid, code, it) {
  if (it.obj) {
    it.obj.parent?.remove(it.obj);
    disposeTree(it.obj);
  }
  removeAura(it);
  it.obj = buildItem(it.type, it.level);
  it.obj.position.set(0, 0.21, -0.12);
  boards[pid].keys.get(code).g.add(it.obj);
  if (it.type === 'amp') addAura(pid, code, it);
  paintKey(pid, code);
}

// level 0 removes the item.
function setItem(pid, code, type, level) {
  const items = G.players[pid]?.items;
  if (!items) return;
  const cur = items.get(code);
  if (!level) {
    if (cur) {
      cur.obj?.parent?.remove(cur.obj);
      if (cur.obj) disposeTree(cur.obj);
      removeAura(cur);
      items.delete(code);
    }
    paintKey(pid, code);
    return;
  }
  if (cur && cur.type !== type) removeAura(cur);
  const it = cur && cur.type === type ? cur : { type, level, obj: cur?.obj ?? null, shots: 0, damage: 0, pid };
  it.level = level;
  items.set(code, it);
  mountItem(pid, code, it);
}

// A change made by this player: apply locally and tell everyone else.
function changeItem(code, type, level) {
  setItem(NET.me, code, type, level);
  if (NET.role === 'host') toGuests({ t: 'item', pid: NET.me, code, type, level });
  else if (NET.role === 'guest') toHost({ t: 'item', code, type, level });
}

function paintKey(pid, code) {
  const it = G.players[pid]?.items.get(code);
  let hsl = [0.6, 0.06, 0.24];
  if (it) hsl = itemHSL(it.type);
  else if (!isLetterCode(code)) hsl = LOCKED_HSL;
  else if (pid === NET.me && G.phase === 'draft' && G.draft?.keys.includes(code)) {
    // the three offered keys glow (in the selected tower's color once one is chosen)
    const type = G.draft.towers[G.draft.tower];
    if (!type) hsl = [0.12, 0.55, 0.5];
    else {
      const [h, s] = itemHSL(type);
      hsl = [h, Math.min(1, s * 2), 0.5];
    }
  }
  setKeyColor(pid, code, hsl);
}
const paintKeys = () => G.players.forEach((p, pid) => KEYS.forEach(k => paintKey(pid, k.code)));

// ---------- enemies

const enemyById = new Map();

function spawnEnemy(spec) {
  const def = ENEMIES[spec.type];
  const mat = new THREE.MeshStandardMaterial({ color: def.color, roughness: 0.5, metalness: 0.1 });
  const shape = { grunt: GEO.sphere, runner: GEO.cone, tank: GEO.dodeca, boss: GEO.ico }[spec.type];
  const body = new THREE.Mesh(shape, mat);
  body.scale.setScalar(def.size);
  if (spec.type === 'runner') body.rotation.z = Math.PI / 2; // point along the direction of travel
  const group = new THREE.Group();
  group.add(body);
  const bar = new THREE.Group();
  bar.position.y = def.size + 0.28;
  const bg = new THREE.Mesh(GEO.plane, new THREE.MeshBasicMaterial({ color: 0x111111 }));
  bg.scale.set(0.8, 0.1, 1);
  const fg = new THREE.Mesh(GEO.plane, new THREE.MeshBasicMaterial({ color: 0x6fdc6f }));
  fg.scale.set(0.76, 0.06, 1);
  fg.position.z = 0.002;
  bar.add(bg, fg);
  group.add(bar);
  group.position.set(LANE.startX, LANE.y + def.size, LANE.z);
  scene.add(group);
  const e = {
    id: spec.id, type: spec.type, def, hp: spec.hp, maxHp: spec.hp, dist: 0, off: (Math.random() - 0.5) * 0.6,
    slow: 0, slowUntil: 0, flashUntil: 0, phase: Math.random() * 6, dead: false, group, body, mat, bar, fg,
    mod: spec.mod, shield: spec.mod === 'shield', lock: spec.lock ?? null, haste: 1,
    poisonDps: 0, poisonUntil: 0, poisonSrc: null,
    bane: spec.bane ? { ...spec.bane, openUntil: 0 } : null,
  };
  if (e.shield || e.bane?.kind === 'shield') {
    e.bubble = new THREE.Mesh(GEO.sphere, new THREE.MeshBasicMaterial({ color: 0x66b3ff, transparent: true, opacity: 0.3, depthWrite: false }));
    e.bubble.scale.setScalar(def.size * 1.5);
    group.add(e.bubble);
  }
  // letter tag: a locked enemy's letter, or (on a bane boss) your own slow keys
  const myBane = e.bane?.letters[NET.me] ?? [];
  const tag = e.lock ? e.lock.toUpperCase() : e.bane ? myBane.map(l => l.toUpperCase()).join(' ') : null;
  if (tag) {
    e.tag = textSprite(tag, e.bane ? '#ff9b8a' : '#ffd166');
    e.tag.material.depthTest = false;
    e.tag.scale.set(e.bane ? 3.6 : 2.8, e.bane ? 0.9 : 0.7, 1);
    e.tag.position.y = def.size + 0.75;
    group.add(e.tag);
  }
  enemies.push(e);
  enemyById.set(e.id, e);
  return e;
}

// Host/solo: create the next enemy of the wave and tell guests.
function hostSpawn(raw) {
  const spec = {
    id: nextEnemyId++, type: raw.type, hp: raw.hp, mod: raw.mod,
    lock: raw.mod === 'lock' ? letterOf(COMMON_CODES[Math.floor(Math.random() * COMMON_CODES.length)]) : null,
    bane: raw.type === 'boss' && G.bane ? G.bane : null,
  };
  spawnEnemy(spec);
  toGuests({ t: 'spawn', spec });
}

function removeEnemy(e) {
  e.dead = true;
  enemyById.delete(e.id);
  scene.remove(e.group);
  e.group.traverse(o => {
    if (o.material) {
      o.material.map?.dispose();
      o.material.dispose();
    }
  });
}

// The word this player is typing right now; letter-locked enemies only take damage from a
// player whose current word contains their letter.
let curWord = '';

function vulnerable(e, pid, word) {
  if (e.dead || e.shield) return false;
  if (e.lock && !word.includes(e.lock)) return false;
  const B = e.bane;
  if (B?.kind === 'lock' && !(B.letters[pid] ?? []).some(l => word.includes(l))) return false;
  if (B?.kind === 'shield' && time > B.openUntil) return false;
  return true;
}
const shieldedNow = e => e.shield || (e.bane?.kind === 'shield' && time > e.bane.openUntil);

// ---- authoritative reactions (host/solo) to what players type

function onTypo(pid, ch) {
  for (const e of enemies) {
    if (e.dead) continue;
    if (e.mod === 'frenzy') e.haste = Math.min(2.5, e.haste + 0.25);
    if (e.bane?.kind === 'frenzy') {
      const bump = (e.bane.letters[pid] ?? []).includes(ch) ? 0.4 : 0.2; // typos on your slow keys count double
      e.haste = Math.min(3, e.haste + bump);
    }
  }
}

function onCleanWord(pid, word) {
  // a clean word breaks the shield on the shielded enemy closest to the goal
  const shielded = enemies.filter(e => !e.dead && e.shield);
  if (shielded.length) {
    const t = leader(shielded);
    t.shield = false;
    ringFx(t.group.position.clone(), 0x66b3ff, 1);
  }
  for (const e of enemies) {
    if (e.dead || e.bane?.kind !== 'shield') continue;
    if ((e.bane.letters[pid] ?? []).some(l => word.includes(l))) {
      e.bane.openUntil = time + 3;
      ringFx(e.group.position.clone(), 0xff9b8a, 1.6);
    }
  }
}

function damage(e, dmg, it, quiet = false) {
  if (e.dead) return;
  const dealt = Math.min(e.hp, dmg);
  e.hp -= dmg;
  if (!quiet) e.flashUntil = time + 0.08;
  if (it) {
    it.damage += dealt;
    if (it.pid != null) dmgAcc[it.pid] = (dmgAcc[it.pid] || 0) + dealt;
  }
  if (e.hp <= 0) {
    popFx(e.group.position.clone(), e.def.color, e.def.size);
    removeEnemy(e);
    G.totals.kills++;
    toGuests({ t: 'die', id: e.id });
  }
}

function leak(e) {
  removeEnemy(e);
  G.lives = Math.max(0, G.lives - e.def.leak);
  ringFx(new THREE.Vector3(LANE.goalX - 0.7, 0.5, LANE.z), 0xff6b5b, 1.4);
  toGuests({ t: 'die', id: e.id, leak: true, lives: G.lives });
  renderHud();
  if (G.lives <= 0) hostGameOver();
}

function updateEnemies(dt) {
  const camQ = kb.camera.quaternion, auth = isAuth();
  for (const e of enemies) {
    if (e.dead) continue;
    const slowed = time < e.slowUntil;
    e.dist += e.def.speed * e.haste * (slowed ? 1 - e.slow : 1) * dt;
    const end = LANE.startX - LANE.goalX;
    if (e.dist >= end) {
      if (auth) {
        leak(e);
        if (G.phase === 'over') return;
        continue;
      }
      e.dist = end; // guests wait for the host to report the leak
    }
    if (auth && e.poisonDps) {
      if (time < e.poisonUntil) { if (!shieldedNow(e)) damage(e, e.poisonDps * dt, e.poisonSrc, true); }
      else e.poisonDps = 0;
      if (e.dead) continue;
    }
    const bob = Math.abs(Math.sin(time * 6 + e.phase)) * 0.08;
    e.group.position.set(LANE.startX - e.dist, 0.26 + e.def.size + bob, LANE.z + e.off);
    if (e.type === 'tank' || e.type === 'boss') e.body.rotation.y += dt;
    if (time < e.flashUntil) e.mat.emissive.setRGB(0.9, 0.9, 0.9);
    else if (e.haste > 1) e.mat.emissive.setRGB(0.25 * (e.haste - 1) + 0.1 * Math.sin(time * 12), 0.05, 0);
    else if (e.poisonDps) e.mat.emissive.setRGB(0.05, 0.3, 0.05);
    else if (slowed) e.mat.emissive.setRGB(0.1, 0.35, 0.6);
    else e.mat.emissive.setRGB(0, 0, 0);
    if (e.tag) e.tag.material.opacity = vulnerable(e, NET.me, curWord) ? 1 : 0.4;
    if (e.bubble) e.bubble.visible = shieldedNow(e);
    const r = Math.max(0, e.hp / e.maxHp);
    e.bar.quaternion.copy(camQ);
    e.fg.scale.x = 0.76 * r;
    e.fg.position.x = -0.38 * (1 - r);
    e.fg.material.color.setHSL(0.33 * r, 0.6, 0.5);
  }
  enemies = enemies.filter(e => !e.dead);
}

// Host -> guests, 10 times a second: positions, health and status of every enemy.
function snapshot() {
  return {
    t: 'snap', lives: G.lives,
    e: enemies.map(e => [
      e.id, +e.dist.toFixed(2), Math.round(e.hp), +e.haste.toFixed(2),
      (e.shield ? 1 : 0) | (time < e.slowUntil ? 2 : 0) | (e.poisonDps ? 4 : 0) | (e.bane && time <= e.bane.openUntil ? 8 : 0),
    ]),
  };
}

function applySnapshot(msg) {
  G.lives = msg.lives;
  for (const [id, dist, hp, haste, f] of msg.e) {
    const e = enemyById.get(id);
    if (!e) continue;
    e.hp = hp;
    e.dist = Math.abs(e.dist - dist) > 0.6 ? dist : e.dist + (dist - e.dist) * 0.5;
    e.haste = haste;
    e.shield = !!(f & 1);
    e.slow = ITEMS.frost.slow;
    e.slowUntil = f & 2 ? time + 0.25 : 0;
    e.poisonDps = f & 4 ? 1 : 0;
    if (e.bane) e.bane.openUntil = f & 8 ? time + 0.25 : 0;
  }
}

// ---------- firing

const alive = () => enemies.filter(e => !e.dead);
const leader = list => list.reduce((a, b) => (b.dist > a.dist ? b : a));

function aim(it, from, target) {
  const p = target.group.position;
  it.obj.userData.head.rotation.y = Math.atan2(p.x - from.x, p.z - from.z);
}

// Amplifiers boost the same player's towers on nearby keys.
function ampBonus(pid, code) {
  let bonus = 1;
  for (const [c, it] of G.players[pid].items) {
    if (it.type !== 'amp' || c === code) continue;
    if (travel(c, code).dist <= AMP_RANGE) bonus += ITEMS.amp.boost + 0.15 * (it.level - 1);
  }
  return bonus;
}
const ampNeighbours = code => LETTER_CODES.filter(c => c !== code && travel(code, c).dist <= AMP_RANGE);

// A correctly typed letter fires that player's tower on the key.
// ctx: { word, first, streak }. auth: apply damage/effects (host/solo) or just show the shot (guests).
function fire(pid, code, ctx, auth) {
  const it = G.players[pid]?.items.get(code);
  if (!it || !boards[pid]) return;
  const def = ITEMS[it.type];
  const from = keyTop(pid, code);
  from.y += 0.4;
  it.shots++;

  if (it.type === 'mine') {
    if (pid === NET.me) {
      const g = def.gold * it.level * keyPowerMult(letterOf(code));
      G.gold += g;
      G.totals.mined += g;
    }
    coinFx(from);
    return;
  }
  if (it.type === 'amp') {
    ringFx(keyTop(pid, code), def.color, 1.2);
    it.pulse = performance.now();
    return;
  }
  const all = alive();
  if (!all.length) return;
  const list = all.filter(e => vulnerable(e, pid, ctx.word));
  if (!list.length) {
    // nothing can be hurt right now: the shot bounces off the lead enemy
    const t = leader(all);
    boltFx(from, t, 0x888888, 0.05);
    ringFx(t.group.position.clone(), 0xaaaaaa, 0.5);
    return;
  }
  let dmg = def.dmg * POWER[it.level] * keyPowerMult(letterOf(code)) * ampBonus(pid, code);
  if (it.type === 'herald' && ctx.first) dmg *= def.startMult;
  if (it.type === 'focus') dmg *= 1 + def.perStreak * Math.min(ctx.streak, def.maxStreak);
  const hit = (e, d) => { if (auth) damage(e, d, it); };

  switch (it.type) {
    case 'blaster': {
      const t = leader(list);
      aim(it, from, t);
      boltFx(from, t, def.color, 0.07);
      hit(t, dmg);
      break;
    }
    case 'frost': {
      const t = leader(list);
      aim(it, from, t);
      boltFx(from, t, def.color, 0.08);
      ringFx(t.group.position.clone(), def.color, 0.6);
      if (auth) {
        t.slow = def.slow;
        t.slowUntil = time + def.slowTime * (1 + 0.5 * (it.level - 1));
      }
      hit(t, dmg);
      break;
    }
    case 'cannon': {
      const t = leader(list), p = t.group.position.clone();
      aim(it, from, t);
      boltFx(from, t, def.color, 0.12);
      ringFx(p, def.color, def.splash);
      for (const e of list) {
        if (e === t) hit(e, dmg);
        else if (Math.hypot(e.group.position.x - p.x, e.group.position.z - p.z) <= def.splash) hit(e, dmg * 0.6);
      }
      break;
    }
    case 'tesla': {
      const targets = [leader(list)];
      while (targets.length < def.chain + it.level - 1) {
        const lastPos = targets.at(-1).group.position;
        const next = list.filter(e => !targets.includes(e))
          .sort((a, b) => a.group.position.distanceTo(lastPos) - b.group.position.distanceTo(lastPos))[0];
        if (!next) break;
        targets.push(next);
      }
      aim(it, from, targets[0]);
      zapFx([from, ...targets.map(e => e.group.position.clone())], def.color);
      targets.forEach(e => hit(e, dmg));
      break;
    }
    case 'rail': {
      const t = list.reduce((a, b) => (b.hp > a.hp ? b : a));
      aim(it, from, t);
      beamFx(from, t.group.position.clone(), def.color);
      hit(t, dmg);
      break;
    }
    case 'poison': {
      const t = leader(list);
      aim(it, from, t);
      boltFx(from, t, def.color, 0.07);
      if (auth) {
        t.poisonDps = Math.min(def.dot * 6, t.poisonDps + def.dot * POWER[it.level] * keyPowerMult(letterOf(code)));
        t.poisonUntil = time + def.dotTime;
        t.poisonSrc = it;
      }
      hit(t, dmg);
      break;
    }
    case 'mortar': {
      // aim at the enemy with the most others around it
      const crowd = e => list.filter(o => o.group.position.distanceTo(e.group.position) <= def.splash).length;
      const t = list.reduce((a, b) => (crowd(b) > crowd(a) ? b : a)), p = t.group.position.clone();
      aim(it, from, t);
      shellFx(from, p, def.color);
      setTimeout(() => {
        if (G.phase !== 'wave') return;
        ringFx(p, def.color, def.splash);
        for (const e of alive()) if (e.group.position.distanceTo(p) <= def.splash && vulnerable(e, pid, ctx.word)) hit(e, dmg);
      }, 350);
      break;
    }
    case 'gust': {
      const t = leader(list);
      aim(it, from, t);
      ringFx(t.group.position.clone(), def.color, 0.9);
      if (auth) {
        const push = def.push * (1 + 0.25 * (it.level - 1)) * (t.type === 'boss' ? 0.2 : t.type === 'tank' ? 0.5 : 1);
        t.dist = Math.max(0, t.dist - push);
      }
      hit(t, dmg);
      break;
    }
    case 'herald':
    case 'focus': {
      const t = leader(list);
      aim(it, from, t);
      if (it.type === 'focus') beamFx(from, t.group.position.clone(), def.color);
      else boltFx(from, t, def.color, ctx.first ? 0.14 : 0.07);
      hit(t, dmg);
      break;
    }
  }
}

// ---------- effects

function addFx(obj, life, update) {
  scene.add(obj);
  fx.push({ obj, t: 0, life, update });
}

function updateFx(dt) {
  for (let i = fx.length - 1; i >= 0; i--) {
    const f = fx[i];
    f.t += dt;
    const k = f.t / f.life;
    if (k >= 1) {
      scene.remove(f.obj);
      f.obj.material?.dispose();
      if (f.obj.userData.ownGeo) f.obj.geometry.dispose();
      fx.splice(i, 1);
    } else f.update(k, f.obj);
  }
}

const fxMat = color => new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false });

function boltFx(from, target, color, size) {
  const m = new THREE.Mesh(GEO.sphere, fxMat(color));
  m.scale.setScalar(size);
  let end = target.group.position.clone();
  addFx(m, 0.16, k => {
    if (!target.dead) end = target.group.position.clone();
    m.position.lerpVectors(from, end, k);
  });
}

function ringFx(pos, color, radius) {
  const m = new THREE.Mesh(GEO.ring, fxMat(color));
  m.rotation.x = Math.PI / 2;
  m.position.copy(pos);
  addFx(m, 0.35, k => {
    m.scale.setScalar(0.2 + k * radius);
    m.material.opacity = 1 - k;
  });
}

function popFx(pos, color, size) {
  const m = new THREE.Mesh(GEO.sphere, fxMat(color));
  m.position.copy(pos);
  addFx(m, 0.3, k => {
    m.scale.setScalar(size * (1 + 1.4 * k));
    m.material.opacity = 0.8 * (1 - k);
  });
}

function beamFx(from, to, color) {
  const m = new THREE.Mesh(GEO.cyl, fxMat(color));
  const dir = to.clone().sub(from);
  m.position.copy(from).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  addFx(m, 0.25, k => {
    const w = 0.06 * (1 - k);
    m.scale.set(w, dir.length(), w);
    m.material.opacity = 1 - k;
  });
}

function zapFx(points, color) {
  const pts = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    for (let s = 0; s < 6; s++) {
      const p = a.clone().lerp(b, s / 6);
      if (s) p.add(new THREE.Vector3((Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.3));
      pts.push(p);
    }
  }
  pts.push(points.at(-1));
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color, transparent: true }));
  line.userData.ownGeo = true;
  addFx(line, 0.22, k => { line.material.opacity = 1 - k; });
}

function shellFx(from, to, color) {
  const m = new THREE.Mesh(GEO.sphere, fxMat(color));
  m.scale.setScalar(0.11);
  addFx(m, 0.35, k => {
    m.position.lerpVectors(from, to, k);
    m.position.y += Math.sin(k * Math.PI) * 2.2;
  });
}

function coinFx(pos) {
  const m = new THREE.Mesh(GEO.coin, fxMat(0xffc94a));
  m.rotation.x = Math.PI / 2;
  addFx(m, 0.6, k => {
    m.position.set(pos.x, pos.y + k * 0.9, pos.z);
    m.rotation.z = k * 8;
    m.material.opacity = 1 - k * k;
  });
}

// ---------- typing

// Weight the word list so the letters you type match Webster's frequencies. Tower damage and
// upgrade prices are set from those frequencies, so this keeps every key's value close to even.
const WORD_WEIGHTS = (() => {
  const target = Object.fromEntries(LETTER_FREQUENCY.map(f => [f.letter, f.pctLetters / 100]));
  let w = WORDS.map(() => 1);
  for (let it = 0; it < 200; it++) {
    const count = {};
    let total = 0;
    WORDS.forEach((word, i) => { for (const c of word) { count[c] = (count[c] || 0) + w[i]; total += w[i]; } });
    w = WORDS.map((word, i) => {
      let s = 0;
      for (const c of word) s += Math.log(target[c] / (count[c] / total));
      return w[i] * Math.exp((0.5 * s) / word.length);
    });
    const max = Math.max(...w);
    w = w.map(x => x / max);
  }
  return w;
})();
const WEIGHT_TOTAL = WORD_WEIGHTS.reduce((a, b) => a + b, 0);

// During a bane boss, most of your words contain your own slow keys.
let banePool = null, baneWeights = null, baneTotal = 0;
const myBaneLetters = () => G.bane?.letters[NET.me] ?? null;
function setBaneWords(letters) {
  if (!letters?.length) { banePool = null; return; }
  const idx = WORDS.map((w, i) => i).filter(i => letters.some(l => WORDS[i].includes(l)));
  banePool = idx.map(i => WORDS[i]);
  baneWeights = idx.map(i => Math.max(WORD_WEIGHTS[i], 0.02));
  baneTotal = baneWeights.reduce((a, b) => a + b, 0);
}

function pickWord() {
  if (banePool?.length && Math.random() < BANE_WORD_SHARE) {
    let r = Math.random() * baneTotal;
    for (let i = 0; i < banePool.length; i++) if ((r -= baneWeights[i]) <= 0) return banePool[i];
  }
  let r = Math.random() * WEIGHT_TOTAL;
  for (let i = 0; i < WORDS.length; i++) if ((r -= WORD_WEIGHTS[i]) <= 0) return WORDS[i];
  return WORDS.at(-1);
}

let text = '', pos = 0, spans = [], wordEls = [], charWord = [], wordErr = [], errAt = [], words = [];
let prevCode = null, lastT = 0;

function newText() {
  words = [];
  let len = 0;
  while (len < 80) {
    const w = pickWord();
    if (words.at(-1) === w) continue;
    words.push(w);
    len += w.length + 1;
  }
  text = words.join(' ') + ' ';
  pos = 0;
  spans = [];
  charWord = [];
  errAt = new Array(text.length).fill(false);
  wordErr = words.map(() => false);
  const el = $('#text');
  el.textContent = '';
  const bane = myBaneLetters() ?? [];
  wordEls = words.map((w, wi) => {
    const wordEl = document.createElement('span');
    wordEl.className = 'word';
    for (const c of w + ' ') {
      const s = document.createElement('span');
      s.className = 'ch' + (c === ' ' ? ' sp' : '') + (bane.includes(c) ? ' bane' : '');
      s.textContent = c === ' ' ? '·' : c;
      wordEl.appendChild(s);
      spans.push(s);
      charWord.push(c === ' ' ? -1 : wi);
    }
    el.appendChild(wordEl);
    return wordEl;
  });
  spans[0].classList.add('cur');
  curWord = words[0];
}

function typeChar(ch, physCode, t) {
  const expected = text[pos], to = charToCode(expected), wi = charWord[pos];
  const fingerFrom = fingers.from(to, t);

  if (ch !== expected) {
    if (!errAt[pos]) {
      errAt[pos] = true;
      wave.misses++;
      G.totals.misses++;
      stats.miss(prevCode, to, physCode, fingerFrom);
      if (wi >= 0) wordErr[wi] = true;
      G.streak = 0;
      if (isAuth()) onTypo(NET.me, expected);
      else toHost({ t: 'typo', ch: expected });
    }
    spans[pos].classList.add('err');
    kb.flashError(physCode);
    return;
  }

  const ms = prevCode ? t - lastT : null;
  if (wave.start == null) wave.start = t;
  if (!errAt[pos]) {
    stats.hit(prevCode, to, ms, fingerFrom);
    wave.hits++;
    G.totals.hits++;
    if (ms != null && ms < PAUSE_MS && !isWordStart(prevCode)) {
      const k = (wave.keys[to] ??= { sum: 0, n: 0 });
      k.sum += ms;
      k.n++;
      if (isLetterCode(to)) {
        const r = (G.keyTimes[to] ??= { sum: 0, n: 0 });
        r.sum += ms;
        r.n++;
      }
    }
  }
  if (ms != null && ms < PAUSE_MS) stats.addPractice(ms);
  fingers.press(to, t);
  prevCode = to;
  lastT = t;
  wave.chars++;
  wave.last = t;
  typeTimes.push(performance.now());

  spans[pos].classList.remove('cur');
  spans[pos].classList.add('done');
  const ctx = { word: curWord, first: wi >= 0 && (pos === 0 || charWord[pos - 1] !== wi), streak: G.streak };
  pos++;
  fire(NET.me, to, ctx, isAuth());
  if (NET.role === 'guest') toHost({ t: 'key', code: to, ctx });
  else if (NET.role === 'host') toGuests({ t: 'key', pid: NET.me, code: to, ctx });
  if (wi >= 0 && charWord[pos] !== wi) completeWord(wi);
  if (pos >= text.length) newText();
  else {
    spans[pos].classList.add('cur');
    curWord = words[charWord[pos]] ?? '';
  }
  renderHud();
}

function completeWord(wi) {
  G.totals.words++;
  wave.words++;
  if (wordErr[wi]) {
    wordEls[wi].classList.add('dirty');
    G.streak = 0;
    return;
  }
  G.streak++;
  if (isAuth()) onCleanWord(NET.me, words[wi]);
  else toHost({ t: 'clean', word: words[wi] });
  const g = words[wi].length;
  G.gold += g;
  G.totals.clean++;
  wave.clean++;
  wave.gold += g;
  wordEls[wi].classList.add('clean');
  floatGold(`+${g}`);
}

function floatGold(label) {
  const anchor = document.querySelector('.hud .gold')?.getBoundingClientRect();
  if (!anchor) return;
  const el = document.createElement('div');
  el.className = 'goldfloat';
  el.textContent = label;
  el.style.left = anchor.right + 4 + 'px';
  el.style.top = anchor.top + 'px';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 900);
}

const waitingFor = () => G.players.filter(p => p.online && !p.ready).map(p => p.name);

function setTextState() {
  const wrap = $('#textWrap'), ov = $('#textOverlay');
  document.body.classList.toggle('drafting', G.phase === 'draft');
  wrap.classList.toggle('active', G.phase === 'wave' && !paused);
  ov.textContent = G.phase === 'lobby' ? 'Choose how to play'
    : G.phase === 'shop' ? `Spend gold on upgrades, then press Enter when you're ready for wave ${G.wave}`
    : G.phase === 'ready' ? `Ready! Waiting for ${waitingFor().join(', ') || 'the host'}…`
    : paused ? 'Paused. Press Esc to continue' : '';
  ov.style.display = ov.textContent ? '' : 'none';
}

// ---------- draft: 3 towers on top, 3 keys below; select a tower, then a key to place it

const art = new CardArt();
const freeLetters = () => LETTER_CODES.filter(c => !myItems().has(c));

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function drawType(exclude) {
  const types = ITEM_ORDER.filter(t => !exclude.includes(t));
  let r = Math.random() * types.reduce((a, t) => a + ITEMS[t].weight, 0);
  for (const t of types) if ((r -= ITEMS[t].weight) <= 0) return t;
  return types.at(-1);
}

function deal() {
  const used = G.wave === 1 ? [...NON_OPENING] : [];
  const towers = [];
  for (let i = 0; i < 3; i++) {
    const t = drawType(used);
    used.push(t);
    towers.push(t);
  }
  const common = COMMON_CODES.filter(c => !myItems().has(c));
  const pool = G.wave === 1 && common.length >= 3 ? common : freeLetters();
  const D = G.draft;
  D.towers = towers;
  D.keys = shuffle([...pool]).slice(0, 3);
  D.tower = null;
  hoverCard = -1;
}

function openDraft(picks) {
  if (!freeLetters().length) return openShop(); // every letter already has a tower
  G.phase = 'draft';
  G.draft = { picksLeft: picks, picksTotal: picks, towers: [], keys: [], tower: null, rerolls: 0 };
  deal();
  setTextState();
  refreshDraft();
}

function refreshDraft() {
  renderDraft();
  renderShop();
  renderHud();
}

function nextDraftOrShop() {
  G.draft.picksLeft--;
  if (G.draft.picksLeft > 0 && freeLetters().length) {
    G.draft.rerolls = 0;
    deal();
    refreshDraft();
  } else openShop();
}

function selectTower(i) {
  if (G.phase !== 'draft' || !G.draft.towers[i]) return;
  G.draft.tower = G.draft.tower === i ? null : i;
  refreshDraft();
}

function selectKey(i) {
  if (G.phase !== 'draft') return;
  const D = G.draft, code = D.keys[i];
  if (!code) return;
  if (D.tower == null) {
    toast('Choose a tower first (top row), then a key for it.');
    const row = $('#draft .dcards');
    row?.classList.remove('shake');
    void row?.offsetWidth;
    row?.classList.add('shake');
    return;
  }
  const type = D.towers[D.tower];
  changeItem(code, type, 1);
  selectedKey = code;
  kb.setSelected(code);
  toast(`${ITEMS[type].name} placed on ${keyLabel(code)}.`);
  nextDraftOrShop();
}

function rerollDraft() {
  if (G.phase !== 'draft') return;
  const cost = rerollCost(G.draft.rerolls);
  if (G.gold < cost) return toast(`Rerolling costs ${cost}g. You have ${goldNow()}g.`);
  G.gold -= cost;
  G.draft.rerolls++;
  deal();
  refreshDraft();
}

function skipDraft() {
  if (G.phase !== 'draft' || !myItems().size) return;
  G.gold += SKIP_GOLD;
  floatGold(`+${SKIP_GOLD}`);
  nextDraftOrShop();
}

function openShop() {
  G.phase = 'shop';
  G.draft = null;
  hoverCard = -1;
  renderDraft();
  setTextState();
  renderShop();
  renderHud();
}

function baseText(t) {
  const d = ITEMS[t];
  return d.support ? `+${Math.round(d.boost * 100)}% to neighbouring towers` : d.dmg ? `${d.dmg} base damage` : `+${d.gold} base gold/press`;
}
const rarityOf = t => (ITEMS[t].weight <= 8 ? 'rare' : ITEMS[t].weight <= 16 ? 'uncommon' : 'common');

function towerCardHTML(t, i) {
  const d = ITEMS[t], sel = G.draft.tower === i;
  return `<button class="dcard ${sel ? 'picked' : ''}" data-tower="${i}" style="--c:${hex(d.color)}">
    <span class="dnum">${i + 1}</span>
    <canvas class="dprev" data-prev="${i}" aria-label="${d.name}"></canvas>
    <span class="dname">${d.name} <span class="drar ${rarityOf(t)}">${rarityOf(t)}</span></span>
    <span class="deff">${baseText(t)}</span>
    <span class="ddesc">${d.desc}</span>
  </button>`;
}

function keyCardHTML(code, i) {
  const D = G.draft, type = D.towers[D.tower], ch = letterOf(code), f = FREQ_BY_LETTER[ch], pm = keyPowerMult(ch);
  const d = type && ITEMS[type];
  const effect = !d ? `damage ×${pm.toFixed(2)} per shot`
    : type === 'mine' ? `+${(d.gold * pm).toFixed(1)} gold per press`
    : d.support ? `boosts ${ampNeighbours(code).map(c => keyLabel(c)).join(' ')}`
    : `${Math.round(d.dmg * pm)} damage per shot`;
  const feel = f.rank <= 8 ? 'fires often, small hits' : f.rank >= 19 ? 'fires rarely, big hits' : 'fires sometimes, medium hits';
  return `<button class="kcard ${d ? 'ready' : ''}" data-key="${i}" style="--c:${d ? hex(d.color) : '#8a8c92'}">
    <canvas class="kprev" data-prev="${3 + i}" aria-label="${keyLabel(code)} key"></canvas>
    <span class="ktext">
      <span class="kname">${keyLabel(code)} <kbd>${keyLabel(code)}</kbd></span>
      <span class="deff">${effect}</span>
      <span class="dfreq">${f.pctLetters}% of letters · rank ${f.rank}/26 · ${feel}</span>
    </span>
  </button>`;
}

function renderDraft() {
  const el = $('#draft');
  el.hidden = G.phase !== 'draft';
  paintKeys();
  if (el.hidden) return;
  const D = G.draft, opening = G.wave === 1;
  const head = opening ? `Opening draft · pick ${D.picksTotal - D.picksLeft + 1} of ${D.picksTotal}` : `Wave ${G.wave - 1} cleared · new tower`;
  const step = D.tower == null ? 'Choose a tower' : `Now choose a key for your ${ITEMS[D.towers[D.tower]].name}`;
  el.innerHTML = `<div class="dtitle">${head} <span class="dstep">${step}</span></div>
    <div class="dcards">${D.towers.map(towerCardHTML).join('')}</div>
    <div class="krow">${D.keys.map(keyCardHTML).join('')}</div>
    <div class="dfoot">
      <button id="rerollBtn" ${G.gold >= rerollCost(D.rerolls) ? '' : 'disabled'}>Reroll all (${rerollCost(D.rerolls)}g) <kbd>Tab</kbd></button>
      <button id="skipBtn" ${myItems().size ? '' : 'disabled'} title="${myItems().size ? '' : 'Pick at least one tower first'}">Skip (+${SKIP_GOLD}g) <kbd>Esc</kbd></button>
    </div>`;
  // 3D art: slots 0–2 are the towers, 3–5 the keys (showing the selected tower on each key)
  art.setCards([
    ...D.towers.map(type => ({ type, code: null })),
    ...D.keys.map(code => ({ type: D.towers[D.tower] ?? null, code })),
  ]);
  art.attach(el);
}

$('#draft').addEventListener('click', e => {
  const t = e.target.closest('[data-tower]'), k = e.target.closest('[data-key]');
  if (t) selectTower(Number(t.dataset.tower));
  else if (k) selectKey(Number(k.dataset.key));
  else if (e.target.closest('#rerollBtn')) rerollDraft();
  else if (e.target.closest('#skipBtn')) skipDraft();
});
$('#draft').addEventListener('mouseover', e => {
  const t = e.target.closest('[data-tower]'), k = e.target.closest('[data-key]');
  const i = t ? Number(t.dataset.tower) : k ? 3 + Number(k.dataset.key) : -1;
  if (i === hoverCard) return;
  hoverCard = i;
  kb.setSelected(k ? G.draft.keys[Number(k.dataset.key)] : selectedKey);
});

// ---------- your slow keys (measured this run) and boss banes

const MIN_KEY_SAMPLES = 4;
function slowestKeys(n = 3) {
  return Object.entries(G.keyTimes).filter(([, r]) => r.n >= MIN_KEY_SAMPLES)
    .map(([code, r]) => ({ code, ms: r.sum / r.n })).sort((a, b) => b.ms - a.ms).slice(0, n);
}

const isBossWave = n => n % BOSS_EVERY === 0;

// Host: one bane per boss, with each player's own three slowest keys.
function chooseBane() {
  const letters = {};
  G.players.forEach((p, pid) => {
    const slow = pid === NET.me ? slowestKeys(3).map(k => letterOf(k.code)) : p.slow ?? [];
    // not enough data yet (e.g. very short run): fill with mid-frequency letters
    const fill = shuffle(COMMON_CODES.slice(6).map(letterOf)).filter(l => !slow.includes(l));
    letters[pid] = [...slow, ...fill].slice(0, 3);
  });
  const kinds = Object.keys(BANES).filter(k => k !== G.lastBane);
  const kind = kinds[Math.floor(Math.random() * kinds.length)];
  G.lastBane = kind;
  return { kind, letters };
}

const baneText = b => {
  const mine = (b.letters[NET.me] ?? []).map(l => l.toUpperCase()).join(', ');
  return `${BANES[b.kind].name}: ${BANES[b.kind].desc(mine)}`;
};

// ---------- phases

// Pressing Enter in the shop: you're ready. Waves start when every player is ready.
function markReady() {
  if (G.phase !== 'shop') return;
  G.phase = 'ready';
  const slow = slowestKeys(3).map(k => letterOf(k.code));
  G.players[NET.me].ready = true;
  if (NET.role === 'guest') toHost({ t: 'ready', slow });
  else {
    Object.assign(G.players[NET.me], { ready: true, slow });
    hostCheckReady();
  }
  setTextState();
  renderShop();
}

function hostCheckReady() {
  toGuests({ t: 'readyState', ready: G.players.map(p => p.ready) });
  if (G.phase !== 'wave' && G.phase !== 'over' && G.players.every(p => p.ready || !p.online)) hostStartWave();
  else {
    setTextState();
    renderShop();
  }
}

function hostStartWave() {
  const bane = isBossWave(G.wave) ? chooseBane() : null;
  G.players.forEach(p => { p.ready = false; });
  toGuests({ t: 'wave', wave: G.wave, bane });
  const spec = waveSpec(G.wave, G.players.length);
  spawnQueue = spec.list.slice();
  spawnInterval = spec.interval;
  spawnTimer = 0.6;
  snapTimer = 0;
  beginWave(bane);
}

// Every client: the wave is on.
function beginWave(bane) {
  G.bane = bane;
  G.phase = 'wave';
  paused = false;
  prevCode = null;
  wave = { start: null, last: null, chars: 0, hits: 0, misses: 0, words: 0, clean: 0, gold: 0, keys: {} };
  setBaneWords(myBaneLetters());
  const news = [];
  if (bane) news.push(`BOSS wave! ${baneText(bane)}`);
  for (const m of new Set(waveSpec(G.wave, G.players.length).list.map(e => e.mod).filter(Boolean))) {
    if (G.seenMods[m]) continue;
    G.seenMods[m] = true;
    news.push(`New enemy: ${MODS[m].name}. ${MODS[m].desc}`);
  }
  if (news.length) toast(news.join('  ·  '));
  newText();
  setTextState();
  renderShop();
  renderHud();
  document.activeElement?.blur?.();
}

function hostEndWave() {
  toGuests({ t: 'waveEnd' });
  onWaveEnd();
}

function onWaveEnd() {
  G.bane = null;
  setBaneWords(null);
  const bonus = waveBonus(G.wave);
  G.gold += bonus;
  stats.pushHistory(wave.keys);
  toast(`Wave ${G.wave} cleared! +${bonus} bonus gold · ${wave.clean}/${wave.words} clean words · ${wave.gold} gold from typing`);
  best = Math.max(best, G.wave);
  try { localStorage.setItem(BEST_KEY, best); } catch { /* storage unavailable */ }
  G.wave++;
  openDraft(1);
}

function hostGameOver() {
  toGuests({ t: 'over' });
  showGameOver();
}

function showGameOver() {
  if (G.phase === 'over') return;
  G.phase = 'over';
  if (wave) stats.pushHistory(wave.keys);
  const cleared = G.wave - 1;
  const t = G.totals, acc = t.hits / Math.max(1, t.hits + t.misses);
  const msg = $('#centerMsg');
  msg.innerHTML = `<div class="box"><h2>The line broke on wave ${G.wave}</h2>
    <p>Waves cleared: <b>${cleared}</b>${cleared > 0 && cleared >= best ? ' (new best!)' : ` · best ${best}`}</p>
    <p>Your words: ${t.clean}/${t.words} clean · accuracy ${(acc * 100).toFixed(1)}% · ${myItems().size} towers</p>
    ${NET.role === 'guest' ? '<p>Waiting for the host to start another game…</p><button id="leaveBtn">Leave room</button>'
      : `<button id="againBtn">Play again (Enter)</button>${isMulti() ? ' <button id="leaveBtn" class="ghostbtn">Close room</button>' : ''}`}</div>`;
  msg.hidden = false;
  $('#againBtn')?.addEventListener('click', playAgain);
  $('#leaveBtn')?.addEventListener('click', leaveRoom);
  setTextState();
  renderShop();
  renderHud();
}

function playAgain() {
  if (NET.role === 'guest') return;
  const players = G.players.filter(p => p.online).map(({ name, id }) => ({ name, id }));
  if (NET.role === 'host') toGuests({ t: 'start', players });
  startGame(players);
}

// Remove everything from the previous run (towers, enemies) before laying out a new one.
function clearRun() {
  G.players.forEach((p, pid) => { for (const code of [...p.items.keys()]) setItem(pid, code, null, 0); });
  enemies.forEach(removeEnemy);
  enemies = [];
  spawnQueue = [];
  setBaneWords(null);
}

function startGame(players) {
  clearRun();
  NET.me = Math.max(0, players.findIndex(p => p.id === myPeerId()));
  G = newGame(players);
  nextEnemyId = 1;
  NET.started = true;
  setLanePlayers(players.length);
  buildLane();
  makeBoards(players.length);
  userMoved = false;
  viewAll = false;
  fitView();
  renderViewBtn();
  selectedKey = null;
  kb.setSelected(null);
  $('#centerMsg').hidden = true;
  $('#lobby').hidden = true;
  $('#statsPanel').dataset.built = '';
  resetStats();
  newText();
  openDraft(OPENING_PICKS);
}

// ---------- game-long stats: DPS, gold and WPM for every player, one sample per second

const STAT_KEYS = ['dps', 'gold', 'wpm'];
let timeline = [];   // [{ wave: bool, p: [[dps, gold, wpm], ...] }]
let dmgAcc = [];     // damage dealt this second, per player (host/solo)
let dmgWindow = [];  // per player: damage in each of the last 5 seconds
let typeTimes = [];  // timestamps of my correct keystrokes in the last 10 seconds
let reported = [];   // host: latest { gold, wpm } reported by each guest
let statTimer = 0;

function resetStats() {
  timeline = [];
  dmgAcc = [];
  dmgWindow = G.players.map(() => []);
  typeTimes = [];
  reported = [];
  statTimer = 0;
  renderStats();
}

function myWpm() {
  const now = performance.now();
  while (typeTimes.length && now - typeTimes[0] > 10000) typeTimes.shift();
  return Math.round(typeTimes.length * 1.2); // chars in 10 s -> words per minute (5 chars per word)
}

// Runs from the simulation timer, so it keeps sampling between rounds and in background tabs.
function statsTick(dt) {
  if (G.phase === 'lobby') return;
  statTimer += dt;
  if (statTimer < 1) return;
  statTimer -= 1;
  if (NET.role === 'guest') {
    toHost({ t: 'stat', gold: goldNow(), wpm: myWpm() });
    return; // the host sends everyone's sample back
  }
  const sample = G.players.map((p, pid) => {
    const w = (dmgWindow[pid] ??= []);
    w.push(dmgAcc[pid] || 0);
    if (w.length > 5) w.shift();
    const dps = Math.round(w.reduce((a, b) => a + b, 0) / w.length);
    if (pid === NET.me) return [dps, goldNow(), myWpm()];
    const r = reported[pid] ?? { gold: 0, wpm: 0 };
    return [dps, p.online ? r.gold : 0, p.online ? r.wpm : 0];
  });
  dmgAcc = [];
  pushSample({ wave: G.phase === 'wave', p: sample });
  toGuests({ t: 'stats', wave: G.phase === 'wave', p: sample });
}

function pushSample(sample) {
  timeline.push(sample);
  renderStats();
}

function drawChart(cv, k) {
  const W = cv.clientWidth, H = cv.clientHeight, dpr = devicePixelRatio || 1;
  if (!W || !H) return;
  cv.width = W * dpr;
  cv.height = H * dpr;
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  const n = timeline.length;
  if (n < 2) return;
  const max = Math.max(10, ...timeline.flatMap(s => s.p.map(v => v[k]))) * 1.1;
  const X = i => (i / (n - 1)) * W, Y = v => H - 2 - (v / max) * (H - 4);
  // shade the wave periods
  g.fillStyle = 'rgba(255,107,91,0.10)';
  let start = null;
  timeline.forEach((s, i) => {
    if (s.wave && start == null) start = i;
    if ((!s.wave || i === n - 1) && start != null) {
      g.fillRect(X(start), 0, X(i) - X(start), H);
      start = null;
    }
  });
  G.players.forEach((p, pid) => {
    g.strokeStyle = PLAYER_COLORS[pid];
    g.lineWidth = pid === NET.me ? 2 : 1.4;
    g.globalAlpha = pid === NET.me ? 1 : 0.8;
    g.beginPath();
    timeline.forEach((s, i) => {
      const v = s.p[pid]?.[k] ?? 0;
      if (i) g.lineTo(X(i), Y(v));
      else g.moveTo(X(i), Y(v));
    });
    g.stroke();
  });
  g.globalAlpha = 1;
}

function renderStats() {
  const el = $('#statsPanel');
  el.hidden = G.phase === 'lobby';
  if (el.hidden) return;
  const last = timeline.at(-1)?.p ?? [];
  const mins = Math.floor(timeline.length / 60), secs = String(timeline.length % 60).padStart(2, '0');
  const multi = G.players.length > 1;
  if (!el.dataset.built) {
    el.innerHTML = `<div class="sp-head"><span>Game stats</span><span class="sp-time"></span><button class="sp-toggle" title="Show or hide the charts">–</button></div>
      <div class="sp-body">${STAT_KEYS.map((k, i) => `<div class="sp-row"><div class="sp-label">${['DPS', 'Gold', 'WPM'][i]}<span class="sp-vals" data-k="${i}"></span></div><canvas class="sp-chart" data-k="${i}"></canvas></div>`).join('')}
      <div class="sp-legend"></div></div>`;
    el.dataset.built = '1';
  }
  el.querySelector('.sp-time').textContent = `${mins}:${secs}`;
  STAT_KEYS.forEach((_, i) => {
    el.querySelector(`.sp-vals[data-k="${i}"]`).innerHTML = G.players.map((p, pid) =>
      `<b style="color:${PLAYER_COLORS[pid]}">${last[pid]?.[i] ?? 0}</b>`).join(multi ? ' · ' : '');
    if (!el.classList.contains('collapsed')) drawChart(el.querySelector(`.sp-chart[data-k="${i}"]`), i);
  });
  el.querySelector('.sp-legend').innerHTML = multi
    ? G.players.map((p, pid) => `<span><i style="background:${PLAYER_COLORS[pid]}"></i>${esc(p.name)}${pid === NET.me ? ' (you)' : ''}</span>`).join('') + '<span><i class="wavebox"></i>wave</span>'
    : '<span><i class="wavebox"></i>shaded = wave in progress</span>';
}
$('#statsPanel').addEventListener('click', e => {
  if (!e.target.closest('.sp-toggle')) return;
  const el = $('#statsPanel');
  el.classList.toggle('collapsed');
  e.target.textContent = el.classList.contains('collapsed') ? '+' : '–';
  renderStats();
});

// ---------- lobby and networking

const myPeerId = () => (NET.role === 'guest' ? NET.room?.peer?.id : 'host');
let myName = 'Player';
try { myName = localStorage.getItem(NAME_KEY) || myName; } catch { /* storage unavailable */ }

function readName() {
  const v = ($('#nameInput')?.value || '').trim().slice(0, 16);
  if (v) myName = v;
  try { localStorage.setItem(NAME_KEY, myName); } catch { /* storage unavailable */ }
}

function lobbyPlayersHTML(list) {
  return `<ul class="plist">${list.map((p, i) => `<li><span class="pdot" style="background:${PLAYER_COLORS[i]}"></span>${esc(p.name)}${p.id === myPeerId() ? ' <span class="muted">(you)</span>' : ''}${i === 0 ? ' <span class="muted">· host</span>' : ''}</li>`).join('')}
    ${Array.from({ length: MAX_PLAYERS - list.length }, () => '<li class="empty">open slot</li>').join('')}</ul>`;
}

function renderLobby(screen = 'menu', info = '') {
  const el = $('#lobby');
  el.hidden = false;
  const roomCode = new URLSearchParams(location.search).get('room') || '';
  let html;
  if (screen === 'menu') {
    html = `<h2>Key<span class="g">Defense</span></h2>
      <label class="lrow">Your name <input id="nameInput" maxlength="16" value="${esc(myName)}"></label>
      <button class="lbtn primary" id="soloBtn">Play solo</button>
      <div class="or">or play together, up to ${MAX_PLAYERS} players</div>
      <button class="lbtn" id="hostBtn">Host a game</button>
      <div class="joinrow"><input id="codeInput" maxlength="4" placeholder="CODE" value="${esc(roomCode.toUpperCase())}"><button class="lbtn" id="joinBtn">Join</button></div>
      <p class="lmsg">${info}</p>`;
  } else if (screen === 'hosting') {
    const link = `${location.origin}${location.pathname}?room=${NET.room.code}`;
    html = `<h2>Room <span class="code">${NET.room.code}</span></h2>
      <p class="muted">Send friends this link, or have them enter the code:</p>
      <div class="joinrow"><input id="linkInput" readonly value="${esc(link)}"><button class="lbtn" id="copyBtn">Copy</button></div>
      ${lobbyPlayersHTML(NET.lobby)}
      <button class="lbtn primary" id="startBtnLobby">Start game (${NET.lobby.length} player${NET.lobby.length > 1 ? 's' : ''})</button>
      <button class="lbtn ghostbtn" id="cancelBtn">Cancel</button>
      <p class="lmsg">${info}</p>`;
  } else if (screen === 'joined') {
    html = `<h2>Room <span class="code">${NET.room.code}</span></h2>
      <p class="muted">You're in! Waiting for the host to start…</p>
      ${lobbyPlayersHTML(NET.lobby)}
      <button class="lbtn ghostbtn" id="cancelBtn">Leave</button>
      <p class="lmsg">${info}</p>`;
  } else {
    html = `<h2>${info}</h2><p class="lmsg"></p>`;
  }
  el.innerHTML = `<div class="box lobbybox">${html}</div>`;
  if (screen === 'menu' && roomCode) $('#codeInput').focus();
}

function lobbyMsg(text) {
  const m = $('#lobby .lmsg');
  if (m) m.textContent = text;
}

$('#lobby').addEventListener('click', async e => {
  const id = e.target.closest('button')?.id;
  if (!id) return;
  if (id === 'soloBtn') {
    readName();
    NET.role = 'solo';
    startGame([{ name: myName, id: 'host' }]);
    applyDevParams();
  } else if (id === 'hostBtn') {
    readName();
    lobbyMsg('Creating a room…');
    try {
      NET.room = new Room(roomHandlers());
      await NET.room.host();
      NET.role = 'host';
      NET.lobby = [{ name: myName, id: 'host' }];
      renderLobby('hosting');
    } catch (err) {
      NET.room?.close();
      NET.room = null;
      lobbyMsg(`Couldn't create a room: ${err.message || err.type}`);
    }
  } else if (id === 'joinBtn') {
    readName();
    const code = $('#codeInput').value.trim().toUpperCase();
    if (code.length !== 4) return lobbyMsg('Enter the 4-letter room code.');
    lobbyMsg(`Joining ${code}…`);
    try {
      NET.room = new Room(roomHandlers());
      await NET.room.join(code);
      NET.role = 'guest';
      toHost({ t: 'hello', name: myName });
    } catch (err) {
      NET.room?.close();
      NET.room = null;
      lobbyMsg(err.message || String(err));
    }
  } else if (id === 'copyBtn') {
    $('#linkInput').select();
    try { await navigator.clipboard.writeText($('#linkInput').value); lobbyMsg('Link copied.'); } catch { lobbyMsg('Select the link and copy it.'); }
  } else if (id === 'startBtnLobby') {
    toGuests({ t: 'start', players: NET.lobby });
    startGame(NET.lobby);
  } else if (id === 'cancelBtn') {
    leaveRoom();
  }
});

function leaveRoom() {
  NET.room?.close();
  NET.room = null;
  NET.role = 'solo';
  NET.started = false;
  NET.lobby = [];
  history.replaceState(null, '', location.pathname);
  clearRun();
  G = newGame([{ name: myName, id: 'host' }]);
  G.phase = 'lobby';
  NET.me = 0;
  setLanePlayers(1);
  buildLane();
  makeBoards(1);
  fitView();
  renderViewBtn();
  $('#centerMsg').hidden = true;
  renderStats();
  setTextState();
  renderShop();
  renderHud();
  renderLobby('menu');
}

const pidOf = peerId => G.players.findIndex(p => p.id === peerId);

function roomHandlers() {
  return {
    canJoin: () => (NET.started ? 'That game has already started.' : NET.lobby.length >= MAX_PLAYERS ? 'That room is full.' : null),
    onMessage: (msg, from) => (NET.role === 'host' ? hostMessage(msg, from) : guestMessage(msg)),
    onLeave: peerId => {
      if (!NET.started) {
        NET.lobby = NET.lobby.filter(p => p.id !== peerId);
        toGuests({ t: 'lobby', players: NET.lobby });
        renderLobby('hosting');
        return;
      }
      const pid = pidOf(peerId);
      if (pid < 0) return;
      G.players[pid].online = false;
      toast(`${G.players[pid].name} left the game.`);
      toGuests({ t: 'left', pid });
      hostCheckReady();
    },
    onHostLeft: () => {
      $('#centerMsg').innerHTML = '<div class="box"><h2>The host left the game</h2><button id="leaveBtn">Back to menu</button></div>';
      $('#centerMsg').hidden = false;
      $('#leaveBtn').addEventListener('click', leaveRoom);
      G.phase = 'over';
      setTextState();
    },
    onError: err => toast(`Connection problem: ${err.message || err.type}`),
  };
}

function hostMessage(msg, from) {
  if (msg.t === 'hello') {
    if (NET.started || NET.lobby.length >= MAX_PLAYERS) return;
    NET.lobby.push({ name: String(msg.name || 'Player').slice(0, 16), id: from });
    toGuests({ t: 'lobby', players: NET.lobby });
    renderLobby('hosting');
    return;
  }
  const pid = pidOf(from);
  if (pid < 0) return;
  switch (msg.t) {
    case 'key':
      pressKey(pid, msg.code);
      if (G.phase === 'wave') fire(pid, msg.code, msg.ctx, true);
      toGuests({ t: 'key', pid, code: msg.code, ctx: msg.ctx }, from);
      break;
    case 'typo':
      if (G.phase === 'wave') onTypo(pid, msg.ch);
      break;
    case 'clean':
      if (G.phase === 'wave') onCleanWord(pid, msg.word);
      break;
    case 'item':
      setItem(pid, msg.code, msg.type, msg.level);
      toGuests({ t: 'item', pid, code: msg.code, type: msg.type, level: msg.level }, from);
      break;
    case 'stat':
      reported[pid] = { gold: msg.gold, wpm: msg.wpm };
      break;
    case 'ready':
      Object.assign(G.players[pid], { ready: true, slow: msg.slow ?? [] });
      hostCheckReady();
      break;
  }
}

function guestMessage(msg) {
  switch (msg.t) {
    case 'reject':
      lobbyMsg(msg.reason);
      NET.room?.close();
      NET.room = null;
      NET.role = 'solo';
      break;
    case 'lobby':
      NET.lobby = msg.players;
      renderLobby('joined');
      break;
    case 'start':
      startGame(msg.players);
      break;
    case 'key':
      pressKey(msg.pid, msg.code);
      if (G.phase === 'wave') fire(msg.pid, msg.code, msg.ctx, false);
      break;
    case 'item':
      setItem(msg.pid, msg.code, msg.type, msg.level);
      break;
    case 'readyState':
      msg.ready.forEach((r, pid) => { if (G.players[pid]) G.players[pid].ready = r; });
      setTextState();
      renderShop();
      break;
    case 'wave':
      G.wave = msg.wave;
      G.players.forEach(p => { p.ready = false; });
      beginWave(msg.bane);
      break;
    case 'spawn':
      spawnEnemy(msg.spec);
      break;
    case 'die': {
      const e = enemyById.get(msg.id);
      if (msg.leak) {
        G.lives = msg.lives;
        ringFx(new THREE.Vector3(LANE.goalX - 0.7, 0.5, LANE.z), 0xff6b5b, 1.4);
        renderHud();
      } else if (e) popFx(e.group.position.clone(), e.def.color, e.def.size);
      if (e) removeEnemy(e);
      break;
    }
    case 'snap':
      applySnapshot(msg);
      break;
    case 'stats':
      pushSample({ wave: msg.wave, p: msg.p });
      break;
    case 'waveEnd':
      for (const e of [...enemies]) removeEnemy(e);
      enemies = [];
      onWaveEnd();
      break;
    case 'over':
      showGameOver();
      break;
    case 'left':
      if (G.players[msg.pid]) {
        G.players[msg.pid].online = false;
        toast(`${G.players[msg.pid].name} left the game.`);
        renderShop();
      }
      break;
  }
}

// ---------- UI

function renderHud() {
  let html = `<span>Wave <b>${G.wave}</b></span><span class="lives">Lives <b>${G.lives}</b></span><span class="gold">Gold <b>${goldNow()}</b></span>`;
  if (G.phase === 'wave' && wave) {
    const left = spawnQueue.length + enemies.filter(e => !e.dead).length;
    const mins = wave.start != null && wave.last > wave.start ? (wave.last - wave.start) / 60000 : 0;
    const wpm = mins ? wave.chars / 5 / mins : 0;
    const acc = wave.hits / Math.max(1, wave.hits + wave.misses);
    html += `<span>Enemies <b>${left}</b></span><span>WPM <b>${wpm.toFixed(0)}</b></span><span>Acc <b>${(acc * 100).toFixed(0)}%</b></span><span>Streak <b>${G.streak}</b></span>`;
    if (G.bane) html += `<span class="banetag" title="${esc(baneText(G.bane))}">${BANES[G.bane.kind].name} · ${(myBaneLetters() ?? []).map(l => l.toUpperCase()).join(' ')}</span>`;
  }
  if (isMulti() && NET.room) html += `<span>Room <b>${NET.room.code}</b></span>`;
  html += `<span>Best <b>${best}</b></span>`;
  $('#hud').innerHTML = html;
}

function effectText(it, code) {
  const d = ITEMS[it.type], pm = keyPowerMult(letterOf(code));
  if (it.type === 'mine') return `+${(d.gold * it.level * pm).toFixed(1)}g/press`;
  if (d.support) return `+${Math.round((d.boost + 0.15 * (it.level - 1)) * 100)}% to ${ampNeighbours(code).map(c => keyLabel(c)).join(' ')}`;
  const amp = ampBonus(NET.me, code);
  return `${Math.round(d.dmg * POWER[it.level] * pm * amp)} dmg/shot${amp > 1 ? ' (amped)' : ''}`;
}

function renderShop() {
  if (G.phase === 'lobby') { $('#shop').innerHTML = ''; return; }
  const open = G.phase === 'shop';
  const owned = [...myItems().entries()].sort((a, b) => ITEM_ORDER.indexOf(a[1].type) - ITEM_ORDER.indexOf(b[1].type)
    || FREQ_BY_LETTER[letterOf(a[0])].rank - FREQ_BY_LETTER[letterOf(b[0])].rank);
  const status = open ? 'upgrade with gold' : G.phase === 'draft' ? 'pick a card first' : G.phase === 'ready' ? 'ready' : G.phase === 'wave' ? 'between waves' : '';
  let html = '';
  if (isMulti()) {
    html += `<div class="card"><h3><span>Room ${NET.room?.code ?? ''}</span><span class="hint">${G.players.length} players</span></h3>
      <ul class="plist small">${G.players.map((p, pid) => `<li><span class="pdot" style="background:${PLAYER_COLORS[pid]}"></span>${esc(p.name)}${pid === NET.me ? ' <span class="muted">(you)</span>' : ''}
        <span class="pstate">${!p.online ? 'left' : G.phase === 'wave' ? `${p.items.size} towers` : p.ready ? '✓ ready' : 'choosing…'}</span></li>`).join('')}</ul></div>`;
  }
  html += `<div class="card"><h3><span>Your towers (${owned.length})</span><span class="hint">${status}</span></h3>`;
  html += owned.length ? `<div class="items">${owned.map(([code, it]) => {
    const d = ITEMS[it.type], up = it.level < MAX_LEVEL ? upgradeCost(it.type, it.level, letterOf(code)) : null;
    return `<div class="item owned ${code === selectedKey ? 'sel' : ''}" data-key="${code}">
      <span class="dot" style="background:${hex(d.color)}"></span>
      <span class="nm"><span class="chip">${keyLabel(code)}</span> ${d.name} <span class="num">L${it.level}/${MAX_LEVEL}</span></span>
      ${up != null ? `<button class="upmini" data-up="${code}" ${open && G.gold >= up ? '' : 'disabled'}>▲ ${up}g</button>` : '<span class="num">max</span>'}
      <span class="ds">${effectText(it, code)} · ${it.shots} ${it.type === 'mine' ? 'presses' : 'shots'}${isAuth() && it.type !== 'mine' && !d.support ? ` · ${Math.round(it.damage)} dmg dealt` : ''}</span>
    </div>`;
  }).join('')}</div>` : '<p class="hint">No towers yet. Pick a card from the draft.</p>';
  html += '</div>';

  if (selectedKey) {
    const ch = codeToChar(selectedKey), f = isLetterCode(selectedKey) ? FREQ_BY_LETTER[ch] : null;
    const it = myItems().get(selectedKey);
    html += `<div class="card"><h3><span>Key ${keyLabel(selectedKey)}</span>${it ? `<span class="hint">${ITEMS[it.type].name} · level ${it.level}/${MAX_LEVEL}</span>` : ''}</h3>`;
    html += f
      ? `<div class="hint">In <b>${f.pctWords}%</b> of Webster's words · <b>${f.pctLetters}%</b> of all letters · rank ${f.rank}/26</div>
         <div class="freqbar"><span style="width:${f.scale * 100}%"></span></div>
         <div class="hint">On this key: damage per shot <b>×${keyPowerMult(ch).toFixed(2)}</b> · upgrade price <b>×${keyCostMult(ch).toFixed(2)}</b></div>`
      : '<p class="hint">Only letter keys can hold towers.</p>';
    if (it) {
      const up = it.level < MAX_LEVEL ? upgradeCost(it.type, it.level, ch) : null;
      html += `<p class="hint">${effectText(it, selectedKey)} now${up != null ? `, ${effectText({ ...it, level: it.level + 1 }, selectedKey)} at level ${it.level + 1}` : ''}</p>
        <div class="btnrow">
        ${up != null ? `<button data-up="${selectedKey}" class="primary" ${open && G.gold >= up ? '' : 'disabled'}>Upgrade (${up}g)</button>` : '<button disabled>Max level</button>'}
        <button id="scrapBtn" ${open ? '' : 'disabled'} title="Removes the tower so this key can show up in future drafts">Scrap (+${scrapValue(it.type, it.level, ch)}g)</button></div>`;
    } else if (f) {
      html += '<p class="hint">Empty. Towers only arrive through drafts.</p>';
    }
    html += '</div>';
  }

  const spec = waveSpec(G.wave, G.players.length).list;
  const next = spec.reduce((m, e) => ((m[e.type] = (m[e.type] || 0) + 1), m), {});
  const mods = spec.reduce((m, e) => (e.mod && (m[e.mod] = (m[e.mod] || 0) + 1), m), {});
  const slow = slowestKeys(3);
  const toBoss = BOSS_EVERY - ((G.wave - 1) % BOSS_EVERY) - 1;
  const startLabel = open ? (isMulti() ? `Ready for wave ${G.wave} ▶` : `Start wave ${G.wave} ▶`)
    : G.phase === 'ready' ? `Waiting for ${waitingFor().join(', ')}…`
    : G.phase === 'draft' ? 'Choose a card first' : G.phase === 'over' ? 'Game over' : `Wave ${G.wave} in progress`;
  html += `<div class="card">
    <p class="hint" style="margin-top:0">${G.phase === 'wave' ? 'This' : 'Next'} wave: ${Object.entries(next).map(([t, n]) => `${n} ${ENEMIES[t].name.toLowerCase()}${n > 1 ? 's' : ''}`).join(', ')}${
      Object.keys(mods).length ? ` <span class="modlist">(${Object.entries(mods).map(([m, n]) => `<span title="${MODS[m].desc}">${n} ${MODS[m].name.toLowerCase()}</span>`).join(', ')})</span>` : ''}${
      G.players.length > 1 ? ` <span class="muted">· scaled for ${G.players.length} players</span>` : ''}</p>
    <div class="scout">${isBossWave(G.wave)
      ? `<b class="bosswarn">Boss wave!</b> It gets a bane built from your slowest keys${slow.length ? `: <b>${slow.map(k => keyLabel(k.code)).join(' ')}</b>` : ''}.`
      : `<b>Boss in ${toBoss} wave${toBoss === 1 ? '' : 's'}.</b> Scouting your slowest keys: ${slow.length
        ? slow.map(k => `<span class="chip">${keyLabel(k.code)}</span> ${Math.round(k.ms)}ms`).join(' · ')
        : 'keep typing…'}`}</div>
    <button class="startbtn" id="startBtn" ${open ? '' : 'disabled'}>${startLabel}</button>
    <p class="hint">Clean words pay gold equal to their length. Towers fire when you type their letter. You get a new card after every wave.<br>
    Draft: <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> tower, then type the key's letter · <kbd>Tab</kbd> reroll · <kbd>Esc</kbd> skip &nbsp; Shop: type a letter to select it · <kbd>Enter</kbd> ${isMulti() ? 'ready' : 'start'}${isMulti() ? '' : ' · <kbd>Esc</kbd> pause'}</p></div>`;
  $('#shop').innerHTML = html;
}

function upgrade(code) {
  const it = myItems().get(code);
  if (!it || G.phase !== 'shop' || it.level >= MAX_LEVEL) return;
  const cost = upgradeCost(it.type, it.level, letterOf(code));
  if (G.gold < cost) return toast(`Upgrading costs ${cost}g. You have ${goldNow()}g.`);
  G.gold -= cost;
  changeItem(code, it.type, it.level + 1);
  renderShop();
  renderHud();
}

function onKeyClick(code) {
  if (G.phase === 'lobby') return;
  selectedKey = code;
  kb.setSelected(code);
  renderShop();
}

$('#shop').addEventListener('click', e => {
  const up = e.target.closest('[data-up]');
  if (up) return upgrade(up.dataset.up);
  if (e.target.closest('#scrapBtn')) {
    const it = myItems().get(selectedKey);
    G.gold += scrapValue(it.type, it.level, letterOf(selectedKey));
    changeItem(selectedKey, it.type, 0);
    renderShop();
    renderHud();
    return;
  }
  if (e.target.closest('#startBtn')) return markReady();
  const row = e.target.closest('[data-key]');
  if (row) onKeyClick(row.dataset.key);
});

function hover(code, x, y) {
  const tip = $('#tooltip');
  if (!code || G.phase === 'lobby') { tip.style.display = 'none'; return; }
  const f = isLetterCode(code) ? FREQ_BY_LETTER[codeToChar(code)] : null;
  const it = myItems().get(code);
  tip.innerHTML = `<b>${keyLabel(code)}</b>` +
    (f ? ` · ${f.pctLetters}% of letters · rank ${f.rank}/26` : '') +
    (it ? `<br>${ITEMS[it.type].name} level ${it.level} · ${effectText(it, code)} · ${it.shots} ${it.type === 'mine' ? 'presses' : 'shots'}` : '');
  tip.style.display = 'block';
  tip.style.left = x + 14 + 'px';
  tip.style.top = y + 14 + 'px';
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 4500);
}

// ---------- input

window.addEventListener('keydown', e => {
  if (e.repeat || e.target.tagName === 'INPUT') return;
  if (G.phase === 'lobby') return;
  kb.press(e.code);
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  if (G.phase === 'over') {
    if (e.key === 'Enter' && NET.role !== 'guest') playAgain();
    return;
  }
  if (G.phase === 'draft') {
    if (/^[1-3]$/.test(e.key)) selectTower(Number(e.key) - 1);
    else if (G.draft.keys.includes(e.code)) selectKey(G.draft.keys.indexOf(e.code)); // type the key's letter
    else if (e.key === 'Tab') { e.preventDefault(); rerollDraft(); }
    else if (e.key === 'Escape') skipDraft();
    return;
  }
  if (G.phase === 'shop' || G.phase === 'ready') {
    if (e.key === 'Enter') { e.preventDefault(); markReady(); }
    else if (isLetterCode(e.code)) onKeyClick(e.code);
    return;
  }
  // wave
  if (e.key === 'Escape') {
    if (isMulti()) return toast("Can't pause a multiplayer game.");
    paused = !paused;
    setTextState();
    return;
  }
  if (paused || e.key.length !== 1) return;
  e.preventDefault();
  typeChar(e.key, e.code, e.timeStamp);
});

document.addEventListener('click', e => e.target.closest('button')?.blur());
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  stats.flush();
  if (NET.role === 'solo' && G.phase === 'wave' && !paused) {
    paused = true;
    setTextState();
  }
});
window.addEventListener('pagehide', () => stats.flush());

// ---------- loop

// The simulation runs on a Web Worker timer rather than requestAnimationFrame: browsers stop
// animation frames in background tabs, which would freeze the game for everyone if the host
// switched tabs. Drawing still happens in the animation loop below.
let lastSim = performance.now();
const ticker = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 33);'], { type: 'text/javascript' })));
ticker.onmessage = () => {
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastSim) / 1000);
  lastSim = now;
  simStep(dt);
};

function simStep(dt) {
  if (!paused) statsTick(dt);
  if (G.phase === 'wave' && !paused) {
    time += dt;
    if (isAuth()) {
      if (spawnQueue.length) {
        spawnTimer -= dt;
        if (spawnTimer <= 0) {
          hostSpawn(spawnQueue.shift());
          spawnTimer = spawnInterval;
          renderHud();
        }
      }
      updateEnemies(dt);
      if (NET.role === 'host' && (snapTimer -= dt) <= 0) {
        snapTimer = 0.1;
        toGuests(snapshot());
      }
      if (G.phase === 'wave' && !spawnQueue.length && !enemies.length) hostEndWave();
    } else updateEnemies(dt);
  }
}

let lastFrame = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  updateFx(dt);
  animateClones(now);
  animateAuras(now);
  if (G.phase === 'draft') art.render(now / 1000, i => i === hoverCard || i === G.draft?.tower);
}

// Developer shortcut for testing later waves (solo only): ?wave=10&gold=500
function applyDevParams() {
  const params = new URLSearchParams(location.search);
  if (!params.has('wave') && !params.has('gold')) return;
  if (params.has('wave')) G.wave = Math.max(1, Number(params.get('wave')) || 1);
  if (params.has('gold')) G.gold = Number(params.get('gold')) || 0;
  openDraft(OPENING_PICKS);
}

setLanePlayers(1);
buildLane();
makeBoards(1);
fitView();
paintKeys();
setTextState();
renderHud();
renderShop();
renderLobby('menu');
requestAnimationFrame(loop);
