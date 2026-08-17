/**
 * 验证部署方式：哪种 origin 下麦克风和 Service Worker 真的可用。
 *
 * 这不是可选的核查——getUserMedia 和 SW 都要求「安全上下文」，
 * 如果 http://局域网IP 不算安全上下文，那「PC 起个 http server 手机访问」
 * 这条最直觉的部署路径会直接废掉麦克风。必须实测而不是靠记忆断言。
 */
import puppeteer from 'puppeteer-core';
import http from 'http';
import { readFile } from 'fs/promises';
import { existsSync, readdirSync } from 'fs';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const PORT = 8197;

function lanIP() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return null;
}

const server = await new Promise((r) => {
  const s = http.createServer(async (req, res) => {
    let p = req.url.split('?')[0];
    if (p === '/') p = '/index.html';
    const f = join(root, p);
    if (!existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': (MIME[extname(f)] || 'application/octet-stream') + '; charset=utf-8' });
    res.end(await readFile(f));
  });
  s.listen(PORT, '0.0.0.0', () => r(s));
});

const ip = lanIP();
console.log('局域网 IP:', ip || '(未检测到)');

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: 'shell',
  args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});

const origins = [
  ['http://127.0.0.1', `http://127.0.0.1:${PORT}/index.html`],
  ['http://localhost', `http://localhost:${PORT}/index.html`],
];
if (ip) origins.push([`http://${ip} (局域网IP)`, `http://${ip}:${PORT}/index.html`]);

console.log('\norigin'.padEnd(32) + 'secureContext  mediaDevices  serviceWorker  getUserMedia');
console.log('-'.repeat(92));
for (const [label, url] of origins) {
  const page = await browser.newPage();
  let r;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    r = await page.evaluate(async () => {
      const out = {
        secure: window.isSecureContext,
        md: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
        sw: 'serviceWorker' in navigator,
        gum: 'n/a',
      };
      if (out.md) {
        try {
          const s = await navigator.mediaDevices.getUserMedia({ audio: true });
          s.getTracks().forEach((t) => t.stop());
          out.gum = 'OK';
        } catch (e) { out.gum = e.name; }
      } else out.gum = 'API 不存在';
      return out;
    });
  } catch (e) {
    r = { secure: '-', md: '-', sw: '-', gum: 'goto失败: ' + e.message.slice(0, 30) };
  }
  console.log(
    label.padEnd(32) +
    String(r.secure).padEnd(15) +
    String(r.md).padEnd(14) +
    String(r.sw).padEnd(15) +
    r.gum
  );
  await page.close();
}

// 非安全上下文下的降级行为：必须给出可行动的提示，且不能影响日语/练耳
if (ip) {
  console.log('\n=== 非安全上下文降级检查（局域网 IP）===');
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`http://${ip}:${PORT}/index.html`, { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 1800));

  const check = async (hash, label, assertFn) => {
    await page.evaluate((h) => { location.hash = h; }, hash);
    await new Promise((r) => setTimeout(r, 900));
    const text = await page.$eval('#view', (e) => e.innerText).catch(() => '');
    const res = await assertFn(text, page);
    console.log(`  ${res ? 'OK  ' : 'BAD '} ${label}`);
    return res;
  };

  let allOk = true;
  allOk &= await check('#/voice', '音准页显示「麦克风不可用」且说明原因',
    (t) => /麦克风不可用/.test(t) && /局域网 IP 不行/.test(t));
  allOk &= await check('#/voice/range', '音域页也有提示', (t) => /麦克风不可用/.test(t));
  allOk &= await check('#/voice/regression', '回归页也有提示', (t) => /麦克风不可用/.test(t));

  // 点开启麦克风：应该出 toast 而不是抛异常
  await page.evaluate((h) => { location.hash = h; }, '#/voice');
  await new Promise((r) => setTimeout(r, 900));
  await page.click('#btnStart').catch(() => {});
  await new Promise((r) => setTimeout(r, 600));
  const toastTxt = await page.$eval('#toast', (e) => e.textContent).catch(() => '');
  const toastShown = await page.$eval('#toast', (e) => e.classList.contains('show')).catch(() => false);
  console.log(`  ${toastShown && /非安全上下文/.test(toastTxt) ? 'OK  ' : 'BAD '} 点按钮给出可行动提示: ${toastTxt.slice(0, 50)}`);
  allOk &= toastShown && /非安全上下文/.test(toastTxt);

  allOk &= await check('#/ear/degree', '练耳仍可用（Web Audio 不需要安全上下文）',
    async (t, pg) => (await pg.$$('#opts button')).length >= 2);
  allOk &= await check('#/review/kana_hira', '日语复习仍可用（IndexedDB 不需要安全上下文）',
    async (t, pg) => (await pg.$('#qcard .q-front')) !== null);

  console.log(`  ${errs.length === 0 ? 'OK  ' : 'BAD '} 无未捕获异常 ${errs.slice(0, 2).join(' | ')}`);
  allOk &= errs.length === 0;
  console.log(allOk ? '\n降级路径正常：局域网 IP 下可用日语+练耳，麦克风相关有明确提示。'
                    : '\n!! 降级路径有问题');
  await page.close();
  if (!allOk) process.exitCode = 1;
}

await browser.close();
server.close();
void readdirSync;
