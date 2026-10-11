// Key Defense balance simulator: plays the game headlessly with a bot typist, using the real
// numbers from tower-defense/defs.js (towers, waves, enemy modifiers, banes, focus waves,
// bridges, economy). Mirrors the targeting/damage rules in tower-defense/game.js.
//
//   node tools/balance-sim.mjs            # full report
//   node tools/balance-sim.mjs --runs 40  # more runs per scenario (slower, smoother numbers)

import {
  ITEMS, ITEM_ORDER, ENEMIES, POWER, MAX_LEVEL, START_GOLD, START_LIVES, OPENING_PICKS, OPENING_KEY_POOL,
  NON_OPENING, AMP_RANGE, BOSS_EVERY, BANE_WORD_SHARE, isFocusWave, FOCUSES, FOCUS_WORD_BIAS, FOCUS_DAMAGE,
  BRIDGE_POWER, upgradeCost, waveSpec, waveBonus, keyPowerMult, LANE, setLanePlayers,
} from '../tower-defense/defs.js';
import { LETTER_FREQUENCY } from '../tower-defense/letter-frequency.js';
import { WORDS } from '../js/words.js';
import { charToCode, travel } from '../js/layout.js';

const args = process.argv.slice(2);
const RUNS = Number(args[args.indexOf('--runs') + 1]) || 20;

// --proposed: try candidate balance changes in memory (the game itself is untouched)
const PROPOSED = {}; // put candidate changes here, e.g. { mortar: { dmg: 12 } }
if (args.includes('--proposed')) for (const [t, v] of Object.entries(PROPOSED)) Object.assign(ITEMS[t], v);
const MAX_WAVE = 30;      // play past 20 (endless) so strong builds can be told apart
const DT = 0.05;

// ---------- seeded random so results are reproducible
let seed = 1;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const pick = arr => arr[Math.floor(rand() * arr.length)];
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// ---------- words, weighted to Webster's letter frequencies (same as the game)
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
function weightedWord(weights, total) {
  let r = rand() * total;
  for (let i = 0; i < WORDS.length; i++) if ((r -= weights[i]) <= 0) return WORDS[i];
  return WORDS.at(-1);
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');
const COMMON = LETTER_FREQUENCY.slice(0, OPENING_KEY_POOL).map(f => f.letter);
const BY_FREQ = LETTER_FREQUENCY.map(f => f.letter);

// ---------- one game
// opts: { wpm, acc, build: tower type to force (mono) or null (random drafts) }
function playGame(opts) {
  setLanePlayers(1);
  const laneLen = LANE.startX - LANE.goalX;
  const cps = (opts.wpm * 5) / 60; // characters per second
  const towers = new Map();        // letter -> { type, level, dmg }
  const bridges = new Map();       // from letter -> to letter
  let gold = START_GOLD, lives = START_LIVES, streak = 0;
  const dmgByType = {};            // total damage per tower type
  let bridgeDmg = 0, bridgeGold = 0;
  const towerWaves = {};           // tower-waves alive per type (for per-slot rates)
  let lastBane = null, lastFocus = null, pickNo = 0;

  const strength = (letter, via) => keyPowerMult(via ?? letter) * (via ? BRIDGE_POWER : 1);
  const ampBonus = letter => {
    let b = 1;
    for (const [l, t] of towers) if (t.type === 'amp' && l !== letter && travel(charToCode(l), charToCode(letter)).dist <= AMP_RANGE) b += ITEMS.amp.boost + 0.15 * (t.level - 1);
    return b;
  };

  // Bot draft: pick a tower type (forced, or a random one of 3 offered), put it on the most
  // frequent of 3 offered keys (the obvious greedy choice).
  function draft(wave) {
    const free = LETTERS.filter(l => !towers.has(l));
    if (!free.length) return;
    if (opts.plan) {
      const next = opts.plan[pickNo++];
      if (next && !towers.has(next[1])) return towers.set(next[1], { type: next[0], level: 1 });
      const filler = BY_FREQ.find(l => !towers.has(l) && l !== opts.bridge?.from) ?? free[0];
      return towers.set(filler, { type: next?.[0] ?? 'blaster', level: 1 });
    }
    let type = typeof opts.build === 'function' ? opts.build(pickNo) : opts.build;
    pickNo++;
    if (!type) {
      const pool = ITEM_ORDER.filter(t => wave > 1 || !NON_OPENING.includes(t));
      const offered = [];
      while (offered.length < 3) {
        let r = rand() * pool.reduce((a, t) => a + ITEMS[t].weight, 0);
        const t = pool.find(x => (r -= ITEMS[x].weight) <= 0) ?? pool.at(-1);
        if (!offered.includes(t)) offered.push(t);
      }
      type = pick(offered);
    }
    const keyPool = wave === 1 ? COMMON.filter(l => !towers.has(l)) : free;
    const offeredKeys = shuffle([...keyPool]).slice(0, 3);
    const key = offeredKeys.sort((a, b) => BY_FREQ.indexOf(a) - BY_FREQ.indexOf(b))[0];
    towers.set(key, { type, level: 1 });
  }

  // Bot shop: keep buying the cheapest upgrade available.
  function shop() {
    for (;;) {
      let best = null;
      for (const [l, t] of towers) {
        if (t.level >= MAX_LEVEL || ITEMS[t.type].support && t.level >= 3) continue;
        const c = upgradeCost(t.type, t.level, l);
        if (!best || c < best.c) best = { l, c };
      }
      if (!best || best.c > gold) return;
      gold -= best.c;
      towers.get(best.l).level++;
    }
  }

  const placeBridge = () => {
    const b = opts.bridge;
    const to = [...towers].find(([, tw]) => tw.type === b.toType)?.[0];
    if (to && !bridges.has(b.from)) bridges.set(b.from, to);
  };
  for (let i = 0; i < OPENING_PICKS; i++) draft(1);

  for (let wave = 1; wave <= MAX_WAVE; wave++) {
    if (opts.bridge && opts.bridge.atWave === 0) placeBridge(); // retried until the target tower exists
    shop();
    for (const t of towers.values()) towerWaves[t.type] = (towerWaves[t.type] || 0) + 1;
    const boss = wave % BOSS_EVERY === 0;
    const focus = isFocusWave(wave) ? (lastFocus = pick(Object.keys(FOCUSES).filter(k => k !== lastFocus))) : null;
    const focusLetters = focus ? FOCUSES[focus].letters : '';
    let bane = null;
    if (boss) {
      const kinds = ['lock', 'shield', 'frenzy'].filter(k => k !== lastBane);
      bane = { kind: (lastBane = pick(kinds)), letters: shuffle(COMMON.slice(6)).slice(0, 3), openUntil: 0 };
    }
    // word source for this wave
    let weights = WORD_WEIGHTS;
    if (focus) weights = WORDS.map((w, i) => WORD_WEIGHTS[i] * FOCUS_WORD_BIAS ** ([...w].filter(c => focusLetters.includes(c)).length / w.length));
    const total = weights.reduce((a, b) => a + b, 0);
    const banePool = bane ? WORDS.map((w, i) => (bane.letters.some(l => w.includes(l)) ? WORD_WEIGHTS[i] : 0)) : null;
    const baneTotal = banePool ? banePool.reduce((a, b) => a + b, 0) : 0;
    const nextWord = () => (bane && rand() < BANE_WORD_SHARE ? weightedWord(banePool, baneTotal) : weightedWord(weights, total));

    const spec = waveSpec(wave, 1);
    const queue = spec.list.map(s => ({ ...s, lock: s.mod === 'lock' ? pick(COMMON) : null }));
    const enemies = [];
    let t = 0, spawnT = 0.6, charT = 0;
    let word = nextWord(), ci = 0, wordClean = true;

    const vulnerable = e => {
      if (e.hp <= 0 || e.shield) return false;
      if (e.lock && !word.includes(e.lock)) return false;
      if (e.bane?.kind === 'lock' && !e.bane.letters.some(l => word.includes(l))) return false;
      if (e.bane?.kind === 'shield' && t > e.bane.openUntil) return false;
      return true;
    };
    const lead = list => list.reduce((a, b) => (b.dist > a.dist ? b : a));
    const hit = (e, dmg, type) => {
      if (e.hp <= 0) return;
      const d = Math.min(e.hp, dmg);
      e.hp -= dmg;
      dmgByType[type] = (dmgByType[type] || 0) + d;
    };

    function fireTower(letter, first, via = null) {
      const tw = towers.get(letter);
      if (!tw) return;
      const def = ITEMS[tw.type], str = strength(letter, via);
      if (tw.type === 'mine') { gold += def.gold * tw.level * str; if (via) bridgeGold += def.gold * tw.level * str; return; }
      const before = via ? Object.values(dmgByType).reduce((a, b) => a + b, 0) : 0;
      fireInner(tw, def, str, letter, first);
      if (via) bridgeDmg += Object.values(dmgByType).reduce((a, b) => a + b, 0) - before;
    }

    function fireInner(tw, def, str, letter, first) {
      if (def.support) return;
      const list = enemies.filter(vulnerable);
      if (!list.length) return;
      let dmg = def.dmg * POWER[tw.level] * str * ampBonus(letter);
      if (focus && focusLetters.includes(letter)) dmg *= 1 + FOCUS_DAMAGE;
      if (tw.type === 'herald' && first) dmg *= def.startMult;
      if (tw.type === 'focus') dmg *= 1 + def.perStreak * Math.min(streak, def.maxStreak);
      const L = lead(list);
      switch (tw.type) {
        case 'blaster': case 'herald': case 'focus': hit(L, dmg, tw.type); break;
        case 'frost':
          hit(L, dmg, tw.type);
          for (const e of def.slowRadius ? list.filter(e => Math.abs(e.dist - L.dist) <= def.slowRadius) : [L]) {
            e.slow = def.slow;
            e.slowUntil = t + def.slowTime * (1 + 0.5 * (tw.level - 1));
          }
          break;
        case 'cannon': for (const e of list) hit(e, e === L ? dmg : Math.abs(e.dist - L.dist) <= def.splash ? dmg * 0.6 : 0, tw.type); break;
        case 'tesla': {
          const targets = [L];
          while (targets.length < def.chain + tw.level - 1) {
            const last = targets.at(-1);
            const next = list.filter(e => !targets.includes(e)).sort((a, b) => Math.abs(a.dist - last.dist) - Math.abs(b.dist - last.dist))[0];
            if (!next) break;
            targets.push(next);
          }
          targets.forEach(e => hit(e, dmg, tw.type));
          break;
        }
        case 'rail': hit(list.reduce((a, b) => (b.hp > a.hp ? b : a)), dmg, tw.type); break;
        case 'poison':
          hit(L, dmg, tw.type);
          L.poisonDps = Math.min(def.dot * 6, (L.poisonDps || 0) + def.dot * POWER[tw.level] * str);
          L.poisonUntil = t + def.dotTime;
          L.poisonType = tw.type;
          break;
        case 'mortar': {
          const crowd = e => list.filter(o => Math.abs(o.dist - e.dist) <= def.splash).length;
          const c = list.reduce((a, b) => (crowd(b) > crowd(a) ? b : a));
          for (const e of list) if (Math.abs(e.dist - c.dist) <= def.splash) hit(e, e === c ? dmg : dmg * (def.otherShare ?? 1), tw.type);
          break;
        }
        case 'gust':
          for (const e of [...list].sort((a, b) => b.dist - a.dist).slice(0, def.targets ?? 1)) {
            hit(e, dmg, tw.type);
            e.dist = Math.max(0, e.dist - def.push * (1 + 0.25 * (tw.level - 1)) * (e.type === 'boss' ? 0.2 : e.type === 'tank' ? 0.5 : 1));
          }
          break;
      }
    }

    while (queue.length || enemies.length) {
      t += DT;
      if (queue.length && (spawnT -= DT) <= 0) {
        const s = queue.shift();
        enemies.push({ ...s, maxHp: s.hp, dist: 0, haste: 1, slow: 0, slowUntil: 0, shield: s.mod === 'shield', bane: s.type === 'boss' ? bane : null });
        spawnT = spec.interval;
      }
      // typing
      charT += DT * cps;
      while (charT >= 1) {
        charT -= 1;
        if (ci === word.length) { // the space after a word
          if (wordClean) {
            streak++;
            gold += word.length;
            const sh = enemies.filter(e => e.shield && e.hp > 0);
            if (sh.length) lead(sh).shield = false;
            for (const e of enemies) if (e.bane?.kind === 'shield' && e.bane.letters.some(l => word.includes(l))) e.bane.openUntil = t + 3;
          } else streak = 0;
          word = nextWord(); ci = 0; wordClean = true;
          continue;
        }
        if (rand() > opts.acc) { // a typo costs this keystroke
          wordClean = false;
          streak = 0;
          for (const e of enemies) {
            if (e.mod === 'frenzy') e.haste = Math.min(2.5, e.haste + 0.25);
            if (e.bane?.kind === 'frenzy') e.haste = Math.min(3, e.haste + (e.bane.letters.includes(word[ci]) ? 0.4 : 0.2));
          }
          continue;
        }
        const letter = word[ci], first = ci === 0;
        ci++;
        fireTower(letter, first);
        const to = bridges.get(letter);
        if (to) fireTower(to, first, letter);
      }
      // enemies
      for (const e of enemies) {
        if (e.poisonDps && t < e.poisonUntil && !e.shield) hit(e, e.poisonDps * DT, e.poisonType);
        e.dist += ENEMIES[e.type].speed * e.haste * (t < e.slowUntil ? 1 - e.slow : 1) * DT;
        if (e.hp > 0 && e.dist >= laneLen) { lives -= ENEMIES[e.type].leak; e.hp = 0; }
      }
      for (let i = enemies.length - 1; i >= 0; i--) if (enemies[i].hp <= 0) enemies.splice(i, 1);
      if (lives <= 0) return { wave, dmgByType, towerWaves, lost: true, bridgeDmg, bridgeGold };
      if (t > 600) break; // safety
    }
    gold += waveBonus(wave);
    if (opts.bridge !== undefined) {
      if (opts.bridge && boss && wave >= opts.bridge.atWave) placeBridge();
    } else if (boss && towers.size) {
      // boss reward: bridge from the most common untowered, unbridged letter to the strongest tower
      const from = BY_FREQ.find(l => !towers.has(l) && !bridges.has(l));
      const best = [...towers].filter(([, tw]) => !ITEMS[tw.type].support).sort((a, b) => b[1].level - a[1].level)[0];
      if (from && best) bridges.set(from, best[0]);
    }
    draft(wave + 1);
  }
  return { wave: MAX_WAVE + 1, dmgByType, towerWaves, lost: false, bridgeDmg, bridgeGold };
}

// ---------- scenarios
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

function monoTable(wpm, acc) {
  const rows = [];
  for (const type of ITEM_ORDER) {
    if (ITEMS[type].support || type === 'mine') continue;
    const waves = [];
    for (let r = 0; r < RUNS; r++) {
      seed = 1000 + r;
      waves.push(playGame({ wpm, acc, build: type }).wave - 1);
    }
    rows.push({ type, med: median(waves), min: Math.min(...waves), max: Math.max(...waves), wins: waves.filter(w => w >= 20).length });
  }
  return rows.sort((a, b) => b.med - a.med || b.wins - a.wins);
}

function mixedTable(wpm, acc) {
  const dmg = {}, slots = {}, waves = [];
  for (let r = 0; r < RUNS * 3; r++) {
    seed = 5000 + r;
    const res = playGame({ wpm, acc, build: null });
    waves.push(res.wave - 1);
    for (const [k, v] of Object.entries(res.dmgByType)) dmg[k] = (dmg[k] || 0) + v;
    for (const [k, v] of Object.entries(res.towerWaves)) slots[k] = (slots[k] || 0) + v;
  }
  const rows = Object.keys(slots).filter(k => !ITEMS[k].support && k !== 'mine')
    .map(k => ({ type: k, perSlot: (dmg[k] || 0) / slots[k] }))
    .sort((a, b) => b.perSlot - a.perSlot);
  const top = rows[0].perSlot;
  return { rows: rows.map(r => ({ ...r, rel: r.perSlot / top })), medWaves: median(waves), wins: waves.filter(w => w >= 20).length, n: waves.length };
}

// What does one extra tower of each type add to a team? Team = Blasters everywhere, except
// picks #2 and #6 which are the tower being tested. Compared with an all-Blaster team.
function marginalTable(wpm, acc) {
  const run = buildFn => {
    const waves = [];
    for (let r = 0; r < RUNS; r++) { seed = 9000 + r; waves.push(playGame({ wpm, acc, build: buildFn }).wave - 1); }
    return waves.reduce((a, b) => a + b, 0) / waves.length;
  };
  const base = run(() => 'blaster');
  return ITEM_ORDER.map(type => ({ type, gain: run(i => (i === 1 || i === 5 ? type : 'blaster')) - base })).sort((a, b) => b.gain - a.gain);
}

// ---------- combo tests: --combos
if (args.includes('--combos')) {
  const WPM = 80, ACC = 0.96;
  const avgRun = (opts, n = RUNS) => {
    const out = { waves: 0, bridgeDmg: 0, bridgeGold: 0, dmg: 0 };
    for (let r = 0; r < n; r++) {
      seed = 7000 + r;
      const res = playGame({ wpm: WPM, acc: ACC, ...opts });
      out.waves += res.wave - 1;
      out.bridgeDmg += res.bridgeDmg;
      out.bridgeGold += res.bridgeGold;
      out.dmg += Object.values(res.dmgByType).reduce((a, b) => a + b, 0);
    }
    for (const k in out) out[k] /= n;
    return out;
  };
  const fmt = x => x.toFixed(1);
  const fill = ['t', 'a', 'i', 'o', 'n', 'l', 'u', 'p', 'm', 'h', 'y', 'g', 'b', 'k', 'w', 'v', 'j', 'z', 'q'];

  console.log(`Combo tests at ${WPM} wpm, ${Math.round(ACC * 100)}% accuracy, ${RUNS} runs each (waves cleared, average)\n`);
  console.log('AMPLIFIER: towers placed on D\'s neighbours (C E F R S X), the best Amplifier spot (30% of typing)');
  for (const type of ['blaster', 'mortar', 'tesla']) {
    const ring = ['e', 'r', 's', 'f', 'c', 'x'];
    const withAmp = [...ring.slice(0, 3).map(l => [type, l]), ['amp', 'd'], ...ring.slice(3).map(l => [type, l]), ...fill.map(l => [type, l])];
    const noAmp = withAmp.map(([t, l]) => [t === 'amp' ? type : t, l]);
    const badAmp = withAmp.map(([t, l]) => (t === 'amp' ? ['amp', 'q'] : [t, l]));
    const a = avgRun({ plan: withAmp, bridge: null }), b = avgRun({ plan: noAmp, bridge: null }), c = avgRun({ plan: badAmp, bridge: null });
    console.log(`  ${pad(ITEMS[type].name + 's', 10)} Amplifier on D: ${fmt(a.waves)} · another ${ITEMS[type].name} on D instead: ${fmt(b.waves)} · Amplifier on Q (lonely corner): ${fmt(c.waves)}`);
  }

  console.log('\nBRIDGE from E (no tower on E) to each tower type, in a mixed team');
  const team = [['blaster', 't'], ['cannon', 'a'], ['tesla', 'i'], ['rail', 'o'], ['mortar', 'n'], ['poison', 'r'], ['herald', 's'], ['focus', 'l'],
    ['gust', 'c'], ['frost', 'u'], ['mine', 'd'], ['blaster', 'h'], ['blaster', 'p'], ['blaster', 'm'], ['blaster', 'y'], ['blaster', 'g'],
    ['blaster', 'b'], ['blaster', 'w'], ['blaster', 'v'], ['blaster', 'k'], ['blaster', 'f'], ['blaster', 'x']];
  const none = avgRun({ plan: team, bridge: null });
  console.log(`  no bridge: ${fmt(none.waves)} waves`);
  console.log(`  ${pad('bridge to', 10)}${lpad('from boss 10', 14)}${lpad('from start', 12)}${lpad('dmg via bridge', 16)}`);
  const rows = [];
  for (const toType of ['mortar', 'tesla', 'cannon', 'rail', 'blaster', 'herald', 'focus', 'poison', 'gust', 'frost', 'mine']) {
    const real = avgRun({ plan: team, bridge: { from: 'e', toType, atWave: 10 } });
    const early = avgRun({ plan: team, bridge: { from: 'e', toType, atWave: 0 } });
    rows.push({ toType, real, early });
  }
  rows.sort((a, b) => b.early.waves - a.early.waves);
  for (const r of rows) {
    console.log(`  ${pad(ITEMS[r.toType].name, 10)}${lpad((r.real.waves - none.waves >= 0 ? '+' : '') + fmt(r.real.waves - none.waves), 14)}${lpad((r.early.waves - none.waves >= 0 ? '+' : '') + fmt(r.early.waves - none.waves), 12)}${lpad(r.toType === 'mine' ? `${Math.round(r.early.bridgeGold)} gold` : Math.round(r.early.bridgeDmg), 16)}`);
  }

  console.log('\nBRIDGE + AMPLIFIER: Mortar on F next to an Amplifier on D, bridged from E (from the start)');
  const ampTeam = [['blaster', 't'], ['mortar', 'f'], ['blaster', 'r'], ['amp', 'd'], ['blaster', 's'], ['blaster', 'c'], ['blaster', 'x'], ...fill.slice(1).map(l => ['blaster', l])];
  const noAmpTeam = ampTeam.map(([t, l]) => [t === 'amp' ? 'blaster' : t, l]);
  const r1 = avgRun({ plan: noAmpTeam, bridge: null });
  const r2 = avgRun({ plan: noAmpTeam, bridge: { from: 'e', toType: 'mortar', atWave: 0 } });
  const r3 = avgRun({ plan: ampTeam, bridge: null });
  const r4 = avgRun({ plan: ampTeam, bridge: { from: 'e', toType: 'mortar', atWave: 0 } });
  console.log(`  neither: ${fmt(r1.waves)} · bridge only: ${fmt(r2.waves)} · Amplifier only: ${fmt(r3.waves)} · both: ${fmt(r4.waves)}`);
  process.exit(0);
}

console.log(`${args.includes('--proposed') ? '[PROPOSED BALANCE] ' : ''}Key Defense balance sim · ${RUNS} runs per mono build, ${RUNS * 3} mixed runs · endless to wave ${MAX_WAVE}`);
console.log('Bot: drafts the most common offered key, buys the cheapest upgrade, builds bridges after bosses.\n');
for (const [wpm, acc] of [[50, 0.94], [80, 0.96], [110, 0.97]]) {
  console.log(`=== ${wpm} wpm, ${Math.round(acc * 100)}% accuracy ===`);
  console.log('Single-tower builds (every pick is this tower): waves cleared');
  console.log(`  ${pad('tower', 9)}${lpad('median', 7)}${lpad('worst', 7)}${lpad('best', 6)}${lpad('reach 20', 10)}`);
  for (const r of monoTable(wpm, acc)) console.log(`  ${pad(ITEMS[r.type].name, 9)}${lpad(r.med, 7)}${lpad(r.min, 7)}${lpad(r.max, 6)}${lpad(`${r.wins}/${RUNS}`, 10)}`);
  const m = mixedTable(wpm, acc);
  console.log(`Random drafts (${m.n} games): median ${m.medWaves} waves cleared, ${m.wins}/${m.n} reached wave 20`);
  console.log('  damage per tower per wave (relative to best):');
  for (const r of m.rows) console.log(`  ${pad(ITEMS[r.type].name, 9)}${lpad(Math.round(r.perSlot), 7)}  ${'█'.repeat(Math.round(r.rel * 30))} ${Math.round(r.rel * 100)}%`);
  console.log('Team value: swap 2 of an all-Blaster team\'s towers for this one (avg waves gained):');
  console.log('  ' + marginalTable(wpm, acc).map(r => `${ITEMS[r.type].name} ${r.gain >= 0 ? '+' : ''}${r.gain.toFixed(1)}`).join(' · '));
  console.log('');
}
