/**
 * 真机验证离线翻译（js/nmt.js + APK 内 280MB int8 模型）。
 *
 * 单独一个脚本而不是并进 verify_device.mjs：模型加载要几秒、每句推理约一秒，
 * 混进主验证会把它拖成分钟级。这里只关心三件事 ——
 * 模型能不能从 APK assets 里加载、翻译对不对、手机上要多久。
 *
 * 用法：node android/verify_nmt.mjs ["自定义句子" ...]
 */
import { execSync } from 'child_process';
import puppeteer from 'puppeteer-core';

const PKG = 'com.rzh.studyhub';
const PORT = 9334;
const sh = (c) => execSync(c, { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${extra}`); }
}

const CASES = process.argv.slice(2).length ? process.argv.slice(2) : [
  '这个多少钱',
  '请问车站怎么走',
  '不好意思，能帮我拍张照吗',
  '我想退掉这张票，需要手续费吗',
];

const pid = sh(`adb shell pidof ${PKG}`).split(/\s+/)[0];
if (!pid) {
  console.error(`${PKG} 没在运行：adb shell am start -n ${PKG}/.MainActivity`);
  process.exit(1);
}
const sock = `webview_devtools_remote_${pid}`;
try { execSync(`adb forward --remove tcp:${PORT}`, { stdio: 'ignore' }); } catch { /* 没有就算了 */ }
sh(`adb forward tcp:${PORT} localabstract:${sock}`);
const ver = JSON.parse(sh(`curl -s -m 10 http://127.0.0.1:${PORT}/json/version`));

const browser = await puppeteer.connect({
  browserWSEndpoint: ver.webSocketDebuggerUrl,
  defaultViewport: null,
  // 手机单线程 wasm 跑一句要数秒到数十秒，默认 180s 会在多句时超时
  protocolTimeout: 1800000,
});
const pages = await browser.pages();
const page = pages.find((p) => p.url().includes('appassets')) || pages[0];
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

console.log(`\n=== 模型加载（从 APK assets，encoder 106MB + decoder 162MB）===`);
const load = await page.evaluate(async () => {
  const N = await import('./js/nmt.js');
  const t0 = performance.now();
  const okk = await N.load();
  return { okk, ms: Math.round(performance.now() - t0), err: N.state.error };
});
ok('模型从 APK 内加载成功', load.okk === true, load.err || '');
if (load.okk) console.log(`  INFO  加载耗时 ${load.ms}ms`);

if (load.okk) {
  console.log('\n=== 翻译（beam 4，手机单线程 wasm）===');
  const res = await page.evaluate(async (cases) => {
    const N = await import('./js/nmt.js');
    const out = [];
    for (const c of cases) {
      try { out.push({ src: c, ...(await N.translate(c, { beams: 4 })) }); }
      catch (e) { out.push({ src: c, text: '', err: String(e && e.message || e) }); }
    }
    return out;
  }, CASES);
  let total = 0;
  for (const r of res) {
    console.log(`  ${r.src}\n    → ${r.text || '(空)'}${r.err ? '  ERR ' + r.err : ''}   ${r.ms || 0}ms`);
    total += r.ms || 0;
  }
  ok('每句都有输出', res.every((r) => r.text && r.text.length));
  ok('输出是日语', res.filter((r) => /[\u3040-\u30ff]/.test(r.text)).length >= res.length - 1);
  console.log(`  INFO  平均 ${Math.round(total / res.length)}ms/句`);
}
console.log('\n=== 日语神经语音（Kokoro int8 90MB）===');
const tts = await page.evaluate(async () => {
  const T = await import('./js/tts.js');
  const J = await import('./js/jaspeech.js');
  const t0 = performance.now();
  const okk = await T.load();
  const loadMs = Math.round(performance.now() - t0);
  if (!okk) return { okk, loadMs, err: T.state.error };
  await J.loadDict();
  const out = [];
  for (const text of ['これはいくらですか', '駅への行き方を教えてください。',
                      'チケットをキャンセルしたいのですが、手数料はかかりますか?']) {
    const kana = J.toKana(text).kana;
    const t1 = performance.now();
    const r = await T.synth(kana);
    out.push({ text, kana, phonemes: r.phonemes, seconds: r.seconds,
               ms: Math.round(performance.now() - t1), unknown: r.unknown.length });
  }
  return { okk, loadMs, out };
});
ok('语音模型从 APK 内加载成功', tts.okk === true, tts.err || '');
if (tts.okk) {
  console.log(`  INFO  加载耗时 ${tts.loadMs}ms`);
  for (const r of tts.out) {
    console.log(`  ${r.text}\n    ${r.phonemes}\n    音频 ${r.seconds}s  合成 ${r.ms}ms`);
  }
  ok('每句都合成出音频', tts.out.every((r) => r.seconds > 0.3));
  ok('没有无法发音的字符', tts.out.every((r) => r.unknown === 0));
  ok('助词 は 读作 wa', /korewa/.test(tts.out[0].phonemes), tts.out[0].phonemes);
  ok('助词 へ 读作 e', /ekie/.test(tts.out[1].phonemes), tts.out[1].phonemes);
  const avg = Math.round(tts.out.reduce((a, r) => a + r.ms, 0) / tts.out.length);
  console.log(`  INFO  手机合成速度 平均 ${avg}ms/句（整句，未分句）`);
}

ok('无页面错误', errors.length === 0, errors.slice(0, 2).join(' | '));

console.log(`\n结果: ${pass} passed, ${fail} failed`);
browser.disconnect();
process.exit(fail ? 1 : 0);
