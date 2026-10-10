// Physical layout of an ANSI TKL (80%) keyboard in key units (1u = one alpha key).
// Fingers: 0 L-pinky, 1 L-ring, 2 L-middle, 3 L-index, 4 L-thumb,
//          5 R-thumb, 6 R-index, 7 R-middle, 8 R-ring, 9 R-pinky
export const FINGER_NAMES = [
  'Left pinky', 'Left ring', 'Left middle', 'Left index', 'Left thumb',
  'Right thumb', 'Right index', 'Right middle', 'Right ring', 'Right pinky',
];
export const ROW_NAMES = ['Function row', 'Number row', 'Top row', 'Home row', 'Bottom row', 'Space row'];

// keybr's unlock order
export const LETTER_ORDER = 'eniarltosudycghpmkbwfzvxqj'.split('');

// Each row: [y, items]; an item is [code, label, width, finger] or a number (horizontal gap).
const ROWS = [
  [0, [
    ['Escape', 'Esc', 1, 0], 1,
    ['F1', 'F1', 1, 1], ['F2', 'F2', 1, 2], ['F3', 'F3', 1, 3], ['F4', 'F4', 1, 3], 0.5,
    ['F5', 'F5', 1, 6], ['F6', 'F6', 1, 6], ['F7', 'F7', 1, 7], ['F8', 'F8', 1, 8], 0.5,
    ['F9', 'F9', 1, 9], ['F10', 'F10', 1, 9], ['F11', 'F11', 1, 9], ['F12', 'F12', 1, 9], 0.25,
    ['PrintScreen', 'PrtSc', 1, 6], ['ScrollLock', 'ScrLk', 1, 7], ['Pause', 'Pause', 1, 8],
  ]],
  [1.25, [
    ['Backquote', '`', 1, 0], ['Digit1', '1', 1, 0], ['Digit2', '2', 1, 1], ['Digit3', '3', 1, 2],
    ['Digit4', '4', 1, 3], ['Digit5', '5', 1, 3], ['Digit6', '6', 1, 6], ['Digit7', '7', 1, 6],
    ['Digit8', '8', 1, 7], ['Digit9', '9', 1, 8], ['Digit0', '0', 1, 9], ['Minus', '-', 1, 9],
    ['Equal', '=', 1, 9], ['Backspace', 'Backspace', 2, 9], 0.25,
    ['Insert', 'Ins', 1, 6], ['Home', 'Home', 1, 7], ['PageUp', 'PgUp', 1, 8],
  ]],
  [2.25, [
    ['Tab', 'Tab', 1.5, 0], ['KeyQ', 'Q', 1, 0], ['KeyW', 'W', 1, 1], ['KeyE', 'E', 1, 2],
    ['KeyR', 'R', 1, 3], ['KeyT', 'T', 1, 3], ['KeyY', 'Y', 1, 6], ['KeyU', 'U', 1, 6],
    ['KeyI', 'I', 1, 7], ['KeyO', 'O', 1, 8], ['KeyP', 'P', 1, 9], ['BracketLeft', '[', 1, 9],
    ['BracketRight', ']', 1, 9], ['Backslash', '\\', 1.5, 9], 0.25,
    ['Delete', 'Del', 1, 6], ['End', 'End', 1, 7], ['PageDown', 'PgDn', 1, 8],
  ]],
  [3.25, [
    ['CapsLock', 'Caps', 1.75, 0], ['KeyA', 'A', 1, 0], ['KeyS', 'S', 1, 1], ['KeyD', 'D', 1, 2],
    ['KeyF', 'F', 1, 3], ['KeyG', 'G', 1, 3], ['KeyH', 'H', 1, 6], ['KeyJ', 'J', 1, 6],
    ['KeyK', 'K', 1, 7], ['KeyL', 'L', 1, 8], ['Semicolon', ';', 1, 9], ['Quote', "'", 1, 9],
    ['Enter', 'Enter', 2.25, 9],
  ]],
  [4.25, [
    ['ShiftLeft', 'Shift', 2.25, 0], ['KeyZ', 'Z', 1, 0], ['KeyX', 'X', 1, 1], ['KeyC', 'C', 1, 2],
    ['KeyV', 'V', 1, 3], ['KeyB', 'B', 1, 3], ['KeyN', 'N', 1, 6], ['KeyM', 'M', 1, 6],
    ['Comma', ',', 1, 7], ['Period', '.', 1, 8], ['Slash', '/', 1, 9], ['ShiftRight', 'Shift', 2.75, 9], 1.25,
    ['ArrowUp', '↑', 1, 7],
  ]],
  [5.25, [
    ['ControlLeft', 'Ctrl', 1.25, 0], ['MetaLeft', 'Cmd', 1.25, 4], ['AltLeft', 'Opt', 1.25, 4],
    ['Space', '', 6.25, 5], ['AltRight', 'Opt', 1.25, 5], ['MetaRight', 'Cmd', 1.25, 5],
    ['ContextMenu', 'Menu', 1.25, 9], ['ControlRight', 'Ctrl', 1.25, 9], 0.25,
    ['ArrowLeft', '←', 1, 6], ['ArrowDown', '↓', 1, 7], ['ArrowRight', '→', 1, 8],
  ]],
];

export const KEYS = [];
ROWS.forEach(([y, items], row) => {
  let x = 0;
  for (const it of items) {
    if (typeof it === 'number') { x += it; continue; }
    const [code, label, w, finger] = it;
    KEYS.push({ code, label, x, y, w, finger, row });
    x += w;
  }
});
export const KEY_BY_CODE = Object.fromEntries(KEYS.map(k => [k.code, k]));

const PUNCT = {
  '`': 'Backquote', '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight',
  '\\': 'Backslash', ';': 'Semicolon', "'": 'Quote', ',': 'Comma', '.': 'Period', '/': 'Slash', ' ': 'Space',
};
const CODE_TO_CHAR = Object.fromEntries(Object.entries(PUNCT).map(([c, code]) => [code, c]));

export function charToCode(ch) {
  const c = ch.toLowerCase();
  if (c >= 'a' && c <= 'z') return 'Key' + c.toUpperCase();
  if (c >= '0' && c <= '9') return 'Digit' + c;
  return PUNCT[c] ?? null;
}

export function codeToChar(code) {
  if (/^Key[A-Z]$/.test(code)) return code[3].toLowerCase();
  if (/^Digit\d$/.test(code)) return code[5];
  return CODE_TO_CHAR[code] ?? null;
}

export function keyLabel(code) {
  if (code === 'Space') return '␣';
  return KEY_BY_CODE[code]?.label || code;
}

const hand = f => (f === 4 || f === 5 ? 'T' : f < 4 ? 'L' : 'R');

// How the hand has to move to go from one key to the next.
export function transitionKind(from, to) {
  const a = KEY_BY_CODE[from], b = KEY_BY_CODE[to];
  if (!a || !b) return 'unknown';
  if (from === to) return 'repeat';
  const ha = hand(a.finger), hb = hand(b.finger);
  if (ha === 'T' || hb === 'T') return 'thumb';
  if (a.finger === b.finger) return 'same-finger';
  if (ha === hb) return 'same-hand';
  return 'alternate';
}

export const KIND_LABEL = {
  'same-finger': 'same finger', 'same-hand': 'same hand', alternate: 'other hand',
  thumb: 'thumb', repeat: 'repeat', unknown: '?',
  stay: 'same key', near: '1 key away', far: '2+ keys away',
};

// ---------- finger travel
// Each finger's resting key; a finger idle for REST_MS is assumed to be back here.
export const HOME_KEYS = ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'Space', 'Space', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon'];
export const REST_MS = 2000;

// Remembers the last key each finger pressed, so a press can be attributed to the
// movement that finger actually made (e.g. right index J→N), not to the previous key overall.
export class FingerTracker {
  constructor() {
    this.pos = [...HOME_KEYS];
    this.t = new Array(10).fill(-Infinity);
  }

  // Where the finger that presses `code` was before this press.
  from(code, now) {
    const f = KEY_BY_CODE[code]?.finger;
    if (f == null) return null;
    return now - this.t[f] > REST_MS ? HOME_KEYS[f] : this.pos[f];
  }

  press(code, now) {
    const f = KEY_BY_CODE[code]?.finger;
    if (f == null) return;
    this.pos[f] = code;
    this.t[f] = now;
  }
}

export function travel(from, to) {
  const a = KEY_BY_CODE[from], b = KEY_BY_CODE[to];
  const dx = b.x + b.w / 2 - (a.x + a.w / 2), dy = b.y - a.y;
  return { dx, dy, dist: Math.hypot(dx, dy) };
}

export function travelBucket(from, to) {
  if (from === to) return 'stay';
  return travel(from, to).dist < 1.5 ? 'near' : 'far';
}

const ARROWS = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'];

export function travelTags(from, to) {
  const a = KEY_BY_CODE[from], b = KEY_BY_CODE[to];
  if (!a || !b) return [];
  if (from === to) return [{ text: 'stays', cls: 'good' }];
  const { dx, dy, dist } = travel(from, to);
  const arrow = ARROWS[(Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8];
  const tags = [{ text: `${arrow} ${dist.toFixed(1)}u`, cls: dist < 1.5 ? 'neutral' : 'warn' }];
  if (from === HOME_KEYS[a.finger]) tags.push({ text: 'from home', cls: 'good' });
  return tags;
}

export function relationTags(from, to) {
  const a = KEY_BY_CODE[from], b = KEY_BY_CODE[to];
  if (!a || !b) return [];
  const kind = transitionKind(from, to);
  const cls = { 'same-finger': 'bad', 'same-hand': 'warn', alternate: 'good' }[kind] || 'neutral';
  const tags = [{ text: KIND_LABEL[kind], cls }];
  if (from === 'Space') tags.push({ text: 'word start', cls: 'neutral' });
  const dr = Math.abs(a.row - b.row);
  if (dr >= 2 && kind !== 'thumb') tags.push({ text: `${dr}-row jump`, cls: 'warn' });
  return tags;
}
