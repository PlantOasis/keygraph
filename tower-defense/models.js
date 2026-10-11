// 3D models shared by the board and the draft cards: tower meshes, text sprites, card art.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { keyLabel } from '../js/layout.js';
import { ITEMS } from './defs.js';

export const hex = n => '#' + n.toString(16).padStart(6, '0');

export const GEO = {
  sphere: new THREE.SphereGeometry(1, 20, 14),
  dodeca: new THREE.DodecahedronGeometry(1),
  ico: new THREE.IcosahedronGeometry(1, 1),
  cone: new THREE.ConeGeometry(0.8, 1.6, 14),
  plane: new THREE.PlaneGeometry(1, 1),
  ring: new THREE.TorusGeometry(1, 0.05, 6, 40),
  cyl: new THREE.CylinderGeometry(1, 1, 1, 8),
  coin: new THREE.CylinderGeometry(0.13, 0.13, 0.035, 18),
};

export function textSprite(text, color) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d');
  let size = 40;
  g.font = `700 ${size}px system-ui, -apple-system, sans-serif`;
  while (size > 16 && g.measureText(text).width > 244) g.font = `700 ${--size}px system-ui, -apple-system, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = color;
  g.fillText(text, 128, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  s.scale.set(2.4, 0.6, 1);
  return s;
}

export function disposeTree(obj) {
  obj.traverse(o => {
    o.geometry?.dispose();
    if (o.material) {
      o.material.map?.dispose();
      o.material.dispose();
    }
  });
}

// Muted key tint for a key holding this item.
export function itemHSL(type) {
  const h = {};
  new THREE.Color(ITEMS[type].color).getHSL(h);
  return [h.h, h.s * 0.5, 0.3];
}

// A tower model sitting on a key top; head (rotates to aim) is in userData.head.
export function buildItem(type, level) {
  const def = ITEMS[type];
  const mat = new THREE.MeshStandardMaterial({
    color: def.color, roughness: 0.4, metalness: 0.3, emissive: def.color, emissiveIntensity: 0.18,
  });
  const dark = new THREE.MeshStandardMaterial({ color: 0x22252b, roughness: 0.6, metalness: 0.4 });
  const g = new THREE.Group();
  const add = (parent, geo, m, x = 0, y = 0, z = 0) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  };
  add(g, new THREE.CylinderGeometry(0.2, 0.25, 0.1, 16), dark, 0, 0.05, 0);
  const head = new THREE.Group();
  head.position.y = 0.17;
  g.add(head);
  const barrel = (r, len, y = 0) => {
    const b = add(head, new THREE.CylinderGeometry(r, r, len, 10), dark, 0, y, len / 2);
    b.rotation.x = Math.PI / 2;
  };
  switch (type) {
    case 'blaster':
      add(head, new THREE.BoxGeometry(0.22, 0.14, 0.22), mat);
      barrel(0.035, 0.3);
      break;
    case 'frost':
      add(head, new THREE.OctahedronGeometry(0.16), mat, 0, 0.04, 0);
      break;
    case 'cannon':
      add(head, new THREE.SphereGeometry(0.14, 16, 12), mat);
      barrel(0.065, 0.26);
      break;
    case 'tesla':
      add(head, new THREE.CylinderGeometry(0.04, 0.08, 0.26, 10), dark, 0, 0.05, 0);
      for (const y of [0, 0.09]) add(head, new THREE.TorusGeometry(0.1, 0.022, 6, 20), mat, 0, y, 0).rotation.x = Math.PI / 2;
      add(head, new THREE.SphereGeometry(0.06, 12, 8), mat, 0, 0.2, 0);
      break;
    case 'rail':
      add(head, new THREE.BoxGeometry(0.16, 0.1, 0.2), mat);
      barrel(0.025, 0.5, 0.02);
      break;
    case 'mine':
      for (let i = 0; i < 3; i++) add(head, new THREE.CylinderGeometry(0.15, 0.15, 0.05, 18), mat, 0, -0.08 + i * 0.06, 0);
      break;
    case 'poison':
      add(head, new THREE.SphereGeometry(0.12, 16, 12), mat, 0, 0.02, 0);
      add(head, new THREE.CylinderGeometry(0.045, 0.045, 0.14, 10), mat, 0, 0.16, 0);
      add(head, new THREE.CylinderGeometry(0.06, 0.06, 0.04, 10), dark, 0, 0.24, 0);
      break;
    case 'mortar': {
      add(head, new THREE.CylinderGeometry(0.15, 0.17, 0.08, 14), dark, 0, -0.03, 0);
      const tube = add(head, new THREE.CylinderGeometry(0.075, 0.09, 0.26, 12), mat, 0, 0.1, 0.05);
      tube.rotation.x = 0.5;
      break;
    }
    case 'gust': {
      add(head, new THREE.TorusGeometry(0.15, 0.025, 8, 24), dark, 0, 0.05, 0.02);
      for (let i = 0; i < 3; i++) {
        const blade = add(head, new THREE.BoxGeometry(0.05, 0.12, 0.015), mat, 0, 0.05, 0.02);
        blade.rotation.z = (i * Math.PI * 2) / 3;
        blade.translateY(0.06);
      }
      break;
    }
    case 'amp':
      add(head, new THREE.CylinderGeometry(0.02, 0.02, 0.3, 8), dark, 0, 0.1, 0);
      add(head, new THREE.SphereGeometry(0.05, 12, 8), mat, 0, 0.27, 0);
      for (const y of [0.04, 0.14]) add(head, new THREE.TorusGeometry(0.09 - y * 0.25, 0.015, 6, 20), mat, 0, y, 0).rotation.x = Math.PI / 2;
      break;
    case 'herald': {
      // open-ended cone: double-sided so the inside of the bell is drawn too
      const hornMat = mat.clone();
      hornMat.side = THREE.DoubleSide;
      const horn = add(head, new THREE.ConeGeometry(0.1, 0.3, 14, 1, true), hornMat, 0, 0.02, 0.08);
      horn.rotation.x = -Math.PI / 2;
      add(head, new THREE.SphereGeometry(0.07, 12, 8), dark, 0, 0, -0.06);
      break;
    }
    case 'focus':
      add(head, new THREE.CylinderGeometry(0.06, 0.08, 0.22, 12), dark, 0, 0.06, 0);
      add(head, new THREE.SphereGeometry(0.08, 16, 12), mat, 0, 0.2, 0);
      break;
  }
  const pip = new THREE.MeshBasicMaterial({ color: 0xffffff });
  for (let i = 0; i < level; i++) add(g, new THREE.SphereGeometry(0.03, 8, 6), pip, -0.12 + i * 0.06, 0.1, 0.24);
  g.userData.head = head;
  return g;
}

// ---------- draft card art: spinning keycaps (with or without a tower), rendered off-screen
// with one shared WebGL context and copied into each card's 2D canvas.

function keyLabelTexture(label) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(255,255,255,0.95)';
  g.font = '700 64px system-ui, -apple-system, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'bottom';
  g.fillText(label, 64, 124); // front edge of the key, in front of the tower on the back half
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// card = { type, code }: type null = bare keycap, code null = blank grey key.
function buildCardModel(card) {
  const group = new THREE.Group();
  let capColor = new THREE.Color(0x4a4c52);
  if (card.type && card.code) {
    const [h, sat] = itemHSL(card.type);
    capColor = new THREE.Color().setHSL(h, Math.min(1, sat * 2), 0.42);
  }
  group.add(new THREE.Mesh(
    new RoundedBoxGeometry(0.9, 0.42, 0.9, 3, 0.09),
    new THREE.MeshStandardMaterial({ color: capColor, roughness: 0.55 }),
  ));
  if (card.code) {
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(0.72, 0.72),
      new THREE.MeshBasicMaterial({ map: keyLabelTexture(keyLabel(card.code)), transparent: true, depthWrite: false }),
    );
    label.rotation.x = -Math.PI / 2;
    label.position.y = 0.213;
    group.add(label);
  }
  if (card.type) {
    const tower = buildItem(card.type, 1);
    tower.position.set(0, 0.21, -0.12);
    group.add(tower);
  }
  group.position.y = -0.05;
  return group;
}

export class CardArt {
  constructor(w = 170, h = 128) {
    this.w = w;
    this.h = h;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(28, w / h, 0.1, 50);
    this.renderer = null;
    this.slots = [];
    this.sig = null;
  }

  _init() {
    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true }));
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.setSize(this.w, this.h, false);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x303040, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(-2, 5, 4);
    this.scene.add(sun);
    this.camera.position.set(0, 1.25, 1.95);
    this.camera.lookAt(0, 0.22, 0);
  }

  // Rebuilds the models only when the cards actually changed.
  setCards(cards) {
    const sig = JSON.stringify(cards);
    if (sig === this.sig) return;
    this.sig = sig;
    if (!this.renderer) this._init();
    for (const slot of this.slots) {
      this.scene.remove(slot.model);
      disposeTree(slot.model);
    }
    this.slots = cards.map(card => {
      const model = buildCardModel(card);
      this.scene.add(model);
      return { model, ctx: null };
    });
  }

  // Binds <canvas data-prev="i"> elements inside root to the slots.
  attach(root) {
    const dpr = Math.min(window.devicePixelRatio, 2);
    for (const slot of this.slots) slot.ctx = null;
    root.querySelectorAll('canvas[data-prev]').forEach(cv => {
      const slot = this.slots[Number(cv.dataset.prev)];
      if (!slot) return;
      cv.width = this.w * dpr;
      cv.height = this.h * dpr;
      slot.ctx = cv.getContext('2d');
    });
  }

  render(t, isHot) {
    if (!this.renderer) return;
    const src = this.renderer.domElement;
    this.slots.forEach((slot, i) => {
      if (!slot.ctx) return;
      this.slots.forEach(o => { o.model.visible = o === slot; });
      const hot = isHot(i);
      slot.model.rotation.y = -0.5 + Math.sin(t * 0.8 + i * 2) * 0.55 + (hot ? t * 1.5 : 0);
      slot.model.position.y = -0.05 + (hot ? 0.05 : 0);
      this.renderer.render(this.scene, this.camera);
      slot.ctx.clearRect(0, 0, slot.ctx.canvas.width, slot.ctx.canvas.height);
      slot.ctx.drawImage(src, 0, 0, slot.ctx.canvas.width, slot.ctx.canvas.height);
    });
  }
}
