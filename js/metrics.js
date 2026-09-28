// 扣球分析的純函式：偵測擊球、切段、算指標。瀏覽器與 node（產參考資料、單元測試）共用。
// frame = { t, img: [[x,y,z,vis]×33] | null, world: [[x,y,z]×33] | null }
// img 是 MediaPipe 正規化座標（x 已乘上寬高比，等向）；world 是公尺、髖部中心為原點、+y 朝下。

export const L = {
  nose: 0, lSh: 11, rSh: 12, lEl: 13, rEl: 14, lWr: 15, rWr: 16,
  lHip: 23, rHip: 24, lKn: 25, rKn: 26, lAn: 27, rAn: 28, lFt: 31, rFt: 32,
};

export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], (a[2] ?? 0) - (b[2] ?? 0)];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const norm = (a) => Math.hypot(a[0], a[1], a[2]);
export const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, ((a[2] ?? 0) + (b[2] ?? 0)) / 2];
export const dist = (a, b) => norm(sub(a, b));

// 兩向量夾角（度）
export function vecAngle(u, v) {
  const n = norm(u) * norm(v);
  if (n === 0) return NaN;
  return (Math.acos(Math.max(-1, Math.min(1, dot(u, v) / n))) * 180) / Math.PI;
}

// 以 b 為頂點的關節角（度）：180 = 完全伸直
export const jointAngle = (a, b, c) => vecAngle(sub(a, b), sub(c, b));

const side = (arm) => (arm === 'R'
  ? { sh: L.rSh, el: L.rEl, wr: L.rWr }
  : { sh: L.lSh, el: L.lEl, wr: L.lWr });

export function kneeAngle(w) {
  return (jointAngle(w[L.lHip], w[L.lKn], w[L.lAn]) + jointAngle(w[L.rHip], w[L.rKn], w[L.rAn])) / 2;
}

// 多人畫面：跨格把同一個人串成軌跡（髖部中心最近者、位移 < 0.8 個軀幹長），
// 再挑「顯眼度」最高的軌跡＝各格軀幹長總和（越大、出現越久越高），× (1 + 手舉過頭時的最大揮臂分數)。
// 回傳單人格式 { t, img, world, track }；已是單人格式的格原樣保留。
export function selectSpiker(frames) {
  if (!frames.some((f) => f.people)) return frames;
  const tracks = []; // { id, last: {c, torso, i}, score, spike }
  const assign = frames.map(() => new Map()); // i → Map(trackId → person)
  const hipC = (p) => mid(p.img[L.lHip], p.img[L.rHip]);
  const torsoOf = (p) => dist(mid(p.img[L.lSh], p.img[L.rSh]), hipC(p));
  frames.forEach((f, i) => {
    const used = new Set();
    const cand = (f.people ?? []).map((p) => ({ p, c: hipC(p), torso: torsoOf(p) }))
      .sort((a, b) => b.torso - a.torso);
    for (const q of cand) {
      let best = null; let bd = Infinity;
      for (const t of tracks) {
        if (used.has(t.id) || i - t.last.i > 8) continue;
        const d = dist(q.c, t.last.c) / Math.max(q.torso, t.last.torso);
        if (d < 0.8 && d < bd) { bd = d; best = t; }
      }
      if (!best) { best = { id: tracks.length, score: 0, spike: 0, last: null, prevWr: null }; tracks.push(best); }
      used.add(best.id);
      best.score += q.torso;
      // 揮臂分數：手腕舉過鼻子時的移動速度（以軀幹長為單位）
      for (const w of [L.lWr, L.rWr]) {
        const h = (q.p.img[L.nose][1] - q.p.img[w][1]) / q.torso;
        const prev = best.prevWr?.[w];
        if (h > 0.3 && prev && i - best.last.i <= 2) best.spike = Math.max(best.spike, (dist(q.p.img[w], prev) / q.torso) * h);
      }
      best.prevWr = { [L.lWr]: q.p.img[L.lWr], [L.rWr]: q.p.img[L.rWr] };
      best.last = { c: q.c, torso: q.torso, i };
      assign[i].set(best.id, q.p);
    }
  });
  if (!tracks.length) return frames.map((f) => ({ t: f.t, img: null, world: null }));
  const win = tracks.reduce((a, b) => (b.score * (1 + b.spike) > a.score * (1 + a.spike) ? b : a));
  return frames.map((f, i) => {
    const p = assign[i].get(win.id);
    return { t: f.t, img: p?.img ?? null, world: p?.world ?? null, track: win.id };
  });
}

// 扣球全程頭都在髖部上方；影像或世界座標任一顯示頭在髖下，視為誤偵測（常見於人群、翻轉），整格作廢
export function cleanFrames(frames) {
  return frames.map((f) => {
    if (!f.img || !f.world) return { ...f, img: null, world: null };
    const hipImg = (f.img[L.lHip][1] + f.img[L.rHip][1]) / 2;
    const hipW = (f.world[L.lHip][1] + f.world[L.rHip][1]) / 2;
    if (f.img[L.nose][1] >= hipImg || f.world[L.nose][1] >= hipW) return { ...f, img: null, world: null };
    return f;
  });
}

// 缺值線性內插（頭尾取最近值），回傳新陣列
export function fillGaps(arr) {
  const out = arr.slice();
  const idx = out.map((v, i) => (Number.isFinite(v) ? i : -1)).filter((i) => i >= 0);
  if (idx.length === 0) return out;
  for (let i = 0; i < out.length; i++) {
    if (Number.isFinite(out[i])) continue;
    const next = idx.find((j) => j > i);
    const prev = [...idx].reverse().find((j) => j < i);
    if (prev === undefined) out[i] = out[next];
    else if (next === undefined) out[i] = out[prev];
    else out[i] = out[prev] + ((out[next] - out[prev]) * (i - prev)) / (next - prev);
  }
  return out;
}

export function smooth3(arr) {
  return arr.map((v, i) => {
    const a = arr[i - 1] ?? v; const b = arr[i + 1] ?? v;
    return (a + 2 * v + b) / 4;
  });
}

// 影像空間序列：每格軀幹長、雙腕高於鼻（以軀幹長為單位）、雙腕速度
export function imageSeries(frames) {
  const n = frames.length;
  const torso = new Array(n).fill(NaN);
  const h = { L: new Array(n).fill(NaN), R: new Array(n).fill(NaN) };
  const wx = { L: [], R: [] }; const wy = { L: [], R: [] };
  const footY = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const p = frames[i].img;
    for (const s of ['L', 'R']) { wx[s].push(NaN); wy[s].push(NaN); }
    if (!p) continue;
    const t = dist(mid(p[L.lSh], p[L.rSh]), mid(p[L.lHip], p[L.rHip]));
    torso[i] = t;
    for (const s of ['L', 'R']) {
      const wr = p[side(s).wr];
      h[s][i] = (p[L.nose][1] - wr[1]) / t;
      wx[s][i] = wr[0]; wy[s][i] = wr[1];
    }
    footY[i] = Math.max(p[L.lAn][1], p[L.rAn][1], p[L.lFt][1], p[L.rFt][1]);
  }
  const torsoF = fillGaps(torso);
  const tMed = median(torsoF.filter(Number.isFinite));
  const speed = {};
  for (const s of ['L', 'R']) {
    h[s] = smooth3(fillGaps(h[s]));
    const x = smooth3(fillGaps(wx[s])); const y = smooth3(fillGaps(wy[s]));
    speed[s] = x.map((_, i) => {
      const a = Math.max(0, i - 1); const b = Math.min(n - 1, i + 1);
      if (a === b) return 0;
      return Math.hypot(x[b] - x[a], y[b] - y[a]) / ((b - a) * tMed);
    });
  }
  return { torso: torsoF, torsoMed: tMed, h, speed, footY: fillGaps(footY) };
}

export function median(a) {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// 偵測每一次扣球：手腕舉過頭（h > 0.3 個軀幹長；真實影片中擊球格實測 0.3–0.7，0.5 會漏掉斜側鏡頭）的連續區段中，取「速度×高度」最大格為擊球格。
// 兩次扣球之間必須有雙腕都低於肩（h < -0.4）的格作分隔。
export function detectSpikes(frames, { minH = 0.3 } = {}) {
  const n = frames.length;
  if (n < 5) return [];
  const s = imageSeries(frames);
  const high = (i) => Math.max(s.h.L[i], s.h.R[i]);
  // 以「雙腕都放低」的格把影片切段
  const low = (i) => s.h.L[i] < -0.4 && s.h.R[i] < -0.4;
  const segs = [];
  let start = 0; let sawHigh = false;
  for (let i = 0; i < n; i++) {
    if (high(i) > minH) sawHigh = true;
    if (low(i) && sawHigh) {
      // 此段在 i 結束；往後延伸到放低區段結束
      let j = i;
      while (j + 1 < n && low(j + 1)) j++;
      segs.push([start, Math.min(n - 1, j)]);
      start = j; sawHigh = false; i = j;
    }
  }
  if (sawHigh) segs.push([start, n - 1]);

  const out = [];
  for (const [a, b] of segs) {
    let best = { score: -1 };
    for (const arm of ['L', 'R']) {
      for (let i = a; i <= b; i++) {
        const hh = s.h[arm][i];
        if (!(hh > 0.3)) continue;
        const score = s.speed[arm][i] * hh;
        if (score > best.score) best = { score, arm, contact: i };
      }
    }
    if (best.score < 0 || !frames[best.contact].world) continue;
    if (s.h[best.arm][best.contact] < minH) continue;
    const ev = phaseEvents(frames, a, b, best.contact);
    out.push({ arm: best.arm, contact: best.contact, start: a, end: b, ...ev });
  }
  return out;
}

// 起跳蹲低格＝擊球前膝角最小；落地緩衝格＝擊球後膝角最小
// 影片沒拍到蹲低或落地（例如從空中開始的重播）時，最小值會落在片段邊界或緊貼擊球格，
// 這時量到的是空中姿勢，不是蹲低／落地：標為沒拍到（crouchSeen / landingSeen = false）。
// 判準：極值不在片段頭尾 2 格內、離擊球 ≥ 4 格，且極值前後膝角都比極值大 ≥ 10°（真的有「蹲下再伸直」）。
export function phaseEvents(frames, a, b, contact) {
  const knee = frames.map((f) => (f.world ? kneeAngle(f.world) : NaN));
  let crouch = a; let landing = b;
  let mn = Infinity;
  for (let i = a; i < contact; i++) if (knee[i] < mn) { mn = knee[i]; crouch = i; }
  mn = Infinity;
  for (let i = contact + 1; i <= b; i++) if (knee[i] < mn) { mn = knee[i]; landing = i; }
  const maxIn = (x, y) => { let m = -Infinity; for (let i = x; i <= y; i++) if (knee[i] > m) m = knee[i]; return m; };
  const crouchSeen = crouch - a >= 2 && contact - crouch >= 4
    && maxIn(a, crouch) - knee[crouch] >= 10 && maxIn(crouch, contact) - knee[crouch] >= 10;
  const landingSeen = b - landing >= 2 && landing - contact >= 4
    && maxIn(contact, landing) - knee[landing] >= 10 && maxIn(landing, b) - knee[landing] >= 10;
  return { crouch, landing, crouchSeen, landingSeen };
}

// 身高代理值（公尺）：小腿＋大腿＋軀幹＋頸，取整段中位數
export function bodyHeight(frames, a, b) {
  const hs = [];
  for (let i = a; i <= b; i++) {
    const w = frames[i].world; if (!w) continue;
    const leg = (dist(w[L.lAn], w[L.lKn]) + dist(w[L.rAn], w[L.rKn]) + dist(w[L.lKn], w[L.lHip]) + dist(w[L.rKn], w[L.rHip])) / 2;
    const ms = mid(w[L.lSh], w[L.rSh]);
    hs.push(leg + dist(mid(w[L.lHip], w[L.rHip]), ms) + dist(ms, w[L.nose]));
  }
  return median(hs);
}

const UP = [0, -1, 0];
const horiz = (v) => [v[0], 0, v[2]];

// 指標定義。tol＝量測誤差容許值：判定「超出範圍」時，職業 min–max 兩端各放寬 tol（單支影片的關節點抖動實測約 ±10°）。
export const METRIC_DEFS = [
  { key: 'takeoffKnee', label: '起跳前膝角', unit: '°', tol: 12, note: '起跳前蹲到最低時的膝蓋角度（180°＝打直）。越小代表蹲得越深、儲力越多。' },
  { key: 'backswingElbow', label: '拉弓手肘高度', unit: '°', tol: 12, note: '擊球臂拉弓時上臂和軀幹的夾角。90° 代表手肘跟肩同高，越大手肘越高。' },
  { key: 'separation', label: '肩髖扭轉', unit: '°', tol: 15, note: '擊球前肩線和髖線在水平面上的最大夾角。代表身體有沒有轉開來蓄力。單支影片的深度估計誤差大，看趨勢就好。' },
  { key: 'contactElbow', label: '擊球時手肘角', unit: '°', tol: 12, note: '擊球那一格擊球臂的手肘角度。越接近 180° 手臂越直、擊球點越高。' },
  { key: 'contactReach', label: '擊球點高度', unit: '%', tol: 6, note: '擊球時手腕高出頭頂多少，以身高的百分比表示。' },
  { key: 'contactTrunk', label: '擊球時軀幹傾角', unit: '°', tol: 12, note: '擊球時軀幹偏離垂直多少度。' },
  { key: 'landingKnee', label: '落地膝角', unit: '°', tol: 12, note: '落地後膝蓋彎到最深的角度。太直（接近 180°）代表落地沒有緩衝，膝蓋負擔大。' },
];

export function computeMetrics(frames, spike) {
  const { arm, contact, crouch, landing, start, end, crouchSeen = true, landingSeen = true } = spike;
  const sd = side(arm);
  const W = (i) => frames[i]?.world;
  const m = {};
  const wc = W(contact);
  const wk = W(crouch);
  m.takeoffKnee = wk && crouchSeen ? kneeAngle(wk) : NaN;
  const from = crouchSeen ? crouch : start; // 沒拍到蹲低時，拉弓與扭轉從片段開頭找

  // 拉弓：蹲低到擊球之間，擊球臂手肘最彎的那格
  let bs = NaN; let minEl = Infinity;
  for (let i = from; i < contact; i++) {
    const w = W(i); if (!w) continue;
    const e = jointAngle(w[sd.sh], w[sd.el], w[sd.wr]);
    if (e < minEl) { minEl = e; bs = i; }
  }
  if (Number.isFinite(bs)) {
    const w = W(bs);
    const trunkDown = sub(mid(w[L.lHip], w[L.rHip]), mid(w[L.lSh], w[L.rSh]));
    m.backswingElbow = vecAngle(sub(w[sd.el], w[sd.sh]), trunkDown);
  } else m.backswingElbow = NaN;
  m.backswingFrame = bs;

  let sep = NaN;
  for (let i = from; i <= contact; i++) {
    const w = W(i); if (!w) continue;
    let a = vecAngle(horiz(sub(w[L.rSh], w[L.lSh])), horiz(sub(w[L.rHip], w[L.lHip])));
    if (!Number.isFinite(sep) || a > sep) sep = a;
  }
  m.separation = sep;

  if (wc) {
    m.contactElbow = jointAngle(wc[sd.sh], wc[sd.el], wc[sd.wr]);
    const H = bodyHeight(frames, start, end);
    m.contactReach = ((wc[L.nose][1] - wc[sd.wr][1]) / H) * 100;
    m.contactTrunk = vecAngle(sub(mid(wc[L.lSh], wc[L.rSh]), mid(wc[L.lHip], wc[L.rHip])), UP);
  } else { m.contactElbow = m.contactReach = m.contactTrunk = NaN; }

  m.landingKnee = W(landing) && landingSeen ? kneeAngle(W(landing)) : NaN;
  return m;
}

// 影像空間推估騰空高度（公尺）：最低那隻腳離地多少。影像位移 × (世界軀幹長 / 影像軀幹長)
export function liftSeries(frames, a, b) {
  const foot = []; const scale = [];
  for (let i = a; i <= b; i++) {
    const f = frames[i];
    if (!f.img || !f.world) { foot.push(NaN); scale.push(NaN); continue; }
    foot.push(Math.max(f.img[L.lAn][1], f.img[L.rAn][1], f.img[L.lFt][1], f.img[L.rFt][1]));
    const ti = dist(mid(f.img[L.lSh], f.img[L.rSh]), mid(f.img[L.lHip], f.img[L.rHip]));
    const tw = dist(mid(f.world[L.lSh], f.world[L.rSh]), mid(f.world[L.lHip], f.world[L.rHip]));
    scale.push(tw / ti);
  }
  const ff = fillGaps(foot); const sc = fillGaps(scale);
  const ground = Math.max(...ff.filter(Number.isFinite));
  return ff.map((y, k) => Math.round(Math.max(0, Math.min(1.4, (ground - y) * sc[k])) * 1000) / 1000);
}
