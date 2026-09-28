import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jointAngle, vecAngle, kneeAngle, L, fillGaps } from '../site/js/metrics.js';

const near = (a, b, tol = 1) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

test('直角 90°', () => near(jointAngle([1,0,0],[0,0,0],[0,1,0]), 90));
test('伸直 180°', () => near(jointAngle([-1,0,0],[0,0,0],[1,0,0]), 180));
test('45°', () => near(jointAngle([1,0,0],[0,0,0],[1,1,0]), 45));
test('3D 任意方向 60°', () => near(jointAngle([0,0,2],[0,0,0],[0, Math.sin(Math.PI/3)*3, Math.cos(Math.PI/3)*3]), 60));
test('零長度向量回 NaN', () => assert.ok(Number.isNaN(vecAngle([0,0,0],[1,0,0]))));
test('膝角＝左右平均', () => {
  const w = Array.from({ length: 33 }, () => [0, 0, 0]);
  w[L.lHip] = [0, -1, 0]; w[L.lKn] = [0, 0, 0]; w[L.lAn] = [0, 1, 0];      // 180
  w[L.rHip] = [1, -1, 0]; w[L.rKn] = [1, 0, 0]; w[L.rAn] = [2, 0, 0];      // 90
  near(kneeAngle(w), 135);
});
test('缺值內插', () => assert.deepEqual(fillGaps([NaN, 1, NaN, 3, NaN]), [1, 1, 2, 3, 3]));

import { selectSpiker } from '../site/js/metrics.js';
// 合成人：以 (cx, cy) 為髖部中心、scale 為軀幹長的簡化站姿，wristUp 時右腕舉過頭
function person(cx, cy, s, wristUp = false) {
  const img = Array.from({ length: 33 }, () => [cx, cy, 0, 1]);
  img[L.lHip] = [cx - 0.1 * s, cy, 0, 1]; img[L.rHip] = [cx + 0.1 * s, cy, 0, 1];
  img[L.lSh] = [cx - 0.15 * s, cy - s, 0, 1]; img[L.rSh] = [cx + 0.15 * s, cy - s, 0, 1];
  img[L.nose] = [cx, cy - 1.3 * s, 0, 1];
  img[L.lWr] = [cx - 0.2 * s, cy - 0.2 * s, 0, 1];
  img[L.rWr] = wristUp ? [cx + 0.2 * s, cy - 2 * s, 0, 1] : [cx + 0.2 * s, cy - 0.2 * s, 0, 1];
  return { img, world: img.map((p) => [p[0], p[1], 0]) };
}
test('多人：挑出又大又持續出現的人，並跨格追蹤同一人', () => {
  const frames = [];
  for (let i = 0; i < 30; i++) {
    const people = [person(0.3 + i * 0.01, 0.8, 0.3)];        // 主角：大、慢慢往右移
    if (i % 3 === 0) people.push(person(1.2, 0.5, 0.08));      // 背景小人，斷斷續續
    frames.push({ t: i / 30, people: i % 2 ? people.reverse() : people });
  }
  const out = selectSpiker(frames);
  assert.equal(out.filter((f) => f.img).length, 30);
  assert.ok(out.every((f) => Math.abs(f.img[L.lSh][1] - (0.8 - 0.3)) < 1e-9), '每格都是主角');
});
test('多人：一樣大時，有扣球揮臂的人勝出', () => {
  const frames = [];
  for (let i = 0; i < 20; i++) {
    const up = i >= 8 && i <= 12;
    const spiker = person(0.3, 0.8, 0.25, up);
    if (up) spiker.img[L.rWr] = [0.3 + (i - 8) * 0.08, 0.8 - 0.5, 0, 1];
    frames.push({ t: i / 30, people: [person(1.0, 0.8, 0.25), spiker] });
  }
  const out = selectSpiker(frames);
  assert.ok(Math.abs(out[0].img[L.lHip][0] - (0.3 - 0.025)) < 1e-9, '選到揮臂者');
});

import { phaseEvents } from '../site/js/metrics.js';
// 只有膝角有意義的合成序列：knees[i] 為該格膝角
function kneeFrames(knees) {
  return knees.map((k) => {
    const w = Array.from({ length: 33 }, () => [0, 0, 0]);
    const r = (k * Math.PI) / 180;
    for (const [h, n, a] of [[L.lHip, L.lKn, L.lAn], [L.rHip, L.rKn, L.rAn]]) { w[h] = [0, -1, 0]; w[n] = [0, 0, 0]; w[a] = [Math.sin(r), -Math.cos(r), 0]; }
    return { world: w };
  });
}
test('有「蹲下再伸直」才算拍到蹲低與落地', () => {
  const k = [170, 165, 150, 130, 115, 130, 150, 170, 175, 175, 175, 175, 175, 150, 125, 140, 165, 170, 170];
  const ev = phaseEvents(kneeFrames(k), 0, k.length - 1, 10);
  assert.equal(ev.crouch, 4); assert.equal(ev.crouchSeen, true);
  assert.equal(ev.landing, 14); assert.equal(ev.landingSeen, true);
});
test('從空中開始、剪在落地前的片段：蹲低與落地都標為沒拍到', () => {
  const k = [160, 165, 170, 172, 175, 175, 175, 174, 172, 170];
  const ev = phaseEvents(kneeFrames(k), 0, k.length - 1, 5);
  assert.equal(ev.crouchSeen, false);
  assert.equal(ev.landingSeen, false);
});
