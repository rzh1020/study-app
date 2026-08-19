// 验证 js/asr.js 的 SenseVoice 实现（fbank + LFR + CMVN + CTC 都是自己写的，
// 必须逐参数对齐训练时的前端，否则输出是乱码）。
//
// 判据来自官方 python 实现在同一台机器上跑同一批音频的结果：
//   test_zh.wav → 开饭时间早上九点至下午五点
//   test_ja.wav → うちの中学は弁当制で持っていきない場合は50円の学校販売のパンを買う
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream', '.txt': 'text/plain', '.bin': 'application/octet-stream',
  '.png': 'image/png', '.svg': 'image/svg+xml' };

const CASES = [
  { wav: '.asr/sensevoice/test_zh.wav', want: '开饭时间早上九点至下午五点', lang: 'zh' },
  { wav: '.asr/sensevoice/test_ja.wav', want: 'うちの中学は弁当制で持っていきない場合は50円の学校販売のパンを買う', lang: 'ja' },
];

/** 读 16bit PCM wav（这两个测试文件都是 16kHz 单声道）。 */
function readWav(p) {
  const b = readFileSync(p);
  let off = 12;
  let sr = 16000, bits = 16, ch = 1, dataOff = -1, dataLen = 0;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const sz = b.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      ch = b.readUInt16LE(off + 10);
      sr = b.readUInt32LE(off + 12);
      bits = b.readUInt16LE(off + 22);
    } else if (id === 'data') { dataOff = off + 8; dataLen = sz; break; }
    off += 8 + sz + (sz % 2);
  }
  const n = Math.floor(dataLen / (bits / 8) / ch);
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    pcm[i] = b.readInt16LE(dataOff + i * ch * 2) / 32768;
  }
  return { pcm, sr };
}

function serve(port) {
  const server = http.createServer(async (q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const f = join(root, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!f.startsWith(root) || !existsSync(f)) { r.writeHead(404); r.end('404'); return; }
    r.writeHead(200, { 'Content-Type': MIME[extname(f)] || 'application/octet-stream',
                       'Cache-Control': 'no-store' });
    r.end(await readFile(f));
  });
  return new Promise((r) => server.listen(port, () => r(server)));
}

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  PASS  ${n}`); }
  else { fail++; console.log(`  FAIL  ${n}  ${e}`); } };

async function main() {
  const srv = await serve(8223);
  const b = await puppeteer.launch({
    executablePath: ['/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => existsSync(p)),
    headless: 'shell', args: ['--no-sandbox', '--disable-dev-shm-usage'],
    protocolTimeout: 900000,
  });
  const page = await b.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('http://127.0.0.1:8223/index.html', { waitUntil: 'domcontentloaded' });

  console.log('\n=== 加载 SenseVoice（int8 229MB）===');
  const ld = await page.evaluate(async () => {
    const A = await import('./js/asr.js');
    const okk = await A.load();
    return { okk, ms: A.state.ms, err: A.state.error };
  });
  ok('模型加载成功', ld.okk === true, ld.err || '');
  if (!ld.okk) { console.log(`\n结果: ${pass} passed, ${fail} failed`); await b.close(); srv.close(); process.exit(1); }
  console.log(`  INFO  加载耗时 ${ld.ms}ms`);

  console.log('\n=== 对照官方 python 结果 ===');
  for (const c of CASES) {
    const { pcm, sr } = readWav(join(root, c.wav));
    const r = await page.evaluate(async (arr, rate) => {
      const A = await import('./js/asr.js');
      const pcm = A.resample16k(Float32Array.from(arr), rate);
      return A.recognize(pcm);
    }, Array.from(pcm), sr);
    console.log(`  ${c.wav.split('/').pop()}  ${(pcm.length / sr).toFixed(1)}s 音频`);
    console.log(`    期望: ${c.want}`);
    console.log(`    实得: ${r.text}`);
    console.log(`    语言: ${r.lang}（期望 ${c.lang}）  识别 ${r.ms}ms  RTF ${(r.ms / 1000 / (pcm.length / sr)).toFixed(3)}`);
    ok(`识别结果与官方一致 (${c.lang})`, r.text === c.want, `得到「${r.text}」`);
    ok(`语言判别正确 (${c.lang})`, r.lang === c.lang, String(r.lang));
  }
  ok('无页面错误', errors.length === 0, errors.slice(0, 2).join(' | '));
  console.log(`\n结果: ${pass} passed, ${fail} failed`);
  await b.close();
  srv.close();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
