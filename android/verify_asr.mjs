/**
 * 真机验证离线语音识别。
 *
 * 麦克风采集要人说话，没法全自动，所以分两段验证：
 *   1. 识别质量与速度：用自家 TTS 合成一段日语，直接喂给识别 —— 不用人开口
 *   2. 麦克风通路：真开一次麦克风录 1.2 秒，看能不能拿到波形
 *      （系统语音服务录不了音，但应用自己的麦克风是好的，这一步就是在证明这点）
 */
import { execSync } from 'child_process';
import puppeteer from 'puppeteer-core';
const sh = (c) => { try { return execSync(c, { encoding: 'utf8' }).trim(); } catch { return ''; } };
const pid = sh('adb shell pidof com.rzh.studyhub').split(/\s+/)[0];
if (!pid) { console.error('App 没在运行'); process.exit(1); }
sh('adb forward --remove tcp:9350');
sh(`adb forward tcp:9350 localabstract:webview_devtools_remote_${pid}`);
const ver = JSON.parse(sh('curl -s -m 10 http://127.0.0.1:9350/json/version'));
const b = await puppeteer.connect({ browserWSEndpoint: ver.webSocketDebuggerUrl,
  defaultViewport: null, protocolTimeout: 1800000 });
const page = (await b.pages()).find((p) => p.url().includes('appassets'));
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  PASS  ${n}`); }
  else { fail++; console.log(`  FAIL  ${n}  ${e}`); } };

console.log('\n=== 识别模型（SenseVoice-small，APK 内 229MB）===');
const r = await page.evaluate(async () => {
  const out = {};
  const A = await import('./js/asr.js');
  const t0 = performance.now();
  out.load = await A.load();
  out.loadMs = Math.round(performance.now() - t0);
  out.err = A.state.error;
  if (!out.load) return out;
  const T = await import('./js/tts.js');
  await T.load();
  out.cases = [];
  for (const kana of ['これはいくらですか', 'しゃしんをとってもらえますか']) {
    const s = await T.synth(kana);
    const pcm = A.resample16k(s.pcm instanceof Float32Array ? s.pcm : Float32Array.from(s.pcm), 24000);
    // 不指定语言：验证模型自己判语言
    const h = await A.recognize(pcm);
    out.cases.push({ said: kana, heard: h.text, lang: h.lang, ms: h.ms, sec: s.seconds });
  }
  return out;
});
ok('识别模型从 APK 内加载成功', r.load === true, r.err || '');
if (r.load) {
  console.log(`  INFO  加载耗时 ${r.loadMs}ms`);
  for (const c of r.cases) {
    console.log(`  说: ${c.said}\n    听成: ${c.heard}   (${c.sec}s 音频 / 识别 ${c.ms}ms / 判定语言 ${c.lang})`);
  }
  ok('识别出日语文本', r.cases.every((c) => /[\u3040-\u30ff]/.test(c.heard)),
    JSON.stringify(r.cases.map((c) => c.heard)));
  const avg = Math.round(r.cases.reduce((a, c) => a + c.ms, 0) / r.cases.length);
  const rtf = (r.cases.reduce((a, c) => a + c.ms / 1000, 0) / r.cases.reduce((a, c) => a + c.sec, 0)).toFixed(2);
  console.log(`  INFO  手机识别速度 平均 ${avg}ms/句，RTF ${rtf}（<1 表示比实时快）`);
}

console.log('\n=== 麦克风通路（应用自己的麦克风，不经过系统语音服务）===');
const m = await page.evaluate(async () => {
  try {
    const A = await import('./js/asr.js');
    const rec = await A.startRecording();
    // MediaRecorder 从 start() 到真正出数据有几百毫秒延迟，等久一点才拿得到完整片段
    await new Promise((r) => setTimeout(r, 2500));
    const { pcm, seconds } = await rec.stop();
    let peak = 0;
    for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]));
    return { ok: true, samples: pcm.length, seconds: +seconds.toFixed(2), peak: +peak.toFixed(4) };
  } catch (e) { return { ok: false, err: String((e && e.message) || e) }; }
});
// 只验证「能开、有波形」；音量取决于环境，不能当判据
  ok('能打开麦克风并录到波形', m.ok === true && m.samples > 8000 && m.peak > 0, JSON.stringify(m));
if (m.ok) console.log(`  INFO  录到 ${m.samples} 个采样点（${m.seconds}s，16kHz），峰值 ${m.peak}`);

console.log(`\n结果: ${pass} passed, ${fail} failed`);
b.disconnect();
process.exit(fail ? 1 : 0);
