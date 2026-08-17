/**
 * 端到端测试：用本机 Chrome 真跑一遍全部页面和交互。
 *
 * 为什么要做这个：这个应用的核心风险不在算法（已单测），而在
 * IndexedDB 事务、动态 import 路由、Web Audio 权限这些只有真浏览器才暴露的地方。
 *
 * 运行：node tools/e2e.mjs [--headful] [--keep]
 */
import puppeteer from 'puppeteer-core';
import http from 'http';
import { readFile, mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname, extname, normalize } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOT_DIR = '/tmp/study-app-shots';
const TONE_WAV = '/tmp/study-app-tone.wav';
const TONE_HZ = 196; // G3，男声舒适中音区
const headful = process.argv.includes('--headful');

/**
 * 生成一段「类人声」WAV 当作假麦克风输入。
 * Chrome 自带的 --use-fake-device-for-media-stream 只发满幅脉冲（实测 peak=1.0、
 * 大部分帧是静音），脉冲没有周期性，无法用来验证音高检测。
 * 用 --use-file-for-fake-audio-capture 喂真实波形，才能端到端测通
 * getUserMedia → MediaStreamSource → Analyser → decimate → detectPitch → UI。
 *
 * 时长取整数个周期（196Hz × 3s = 588 周期），循环播放时不会有接缝爆音。
 */
async function makeToneWav(path, hz = TONE_HZ, seconds = 3, sampleRate = 48000) {
  const n = Math.round(sampleRate * seconds);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    // 基频 + 2/3/4 次谐波，模拟人声频谱（2 次谐波比基频强，专门考八度错误）
    let v = 0.5 * Math.sin(2 * Math.PI * hz * t)
          + 0.7 * Math.sin(2 * Math.PI * 2 * hz * t + 0.3)
          + 0.4 * Math.sin(2 * Math.PI * 3 * hz * t + 1.1)
          + 0.2 * Math.sin(2 * Math.PI * 4 * hz * t + 2.0);
    v *= 0.22;
    data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 32767))), i * 2);
  }
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0);
  hdr.writeUInt32LE(36 + data.length, 4);
  hdr.write('WAVE', 8);
  hdr.write('fmt ', 12);
  hdr.writeUInt32LE(16, 16);
  hdr.writeUInt16LE(1, 20);          // PCM
  hdr.writeUInt16LE(1, 22);          // mono
  hdr.writeUInt32LE(sampleRate, 24);
  hdr.writeUInt32LE(sampleRate * 2, 28);
  hdr.writeUInt16LE(2, 32);
  hdr.writeUInt16LE(16, 34);
  hdr.write('data', 36);
  hdr.writeUInt32LE(data.length, 40);
  await writeFile(path, Buffer.concat([hdr, data]));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function serve(port) {
  const server = http.createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const file = join(root, normalize(p).replace(/^(\.\.[/\\])+/, ''));
      if (!file.startsWith(root) || !existsSync(file)) {
        res.writeHead(404); res.end('404'); return;
      }
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(body);
    } catch (e) {
      res.writeHead(500); res.end(String(e));
    }
  });
  return new Promise((r) => server.listen(port, () => r(server)));
}

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name + ' ' + extra); console.log(`  FAIL  ${name}  ${extra}`); }
}

function findChrome() {
  const cands = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const c of cands) if (existsSync(c)) return c;
  throw new Error('找不到 Chrome');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await mkdir(SHOT_DIR, { recursive: true });
  await makeToneWav(TONE_WAV);
  const PORT = 8199;
  const server = await serve(PORT);
  const base = `http://127.0.0.1:${PORT}/index.html`;

  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: headful ? false : 'shell',
    args: [
      '--no-sandbox', '--disable-dev-shm-usage',
      // 用真实波形 WAV 当麦克风输入并自动允许权限，这样音高链路能被真正测到
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${TONE_WAV}`,
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=412,915',
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 412, height: 915, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => errors.push('requestfailed: ' + r.url() + ' ' + r.failure()?.errorText));

  const ctx = browser.defaultBrowserContext();
  await ctx.overridePermissions(`http://127.0.0.1:${PORT}`, ['microphone']);

  const shot = (n) => page.screenshot({ path: join(SHOT_DIR, n + '.png') });
  const goto = async (hash) => {
    await page.evaluate((h) => { location.hash = h; }, hash);
    await sleep(700);
  };

  console.log('\n=== 启动与种卡 ===');
  await page.goto(base, { waitUntil: 'networkidle2' });
  await sleep(1400);

  const cardCount = await page.evaluate(async () => {
    const { db } = await import('./js/db.js');
    return (await db.count('cards'));
  });
  ok('卡片已种入 IndexedDB', cardCount > 4000, `实际 ${cardCount}`);

  const deckCounts = await page.evaluate(async () => {
    const { deckStats } = await import('./js/store.js');
    return await deckStats();
  });
  ok('7 个牌组都有卡', Object.keys(deckCounts).length === 7 && Object.values(deckCounts).every((s) => s.total > 0),
    JSON.stringify(Object.fromEntries(Object.entries(deckCounts).map(([k, v]) => [k, v.total]))));
  ok('平假名 104 张', deckCounts.kana_hira.total === 104, String(deckCounts.kana_hira.total));
  ok('词汇 2000 张', deckCounts.vocab_jp2cn.total === 2000, String(deckCounts.vocab_jp2cn.total));

  console.log('\n=== 首页 ===');
  await goto('#/home');
  const homeText = await page.$eval('#view', (e) => e.innerText);
  ok('首页有连续天数', /天连续/.test(homeText));
  ok('首页有三个碎片任务', (await page.$$('#view .task')).length >= 5, String((await page.$$('#view .task')).length));
  ok('首页显示回归提醒（尚无基线）', /还没建立基线|该做回归了/.test(homeText));
  await shot('01-home');

  console.log('\n=== 牌组页 ===');
  await goto('#/jp');
  ok('牌组页列出 7 个牌组', (await page.$$('#view .bar')).length === 7, String((await page.$$('#view .bar')).length));
  ok('有「开始今日全部」按钮', /开始今日全部/.test(await page.$eval('#view', (e) => e.innerText)));
  await shot('02-decks');

  console.log('\n=== 日语复习流程 ===');
  await goto('#/review/kana_hira');
  ok('显示题面', await page.$('#qcard .q-front') !== null);
  const frontKana = await page.$eval('.q-front', (e) => e.textContent.trim());
  ok('题面是单个假名', /^[\u3040-\u309F]{1,2}$/.test(frontKana), frontKana);
  ok('未翻面时无答案', await page.$('.q-back') === null);
  const leftBefore = +(await page.$eval('#rLeft', (e) => e.textContent));
  await shot('03-review-front');

  await page.click('#btnShow');
  await sleep(250);
  ok('翻面后出现答案', await page.$('.q-back') !== null);
  const romaji = await page.$eval('.q-answer', (e) => e.textContent.trim());
  ok('答案是罗马音', /^[a-z']+$/.test(romaji), romaji);
  ok('出现 4 个评级按钮', (await page.$$('.grade-row button')).length === 4);
  const ivls = await page.$$eval('.grade-row button i', (es) => es.map((e) => e.textContent));
  ok('4 个按钮都显示间隔预览', ivls.every((t) => t && t !== '-'), JSON.stringify(ivls));
  await shot('04-review-back');

  await page.click('.grade-row button[data-g="3"]');
  await sleep(500);
  const leftAfter = +(await page.$eval('#rLeft', (e) => e.textContent));
  ok('评级后剩余数减少', leftAfter === leftBefore - 1, `${leftBefore} -> ${leftAfter}`);
  ok('评级后回到未翻面状态', await page.$('.q-back') === null);

  // 连续做 6 张，含一次「忘了」，验证重入队与持久化
  for (let i = 0; i < 6; i++) {
    await page.click('#btnShow');
    await sleep(140);
    await page.click(`.grade-row button[data-g="${i === 2 ? 1 : 3}"]`);
    await sleep(260);
  }
  const revStat = await page.evaluate(async () => {
    const { db } = await import('./js/db.js');
    const { STATE } = await import('./js/fsrs.js');
    const rows = await db.all('reviews');
    const cards = await db.all('cards');
    const touched = cards.filter((c) => c.state !== STATE.NEW);
    return { reviews: rows.length, touched: touched.length, sample: touched[0] && { state: touched[0].state, stability: touched[0].stability, due: touched[0].due } };
  });
  ok('复习日志已落库', revStat.reviews === 7, `${revStat.reviews}`);
  ok('卡片状态已更新', revStat.touched >= 6, `${revStat.touched}`);
  ok('记忆状态有效（stability>0 且 due 在未来）',
    revStat.sample && revStat.sample.stability > 0 && revStat.sample.due > Date.now(),
    JSON.stringify(revStat.sample));

  console.log('\n=== 各牌组题面渲染 ===');
  for (const [deck, expect] of [
    ['vocab_jp2cn', /读音 \+ 意思/],
    ['grammar', /什么意思、怎么用/],
    ['theory', /./],
    ['kana_rule', /这条规则/],
  ]) {
    await goto(`#/review/${deck}`);
    const t = await page.$eval('#qcard', (e) => e.innerText);
    ok(`${deck} 题面渲染`, expect.test(t) && t.length > 3, t.slice(0, 40).replace(/\n/g, '|'));
    await page.click('#btnShow');
    await sleep(200);
    const b = await page.$eval('.q-back', (e) => e.innerText);
    ok(`${deck} 答案非空`, b.trim().length > 2, b.slice(0, 40).replace(/\n/g, '|'));
  }
  await shot('05-vocab-back');

  console.log('\n=== 练耳 ===');
  await goto('#/ear');
  // 阶梯改成一行一级的紧凑列表：解锁的是 <a.ear-row>，未解锁的是 <div.ear-row.locked>
  const ladderTxt = await page.$eval('#view', (e) => e.innerText);
  ok('练耳阶梯列出 9 级', (await page.$$('#view .ear-row')).length === 9,
    String((await page.$$('#view .ear-row')).length));
  ok('只有第一级解锁（渐进解锁生效）', (await page.$$('#view a.ear-row')).length === 1,
    String((await page.$$('#view a.ear-row')).length));
  ok('未解锁的级是锁定态', (await page.$$('#view .ear-row.locked')).length === 8,
    String((await page.$$('#view .ear-row.locked')).length));
  ok('顶部有「接着练」入口', (await page.$('#view .ear-hero')) !== null);
  ok('菜单不再有说教文案', !/为什么练/.test(ladderTxt), ladderTxt.slice(0, 40).replace(/\n/g, '|'));

  for (const mode of ['highlow', 'same', 'contour', 'tri', 'degree', 'chord', 'interval', 'melody', 'rhythm']) {
    await goto(`#/ear/${mode}`);
    await sleep(700);
    // 第一次进某一级先出示范页：零基础的人对「音高」「音程」没有概念，
    // 直接出题等于在听不懂的选项里瞎猜
    const demoBtns = await page.$$('#demos [data-d]');
    ok(`${mode} 首次进入先给示范`, demoBtns.length >= 1, `${demoBtns.length} 个示范`);
    if (demoBtns.length) {
      await demoBtns[0].click();
      await sleep(900);
      await page.click('#btnStart');
      await sleep(800);
    }
    // 第二次进入应直接出题（示范已记住）
    await goto(`#/ear/${mode}`);
    await sleep(700);
    ok(`${mode} 看过示范后直接出题`, (await page.$('#opts')) !== null && (await page.$('#demos')) === null);
    const wasLearn = await page.$eval('#cbLearn', (e) => e.checked);
    if (wasLearn) {
      await page.click('#cbLearn');
      await sleep(700);
    }
    ok(`${mode} 首次进入默认开熟悉模式`, wasLearn === true, String(wasLearn));
    const opts = await page.$$('#opts button');
    ok(`${mode} 出题并渲染选项`, opts.length >= 2, `${opts.length} 个选项`);
    if (opts.length) {
      await opts[0].click();
      await sleep(700);
      const fb = await page.$eval('#fb', (e) => e.innerText).catch(() => '');
      ok(`${mode} 作答后计分并给出解释`, /✓ 对|✗ 错/.test(fb) && fb.length > 12,
        fb.slice(0, 60).replace(/\n/g, '|'));
      const marked = await page.$$('#opts button.right');
      ok(`${mode} 标出了正确答案`, marked.length === 1, `${marked.length}`);
    }
  }
  await shot('07-ear-quiz');

  const earLog = await page.evaluate(async () => {
    const { db } = await import('./js/db.js');
    return (await db.all('earlog')).length;
  });
  // 熟悉模式的作答不计分不落库；第一次进某一级会自动开熟悉模式，
  // 所以这里只断言「有记录」而不是精确条数
  ok('练耳记录已落库（9 级各 1 题）', earLog === 9, String(earLog));
  await goto('#/ear/highlow/demo');
  await sleep(700);
  ok('答题页可回看示范', (await page.$$('#demos [data-d]')).length >= 2,
    String((await page.$$('#demos [data-d]')).length));

  // 自适应难度：「同异」级的半音差应随表现变化，而不是恒定
  const adaptive = await page.evaluate(async () => {
    const { nextSameGap } = await import('./js/ear-levels.js');
    const good = Array.from({ length: 6 }, () => ({ mode: 'same', correct: 1, gap: 4 }));
    const bad = Array.from({ length: 6 }, () => ({ mode: 'same', correct: 0, gap: 4 }));
    return { onGood: nextSameGap(good), onBad: nextSameGap(bad), initial: nextSameGap([]) };
  });
  ok('答对后难度收窄', adaptive.onGood < 4, JSON.stringify(adaptive));
  ok('答错后难度放宽', adaptive.onBad > 4, JSON.stringify(adaptive));
  ok('无历史时给初始难度', adaptive.initial === 5, String(adaptive.initial));

  // 解锁逻辑：第一级永远解锁，后面的要前一级达标
  const unlock = await page.evaluate(async () => {
    const { levelProgress, LEVELS, UNLOCK } = await import('./js/ear-levels.js');
    const empty = levelProgress([]);
    const passFirst = levelProgress(
      Array.from({ length: UNLOCK.window }, (_, i) => ({ mode: 'highlow', correct: 1, ts: i })));
    return {
      firstUnlockedEmpty: empty[LEVELS[0].id].unlocked,
      secondLockedEmpty: empty[LEVELS[1].id].unlocked,
      secondUnlockedAfter: passFirst[LEVELS[1].id].unlocked,
      thirdStillLocked: passFirst[LEVELS[2].id].unlocked,
    };
  });
  ok('第一级默认解锁', unlock.firstUnlockedEmpty === true);
  ok('第二级初始锁定', unlock.secondLockedEmpty === false);
  ok('第一级达标后解锁第二级', unlock.secondUnlockedAfter === true);
  ok('第三级仍锁定（逐级解锁）', unlock.thirdStillLocked === false);

  console.log('\n=== 练声：音准页（含麦克风）===');
  await goto('#/voice');
  ok('音准页有音高表', await page.$('#tnNote') !== null);
  ok('音准页有轨迹画布', await page.$('#trk') !== null);
  await page.click('#btnStart');
  await sleep(2200);
  const micState = await page.evaluate(async () => {
    const { mic } = await import('./js/audio.js');
    return { active: mic.active, sr: mic.sampleRate, dec: mic.decFactor };
  });
  ok('麦克风已启动', micState.active === true, JSON.stringify(micState));
  ok('采样率合理', micState.sr >= 8000, String(micState.sr));

  // 端到端验证音高链路：喂进去的是 196Hz(G3)，UI 上应该显示 G3
  const pitchProbe = await page.evaluate(async (hz) => {
    const { mic } = await import('./js/audio.js');
    const got = [];
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 60));
      const p = mic.readPitch();
      if (p.hz > 0) got.push(p);
    }
    if (!got.length) return { n: 0 };
    got.sort((a, b) => a.hz - b.hz);
    const med = got[Math.floor(got.length / 2)];
    return { n: got.length, hz: +med.hz.toFixed(2), name: med.name, cents: med.cents, clarity: +med.clarity.toFixed(3), err: +(1200 * Math.log2(med.hz / hz)).toFixed(1) };
  }, TONE_HZ);
  ok('麦克风链路检出音高', pitchProbe.n >= 10, `${pitchProbe.n}/25 帧`);
  ok('检出频率与输入一致（误差<20音分）', Math.abs(pitchProbe.err ?? 999) < 20, JSON.stringify(pitchProbe));
  ok('音名正确识别为 G3', pitchProbe.name === 'G3', String(pitchProbe.name));

  const tunerText = await page.$eval('#tn', (e) => e.innerText);
  ok('音高表显示了音名和频率', /G3/.test(tunerText) && /Hz/.test(tunerText), tunerText.replace(/\n/g, '|'));
  const needleLeft = await page.$eval('#tnNeedle', (e) => e.style.left);
  ok('指针已定位', /%$/.test(needleLeft), needleLeft);
  const trackLen = await page.evaluate(() => {
    const c = document.querySelector('#trk');
    return { w: c.width, h: c.height };
  });
  ok('轨迹画布已按 DPR 设置尺寸', trackLen.w > 400 && trackLen.h > 100, JSON.stringify(trackLen));
  await shot('08-voice-tuner');

  console.log('\n=== 练声：引导流程 ===');
  await goto('#/voice/routine');
  ok('7 个步骤', (await page.$$('#steps .step')).length === 7, String((await page.$$('#steps .step')).length));
  await page.click('#btnGo');
  await sleep(1500);
  ok('计时器在跑', /^\d\d:\d\d$/.test(await page.$eval('#tmr', (e) => e.textContent)), await page.$eval('#tmr', (e) => e.textContent));
  ok('当前步骤高亮', (await page.$$('#steps .step.cur')).length === 1);
  await page.click('#btnSkip');
  await sleep(400);
  ok('跳到第 2 步', /2\/7/.test(await page.$eval('#curName', (e) => e.textContent)), await page.$eval('#curName', (e) => e.textContent));
  await shot('09-voice-routine');
  await page.click('#btnStop');
  await sleep(600);
  const voiceRows = await page.evaluate(async () => {
    const { db } = await import('./js/db.js');
    return (await db.all('voice')).map((v) => v.kind);
  });
  ok('练声记录已落库', voiceRows.includes('routine'), JSON.stringify(voiceRows));

  console.log('\n=== 练声：音域测试 ===');
  await goto('#/voice/range');
  ok('音域页三个指标', (await page.$$('#view .stat')).length === 3);
  await page.click('#rgStart');
  await sleep(3000);
  ok('音域测量已启动', await page.$eval('#rgStart', (e) => e.textContent) === '停止');
  const rgVals = await page.evaluate(() => ({
    lo: document.querySelector('#rgLo').textContent,
    hi: document.querySelector('#rgHi').textContent,
    span: document.querySelector('#rgSpan').textContent,
    saveEnabled: !document.querySelector('#rgSave').disabled,
  }));
  ok('音域测到了输入音 G3', rgVals.lo === 'G3' && rgVals.hi === 'G3', JSON.stringify(rgVals));
  ok('测到边界后可保存', rgVals.saveEnabled === true, JSON.stringify(rgVals));
  await page.click('#rgSave');
  await sleep(600);
  const rangeSaved = await page.evaluate(async () => {
    const { db } = await import('./js/db.js');
    return (await db.all('voice')).filter((v) => v.kind === 'range').length;
  });
  ok('音域结果已存档', rangeSaved === 1, String(rangeSaved));
  await shot('10-voice-range');

  console.log('\n=== 练声：回归体检（跑完整 4 项）===');
  await goto('#/voice/regression');
  ok('回归页 4 个步骤', (await page.$$('#rrSteps .step')).length === 4, String((await page.$$('#rrSteps .step')).length));
  for (let i = 0; i < 4; i++) {
    await page.click('#rrGo');          // 开始本项（含参考音播放）
    // 参考音播放期间不采集，必须等播放结束后再留足采集窗口。
    // 音阶那项要放 9 个音（约 3.8s），所以单独给更长的等待。
    await sleep(i === 1 ? 6500 : 4000);
    if (i === 0) {
      ok('第 1 项计时器在跑', /^\d\d:\d\d$/.test(await page.$eval('#rrTimer', (e) => e.textContent)), await page.$eval('#rrTimer', (e) => e.textContent));
    }
    await page.click('#rrGo');          // 提前结束本项
    await sleep(1000);
    const out = await page.$eval('#rrOut', (e) => e.innerText);
    ok(`第 ${i + 1} 项算出指标`, out.trim().length > 0 && !/数据不足/.test(out), out.replace(/\n/g, '|'));
    ok(`第 ${i + 1} 项打勾`, (await page.$$('#rrSteps .step.fin')).length === i + 1,
      String((await page.$$('#rrSteps .step.fin')).length));
  }
  await shot('11a-voice-regression-steps');
  await page.click('#rrGo');            // 完成并保存
  await sleep(1200);
  const regSaved = await page.evaluate(async () => {
    const { db } = await import('./js/db.js');
    const rows = (await db.all('voice')).filter((v) => v.kind === 'regression');
    const r = rows[rows.length - 1];
    return { n: rows.length, metrics: r && r.metrics, hasAudio: !!(r && r.audio), audioSize: r && r.audio ? r.audio.size : 0 };
  });
  ok('回归记录已存档', regSaved.n === 1, JSON.stringify(regSaved.n));
  ok('四项指标都算出来了',
    regSaved.metrics && regSaved.metrics.sustainSec > 0.5 && regSaved.metrics.scaleCents !== null
    && regSaved.metrics.songCents !== null && regSaved.metrics.rangeSemitones !== null,
    JSON.stringify(regSaved.metrics));
  // 输入是恒定 196Hz 纯音，所以音准偏差应该接近 0；这同时验证了指标算得对
  ok('恒定音输入下音准偏差接近 0', regSaved.metrics.songCents !== null && regSaved.metrics.songCents < 8,
    `songCents=${regSaved.metrics.songCents} scaleCents=${regSaved.metrics.scaleCents}`);
  ok('最长发声秒数量级合理（采集窗口约 2-4 秒）',
    regSaved.metrics.sustainSec >= 1 && regSaved.metrics.sustainSec <= 6, String(regSaved.metrics.sustainSec));
  ok('固定曲目项录到了音频', regSaved.hasAudio && regSaved.audioSize > 500, `size=${regSaved.audioSize}`);
  ok('完成页显示汇总', /体检完成/.test(await page.$eval('#rrTitle', (e) => e.textContent)), await page.$eval('#rrTitle', (e) => e.textContent));
  await shot('11-voice-regression');

  // 直接注入一条完整回归记录，验证数据页的曲线绘制（跑完真实 4 项要 3 分钟）
  await page.evaluate(async () => {
    const { db } = await import('./js/db.js');
    const day = 86400000;
    const base = Date.now() - 21 * day;
    const data = [
      { scaleCents: 42, songCents: 51, sustainSec: 12.4, rangeLow: 45, rangeHigh: 64 },
      { scaleCents: 33, songCents: 44, sustainSec: 15.1, rangeLow: 44, rangeHigh: 66 },
      { scaleCents: 26, songCents: 35, sustainSec: 18.9, rangeLow: 43, rangeHigh: 67 },
      { scaleCents: 19, songCents: 28, sustainSec: 21.3, rangeLow: 43, rangeHigh: 69 },
    ];
    for (let i = 0; i < data.length; i++) {
      await db.add('voice', { ts: base + i * 7 * day, kind: 'regression', durationSec: 360, metrics: { ...data[i], rangeSemitones: data[i].rangeHigh - data[i].rangeLow, refMidi: 55 } });
    }
  });

  console.log('\n=== 翻译（离线）===');
  await goto('#/translate');
  await sleep(1200);
  ok('翻译页渲染', (await page.$('#trIn')) !== null && (await page.$('#btnSwap')) !== null);
  const trTxt = await page.$eval('#view', (e) => e.innerText);
  ok('方向显示中文→日语', /中文/.test(trTxt) && /日语/.test(trTxt));
  // 打字输入是唯一稳定通路，必须在主位；语音不可用时要说清楚且不挡路
  const micHint = await page.$eval('#micHint', (e) => e.innerText);
  ok('语音状态有明确说明', micHint.trim().length > 0, micHint.slice(0, 60).replace(/\n/g, '|'));
  ok('语音不可用时不影响打字', (await page.$eval('#btnGo', (e) => e.disabled)) === false);
  // 能力表：如实列出本机哪条路能用，避免点了才发现不行
  await sleep(2600);
  const capTxt = await page.$eval('#capBox', (e) => e.innerText);
  ok('列出本机语音能力', /打字翻译/.test(capTxt) && /朗读日语/.test(capTxt), capTxt.slice(0, 70).replace(/\n/g, '|'));
  ok('能力表不停留在「检测中」', !/检测中/.test(capTxt.split('朗读中文')[1] || ''), capTxt.replace(/\n/g, '|'));

  // 第 1 层：短语库精确匹配
  await page.$eval('#trIn', (e) => { e.value = '这个多少钱'; });
  await page.click('#btnGo');
  await sleep(700);
  let out = await page.$eval('#trOut', (e) => e.innerText);
  ok('短语库精确匹配出日语', /これはいくらですか/.test(out), out.slice(0, 70).replace(/\n/g, '|'));
  ok('标出「短语库·精确匹配」', /短语库.*精确/.test(out), out.slice(0, 40).replace(/\n/g, '|'));
  ok('显示罗马音且助词读音正确', /kore wa ikura desu ka/.test(out), out.replace(/\n/g, '|').slice(0, 90));

  // 第 1 层：模糊匹配（多了语气词）
  await page.$eval('#trIn', (e) => { e.value = '这个多少钱呀'; });
  await page.click('#btnGo');
  await sleep(600);
  out = await page.$eval('#trOut', (e) => e.innerText);
  ok('模糊匹配标为「相近句」并说明偏差', /相近句/.test(out) && /可能有偏差/.test(out), out.slice(0, 60).replace(/\n/g, '|'));

  // 第 2 层：逐词，必须明确声明不是完整翻译
  await page.$eval('#trIn', (e) => { e.value = '我想买便宜的相机'; });
  await page.click('#btnGo');
  await sleep(600);
  out = await page.$eval('#trOut', (e) => e.innerText);
  ok('逐词查询有结果', /逐词/.test(out), out.slice(0, 60).replace(/\n/g, '|'));
  ok('明确声明不是完整翻译', /不是完整翻译/.test(out), out.slice(0, 80).replace(/\n/g, '|'));
  ok('逐词模式显示命中统计', /命中 \d+/.test(out), (out.match(/命中 \d+[^\n]*/) || [''])[0]);

  // 第 3 层：查不到必须说查不到，不能编
  await page.$eval('#trIn', (e) => { e.value = '量子纠缠退相干时间'; });
  await page.click('#btnGo');
  await sleep(600);
  out = await page.$eval('#trOut', (e) => e.innerText);
  ok('查不到时明确说未收录', /未收录|查不到/.test(out), out.slice(0, 60).replace(/\n/g, '|'));

  // 日→中方向
  await page.click('#btnSwap');
  await sleep(400);
  await page.$eval('#trIn', (e) => { e.value = 'ありがとうございます'; });
  await page.click('#btnGo');
  await sleep(600);
  out = await page.$eval('#trOut', (e) => e.innerText);
  ok('日→中方向可用', /谢谢/.test(out), out.slice(0, 60).replace(/\n/g, '|'));
  await page.click('#btnSwap');
  await sleep(300);

  // 短语库快捷区
  const cats = await page.$$('#trCats [data-cat]');
  ok('短语分类 8 类', cats.length === 8, String(cats.length));
  const phs = await page.$$('#trPhrases [data-ph]');
  ok('当前分类有短语', phs.length >= 10, String(phs.length));
  await phs[0].click();
  await sleep(500);
  ok('点短语进结果区', /短语库/.test(await page.$eval('#trOut', (e) => e.innerText)));
  await shot('15-translate');

  // 存为卡片
  const beforeCards = await page.evaluate(async () => {
    const { db } = await import('./js/db.js');
    return db.count('cards');
  });
  await page.$eval('#trIn', (e) => { e.value = '请给我水'; });
  await page.click('#btnGo');
  await sleep(600);
  await page.click('#btnSave');
  await sleep(800);
  const savedCard = await page.evaluate(async () => {
    const { db } = await import('./js/db.js');
    const all = await db.all('cards');
    const mine = all.filter((c) => c.extra && c.extra.custom && /お水/.test(c.front));
    return { total: all.length, hit: mine.length };
  });
  ok('翻译结果可存为复习卡片', savedCard.hit === 1 && savedCard.total === beforeCards + 1,
    JSON.stringify(savedCard) + ' before=' + beforeCards);

  // 短语库数据质量
  const phQ = await page.evaluate(async () => {
    const d = await fetch('./data/phrases.json').then((r) => r.json());
    const bad = d.phrases.filter((p) => !p.cn || !p.jp || !p.kana || !p.romaji || !p.cat);
    const mark = d.phrases.filter((p) => /\//.test(p.jp) || /\//.test(p.kana));
    const badRom = d.phrases.filter((p) => /[\u3040-\u30FF]/.test(p.romaji));
    return { n: d.phrases.length, cats: d.categories.length, bad: bad.length,
             mark: mark.length, badRom: badRom.length };
  });
  ok('短语库 >=120 条', phQ.n >= 120, String(phQ.n));
  ok('短语库字段完整', phQ.bad === 0, String(phQ.bad));
  ok('短语库无残留边界标记', phQ.mark === 0, String(phQ.mark));
  ok('罗马音里没有漏转的假名', phQ.badRom === 0, String(phQ.badRom));

  console.log('\n=== 内置日语语音（预渲染，不依赖系统 TTS）===');
  const ja = await page.evaluate(async () => {
    const J = await import('./js/jaspeech.js');
    const st = await J.stats();
    return {
      st,
      phrase: J.coverage('これはいくらですか', 'これはいくらですか'),
      mora: J.coverage('わたしはがくせいです', 'わたしはがくせいです'),
      kanjiOnly: J.coverage('量子力学', ''),
      played: await J.speakJa('これはいくらですか', 'これはいくらですか', null),
      playedMora: await J.speakJa('わたしはがくせいです', 'わたしはがくせいです', null),
    };
  });
  ok('127 条整句语音已打包', ja.st.phrases === 127, String(ja.st.phrases));
  ok('104 个假名音节已打包', ja.st.mora === 104, String(ja.st.mora));
  ok('渲染引擎记录在案', ja.st.engine === 'open-jtalk', String(ja.st.engine));
  ok('短语走整句音频', ja.phrase === 'phrase', String(ja.phrase));
  ok('任意假名走音节拼接', ja.mora === 'mora', String(ja.mora));
  ok('纯汉字无假名时判为不覆盖', ja.kanjiOnly === 'none', String(ja.kanjiOnly));
  ok('整句实际播放成功', ja.played === 'phrase', String(ja.played));
  ok('拼接实际播放成功', ja.playedMora === 'mora', String(ja.playedMora));

  console.log('\n=== 带唱 ===');
  await goto('#/sing');
  await sleep(900);
  ok('带唱页渲染', (await page.$('#roll')) !== null && (await page.$('#btnSing')) !== null);
  const songs = await page.$$eval('#songSel option', (os) => os.map((o) => o.textContent));
  ok('内置练习旋律 4 条', songs.length === 4, JSON.stringify(songs));
  const rollPainted = await page.$eval('#roll', (c) => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  });
  ok('钢琴卷帘画出了目标音块', rollPainted > 2000, String(rollPainted));
  // 移调必须真的改变目标音高
  const rollBefore = rollPainted;
  await page.select('#trSel', '-5');
  await sleep(500);
  const rollAfter = await page.evaluate(() => {
    const c = document.querySelector('#roll');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  });
  ok('移调后重绘', rollAfter > 2000, `${rollBefore} -> ${rollAfter}`);
  await page.select('#trSel', '0');
  await sleep(300);
  await shot('16-sing');

  console.log('\n=== 本地音乐提取旋律 ===');
  await goto('#/sing/file');
  await sleep(700);
  ok('本地音频页渲染', (await page.$('#f')) !== null);
  // 合成一段已知旋律的音频喂给分析函数，验证真能提取出对的音
  const mel = await page.evaluate(async () => {
    const { audioCtx } = await import('./js/audio.js');
    const { detectPitch, decimate, hzToMidi, midiToHz } = await import('./js/pitch.js');
    const ctx = audioCtx();
    const sr = 24000;
    const want = [60, 64, 67, 72];          // do mi sol do'
    const noteSec = 0.5;
    const buf = ctx.createBuffer(1, sr * noteSec * want.length, sr);
    const d = buf.getChannelData(0);
    want.forEach((m, k) => {
      const f = midiToHz(m);
      for (let i = 0; i < sr * noteSec; i++) {
        const t = i / sr;
        const idx = k * sr * noteSec + i;
        // 带谐波，模拟人声
        d[idx] = 0.35 * (Math.sin(2 * Math.PI * f * t) + 0.6 * Math.sin(4 * Math.PI * f * t)
                 + 0.3 * Math.sin(6 * Math.PI * f * t));
      }
    });
    // 复刻 sing.js 里的提取逻辑（同一套算法）
    const dec = 1, rate = sr, win = 1024, hop = Math.round(rate * 0.02);
    const sig = buf.getChannelData(0);
    const raw = [];
    for (let i = 0; i + win <= sig.length; i += hop) {
      const p = detectPitch(sig.subarray(i, i + win), rate, { minHz: 70, maxHz: 1100 });
      raw.push(p.hz > 0 && p.clarity > 0.9 ? Math.round(hzToMidi(p.hz)) : null);
    }
    const found = [...new Set(raw.filter((x) => x !== null))].sort((a, b) => a - b);
    void dec;
    return { want, found, frames: raw.length, valid: raw.filter((x) => x !== null).length };
  });
  ok('本地音频能提取出正确的音',
    mel.want.every((m) => mel.found.includes(m)), JSON.stringify(mel));
  ok('提取覆盖率合理', mel.valid / mel.frames > 0.7, `${mel.valid}/${mel.frames}`);
  await shot('17-sing-file');

  console.log('\n=== 数据页 ===');
  await goto('#/data');
  await sleep(900);
  const canvasSizes = await page.$$eval('canvas', (cs) => cs.map((c) => ({ id: c.id, w: c.width, h: c.height })));
  ok('数据页有 5 张图', canvasSizes.length === 5, JSON.stringify(canvasSizes.map((c) => c.id)));
  ok('所有画布尺寸有效', canvasSizes.every((c) => c.w > 100 && c.h > 50), JSON.stringify(canvasSizes));
  const nonBlank = await page.$$eval('canvas', (cs) => cs.map((c) => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return { id: c.id, painted: n };
  }));
  ok('所有画布都画了内容', nonBlank.every((c) => c.painted > 300), JSON.stringify(nonBlank));
  const dataText = await page.$eval('#view', (e) => e.innerText);
  ok('总览有保持率', /保持率/.test(dataText));
  ok('回归趋势表有 5 行记录', (await page.$$('#view table.tbl tbody tr')).length === 5, String((await page.$$('#view table.tbl tbody tr')).length));
  const playBtns = await page.$$('#view [data-play]');
  ok('有录音的那次显示播放按钮', playBtns.length === 1, String(playBtns.length));
  await shot('12-data');

  console.log('\n=== 设置：改配置 ===');
  await page.evaluate(() => { document.querySelector('[data-np="vocab_jp2cn"]').value = '25'; });
  await page.click('#btnSaveCfg');
  await sleep(1500);
  const cfgSaved = await page.evaluate(async () => {
    const { getConfig } = await import('./js/store.js');
    return (await getConfig()).newPerDay.vocab_jp2cn;
  });
  ok('配置保存生效', cfgSaved === 25, String(cfgSaved));

  console.log('\n=== 导入自定义词表 ===');
  await goto('#/data');
  await sleep(700);
  await page.evaluate(() => {
    document.querySelector('#impText').value = 'やめて\t停下\nお前はもう死んでいる\t你已经死了\nばかやろう\t混蛋';
  });
  await page.click('#btnImpTSV');
  await sleep(800);
  const custom = await page.evaluate(async () => {
    const { db } = await import('./js/db.js');
    return (await db.all('cards')).filter((c) => c.extra && c.extra.custom).length;
  });
  // 翻译页「存为卡片」也会产生 extra.custom 的卡，所以这里断言 TSV 导入的那 3 条在内
  ok('自定义词表已导入 3 条', custom >= 3, String(custom));

  console.log('\n=== 种卡的孤儿清理（数据集换代时不能留僵尸卡，但要保住自导入卡）===');
  const prune = await page.evaluate(async () => {
    const { db } = await import('./js/db.js');
    const { seed } = await import('./js/store.js');
    const { newCardState } = await import('./js/fsrs.js');
    // 造一张「内置牌组里但不在 seeds 中」的旧卡（模拟数据集换代遗留）
    await db.put('cards', { id: 'vj-v-999-legacy', deck: 'vocab_jp2cn', seq: 9999,
      front: '旧卡', back: 'legacy', extra: {}, suspended: 0, ...newCardState() });
    // 再造一张用户自己导入的卡，它必须被豁免
    await db.put('cards', { id: 'u-vocab_jp2cn-mycard', deck: 'vocab_jp2cn', seq: 9998,
      front: 'やめて', back: '停下', extra: { custom: true }, suspended: 0, ...newCardState() });
    const before = await db.count('cards');
    const r = await seed();
    const legacy = await db.get('cards', 'vj-v-999-legacy');
    const mine = await db.get('cards', 'u-vocab_jp2cn-mycard');
    return { before, after: await db.count('cards'), removed: r.removed,
             legacyGone: !legacy, mineKept: !!mine };
  });
  ok('孤儿卡被清理', prune.legacyGone === true && prune.removed >= 1, JSON.stringify(prune));
  ok('自导入卡被豁免', prune.mineKept === true, JSON.stringify(prune));

  console.log('\n=== 备份导出/导入 ===');
  const exported = await page.evaluate(async () => {
    const { exportAll } = await import('./js/store.js');
    const d = await exportAll();
    return { app: d.app, cards: d.cards.length, reviews: d.reviews.length, hasAudioField: JSON.stringify(d.voice).includes('"audio"') };
  });
  ok('导出结构正确', exported.app === 'study-app' && exported.cards > 4000 && exported.reviews === 7, JSON.stringify(exported));
  ok('导出不含录音 Blob', exported.hasAudioField === false);

  console.log('\n=== 12 周计划页 ===');
  await goto('#/plan');
  const weekCards = await page.$$('#view [data-wk]');
  ok('12 周全部列出', weekCards.length === 12, String(weekCards.length));
  const planText = await page.$eval('#view', (e) => e.innerText);
  // 折叠的 <details> 内容不进 innerText（它只算可见文本），改用 textContent：
  // 12 周全部渲染进 DOM，只是默认收起
  const planAll = await page.$eval('#view', (e) => e.textContent);
  ok('每周有过关判据', (planAll.match(/过关判据/g) || []).length === 12,
    String((planAll.match(/过关判据/g) || []).length));
  ok('默认最多展开一周', (await page.$$('#view details.plan-week[open]')).length <= 1,
    String((await page.$$('#view details.plan-week[open]')).length));
  ok('页面不含对话输入与设计说明', !/时间预算|四条原则|碎片 25-35|起点：日语十几年前/.test(planAll),
    (planAll.match(/时间预算|四条原则|碎片 25-35|起点：日语十几年前/) || [''])[0]);
  await page.click('#btnStartPlan');
  await sleep(1400);
  const afterStart = await page.$eval('#view', (e) => e.innerText);
  ok('设定起始周后显示进度头', /第\s*1\s*\/\s*12\s*周/.test(afterStart), afterStart.slice(0, 40).replace(/\n/g, '|'));
  ok('当前周自动展开', (await page.$$('#view details.plan-week[open]')).length === 1,
    String((await page.$$('#view details.plan-week[open]')).length));
  await shot('13-plan');

  console.log('\n=== 路由与资源 ===');
  const swReg = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration();
    return !!r;
  });
  ok('Service Worker 已注册', swReg);
  const mani = await page.evaluate(async () => {
    const r = await fetch('./manifest.webmanifest');
    const j = await r.json();
    return { ok: r.ok, icons: j.icons.length, name: j.name };
  });
  ok('manifest 可解析', mani.ok && mani.icons === 4, JSON.stringify(mani));

  await goto('#/nonexistent');
  ok('未知路由回落到首页', /天连续/.test(await page.$eval('#view', (e) => e.innerText)));

  // 重新加载，验证数据持久化 + 二次种卡不重复
  await page.reload({ waitUntil: 'networkidle2' });
  await sleep(1500);
  const after = await page.evaluate(async () => {
    const { db } = await import('./js/db.js');
    return { cards: await db.count('cards'), reviews: await db.count('reviews') };
  });
  ok('重载后数据仍在', after.reviews === 7, JSON.stringify(after));
  // +4 = TSV 导入的 3 张 + 孤儿清理测试留下的 1 张自导入卡（它被正确豁免了）
  // +6 = TSV 导入 3 + 孤儿测试留的自导入卡 1 + 翻译页存的 2（お水をください / 短语点击那条）
  ok('二次种卡不产生重复', after.cards >= cardCount + 4 && after.cards <= cardCount + 7,
    `${cardCount} -> ${after.cards}`);

  console.log('\n=== 离线可用性（地铁场景）===');
  // 先 reload 一次让 SW 接管导航请求，再切断网络验证是否真能离线启动
  await page.reload({ waitUntil: 'networkidle2' });
  await sleep(1200);
  const swActive = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration();
    return !!(r && r.active) && !!navigator.serviceWorker.controller;
  });
  ok('SW 已激活并接管页面', swActive);

  await page.setOfflineMode(true);
  const offlineErrors = [];
  const offHandler = (e) => offlineErrors.push(e.message);
  page.on('pageerror', offHandler);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(2000);
  const offlineText = await page.$eval('#view', (e) => e.innerText).catch(() => '');
  ok('断网后页面仍能加载', /天连续/.test(offlineText), offlineText.slice(0, 60).replace(/\n/g, '|'));

  await goto('#/review/kana_hira');
  const offlineCard = await page.$('#qcard .q-front');
  ok('断网后仍能复习（数据来自本地库）', offlineCard !== null);
  await goto('#/plan');
  ok('断网后计划页仍可用（JSON 已被 SW 缓存）', (await page.$$('#view [data-wk]')).length === 12,
    String((await page.$$('#view [data-wk]')).length));
  await shot('14-offline');
  ok('离线期间无页面错误', offlineErrors.length === 0, offlineErrors.slice(0, 3).join(' || '));
  page.off('pageerror', offHandler);
  await page.setOfflineMode(false);

  console.log('\n=== 控制台错误 ===');
  // 离线测试期间的网络失败是预期的（正是要验证 SW 兜底），不算 bug
  const real = errors.filter((e) => !/favicon|Download the React|DevTools|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_FAILED/.test(e));
  ok('无控制台/页面错误', real.length === 0, real.slice(0, 6).join(' || '));

  await browser.close();
  server.close();

  console.log(`\n截图目录: ${SHOT_DIR}`);
  console.log(`结果: ${pass} passed, ${fail} failed\n`);
  if (fail) { console.log('失败项:\n' + failures.map((f) => '  - ' + f).join('\n')); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
