import { analyzeVideo, loadModel } from './pose.js';
import { selectSpiker, cleanFrames, detectSpikes, computeMetrics, liftSeries, METRIC_DEFS, kneeAngle, jointAngle, vecAngle, sub, mid, L } from './metrics.js';
import { corrected, boneLengths, alignRef, yawDelta, mapIndex } from './retarget.js';
import { createScene, groundOffset } from './scene.js';

const $ = (id) => document.getElementById(id);
const S = createScene($('three'));

// ---------- 參考資料 ----------
// reference.json：
//   standards：每項指標的文獻判定範圍與出處（判定用）
//   reference：通過驗證的參考選手骨架（石川補入後才有；有它才顯示矯正骨架）
//   demos：示範用骨架（不參與判定）
let REF = null;
let PN = null; // 參考選手短名（沒有參考骨架時為 null）
const STORED = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 31, 32]; // 只存這 15 點
function expand(pts) {
  const w = Array.from({ length: 33 }, () => [0, 0, 0]);
  STORED.forEach((j, k) => { w[j] = pts[k]; });
  return w;
}
const hasRef = () => Boolean(REF?.reference?.clips?.length);

// ---------- 狀態 ----------
const st = {
  mode: 'demo', // demo | user
  user: null,   // { frames, fps, spikes: [{...spike, metrics, lengths, lift}] }
  shot: 0,
  i: 0,         // 目前格（使用者影片或示範片段的絕對格號）
  playing: false,
  speed: 0.5,
  demo: null,   // 目前示範片段
  refClip: null, // 目前對照的參考片段（有參考骨架時）
};

// ---------- 分析使用者影片 ----------
let abort = null;
$('file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';
  setPlaying(false);
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
        const left = ((performance.now() - t0) / 1000 / k) * (n - k);
        setStatus(`分析中 ${k} / ${n} 格　約剩 ${Math.ceil(left)} 秒`);
      },
    });
    const frames = cleanFrames(selectSpiker(res.frames));
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

// ---------- 選球 ----------
function selectShot(k) {
  st.shot = k;
  if (st.mode === 'user') {
    const sp = st.user.spikes[k];
    if (hasRef()) {
      const clips = REF.reference.clips;
      st.refClip = clips.find((c) => c.arm === sp.arm) ?? clips[0];
      const r = st.refClip.pose;
      st.mirror = st.refClip.arm !== sp.arm;
      st.yaw = yawDelta(st.user.frames[sp.contact].world, alignRef(expand(r.frames[r.events.contact]), st.mirror, 0));
    }
    st.i = sp.contact;
    $('scrub').min = sp.start; $('scrub').max = sp.end;
    $('demoTag').hidden = true;
    $('headline').textContent = `第 ${k + 1} 球` + (hasRef() ? ` · 對照 ${REF.reference.player}` : '');
    $('lede').textContent = hasRef()
      ? `橘色是你，青色是把你每段骨頭的方向往 ${PN} 同一時刻的動作靠攏後的你，半透明白色是 ${PN} 本人。拖曳 3D 畫面可以轉視角。`
      : '橘色是你的 3D 骨架，拖曳畫面可以轉視角。下方表格把你的數值跟運動生物力學研究量到的範圍比較。';
  } else {
    const r = st.demo.pose;
    st.i = r.events.contact;
    $('scrub').min = 0; $('scrub').max = r.frames.length - 1;
  }
  renderLegend();
  renderChips();
  renderMetrics();
  renderAdvice();
  draw();
}

function renderLegend() {
  const user = st.mode === 'user';
  const items = [];
  if (user) items.push('<span><i style="background:var(--you)"></i>你的動作</span>');
  if (user && hasRef()) items.push('<span><i style="background:var(--fix)"></i>矯正後</span>');
  if (hasRef() && user) items.push(`<span><i style="background:var(--ghost);opacity:.5"></i>${REF.reference.player}</span>`);
  if (!user) items.push(`<span><i style="background:var(--ghost)"></i>範例：${st.demo.player}（示範用）</span>`);
  $('legend').innerHTML = items.join('');
  $('refToggles').hidden = !(user && hasRef());
}

function renderChips() {
  const box = $('chips'); box.innerHTML = '';
  const lab = document.createElement('span'); lab.className = 'hint';
  if (st.mode === 'user') {
    lab.textContent = '選球'; box.append(lab);
    st.user.spikes.forEach((sp, k) => {
      const b = document.createElement('button');
      b.className = 'chip' + (outCount(sp.metrics) ? ' bad' : '');
      b.setAttribute('aria-pressed', k === st.shot);
      b.innerHTML = `<span class="dot"></span>第 ${k + 1} 球 ${fmtT(st.user.frames[sp.contact].t)}`;
      b.onclick = () => selectShot(k);
      box.append(b);
    });
  } else if (REF.demos.length > 1) {
    lab.textContent = '範例'; box.append(lab);
    REF.demos.forEach((c) => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.setAttribute('aria-pressed', c === st.demo);
      b.textContent = c.player;
      b.onclick = () => { st.demo = c; selectShot(0); };
      box.append(b);
    });
  }
}

const fmtT = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const fmt = (v, unit) => (Number.isFinite(v) ? `${Math.round(v)}${unit}` : '—');

// ---------- 判定 ----------
// 判定範圍＝文獻範圍兩端各放寬量測誤差 tol；沒有文獻範圍的指標只顯示不判定
function judgeRange(key) {
  const r = REF.standards[key]?.range; const d = METRIC_DEFS.find((x) => x.key === key);
  return r ? [r[0] - d.tol, r[1] + d.tol] : null;
}
function status(key, v) {
  const r = judgeRange(key);
  if (!r || !Number.isFinite(v)) return 0;
  if (v < r[0]) return -1;
  if (v > r[1]) return 1;
  return 0;
}
const litText = (d) => { const r = REF.standards[d.key]?.range; return r ? `${Math.round(r[0])}–${Math.round(r[1])}${d.unit}` : '<span class="muted">無文獻</span>'; };
const outCount = (m) => METRIC_DEFS.filter((d) => status(d.key, m[d.key]) !== 0).length;

function renderMetrics() {
  const user = st.mode === 'user' ? st.user.spikes[st.shot].metrics : null;
  const refM = hasRef() ? REF.reference.metrics : null;
  $('shotTitle').textContent = user ? `第 ${st.shot + 1} 球的數據` : '判定標準（運動生物力學研究）';
  let html = `<tr><th>指標</th>${user ? '<th>你</th>' : ''}<th>研究範圍</th>${refM ? `<th>${PN}</th>` : ''}</tr>`;
  for (const d of METRIC_DEFS) {
    const s = user ? status(d.key, user[d.key]) : 0;
    const youCell = !user ? ''
      : `<td class="you ${s ? 'out' : ''}">${Number.isFinite(user[d.key]) ? fmt(user[d.key], d.unit) : '<span class="muted">沒拍到</span>'}${s ? ` <span class="pill">${s < 0 ? '偏低' : '偏高'}</span>` : ''}</td>`;
    html += `<tr><td>${d.label}<small>${d.note}</small></td>${youCell}<td>${litText(d)}</td>${refM ? `<td>${fmt(refM[d.key], d.unit)}</td>` : ''}</tr>`;
  }
  $('metrics').innerHTML = html;
}

// ---------- 建議 ----------
const ADVICE = {
  takeoffKnee: {
    '1': '起跳前蹲得不夠深。最後兩步踩下時，髖和膝一起往下沉，雙手同時往後擺到底，把力量存在腿上再往上爆發。',
    '-1': '起跳前蹲得比研究範圍還深。蹲太深會讓起跳變慢，試著蹲淺一點、更快地往上跳。',
  },
  backswingElbow: {
    '-1': '拉弓時手肘太低。起跳後擊球手要往後上方拉，手肘至少和肩同高，像拉弓一樣，揮臂才有足夠的距離加速。',
    '1': '拉弓時手肘抬得比研究範圍更高，只要揮臂順暢就不一定是問題，留意肩膀有沒有卡住。',
  },
  separation: {
    '-1': '擊球前身體轉開得不夠，肩膀和髖幾乎一起轉。起跳後先把擊球側的肩膀往後拉開，再由髖帶動肩膀轉回來擊球（這項數值受拍攝角度影響大，看趨勢就好）。',
    '1': '肩髖扭轉比研究範圍大，可能是拍攝角度造成的深度誤差，先看其他指標。',
  },
  contactElbow: {
    '-1': '擊球時手臂沒有伸直，擊球點被壓低了。等球落到手臂伸直能碰到的最高點再打，手肘在擊球瞬間要打開。',
    '1': '擊球時手臂比研究範圍還直，這通常不是問題。',
  },
  contactReach: {
    '-1': '擊球點偏低。起跳時機可能太晚或太早，試著在最高點、手臂伸直時在頭部前上方觸球。',
    '1': '擊球點比研究範圍還高，很好。',
  },
  contactTrunk: {
    '1': '擊球時身體傾斜太多。軀幹保持比較直立，讓力量從腹部往上傳到手臂，而不是整個人往前倒。',
    '-1': '擊球時身體太直、沒有收腹。擊球瞬間腹部要往前收，把軀幹的力量帶進手臂。',
  },
  landingKnee: {
    '1': '落地時膝蓋太直，衝擊直接傳到膝蓋和腰。落地時雙腳著地、膝蓋和髖一起彎曲緩衝。',
    '-1': '落地時膝蓋彎得比研究範圍還深，緩衝是夠的，留意能不能馬上站穩準備下一球。',
  },
};

function renderAdvice() {
  const ul = $('advice');
  if (st.mode !== 'user') {
    ul.innerHTML = '<li class="good"><b>先上傳一支你的扣球影片</b><p>分析完成後，這裡會列出你和研究範圍差最多的地方，以及具體的練習方向。</p></li>';
    return;
  }
  const m = st.user.spikes[st.shot].metrics;
  const items = [];
  for (const d of METRIC_DEFS) {
    const s = status(d.key, m[d.key]);
    if (!s) continue;
    const r = REF.standards[d.key].range;
    const gap = (s < 0 ? r[0] - m[d.key] : m[d.key] - r[1]) / Math.max(1, r[1] - r[0]);
    items.push({ gap, html: `<li><b>${d.label}：你 ${fmt(m[d.key], d.unit)}，研究範圍 ${litText(d)}</b><p>${ADVICE[d.key][String(s)]}</p></li>` });
  }
  items.sort((a, b) => b.gap - a.gap);
  const unseen = METRIC_DEFS.filter((d) => !Number.isFinite(m[d.key])).map((d) => d.label);
  const tail = unseen.length ? `<li class="good"><b>這支影片沒拍到：${unseen.join('、')}</b><p>下次從助跑前拍到落地站穩，這幾項就能一起分析。</p></li>` : '';
  ul.innerHTML = (items.length ? items.map((x) => x.html).join('')
    : '<li class="good"><b>這一球有研究範圍的指標都在範圍內</b><p>可以在 3D 畫面裡慢速播放，檢查蹲低、拉弓、擊球的時間順序順不順。</p></li>') + tail;
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
    const w = f.world;
    const lift = sp.lift[st.i - sp.start] ?? 0;
    const ev = { start: sp.start, crouch: sp.crouch, contact: sp.contact, landing: sp.landing, end: sp.end };
    if (Math.abs(st.i - sp.contact) <= 1) [L.rWr, L.lWr, L.rEl, L.lEl].forEach((j) => hi.add(j));
    let fixW = null;
    if (hasRef()) {
      const r = st.refClip.pose;
      const ri = mapIndex(st.i, ev, r.events);
      const refW = alignRef(expand(r.frames[ri]), st.mirror, st.yaw);
      if (w) fixW = corrected(w, refW, sp.lengths, 0.75);
      S.you.set(w, [-0.55, groundOffset(w) + lift], hi);
      S.fix.set($('showFix').checked && fixW ? fixW : null, [0.55, groundOffset(fixW) + lift], hi);
      S.ghost.mat.opacity = 0.28;
      S.ghost.set($('showGhost').checked ? refW : null, [0.55, groundOffset(refW) + (r.lift[ri] ?? 0)]);
    } else {
      S.you.set(w, [0, groundOffset(w) + lift], hi);
      S.fix.set(null); S.ghost.set(null);
    }
    hud(angles(w, sp.arm), fixW ? angles(fixW, sp.arm) : null);
    $('phase').textContent = phaseName(st.i, ev);
    $('tlabel').textContent = `${f.t.toFixed(2)}s · F${st.i}`;
    drawOverlay(f);
  } else {
    const c = st.demo; const r = c.pose;
    const w = expand(r.frames[st.i]);
    S.you.set(null); S.fix.set(null);
    S.ghost.mat.opacity = 0.9;
    if (Math.abs(st.i - r.events.contact) <= 1) [L.rWr, L.lWr].forEach((j) => hi.add(j));
    S.ghost.set(w, [0, groundOffset(w) + (r.lift[st.i] ?? 0)], hi);
    hud(null, null, angles(w, c.arm));
    $('phase').textContent = st.i === r.events.contact ? '擊球' : (st.i < r.events.contact ? '擊球前' : '擊球後');
    $('tlabel').textContent = `${c.player} · F${st.i}`;
  }
  $('scrub').value = st.i;
  S.render();
}

function hud(a, b, g) {
  const rows = [['膝角', 'knee'], ['擊球臂肘角', 'elbow'], ['上臂抬高', 'raise'], ['軀幹傾角', 'trunk']];
  const t = $('hudTable');
  if (g) {
    t.innerHTML = '<tr><th></th><th>範例</th></tr>' + rows.map(([n, k]) => `<tr><td>${n}</td><td>${fmt(g[k], '°')}</td></tr>`).join('');
    return;
  }
  t.innerHTML = `<tr><th></th><th class="y">你</th>${b ? '<th class="f">矯正</th>' : ''}</tr>`
    + rows.map(([n, k]) => `<tr><td>${n}</td><td class="y">${fmt(a?.[k], '°')}</td>${b ? `<td class="f">${fmt(b[k], '°')}</td>` : ''}</tr>`).join('');
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
  for (const [a, b] of segs) { ctx.moveTo(...P(a)); ctx.lineTo(...P(b)); }
  ctx.stroke();
  ctx.fillStyle = '#ffd1ad';
  for (const j of [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) { const p = P(j); ctx.beginPath(); ctx.arc(p[0], p[1], ctx.lineWidth * 1.3, 0, 7); ctx.fill(); }
}

// ---------- 播放控制 ----------
function bounds() {
  if (st.mode === 'user') { const sp = st.user.spikes[st.shot]; return [sp.start, sp.end, sp.contact, st.user.fps]; }
  const r = st.demo.pose; return [0, r.frames.length - 1, r.events.contact, r.fps];
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

// ---------- 文字與出處 ----------
function applyNames() {
  PN = hasRef() ? (/ishikawa|石川/i.test(REF.reference.player) ? '石川' : REF.reference.player.split(' ').pop()) : null;
  const d = st.demo;
  $('metaFile').textContent = d ? `範例：${d.player}` : '範例';
  $('headline').textContent = hasRef() ? `跟 ${REF.reference.player} 比一比` : '拍一球，看懂你的扣球';
  $('ghostToggle').textContent = PN ? ` 顯示 ${PN}` : '';
  $('refNotice').hidden = false;
  $('refNotice').innerHTML = hasRef()
    ? `對照骨架：${REF.reference.player}（${REF.reference.clips.length} 球）。判定標準用運動生物力學研究的數值。`
    : '<b>石川祐希的對照骨架補充中。</b>目前判定標準用運動生物力學研究量到的數值（出處在頁面最下方）；補上石川的影片之後，會多出「往石川動作調整後的你」這副青色骨架。';
}

function renderSources() {
  const lit = METRIC_DEFS.map((d) => {
    const s = REF.standards[d.key];
    if (!s?.range) return `<div><b>${d.label}</b>：沒有找到對應的研究數值，只顯示、不判定。</div>`;
    const cites = (s.sources ?? []).map((c) => (c.url ? `<a href="${c.url}" target="_blank" rel="noopener">${c.cite}</a>` : c.cite)).join('；');
    return `<div><b>${d.label}</b>：${Math.round(s.range[0])}–${Math.round(s.range[1])}${d.unit}。${cites}${s.conversion ? `<br><span class="fine">${s.conversion}</span>` : ''}</div>`;
  }).join('');
  const demos = REF.demos.map((c) => `<a href="${c.source_url}" target="_blank" rel="noopener">${c.player}（${c.country}）</a>`).join('、');
  const refs = hasRef() ? REF.reference.clips.map((c, k) => `<a href="${c.source_url}" target="_blank" rel="noopener">第 ${k + 1} 球</a>`).join('、') : '';
  $('sources').innerHTML = lit
    + (refs ? `<div><b>對照骨架</b>：${REF.reference.player}，${refs}</div>` : '')
    + (demos ? `<div><b>首頁範例骨架</b>：${demos}（慢動作重播片段，只拍到空中階段，僅供示範，不參與判定）</div>` : '');
}

// ---------- 啟動 ----------
(async () => {
  try {
    REF = await (await fetch('./data/reference.json')).json();
  } catch {
    setStatus('參考資料載入失敗，請重新整理頁面。', true);
    return;
  }
  st.demo = REF.demos[0] ?? null;
  applyNames();
  renderSources();
  if (st.demo) { selectShot(0); setPlaying(true); } else { renderMetrics(); renderAdvice(); }
})();

// 給自動化測試用的唯讀窗口
window.__spikeLab = { st, get ref() { return REF; } };
