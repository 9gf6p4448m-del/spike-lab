// 手機尺寸開網站：抓 console 錯誤、檢查橫向捲動、截圖；可選上傳影片跑完整流程
// 用法：node tools/ui-smoke.mjs <截圖前綴> [影片路徑]
import { chromium } from 'playwright';
import path from 'node:path';
import { serve } from './serve.mjs';
const ROOT = path.resolve(import.meta.dirname, '..');
const [prefix, video] = process.argv.slice(2);
const srv = await serve(ROOT); const port = srv.address().port;
const b = await chromium.launch({ args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errs = []; const reqs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => errs.push('[pageerror] ' + e.message));
page.on('request', (r) => reqs.push(`${r.method()} ${r.url().replace(/^http:\/\/localhost:\d+/, '')} ${r.postData()?.length ?? 0}`));
await page.goto(`http://localhost:${port}/site/index.html`);
await page.waitForTimeout(2500);
const ov = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
console.log('橫向捲動檢查', ov, ov.sw > ov.cw ? 'FAIL' : 'OK');
await page.screenshot({ path: `${prefix}-demo.png`, fullPage: true });
if (video) {
  const before = reqs.length;
  await page.setInputFiles('#file', video);
  await page.waitForFunction(() => /完成|沒有找到|讀不了|失敗/.test(document.getElementById('status').textContent), null, { timeout: 600000 });
  console.log('狀態：', await page.textContent('#status'));
  await page.click('#toContact').catch(() => {});
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${prefix}-user.png`, fullPage: true });
  const after = reqs.slice(before);
  console.log('分析期間的請求：\n' + after.join('\n'));
  console.log('帶 body 的請求數：', after.filter((r) => !r.endsWith(' 0')).length);
}
console.log('console 錯誤／警告：\n' + (errs.join('\n') || '(無)'));
await b.close(); srv.close();
