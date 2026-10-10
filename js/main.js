import {
  KEYS, KEY_BY_CODE, LETTER_ORDER, FINGER_NAMES, ROW_NAMES,
  charToCode, codeToChar, keyLabel, relationTags, transitionKind, KIND_LABEL,
  FingerTracker, travelTags, travelBucket,
} from './layout.js';
import { Stats, msToWpm, PAUSE_MS, learningRate, isWordStart, dayKey } from './stats.js';
import { Lesson } from './lesson.js';
import { Keyboard3D } from './keyboard3d.js';
import { ratioHSL, ratioCss, hslCss, FINGER_HSL, LOCKED_HSL, NEUTRAL_HSL } from './colors.js';

const $ = s => document.querySelector(s);
const stats = new Stats();
const lesson = new Lesson(stats);
const S = () => stats.settings;
const MIN_N = 5; // samples before a transition is trusted for diagnosis
const fingers = new FingerTracker();

// Which graph the views show: finger travel (where the pressing finger came from) or key sequence (previous key).
const isFinger = () => S().graph === 'finger';
const G = () => (isFinger() ? 'fedges' : 'edges');

let selected = null;

const kb = new Keyboard3D($('#kb'), { onSelect: code => select(code), onHover: hover });

// ---------- helpers

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmt = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '–');
const pct = x => (Number.isFinite(x) ? (x * 100).toFixed(1) + '%' : '–');
const accOf = o => (o && o.hits + o.misses ? o.hits / (o.hits + o.misses) : NaN);
const wpmOf = o => (o && o.n && o.ema > 0 ? msToWpm(o.ema) : NaN);
const ratioOf = o => {
  const w = wpmOf(o);
  return Number.isFinite(w) ? w / S().targetWpm : null;
};
const isLetter = code => /^Key[A-Z]$/.test(code);
const isLocked = code => S().mode === 'learn' && isLetter(code) && !lesson.included().includes(codeToChar(code));
const chip = code => `<span class="chip" data-code="${code}">${esc(keyLabel(code))}</span>`;
const tags = (from, to) => (isFinger() ? travelTags : relationTags)(from, to).map(t => `<span class="tag ${t.cls}">${t.text}</span>`).join('');

function keyHSL(code) {
  if (S().colorMode === 'finger') return FINGER_HSL[KEY_BY_CODE[code].finger];
  if (isLocked(code)) return LOCKED_HSL;
  const k = stats.peekKey(code);
  return k && k.n >= 3 ? ratioHSL(ratioOf(k)) : NEUTRAL_HSL;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 3500);
}

// ---------- learn mode typing

let text = '', pos = 0, errs = [], spans = [], active = false;
let startT = 0, lastT = 0, lessonHits = 0, lessonMisses = 0, lessonKeys = {};

function newLesson() {
  text = lesson.generate();
  pos = 0;
  errs = new Array(text.length).fill(false);
  lessonHits = lessonMisses = 0;
  lessonKeys = {};
  renderText();
}

function renderText() {
  const el = $('#text');
  el.textContent = '';
  spans = [];
  let word = document.createElement('span');
  word.className = 'word';
  for (let i = 0; i < text.length; i++) {
    const s = document.createElement('span');
    const sp = text[i] === ' ';
    s.className = 'ch' + (sp ? ' sp' : '');
    s.textContent = sp ? '·' : text[i];
    word.appendChild(s);
    spans.push(s);
    if (sp) {
      el.appendChild(word);
      word = document.createElement('span');
      word.className = 'word';
    }
  }
  el.appendChild(word);
  spans[0]?.classList.add('cur');
}

function setActive(on) {
  active = on;
  $('#textWrap').classList.toggle('active', on);
  if (on) document.activeElement?.blur?.();
}

function typeChar(ch, physCode, t) {
  const expected = text[pos];
  const to = charToCode(expected);
  const from = pos > 0 ? charToCode(text[pos - 1]) : null;
  const fingerFrom = fingers.from(to, t);

  if (ch !== expected) {
    if (!errs[pos]) {
      errs[pos] = true;
      lessonMisses++;
      stats.miss(from, to, physCode, fingerFrom);
    }
    spans[pos].classList.add('err');
    kb.flashError(physCode);
    return;
  }

  if (pos === 0) startT = t;
  const ms = pos > 0 ? t - lastT : null;
  if (!errs[pos]) {
    stats.hit(from, to, ms, fingerFrom);
    lessonHits++;
    if (ms != null && ms < PAUSE_MS && !isWordStart(from)) {
      const lk = (lessonKeys[to] ??= { sum: 0, n: 0 });
      lk.sum += ms;
      lk.n++;
    }
  }
  const arcFrom = isFinger() ? fingerFrom : from;
  if (arcFrom && ms != null && ms < PAUSE_MS) kb.flashArc(arcFrom, to, ratioHSL(msToWpm(ms) / S().targetWpm));
  kb.setKeyColor(to, keyHSL(to));
  fingers.press(to, t);
  lastT = t;

  spans[pos].classList.remove('cur');
  spans[pos].classList.add('done');
  pos++;
  if (pos >= text.length) return finishLesson(t);
  spans[pos].classList.add('cur');
}

function finishLesson(t) {
  const elapsed = t - startT;
  const wpm = elapsed > 0 ? (text.length - 1) / 5 / (elapsed / 60000) : 0;
  const acc = lessonHits / Math.max(1, lessonHits + lessonMisses);
  const before = todayMinutes();
  stats.endLesson({ wpm, acc, ms: elapsed, perKey: lessonKeys });
  checkGoalReached(before);
  const unlocked = lesson.maybeUnlock();
  if (unlocked) toast(`New key unlocked: ${unlocked.toUpperCase()}. All earlier keys reached ${S().targetWpm} wpm.`);
  newLesson();
  refreshAll();
}

// ---------- free type mode: every physical key is a node

let freePrev = null, freeLastT = 0, freeLastEdge = null, freeCount = 0, freeKeys = {};
const FREE_CHUNK = 100; // free typing has no lessons, so every 100 keys becomes one graph point

function flushFreeHistory() {
  if (Object.keys(freeKeys).length) stats.pushHistory(freeKeys);
  freeKeys = {};
}

function freeKey(e) {
  const code = e.code;
  if (!KEY_BY_CODE[code]) return;
  const t = e.timeStamp;
  const gap = freePrev ? t - freeLastT : Infinity;
  const from = gap < PAUSE_MS ? freePrev : null;
  const fingerFrom = fingers.from(code, t);

  if (code === 'Backspace' && freeLastEdge && freeLastEdge.to !== 'Backspace') {
    stats.retract(freeLastEdge.from, freeLastEdge.to, freeLastEdge.fingerFrom);
    kb.setKeyColor(freeLastEdge.to, keyHSL(freeLastEdge.to));
  }
  stats.hit(from, code, from ? gap : null, fingerFrom);
  fingers.press(code, t);
  if (from) {
    const before = todayMinutes();
    stats.addPractice(gap);
    checkGoalReached(before);
    renderDaily();
  }
  if (from) {
    kb.flashArc(isFinger() ? fingerFrom : from, code, ratioHSL(msToWpm(gap) / S().targetWpm));
    if (!isWordStart(from)) {
      const fk = (freeKeys[code] ??= { sum: 0, n: 0 });
      fk.sum += gap;
      fk.n++;
    }
  }
  kb.setKeyColor(code, keyHSL(code));
  freeLastEdge = { from, to: code, fingerFrom };
  freePrev = code;
  freeLastT = t;
  freeCount++;
  if (freeCount % FREE_CHUNK === 0) flushFreeHistory();
  if (freeCount % 25 === 0) refreshAll();
  else renderSummary();
}

// ---------- keyboard input

window.addEventListener('keydown', e => {
  const tgt = e.target;
  if (tgt.id === 'target' || tgt.id === 'goalInput' || tgt.tagName === 'SELECT') return;
  if (e.repeat) return;
  kb.press(e.code);

  if (S().mode === 'free') {
    if (tgt.id === 'freeText') freeKey(e);
    return;
  }
  if (!active) {
    if (e.key === 'Enter') { e.preventDefault(); setActive(true); }
    return;
  }
  if (e.key === 'Escape') return setActive(false);
  if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
  e.preventDefault();
  typeChar(e.key, e.code, e.timeStamp);
});

// Clicking anywhere except the text and the 3D keyboard pauses, like keybr.
document.addEventListener('pointerdown', e => {
  if (S().mode !== 'learn') return;
  if (e.target.closest('#textWrap')) setActive(true);
  else if (!e.target.closest('.kb-wrap')) setActive(false);
});
document.addEventListener('click', e => e.target.closest('button')?.blur());

// ---------- selection + 3D graph

function focusCode() { return charToCode(lesson.focus()); }

function select(code) {
  selected = code;
  kb.setSelected(code);
  renderInspector();
  renderEdges();
  renderKeyStrip();
}

// relative=true colors by how this transition compares with the destination key's own
// average (green = normal, red = much slower than usual), which is what exposes a "bad approach" key.
function edgeVisual(e, relative) {
  const dest = stats.peekKey(e.to);
  const r = relative ? (dest?.ema && e.ema ? dest.ema / e.ema : null) : ratioOf(e);
  return {
    from: e.from, to: e.to,
    hsl: ratioHSL(r),
    width: 0.014 + 0.032 * Math.min(1, Math.log(e.n + 1) / Math.log(60)),
    opacity: 0.3 + 0.6 * Math.min(1, e.n / 15),
  };
}

function renderEdges() {
  const mode = S().edgeMode, code = selected;
  let list = [];
  if (mode === 'in' || mode === 'both') list.push(...stats.edgesTo(code, G()));
  if (mode === 'out' || mode === 'both') list.push(...stats.edgesFrom(code, G()).filter(e => mode === 'out' || e.to !== code));
  if (mode === 'in' || mode === 'out' || mode === 'both') {
    list = list.filter(e => e.n > 0).sort((a, b) => b.n - a.n).slice(0, 40);
  }
  if (mode === 'weak' || mode === 'strong') {
    // Word starts are a reading pause, measured separately, and would crowd out every finger problem.
    list = stats.allEdges(G()).filter(e => e.n >= MIN_N && e.ema > 0 && !isWordStart(e.from))
      .sort((a, b) => (mode === 'weak' ? b.ema - a.ema : a.ema - b.ema)).slice(0, 20);
  }
  const relative = mode === 'in' || mode === 'out' || mode === 'both';
  kb.setEdges(list.map(e => edgeVisual(e, relative)));
  $('#legendRight').textContent = relative ? "the key's usual speed" : 'target speed';
}

function paintKeys() {
  for (const k of KEYS) kb.setKeyColor(k.code, keyHSL(k.code));
  kb.setFocus(S().mode === 'learn' ? focusCode() : null);
}

// Least-squares line through (i, ys[i]).
function trend(ys) {
  const n = ys.length, mx = (n - 1) / 2, my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  ys.forEach((y, x) => { num += (x - mx) * (y - my); den += (x - mx) ** 2; });
  const slope = den ? num / den : 0;
  return { slope, at: x => my + slope * (x - mx) };
}

function drawHistory(cv, hist) {
  const W = 260, H = 110, dpr = devicePixelRatio || 1;
  cv.width = W * dpr;
  cv.height = H * dpr;
  cv.style.width = W + 'px';
  cv.style.height = H + 'px';
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  const pad = { l: 30, r: 8, t: 8, b: 16 };
  const target = S().targetWpm;
  const lo = Math.max(0, Math.floor(Math.min(...hist, target) / 10) * 10 - 10);
  const hi = Math.ceil(Math.max(...hist, target) / 10) * 10 + 10;
  const X = i => pad.l + (hist.length === 1 ? 0.5 : i / (hist.length - 1)) * (W - pad.l - pad.r);
  const Y = v => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);

  g.font = '10px ui-monospace, monospace';
  g.fillStyle = '#777';
  g.textAlign = 'right';
  g.textBaseline = 'middle';
  for (const v of [lo, (lo + hi) / 2, hi]) {
    g.fillText(Math.round(v), pad.l - 5, Y(v));
    g.strokeStyle = '#333';
    g.beginPath(); g.moveTo(pad.l, Y(v)); g.lineTo(W - pad.r, Y(v)); g.stroke();
  }
  g.textAlign = 'left';
  g.fillText(`${hist.length} sessions`, pad.l, H - 6);

  // target speed
  g.setLineDash([3, 3]);
  g.strokeStyle = '#888';
  g.beginPath(); g.moveTo(pad.l, Y(target)); g.lineTo(W - pad.r, Y(target)); g.stroke();
  g.setLineDash([]);

  // speed line + points
  g.strokeStyle = '#9ac79a';
  g.lineWidth = 1.5;
  g.beginPath();
  hist.forEach((v, i) => (i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v))));
  g.stroke();
  hist.forEach((v, i) => {
    g.fillStyle = ratioCss(v / target);
    g.beginPath(); g.arc(X(i), Y(v), 2.2, 0, Math.PI * 2); g.fill();
  });

  // trend line
  if (hist.length >= 2) {
    const tr = trend(hist);
    g.strokeStyle = tr.slope >= 0 ? '#e6d36a' : '#e07a62';
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(X(0), Y(tr.at(0))); g.lineTo(X(hist.length - 1), Y(tr.at(hist.length - 1))); g.stroke();
  }
}

let tipCode = null;
function hover(code, x, y) {
  const tip = $('#tooltip');
  if (!code) { tip.style.display = 'none'; tipCode = null; return; }
  if (code !== tipCode) {
    tipCode = code;
    const k = stats.peekKey(code);
    const info = KEY_BY_CODE[code];
    const hist = k?.hist ?? [];
    const tr = hist.length >= 2 ? trend(hist) : null;
    tip.innerHTML = `<b>${esc(keyLabel(code))}</b> · ${FINGER_NAMES[info.finger]}${isLocked(code) ? ' · <span class="muted">locked</span>' : ''}<br>` +
      (k && k.n ? `${fmt(wpmOf(k))} wpm now · ${pct(accOf(k))} acc · ${k.n} samples` : '<span class="muted">no data yet</span>') +
      (hist.length
        ? `<canvas class="tipchart"></canvas><div class="tiplegend"><span class="sw line"></span>speed <span class="sw trend"></span>trend ` +
          `<b class="${tr && tr.slope < 0 ? 'down' : 'up'}">${tr ? (tr.slope >= 0 ? '+' : '') + tr.slope.toFixed(2) + ' wpm/session' : ''}</b> <span class="sw tgt"></span>target</div>`
        : k && k.n ? '<div class="muted">Graph appears after a finished lesson.</div>' : '');
    const cv = tip.querySelector('canvas');
    if (cv) drawHistory(cv, hist);
    tip.style.display = 'block';
  }
  // keep the tooltip on screen
  const r = tip.getBoundingClientRect();
  tip.style.left = Math.min(x + 14, innerWidth - r.width - 8) + 'px';
  tip.style.top = (y + 14 + r.height > innerHeight ? y - r.height - 10 : y + 14) + 'px';
}

// Same hover chart for key chips outside the 3D view (key strip, tables).
document.addEventListener('mouseover', e => {
  const c = e.target.closest('[data-code]');
  if (c && !e.target.closest('#kb')) hover(c.dataset.code, e.clientX, e.clientY);
});
document.addEventListener('mouseout', e => {
  const c = e.target.closest('[data-code]');
  if (c && !c.contains(e.relatedTarget)) hover(null);
});

// ---------- metrics bar

function renderSummary() {
  const L = stats.data.lessons, last = L.at(-1);
  const prev = L.slice(-11, -1);
  const avg = f => (prev.length ? prev.reduce((a, l) => a + f(l), 0) / prev.length : NaN);
  const delta = (v, base, d, unit) => {
    if (!Number.isFinite(base)) return '';
    const x = v - base;
    return ` (<span class="${x >= 0 ? 'up' : 'down'}">${x >= 0 ? '↑+' : '↓'}${x.toFixed(d)}${unit}</span>)`;
  };
  const totalMin = L.reduce((a, l) => a + l.ms, 0) / 60000;
  const edgeCount = Object.keys(stats.data[G()]).length;
  let html = last
    ? `<b>Speed:</b> ${fmt(last.wpm)}wpm${delta(last.wpm, avg(l => l.wpm), 1, 'wpm')} &nbsp;
       <b>Accuracy:</b> ${pct(last.acc)}${delta(last.acc * 100, avg(l => l.acc * 100), 2, '%')} &nbsp;`
    : '<b>Speed:</b> – &nbsp; <b>Accuracy:</b> – &nbsp;';
  const ws = stats.data.wordStart, iw = stats.data.inWord;
  if (ws?.n >= 10 && iw?.n >= 10) {
    html += `<b>Word start:</b> <span title="Average time to type the first letter of a word, compared with letters inside words">${fmt(ws.ema, 0)}ms vs ${fmt(iw.ema, 0)}ms in-word</span> &nbsp; `;
  }
  html += `<b>Lessons:</b> ${L.length} &nbsp; <b>Time:</b> ${fmt(totalMin, 0)}min &nbsp; <b>${isFinger() ? 'Finger moves' : 'Transitions'}:</b> ${edgeCount}`;
  if (S().mode === 'free') html += ` &nbsp; <b>This session:</b> ${freeCount} keys`;
  $('#mSummary').innerHTML = html;
}

function renderKeyStrip() {
  const inc = lesson.included(), focus = lesson.focus();
  $('#mKeys').innerHTML = LETTER_ORDER.map(ch => {
    const code = charToCode(ch), locked = !inc.includes(ch);
    const k = stats.peekKey(code);
    const bg = !locked && k && k.n >= 3 ? `style="background:${ratioCss(ratioOf(k))}"` : '';
    const cls = ['kchip', locked && 'locked', ch === focus && 'focus', code === selected && 'sel'].filter(Boolean).join(' ');
    return `<span class="${cls}" data-code="${code}" ${bg} title="${locked ? 'locked' : ''}">${ch}</span>`;
  }).join('');
}

function renderCurrent() {
  const focus = lesson.focus(), code = charToCode(focus), k = stats.peekKey(code);
  const lr = k ? learningRate(k.hist) : NaN;
  const conf = lesson.confidence(focus);
  const override = S().focusOverride === focus;
  $('#mCurrent').innerHTML =
    `<span class="kchip big focus" data-code="${code}" style="background:${ratioCss(ratioOf(k))}">${focus}</span>` +
    `<b>Last speed:</b> ${fmt(k?.hist.at(-1))}wpm &nbsp; <b>Top speed:</b> ${fmt(k?.best || NaN)}wpm &nbsp; ` +
    `<b>Learning rate:</b> <span class="${lr >= 0 ? 'up' : 'down'}">${Number.isFinite(lr) ? (lr >= 0 ? '+' : '') + lr.toFixed(1) + 'wpm/lesson' : '–'}</span> &nbsp; ` +
    `<b>Progress:</b> ${fmt(Math.min(conf, 1) * 100, 0)}% of target` +
    (override ? ' &nbsp; <span class="tag warn">pinned focus</span>' : '');
}

// ---------- inspector

function analyzeIncoming(code) {
  const k = stats.peekKey(code);
  const base = k?.ema, baseErr = 1 - accOf(k);
  // In finger mode "stayed on the same key" is a real movement; in sequence mode a double letter is noise.
  const rows = stats.edgesTo(code, G()).filter(e => isFinger() || e.from !== code).map(e => ({
    ...e,
    rel: base && e.ema ? e.ema / base : NaN,
    err: 1 - accOf(e),
  }));
  for (const r of rows) {
    r.problem = r.n >= MIN_N && !isWordStart(r.from) && (r.rel > 1.2 || r.err > (Number.isFinite(baseErr) ? baseErr : 0) * 1.5 + 0.03);
  }
  const problems = rows.filter(r => r.problem).sort((a, b) => (b.rel - 1) * b.n - (a.rel - 1) * a.n);
  return { rows, problems };
}

// Average slowdown relative to the destination key's own speed, grouped by hand movement
// (sequence graph) or by how far the finger travelled (finger graph).
function patternStats(filterTo = null) {
  const groups = {}, finger = isFinger();
  for (const e of stats.allEdges(G())) {
    if (e.n < 3 || !e.ema || (!finger && e.from === e.to)) continue;
    if (filterTo && e.to !== filterTo) continue;
    const k = stats.peekKey(e.to);
    if (!k?.ema) continue;
    const kind = finger ? travelBucket(e.from, e.to) : transitionKind(e.from, e.to);
    const g = (groups[kind] ??= { w: 0, rel: 0, ms: 0 });
    g.w += e.n;
    g.rel += e.n * (e.ema / k.ema);
    g.ms += e.n * e.ema;
  }
  const order = finger ? ['stay', 'near', 'far'] : ['alternate', 'same-hand', 'same-finger', 'thumb'];
  return order.filter(kd => groups[kd]).map(kd => ({
    kind: kd, n: groups[kd].w, rel: groups[kd].rel / groups[kd].w, ms: groups[kd].ms / groups[kd].w,
  }));
}

function barsHTML(items) {
  if (!items.length) return '<p class="muted">Not enough data yet (each transition needs a few samples).</p>';
  const maxMs = Math.max(...items.map(i => i.ms));
  return `<div class="bars">${items.map(i => `
    <div class="bar"><span>${KIND_LABEL[i.kind]}</span>
      <div class="track"><div class="fill" style="width:${(i.ms / maxMs) * 100}%;background:${ratioCss(msToWpm(i.ms) / S().targetWpm)}"></div></div>
      <span class="num">${fmt(i.ms, 0)}ms · ${i.rel >= 1 ? '+' : ''}${fmt((i.rel - 1) * 100, 0)}%</span></div>`).join('')}</div>`;
}

function edgeTable(rows, dir, code) {
  if (!rows.length) return '<p class="muted">No transitions recorded yet.</p>';
  const other = dir === 'in' ? 'From' : 'To';
  return `<table class="edges"><thead><tr><th>${other}</th><th class="num">ms</th><th class="num">wpm</th><th class="num">vs key</th><th class="num">acc</th><th class="num">n</th><th>move</th></tr></thead><tbody>${
    rows.map(r => {
      const o = dir === 'in' ? r.from : r.to;
      const rel = Number.isFinite(r.rel) ? `${r.rel >= 1 ? '+' : ''}${fmt((r.rel - 1) * 100, 0)}%` : '–';
      return `<tr class="${r.problem ? 'problem' : ''}"><td>${chip(o)}</td>
        <td class="num">${r.ema ? fmt(r.ema, 0) : '–'}</td>
        <td class="num" style="color:${ratioCss(ratioOf(r))}">${fmt(wpmOf(r), 0)}</td>
        <td class="num">${rel}</td><td class="num">${pct(accOf(r))}</td><td class="num">${r.n}</td>
        <td>${dir === 'in' ? tags(o, code) : tags(code, o)}</td></tr>`;
    }).join('')}</tbody></table>`;
}

function renderInspector() {
  const code = selected, info = KEY_BY_CODE[code], k = stats.peekKey(code);
  const ch = codeToChar(code);
  const { rows, problems } = analyzeIncoming(code);
  const incoming = rows.sort((a, b) => (b.ema || 0) - (a.ema || 0)).slice(0, 14);
  const outgoing = stats.edgesFrom(code, G()).filter(e => isFinger() || e.to !== code).map(e => {
    const dest = stats.peekKey(e.to);
    return { ...e, rel: dest?.ema && e.ema ? e.ema / dest.ema : NaN };
  }).sort((a, b) => (b.ema || 0) - (a.ema || 0)).slice(0, 10);
  const lr = k ? learningRate(k.hist) : NaN;
  const wrong = k ? Object.entries(k.wrong).sort((a, b) => b[1] - a[1]).slice(0, 6) : [];
  const included = ch && lesson.included().includes(ch);
  const pinned = S().focusOverride === ch;

  const L = esc(keyLabel(code)), fname = FINGER_NAMES[info.finger].toLowerCase();
  const T = isFinger() ? {
    none: `Your ${fname} reaches ${L} at about the same speed from every starting key.`,
    head: `${L} gets slower or less accurate when your ${fname} has to come from:`,
    bars: `Into ${L} by finger travel`,
    inTitle: `Finger travel → ${L}`,
    inNote: `Where your ${fname} was right before pressing ${L}. “from home” includes the finger resting there.`,
    outTitle: `${L} → where that finger goes next`,
    whole: 'Whole keyboard by finger travel',
    wholeNote: 'Time to press a key compared with its own average, grouped by how far the finger had to move to get there.',
    matrix: 'Finger-travel matrix (letters + space)',
    matrixNote: 'Row = where the finger was, column = key pressed. Letters are grouped by finger, so only the blocks on the diagonal fill in.',
    weak: 'Weakest finger movements',
  } : {
    none: `No single previous key stands out. ${L} is about equally fast whichever key you come from.`,
    head: `${L} gets slower or less accurate when you come from:`,
    bars: `Into ${L} by hand movement`,
    inTitle: `Previous key → ${L}`,
    inNote: '',
    outTitle: `${L} → next key`,
    whole: 'Whole keyboard by hand movement',
    wholeNote: "Time to reach a key compared with that key's own average. A large “same finger” bar means your slow keys are mostly a hand-travel problem.",
    matrix: 'Transition matrix (letters + space)',
    matrixNote: 'Row = previous key, column = next key. Color = speed. Click a cell to inspect.',
    weak: 'Weakest transitions overall',
  };

  let diag;
  if (!k || k.n < MIN_N) {
    diag = `<p class="muted">Type more with this key. Diagnosis starts after ${MIN_N} samples per transition.</p>`;
  } else if (!problems.length) {
    diag = `<p>${T.none}</p>`;
  } else {
    diag = `<p>${T.head}</p><ul class="diag">${
      problems.slice(0, 5).map(p => `<li>${chip(p.from)} → ${chip(code)} &nbsp;
        <b>${p.rel >= 1 ? '+' : ''}${fmt((p.rel - 1) * 100, 0)}%</b> time, ${pct(p.err)} errors ${tags(p.from, code)}</li>`).join('')
    }</ul>`;
  }

  $('#inspector').innerHTML = `
    <div class="card">
      <div class="keyhead">
        <div class="bigcap" style="background:${hslCss(keyHSL(code))}">${esc(keyLabel(code))}</div>
        <div><div><b>${esc(code)}</b></div>
          <div class="sub">${FINGER_NAMES[info.finger]} · ${ROW_NAMES[info.row]}${isLocked(code) ? ' · locked' : ''}${ch === lesson.focus() && S().mode === 'learn' ? ' · current focus' : ''}</div></div>
      </div>
      <div class="statgrid">
        <div class="stat"><div class="k">Speed</div><div class="v" style="color:${ratioCss(ratioOf(k))}">${fmt(wpmOf(k))}</div></div>
        <div class="stat"><div class="k">Accuracy</div><div class="v">${pct(accOf(k))}</div></div>
        <div class="stat"><div class="k">Samples</div><div class="v">${k?.n ?? 0}</div></div>
        <div class="stat"><div class="k">Top speed</div><div class="v">${k?.best ? fmt(k.best) : '–'}</div></div>
        <div class="stat"><div class="k">Learn rate</div><div class="v">${Number.isFinite(lr) ? (lr >= 0 ? '+' : '') + fmt(lr) : '–'}</div></div>
        <div class="stat" title="Time to type this key as the first letter of a word. Not included in Speed."><div class="k">As 1st letter</div><div class="v">${k?.ws?.n ? fmt(k.ws.ema, 0) + 'ms' : '–'}</div></div>
        <div class="stat"><div class="k">In-word time</div><div class="v">${k?.ema ? fmt(k.ema, 0) + 'ms' : '–'}</div></div>
        <div class="stat"><div class="k">Misses</div><div class="v">${k?.misses ?? 0}</div></div>
      </div>
      ${isLetter(code) ? `<div class="btnrow">
        ${pinned ? '<button id="unpin">Stop pinning focus</button>'
          : `<button id="pin" class="primary" ${included ? '' : 'disabled'}>Practice this key</button>`}
        ${!included ? '<span class="muted" style="font-size:12px;align-self:center">Unlocks after earlier keys reach target</span>' : ''}
      </div>` : ''}
    </div>

    <div class="card"><h3>Diagnosis</h3>${diag}
      <h3 style="margin-top:14px">${T.bars}</h3>${barsHTML(patternStats(code))}
      ${wrong.length ? `<h3 style="margin-top:14px">Mistyped as</h3><p>${wrong.map(([c, n]) => `${chip(c)} ×${n}`).join(' &nbsp; ')}</p>` : ''}
    </div>

    <div class="card"><h3>${T.inTitle}</h3>${T.inNote ? `<p class="muted" style="font-size:12px">${T.inNote}</p>` : ''}${edgeTable(incoming, 'in', code)}</div>
    <div class="card"><h3>${T.outTitle}</h3>${edgeTable(outgoing, 'out', code)}</div>

    <div class="card"><h3>${T.whole}</h3>
      <p class="muted" style="font-size:12px">${T.wholeNote}</p>
      ${barsHTML(patternStats())}
    </div>

    <div class="card"><h3>${T.matrix}</h3>
      <p class="muted" style="font-size:12px">${T.matrixNote}</p>
      <div class="matrix-wrap"><canvas id="matrix"></canvas></div><div id="matrixInfo"></div>
    </div>

    <div class="card"><h3>${T.weak}</h3>${weakestList()}</div>`;

  $('#pin')?.addEventListener('click', () => { S().focusOverride = ch; stats.save(); newLesson(); refreshAll(); });
  $('#unpin')?.addEventListener('click', () => { S().focusOverride = null; stats.save(); newLesson(); refreshAll(); });
  drawMatrix();
}

function weakestList() {
  const list = stats.allEdges(G()).filter(e => e.n >= MIN_N && e.ema > 0 && !isWordStart(e.from)).sort((a, b) => b.ema - a.ema).slice(0, 10);
  if (!list.length) return `<p class="muted">Each transition needs at least ${MIN_N} samples to appear here.</p>`;
  return `<table class="edges"><tbody>${list.map(e => `<tr><td>${chip(e.from)} → ${chip(e.to)}</td>
    <td class="num" style="color:${ratioCss(ratioOf(e))}">${fmt(wpmOf(e), 0)}wpm</td><td class="num">${pct(accOf(e))}</td>
    <td class="num">n=${e.n}</td><td>${tags(e.from, e.to)}</td></tr>`).join('')}</tbody></table>`;
}

// Letters grouped by finger (left pinky → right pinky, then thumb) so finger blocks sit on the diagonal.
const MATRIX_GROUPS = ['qaz', 'wsx', 'edc', 'rfvtgb', 'yhnujm', 'ik', 'ol', 'p', ' '];
const MATRIX_SYMS = MATRIX_GROUPS.join('').split('');

function drawMatrix() {
  const cv = $('#matrix');
  if (!cv) return;
  const cell = 12, off = 16, n = MATRIX_SYMS.length, size = off + cell * n, dpr = devicePixelRatio || 1;
  cv.width = size * dpr;
  cv.height = size * dpr;
  cv.style.width = cv.style.height = size + 'px';
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  g.font = '10px ui-monospace, monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const selCh = codeToChar(selected);
  MATRIX_SYMS.forEach((c, i) => {
    const label = c === ' ' ? '␣' : c;
    g.fillStyle = c === selCh ? '#fff' : '#888';
    g.fillText(label, off + i * cell + cell / 2, off / 2);
    g.fillText(label, off / 2, off + i * cell + cell / 2);
  });
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const e = stats.peekEdge(charToCode(MATRIX_SYMS[i]), charToCode(MATRIX_SYMS[j]), G());
      g.fillStyle = e && e.ema > 0 ? ratioCss(ratioOf(e), 0.35 + 0.65 * Math.min(1, e.n / 10)) : '#2b2c2f';
      g.fillRect(off + j * cell, off + i * cell, cell - 1, cell - 1);
    }
  }
  g.strokeStyle = '#5a5b60';
  let edge = 0;
  for (const grp of MATRIX_GROUPS.slice(0, -1)) {
    edge += grp.length;
    const p = off + edge * cell - 0.5;
    g.beginPath(); g.moveTo(p, off); g.lineTo(p, size); g.moveTo(off, p); g.lineTo(size, p); g.stroke();
  }
  const si = MATRIX_SYMS.indexOf(selCh);
  if (si >= 0) {
    g.strokeStyle = 'rgba(255,255,255,0.7)';
    g.strokeRect(off - 0.5, off + si * cell - 0.5, cell * n, cell);
    g.strokeRect(off + si * cell - 0.5, off - 0.5, cell, cell * n);
  }
  const cellAt = ev => {
    const r = cv.getBoundingClientRect();
    const j = Math.floor((ev.clientX - r.left - off) / cell), i = Math.floor((ev.clientY - r.top - off) / cell);
    return i >= 0 && j >= 0 && i < n && j < n ? [MATRIX_SYMS[i], MATRIX_SYMS[j]] : null;
  };
  cv.onmousemove = ev => {
    const c = cellAt(ev);
    if (!c) { $('#matrixInfo').textContent = ''; return; }
    const [a, b] = c.map(x => (x === ' ' ? '␣' : x));
    const e = stats.peekEdge(charToCode(c[0]), charToCode(c[1]), G());
    $('#matrixInfo').textContent = e
      ? `${a} → ${b}: ${e.ema ? fmt(e.ema, 0) + 'ms · ' + fmt(wpmOf(e), 0) + 'wpm' : 'untimed'} · ${pct(accOf(e))} · n=${e.n}`
      : `${a} → ${b}: no data`;
  };
  cv.onclick = ev => {
    const c = cellAt(ev);
    if (c) select(charToCode(c[1]));
  };
}

// ---------- daily practice goal

const dayMinutes = key => (stats.data.daily[key] || 0) / 60000;
const todayMinutes = () => dayMinutes(dayKey());
const goalMin = () => S().dailyGoalMin;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

function checkGoalReached(before) {
  if (before < goalMin() && todayMinutes() >= goalMin()) toast(`Daily goal reached: ${goalMin()} minutes today. Nice work!`);
}

// Current streak counts back from today, or from yesterday if today's goal isn't met yet.
function streaks() {
  const met = d => dayMinutes(dayKey(d)) >= goalMin();
  let d = new Date(), current = 0;
  if (!met(d)) d = addDays(d, -1);
  while (met(d)) { current++; d = addDays(d, -1); }
  const days = Object.keys(stats.data.daily).sort();
  let best = 0, run = 0;
  if (days.length) {
    const [y, m, dd] = days[0].split('-').map(Number);
    for (let x = new Date(y, m - 1, dd); x <= new Date(); x = addDays(x, 1)) {
      run = met(x) ? run + 1 : 0;
      best = Math.max(best, run);
    }
  }
  return { current, best };
}

function renderDaily() {
  const m = todayMinutes(), goal = goalMin(), { current } = streaks();
  $('#dailyText').textContent = `${fmt(m, 1)}/${goal} minutes`;
  const fill = $('#dailyFill');
  fill.style.width = Math.min(100, (m / goal) * 100) + '%';
  fill.classList.toggle('done', m >= goal);
  $('#dailyStreak').innerHTML = current ? `<b>${current}</b>-day streak` : 'no streak yet';
  if (!$('#calendar').hidden) renderCalendar();
}

const WEEKS = 17;

function cellColor(min) {
  if (!min) return '';
  const r = Math.min(1, min / goalMin());
  return `background:hsl(${60 + 60 * r} ${35 + 15 * r}% ${22 + 20 * r}%)`;
}

function renderCalendar() {
  const today = new Date(), todayKey = dayKey(today);
  const monday = addDays(today, -((today.getDay() + 6) % 7));
  const start = addDays(monday, -7 * (WEEKS - 1));
  let html = '<div class="calgrid"><span></span>' +
    ['Mon', '', 'Wed', '', 'Fri', '', 'Sun'].map(l => `<span class="dlabel">${l}</span>`).join('');
  for (let w = 0; w < WEEKS; w++) {
    const weekStart = addDays(start, 7 * w);
    const label = weekStart.getDate() <= 7 || w === 0 ? weekStart.toLocaleString(undefined, { month: 'short' }) : '';
    html += `<span class="mlabel">${label}</span>`;
    for (let i = 0; i < 7; i++) {
      const d = addDays(weekStart, i), key = dayKey(d), min = dayMinutes(key);
      const cls = ['cell', min >= goalMin() && 'met', key === todayKey && 'today', d > today && 'future'].filter(Boolean).join(' ');
      const title = `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}: ${fmt(min, 1)} min`;
      html += `<span class="${cls}" style="${cellColor(min)}" title="${title}"></span>`;
    }
  }
  html += '</div>';

  const { current, best } = streaks();
  let week = 0, met30 = 0;
  for (let i = 0; i < 7; i++) week += dayMinutes(dayKey(addDays(monday, i)));
  for (let i = 0; i < 30; i++) if (dayMinutes(dayKey(addDays(today, -i))) >= goalMin()) met30++;
  const total = Object.values(stats.data.daily).reduce((a, b) => a + b, 0) / 60000;
  const practiced = Object.values(stats.data.daily).filter(v => v > 0).length;
  html += `<div class="calstats">
    <span>This week <b>${fmt(week, 0)} min</b></span>
    <span>Goal met <b>${met30}/30</b> days</span>
    <span>Streak <b>${current}</b> · best <b>${best}</b></span>
    <span>Total <b>${fmt(total / 60, 1)} h</b> over <b>${practiced}</b> days</span>
  </div>
  <div class="callegend">less <span class="cell"></span>${[0.25, 0.5, 0.75, 1].map(r => `<span class="cell" style="${cellColor(r * goalMin())}"></span>`).join('')} goal met</div>`;
  $('#calendar').innerHTML = html;
}

$('#calToggle').addEventListener('click', () => {
  const cal = $('#calendar');
  cal.hidden = !cal.hidden;
  $('#calToggle').textContent = cal.hidden ? 'calendar ▾' : 'calendar ▴';
  if (!cal.hidden) renderCalendar();
});
const goalInput = $('#goalInput');
goalInput.value = goalMin();
goalInput.addEventListener('change', () => {
  const v = Math.max(5, Math.min(240, Math.round(Number(goalInput.value) || 30)));
  goalInput.value = v;
  S().dailyGoalMin = v;
  stats.save();
  renderDaily();
});
setInterval(renderDaily, 60000); // picks up the new day after midnight

// ---------- wiring

function refreshAll() {
  if (!selected) selected = focusCode();
  kb.setSelected(selected);
  paintKeys();
  renderSummary();
  renderDaily();
  renderKeyStrip();
  renderCurrent();
  renderInspector();
  renderEdges();
}

function setSeg(id, attr, value) {
  for (const b of document.querySelectorAll(`#${id} button`)) b.classList.toggle('active', b.dataset[attr] === value);
}

function setMode(mode) {
  S().mode = mode;
  stats.save();
  document.body.classList.toggle('free', mode === 'free');
  setSeg('modeSeg', 'mode', mode);
  setActive(false);
  if (mode === 'free') $('#freeText').focus();
  refreshAll();
}

document.addEventListener('click', e => {
  const c = e.target.closest('[data-code]');
  if (c && !e.target.closest('#kb')) select(c.dataset.code);
});
$('#modeSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setMode(b.dataset.mode); });
$('#edgeSeg').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  S().edgeMode = b.dataset.edge;
  stats.save();
  setSeg('edgeSeg', 'edge', S().edgeMode);
  renderEdges();
});
$('#graphSeg').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  S().graph = b.dataset.graph;
  stats.save();
  setSeg('graphSeg', 'graph', S().graph);
  refreshAll();
});
$('#colorSeg').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  S().colorMode = b.dataset.color;
  stats.save();
  setSeg('colorSeg', 'color', S().colorMode);
  paintKeys();
});
$('#resetView').addEventListener('click', () => kb.resetView());
$('#overlay').addEventListener('click', () => setActive(true));

const target = $('#target');
target.value = S().targetWpm;
target.addEventListener('change', () => {
  const v = Math.max(10, Math.min(250, Number(target.value) || 35));
  target.value = v;
  S().targetWpm = v;
  stats.save();
  refreshAll();
});

$('#exportBtn').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([stats.exportJSON()], { type: 'application/json' }));
  a.download = `keygraph-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});
$('#importBtn').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    stats.importJSON(await f.text());
    target.value = S().targetWpm;
    goalInput.value = goalMin();
    newLesson();
    setMode(S().mode);
    toast('Data imported.');
  } catch (err) {
    toast('Import failed: ' + err.message);
  }
  e.target.value = '';
});
$('#resetBtn').addEventListener('click', () => {
  if (!confirm('Delete all key and transition statistics?')) return;
  stats.reset();
  selected = null;
  newLesson();
  refreshAll();
  toast('Statistics reset.');
});

// Save everything right away when the tab is hidden, closed, or reloaded.
const saveNow = () => { flushFreeHistory(); stats.flush(); };
window.addEventListener('pagehide', saveNow);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });

setSeg('graphSeg', 'graph', S().graph);
setSeg('edgeSeg', 'edge', S().edgeMode);
setSeg('colorSeg', 'color', S().colorMode);
newLesson();
setMode(S().mode);
