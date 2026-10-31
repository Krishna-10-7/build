import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { cloud, plant, poster, windowPane } from './office.ts';
import { Robot } from './robot.ts';
import { CanvasPanel, at, box, mesh, toon } from './toon.ts';

/** The ground floor of the tower: reception, the directory, two kiosks and the lift. */

export type LobbySpot = 'elevator' | 'github' | 'jira' | 'agents' | 'console' | 'directory' | 'reception' | 'users';

export interface Lobby {
  renderer: THREE.WebGLRenderer;
  labels: CSS2DRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  directory: CanvasPanel;
  indicators: CanvasPanel[];
  githubScreen: CanvasPanel;
  jiraScreen: CanvasPanel;
  agentScreen: CanvasPanel;
  receptionist: Robot;
  bubble: HTMLDivElement;
  clickable: Map<THREE.Object3D, LobbySpot>;
  views: Record<string, { pos: THREE.Vector3; target: THREE.Vector3 }>;
  /** Opens (1) or closes (0) the lift doors over time. */
  setDoors(open: number): void;
  tick(dt: number): void;
}

const WALL = 0xf3e4d0;
const TRIM = 0xd9b48f;

function tiles(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 4; x++) {
      g.fillStyle = (x + y) % 2 ? '#efe2cf' : '#e3cdb0';
      g.fillRect(x * 64, y * 64, 64, 64);
    }
  g.strokeStyle = 'rgba(140,100,60,.25)';
  g.lineWidth = 2;
  for (let i = 0; i <= 256; i += 64) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i, 256);
    g.moveTo(0, i);
    g.lineTo(256, i);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(7.5, 5);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A kiosk: a post with a tilted screen on top. */
function kiosk(color: number, screen: CanvasPanel): THREE.Group {
  const g = new THREE.Group();
  const foot = box(1.4, 0.16, 1.0, 0x3a3f4b, 0.06);
  at(foot, 0, 0.08, 0);
  g.add(foot);
  const post = box(0.5, 1.6, 0.4, color, 0.12);
  at(post, 0, 0.95, 0);
  g.add(post);
  const head = new THREE.Group();
  at(head, 0, 1.95, 0.05);
  head.rotation.x = -0.35;
  g.add(head);
  const bezel = box(2.1, 1.45, 0.14, 0x2b2f3a, 0.08);
  head.add(bezel);
  at(screen.mesh, 0, 0, 0.075);
  head.add(screen.mesh);
  return g;
}

export function buildLobby(stage: HTMLElement): Lobby {
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
  sun.position.set(-8, 16, 10);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -18, right: 18, top: 14, bottom: -14, near: 1, far: 50 });
  sun.shadow.bias = -0.0005;
  scene.add(sun);

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 20), new THREE.MeshToonMaterial({ map: tiles() }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.z = -1;
  floor.receiveShadow = true;
  scene.add(floor);
  const carpet = new THREE.Mesh(new THREE.PlaneGeometry(4, 14), toon(0xd9652f));
  carpet.rotation.x = -Math.PI / 2;
  carpet.position.set(0, 0.012, 1.5);
  carpet.receiveShadow = true;
  scene.add(carpet);

  const back = box(30, 6.5, 0.3, WALL, 0.02);
  at(back, 0, 3.25, -11);
  scene.add(back);
  const backTrim = box(30, 0.25, 0.34, TRIM, 0.02);
  at(backTrim, 0, 0.12, -11);
  scene.add(backTrim);
  for (const sx of [-15, 15]) {
    const side = box(0.3, 6.5, 20, WALL, 0.02);
    at(side, sx, 3.25, -1);
    scene.add(side);
    const trim = box(0.34, 0.25, 20, TRIM, 0.02);
    at(trim, sx, 0.12, -1);
    scene.add(trim);
    for (const z of [-5, 3]) {
      const w = windowPane(3.2, 2.4);
      at(w, sx - Math.sign(sx) * 0.17, 3.1, z);
      w.rotation.y = -Math.sign(sx) * (Math.PI / 2);
      scene.add(w);
    }
  }

  const clickable = new Map<THREE.Object3D, LobbySpot>();
  const tagAll = (o: THREE.Object3D, spot: LobbySpot) => o.traverse((c) => (c as THREE.Mesh).isMesh && clickable.set(c, spot));

  // The name over the lifts.
  const sign = new CanvasPanel(9, 1.1, 1400);
  {
    const g = sign.ctx;
    g.fillStyle = '#1c1814';
    g.fillRect(0, 0, sign.w, sign.h);
    g.fillStyle = '#ffb38a';
    g.font = '900 104px Nunito, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('SENTINELQA TOWER', sign.w / 2, sign.h / 2 + 6);
    sign.commit();
  }
  at(sign.mesh, 0, 5.75, -10.82);
  scene.add(sign.mesh);

  // Two lifts with sliding doors and a floor display over each.
  const doors: { l: THREE.Mesh; r: THREE.Mesh; x: number }[] = [];
  const indicators: CanvasPanel[] = [];
  for (const x of [-2.4, 2.4]) {
    const frame = box(3.3, 4.5, 0.3, 0x8a6a4c, 0.08);
    at(frame, x, 2.25, -10.75);
    scene.add(frame);
    const shaft = box(2.7, 4.0, 0.1, 0x1c1814, 0.02);
    at(shaft, x, 2.0, -10.6);
    scene.add(shaft);
    const l = box(1.35, 3.95, 0.1, 0xc9ccd3, 0.03);
    const r = box(1.35, 3.95, 0.1, 0xc9ccd3, 0.03);
    at(l, x - 0.675, 2.0, -10.5);
    at(r, x + 0.675, 2.0, -10.5);
    scene.add(l, r);
    doors.push({ l, r, x });
    tagAll(frame, 'elevator');
    clickable.set(l, 'elevator');
    clickable.set(r, 'elevator');
    const ind = new CanvasPanel(1.5, 0.45, 300, { emissive: true });
    at(ind.mesh, x, 4.72, -10.58);
    scene.add(ind.mesh);
    indicators.push(ind);
  }
  // Call buttons between them.
  const plate = box(0.45, 0.8, 0.08, 0x8a6a4c, 0.04);
  at(plate, 0, 1.5, -10.8);
  scene.add(plate);
  for (const y of [1.7, 1.3]) {
    const b = new THREE.Mesh(new THREE.CircleGeometry(0.11, 20), new THREE.MeshBasicMaterial({ color: 0xffb38a }));
    at(b, 0, y, -10.75);
    scene.add(b);
    clickable.set(b, 'elevator');
  }
  clickable.set(plate, 'elevator');

  // The building directory, left of the lifts.
  const directory = new CanvasPanel(5.6, 3.9, 1200, { emissive: true });
  const df = box(5.95, 4.25, 0.14, 0x2b2f3a, 0.1);
  at(df, -9.2, 3.1, -10.78);
  scene.add(df);
  at(directory.mesh, -9.2, 3.1, -10.69);
  scene.add(directory.mesh);
  clickable.set(directory.mesh, 'directory');

  // Control room door (the console), right of the lifts.
  const doorFrame = box(2.7, 4.2, 0.3, 0x8a6a4c, 0.08);
  at(doorFrame, 9.2, 2.1, -10.75);
  scene.add(doorFrame);
  const door = box(2.2, 3.8, 0.12, 0x2f6f73, 0.06);
  at(door, 9.2, 1.9, -10.55);
  scene.add(door);
  const knob = mesh(new THREE.SphereGeometry(0.1, 16, 12), 0xffd27a);
  at(knob, 9.95, 1.8, -10.45);
  scene.add(knob);
  const doorSign = new CanvasPanel(2.4, 0.7, 480, { emissive: true });
  {
    const g = doorSign.ctx;
    g.fillStyle = '#12151c';
    g.fillRect(0, 0, doorSign.w, doorSign.h);
    g.fillStyle = '#7bd3a8';
    g.font = '900 52px Nunito, sans-serif';
    g.textAlign = 'center';
    g.fillText('CONTROL ROOM', doorSign.w / 2, 70);
    g.fillStyle = '#e6e1da';
    g.font = '700 30px Nunito, sans-serif';
    g.fillText('tickets · runs · policies', doorSign.w / 2, 118);
    doorSign.commit();
  }
  at(doorSign.mesh, 9.2, 4.6, -10.58);
  scene.add(doorSign.mesh);
  for (const o of [doorFrame, door, knob, doorSign.mesh]) clickable.set(o, 'console');

  // Reception: a long desk and the receptionist robot.
  const desk = box(5.2, 1.15, 1.2, 0xfaf3ea, 0.12);
  at(desk, 0, 0.58, -1.2);
  scene.add(desk);
  const deskFront = box(5.3, 0.3, 1.3, 0xd9652f, 0.08);
  at(deskFront, 0, 1.2, -1.2);
  scene.add(deskFront);
  const receptionist = new Robot(0x2f6f73, 0x9be7ff);
  at(receptionist.root, 0, 0.1, -2.4);
  scene.add(receptionist.root);
  // The reception desk is the ticket desk.
  for (const o of [desk, deskFront]) clickable.set(o, 'reception');
  tagAll(receptionist.root, 'reception');
  const bell = mesh(new THREE.SphereGeometry(0.16, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), 0xffd27a);
  at(bell, 1.6, 1.36, -1.0);
  scene.add(bell);
  const bubble = document.createElement('div');
  bubble.className = 'tag';
  const label = new CSS2DObject(bubble);
  at(label, 0, 3.1, -2.4);
  scene.add(label);

  // Kiosks: GitHub on the left, agent access on the right.
  const githubScreen = new CanvasPanel(1.9, 1.25, 640, { emissive: true });
  const gk = kiosk(0x8f7ae6, githubScreen);
  at(gk, -7.2, 0, 1.6);
  gk.rotation.y = 0.45;
  scene.add(gk);
  tagAll(gk, 'github');
  const jiraScreen = new CanvasPanel(1.9, 1.25, 640, { emissive: true });
  const jk = kiosk(0x2f6fd6, jiraScreen);
  at(jk, -9.2, 0, -3.6);
  jk.rotation.y = 0.55;
  scene.add(jk);
  tagAll(jk, 'jira');
  const agentScreen = new CanvasPanel(1.9, 1.25, 640, { emissive: true });
  const ak = kiosk(0xd9652f, agentScreen);
  at(ak, 7.2, 0, 1.6);
  ak.rotation.y = -0.45;
  scene.add(ak);
  tagAll(ak, 'agents');

  // Decor.
  for (const [x, z, s] of [
    [-13.5, -9.5, 1.3],
    [13.5, -9.5, 1.3],
    [-13.4, 7.5, 1.1],
    [13.4, 7.5, 1.1],
    [-4.6, -10, 0.9],
    [4.6, -10, 0.9],
  ]) {
    const p = plant(s);
    at(p, x, 0, z);
    scene.add(p);
  }
  const sofa = new THREE.Group();
  const seat = box(3.4, 0.55, 1.2, 0x8fb8ff, 0.2);
  at(seat, 0, 0.42, 0);
  const sback = box(3.4, 1.0, 0.35, 0x8fb8ff, 0.16);
  at(sback, 0, 0.95, -0.45);
  sofa.add(seat, sback);
  at(sofa, -11.5, 0, -3);
  sofa.rotation.y = Math.PI / 2;
  scene.add(sofa);
  const p1 = poster('Every push gets a floor of its own.', 'SentinelQA Tower', '#2f6f73');
  at(p1.mesh, 14.83, 3.4, -1);
  p1.mesh.rotation.y = -Math.PI / 2;
  scene.add(p1.mesh);

  const clouds: THREE.Group[] = [];
  for (let i = 0; i < 6; i++) {
    const c = cloud();
    at(c, -24 + i * 9, 11 + (i % 3), -16 - (i % 2) * 6);
    c.scale.setScalar(0.9 + (i % 3) * 0.3);
    scene.add(c);
    clouds.push(c);
  }

  const views = {
    overview: { pos: new THREE.Vector3(0, 7.5, 13.5), target: new THREE.Vector3(0, 2.2, -4) },
    elevator: { pos: new THREE.Vector3(0, 2.6, -4.5), target: new THREE.Vector3(0, 2.2, -10.6) },
    reception: { pos: new THREE.Vector3(0, 3.0, 4.2), target: new THREE.Vector3(0, 1.6, -1.6) },
    github: { pos: new THREE.Vector3(-4.6, 3.0, 5.6), target: new THREE.Vector3(-7.2, 1.9, 1.6) },
    jira: { pos: new THREE.Vector3(-5.6, 3.0, 0.8), target: new THREE.Vector3(-9.2, 1.9, -3.6) },
    agents: { pos: new THREE.Vector3(4.6, 3.0, 5.6), target: new THREE.Vector3(7.2, 1.9, 1.6) },
    directory: { pos: new THREE.Vector3(-7.4, 3.2, -4.6), target: new THREE.Vector3(-9.2, 3.0, -10.7) },
  };
  camera.position.copy(views.overview.pos);
  controls.target.copy(views.overview.target);

  const resize = () => {
    const w = stage.clientWidth || window.innerWidth;
    const h = stage.clientHeight || window.innerHeight;
    renderer.setSize(w, h);
    labels.setSize(w, h);
    camera.aspect = w / h;
    camera.fov = w < 700 ? 64 : 48;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);
  resize();

  let doorOpen = 0;
  let doorGoal = 0;
  return {
    renderer,
    labels,
    scene,
    camera,
    controls,
    directory,
    indicators,
    githubScreen,
    jiraScreen,
    agentScreen,
    receptionist,
    bubble,
    clickable,
    views,
    setDoors(v) {
      doorGoal = v;
    },
    tick(dt) {
      for (const c of clouds) {
        c.position.x += dt * 0.35;
        if (c.position.x > 30) c.position.x = -30;
      }
      receptionist.update(dt);
      doorOpen += Math.sign(doorGoal - doorOpen) * Math.min(Math.abs(doorGoal - doorOpen), dt * 1.6);
      for (const d of doors) {
        d.l.position.x = d.x - 0.675 - doorOpen * 1.25;
        d.r.position.x = d.x + 0.675 + doorOpen * 1.25;
      }
    },
  };
}
