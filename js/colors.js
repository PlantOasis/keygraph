// Speed ratio (key wpm / target wpm) -> red..green. 40% of target or less is fully red.
const ratioT = r => Math.max(0, Math.min(1, (r - 0.4) / 0.6));

export const NEUTRAL_HSL = [0.6, 0.05, 0.2];
export const LOCKED_HSL = [0, 0, 0.12];

export function ratioHSL(r) {
  if (r == null || !Number.isFinite(r)) return NEUTRAL_HSL;
  const t = ratioT(r);
  return [t * 0.333, 0.5, 0.36 + 0.05 * t];
}

export function hslCss([h, s, l], a = 1) {
  return `hsl(${(h * 360).toFixed(0)} ${(s * 100).toFixed(0)}% ${(l * 100).toFixed(0)}% / ${a})`;
}

export const ratioCss = (r, a = 1) => hslCss(ratioHSL(r), a);

// One hue per finger, like the zones on keybr's keyboard.
export const FINGER_HSL = [
  [0.95, 0.4, 0.38], [0.08, 0.45, 0.38], [0.14, 0.45, 0.36], [0.33, 0.3, 0.34], [0.6, 0.15, 0.32],
  [0.6, 0.15, 0.32], [0.53, 0.35, 0.34], [0.75, 0.3, 0.4], [0.86, 0.32, 0.4], [0.0, 0.42, 0.4],
];
