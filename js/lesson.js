// keybr-style progression: unlock letters in order, focus the weakest one, and
// build lessons from words weighted toward weak keys AND weak key-to-key transitions.
import { WORDS } from './words.js';
import { LETTER_ORDER, KEY_BY_CODE, HOME_KEYS, charToCode } from './layout.js';
import { msToWpm, wpmToMs } from './stats.js';

const LESSON_CHARS = 90;
const MIN_REAL_WORDS = 25;

function weightedPick(items, weights) {
  let total = 0;
  for (const w of weights) total += w;
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

// Letter-to-letter probabilities ('^' = word start, '$' = word end) learned from the word list.
const MARKOV = (() => {
  const counts = {};
  for (const w of WORDS) {
    const s = '^' + w + '$';
    for (let i = 0; i < s.length - 1; i++) {
      const row = (counts[s[i]] ??= {});
      row[s[i + 1]] = (row[s[i + 1]] || 0) + 1;
    }
  }
  for (const row of Object.values(counts)) {
    const total = Object.values(row).reduce((a, b) => a + b, 0);
    for (const k in row) row[k] /= total;
  }
  return counts;
})();

export class Lesson {
  constructor(stats) {
    this.stats = stats;
  }

  get target() { return this.stats.settings.targetWpm; }

  included() { return LETTER_ORDER.slice(0, this.stats.settings.unlocked); }

  // Key speed as a fraction of the target; 0 until there are enough samples.
  confidence(ch) {
    const k = this.stats.peekKey(charToCode(ch));
    if (!k || k.n < 3 || !k.ema) return 0;
    return msToWpm(k.ema) / this.target;
  }

  ready(ch) {
    const k = this.stats.peekKey(charToCode(ch));
    return !!k && k.n >= 10 && this.confidence(ch) >= 1;
  }

  focus() {
    const inc = this.included();
    const o = this.stats.settings.focusOverride;
    if (o && inc.includes(o)) return o;
    let best = inc[inc.length - 1], bestC = Infinity;
    for (let i = inc.length - 1; i >= 0; i--) {
      const c = this.confidence(inc[i]);
      if (c < bestC) { bestC = c; best = inc[i]; }
    }
    return best;
  }

  maybeUnlock() {
    const s = this.stats.settings;
    if (s.unlocked >= LETTER_ORDER.length) return null;
    if (!this.included().every(ch => this.ready(ch))) return null;
    s.unlocked++;
    this.stats.save();
    return LETTER_ORDER[s.unlocked - 1];
  }

  letterWeakness(ch) {
    return 1 / Math.max(0.2, Math.min(1.2, this.confidence(ch) || 0.2));
  }

  // >1 means this transition is slow or error-prone; unknown transitions get a mild 1.2 to encourage exploring them.
  // store: 'edges' (previous key → key) or 'fedges' (where the finger was → key).
  edgeWeakness(fromCode, toCode, store = 'edges') {
    const e = this.stats.peekEdge(fromCode, toCode, store);
    if (!e || e.n < 3) return 1.2;
    const slow = Math.min(4, Math.max(0.3, e.ema / wpmToMs(this.target)));
    const err = e.misses / Math.max(1, e.hits + e.misses);
    return slow * (1 + 4 * err);
  }

  wordWeight(w, focus) {
    const fingers = [...HOME_KEYS];
    let letters = 0, seq = 0, travel = 0, focusCount = 0;
    for (let i = 0; i < w.length; i++) {
      const code = charToCode(w[i]), f = KEY_BY_CODE[code].finger;
      letters += this.letterWeakness(w[i]);
      if (i) seq += this.edgeWeakness(charToCode(w[i - 1]), code);
      travel += this.edgeWeakness(fingers[f], code, 'fedges');
      fingers[f] = code;
      if (w[i] === focus) focusCount++;
    }
    const score = letters / w.length + seq / (w.length - 1) + 1.5 * (travel / w.length);
    return (score * (1 + focusCount)) ** 2;
  }

  pseudoWord(letters, focus) {
    for (let attempt = 0; attempt < 80; attempt++) {
      let w = '', prev = '^';
      const fingers = [...HOME_KEYS];
      const maxLen = 3 + Math.floor(Math.random() * 5);
      while (w.length < 10) {
        const row = MARKOV[prev] || {};
        const opts = [], ws = [];
        for (const c of letters) {
          if (w.length >= 2 && w.at(-1) === c && w.at(-2) === c) continue;
          const code = charToCode(c);
          let p = (row[c] || 0) + 0.01;
          if (c === focus) p *= 1.6;
          if (prev !== '^') p *= this.edgeWeakness(charToCode(prev), code);
          p *= this.edgeWeakness(fingers[KEY_BY_CODE[code].finger], code, 'fedges');
          opts.push(c); ws.push(p);
        }
        if (w.length >= 2) {
          opts.push('$');
          ws.push(((row.$ || 0) + 0.01) * (w.length >= maxLen ? 30 : 0.4));
        }
        const c = weightedPick(opts, ws);
        if (c === '$') break;
        w += c;
        prev = c;
        const code = charToCode(c);
        fingers[KEY_BY_CODE[code].finger] = code;
      }
      if (w.length >= 2 && w.includes(focus)) return w;
    }
    return focus + letters[Math.floor(Math.random() * letters.length)] + focus;
  }

  generate() {
    const inc = this.included(), allowed = new Set(inc), focus = this.focus();
    const pool = WORDS.filter(w => w.includes(focus) && [...w].every(c => allowed.has(c)));
    const weights = pool.map(w => this.wordWeight(w, focus));
    const useReal = pool.length >= MIN_REAL_WORDS;
    const words = [];
    let len = 0;
    for (let guard = 0; len < LESSON_CHARS && guard < 500; guard++) {
      const w = useReal && Math.random() < 0.9 ? weightedPick(pool, weights) : this.pseudoWord(inc, focus);
      if (words.at(-1) === w) continue;
      words.push(w);
      len += w.length + 1;
    }
    return words.join(' ');
  }
}
