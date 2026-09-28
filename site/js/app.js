import { analyzeVideo, loadModel } from './pose.js';
import { cleanFrames, detectSpikes, computeMetrics, METRIC_DEFS, kneeAngle, jointAngle, vecAngle, sub, mid, dist, L, fillGaps } from './metrics.js';
import { corrected, boneLengths, alignRef, yawDelta, mapIndex, withCenters } from './retarget.js';
import { createScene, groundOffset } from './scene.js';

const $ = (id) => document.getElementById(id);
const S = createScene($('three'));

// ---------- 參考資料 ----------
let REF = null;
const STORED = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 31, 32]; // reference.json 只存這 15 點
function expand(pts) {
  const w = Array.from({ length: 33 }, () => [0, 0, 0]);
  STORED.forEach((j, k) => { w[j] = pts[k]; });
  return w;
}

// ---------- 狀態 ----------
const st = {
  mode: 'demo', // demo | user
  user: null,   // { frames, fps, spikes: [{...spike, metrics, lengths, lift}] }
  shot: 0,
  i: 0,         // 目前格（使用者影片或參考片段的絕對格號）
  playing: false,
  speed: 0.5,
  refClip: null,
};

// 影像空間推估騰空高度（公尺）：最低那隻腳離地多少
function liftSeries(frames, a, b) {
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
  return ff.map((y, k) => Math.max(0, Math.min(1.4, (ground - y) * sc[k])));
}

// ---------- 分析使用者影片 ----------
let abort = null;
$('file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';
  const video = $('video');
  if (video.src) URL.revokeObjectURL(video.src);
  video.src = URL.createObjectURL(file);
  $('videoCard').hidden = false;
  $('metaFile').textContent = file.name;
  setStatus('讀取影片…');
  $('progWrap').hidden = false; $('cancel').hidden = false;
  abort = new AbortController();
  try {
    await loadModel((m) => setStatus(m));
    await new Promise((r, j) => {
      if (video.readyState >= 2) return r();
      video.addEventListener('loadeddata', r, { once: true });
      video.addEventListener('error', () => j(new Error('這支影片的格式瀏覽器讀不了，換一支 MP4 或 MOV 試試。')), { once: true });
    });
    const t0 = performance.now();
    const res = await analyzeVideo(video, {
      fps: 30,
      signal: abort.signal,
      onProgress: (k, n) => {
        $('prog').style.width = `${(k / n) * 100}%`;
        const el = (performance.now() - t0) / 1000;
        const left = (el / k) * (n - k);
        setStatus(`分析中 ${k} / ${n} 格　約剩 ${Math.ceil(left)} 秒`);
      },
    });
    const frames = cleanFrames(res.frames);
    const seen = frames.filter((f) => f.world).length;
    const spikes = detectSpikes(frames);
    if (!spikes.length) {
      setStatus(`看完 ${frames.length} 格，其中 ${seen} 格有抓到人，但沒有找到扣球動作。確認助跑到落地都在畫面裡、擊球手有舉過頭。`, true);
      return;
    }
    for (const sp of spikes) {
      sp.metrics = computeMetrics(frames, sp);
      sp.lengths = boneLengths(frames, sp.start, sp.end);
      sp.lift = liftSeries(frames, sp.start, sp.end);
    }
    st.user = { frames, fps: res.fps, spikes };
    st.mode = 'user';
    setStatus(`完成：${frames.length} 格中 ${seen} 格抓到人（${Math.round((seen / frames.length) * 100)}%），找到 ${spikes.length} 球。`);
    selectShot(0);
  } catch (err) {
    if (err.name === 'AbortError') setStatus('已取消。');
    else { console.error(err); setStatus(err.message || String(err), true); }
  } finally {
    $('cancel').hidden = true; $('progWrap').hidden = true;
  }
});
$('cancel').addEventListener('click', () => abort?.abort());

function setStatus(msg, err = false) {
  $('status').textContent = msg;
  $('status').classList.toggle('err', err);
}

// ---------- 選球、畫面 ----------
function primaryRef(arm) {
  const clips = REF.clips.filter((c) => c.primary && c.pose);
  return clips.find((c) => c.arm === arm) ?? clips[0];
}

function selectShot(k) {
  st.shot = k;
  if (st.mode === 'user') {
    const sp = st.user.spikes[k];
    st.refClip = primaryRef(sp.arm);
    const r = st.refClip.pose;
    st.yaw = yawDelta(st.user.frames[sp.contact].world, expand(r.frames[r.events.contact]));
    st.mirror = st.refClip.arm !== sp.arm;
    if (st.mirror) st.yaw = yawDelta(st.user.frames[sp.contact].world, alignRef(expand(r.frames[r.events.contact]), true, 0));
    st.i = sp.contact;
    $('scrub').min = sp.start; $('scrub').max = sp.end;
    $('demoTag').hidden = true;
    $('headline').textContent = `第 ${k + 1} 球 · 對照 ${st.refClip.player}`;
    $('lede').textContent = `橘色是你，青色是把你每段骨頭的方向往 ${st.refClip.player} 同一時刻的動作靠攏後的你，半透明白色是 ${st.refClip.player} 本人。拖曳 3D 畫面可以轉視角。`;
  } else {
    const r = st.refClip.pose;
    st.i = r.events.contact;
    $('scrub').min = 0; $('scrub').max = r.frames.length - 1;
  }
  renderChips();
  renderMetrics();
  renderAdvice();
  draw();
}

function renderChips() {
  const box = $('chips'); box.innerHTML = '';
  if (st.mode === 'user') {
    const lab = document.createElement('span'); lab.className = 'hint'; lab.textContent = '選球';
    box.append(lab);
    st.user.spikes.forEach((sp, k) => {
      const b = document.createElement('button');
      b.className = 'chip' + (outCount(sp.metrics) ? ' bad' : '');
      b.setAttribute('aria-pressed', k === st.shot);
      const t = st.user.frames[sp.contact].t;
      b.innerHTML = `<span class="dot"></span>第 ${k + 1} 球 ${fmtT(t)}`;
      b.onclick = () => selectShot(k);
      box.append(b);
    });
  } else {
    const lab = document.createElement('span'); lab.className = 'hint'; lab.textContent = '範例';
    box.append(lab);
    REF.clips.filter((c) => c.pose).forEach((c) => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.setAttribute('aria-pressed', c === st.refClip);
      b.textContent = `${c.player} · ${c.label ?? c.id}`;
      b.onclick = () => { st.refClip = c; selectShot(0); };
      box.append(b);
    });
  }
}

const fmtT = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const fmt = (v, unit) => (Number.isFinite(v) ? `${Math.round(v)}${unit}` : '—');

function status(key, v) {
  const r = REF.summary.range[key];
  if (!r || !Number.isFinite(v)) return 0;
  if (v < r[0]) return -1;
  if (v > r[1]) return 1;
  return 0;
}
const outCount = (m) => METRIC_DEFS.filter((d) => status(d.key, m[d.key]) !== 0).length;

function renderMetrics() {
  const t = $('metrics');
  const ish = REF.summary.ishikawa;
  const user = st.mode === 'user' ? st.user.spikes[st.shot].metrics : null;
  const n = REF.summary.counts;
  $('shotTitle').textContent = user ? `第 ${st.shot + 1} 球的數據` : `石川祐希 vs 職業範圍（${n.players} 位選手、${n.clips} 球）`;
  let html = `<tr><th>指標</th>${user ? '<th>你</th>' : ''}<th>石川</th><th>職業範圍</th></tr>`;
  for (const d of METRIC_DEFS) {
    const r = REF.summary.range[d.key];
    const s = user ? status(d.key, user[d.key]) : 0;
    html += `<tr><td>${d.label}<small>${d.note}</small></td>`
      + (user ? `<td class="you ${s ? 'out' : ''}">${fmt(user[d.key], d.unit)}${s ? ` <span class="pill">${s < 0 ? '偏低' : '偏高'}</span>` : ''}</td>` : '')
      + `<td>${fmt(ish[d.key], d.unit)}</td><td>${r ? `${Math.round(r[0])}–${Math.round(r[1])}${d.unit}` : '—'}</td></tr>`;
  }
  t.innerHTML = html;
}

// ---------- 建議 ----------
const ADVICE = {
  takeoffKnee: {
    '1': '起跳前蹲得不夠深。最後兩步踩下時，髖和膝一起往下沉，雙手同時往後擺到底，把力量存在腿上再往上爆發。',
    '-1': '起跳前蹲得比職業選手還深。蹲太深會讓起跳變慢，試著蹲到大約大腿和地面呈 45° 就往上跳。',
  },
  backswingElbow: {
    '-1': '拉弓時手肘太低。起跳後擊球手要往後上方拉，手肘至少和肩同高，像拉弓一樣，揮臂才有足夠的距離加速。',
    '1': '拉弓時手肘抬得比職業選手更高，只要揮臂順暢就不一定是問題，留意肩膀有沒有卡住。',
  },
  separation: {
    '-1': '擊球前身體轉開得不夠，肩膀和髖幾乎一起轉。起跳後先把擊球側的肩膀往後拉開，再由髖帶動肩膀轉回來擊球（這項數值受拍攝角度影響大，看趨勢就好）。',
    '1': '肩髖扭轉比職業範圍大，可能是拍攝角度造成的深度誤差，先看其他指標。',
  },
  contactElbow: {
    '-1': '擊球時手臂沒有伸直，擊球點被壓低了。等球落到手臂伸直能碰到的最高點再打，手肘在擊球瞬間要打開。',
    '1': '擊球時手臂比職業範圍還直，這通常不是問題。',
  },
  contactReach: {
    '-1': '擊球點偏低。起跳時機可能太晚或太早，試著在最高點、手臂伸直時在頭部前上方觸球。',
    '1': '擊球點比職業範圍還高，很好。',
  },
  contactTrunk: {
    '1': '擊球時身體傾斜太多。軀幹保持比較直立，讓力量從腹部往上傳到手臂，而不是整個人往前倒。',
    '-1': '擊球時身體太直、沒有收腹。擊球瞬間腹部要往前收，把軀幹的力量帶進手臂。',
  },
  landingKnee: {
    '1': '落地時膝蓋太直，衝擊直接傳到膝蓋和腰。落地時雙腳著地、膝蓋和髖一起彎曲緩衝。',
    '-1': '落地時膝蓋彎得比職業範圍還深，緩衝是夠的，留意能不能馬上站穩準備下一球。',
  },
};

function renderAdvice() {
  const ul = $('advice'); ul.innerHTML = '';
  if (st.mode !== 'user') {
    ul.innerHTML = '<li class="good"><b>先上傳一支你的扣球影片</b><p>分析完成後，這裡會列出你和職業範圍差最多的地方，以及具體的練習方向。</p></li>';
    return;
  }
  const m = st.user.spikes[st.shot].metrics;
  const items = [];
  for (const d of METRIC_DEFS) {
    const s = status(d.key, m[d.key]);
    if (!s) continue;
    const r = REF.summary.range[d.key];
    const gap = s < 0 ? r[0] - m[d.key] : m[d.key] - r[1];
    items.push({ gap: gap / Math.max(1, r[1] - r[0]), html: `<li><b>${d.label}：你 ${fmt(m[d.key], d.unit)}，職業範圍 ${Math.round(r[0])}–${Math.round(r[1])}${d.unit}，石川 ${fmt(REF.summary.ishikawa[d.key], d.unit)}</b><p>${ADVICE[d.key][String(s)]}</p></li>` });
  }
  items.sort((a, b) => b.gap - a.gap);
  if (!items.length) ul.innerHTML = '<li class="good"><b>這一球每項指標都落在職業範圍內</b><p>接下來可以比對 3D 畫面，看動作的時間順序（蹲低、拉弓、擊球）跟石川有沒有差別。</p></li>';
  else ul.innerHTML = items.map((x) => x.html).join('');
}

// ---------- 逐格繪製 ----------
function phaseName(i, ev) {
  if (i < ev.crouch - 3) return '助跑';
  if (i <= ev.crouch + 1) return '蹲低起跳';
  if (i < ev.contact - 1) return '拉弓';
  if (i <= ev.contact + 1) return '擊球';
  if (i < ev.landing - 1) return '收臂下降';
  return '落地';
}

function angles(w, arm) {
  if (!w) return null;
  const s = arm === 'R' ? [L.rSh, L.rEl, L.rWr] : [L.lSh, L.lEl, L.lWr];
  const trunkDown = sub(mid(w[L.lHip], w[L.rHip]), mid(w[L.lSh], w[L.rSh]));
  return {
    knee: kneeAngle(w),
    elbow: jointAngle(w[s[0]], w[s[1]], w[s[2]]),
    raise: vecAngle(sub(w[s[1]], w[s[0]]), trunkDown),
    trunk: vecAngle(sub(mid(w[L.lSh], w[L.rSh]), mid(w[L.lHip], w[L.rHip])), [0, -1, 0]),
  };
}

function draw() {
  const hi = new Set();
  if (st.mode === 'user') {
    const sp = st.user.spikes[st.shot];
    const f = st.user.frames[st.i];
    const r = st.refClip.pose;
    const ev = { start: sp.start, crouch: sp.crouch, contact: sp.contact, landing: sp.landing, end: sp.end };
    const ri = mapIndex(st.i, ev, r.events);
    const refW = alignRef(expand(r.frames[ri]), st.mirror, st.yaw);
    const lift = sp.lift[st.i - sp.start] ?? 0;
    const w = f.world;
    if (Math.abs(st.i - sp.contact) <= 1) [L.rWr, L.lWr, L.rEl, L.lEl].forEach((j) => hi.add(j));
    let fixW = null;
    if (w) {
      fixW = corrected(w, refW, sp.lengths, 0.75);
      S.you.set(w, [-0.55, groundOffset(w) + lift], hi);
      S.fix.set($('showFix').checked ? fixW : null, [0.55, groundOffset(fixW) + lift], hi);
    } else { S.you.set(null); S.fix.set(null); }
    S.ghost.mat.opacity = 0.28;
    S.ghost.set($('showGhost').checked ? refW : null, [0.55, groundOffset(refW) + (r.lift[ri] ?? 0)]);
    const a = angles(w, sp.arm); const b = angles(fixW, sp.arm);
    hud(a, b);
    $('phase').textContent = phaseName(st.i, ev);
    $('tlabel').textContent = `${f.t.toFixed(2)}s · F${st.i}`;
    drawOverlay(f);
  } else {
    const c = st.refClip; const r = c.pose;
    const w = expand(r.frames[st.i]);
    S.you.set(null); S.fix.set(null);
    S.ghost.mat.opacity = 0.9;
    if (Math.abs(st.i - r.events.contact) <= 1) [L.rWr, L.lWr].forEach((j) => hi.add(j));
    S.ghost.set(w, [0, groundOffset(w) + (r.lift[st.i] ?? 0)], hi);
    hud(null, null, angles(w, c.arm));
    $('phase').textContent = phaseName(st.i, r.events);
    $('tlabel').textContent = `${c.player} · F${st.i}`;
  }
  $('scrub').value = st.i;
  S.render();
}

function hud(a, b, g) {
  const rows = [['膝角', 'knee'], ['擊球臂肘角', 'elbow'], ['上臂抬高', 'raise'], ['軀幹傾角', 'trunk']];
  const t = $('hudTable');
  if (g) {
    t.innerHTML = '<tr><th></th><th>石川</th></tr>' + rows.map(([n, k]) => `<tr><td>${n}</td><td>${fmt(g[k], '°')}</td></tr>`).join('');
    return;
  }
  t.innerHTML = '<tr><th></th><th class="y">你</th><th class="f">矯正</th></tr>'
    + rows.map(([n, k]) => `<tr><td>${n}</td><td class="y">${fmt(a?.[k], '°')}</td><td class="f">${fmt(b?.[k], '°')}</td></tr>`).join('');
}

// 原始影片上疊 2D 骨架（播放中節流，避免手機一直 seek）
let lastSeek = 0;
function drawOverlay(f) {
  const v = $('video'); const c = $('overlay');
  if (!v.videoWidth) return;
  const now = performance.now();
  if (!st.playing || now - lastSeek > 120) { v.currentTime = f.t; lastSeek = now; }
  c.width = v.videoWidth; c.height = v.videoHeight;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  if (!f.img) return;
  const aspect = v.videoWidth / v.videoHeight;
  const P = (j) => [(f.img[j][0] / aspect) * c.width, f.img[j][1] * c.height];
  ctx.strokeStyle = '#ff7a1a'; ctx.lineWidth = Math.max(2, c.width / 250); ctx.lineCap = 'round';
  const segs = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28], [27, 31], [28, 32]];
  ctx.beginPath();
  for (const [a, b] of segs) { const p = P(a); const q = P(b); ctx.moveTo(...p); ctx.lineTo(...q); }
  ctx.stroke();
  ctx.fillStyle = '#ffd1ad';
  for (const j of [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) { const p = P(j); ctx.beginPath(); ctx.arc(p[0], p[1], ctx.lineWidth * 1.3, 0, 7); ctx.fill(); }
}

// ---------- 播放控制 ----------
function bounds() {
  if (st.mode === 'user') { const sp = st.user.spikes[st.shot]; return [sp.start, sp.end, sp.contact, st.user.fps]; }
  const r = st.refClip.pose; return [0, r.frames.length - 1, r.events.contact, r.fps];
}
let acc = 0; let last = 0;
function tick(ts) {
  if (!st.playing) return;
  const [a, b, , fps] = bounds();
  acc += ((ts - last) / 1000) * fps * st.speed; last = ts;
  if (acc >= 1) {
    const step = Math.floor(acc); acc -= step;
    st.i += step;
    if (st.i > b) st.i = a;
    draw();
  }
  requestAnimationFrame(tick);
}
function setPlaying(p) {
  st.playing = p;
  $('play').textContent = p ? '❚❚ 暫停' : '▶ 播放';
  $('play').setAttribute('aria-label', p ? '暫停' : '播放');
  if (p) { last = performance.now(); acc = 0; requestAnimationFrame(tick); }
}
$('play').onclick = () => setPlaying(!st.playing);
$('toContact').onclick = () => { setPlaying(false); st.i = bounds()[2]; draw(); };
$('speed').onclick = () => {
  const opts = [0.25, 0.5, 1]; st.speed = opts[(opts.indexOf(st.speed) + 1) % opts.length];
  $('speed').textContent = `速度 ${st.speed}×`;
};
$('scrub').oninput = (e) => { setPlaying(false); st.i = Number(e.target.value); draw(); };
$('showGhost').onchange = draw;
$('showFix').onchange = draw;

function renderSources() {
  const byP = {};
  for (const c of REF.clips) (byP[`${c.player}（${c.country}）`] ??= []).push(c);
  $('sources').innerHTML = Object.entries(byP).map(([p, cs]) => `<div>${p}：${cs.map((c, k) => `<a href="${c.source_url}" target="_blank" rel="noopener">第 ${k + 1} 球</a>`).join('、')}</div>`).join('')
    + (REF.missing?.length ? `<div class="fine">找不到合格片段：${REF.missing.join('、')}</div>` : '');
}

// ---------- 啟動 ----------
(async () => {
  try {
    REF = await (await fetch('./data/reference.json')).json();
  } catch {
    setStatus('參考資料載入失敗，請重新整理頁面。', true);
    return;
  }
  st.refClip = REF.clips.find((c) => c.primary && c.pose) ?? REF.clips.find((c) => c.pose);
  renderSources();
  selectShot(0);
  setPlaying(true);
})();

// 給自動化測試用的唯讀窗口
window.__spikeLab = { st, get ref() { return REF; } };
