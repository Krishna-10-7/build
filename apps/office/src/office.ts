import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { Robot } from './robot.ts';
import { CanvasPanel, at, box, mesh, roundRect, toon, wrap } from './toon.ts';

export type DeskId = 'rival' | 'sentinel';

export interface Desk {
  id: DeskId;
  robot: Robot;
  browser: CanvasPanel;
  terminal: CanvasPanel;
  /** HTML name tag and speech bubble floating over the agent. */
  tag: HTMLDivElement;
  view: { pos: THREE.Vector3; target: THREE.Vector3 };
}

export interface World {
  renderer: THREE.WebGLRenderer;
  labels: CSS2DRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  desks: Record<DeskId, Desk>;
  tickets: CanvasPanel;
  score: CanvasPanel;
  build: CanvasPanel;
  /** Meshes that open a full-size view when clicked. */
  clickable: Map<THREE.Object3D, { desk: DeskId; what: 'browser' | 'terminal' }>;
  views: Record<string, { pos: THREE.Vector3; target: THREE.Vector3 }>;
  tick(dt: number): void;
}

const WALL = 0xf6e7d4;
const TRIM = 0xd9b48f;
const FLOOR = 0xe7c79c;

function floorTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;
  g.fillStyle = '#e9c99f';
  g.fillRect(0, 0, 512, 512);
  for (let row = 0; row < 8; row++) {
    const y = row * 64;
    const shift = (row % 2) * 128;
    g.fillStyle = row % 2 ? '#e4c194' : '#ecceA6';
    g.fillRect(0, y, 512, 64);
    g.strokeStyle = 'rgba(150,105,60,.28)';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(512, y);
    for (let x = shift; x < 512 + 256; x += 256) {
      g.moveTo(x % 512, y);
      g.lineTo(x % 512, y + 64);
    }
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(6, 4);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function plant(scale = 1): THREE.Group {
  const g = new THREE.Group();
  const pot = mesh(new THREE.CylinderGeometry(0.32, 0.24, 0.5, 18), 0xd9653b);
  at(pot, 0, 0.25, 0);
  g.add(pot);
  for (const [x, y, z, r] of [
    [0, 0.85, 0, 0.42],
    [0.22, 1.05, 0.05, 0.3],
    [-0.2, 1.1, -0.05, 0.32],
    [0.02, 1.3, 0, 0.28],
  ]) {
    const leaf = mesh(new THREE.IcosahedronGeometry(r, 1), 0x4f9d4a);
    at(leaf, x, y, z);
    g.add(leaf);
  }
  g.scale.setScalar(scale);
  return g;
}

function beanBag(color: THREE.ColorRepresentation): THREE.Mesh {
  const b = mesh(new THREE.SphereGeometry(0.75, 24, 16), color);
  b.scale.set(1, 0.42, 1);
  b.position.y = 0.3;
  return b;
}

function cloud(): THREE.Group {
  const g = new THREE.Group();
  for (const [x, y, z, r] of [
    [0, 0, 0, 1.4],
    [1.4, -0.2, 0.2, 1.1],
    [-1.4, -0.25, 0, 1.05],
    [0.6, 0.6, -0.2, 1],
  ]) {
    const s = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), toon(0xffffff));
    at(s, x, y, z);
    g.add(s);
  }
  return g;
}

function windowPane(w: number, h: number): THREE.Group {
  const g = new THREE.Group();
  g.add(box(w + 0.2, h + 0.2, 0.12, 0xffffff, 0.04));
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: 0xbfe6f7 }));
  at(glass, 0, 0, 0.07);
  g.add(glass);
  const bar = box(0.07, h, 0.05, 0xffffff, 0.02);
  at(bar, 0, 0, 0.09);
  g.add(bar);
  // A tree outside, to sell the view.
  const tree = new THREE.Mesh(new THREE.CircleGeometry(h * 0.33, 20), new THREE.MeshBasicMaterial({ color: 0x7fbf6a }));
  at(tree, -w * 0.25, -h * 0.22, 0.08);
  g.add(tree);
  return g;
}

function poster(text: string, sub: string, color: string): CanvasPanel {
  const p = new CanvasPanel(2.2, 1.4, 512);
  const g = p.ctx;
  g.fillStyle = color;
  g.fillRect(0, 0, p.w, p.h);
  g.fillStyle = '#fffaf2';
  g.font = '900 54px Nunito, sans-serif';
  wrap(g, text, p.w - 70).forEach((l, i) => g.fillText(l, 36, 90 + i * 60));
  g.font = '700 26px Nunito, sans-serif';
  g.fillText(sub, 36, p.h - 40);
  p.commit();
  return p;
}

function desk(world: THREE.Scene, id: DeskId, x: number, color: number, eye: number, clickable: World['clickable']): Desk {
  const g = new THREE.Group();
  at(g, x, 0, 0);
  world.add(g);

  const top = box(4.2, 0.12, 1.8, 0xfaf3ea, 0.05);
  at(top, 0, 1.0, -1.3);
  g.add(top);
  for (const [lx, lz] of [
    [-1.95, -0.5],
    [1.95, -0.5],
    [-1.95, -2.1],
    [1.95, -2.1],
  ]) {
    const leg = box(0.1, 1.0, 0.1, 0xb9a48c, 0.03);
    at(leg, lx, 0.5, lz);
    g.add(leg);
  }

  // Big monitor: the live browser.
  const stand = box(0.14, 0.8, 0.14, 0x3a3f4b, 0.04);
  at(stand, -0.45, 1.45, -1.85);
  g.add(stand);
  const bezel = box(2.75, 1.7, 0.12, 0x2b2f3a, 0.08);
  at(bezel, -0.45, 2.75, -1.9);
  g.add(bezel);
  const browser = new CanvasPanel(2.55, 1.5, 1024, { emissive: true });
  at(browser.mesh, -0.45, 2.75, -1.83);
  g.add(browser.mesh);
  clickable.set(browser.mesh, { desk: id, what: 'browser' });

  // Laptop: the agent's terminal.
  const base = box(1.25, 0.05, 0.85, 0xc9ccd3, 0.03);
  at(base, 1.45, 1.09, -1.0);
  g.add(base);
  const lid = new THREE.Group();
  at(lid, 1.45, 1.1, -1.42);
  lid.rotation.x = -0.28;
  g.add(lid);
  const shell = box(1.25, 0.85, 0.04, 0xc9ccd3, 0.03);
  at(shell, 0, 0.42, 0);
  lid.add(shell);
  const terminal = new CanvasPanel(1.15, 0.75, 768, { emissive: true });
  at(terminal.mesh, 0, 0.42, 0.025);
  lid.add(terminal.mesh);
  clickable.set(terminal.mesh, { desk: id, what: 'terminal' });

  const mug = mesh(new THREE.CylinderGeometry(0.1, 0.09, 0.2, 14), 0xffffff);
  at(mug, -2.0, 1.16, -0.7);
  g.add(mug);
  const plantSmall = plant(0.45);
  at(plantSmall, 1.85, 1.06, -1.95);
  g.add(plantSmall);

  // Chair and the agent sitting at it, back to the room, facing its screens.
  const seat = box(0.95, 0.14, 0.9, color === 0xd9652f ? 0x2f6f73 : 0xe0739a, 0.08);
  at(seat, 0, 0.62, 0.15);
  g.add(seat);
  const back = box(0.95, 0.95, 0.14, color === 0xd9652f ? 0x2f6f73 : 0xe0739a, 0.08);
  at(back, 0, 1.15, 0.6);
  g.add(back);
  const post = box(0.1, 0.55, 0.1, 0x3a3f4b, 0.03);
  at(post, 0, 0.3, 0.15);
  g.add(post);

  const robot = new Robot(color, eye);
  at(robot.root, 0, 0.35, 0.05);
  robot.root.rotation.y = Math.PI;
  g.add(robot.root);

  const tag = document.createElement('div');
  tag.className = `tag tag-${id}`;
  const label = new CSS2DObject(tag);
  at(label, -2.6, 2.6, 0.4);
  g.add(label);

  const worldPos = (v: THREE.Vector3) => v.add(new THREE.Vector3(x, 0, 0));
  return {
    id,
    robot,
    browser,
    terminal,
    tag,
    view: { pos: worldPos(new THREE.Vector3(0.4, 3.2, 3.4)), target: worldPos(new THREE.Vector3(0.2, 2.3, -1.7)) },
  };
}

export function buildOffice(stage: HTMLElement): World {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  stage.appendChild(renderer.domElement);
  const labels = new CSS2DRenderer();
  labels.domElement.className = 'labels';
  stage.appendChild(labels.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xa9dcf4);

  const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 200);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.minDistance = 3;
  controls.maxDistance = 30;
  controls.maxPolarAngle = Math.PI * 0.47;

  scene.add(new THREE.HemisphereLight(0xfff6e8, 0xd8b892, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(8, 16, 10);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -18, right: 18, top: 14, bottom: -14, near: 1, far: 50 });
  sun.shadow.bias = -0.0005;
  scene.add(sun);

  // Floor and walls. No ceiling: the sky and clouds are part of the look.
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 20), new THREE.MeshToonMaterial({ map: floorTexture(), color: FLOOR }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.z = -1;
  floor.receiveShadow = true;
  scene.add(floor);
  const rug = new THREE.Mesh(new THREE.CircleGeometry(3.2, 40), toon(0xf4b6c8));
  rug.rotation.x = -Math.PI / 2;
  rug.position.set(0, 0.012, 4.2);
  rug.receiveShadow = true;
  scene.add(rug);

  const back = box(30, 5.5, 0.3, WALL, 0.02);
  at(back, 0, 2.75, -11);
  scene.add(back);
  for (const sx of [-15, 15]) {
    const side = box(0.3, 5.5, 20, WALL, 0.02);
    at(side, sx, 2.75, -1);
    scene.add(side);
    const trim = box(0.34, 0.25, 20, TRIM, 0.02);
    at(trim, sx, 0.12, -1);
    scene.add(trim);
    for (const z of [-6, 1.5]) {
      const w = windowPane(3, 2);
      at(w, sx - Math.sign(sx) * 0.17, 2.9, z);
      w.rotation.y = -Math.sign(sx) * (Math.PI / 2);
      scene.add(w);
    }
  }
  const backTrim = box(30, 0.25, 0.34, TRIM, 0.02);
  at(backTrim, 0, 0.12, -11);
  scene.add(backTrim);

  const clickable: World['clickable'] = new Map();
  const rival = desk(scene, 'rival', -5.2, 0x8f7ae6, 0x9be7ff, clickable);
  const sentinel = desk(scene, 'sentinel', 5.2, 0xd9652f, 0xffd27a, clickable);

  // Back wall boards: tickets, scoreboard, build under test.
  const corkFrame = (w: number, h: number) => box(w + 0.3, h + 0.3, 0.12, 0xb07a4a, 0.06);
  const tickets = new CanvasPanel(6.2, 3.1, 1240);
  const tf = corkFrame(6.2, 3.1);
  at(tf, -8.2, 3.0, -10.78);
  scene.add(tf);
  at(tickets.mesh, -8.2, 3.0, -10.7);
  scene.add(tickets.mesh);

  const score = new CanvasPanel(6.4, 3.3, 1280, { emissive: true });
  const sf = box(6.7, 3.6, 0.14, 0x2b2f3a, 0.1);
  at(sf, 0, 3.05, -10.78);
  scene.add(sf);
  at(score.mesh, 0, 3.05, -10.69);
  scene.add(score.mesh);

  const build = new CanvasPanel(5.2, 3.1, 1040);
  const bf = corkFrame(5.2, 3.1);
  at(bf, 8.4, 3.0, -10.78);
  scene.add(bf);
  at(build.mesh, 8.4, 3.0, -10.7);
  scene.add(build.mesh);

  // Decor.
  for (const [x, z, s] of [
    [-13.5, -9.5, 1.3],
    [13.5, -9.5, 1.3],
    [-13.4, 7, 1.1],
    [13.4, 7, 1.1],
    [0, -4.5, 0.9],
  ]) {
    const p = plant(s);
    at(p, x, 0, z);
    scene.add(p);
  }
  for (const [x, z, c] of [
    [-1.6, 4.6, 0xffd166],
    [1.5, 3.4, 0x7bd3a8],
    [0.2, 5.6, 0x8fb8ff],
  ] as const) {
    const b = beanBag(c);
    at(b, x, 0.3, z);
    scene.add(b);
  }
  const p1 = poster('Repair the locator. Never the truth.', 'SentinelQA house rule', '#d9652f');
  at(p1.mesh, -14.83, 3.2, -1.8);
  p1.mesh.rotation.y = Math.PI / 2;
  scene.add(p1.mesh);
  const p2 = poster('Green is not the same as correct.', 'Pinned by QA, 2026', '#2f6f73');
  at(p2.mesh, 14.83, 3.2, -1.8);
  p2.mesh.rotation.y = -Math.PI / 2;
  scene.add(p2.mesh);

  const clouds: THREE.Group[] = [];
  for (let i = 0; i < 6; i++) {
    const c = cloud();
    at(c, -24 + i * 9, 10 + (i % 3), -16 - (i % 2) * 6);
    c.scale.setScalar(0.9 + (i % 3) * 0.3);
    scene.add(c);
    clouds.push(c);
  }

  const views = {
    overview: { pos: new THREE.Vector3(0, 7.2, 10.5), target: new THREE.Vector3(0, 2.2, -4) },
    rival: rival.view,
    sentinel: sentinel.view,
    boards: { pos: new THREE.Vector3(0, 4.2, -1.5), target: new THREE.Vector3(0, 3.0, -11) },
  };
  camera.position.copy(views.overview.pos);
  controls.target.copy(views.overview.target);

  const resize = () => {
    const w = stage.clientWidth || window.innerWidth;
    const h = stage.clientHeight || window.innerHeight;
    renderer.setSize(w, h);
    labels.setSize(w, h);
    camera.aspect = w / h;
    camera.fov = w < 700 ? 62 : 48;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);
  resize();

  return {
    renderer,
    labels,
    scene,
    camera,
    controls,
    desks: { rival, sentinel },
    tickets,
    score,
    build,
    clickable,
    views,
    tick(dt) {
      for (const c of clouds) {
        c.position.x += dt * 0.35;
        if (c.position.x > 30) c.position.x = -30;
      }
      rival.robot.update(dt);
      sentinel.robot.update(dt);
    },
  };
}

export { roundRect, wrap };
