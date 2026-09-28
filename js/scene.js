// 3D 骨架場景：橘＝你、青＝矯正後的你、半透明白＝石川
import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { BONES, MH, MS, withCenters } from './retarget.js';
import { L } from './metrics.js';

// MediaPipe 世界座標（+y 朝下、+z 遠離鏡頭）→ three（+y 朝上、+z 朝向鏡頭）
const toV = (p) => new THREE.Vector3(p[0], -p[1], -p[2]);
const JOINTS = [L.nose, L.lSh, L.rSh, L.lEl, L.rEl, L.lWr, L.rWr, L.lHip, L.rHip, L.lKn, L.rKn, L.lAn, L.rAn, L.lFt, L.rFt];

class Skeleton {
  constructor(scene, color, { opacity = 1, radius = 0.028 } = {}) {
    this.group = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: 0.55, roughness: 0.35, metalness: 0.1,
      transparent: opacity < 1, opacity, depthWrite: opacity >= 1,
    });
    this.mat = mat;
    const cyl = new THREE.CylinderGeometry(radius, radius, 1, 10, 1, false);
    cyl.translate(0, 0.5, 0);
    this.bones = BONES.map(() => { const m = new THREE.Mesh(cyl, mat); this.group.add(m); return m; });
    const sph = new THREE.SphereGeometry(radius * 1.7, 14, 10);
    this.joints = JOINTS.map(() => { const m = new THREE.Mesh(sph, mat); this.group.add(m); return m; });
    const head = new THREE.SphereGeometry(0.1, 20, 14);
    this.head = new THREE.Mesh(head, new THREE.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: 0.3, transparent: true, opacity: 0.35 * opacity, depthWrite: false,
    }));
    this.group.add(this.head);
    scene.add(this.group);
  }

  // pose：35 點（含 MH/MS）或 33 點世界座標；offset：[x, y]
  set(pose, offset = [0, 0], highlight = new Set()) {
    if (!pose) { this.group.visible = false; return; }
    this.group.visible = true;
    const p = pose.length >= 35 && pose[MH] ? pose : withCenters(pose);
    const up = new THREE.Vector3(0, 1, 0);
    const off = new THREE.Vector3(offset[0], offset[1], 0);
    BONES.forEach(([a, b], i) => {
      const A = toV(p[a]).add(off); const B = toV(p[b]).add(off);
      const d = B.clone().sub(A); const len = d.length();
      const m = this.bones[i];
      m.position.copy(A);
      m.scale.set(1, Math.max(len, 1e-4), 1);
      m.quaternion.setFromUnitVectors(up, d.normalize());
    });
    JOINTS.forEach((j, i) => {
      this.joints[i].position.copy(toV(p[j]).add(off));
      this.joints[i].scale.setScalar(highlight.has(j) ? 1.9 : 1);
    });
    this.head.position.copy(toV(p[L.nose]).add(off)).add(new THREE.Vector3(0, 0.04, 0));
  }
}

// 讓腳踩在地面：回傳需要往上加的位移（three 座標）
export function groundOffset(pose) {
  let minY = Infinity;
  for (const j of [L.lAn, L.rAn, L.lFt, L.rFt]) if (pose?.[j]) minY = Math.min(minY, -pose[j][1]);
  return Number.isFinite(minY) ? -minY : 0;
}

export function createScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setClearColor(0x0a0e13);
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x0a0e13, 6, 14);
  const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 50);
  camera.position.set(0.9, 1.3, 3.9);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 1.0, 0);
  controls.enableDamping = true;
  controls.minDistance = 1.5; controls.maxDistance = 9;
  controls.maxPolarAngle = Math.PI * 0.52;

  scene.add(new THREE.HemisphereLight(0xbfd6ff, 0x1a1208, 0.9));
  const key = new THREE.DirectionalLight(0xffffff, 1.2); key.position.set(2, 4, 3); scene.add(key);

  // 地板：排球場的攻擊線與中線（尺寸按真實球場：攻擊線距網 3 m）
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(9, 9), new THREE.MeshStandardMaterial({ color: 0x10161d, roughness: 0.95 }));
  floor.rotation.x = -Math.PI / 2; scene.add(floor);
  const grid = new THREE.GridHelper(9, 18, 0x1f2b38, 0x16202a); grid.position.y = 0.002; scene.add(grid);
  const lineMat = new THREE.MeshBasicMaterial({ color: 0x3b4a5c });
  for (const z of [-1.5, 1.5]) {
    const l = new THREE.Mesh(new THREE.PlaneGeometry(9, 0.05), lineMat);
    l.rotation.x = -Math.PI / 2; l.position.set(0, 0.004, z); scene.add(l);
  }

  const you = new Skeleton(scene, 0xff7a1a);
  const fix = new Skeleton(scene, 0x2ee6d6);
  const ghost = new Skeleton(scene, 0xdfe8f2, { opacity: 0.28, radius: 0.032 });

  function resize() {
    const w = canvas.clientWidth; const h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(canvas);
  resize();

  let dirty = true;
  controls.addEventListener('change', () => { dirty = true; });
  (function loop() {
    requestAnimationFrame(loop);
    controls.update();
    if (dirty) { renderer.render(scene, camera); dirty = false; }
  })();

  return {
    you, fix, ghost,
    render() { dirty = true; },
    resetView(target = [0, 1.0, 0]) { camera.position.set(0.9, 1.3, 3.9); controls.target.set(...target); dirty = true; },
  };
}
