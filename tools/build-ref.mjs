// 產生 site/data/reference.json（用網站同一份 pose.js ＋ metrics.js）
//   standards ← docs/literature.json（文獻判定範圍）
//   reference ← manifest 中 verified:true 的石川片段，且蹲低、落地都有拍到（才顯示矯正骨架）
//   demos     ← 其餘有偵測到扣球的片段（只做首頁示範，不參與判定）
// 用法：node tools/build-ref.mjs   （已跑過的片段讀 ref-clips/_frames 快取）
import fs from 'node:fs';
import path from 'node:path';
import { runPose } from './run-pose.mjs';
import { selectSpiker, cleanFrames, detectSpikes, computeMetrics, liftSeries, METRIC_DEFS, imageSeries } from '../site/js/metrics.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLIPS = path.join(ROOT, 'ref-clips');
const manifestPath = path.join(CLIPS, 'manifest.json');
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : [];
const cacheDir = path.join(CLIPS, '_frames');
fs.mkdirSync(cacheDir, { recursive: true });

const STORED = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 31, 32];
const r3 = (v) => Math.round(v * 1000) / 1000;
const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const isIshikawa = (e) => /ishikawa|石川/i.test(e.player);
const cacheOf = (e) => path.join(cacheDir, path.basename(e.file) + '.json');
const byAbs = (f) => manifest.find((e) => path.resolve(CLIPS, e.file) === f);

const todo = manifest.filter((e) => !fs.existsSync(cacheOf(e)));
if (todo.length) {
  const abs = todo.map((e) => path.resolve(CLIPS, e.file));
  const res = await runPose(abs, (f) => Math.round(byAbs(f).fps) || 30, (f) => byAbs(f).crop ?? null);
  for (const e of todo) fs.writeFileSync(cacheOf(e), JSON.stringify(res[path.resolve(CLIPS, e.file)]));
}

const refClips = []; const demos = []; const report = [];
for (const e of manifest) {
  const raw = JSON.parse(fs.readFileSync(cacheOf(e), 'utf8'));
  const frames = cleanFrames(selectSpiker(raw.frames));
  const seen = frames.filter((f) => f.world).length;
  const spikes = detectSpikes(frames);
  report.push(`${path.basename(e.file)}｜${e.player}｜${frames.length} 格｜抓到人 ${seen}（${Math.round((seen / frames.length) * 100)}%）｜扣球 ${spikes.length}`);
  if (!spikes.length) continue;
  const ser = imageSeries(frames);
  const sp = spikes.sort((a, b) => ser.h[b.arm][b.contact] - ser.h[a.arm][a.contact])[0];
  const m = computeMetrics(frames, sp);
  const fr = frames.slice(sp.start, sp.end + 1);
  let prev = fr.find((f) => f.world)?.world;
  const clip = {
    id: path.basename(e.file).replace(/\.\w+$/, ''), player: e.player, country: e.country,
    source_url: e.source_url, source_start: e.source_start, arm: sp.arm,
    metrics: Object.fromEntries(METRIC_DEFS.map((d) => [d.key, r1(m[d.key])])),
    pose: {
      fps: raw.fps,
      events: { start: 0, crouch: sp.crouch - sp.start, contact: sp.contact - sp.start, landing: sp.landing - sp.start, end: sp.end - sp.start },
      // 缺格用前一格補，播放才不會斷
      frames: fr.map((f) => { if (f.world) prev = f.world; return STORED.map((j) => prev[j].map(r3)); }),
      lift: liftSeries(frames, sp.start, sp.end),
    },
  };
  const complete = sp.crouchSeen && sp.landingSeen;
  const isRef = isIshikawa(e) && e.verified === true && complete;
  (isRef ? refClips : demos).push(clip);
  report.push(`  → ${isRef ? '對照骨架' : '示範'}｜${sp.arm} 手｜擊球 F${sp.contact}（${frames[sp.contact].t.toFixed(2)}s）｜蹲低${sp.crouchSeen ? '有' : '沒'}拍到、落地${sp.landingSeen ? '有' : '沒'}拍到｜`
    + METRIC_DEFS.map((d) => `${d.label} ${clip.metrics[d.key]}`).join('，'));
}

const litPath = path.join(ROOT, 'docs', 'literature.json');
const standards = fs.existsSync(litPath) ? JSON.parse(fs.readFileSync(litPath, 'utf8')) : {};
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const reference = refClips.length ? {
  player: refClips[0].player,
  clips: refClips,
  metrics: Object.fromEntries(METRIC_DEFS.map((d) => { const v = refClips.map((c) => c.metrics[d.key]).filter((x) => x != null); return [d.key, v.length ? r1(mean(v)) : null]; })),
} : null;

const out = { generated: new Date().toISOString(), model: 'pose_landmarker_full (MediaPipe tasks-vision 1.0.1)', standards, reference, demos };
fs.mkdirSync(path.join(ROOT, 'site', 'data'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'site', 'data', 'reference.json'), JSON.stringify(out));
fs.writeFileSync(path.join(CLIPS, 'build-report.txt'), report.join('\n'));
console.log(report.join('\n'));
console.log(`standards: ${Object.values(standards).filter((s) => s?.range).length}/${METRIC_DEFS.length} 項有範圍；reference: ${reference ? reference.clips.length + ' 球' : '無'}；demos: ${demos.length}`);
