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
