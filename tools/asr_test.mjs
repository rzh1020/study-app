// 用我们自己的 TTS 合成语音，再喂给 ASR，看能不能识别回原文 —— 闭环验证，
// 不需要人来录音。中文那侧用系统 TTS 合成不了，所以只验证日语链路 +
// 一段合成的中文（用 Kokoro 的中文音色）。
import http from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const M = { '.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css',
  '.json':'application/json','.wasm':'application/wasm','.onnx':'application/octet-stream',
  '.bin':'application/octet-stream','.png':'image/png','.svg':'image/svg+xml','.txt':'text/plain' };
const srv = http.createServer(async (q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = join(root, normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!f.startsWith(root) || !existsSync(f)) { r.writeHead(404); r.end('404'); return; }
  r.writeHead(200, { 'Content-Type': M[extname(f)] || 'application/octet-stream', 'Cache-Control':'no-store' });
  r.end(await readFile(f));
});
await new Promise((r) => srv.listen(8217, r));
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'shell',
  args: ['--no-sandbox','--disable-dev-shm-usage'], protocolTimeout: 1800000 });
const page = await b.newPage();
page.on('pageerror', (e) => console.log('  PAGEERROR', String(e).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') console.log('  CONSOLE', m.text().slice(0, 200)); });
await page.goto('http://127.0.0.1:8217/index.html', { waitUntil: 'domcontentloaded' });
const out = await page.evaluate(async () => {
  const res = {};
  const A = await import('./js/asr.js');
  res.load = await A.load();
  res.err = A.state.error;
  if (!res.load) return res;
  res.loadMs = A.state.ms;
  const T = await import('./js/tts.js');
  await T.load();
  res.cases = [];
  for (const kana of ['これはいくらですか', 'えきへのいきかたをおしえてください']) {
    const s = await T.synth(kana);
    const pcm = A.resample16k(s.pcm instanceof Float32Array ? s.pcm : Float32Array.from(s.pcm), 24000);
    const auto = await A.recognize(pcm);
    const forced = await A.recognize(pcm, { language: 'ja' });
    res.cases.push({ said: kana, auto: auto.text, forcedJa: forced.text,
                     autoMs: auto.ms, forcedMs: forced.ms, sec: s.seconds,
                     rms: Math.sqrt(pcm.reduce((a, x) => a + x * x, 0) / pcm.length).toFixed(3),
                     n: pcm.length });
  }
  return res;
});
console.log(JSON.stringify(out, null, 1));
await b.close(); srv.close();
