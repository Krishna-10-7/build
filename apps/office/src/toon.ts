import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

/** Three-step ramp gives the soft cartoon shading used everywhere in the office. */
const ramp = (() => {
  const data = new Uint8Array([90, 170, 255]);
  const t = new THREE.DataTexture(data, data.length, 1, THREE.RedFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
})();

const cache = new Map<string, THREE.MeshToonMaterial>();

export function toon(color: THREE.ColorRepresentation, opts: { emissive?: THREE.ColorRepresentation; transparent?: boolean; opacity?: number } = {}): THREE.MeshToonMaterial {
  const key = `${new THREE.Color(color).getHexString()}|${opts.emissive ?? ''}|${opts.opacity ?? 1}`;
  let m = cache.get(key);
  if (!m) {
    m = new THREE.MeshToonMaterial({ color, gradientMap: ramp, emissive: opts.emissive ?? 0x000000, transparent: opts.transparent, opacity: opts.opacity ?? 1 });
    cache.set(key, m);
  }
  return m;
}

export function box(w: number, h: number, d: number, color: THREE.ColorRepresentation, radius = 0.06): THREE.Mesh {
  const r = Math.min(radius, w / 2, h / 2, d / 2) * 0.99;
  const mesh = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 3, r), toon(color));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export function mesh(geo: THREE.BufferGeometry, color: THREE.ColorRepresentation): THREE.Mesh {
  const m = new THREE.Mesh(geo, toon(color));
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export function at<T extends THREE.Object3D>(o: T, x: number, y: number, z: number): T {
  o.position.set(x, y, z);
  return o;
}

/** A canvas drawn in 2D and shown on a plane: boards, posters, screens. */
export class CanvasPanel {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly texture: THREE.CanvasTexture;
  readonly mesh: THREE.Mesh;

  constructor(w: number, h: number, px: number, opts: { emissive?: boolean } = {}) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = px;
    this.canvas.height = Math.round((px * h) / w);
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    // Screens glow on their own; printed boards take the room light.
    const mat = opts.emissive ? new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false }) : new THREE.MeshToonMaterial({ map: this.texture, gradientMap: ramp });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  }

  get w() {
    return this.canvas.width;
  }

  get h() {
    return this.canvas.height;
  }

  commit() {
    this.texture.needsUpdate = true;
  }
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Word-wraps text into lines that fit `width`. */
export function wrap(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width > width && line) {
        out.push(line);
        line = word;
      } else line = next;
    }
    out.push(line);
  }
  return out;
}
