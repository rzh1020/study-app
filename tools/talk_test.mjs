// 面对面对话的端到端验证：用 Chrome 的假麦克风喂一段日语音频进去，
// 走完「录音 → 离线识别 → 神经翻译 → 显示」。
//
// 音频用我们自己的 TTS 合成（tools/tts_test.mjs 会写到 /tmp/studyhub-tts/），
// 这样不需要人来录音就能回归整条链路。
import http from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const WAV = process.argv[2] || '/tmp/studyhub-tts/00.wav';   // これはいくらですか
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream', '.bin': 'application/octet-stream',
  '.png': 'image/png', '.svg': 'image/svg+xml' };

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!existsSync(WAV)) {
    console.error(`缺测试音频 ${WAV}，先跑 node tools/tts_test.mjs 生成`);
    process.exit(1);
  }
  const srv = await serve(8221);
  const b = await puppeteer.launch({
    executablePath: ['/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => existsSync(p)),
    headless: 'shell',
    args: ['--no-sandbox', '--disable-dev-shm-usage',
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${WAV}`,
      '--autoplay-policy=no-user-gesture-required'],
    protocolTimeout: 1800000,
  });
  const page = await b.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('http://127.0.0.1:8221/index.html#/talk', { waitUntil: 'domcontentloaded' });
  await sleep(1500);

  ok('对话页渲染出说话按钮', (await page.$('#tkMic')) !== null);
  ok('语言选择按钮都在（默认自动）', (await page.$('#tkAuto')) !== null
    && (await page.$('#tkZh')) !== null && (await page.$('#tkJa')) !== null);

  // 不指定语言，靠模型自己判 —— 这正是要验证的能力
  console.log('\n=== 载入识别模型并录音 ===');
  await page.click('#tkMic');
  // 等模型加载完并真正开始录音
  await page.waitForFunction(
    () => /在听/.test((document.querySelector('#tkHint') || {}).textContent || ''),
    { timeout: 300000 });
  console.log('  已开始录音，采 4 秒');
  await sleep(1200);
  const lvl = await page.evaluate(() => {
    const b = document.querySelector('#tkLevel');
    return { on: b && b.classList.contains('on'), w: b && b.firstElementChild.style.width };
  });
  console.log(`  录音电平条: 显示=${lvl.on} 宽度=${lvl.w}`);
  ok('录音时显示输入电平', lvl.on === true, JSON.stringify(lvl));
  await sleep(2800);
  await page.click('#tkMic');          // 第二次点击 = 说完
  console.log('  识别+翻译中…');
  // 等译文真的出现，而不是等状态文字消失 —— 状态还会经过「载入翻译模型…」
  // （内存受限，一次只留一个翻译方向，换向要重新加载）
  await page.waitForFunction(
    () => {
      const me = (document.querySelector('.tk-me') || {}).innerText || '';
      return /[\u4e00-\u9fff]/.test(me) && !/点「中文」说一句/.test(me);
    }, { timeout: 900000 });
  await sleep(500);

  const shown = await page.evaluate(() => ({
    them: (document.querySelector('.tk-them') || {}).innerText || '',
    me: (document.querySelector('.tk-me') || {}).innerText || '',
    hint: (document.querySelector('#tkHint') || {}).textContent || '',
  }));
  console.log(`  上半屏(给对方看): ${shown.them.replace(/\n/g, ' | ')}`);
  console.log(`  下半屏(给我看)  : ${shown.me.replace(/\n/g, ' | ')}`);
  console.log(`  状态: ${shown.hint}`);

  // 说的是日语，所以「给我看」的那半屏应该出现中文译文
  ok('识别并翻译出了内容', /[\u4e00-\u9fff]/.test(shown.me) && !/点「中文」说一句/.test(shown.me),
    shown.me.slice(0, 60));
  // 识别原文必须回显，否则用户没法判断是听错还是翻错
  ok('把识别到的原文回显给说话人', /あなたの発話|听到你说/.test(shown.them + shown.me),
    (shown.them + '|' + shown.me).slice(0, 100));
  ok('提供「听错了，重说」', (await page.$('[data-redo]')) !== null);
  ok('译文不是空的', shown.me.replace(/\s/g, '').length > 2, shown.me);
  ok('无页面错误', errors.length === 0, errors.slice(0, 2).join(' | '));

  console.log(`\n结果: ${pass} passed, ${fail} failed`);
  await b.close();
  srv.close();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
