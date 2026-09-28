// 從 ref-clips/manifest.json 產生 site/data/reference.json（用網站同一份 pose.js ＋ metrics.js）
// 用法：node tools/build-ref.mjs   （已跑過的片段會讀 ref-clips/_frames 快取）
import fs from 'node:fs';
import path from 'node:path';
import { runPose } from './run-pose.mjs';
import { selectSpiker, cleanFrames, detectSpikes, computeMetrics, METRIC_DEFS, imageSeries } from '../site/js/metrics.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLIPS = path.join(ROOT, 'ref-clips');
const manifest = JSON.parse(fs.readFileSync(path.join(CLIPS, 'manifest.json'), 'utf8'));
const cacheDir = path.join(CLIPS, '_frames');
fs.mkdirSync(cacheDir, { recursive: true });

const STORED = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 31, 32];
const r3 = (v) => Math.round(v * 1000) / 1000;
const isIshikawa = (e) => /ishikawa|石川/i.test(e.player);

const todo = manifest.filter((e) => !fs.existsSync(path.join(cacheDir, path.basename(e.file) + '.json')));
if (todo.length) {
  const abs = todo.map((e) => path.resolve(CLIPS, e.file));
  const res = await runPose(abs, (f) => Math.round(manifest.find((e) => path.resolve(CLIPS, e.file) === f).fps) || 30, (f) => manifest.find((e) => path.resolve(CLIPS, e.file) === f).crop ?? null);
  for (const e of todo) fs.writeFileSync(path.join(cacheDir, path.basename(e.file) + '.json'), JSON.stringify(res[path.resolve(CLIPS, e.file)]));
}

function liftSeries(frames, a, b) {
  // 與 app.js 同邏輯（騰空高度）
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], (p[2] ?? 0) - (q[2] ?? 0));
  const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, ((p[2] ?? 0) + (q[2] ?? 0)) / 2];
  const foot = []; const sc = [];
  for (let i = a; i <= b; i++) {
    const f = frames[i];
    if (!f.img || !f.world) { foot.push(NaN); sc.push(NaN); continue; }
    foot.push(Math.max(f.img[27][1], f.img[28][1], f.img[31][1], f.img[32][1]));
    sc.push(dist(mid(f.world[11], f.world[12]), mid(f.world[23], f.world[24])) / dist(mid(f.img[11], f.img[12]), mid(f.img[23], f.img[24])));
  }
  const fill = (arr) => { let lastv = arr.find(Number.isFinite) ?? 0; return arr.map((v) => (Number.isFinite(v) ? (lastv = v) : lastv)); };
  const ff = fill(foot); const s = fill(sc); const g = Math.max(...ff);
  return ff.map((y, k) => r3(Math.max(0, Math.min(1.4, (g - y) * s[k]))));
}

const clips = []; const report = [];
for (const e of manifest) {
  const raw = JSON.parse(fs.readFileSync(path.join(cacheDir, path.basename(e.file) + '.json'), 'utf8'));
  const frames = cleanFrames(selectSpiker(raw.frames));
  const seen = frames.filter((f) => f.world).length;
  const spikes = detectSpikes(frames);
  report.push(`${path.basename(e.file)}｜${e.player}｜${frames.length} 格｜抓到人 ${seen}（${Math.round((seen / frames.length) * 100)}%）｜扣球 ${spikes.length}`);
  if (!spikes.length) continue;
  // 一個片段原則上一球；多球時取擊球格高度最高者
  const ser = imageSeries(frames);
  const sp = spikes.sort((a, b) => ser.h[b.arm][b.contact] - ser.h[a.arm][a.contact])[0];
  const m = computeMetrics(frames, sp);
  const id = path.basename(e.file).replace(/\.\w+$/, '');
  const clip = {
    id, player: e.player, country: e.country, source_url: e.source_url, source_start: e.source_start,
    arm: sp.arm, primary: isIshikawa(e), metrics: Object.fromEntries(Object.entries(m).filter(([k]) => METRIC_DEFS.some((d) => d.key === k)).map(([k, v]) => [k, Number.isFinite(v) ? Math.round(v * 10) / 10 : null])),
  };
  if (isIshikawa(e)) {
    const fr = frames.slice(sp.start, sp.end + 1);
    // 缺格用前一格補，確保播放不斷
    let prev = fr.find((f) => f.world)?.world;
    clip.pose = {
      fps: raw.fps,
      events: { start: 0, crouch: sp.crouch - sp.start, contact: sp.contact - sp.start, landing: sp.landing - sp.start, end: sp.end - sp.start },
      frames: fr.map((f) => { if (f.world) prev = f.world; return STORED.map((j) => prev[j].map(r3)); }),
      lift: liftSeries(frames, sp.start, sp.end),
    };
  }
  clips.push(clip);
  report.push(`  → ${sp.arm} 手，擊球 F${sp.contact}（${frames[sp.contact].t.toFixed(2)}s），` + METRIC_DEFS.map((d) => `${d.label} ${clip.metrics[d.key]}`).join('，'));
}

const keys = METRIC_DEFS.map((d) => d.key);
const ish = clips.filter((c) => c.primary);
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const summary = {
  ishikawa: Object.fromEntries(keys.map((k) => { const v = ish.map((c) => c.metrics[k]).filter((x) => x != null); return [k, v.length ? Math.round(mean(v) * 10) / 10 : null]; })),
  range: Object.fromEntries(keys.map((k) => { const v = clips.map((c) => c.metrics[k]).filter((x) => x != null); return [k, v.length ? [Math.min(...v), Math.max(...v)] : null]; })),
  counts: { players: new Set(clips.map((c) => c.player)).size, clips: clips.length },
};
const missingFile = path.join(CLIPS, 'missing.md');
const out = { generated: new Date().toISOString(), model: 'pose_landmarker_full (MediaPipe tasks-vision 1.0.1)', summary, clips, missing: fs.existsSync(missingFile) ? (fs.readFileSync(missingFile, 'utf8').match(/^##\s*(.+)$/gm) ?? []).map((s) => s.replace(/^##\s*/, '')) : [] };
fs.mkdirSync(path.join(ROOT, 'site', 'data'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'site', 'data', 'reference.json'), JSON.stringify(out));
fs.writeFileSync(path.join(CLIPS, 'build-report.txt'), report.join('\n'));
console.log(report.join('\n'));
console.log('summary', JSON.stringify(summary));
