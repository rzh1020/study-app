// 离线翻译（js/nmt.js）在真实浏览器里的验证。
//
// 为什么要单独一个脚本而不是塞进 e2e：模型 280MB，加载要几秒，
// 每次跑 e2e 都带上它太拖；这个脚本只管翻译质量和耗时。
//
// 用法：node tools/nmt_test.mjs [句子...]
import http from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream', '.png': 'image/png', '.svg': 'image/svg+xml',
};

function serve(port) {
  const server = http.createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const file = join(root, normalize(p).replace(/^(\.\.[/\\])+/, ''));
      if (!file.startsWith(root) || !existsSync(file)) { res.writeHead(404); res.end('404'); return; }
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream',
                           'Cache-Control': 'no-store' });
      res.end(body);
    } catch (e) { res.writeHead(500); res.end(String(e)); }
  });
  return new Promise((r) => server.listen(port, () => r(server)));
}

function findChrome() {
  for (const c of ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (existsSync(c)) return c;
  }
  throw new Error('找不到 Chrome');
}

// 默认用旅游场景的真实句子，而不是教科书例句
const CASES = process.argv.slice(2).length ? process.argv.slice(2) : [
  '这个多少钱',
  '请问车站怎么走',
  '可以用手机支付吗',
  '我对花生过敏，这个里面有花生吗',
  '不好意思，能帮我拍张照吗',
  '这附近有没有便宜又好吃的拉面店',
  '我想退掉这张票，需要手续费吗',
  '麻烦给我一杯不加冰的水',
];

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${extra}`); }
}

async function main() {
  const PORT = 8207;
  const server = await serve(PORT);
  const browser = await puppeteer.launch({
    executablePath: findChrome(), headless: 'shell',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-features=SharedArrayBuffer'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });

  console.log('\n=== 加载模型（encoder 106MB + decoder 162MB int8）===');
  const loaded = await page.evaluate(async () => {
    const N = await import('./js/nmt.js');
    const t0 = performance.now();
    const okk = await N.load();
    return { okk, ms: Math.round(performance.now() - t0), err: N.state.error };
  });
  ok('模型加载成功', loaded.okk === true, loaded.err || '');
  if (!loaded.okk) { console.log('  加载失败，后面的翻译测试跳过'); }
  else console.log(`  INFO  加载耗时 ${loaded.ms}ms`);

  if (loaded.okk) {
    console.log('\n=== 分词自检（源端必须用 source.spm 的 id，不能有大量 unk）===');
    const tk = await page.evaluate(async () => {
      const N = await import('./js/nmt.js');
      const s = '这附近有没有便宜又好吃的拉面店';
      const ids = N.encode(s);
      return { ids, unk: ids.filter((i) => i === 0).length };
    });
    ok('中文不再被切成 unk', tk.unk === 0, `unk=${tk.unk} ids=${tk.ids.slice(0, 8)}`);
    ok('分词结果长度合理', tk.ids.length >= 4 && tk.ids.length <= 24, String(tk.ids.length));

    console.log('\n=== 翻译（beam 4）===');
    const results = await page.evaluate(async (cases) => {
      const N = await import('./js/nmt.js');
      const out = [];
      for (const c of cases) {
        try {
          const r = await N.translate(c, { beams: 4 });
          out.push({ src: c, ...r });
        } catch (e) { out.push({ src: c, text: '', err: String(e && e.message || e) }); }
      }
      return out;
    }, CASES);
    let totalMs = 0;
    for (const r of results) {
      console.log(`  ${r.src}\n    → ${r.text || '(空)'}${r.err ? '  ERR ' + r.err : ''}   ${r.ms || 0}ms`);
      if (r.alts && r.alts.length) console.log(`      备选: ${r.alts.join(' / ')}`);
      totalMs += r.ms || 0;
    }
    ok('全部句子都有输出', results.every((r) => r.text && r.text.length > 0));
    ok('输出是日语（含平假名或片假名）',
      results.filter((r) => /[\u3040-\u30ff]/.test(r.text)).length >= results.length - 1);
    ok('没有把中文原样吐回来', results.every((r) => r.text !== r.src));
    console.log(`\n  INFO  平均 ${Math.round(totalMs / results.length)}ms/句（桌面 Chrome 单线程 wasm）`);
  }

  ok('无页面错误', errors.length === 0, errors.slice(0, 2).join(' | '));
  console.log(`\n结果: ${pass} passed, ${fail} failed`);
  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
