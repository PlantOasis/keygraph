// Per-key and per-transition (graph edge) statistics, persisted in localStorage.
const STORE = 'keygraph.v1';

// Gaps longer than this are treated as pauses, not as typing speed.
export const PAUSE_MS = 1500;
export const msToWpm = ms => (ms > 0 ? 12000 / ms : 0); // 5 chars per word
export const wpmToMs = wpm => 12000 / wpm;

// A press right after one of these starts a new word. That delay is mostly reading/planning
// the next word, so it is tracked separately instead of counting against the key's finger speed.
export const WORD_BOUNDARY = new Set(['Space', 'Enter', 'Tab']);
export const isWordStart = from => !!from && WORD_BOUNDARY.has(from);

// A lesson only becomes a point on a key's speed graph with at least this many timed presses.
const MIN_HIST_SAMPLES = 3;

// Local calendar day, e.g. "2026-10-10".
export function dayKey(t = Date.now()) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const defaults = () => ({
  version: 3,
  keys: {},   // code -> { n, ema, hits, misses, best, hist[], wrong{}, ws: { n, ema } (as first letter of a word) }
  edges: {},  // key sequence: "prev>next" -> { n, ema, hits, misses }
  fedges: {}, // finger travel: "where that finger was>key pressed" -> same shape
  lessons: [],
  wordStart: { n: 0, ema: 0 }, // all first-letter-of-word presses
  inWord: { n: 0, ema: 0 },    // all other timed presses
  daily: {},                   // "YYYY-MM-DD" -> ms of active typing that day
  settings: {
    targetWpm: 35, unlocked: 6, focusOverride: null, dailyGoalMin: 30,
    mode: 'learn', edgeMode: 'in', colorMode: 'speed', graph: 'finger',
  },
});

// Running mean for the first 10 samples, then an exponential moving average.
function addSample(o, ms) {
  o.n++;
  o.ema += (ms - o.ema) / (o.n <= 10 ? o.n : 10);
}

export function learningRate(hist, window = 10) {
  const ys = hist.slice(-window);
  if (ys.length < 3) return NaN;
  const n = ys.length, mx = (n - 1) / 2, my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  ys.forEach((y, x) => { num += (x - mx) * (y - my); den += (x - mx) ** 2; });
  return num / den;
}

export class Stats {
  constructor() {
    this.data = this.load();
    this.migrate();
  }

  migrate() {
    const d = this.data;
    if (d.version >= 3) return;
    // v1 → v2: graph points used to be recorded from a single press, producing spikes like 600 wpm.
    // Drop points far above that key's typical lesson speed.
    if (d.version < 2) {
      for (const k of Object.values(d.keys)) {
        if (!k.hist?.length) continue;
        const sorted = [...k.hist].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        k.hist = k.hist.filter(w => w <= median * 2.5);
        k.best = k.hist.length ? Math.max(...k.hist) : 0;
      }
    }
    // v2 → v3: daily practice log, backfilled from lesson timestamps.
    d.daily = {};
    for (const l of d.lessons) d.daily[dayKey(l.t)] = (d.daily[dayKey(l.t)] || 0) + l.ms;
    d.version = 3;
    this.save();
  }

  addPractice(ms, t = Date.now()) {
    if (!(ms > 0)) return;
    const k = dayKey(t);
    this.data.daily[k] = (this.data.daily[k] || 0) + ms;
    this.save();
  }

  load() {
    try {
      const raw = localStorage.getItem(STORE);
      if (raw) {
        const d = JSON.parse(raw), base = defaults();
        return { ...base, ...d, settings: { ...base.settings, ...d.settings } };
      }
    } catch { /* fall through to defaults */ }
    return defaults();
  }

  save() {
    clearTimeout(this._t);
    this._t = setTimeout(() => this.flush(), 300);
  }

  // Write immediately; called when the tab is hidden or closed so nothing pending is lost.
  flush() {
    clearTimeout(this._t);
    try { localStorage.setItem(STORE, JSON.stringify(this.data)); } catch { /* storage unavailable */ }
  }

  get settings() { return this.data.settings; }

  key(code) {
    return (this.data.keys[code] ??= { n: 0, ema: 0, hits: 0, misses: 0, best: 0, hist: [], wrong: {} });
  }
  peekKey(code) { return this.data.keys[code]; }

  edge(from, to, store = 'edges') {
    return (this.data[store][`${from}>${to}`] ??= { n: 0, ema: 0, hits: 0, misses: 0 });
  }
  peekEdge(from, to, store = 'edges') { return this.data[store][`${from}>${to}`]; }

  // A correct press of `to`, reached from `from` (previous key, null at the start of a run)
  // after `ms`; `fingerFrom` is where the pressing finger was before moving.
  hit(from, to, ms, fingerFrom = null) {
    const timed = ms != null && ms < PAUSE_MS;
    const start = isWordStart(from);
    const k = this.key(to);
    k.hits++;
    if (timed) {
      if (start) {
        addSample((k.ws ??= { n: 0, ema: 0 }), ms);
        addSample(this.data.wordStart, ms);
      } else {
        addSample(k, ms);
        addSample(this.data.inWord, ms);
      }
    }
    // The previous-key edge (e.g. Space→A) keeps its timing so word starts stay visible in the
    // sequence graph; the finger-travel edge doesn't, since that time isn't finger movement.
    if (from) {
      const e = this.edge(from, to);
      e.hits++;
      if (timed) addSample(e, ms);
    }
    if (fingerFrom) {
      const e = this.edge(fingerFrom, to, 'fedges');
      e.hits++;
      if (timed && !start) addSample(e, ms);
    }
    this.save();
  }

  miss(from, to, wrongCode, fingerFrom = null) {
    const k = this.key(to);
    k.misses++;
    if (wrongCode && wrongCode !== to) k.wrong[wrongCode] = (k.wrong[wrongCode] || 0) + 1;
    for (const e of this._edges(from, to, fingerFrom)) e.misses++;
    this.save();
  }

  // Free-type mode: a Backspace turns the previous press into a miss.
  retract(from, to, fingerFrom = null) {
    const k = this.key(to);
    k.hits = Math.max(0, k.hits - 1);
    k.misses++;
    for (const e of this._edges(from, to, fingerFrom)) {
      e.hits = Math.max(0, e.hits - 1);
      e.misses++;
    }
    this.save();
  }

  _edges(from, to, fingerFrom) {
    const out = [];
    if (from) out.push(this.edge(from, to));
    if (fingerFrom) out.push(this.edge(fingerFrom, to, 'fedges'));
    return out;
  }

  endLesson({ wpm, acc, ms, perKey }) {
    const d = this.data;
    d.lessons.push({ t: Date.now(), wpm: +wpm.toFixed(1), acc: +acc.toFixed(4), ms: Math.round(ms) });
    if (d.lessons.length > 1000) d.lessons.shift();
    this.addPractice(ms);
    this.pushHistory(perKey);
  }

  // One point per key on its speed-over-time graph: { code: { sum (ms), n } }.
  pushHistory(perKey) {
    for (const [code, { sum, n }] of Object.entries(perKey)) {
      if (n < MIN_HIST_SAMPLES) continue;
      const k = this.key(code), w = msToWpm(sum / n);
      k.hist.push(+w.toFixed(1));
      if (k.hist.length > 300) k.hist.shift();
      k.best = Math.max(k.best, w);
    }
    this.save();
  }

  allEdges(store = 'edges') {
    return Object.entries(this.data[store]).map(([id, e]) => {
      const [from, to] = id.split('>');
      return { from, to, ...e };
    });
  }
  edgesTo(code, store) { return this.allEdges(store).filter(e => e.to === code); }
  edgesFrom(code, store) { return this.allEdges(store).filter(e => e.from === code); }

  reset() {
    const keep = { targetWpm: this.settings.targetWpm, mode: this.settings.mode, dailyGoalMin: this.settings.dailyGoalMin };
    const daily = this.data.daily; // the practice calendar survives a stats reset
    this.data = defaults();
    Object.assign(this.data.settings, keep);
    this.data.daily = daily;
    this.save();
  }

  exportJSON() { return JSON.stringify(this.data, null, 1); }
  importJSON(text) {
    const d = JSON.parse(text);
    if (!d || typeof d.keys !== 'object' || typeof d.edges !== 'object') throw new Error('Not a KeyGraph export');
    const base = defaults();
    this.data = { ...base, ...d, settings: { ...base.settings, ...d.settings } };
    this.migrate();
    this.save();
  }
}
