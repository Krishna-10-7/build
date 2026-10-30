import * as THREE from 'three';
import { at, box, mesh, toon } from './toon.ts';

export type Mood = 'idle' | 'working' | 'thinking' | 'done' | 'alert';

/**
 * Our office agent: a round little robot with a visor face. It types while
 * working, tilts its head while thinking, hops when done and flashes red on alert.
 */
export class Robot {
  readonly root = new THREE.Group();
  private body: THREE.Group;
  private head: THREE.Group;
  private armL: THREE.Mesh;
  private armR: THREE.Mesh;
  private eyes: THREE.Mesh[] = [];
  private bulb: THREE.Mesh;
  private bulbLight: THREE.PointLight;
  private mood: Mood = 'idle';
  private t = Math.random() * 10;

  constructor(readonly color: THREE.ColorRepresentation, readonly eyeColor: THREE.ColorRepresentation) {
    this.body = new THREE.Group();
    this.root.add(this.body);

    const torso = mesh(new THREE.CapsuleGeometry(0.42, 0.45, 8, 20), color);
    at(torso, 0, 0.75, 0);
    this.body.add(torso);
    const belly = mesh(new THREE.SphereGeometry(0.26, 20, 14), 0xfdf6ec);
    belly.scale.set(1, 1.1, 0.45);
    at(belly, 0, 0.72, 0.36);
    this.body.add(belly);

    this.head = new THREE.Group();
    at(this.head, 0, 1.55, 0);
    this.body.add(this.head);
    const skull = mesh(new THREE.SphereGeometry(0.46, 24, 18), color);
    skull.scale.set(1.08, 0.95, 1);
    this.head.add(skull);
    const visor = box(0.66, 0.36, 0.2, 0x1f2430, 0.12);
    at(visor, 0, 0.0, 0.36);
    this.head.add(visor);
    for (const x of [-0.14, 0.14]) {
      const eye = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.09, 4, 10), new THREE.MeshBasicMaterial({ color: eyeColor }));
      at(eye, x, 0.01, 0.47);
      this.head.add(eye);
      this.eyes.push(eye);
    }
    const stalk = mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.26, 8), 0x555b66);
    at(stalk, 0, 0.53, 0);
    this.head.add(stalk);
    this.bulb = new THREE.Mesh(new THREE.SphereGeometry(0.075, 14, 10), toon(0xfff3c4, { emissive: 0x332200 }));
    at(this.bulb, 0, 0.7, 0);
    this.head.add(this.bulb);
    this.bulbLight = new THREE.PointLight(0xff3b3b, 0, 4);
    at(this.bulbLight, 0, 0.75, 0);
    this.head.add(this.bulbLight);

    // Pivot at the shoulder so the arms swing from the top.
    const armGeo = new THREE.CapsuleGeometry(0.09, 0.42, 6, 10).translate(0, -0.25, 0);
    this.armL = mesh(armGeo, color);
    this.armR = mesh(armGeo, color);
    for (const [arm, x] of [
      [this.armL, -0.5],
      [this.armR, 0.5],
    ] as const) {
      at(arm, x, 1.05, 0.05);
      arm.rotation.x = -1.1;
      this.body.add(arm);
    }

    const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.55, 24), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.12 }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.01;
    this.root.add(shadow);
  }

  setMood(m: Mood) {
    this.mood = m;
    const eye = m === 'alert' ? 0xff4d4d : m === 'done' ? 0x5fe08a : this.eyeColor;
    for (const e of this.eyes) (e.material as THREE.MeshBasicMaterial).color.set(eye);
  }

  update(dt: number) {
    this.t += dt;
    const t = this.t;
    const m = this.mood;
    // Defaults, then each mood adds its own motion.
    this.body.position.y = Math.sin(t * 1.6) * 0.02;
    this.head.rotation.set(0, Math.sin(t * 0.5) * 0.08, 0);
    this.armL.rotation.x = -1.1;
    this.armR.rotation.x = -1.1;
    this.bulbLight.intensity = 0;
    (this.bulb.material as THREE.MeshToonMaterial).emissive.set(0x332200);

    if (m === 'working') {
      this.armL.rotation.x = -1.25 + Math.sin(t * 18) * 0.12;
      this.armR.rotation.x = -1.25 + Math.sin(t * 18 + 1.7) * 0.12;
      this.head.rotation.x = 0.12;
    } else if (m === 'thinking') {
      this.head.rotation.z = Math.sin(t * 1.4) * 0.18;
      this.armR.rotation.x = -2.3;
      (this.bulb.material as THREE.MeshToonMaterial).emissive.set(Math.sin(t * 6) > 0 ? 0x6b5200 : 0x332200);
    } else if (m === 'done') {
      this.body.position.y = Math.abs(Math.sin(t * 4)) * 0.18;
      this.armL.rotation.x = this.armR.rotation.x = -2.6;
    } else if (m === 'alert') {
      const on = Math.sin(t * 10) > 0;
      this.bulbLight.intensity = on ? 3 : 0;
      (this.bulb.material as THREE.MeshToonMaterial).emissive.set(on ? 0xff2020 : 0x330000);
      this.body.rotation.z = Math.sin(t * 30) * 0.015;
      this.armR.rotation.x = -2.8;
    }
    if (m !== 'alert') this.body.rotation.z = 0;
  }
}
