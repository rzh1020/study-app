// 诊断：Chrome 假音频设备到底送来什么信号，我们的检测链路能不能读到。
import puppeteer from 'puppeteer-core';
import http from 'http';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = await new Promise((r) => {
  const s = http.createServer(async (req, res) => {
    let p = req.url.split('?')[0]; if (p === '/') p = '/index.html';
    const f = join(root, p);
    if (!existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': (MIME[extname(f)] || 'application/octet-stream') + '; charset=utf-8' });
    res.end(await readFile(f));
  });
  s.listen(8198, () => r(s));
});

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: 'shell',
  args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
page.on('console', (m) => console.log('  [page]', m.text()));
page.on('pageerror', (e) => console.log('  [err]', e.message));
await browser.defaultBrowserContext().overridePermissions('http://127.0.0.1:8198', ['microphone']);
await page.goto('http://127.0.0.1:8198/index.html', { waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 1200));

const diag = await page.evaluate(async () => {
  const { mic } = await import('./js/audio.js');
  const { detectPitch, decimate } = await import('./js/pitch.js');
  await mic.start();
  const out = [];
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 50));
    mic.analyser.getFloatTimeDomainData(mic.buf);
    let sq = 0, peak = 0;
    for (const v of mic.buf) { sq += v * v; if (Math.abs(v) > peak) peak = Math.abs(v); }
    const rms = Math.sqrt(sq / mic.buf.length);
    const dec = decimate(mic.buf, mic.decFactor);
    const p = detectPitch(dec, mic.sampleRate / mic.decFactor, { rmsGate: 0 });
    out.push({ rms: +rms.toFixed(5), peak: +peak.toFixed(4), hz: +p.hz.toFixed(1), clar: +p.clarity.toFixed(2) });
  }
  return { sr: mic.sampleRate, dec: mic.decFactor, frames: out };
});

console.log('sampleRate', diag.sr, 'decFactor', diag.dec);
const nz = diag.frames.filter((f) => f.rms > 0.0005);
console.log(`有信号帧 ${nz.length}/40`);
console.log('RMS 范围', Math.min(...diag.frames.map(f => f.rms)), '~', Math.max(...diag.frames.map(f => f.rms)));
console.log('前 12 帧:');
diag.frames.slice(0, 12).forEach((f, i) => console.log(` ${String(i).padStart(2)} rms=${f.rms} peak=${f.peak} hz=${f.hz} clarity=${f.clar}`));
const detected = diag.frames.filter((f) => f.hz > 0);
console.log(`检出音高帧 ${detected.length}/40`, detected.length ? `示例 ${detected.slice(0,5).map(f=>f.hz+'Hz').join(' ')}` : '');

await browser.close();
server.close();
