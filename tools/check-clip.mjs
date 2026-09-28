// 檢查單一參考片段：重跑姿勢（清掉舊快取）→ 挑扣球者 → 偵測扣球 → 輸出疊圖與指標
// 用法：node tools/check-clip.mjs <片段檔名，例如 ishikawa_01.mp4> [crop w:h:x:y]
// 疊圖存到 ref-clips/_check/<檔名>.png：蹲低、拉弓、擊球前後、落地各格，用來親眼確認骨架在目標選手身上
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runPose } from './run-pose.mjs';
import { selectSpiker, cleanFrames, detectSpikes, computeMetrics, METRIC_DEFS, imageSeries } from '../site/js/metrics.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const [clip, crop] = process.argv.slice(2);
const src = path.join(ROOT, 'ref-clips', clip);
const base = path.basename(clip);
fs.rmSync(path.join(ROOT, 'ref-clips/_webm', base.replace(/\.\w+$/, '.webm')), { force: true });
fs.mkdirSync(path.join(ROOT, 'ref-clips/_frames'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'ref-clips/_check'), { recursive: true });
const fps = Math.round(Number(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', src]).toString().trim().split('/').reduce((a, b) => a / b))) || 30;
const res = (await runPose([src], () => fps, () => crop ?? null))[src];
fs.writeFileSync(path.join(ROOT, 'ref-clips/_frames', base + '.json'), JSON.stringify(res));

const frames = cleanFrames(selectSpiker(res.frames));
const seen = frames.filter((f) => f.world).length;
const spikes = detectSpikes(frames);
console.log(`${base}: ${frames.length} 格, 扣球者被抓到 ${seen} 格 (${Math.round((seen / frames.length) * 100)}%), 偵測到扣球 ${spikes.length} 次`);
const ser = imageSeries(frames);
let pick = [];
if (spikes.length) {
  const sp = spikes.sort((a, b) => ser.h[b.arm][b.contact] - ser.h[a.arm][a.contact])[0];
  const m = computeMetrics(frames, sp);
  console.log(`擊球 F${sp.contact} (${frames[sp.contact].t.toFixed(2)}s) 手=${sp.arm} 蹲低 F${sp.crouch} 落地 F${sp.landing} 拉弓 F${m.backswingFrame}`);
  console.log(METRIC_DEFS.map((d) => `${d.label}=${Number.isFinite(m[d.key]) ? m[d.key].toFixed(0) : 'NaN'}`).join(' '));
  const c = sp.contact;
  pick = [sp.start, sp.crouch, m.backswingFrame, c - 4, c - 2, c - 1, c, c + 1, c + 2, c + 4, sp.landing, sp.end]
    .map((x) => Math.max(0, Math.min(frames.length - 1, Number.isFinite(x) ? x : c)));
}
const out = path.join(ROOT, 'ref-clips/_check', base + '.png');
execFileSync('node', [path.join(ROOT, 'tools/contact-sheet.mjs'), base, out, ...(pick.length ? [pick.join(',')] : [])], { stdio: 'inherit' });
console.log('疊圖：' + out + (pick.length ? '（順序：開始、蹲低、拉弓、擊球-4、-2、-1、擊球、+1、+2、+4、落地、結束）' : '（沒偵測到扣球，均勻取 12 格）'));
