import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { KEYS } from './layout.js';
import { NEUTRAL_HSL } from './colors.js';

const W = 18.25, D = 6.25;      // keyboard footprint in key units
const CAP_H = 0.42, BASE_Y = 0.3;
const UP = new THREE.Vector3(0, 1, 0);

function makeLabel(k) {
  const pw = k.w - 0.2, ph = 0.72, scale = 128;
  const c = document.createElement('canvas');
  c.width = Math.round(pw * scale);
  c.height = Math.round(ph * scale);
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(255,255,255,0.92)';
  g.textBaseline = 'middle';
  if (k.label.length === 1) {
    g.font = '600 50px system-ui, -apple-system, sans-serif';
    g.textAlign = 'center';
    g.fillText(k.label, c.width / 2, c.height / 2 + 2);
  } else if (k.label) {
    g.font = '500 22px system-ui, -apple-system, sans-serif';
    g.textAlign = 'left';
    g.fillText(k.label, 10, 22);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(pw, ph),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
  m.rotation.x = -Math.PI / 2;
  return m;
}

function dispose(obj) {
  obj.traverse(o => {
    o.geometry?.dispose();
    o.material?.dispose();
  });
}

export class Keyboard3D {
  constructor(el, { onSelect = () => {}, onHover = () => {} } = {}) {
    this.el = el;
    this.onSelect = onSelect;
    this.onHover = onHover;

    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }));
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    el.appendChild(r.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 2, 0.1, 200);
    this.controls = new OrbitControls(this.camera, r.domElement);
    Object.assign(this.controls, {
      enableDamping: true, dampingFactor: 0.08, minDistance: 8, maxDistance: 60, maxPolarAngle: Math.PI * 0.49,
    });

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x303040, 1.5));
    const sun = new THREE.DirectionalLight(0xffffff, 1.7);
    sun.position.set(-4, 12, 9);
    this.scene.add(sun);
    const rim = new THREE.DirectionalLight(0x99aaff, 0.5);
    rim.position.set(8, 4, -6);
    this.scene.add(rim);

    this.root = new THREE.Group();
    this.root.position.set(-W / 2, 0, -D / 2);
    this.scene.add(this.root);

    const plate = new THREE.Mesh(
      new RoundedBoxGeometry(W + 0.7, 0.6, D + 0.7, 4, 0.25),
      new THREE.MeshStandardMaterial({ color: 0x1b1c1f, roughness: 0.7, metalness: 0.25 }),
    );
    plate.position.set(W / 2, 0, D / 2);
    this.root.add(plate);

    this.keys = new Map();
    this.pickables = [];
    const geoCache = new Map();
    for (const k of KEYS) {
      let geo = geoCache.get(k.w);
      if (!geo) geoCache.set(k.w, (geo = new RoundedBoxGeometry(k.w - 0.1, CAP_H, 0.9, 3, 0.09)));
      const mat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05 });
      const cap = new THREE.Mesh(geo, mat);
      cap.userData.code = k.code;
      const label = makeLabel(k);
      label.position.y = CAP_H / 2 + 0.003;
      const g = new THREE.Group();
      g.position.set(k.x + k.w / 2, BASE_Y + CAP_H / 2 + 0.02, k.y + 0.5);
      g.add(cap, label);
      this.root.add(g);
      this.pickables.push(cap);
      this.keys.set(k.code, { k, g, mat, baseY: g.position.y, y: 0, pressUntil: 0, errUntil: 0 });
      this.setKeyColor(k.code, null);
    }

    this.arcs = new THREE.Group();
    this.root.add(this.arcs);
    this.transient = [];
    this.selected = this.focus = this.hovered = null;

    this._bindPointer();
    this._fitted = false;
    new ResizeObserver(() => this._resize()).observe(el);
    this._resize();
    this._tick = this._tick.bind(this);
    requestAnimationFrame(this._tick);
  }

  // ---------- public API

  setKeyColor(code, hsl) {
    const s = this.keys.get(code);
    if (s) s.mat.color.setHSL(...(hsl || NEUTRAL_HSL));
  }

  setSelected(code) { this.selected = code; }
  setFocus(code) { this.focus = code; }

  press(code) {
    const s = this.keys.get(code);
    if (s) s.pressUntil = performance.now() + 110;
  }

  flashError(code) {
    const s = this.keys.get(code);
    if (s) s.errUntil = performance.now() + 260;
  }

  // edges: [{ from, to, hsl, width, opacity }]
  setEdges(edges) {
    for (const c of [...this.arcs.children]) {
      this.arcs.remove(c);
      dispose(c);
    }
    for (const e of edges) {
      const a = this._arc(e.from, e.to, e.hsl, e.width, e.opacity);
      if (a) this.arcs.add(a);
    }
  }

  // Short-lived arc drawn while typing.
  flashArc(from, to, hsl) {
    const obj = this._arc(from, to, hsl, 0.035, 0.9);
    if (!obj) return;
    this.root.add(obj);
    this.transient.push({ obj, born: performance.now(), life: 650, opacity: 0.9 });
    if (this.transient.length > 12) this._expire(0);
  }

  resetView() {
    const deg = THREE.MathUtils.degToRad;
    const vf = deg(this.camera.fov);
    const hf = 2 * Math.atan(Math.tan(vf / 2) * this.camera.aspect);
    const dist = Math.max((W / 2 + 0.9) / Math.tan(hf / 2), (D / 2 + 1.8) / Math.tan(vf / 2));
    const elev = deg(55);
    this.controls.target.set(0, 0.5, 0.3);
    this.camera.position.set(0, 0.5 + Math.sin(elev) * dist, 0.3 + Math.cos(elev) * dist);
    this.controls.update();
  }

  // ---------- internals

  _top(code) {
    const s = this.keys.get(code);
    if (!s) return null;
    return new THREE.Vector3(s.k.x + s.k.w / 2, s.baseY + CAP_H / 2 + 0.06, s.k.y + 0.5);
  }

  _arc(from, to, hsl, width, opacity) {
    const a = this._top(from), b = this._top(to);
    if (!a || !b) return null;
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color().setHSL(hsl[0], Math.min(1, hsl[1] + 0.25), Math.min(0.7, hsl[2] + 0.18)),
      transparent: true, opacity, depthWrite: false,
    });
    const grp = new THREE.Group();
    if (from === to) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.24, width, 8, 32), mat);
      ring.position.copy(a).add(new THREE.Vector3(0, 0.32, 0));
      grp.add(ring);
      return grp;
    }
    const dist = a.distanceTo(b);
    const mid = a.clone().lerp(b, 0.5);
    mid.y += 0.6 + dist * 0.3;
    const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
    grp.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 48, width, 6, false), mat));
    const head = new THREE.Mesh(new THREE.ConeGeometry(width * 2.6 + 0.04, 0.26, 12), mat);
    head.position.copy(curve.getPoint(0.95));
    head.quaternion.setFromUnitVectors(UP, curve.getTangent(0.95).normalize());
    grp.add(head);
    return grp;
  }

  _expire(i) {
    const { obj } = this.transient[i];
    this.root.remove(obj);
    dispose(obj);
    this.transient.splice(i, 1);
  }

  _bindPointer() {
    const dom = this.renderer.domElement;
    const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
    const pick = e => {
      const rect = dom.getBoundingClientRect();
      ptr.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      ray.setFromCamera(ptr, this.camera);
      return ray.intersectObjects(this.pickables, false)[0]?.object.userData.code ?? null;
    };
    let down = null;
    dom.addEventListener('pointermove', e => {
      const code = pick(e);
      this.hovered = code;
      dom.style.cursor = code ? 'pointer' : 'grab';
      this.onHover(code, e.clientX, e.clientY);
    });
    dom.addEventListener('pointerleave', () => {
      this.hovered = null;
      this.onHover(null);
    });
    dom.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
    dom.addEventListener('pointerup', e => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]);
      down = null;
      if (moved < 5) {
        const code = pick(e);
        if (code) this.onSelect(code);
      }
    });
  }

  _resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (!this._fitted) {
      this._fitted = true;
      this.resetView();
    }
  }

  _tick() {
    requestAnimationFrame(this._tick);
    const t = performance.now();
    this.controls.update();
    for (const s of this.keys.values()) {
      const pressed = s.pressUntil > t;
      s.y += ((pressed ? -0.14 : 0) - s.y) * 0.4;
      s.g.position.y = s.baseY + s.y;
      const em = s.mat.emissive;
      if (s.errUntil > t) {
        em.setRGB(0.6, 0.04, 0.04);
        continue;
      }
      const code = s.k.code;
      let v = 0;
      if (code === this.selected) v = 0.3;
      if (code === this.focus) v = Math.max(v, 0.14 + 0.1 * Math.sin(t / 220));
      if (code === this.hovered) v += 0.12;
      if (pressed) v += 0.25;
      em.setRGB(v, v, v);
    }
    for (let i = this.transient.length - 1; i >= 0; i--) {
      const a = this.transient[i];
      const age = (t - a.born) / a.life;
      if (age >= 1) this._expire(i);
      else a.obj.traverse(o => { if (o.material) o.material.opacity = a.opacity * (1 - age); });
    }
    this.renderer.render(this.scene, this.camera);
  }
}
