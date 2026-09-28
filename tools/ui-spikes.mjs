import { chromium } from 'playwright';
import path from 'node:path';
import { serve } from './serve.mjs';
// 用網站本身（手機尺寸）上傳影片，印出偵測到的每一球：用法 node tools/ui-spikes.mjs <影片>
const srv = await serve(path.resolve(import.meta.dirname, '..')); const port = srv.address().port;
const b = await chromium.launch({ args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
const page = await b.newPage({ viewport: { width: 390, height: 844 } });
await page.goto(`http://localhost:${port}/site/index.html`);
await page.setInputFiles('#file', process.argv[2]);
await page.waitForFunction(() => /完成|沒有找到/.test(document.getElementById('status').textContent), null, { timeout: 600000 });
const r = await page.evaluate(() => { const u = window.__spikeLab.st.user; return u.spikes.map((s) => ({ contactT: u.frames[s.contact].t, arm: s.arm, crouchSeen: s.crouchSeen, landingSeen: s.landingSeen, m: s.metrics })); });
console.log(await page.textContent('#status'));
console.log(JSON.stringify(r, null, 1));
await b.close(); srv.close();
