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
ok('卡片已种入本机数据库', seeded.total >= 4000, `${seeded.total} 张`);
ok('平假名 104', seeded.decks.kana_hira.total === 104, String(seeded.decks.kana_hira.total));
ok('片假名 104', seeded.decks.kana_kata.total === 104, String(seeded.decks.kana_kata.total));
ok('词汇 2000', seeded.decks.vocab_jp2cn.total === 2000, String(seeded.decks.vocab_jp2cn.total));
ok('语法 42', seeded.decks.grammar.total === 42, String(seeded.decks.grammar.total));
ok('声乐科普 45', seeded.decks.theory.total === 45, String(seeded.decks.theory.total));

console.log('\n=== 首页 ===');
await goto('#/home');
const homeTxt = await page.$eval('#view', (e) => e.innerText);
ok('首页渲染', /连续 \d+ 天/.test(homeTxt), homeTxt.slice(0, 40).replace(/\n/g, '|'));
await shot('01-home');

// 真机的数据库是持久的：跑过几轮验证后当天新卡配额（默认 12/天）就用完了，
// 队列会空掉，导致「题面出现」误报失败。所以先抬高配额，让测试与历史数据无关。
await page.evaluate(async () => {
  const { setConfig, getConfig } = await import('./js/store.js');
  const cfg = await getConfig();
  await setConfig({ newPerDay: { ...cfg.newPerDay, kana_hira: 999 } });
});

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
await goto('#/ear/highlow');
await sleep(700);
// 首次进入某一级会先出示范页（零基础需要先听懂概念），跳过它进入答题
if ((await page.$$('#demos [data-d]')).length) {
  ok('练耳首次进入先给示范', true);
  await page.click('#btnStart');
  await sleep(900);
}
await sleep(1000);
const opts = await page.$$('#opts button');
ok('出题并渲染选项', opts.length >= 2, `${opts.length}`);
const audioState = await page.evaluate(async () => {
  const { audioCtx } = await import('./js/audio.js');
  return audioCtx().state;
});
ok('AudioContext 处于 running（未被手势策略挂起）', audioState === 'running', audioState);
// 首次进某一级会自动开熟悉模式（不计分），关掉它才能测计分路径
if (await page.$eval('#cbLearn', (e) => e.checked).catch(() => false)) {
  await page.click('#cbLearn');
  await sleep(800);
}
const optsScored = await page.$$('#opts button');
if (optsScored.length) { await optsScored[0].click(); await sleep(800); }
ok('作答后计分并给出解释',
  /✓ 对|✗ 错/.test(await page.$eval('#fb', (e) => e.innerText).catch(() => '')));
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
// 折叠的 <details> 内容不进 innerText，改用 textContent 统计
const planTc = await page.$eval('#view', (e) => e.textContent);
ok('每周有过关判据', ((planTc.match(/过关判据/g)) || []).length === 12,
  String(((planTc.match(/过关判据/g)) || []).length));
await shot('06-plan');

console.log('\n=== 翻译（真机离线）===');
await goto('#/translate');
await sleep(1200);
ok('翻译页渲染', (await page.$('#trIn')) !== null);
// 必须用 probeTts 而不是 ttsHasVoice：后者在原生 TTS 异步 init 完成前会
// 乐观返回 true（避免误报缺语音包），拿它当验证结论等于自己骗自己 ——
// 上一版就因此报告「日语=true」，而实际设备上根本没有日语合成。
const spx = await page.evaluate(async () => {
  const { asrStatus, probeTts } = await import('./js/native.js');
  const zh = await probeTts('zh-CN');
  const ja = await probeTts('ja-JP', 900);
  return { asr: asrStatus(), ja, zh };
});
console.log(`  INFO  语音识别 available=${spx.asr.available} offline=${spx.asr.offline} : ${spx.asr.reason}`);
console.log(`  INFO  TTS 真实能力（probeTts）日语=${spx.ja} 中文=${spx.zh}`);
ok('至少有一种语言能朗读', spx.ja || spx.zh, `ja=${spx.ja} zh=${spx.zh}`);
// 系统没有日语引擎（实测就是这样），所以日语朗读必须由内置预渲染语音兜住
await goto('#/translate');
await sleep(4200);
const cap = await page.$eval('#capBox', (e) => e.innerText);
ok('能力表标出日语用内置语音', /朗读日语[\s\S]*内置语音/.test(cap), cap.replace(/\n/g, '|').slice(0, 80));
const jaAudio = await page.evaluate(async () => {
  const J = await import('./js/jaspeech.js');
  const st = await J.stats();
  // 注意别用 mora 当键名：会覆盖 stats() 里的 mora 计数
  return { st, played: await J.speakJa('これはいくらですか', 'これはいくらですか', null),
           moraPlayed: await J.speakJa('わたしはがくせいです', 'わたしはがくせいです', null) };
});
ok('内置日语语音已打包（127 句 + 104 音节）',
  jaAudio.st.phrases === 127 && jaAudio.st.mora === 104, JSON.stringify(jaAudio));
ok('真机上整句语音播放成功', jaAudio.played === 'phrase', String(jaAudio.played));
ok('真机上音节拼接播放成功', jaAudio.moraPlayed === 'mora', String(jaAudio.moraPlayed));
if (!spx.ja) console.log('  INFO  系统确实没有日语引擎，内置语音是唯一通路 —— 已验证可用');

console.log('\n=== 带唱（真机）===');
await goto('#/sing');
await sleep(1100);
ok('带唱页渲染', (await page.$('#roll')) !== null);
const rollPx = await page.$eval('#roll', (c) => {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n;
});
ok('钢琴卷帘已绘制', rollPx > 2000, String(rollPx));
ok('原生桥返回了语音识别状态', typeof spx.asr.available === 'boolean');
await page.$eval('#trIn', (e) => { e.value = '这个多少钱'; });
await page.click('#btnGo');
await sleep(900);
const trO = await page.$eval('#trOut', (e) => e.innerText);
ok('真机上短语库翻译可用', /これはいくらですか/.test(trO), trO.slice(0, 60).replace(/\n/g, '|'));
ok('罗马音助词读音正确', /kore wa ikura desu ka/.test(trO));

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
ok('导出数据完整', exportPath.cards >= 4000 && exportPath.reviews >= 4, JSON.stringify(exportPath));
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
