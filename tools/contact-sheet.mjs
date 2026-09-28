// 把 MediaPipe 抓到的 2D 骨架畫回原影片，輸出 4×3 縮圖表，檢查骨架落在誰身上
// 用法：node tools/contact-sheet.mjs <clip檔名> <輸出.png> [格號,格號,...]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { serve } from './serve.mjs';
import { selectSpiker } from '../site/js/metrics.js';
const ROOT = path.resolve(import.meta.dirname, '..');
const [clip, out, list] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'ref-clips/_frames', clip + '.json'), 'utf8'));
data.frames = selectSpiker(data.frames).map((f) => ({ t: f.t, img: f.img }));
const n = data.frames.length;
const idx = list ? list.split(',').map(Number) : Array.from({ length: 12 }, (_, k) => Math.round((k * (n - 1)) / 11));
const srv = await serve(ROOT); const port = srv.address().port;
const b = await chromium.launch(); const page = await b.newPage({ viewport: { width: 1280, height: 560 } });
await page.goto(`http://localhost:${port}/tools/harness.html`);
await page.evaluate(async ({ src, frames, idx }) => {
  document.body.style.margin = 0; document.body.style.background = '#000';
  const v = document.createElement('video'); v.muted = true; v.src = src;
  await new Promise((r) => { v.onloadeddata = r; });
  const W = 320, H = 180;
  const c = document.createElement('canvas'); c.width = W * 4; c.height = H * 3; document.body.append(c);
  const ctx = c.getContext('2d');
  const segs = [[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28]];
  for (let k = 0; k < idx.length; k++) {
    const f = frames[idx[k]];
    await new Promise((r) => { v.onseeked = r; v.currentTime = f.t; });
    const ox = (k % 4) * W, oy = Math.floor(k / 4) * H;
    ctx.drawImage(v, ox, oy, W, H);
    if (f.img) {
      const asp = v.videoWidth / v.videoHeight;
      const P = (j) => [ox + (f.img[j][0] / asp) * W, oy + f.img[j][1] * H];
      ctx.strokeStyle = '#ff7a1a'; ctx.lineWidth = 2; ctx.beginPath();
      for (const [a, bb] of segs) { ctx.moveTo(...P(a)); ctx.lineTo(...P(bb)); } ctx.stroke();
    }
    ctx.fillStyle = '#ff0'; ctx.font = '14px monospace'; ctx.fillText(`F${idx[k]} ${f.img ? '' : '(無)'}`, ox + 4, oy + 16);
  }
}, { src: '/ref-clips/_webm/' + clip.replace(/\.\w+$/, '.webm'), frames: data.frames, idx });
await page.screenshot({ path: out }); await b.close(); srv.close();
