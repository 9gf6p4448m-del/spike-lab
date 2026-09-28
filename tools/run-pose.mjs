// 用網站同一份 pose.js 在無頭 Chromium 跑影片，輸出逐格關節點 JSON。
// 用法：node tools/run-pose.mjs <影片> <輸出.json> [fps]
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { serve } from './serve.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
export async function runPose(files, fpsFor = () => 30, cropFor = () => null) {
  const srv = await serve(ROOT);
  const port = srv.address().port;
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
  await page.goto(`http://localhost:${port}/tools/harness.html`);
  await page.waitForFunction(() => window.ready);
  const results = {};
  for (const f of files) {
    const webm = path.join(ROOT, 'ref-clips', '_webm', path.basename(f).replace(/\.\w+$/, '.webm'));
    fs.mkdirSync(path.dirname(webm), { recursive: true });
    if (!fs.existsSync(webm)) execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', f, ...(cropFor(f) ? ['-vf', `crop=${cropFor(f)},scale=-2:720`] : []), '-an','-c:v', 'libvpx-vp9', '-b:v', '3M', '-deadline', 'realtime', '-cpu-used', '8', webm]);
    const rel = '/' + path.relative(ROOT, webm).split(path.sep).join('/');
    const fps = fpsFor(f);
    const t0 = Date.now();
    results[f] = await page.evaluate(async ({ rel, fps }) => {
      const v = document.createElement('video'); v.muted = true; v.preload = 'auto'; v.src = rel;
      await new Promise((r, j) => { v.onloadeddata = r; v.onerror = () => j(new Error('video load failed')); });
      const out = await window.P.analyzeVideo(v, { fps });
      return out;
    }, { rel, fps });
    const hit = results[f].frames.filter((x) => x.people?.length).length;
    console.error(`${path.basename(f)}: ${results[f].frames.length} 格，偵測到人 ${hit} 格，${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  await browser.close(); srv.close();
  return results;
}

if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) {
  const [src, out, fps] = process.argv.slice(2);
  const r = await runPose([path.resolve(src)], () => Number(fps) || 30);
  fs.writeFileSync(out, JSON.stringify(Object.values(r)[0]));
}
