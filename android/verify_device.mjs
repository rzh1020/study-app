/**
 * 真机 APK 验证。通过 adb + WebView 远程调试直连手机里的 WebView，
 * 在真实设备上跑一遍关键路径。
 *
 * 为什么必须这么测：headless Chrome 上全绿不代表 APK 里能跑。
 * WebView 与 Chrome 有实质差异（Service Worker 支持、权限模型、
 * shouldInterceptRequest 的响应处理、MediaRecorder 编码支持），
 * 而且这次要验证的恰恰是「安全上下文是否真的成立」「麦克风是否真能取到数据」。
 * 这个脚本还有个好处：屏幕灭着也能跑，CDP 截图是离屏渲染的。
 *
 * 用法：node android/verify_device.mjs
 */
import puppeteer from 'puppeteer-core';
import { execSync, execFileSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';

const PKG = 'com.rzh.studyhub';
const PORT = 9333;
const SHOTS = '/tmp/studyhub-device';

const sh = (c) => execSync(c, { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(`${name} ${extra}`); console.log(`  FAIL  ${name}  ${extra}`); }
}

mkdirSync(SHOTS, { recursive: true });

// ---- 建立到设备内 WebView 的调试通道 ----
// 必须按本 App 的 pid 精确匹配 socket：设备上可能同时存在其他应用的 WebView
// （浏览器、带 WebView 的系统应用），取「第一个」会连到别人身上，
// 表现为 /json/version 无响应，很难看出原因。
const appPid = sh(`adb shell pidof ${PKG}`).split(/\s+/)[0];
if (!appPid) {
  console.error(`${PKG} 没在运行。先执行：adb shell am start -n ${PKG}/.MainActivity`);
  process.exit(1);
}
const allSocks = sh(`adb shell cat /proc/net/unix`).match(/webview_devtools_remote_\d+/g) || [];
const sock = `webview_devtools_remote_${appPid}`;
if (![...new Set(allSocks)].includes(sock)) {
  console.error(`找不到 ${sock}。现有: ${[...new Set(allSocks)].join(', ') || '(无)'}`);
  console.error('若 App 刚启动，等 2 秒后重试；若始终没有，检查 setWebContentsDebuggingEnabled。');
  process.exit(1);
}
console.log(`app pid ${appPid} -> ${sock}`);
try { execSync(`adb forward --remove tcp:${PORT}`, { stdio: 'ignore' }); } catch { /* 本来就没有 */ }
sh(`adb forward tcp:${PORT} localabstract:${sock}`);

// App 被系统冻结（HyperOS 会冻结后台应用）时 devtools 不响应，给出可行动的提示
let ver;
try {
  ver = JSON.parse(sh(`curl -s -m 10 http://127.0.0.1:${PORT}/json/version`));
} catch {
  console.error('\ndevtools 无响应。最常见原因：App 不在前台被系统冻结了。');
  console.error('先确保屏幕亮着且 App 在前台：');
  console.error('  adb shell svc power stayon true');
  console.error('  adb shell input keyevent 224 && adb shell wm dismiss-keyguard');
  console.error(`  adb shell am start -n ${PKG}/.MainActivity`);
  process.exit(1);
}
console.log(`WebView: ${ver['User-Agent'].match(/Chrome\/[\d.]+/)?.[0] || '?'}`);
console.log(`内核: ${ver.Browser}\n`);

const browser = await puppeteer.connect({
  browserURL: `http://127.0.0.1:${PORT}`,
  defaultViewport: null,
});

const pages = await browser.pages();
const page = pages.find((p) => p.url().includes('appassets')) || pages[0];
console.log(`页面: ${page.url()}\n`);

const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

const goto = async (hash) => {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await sleep(800);
};
/**
 * 截图。CDP 的 Page.captureScreenshot 在 WebView 里不可靠
 * （App 不在前台或没有渲染表面时会直接超时挂住整个测试），
 * 所以走 adb screencap，并且失败不阻断测试。
 */
const shot = async (n) => {
  try {
    execSync(`adb exec-out screencap -p > ${SHOTS}/${n}.png`, { stdio: 'ignore', timeout: 15000 });
  } catch {
    console.log(`  INFO  截图 ${n} 失败（App 可能不在前台），已跳过`);
  }
};

console.log('=== 运行环境（这是 APK 相对网页版的关键改善）===');
const env = await page.evaluate(() => ({
  origin: location.origin,
  secure: window.isSecureContext,
  md: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
  mr: !!window.MediaRecorder,
  idb: !!window.indexedDB,
  bridge: typeof window.AndroidBridge,
  platform: window.AndroidBridge ? window.AndroidBridge.platform() : null,
  sw: 'serviceWorker' in navigator,
  ua: navigator.userAgent,
}));
ok('origin 是 https（不是 file://）', env.origin.startsWith('https://'), env.origin);
ok('安全上下文成立', env.secure === true, String(env.secure));
ok('getUserMedia API 存在', env.md === true);
ok('MediaRecorder 存在（回归录音）', env.mr === true);
ok('IndexedDB 可用', env.idb === true);
ok('原生桥已注入', env.bridge === 'object' && env.platform === 'android', `${env.bridge}/${env.platform}`);
console.log(`  INFO  UA: ${env.ua.slice(0, 110)}`);

console.log('\n=== 内容加载（打包在 APK 内，无需联网）===');
const seeded = await page.evaluate(async () => {
  const { db } = await import('./js/db.js');
  const { deckStats } = await import('./js/store.js');
  const s = await deckStats();
  return { total: await db.count('cards'), decks: s };
});
ok('卡片已种入本机数据库', seeded.total >= 670, `${seeded.total} 张`);
ok('平假名 104', seeded.decks.kana_hira.total === 104, String(seeded.decks.kana_hira.total));
ok('片假名 104', seeded.decks.kana_kata.total === 104, String(seeded.decks.kana_kata.total));
ok('词汇 185', seeded.decks.vocab_jp2cn.total === 185, String(seeded.decks.vocab_jp2cn.total));
ok('语法 42', seeded.decks.grammar.total === 42, String(seeded.decks.grammar.total));
ok('声乐科普 45', seeded.decks.theory.total === 45, String(seeded.decks.theory.total));

console.log('\n=== 首页 ===');
await goto('#/home');
const homeTxt = await page.$eval('#view', (e) => e.innerText);
ok('首页渲染', /天连续/.test(homeTxt), homeTxt.slice(0, 40).replace(/\n/g, '|'));
await shot('01-home');

console.log('\n=== 日语复习 + 数据落盘 ===');
await goto('#/review/kana_hira');
ok('题面出现', (await page.$('#qcard .q-front')) !== null);
const kana = await page.$eval('.q-front', (e) => e.textContent.trim());
ok('题面是假名', /^[\u3040-\u309F]{1,2}$/.test(kana), kana);
await page.click('#btnShow');
await sleep(300);
ok('翻面显示罗马音', /^[a-z']+$/.test(await page.$eval('.q-answer', (e) => e.textContent.trim())));
const ivls = await page.$$eval('.grade-row button i', (es) => es.map((e) => e.textContent));
ok('四档间隔各不相同', new Set(ivls).size === 4, JSON.stringify(ivls));
await shot('02-review');
for (let i = 0; i < 4; i++) {
  await page.click('#btnShow').catch(() => {});
  await sleep(150);
  await page.click('.grade-row button[data-g="3"]');
  await sleep(300);
}
const revCount = await page.evaluate(async () => {
  const { db } = await import('./js/db.js');
  return await db.count('reviews');
});
ok('复习记录写入本机', revCount >= 4, `${revCount} 条`);

console.log('\n=== 练耳（Web Audio 无手势播放）===');
await goto('#/ear/degree');
await sleep(1000);
const opts = await page.$$('#opts button');
ok('出题并渲染选项', opts.length >= 7, `${opts.length}`);
const audioState = await page.evaluate(async () => {
  const { audioCtx } = await import('./js/audio.js');
  return audioCtx().state;
});
ok('AudioContext 处于 running（未被手势策略挂起）', audioState === 'running', audioState);
if (opts.length) { await opts[0].click(); await sleep(700); }
ok('作答有反馈', /对|错/.test(await page.$eval('#fb', (e) => e.innerText).catch(() => '')));
await shot('03-ear');

console.log('\n=== 麦克风：真机实测取数 ===');
await goto('#/voice');
const noBanner = await page.evaluate(() => !/麦克风不可用/.test(document.querySelector('#view').innerText));
ok('没有出现「麦克风不可用」警告条', noBanner);
const micTest = await page.evaluate(async () => {
  const { mic } = await import('./js/audio.js');
  try {
    await mic.start();
  } catch (e) {
    return { err: `${e.name}: ${e.message}` };
  }
  let maxRms = 0, frames = 0, detected = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < 2500) {
    const p = mic.readPitch();
    frames++;
    if (p.rms > maxRms) maxRms = p.rms;
    if (p.hz > 0) detected++;
    await new Promise((r) => setTimeout(r, 45));
  }
  const info = { sr: mic.sampleRate, dec: mic.decFactor, maxRms: +maxRms.toFixed(5), frames, detected };
  mic.stop();
  return info;
});
if (micTest.err) {
  ok('麦克风可以打开', false, micTest.err);
} else {
  ok('麦克风可以打开', true);
  ok('采样率合理', micTest.sr >= 16000, `${micTest.sr}Hz`);
  ok('启用了降采样', micTest.dec === 3, String(micTest.dec));
  ok('真的取到音频数据（有非零 RMS）', micTest.maxRms > 0.0002,
    `maxRms=${micTest.maxRms} 采了 ${micTest.frames} 帧`);
  console.log(`  INFO  ${micTest.frames} 帧中检出音高 ${micTest.detected} 帧（环境安静时为 0 属正常）`);
}
await shot('04-voice');

console.log('\n=== 录音编码（回归体检要存档）===');
const recTest = await page.evaluate(() => {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/aac'];
  return {
    supported: types.filter((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)),
  };
});
ok('至少支持一种录音编码', recTest.supported.length > 0, JSON.stringify(recTest.supported));

console.log('\n=== 引导练声 + 屏幕常亮 ===');
await goto('#/voice/routine');
ok('7 个步骤', (await page.$$('#steps .step')).length === 7);
await page.click('#btnGo');
await sleep(1600);
ok('计时器在跑', /^\d\d:\d\d$/.test(await page.$eval('#tmr', (e) => e.textContent)));
const awakeFlag = sh(`adb shell dumpsys window ${PKG} 2>/dev/null | grep -c "KEEP_SCREEN_ON" || true`);
console.log(`  INFO  window flags 里 KEEP_SCREEN_ON 出现 ${awakeFlag} 次`);
await shot('05-routine');
await page.click('#btnStop');
await sleep(800);
const voiceLog = await page.evaluate(async () => {
  const { db } = await import('./js/db.js');
  return (await db.all('voice')).map((v) => v.kind);
});
ok('练声记录落盘', voiceLog.includes('routine'), JSON.stringify(voiceLog));

console.log('\n=== 12 周计划（内容从 APK 内 JSON 读取）===');
await goto('#/plan');
ok('12 周全部列出', (await page.$$('#view [data-wk]')).length === 12,
  String((await page.$$('#view [data-wk]')).length));
ok('有过关判据', (((await page.$eval('#view', (e) => e.innerText)).match(/过关判据/g)) || []).length === 12);
await shot('06-plan');

console.log('\n=== 数据页 ===');
await goto('#/data');
await sleep(1000);
const canv = await page.$$eval('canvas', (cs) => cs.map((c) => ({ id: c.id, w: c.width, painted: (() => {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
  return n;
})() })));
ok('图表已绘制', canv.length >= 2 && canv.every((c) => c.painted > 100), JSON.stringify(canv));
ok('备份说明是原生版文案', /App 私有目录/.test(await page.$eval('#view', (e) => e.innerText)));
await shot('07-data');

console.log('\n=== 备份导出链路（原生 SAF）===');
const exportPath = await page.evaluate(async () => {
  const { isNative } = await import('./js/native.js');
  const { exportAll } = await import('./js/store.js');
  const d = await exportAll();
  return { isNative, cards: d.cards.length, reviews: d.reviews.length, bytes: JSON.stringify(d).length };
});
ok('native.js 识别出原生环境', exportPath.isNative === true);
ok('导出数据完整', exportPath.cards >= 670 && exportPath.reviews >= 4, JSON.stringify(exportPath));
console.log(`  INFO  备份体积 ${(exportPath.bytes / 1024).toFixed(0)} KB`);

console.log('\n=== 无 Service Worker 报错（APK 里应跳过注册）===');
const swSkipped = await page.evaluate(async () => {
  if (!('serviceWorker' in navigator)) return 'API 不存在';
  const r = await navigator.serviceWorker.getRegistration();
  return r ? '已注册' : '未注册';
});
ok('APK 内未注册 SW', swSkipped !== '已注册', swSkipped);

console.log('\n=== 页面错误 ===');
const real = errors.filter((e) => !/favicon|DevTools|ERR_INTERNET/.test(e));
ok('无未捕获错误', real.length === 0, real.slice(0, 5).join(' || '));

// APK 内部结构核对
console.log('\n=== APK 内容核对 ===');
const apkList = sh(`unzip -l android/build/study-hub.apk`);
ok('assets 已打进 APK', /assets\/index\.html/.test(apkList) && /assets\/data\/vocab\.json/.test(apkList));
ok('classes.dex 存在', /classes\.dex/.test(apkList));
const perms = sh(`adb shell dumpsys package ${PKG} | grep -c "android.permission.INTERNET" || true`);
ok('APK 未申请联网权限', perms.trim() === '0', `INTERNET 出现 ${perms} 次`);

await browser.disconnect();
try { execSync(`adb forward --remove tcp:${PORT}`, { stdio: "ignore" }); } catch { /* ignore */ }

writeFileSync(`${SHOTS}/summary.txt`, `pass=${pass} fail=${fail}\n${failures.join('\n')}`);
console.log(`\n截图: ${SHOTS}`);
console.log(`结果: ${pass} passed, ${fail} failed\n`);
if (fail) { console.log('失败项:\n' + failures.map((f) => '  - ' + f).join('\n')); process.exit(1); }
void execFileSync;
