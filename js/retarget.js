// 矯正骨架：保留使用者每段骨長，只把骨段方向往參考選手同一時刻的姿勢靠攏。
import { L, sub, norm, mid, dist } from './metrics.js';

export const MH = 33; // 髖部中心（虛擬點）
export const MS = 34; // 肩部中心（虛擬點）

// 由根往外的骨段順序（parent 一定先於 child 出現）
export const BONES = [
  [MH, L.lHip], [MH, L.rHip], [L.lHip, L.lKn], [L.lKn, L.lAn], [L.lAn, L.lFt],
  [L.rHip, L.rKn], [L.rKn, L.rAn], [L.rAn, L.rFt],
  [MH, MS], [MS, L.lSh], [MS, L.rSh], [L.lSh, L.lEl], [L.lEl, L.lWr],
  [L.rSh, L.rEl], [L.rEl, L.rWr], [MS, L.nose],
];

export function withCenters(w) {
  const p = w.slice();
  p[MH] = mid(w[L.lHip], w[L.rHip]);
  p[MS] = mid(w[L.lSh], w[L.rSh]);
  return p;
}

const unit = (v) => { const n = norm(v); return n ? [v[0] / n, v[1] / n, v[2] / n] : [0, 1, 0]; };

// 單位向量球面內插
export function slerp(a, b, t) {
  const d = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const th = Math.acos(d);
  if (th < 1e-4) return a.slice();
  const s = Math.sin(th);
  const ka = Math.sin((1 - t) * th) / s; const kb = Math.sin(t * th) / s;
  return unit([a[0] * ka + b[0] * kb, a[1] * ka + b[1] * kb, a[2] * ka + b[2] * kb]);
}

// 使用者在一段影片中的骨長（中位數），矯正骨架一律用這組長度
export function boneLengths(frames, a, b) {
  return BONES.map(([p, c]) => {
    const ls = [];
    for (let i = a; i <= b; i++) {
      const w = frames[i]?.world; if (!w) continue;
      const q = withCenters(w); ls.push(dist(q[p], q[c]));
    }
    ls.sort((x, y) => x - y);
    return ls[ls.length >> 1] ?? 0.3;
  });
}

const SWAP = [[11, 12], [13, 14], [15, 16], [23, 24], [25, 26], [27, 28], [29, 30], [31, 32], [7, 8], [1, 4], [2, 5], [3, 6], [9, 10], [17, 18], [19, 20], [21, 22]];
export function mirror(w) {
  const p = w.map((v) => [-v[0], v[1], v[2]]);
  for (const [a, b] of SWAP) { const t = p[a]; p[a] = p[b]; p[b] = t; }
  return p;
}

export function yaw(w) {
  const v = sub(w[L.rHip], w[L.lHip]);
  return Math.atan2(v[2], v[0]);
}

export function rotateY(w, ang) {
  const c = Math.cos(ang); const s = Math.sin(ang);
  return w.map((v) => [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c]);
}

// 參考姿勢轉到使用者的朝向（慣用手不同時先鏡像）
export function alignRef(refW, needMirror, yawDelta) {
  const m = needMirror ? mirror(refW) : refW;
  return rotateY(m, yawDelta);
}

// 朝向差：讓 rotateY(ref, delta) 的髖線方向等於 user 的髖線方向
export function yawDelta(userW, refW) {
  return -(yaw(userW) - yaw(refW));
}

export function corrected(userW, refW, lengths, alpha = 0.75) {
  const u = withCenters(userW); const r = withCenters(refW);
  const out = new Array(35);
  out[MH] = u[MH];
  BONES.forEach(([p, c], k) => {
    const dir = slerp(unit(sub(u[c], u[p])), unit(sub(r[c], r[p])), alpha);
    out[c] = [out[p][0] + dir[0] * lengths[k], out[p][1] + dir[1] * lengths[k], out[p][2] + dir[2] * lengths[k]];
  });
  out[MS] = out[MS] ?? u[MS];
  for (let i = 0; i < 33; i++) if (!out[i]) out[i] = null;
  return out;
}

// 事件對齊的時間映射：[start, crouch, contact, landing, end] 分段線性
export function mapIndex(i, from, to) {
  const f = [from.start, from.crouch, from.contact, from.landing, from.end];
  const t = [to.start, to.crouch, to.contact, to.landing, to.end];
  for (let k = 0; k < 4; k++) {
    if (i <= f[k + 1] || k === 3) {
      const span = f[k + 1] - f[k];
      const u = span > 0 ? Math.max(0, Math.min(1, (i - f[k]) / span)) : 0;
      return Math.round(t[k] + u * (t[k + 1] - t[k]));
    }
  }
  return t[4];
}
