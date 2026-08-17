// 核心算法单测：node tools/test_core.mjs
import { schedule, newCardState, RATING, STATE, retrievability, previewIntervals } from '../js/fsrs.js';
import { detectPitch, decimate, hzToNote, midiToHz, parseNote, noteName, pitchAccuracy, trackRange } from '../js/pitch.js';

let pass = 0, fail = 0;
const DAY = 86400000;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${extra}`); }
}
function near(a, b, tol) { return Math.abs(a - b) <= tol; }
const fmtMin = (ms) => (ms < 3600000 ? (ms / 60000).toFixed(1) + 'm' : (ms / 86400000).toFixed(1) + 'd');

console.log('\n=== FSRS ===');
{
  // R 单调递减，且 t==S 时 R==0.9（FSRS 的定义锚点）
  ok('R(0,S)=1', near(retrievability(0, 10), 1, 1e-9));
  ok('R(S,S)=0.9', near(retrievability(10, 10), 0.9, 1e-6), retrievability(10, 10));
  ok('R 递减', retrievability(5, 10) > retrievability(50, 10));

  const t0 = Date.parse('2026-01-01T00:00:00Z');
  // 新卡按 Good 走：应进 learning，分钟级
  let c = { ...newCardState() };
  let g = schedule(c, RATING.GOOD, t0);
  ok('新卡Good→LEARNING', g.state === STATE.LEARNING, g.state);
  ok('新卡Good间隔=10min', near(g.due - t0, 10 * 60000, 1), (g.due - t0) / 60000);
  ok('difficulty 在 1..10', g.difficulty >= 1 && g.difficulty <= 10, g.difficulty);

  // 新卡的四个按钮也必须严格递增，不能有两档等价（否则 UI 上有按钮是废的）
  const pNew = previewIntervals({ ...newCardState() }, t0);
  ok('新卡四档间隔严格递增', pNew[1] < pNew[2] && pNew[2] < pNew[3] && pNew[3] < pNew[4],
    [1, 2, 3, 4].map((k) => (pNew[k] / 60000).toFixed(1) + 'min').join(' < '));
  ok('新卡Again=1min', near(pNew[1], 60000, 1), pNew[1] / 60000);
  ok('新卡Hard介于Again与Good之间', pNew[2] > pNew[1] && pNew[2] < pNew[3], pNew[2] / 60000);

  // 新卡按 Easy：直接毕业进 review，且间隔应该好几天
  let e = schedule({ ...newCardState() }, RATING.EASY, t0);
  ok('新卡Easy→REVIEW', e.state === STATE.REVIEW, e.state);
  ok('新卡Easy间隔>=10天', e.scheduledDays >= 10, e.scheduledDays);
  ok('Easy比Good难度低', e.difficulty < g.difficulty, `${e.difficulty} vs ${g.difficulty}`);

  // 毕业后连续 Good，间隔必须单调增长
  let card = e;
  let t = t0;
  const ivls = [];
  for (let i = 0; i < 6; i++) {
    t = card.due;
    card = schedule(card, RATING.GOOD, t);
    ivls.push(card.scheduledDays);
  }
  ok('连续Good间隔单调增', ivls.every((v, i) => i === 0 || v > ivls[i - 1]), ivls.join(','));
  ok('6次Good后间隔>90天', ivls[ivls.length - 1] > 90, ivls.join(','));
  ok('stability 增长', card.stability > e.stability);

  // Again：进 relearning，稳定度必须下降但不为 0
  const before = card.stability;
  const lapsed = schedule(card, RATING.AGAIN, card.due);
  ok('Again→RELEARNING', lapsed.state === STATE.RELEARNING, lapsed.state);
  ok('Again 稳定度下降', lapsed.stability < before, `${lapsed.stability} < ${before}`);
  ok('Again 稳定度>0', lapsed.stability > 0, lapsed.stability);
  ok('Again lapses+1', lapsed.lapses === card.lapses + 1);
  ok('Again 分钟级重排', lapsed.due - card.due <= 15 * 60000);

  // 四个按钮的间隔必须 again < hard < good < easy
  // 用中等状态的卡来测：稳定度极高时四者都会撞 maximumInterval 上限而并列
  let mid2 = schedule(schedule(e, RATING.GOOD, e.due), RATING.GOOD, e.due + 30 * DAY);
  const p = previewIntervals(mid2, mid2.due);
  ok('间隔序 again<hard<good<easy', p[1] < p[2] && p[2] < p[3] && p[3] < p[4],
    [1, 2, 3, 4].map((k) => (p[k] / DAY).toFixed(2)).join(' < '));

  // 目标保持率越高 → 间隔越短
  const r95 = schedule(e, RATING.GOOD, e.due, { requestRetention: 0.95 }).scheduledDays;
  const r85 = schedule(e, RATING.GOOD, e.due, { requestRetention: 0.85 }).scheduledDays;
  ok('retention 高则间隔短', r95 < r85, `95%:${r95} 85%:${r85}`);

  // 难卡的间隔应短于易卡
  const easyCard = { ...e, difficulty: 2 };
  const hardCard = { ...e, difficulty: 9 };
  const iEasy = schedule(easyCard, RATING.GOOD, e.due).scheduledDays;
  const iHard = schedule(hardCard, RATING.GOOD, e.due).scheduledDays;
  ok('难度高则间隔短', iHard < iEasy, `D9:${iHard} D2:${iEasy}`);

  // maximumInterval 生效
  const capped = schedule({ ...e, stability: 100000 }, RATING.GOOD, e.due, { maximumInterval: 365 });
  ok('maximumInterval 封顶', capped.scheduledDays === 365, capped.scheduledDays);

  // 学习阶段每一步的四档都必须严格递增（UI 上四个按钮不能有等价的）
  let lc = schedule({ ...newCardState() }, RATING.GOOD, t0); // LEARNING step 1
  ok('学习卡在 step1', lc.state === STATE.LEARNING && lc.step === 1, `${lc.state}/${lc.step}`);
  const pL1 = previewIntervals(lc, lc.due);
  ok('学习step1四档递增', pL1[1] < pL1[2] && pL1[2] < pL1[3] && pL1[3] < pL1[4],
    [1, 2, 3, 4].map((k) => fmtMin(pL1[k])).join(' < '));
  ok('学习中Again退回1分钟(不是进重学的10分钟)', near(pL1[1], 60000, 1), fmtMin(pL1[1]));
  ok('学习step1按Good毕业进REVIEW', schedule(lc, RATING.GOOD, lc.due).state === STATE.REVIEW);

  let lc0 = schedule(lc, RATING.AGAIN, lc.due); // LEARNING step 0
  ok('学习中Again后仍是LEARNING', lc0.state === STATE.LEARNING && lc0.step === 0, `${lc0.state}/${lc0.step}`);
  ok('学习中Again不计lapse', lc0.lapses === lc.lapses, `${lc0.lapses} vs ${lc.lapses}`);
  const pL0 = previewIntervals(lc0, lc0.due);
  ok('学习step0四档递增', pL0[1] < pL0[2] && pL0[2] < pL0[3] && pL0[3] < pL0[4],
    [1, 2, 3, 4].map((k) => fmtMin(pL0[k])).join(' < '));

  // 重学阶段
  const lapsedCard = schedule(mid2, RATING.AGAIN, mid2.due);
  ok('毕业卡Again→RELEARNING', lapsedCard.state === STATE.RELEARNING, lapsedCard.state);
  ok('毕业卡Again计lapse', lapsedCard.lapses === mid2.lapses + 1, `${lapsedCard.lapses}`);
  const pR = previewIntervals(lapsedCard, lapsedCard.due);
  ok('重学四档递增', pR[1] < pR[2] && pR[2] < pR[3] && pR[3] < pR[4],
    [1, 2, 3, 4].map((k) => fmtMin(pR[k])).join(' < '));
  ok('重学Good毕业回REVIEW', schedule(lapsedCard, RATING.GOOD, lapsedCard.due).state === STATE.REVIEW);
}

console.log('\n=== 乐理换算 ===');
{
  ok("parseNote('A4')=69", parseNote('A4') === 69, parseNote('A4'));
  ok("parseNote('C4')=60", parseNote('C4') === 60, parseNote('C4'));
  ok("parseNote('C#3')=49", parseNote('C#3') === 49, parseNote('C#3'));
  ok("parseNote('Bb2')=46", parseNote('Bb2') === 46, parseNote('Bb2'));
  ok('midiToHz(69)=440', near(midiToHz(69), 440, 1e-9));
  ok('midiToHz(60)=261.626', near(midiToHz(60), 261.6256, 1e-3), midiToHz(60));
  ok('noteName(69)=A4', noteName(69) === 'A4', noteName(69));
  ok('noteName(60)=C4', noteName(60) === 'C4', noteName(60));
  const n = hzToNote(445);
  ok('445Hz≈A4+20cents', n.name === 'A4' && near(n.cents, 20, 1), JSON.stringify(n));
}

console.log('\n=== 音高检测 ===');
{
  const sr = 48000;
  const N = 2048;
  // 合成带谐波的类人声信号：基频 + 2/3/4 次谐波（谐波比基频还强，专门考八度错误）
  function voice(f0, sr, n, noise = 0) {
    const b = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      b[i] = 0.5 * Math.sin(2 * Math.PI * f0 * t)
           + 0.7 * Math.sin(2 * Math.PI * 2 * f0 * t + 0.3)
           + 0.4 * Math.sin(2 * Math.PI * 3 * f0 * t + 1.1)
           + 0.2 * Math.sin(2 * Math.PI * 4 * f0 * t + 2.0);
      if (noise) b[i] += noise * (Math.random() * 2 - 1);
      b[i] *= 0.4;
    }
    return b;
  }
  const cases = [
    ['E2 82.4Hz 男低', 82.41], ['A2 110Hz', 110], ['C3 130.8Hz', 130.81],
    ['G3 196Hz 男声中区', 196], ['A3 220Hz', 220], ['C4 261.6Hz', 261.63],
    ['E4 329.6Hz 女声中区', 329.63], ['A4 440Hz', 440], ['C5 523.3Hz', 523.25],
    ['A5 880Hz 女高', 880],
  ];
  for (const [label, f0] of cases) {
    const r = detectPitch(voice(f0, sr, N), sr);
    const cents = r.hz > 0 ? Math.abs(1200 * Math.log2(r.hz / f0)) : 9999;
    ok(`${label} 误差<15音分`, cents < 15, `得到 ${r.hz.toFixed(2)}Hz 偏 ${cents.toFixed(1)}音分 clarity=${r.clarity.toFixed(3)}`);
  }
  // 加噪声（模拟手机麦克风环境底噪）
  const rn = detectPitch(voice(220, sr, N, 0.05), sr);
  const cn = rn.hz > 0 ? Math.abs(1200 * Math.log2(rn.hz / 220)) : 9999;
  ok('带噪 220Hz 误差<25音分', cn < 25, `${rn.hz.toFixed(2)}Hz 偏 ${cn.toFixed(1)}`);

  // 静音必须报未检出，不能瞎猜
  const silence = new Float32Array(N);
  ok('静音→未检出', detectPitch(silence, sr).hz < 0);
  const tiny = new Float32Array(N).map(() => (Math.random() * 2 - 1) * 0.001);
  ok('极小底噪→未检出', detectPitch(tiny, sr).hz < 0, detectPitch(tiny, sr).hz);

  // 轨迹统计
  const track = [];
  for (let i = 0; i < 50; i++) track.push({ hz: midiToHz(60 + (i % 13)), clarity: 0.95 });
  const acc = pitchAccuracy(track);
  ok('完美音准 medianCents≈0', acc && acc.medianCents < 1, JSON.stringify(acc));
  const rg = trackRange(track);
  ok('音域跨度≈12半音', rg && near(rg.semitones, 12, 1), JSON.stringify(rg));
  const off = track.map((p) => ({ hz: p.hz * Math.pow(2, 30 / 1200), clarity: 0.95 }));
  const accOff = pitchAccuracy(off);
  ok('整体偏30音分被测出', accOff && near(accOff.medianCents, 30, 2), JSON.stringify(accOff));
}

console.log('\n=== 性能（手机可行性）===');
{
  const sr = 48000;
  function voice(f0, sr, n) {
    const b = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      b[i] = 0.4 * (0.5 * Math.sin(2 * Math.PI * f0 * t) + 0.7 * Math.sin(4 * Math.PI * f0 * t) + 0.3 * Math.sin(6 * Math.PI * f0 * t));
    }
    return b;
  }
  // 实际运行配置：48k 采到 2048 点，降采样 3 倍 -> 16k / 682 点
  const raw = voice(196, sr, 2048);
  const dec = decimate(raw, 3);
  const decSr = sr / 3;
  const rd = detectPitch(dec, decSr);
  const cd = rd.hz > 0 ? Math.abs(1200 * Math.log2(rd.hz / 196)) : 9999;
  ok('降采样后 196Hz 误差<20音分', cd < 20, `${rd.hz.toFixed(2)}Hz 偏 ${cd.toFixed(1)}音分`);
  const rd2 = detectPitch(decimate(voice(440, sr, 2048), 3), decSr);
  ok('降采样后 440Hz 误差<20音分', Math.abs(1200 * Math.log2(rd2.hz / 440)) < 20, `${rd2.hz.toFixed(2)}Hz`);
  const rd3 = detectPitch(decimate(voice(98, sr, 4096), 3), decSr);
  ok('降采样后 98Hz(G2) 误差<25音分', rd3.hz > 0 && Math.abs(1200 * Math.log2(rd3.hz / 98)) < 25, `${rd3.hz.toFixed(2)}Hz`);

  const N = 300;
  let t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) detectPitch(decimate(raw, 3), decSr);
  let ms = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  console.log(`  INFO  降采样版单帧 ${ms.toFixed(2)} ms（含 decimate）`);
  ok('单帧 <8ms（手机约慢 3-5 倍，25fps 有余量）', ms < 8, `${ms.toFixed(2)}ms`);

  t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) detectPitch(raw, sr);
  const msFull = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  console.log(`  INFO  不降采样单帧 ${msFull.toFixed(2)} ms（对照，说明降采样必要性）`);
}

console.log(`\n结果: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
