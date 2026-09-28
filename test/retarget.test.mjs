import assert from 'node:assert/strict';
import { test } from 'node:test';
import { corrected, BONES, withCenters, mapIndex, alignRef, yaw, yawDelta } from '../site/js/retarget.js';
import { dist, jointAngle, L } from '../site/js/metrics.js';

const rnd = (s) => () => (s = (s * 16807) % 2147483647) / 2147483647;
const r = rnd(7);
const pose = () => Array.from({ length: 33 }, () => [r() - 0.5, r() - 0.5, r() - 0.5]);

test('矯正骨架保留使用者骨長（誤差 < 2%）', () => {
  const u = pose(); const ref = pose();
  const lens = BONES.map(() => 0.2 + r() * 0.3);
  const c = corrected(u, ref, lens, 0.75);
  BONES.forEach(([p, k], i) => {
    const d = dist(c[p], c[k]);
    assert.ok(Math.abs(d - lens[i]) / lens[i] < 0.02, `bone ${i}: ${d} vs ${lens[i]}`);
  });
});

test('alpha=1 時關節角等於參考姿勢', () => {
  const u = pose(); const ref = pose();
  const lens = BONES.map(() => 0.3);
  const c = corrected(u, ref, lens, 1);
  const rr = withCenters(ref);
  for (const [a, b, d] of [[L.rSh, L.rEl, L.rWr], [L.lHip, L.lKn, L.lAn]]) {
    assert.ok(Math.abs(jointAngle(c[a], c[b], c[d]) - jointAngle(rr[a], rr[b], rr[d])) < 0.5);
  }
});

test('alpha=0 時關節角等於使用者', () => {
  const u = pose(); const ref = pose();
  const c = corrected(u, ref, BONES.map(() => 0.3), 0);
  assert.ok(Math.abs(jointAngle(c[L.rSh], c[L.rEl], c[L.rWr]) - jointAngle(u[L.rSh], u[L.rEl], u[L.rWr])) < 0.5);
});

test('事件對齊：擊球格對到擊球格、端點對端點', () => {
  const a = { start: 0, crouch: 10, contact: 20, landing: 30, end: 40 };
  const b = { start: 5, crouch: 50, contact: 80, landing: 100, end: 120 };
  assert.equal(mapIndex(20, a, b), 80);
  assert.equal(mapIndex(0, a, b), 5);
  assert.equal(mapIndex(40, a, b), 120);
  assert.equal(mapIndex(15, a, b), 65);
});

test('朝向對齊後髖線方向一致', () => {
  const u = pose(); const ref = pose();
  const al = alignRef(ref, false, yawDelta(u, ref));
  assert.ok(Math.abs(Math.sin(yaw(al) - yaw(u))) < 1e-6 && Math.cos(yaw(al) - yaw(u)) > 0);
});
