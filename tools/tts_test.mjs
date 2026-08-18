// 日语神经语音（js/tts.js + Kokoro）在真实浏览器里的验证。
// 会把合成结果写成 wav 落盘，方便人耳复核 —— 客观指标只能证明"有声音"，
// 好不好听得听。
//
// 用法：node tools/tts_test.mjs ["日语文本" ...]
import http from 'node:http';
import { existsSync, writeFileSync } from 'node:fs';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = '/tmp/studyhub-tts';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream', '.bin': 'application/octet-stream',
  '.png': 'image/png', '.svg': 'image/svg+xml' };

function serve(port) {
  const server = http.createServer(async (req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const f = join(root, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!f.startsWith(root) || !existsSync(f)) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[extname(f)] || 'application/octet-stream',
                         'Cache-Control': 'no-store' });
    res.end(await readFile(f));
  });
  return new Promise((r) => server.listen(port, () => r(server)));
}

function wav(pcm, sr = 24000) {
  const n = pcm.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767))), 44 + i * 2);
  }
  return buf;
}

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${extra}`); }
};

const CASES = process.argv.slice(2).length ? process.argv.slice(2) : [
  'これはいくらですか',
  '駅への行き方を教えてください。',
  '写真を撮ってもらえますか?',
  'チケットをキャンセルしたいのですが、手数料はかかりますか?',
  '今日はいい天気ですね',
];

async function main() {
  await mkdir(OUT, { recursive: true });
  const server = await serve(8213);
  const browser = await puppeteer.launch({
    executablePath: ['/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => existsSync(p)),
    headless: 'shell',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
    protocolTimeout: 900000,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('http://127.0.0.1:8213/index.html', { waitUntil: 'domcontentloaded' });

  console.log('\n=== 加载语音模型（Kokoro int8 90MB）===');
  const ld = await page.evaluate(async () => {
    const T = await import('./js/tts.js');
    const t0 = performance.now();
    const okk = await T.load();
    return { okk, ms: Math.round(performance.now() - t0), err: T.state.error };
  });
  ok('语音模型加载成功', ld.okk === true, ld.err || '');
  if (ld.okk) console.log(`  INFO  加载耗时 ${ld.ms}ms`);

  if (ld.okk) {
    console.log('\n=== 汉字→假名→音素→波形 ===');
    const results = await page.evaluate(async (cases) => {
      const T = await import('./js/tts.js');
      const J = await import('./js/jaspeech.js');
      await J.loadDict();
      const out = [];
      for (const text of cases) {
        try {
          const kana = J.toKana(text).kana;
          const r = await T.synth(kana);
          out.push({ text, kana, phonemes: r.phonemes, unknown: r.unknown,
                     seconds: r.seconds, ms: r.ms,
                     peak: Math.max(...Array.from(r.pcm).map(Math.abs)).toFixed(3),
                     pcm: Array.from(r.pcm) });
        } catch (e) { out.push({ text, err: String((e && e.message) || e) }); }
      }
      return out;
    }, CASES);

    let i = 0;
    for (const r of results) {
      if (r.err) { console.log(`  ${r.text}\n    ERR ${r.err}`); i++; continue; }
      const f = join(OUT, `${String(i).padStart(2, '0')}.wav`);
      writeFileSync(f, wav(r.pcm));
      console.log(`  ${r.text}`);
      console.log(`    假名 ${r.kana}`);
      console.log(`    音素 ${r.phonemes}`);
      console.log(`    ${r.seconds}s  合成 ${r.ms}ms  峰值 ${r.peak}  ${f}`);
      if (r.unknown.length) console.log(`    !! 无法发音的字符: ${r.unknown.join('')}`);
      i++;
    }
    ok('每句都合成出波形', results.every((r) => !r.err && r.seconds > 0.3));
    ok('没有无法发音的字符', results.every((r) => !r.err && r.unknown.length === 0),
      JSON.stringify(results.map((r) => r.unknown).filter((u) => u && u.length)));
    ok('音量正常（未静音也未削波）',
      results.every((r) => !r.err && +r.peak > 0.05 && +r.peak < 0.999));
    // 助词必须按 wa/e 读，这是最容易被忽略又最影响听感的一处
    const p0 = results[0] && results[0].phonemes;
    ok('助词 は 读作 wa', /korewa/.test(p0 || ''), p0 || '');
    const p1 = results[1] && results[1].phonemes;
    ok('助词 へ 读作 e', /ekie/.test(p1 || ''), p1 || '');
    console.log(`\n  合成速度：平均 ${Math.round(results.reduce((a, r) => a + (r.ms || 0), 0) / results.length)}ms/句`);
    console.log(`  波形已写入 ${OUT}，可直接播放试听`);
  }
  ok('无页面错误', errors.length === 0, errors.slice(0, 2).join(' | '));
  console.log(`\n结果: ${pass} passed, ${fail} failed`);
  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
