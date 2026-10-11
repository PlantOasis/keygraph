// Game balance: items you can put on keys, enemies, and wave composition.
import { FREQ_BY_LETTER } from './letter-frequency.js';

// Towers come from drafts (pick 1 of 3 cards, each a tower already bound to a key).
// Gold only buys upgrades, draft rerolls, and comes from clean words, mines, wave bonuses and skips.
export const START_GOLD = 0;
export const START_LIVES = 20;
export const OPENING_PICKS = 3;       // drafts before wave 1
export const OPENING_KEY_POOL = 13;   // opening cards only use the 13 most common letters
export const SKIP_GOLD = 25;
export const rerollCost = n => 15 + 10 * n; // n = rerolls already used this draft
export const MAX_LEVEL = 5;
export const POWER = [0, 1, 1.6, 2.4, 3.4, 4.6]; // damage multiplier by tower level

// Lane behind the keyboards, in scene units (1 = one key width). Enemies walk from startX to goalX.
// In multiplayer the keyboards sit side by side and the lane stretches across all of them.
export const LANE = { startX: 12, goalX: -12, z: -5.4, y: 0.32, width: 1.5 };
export const BOARD_GAP = 21; // distance between neighbouring players' keyboards
export function setLanePlayers(players) {
  LANE.startX = 12 + ((players - 1) * BOARD_GAP) / 2;
  LANE.goalX = -LANE.startX;
}

// Each extra player adds enemies and health on top of the longer lane.
export const PLAYER_SCALE = { count: 0.6, hp: 0.5 };

export const ITEMS = {
  blaster: {
    name: 'Blaster', weight: 30, cost: 60, color: 0x4fc3f7, dmg: 12,
    desc: 'Shoots the enemy closest to the goal.',
  },
  frost: {
    name: 'Frost', weight: 18, cost: 70, color: 0x9be7ff, dmg: 6, slow: 0.6, slowTime: 2, slowRadius: 1.2,
    desc: 'Chills the lead enemy and everything near it: 60% slower for 2 s.',
  },
  cannon: {
    name: 'Cannon', weight: 16, cost: 110, color: 0xff8a50, dmg: 16, splash: 1.6,
    desc: 'Explodes on impact, hurting everything nearby.',
  },
  tesla: {
    name: 'Tesla', weight: 14, cost: 120, color: 0xffee58, dmg: 10, chain: 3,
    desc: 'Lightning jumps between up to 3 enemies (+1 per level).',
  },
  rail: {
    name: 'Railgun', weight: 8, cost: 150, color: 0xb388ff, dmg: 45,
    desc: 'Huge single hit on the enemy with the most health.',
  },
  mine: {
    name: 'Gold mine', weight: 14, cost: 40, color: 0xffc107, gold: 1,
    desc: 'Gold every time you type this key. Pays more per press on rare letters.',
  },
  poison: {
    name: 'Poison', weight: 14, cost: 90, color: 0x7ee06a, dmg: 3, dot: 8, dotTime: 4,
    desc: 'Poisons the lead enemy: 8 damage per second for 4 s. Stacks.',
  },
  mortar: {
    name: 'Mortar', weight: 10, cost: 130, color: 0xa1887f, dmg: 15, splash: 2.2, otherShare: 0.6,
    desc: 'Lobs a heavy shell at the most crowded spot. Others in the blast take 60%.',
  },
  gust: {
    name: 'Gust', weight: 12, cost: 80, color: 0x80deea, dmg: 5, push: 1.6, targets: 2,
    desc: 'Blows the two lead enemies back toward the start. Bosses barely budge.',
  },
  amp: {
    name: 'Amplifier', weight: 10, cost: 100, color: 0xf48fb1, boost: 0.35, support: true,
    desc: "Doesn't shoot. Towers on neighbouring keys deal +35% damage (+15% per level).",
  },
  herald: {
    name: 'Herald', weight: 14, cost: 80, color: 0xffb74d, dmg: 9, startMult: 3,
    desc: 'Triple damage when its letter is the first letter of a word.',
  },
  focus: {
    name: 'Focus', weight: 10, cost: 110, color: 0xff5252, dmg: 6, perStreak: 0.35, maxStreak: 12,
    desc: '+35% damage for every clean word in your current streak (up to +420%).',
  },
};
export const ITEM_ORDER = ['blaster', 'frost', 'cannon', 'tesla', 'rail', 'poison', 'mortar', 'gust', 'herald', 'focus', 'amp', 'mine'];
export const NON_OPENING = ['mine', 'amp']; // opening hands are damage towers only
export const AMP_RANGE = 1.6;              // key units: the 4–6 keys around an Amplifier

// ---------- letter frequency (Webster's) shapes every key
// rel = how often the letter is typed compared with an average letter (E ≈ 2.7, J ≈ 0.03).
// Common letters fire often but hit softer and cost more to upgrade; rare letters fire
// rarely but hit hard and upgrade cheaply. A tower on E still out-damages one on J overall,
// which is what makes choosing between draft cards interesting.
export const COST_EXP = 0.6;   // upgrade price = base × rel^0.6  (clamped)
export const POWER_EXP = 0.5;  // per-press     = base × rel^-0.5 (clamped)
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const rel = letter => FREQ_BY_LETTER[letter].pctLetters / (100 / 26);
export const keyCostMult = letter => clamp(rel(letter) ** COST_EXP, 0.35, 2.5);
export const keyPowerMult = letter => clamp(rel(letter) ** -POWER_EXP, 0.5, 6);

// `cost` on each item is its base value, used to price upgrades.
export const upgradeCost = (type, level, letter) => Math.round(ITEMS[type].cost * 0.6 * level * keyCostMult(letter));
// Scrapping frees the key for future drafts and refunds half of what you spent upgrading.
export function scrapValue(type, level, letter) {
  let spent = 0;
  for (let l = 1; l < level; l++) spent += upgradeCost(type, l, letter);
  return 10 + Math.floor(spent * 0.5);
}

export const ENEMIES = {
  grunt: { name: 'Grunt', hp: 30, speed: 1.3, leak: 1, color: 0xef5350, size: 0.3 },
  runner: { name: 'Runner', hp: 16, speed: 2.4, leak: 1, color: 0x66bb6a, size: 0.24 },
  tank: { name: 'Tank', hp: 120, speed: 0.75, leak: 3, color: 0x8d6e63, size: 0.42 },
  boss: { name: 'Boss', hp: 420, speed: 0.55, leak: 10, color: 0xab47bc, size: 0.6 },
};

// Modifiers that make regular enemies react to how you type.
export const MODS = {
  shield: { name: 'Shielded', from: 3, desc: 'Immune until you finish a clean word, which breaks the shield.' },
  lock: { name: 'Letter-locked', from: 5, desc: 'Only takes damage while you are typing a word that contains its letter.' },
  frenzy: { name: 'Frenzied', from: 7, desc: 'Speeds up every time you make a typo.' },
};

// Every BOSS_EVERY waves a boss arrives with a bane built from your slowest keys this run.
export const BOSS_EVERY = 10;
// The three banes take turns (in an order set at the start of each game), so bosses 10, 20
// and 30 are always different. Each has its own look.
export const BANE_KINDS = ['lock', 'shield', 'frenzy'];
export const BANES = {
  lock: { name: 'Lockjaw', desc: k => `Only takes damage while you type a word containing ${k}.` },
  shield: { name: 'Aegis', desc: k => `Shielded. A clean word containing ${k} opens the shield for 3 seconds.` },
  frenzy: { name: 'Frenzy', desc: k => `Speeds up with every typo. Typos on ${k} count double.` },
};
export const BANE_WORD_SHARE = 0.6; // share of boss-wave words that contain your slow keys

export function waveSpec(n, players = 1) {
  const extra = players - 1;
  const hpMul = 1.17 ** (n - 1) * (1 + PLAYER_SCALE.hp * extra); // compounding, so later waves keep up with upgrades
  const many = x => Math.round(x * (1 + PLAYER_SCALE.count * extra));
  const counts = {
    grunt: many(5 + 2 * n),
    runner: n >= 2 ? many(Math.floor(n * 1.5)) : 0,
    tank: n >= 4 ? many(Math.floor((n - 2) / 2)) : 0,
    boss: n % BOSS_EVERY === 0 ? 1 : 0,
  };
  // Grunts and runners mixed, tanks in the back half, boss last.
  const light = [];
  for (let i = 0; i < counts.grunt; i++) light.push('grunt');
  for (let i = 0; i < counts.runner; i++) light.splice(Math.floor(Math.random() * (light.length + 1)), 0, 'runner');
  const list = [...light];
  for (let i = 0; i < counts.tank; i++) list.splice(Math.floor(list.length / 2 + Math.random() * (list.length / 2 + 1)), 0, 'tank');
  for (let i = 0; i < counts.boss; i++) list.push('boss');
  const out = list.map(type => ({ type, hp: Math.round(ENEMIES[type].hp * hpMul), mod: null }));
  // Sprinkle typing modifiers onto regular enemies as the run goes on.
  const plain = () => out.filter(e => !e.mod && e.type !== 'boss');
  const assign = (mod, count) => {
    for (let i = 0; i < count; i++) {
      const pool = plain();
      if (!pool.length) return;
      pool[Math.floor(Math.random() * pool.length)].mod = mod;
    }
  };
  assign('shield', n >= MODS.shield.from ? many(Math.floor((n - 1) / 2)) : 0);
  assign('lock', n >= MODS.lock.from ? many(Math.floor((n - 3) / 2)) : 0);
  assign('frenzy', n >= MODS.frenzy.from ? many(Math.floor((n - 5) / 2)) : 0);
  return { list: out, interval: Math.max(0.35, (1.6 - 0.07 * n) / (1 + PLAYER_SCALE.count * extra)) };
}

export const waveBonus = n => 25 + 5 * n;

// ---------- Focus waves: on waves 3, 5, 7 (13, 15, 17, …) one region of the keyboard comes up far
// more in the words, and towers on it hit harder. It's announced in the shop beforehand.
export const isFocusWave = n => [3, 5, 7].includes(n % 10);
export const FOCUSES = {
  left: { name: 'Left hand', letters: 'qwertasdfgzxcvb' },
  right: { name: 'Right hand', letters: 'yuiophjklnm' },
  top: { name: 'Top row', letters: 'qwertyuiop' },
  home: { name: 'Home row', letters: 'asdfghjkl' },
  bottom: { name: 'Bottom row', letters: 'zxcvbnm' },
  index: { name: 'Index fingers', letters: 'rtfgvbyuhjnm' },
  outer: { name: 'Ring & pinky fingers', letters: 'qazwsxolp' },
};
// word weight × FOCUS_WORD_BIAS^(share of the word's letters in the region): lifts the region's
// share of typing by about 1.25–1.5×; with the damage bonus, its towers do roughly 2× as much.
export const FOCUS_WORD_BIAS = 30;
export const FOCUS_DAMAGE = 0.4;

// ---------- Bridges: a reward for each boss. Typing the "from" key also fires the tower on the
// "to" key, at half power and using the FROM key's per-shot strength, so a bridge from a common
// key to a rare-key tower doesn't multiply that tower's big hits. One per key, no chains.
export const BRIDGE_POWER = 0.5;

// Beating this wave's boss wins the game; players can then keep going in endless mode.
export const FINAL_WAVE = 20;
