// 离线语音识别（SenseVoice-small，模型打包在 APK 内）。
//
// 为什么自己做而不用系统的 SpeechRecognizer：
// 这台设备的系统语音服务拿不到录音 AppOps —— 日志里是
// "AppOps: Operation not found: pkg=com.xiaomi.mibrain.speech op=RECORD_AUDIO"，
// isRecognitionAvailable() 返回 true 但一录就报权限错误，反复授权也没用。
// 应用自己的麦克风（getUserMedia）一直是好的，所以自己采音 + 自己跑模型。
//
// 为什么换掉之前用的 Whisper base：
//   1. 慢。Whisper 的 encoder 固定要把输入 pad 到 30 秒，说 2 秒和说 20 秒
//      耗时一样，实测手机上 RTF 1.87（4.5 秒才认完一句）
//   2. 不准。它是多语言通用模型，中文和日文都不是强项
//   3. 语言自检不可靠 —— 实测把日语听成英文，转写出一串谐音英文
// SenseVoice-small 是非自回归 CTC 模型，一次前向出结果，且专攻中日英韩粤。
// 官方 python 实现在同一台机器上跑官方测试音频：RTF 0.033（比 Whisper 快 50 倍），
// 中日文都识别正确，语言标签也对。
//
// 代价是模型大（int8 239MB）。但它替掉了 Whisper 77MB + transformers.js 那套
// 额外的 onnxruntime 35MB，而且现在和 nmt.js 共用同一份 ORT。
//
// 前端（fbank → LFR → CMVN）必须和训练时逐参数一致，否则输出是乱码。
// 参数取自模型自带的 metadata 和 sherpa-onnx 的 kaldi-native-fbank 默认值。
const DIR = './models/sensevoice';
const ORT_DIR = './vendor/ort';

const SR = 16000;
const N_MEL = 80;
const FRAME_LEN = 400;      // 25ms
const FRAME_SHIFT = 160;    // 10ms
const N_FFT = 512;
const PREEMPH = 0.97;
const LANG = { auto: 0, zh: 3, en: 4, yue: 7, ja: 11, ko: 12 };
const WITHOUT_ITN = 15;

let ort = null;
let sess = null;
let tokens = null;   // id → piece
let meta = null;     // lfr 参数 + cmvn
let win = null;      // povey 窗
let melFb = null;    // mel 滤波器组
let loading = null;

export const state = { ready: false, loading: false, error: null, ms: 0 };

// ---------- 加载 ----------

async function loadOrt() {
  if (ort) return ort;
  const mod = await import(new URL(`${ORT_DIR}/ort.min.mjs`, location.href).href);
  ort = mod.default || mod;
  ort.env.wasm.wasmPaths = new URL(`${ORT_DIR}/`, location.href).href;
  ort.env.wasm.numThreads = 1;   // WebView 里拿不到 SharedArrayBuffer
  ort.env.wasm.simd = true;
  ort.env.logLevel = 'error';
  return ort;
}

export function load() {
  if (loading) return loading;
  state.loading = true;
  loading = (async () => {
    const t0 = performance.now();
    try {
      const o = await loadOrt();
      const [tk, mt] = await Promise.all([
        fetch(`${DIR}/tokens.txt`).then((r) => r.text()),
        fetch(`${DIR}/meta.json`).then((r) => r.json()),
      ]);
      tokens = [];
      for (const line of tk.split('\n')) {
        if (!line) continue;
        const i = line.lastIndexOf(' ');
        if (i < 0) continue;
        tokens[+line.slice(i + 1)] = line.slice(0, i);
      }
      meta = mt;
      win = poveyWindow(FRAME_LEN);
      melFb = melBank(SR, N_FFT, N_MEL);
      sess = await o.InferenceSession.create(`${DIR}/model.int8.onnx`,
        { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
      state.ready = true;
      state.ms = Math.round(performance.now() - t0);
      return true;
    } catch (e) {
      state.error = String((e && e.message) || e);
      return false;
    } finally {
      state.loading = false;
    }
  })();
  return loading;
}

export function available() { return state.ready; }

/** 释放模型（239MB）。四套模型全常驻会把 WebView 渲染进程挤爆。 */
export async function unload() {
  const s = sess;
  sess = null;
  loading = null;
  state.ready = false;
  if (s) { try { await s.release(); } catch { /* 已经释放了 */ } }
}

// ---------- 特征：kaldi 风格 fbank ----------

/** kaldi 的 povey 窗 = hann^0.85 */
function poveyWindow(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = Math.pow(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)), 0.85);
  }
  return w;
}

const hz2mel = (f) => 1127 * Math.log(1 + f / 700);

/** kaldi 的三角 mel 滤波器组，低频 20Hz 到 nyquist。 */
function melBank(sr, nfft, nmel) {
  const nyq = sr / 2;
  const bins = nfft / 2 + 1;
  const lo = hz2mel(20);
  const hi = hz2mel(nyq);
  const delta = (hi - lo) / (nmel + 1);
  const fb = [];
  for (let m = 0; m < nmel; m++) {
    const left = lo + m * delta;
    const center = left + delta;
    const right = center + delta;
    const idx = [];
    const wts = [];
    for (let k = 0; k < bins; k++) {
      const mel = hz2mel((k * sr) / nfft);
      if (mel <= left || mel >= right) continue;
      idx.push(k);
      wts.push(mel <= center ? (mel - left) / delta : (right - mel) / delta);
    }
    fb.push({ idx, wts });
  }
  return fb;
}

/** 原地 radix-2 复数 FFT。 */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/**
 * 算 fbank。逐参数对齐 kaldi-native-fbank 的默认设置：
 * 25ms 窗 / 10ms 步长、povey 窗、去直流、预加重 0.97、power 谱、log mel、
 * snip_edges（末尾不足一帧就丢掉）。
 * 模型 metadata 里 normalize_samples=0，意思是样本要用 [-32768, 32767] 的量级，
 * 而浏览器给的是 [-1, 1]，所以这里乘回 32768。
 */
export function fbank(pcm) {
  const nFrames = pcm.length < FRAME_LEN ? 0
    : 1 + Math.floor((pcm.length - FRAME_LEN) / FRAME_SHIFT);
  const out = [];
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  const buf = new Float64Array(FRAME_LEN);
  for (let f = 0; f < nFrames; f++) {
    const off = f * FRAME_SHIFT;
    let sum = 0;
    for (let i = 0; i < FRAME_LEN; i++) {
      buf[i] = pcm[off + i] * 32768;
      sum += buf[i];
    }
    const mean = sum / FRAME_LEN;
    for (let i = 0; i < FRAME_LEN; i++) buf[i] -= mean;       // 去直流
    for (let i = FRAME_LEN - 1; i > 0; i--) {                  // 预加重
      buf[i] -= PREEMPH * buf[i - 1];
    }
    buf[0] -= PREEMPH * buf[0];
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < FRAME_LEN; i++) re[i] = buf[i] * win[i];
    fft(re, im);
    const row = new Float32Array(N_MEL);
    for (let m = 0; m < N_MEL; m++) {
      const { idx, wts } = melFb[m];
      let e = 0;
      for (let k = 0; k < idx.length; k++) {
        const b = idx[k];
        e += (re[b] * re[b] + im[b] * im[b]) * wts[k];
      }
      row[m] = Math.log(Math.max(e, 1.1754944e-38));           // kaldi 的 log 下限
    }
    out.push(row);
  }
  return out;
}

/**
 * LFR（low frame rate）：把相邻 7 帧拼成一帧、步长 6，帧率降到 1/6。
 * 前面补 3 帧（复制首帧）、末尾不足就重复尾帧 —— 与 FunASR 的 apply_lfr 一致。
 * 然后做 CMVN：(x + neg_mean) * inv_stddev。
 */
export function lfrCmvn(feats) {
  const m = meta.lfr_m, n = meta.lfr_n;
  const pad = Math.floor((m - 1) / 2);
  const src = [];
  for (let i = 0; i < pad; i++) src.push(feats[0]);
  for (const f of feats) src.push(f);
  const T = src.length;
  const outT = Math.ceil(feats.length / n);
  const dim = N_MEL * m;
  const out = new Float32Array(outT * dim);
  for (let i = 0; i < outT; i++) {
    for (let k = 0; k < m; k++) {
      const row = src[Math.min(i * n + k, T - 1)];
      out.set(row, i * dim + k * N_MEL);
    }
    for (let d = 0; d < dim; d++) {
      out[i * dim + d] = (out[i * dim + d] + meta.neg_mean[d]) * meta.inv_stddev[d];
    }
  }
  return { data: out, frames: outT, dim };
}

// ---------- 解码 ----------

/** CTC 贪心解码：取每帧最大、去掉连续重复、去掉 blank(0)。 */
function ctcGreedy(logits, T, V) {
  const ids = [];
  let prev = -1;
  for (let t = 0; t < T; t++) {
    let best = 0;
    let bv = -Infinity;
    const base = t * V;
    for (let v = 0; v < V; v++) {
      if (logits[base + v] > bv) { bv = logits[base + v]; best = v; }
    }
    if (best !== prev && best !== 0) ids.push(best);
    prev = best;
  }
  return ids;
}

/** token 拼回文本，顺便把模型输出的 <|zh|> 这类标签摘出来。 */
function detok(ids) {
  let text = '';
  let lang = null;
  for (const id of ids) {
    const p = tokens[id];
    if (!p) continue;
    if (p.startsWith('<|')) {
      const m = p.match(/^<\|(zh|ja|en|ko|yue)\|>$/);
      if (m && !lang) lang = m[1];
      continue;                       // 语言/情感/事件标签不进正文
    }
    if (p === '<unk>' || p === '<s>' || p === '</s>') continue;
    text += p.startsWith('\u2581') ? ' ' + p.slice(1) : p;
  }
  return { text: text.trim(), lang };
}

/**
 * 识别一段 16kHz 单声道音频。
 * @param {{language?:'zh'|'ja'|'auto'}} opt 默认 auto —— SenseVoice 自己判断语言，
 *   实测官方模型对中日判别是对的（这正是面对面对话需要的）。
 */
export async function recognize(pcm16k, opt = {}) {
  if (!state.ready) throw new Error('识别模型未加载');
  const t0 = performance.now();
  const feats = fbank(pcm16k);
  if (!feats.length) return { text: '', lang: null, ms: 0 };
  const { data, frames, dim } = lfrCmvn(feats);
  const langId = LANG[opt.language || 'auto'] ?? LANG.auto;
  const out = await sess.run({
    x: new ort.Tensor('float32', data, [1, frames, dim]),
    x_length: new ort.Tensor('int32', Int32Array.from([frames]), [1]),
    language: new ort.Tensor('int32', Int32Array.from([langId]), [1]),
    text_norm: new ort.Tensor('int32', Int32Array.from([WITHOUT_ITN]), [1]),
  });
  const logits = out.logits;
  const [, T, V] = logits.dims;
  const { text, lang } = detok(ctcGreedy(logits.data, T, V));
  return { text, lang, ms: Math.round(performance.now() - t0),
           seconds: +(pcm16k.length / SR).toFixed(2) };
}

/**
 * 识别并给出语言。SenseVoice 自己就会判语言，所以不再需要「先指定语言、
 * 再用假名比例复核」那套绕法（那是 Whisper 语言自检不可靠时的补救）。
 * 这里只在模型没给出语言标签时，用文本字符兜底判断。
 */
export async function recognizeChecked(pcm16k, preferLang) {
  const r = await recognize(pcm16k, { language: 'auto' });
  const lang = r.lang || guessLang(r.text) || preferLang;
  return { ...r, lang, retried: false };
}

/** 兜底：从文本判断语言。日语正常句子必然有假名，中文一个都没有。 */
export function guessLang(text) {
  const s = String(text || '');
  const kana = (s.match(/[\u3040-\u309f\u30a0-\u30ff]/g) || []).length;
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  if (!kana && !cjk) return null;
  return kana / Math.max(1, kana + cjk) > 0.12 ? 'ja' : 'zh';
}

// ---------- 录音 ----------
// 用 MediaRecorder 而不是 Mic 那套 AnalyserNode + requestAnimationFrame：
// 后者是为实时音高显示做的，每帧只取当前分析窗口，帧之间会重叠或漏采，
// 拼不出完整波形。识别要的是连续、无缺口的音频。

/** 把任意采样率的单声道 PCM 重采样到 16kHz。 */
export function resample16k(pcm, srcRate) {
  if (srcRate === SR) return pcm;
  const ratio = srcRate / SR;
  const out = new Float32Array(Math.floor(pcm.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const i1 = Math.min(pcm.length - 1, i0 + 1);
    out[i] = pcm[i0] + (pcm[i1] - pcm[i0]) * (x - i0);
  }
  return out;
}

/** 开始录音。调用返回对象的 stop() 拿到 16kHz 单声道 PCM。 */
export async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', '']
    .find((t) => !t || (window.MediaRecorder && MediaRecorder.isTypeSupported(t)));
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.start();
  const t0 = performance.now();
  // 顺便挂一个分析节点读实时电平：录音时界面要能显示「确实在收音」，
  // 否则用户唯一的反馈就是等几秒后出来一句错的识别结果。
  let mon = null;
  let an = null;
  let tmp = null;
  try {
    mon = new (window.AudioContext || window.webkitAudioContext)();
    an = mon.createAnalyser();
    an.fftSize = 1024;
    mon.createMediaStreamSource(stream).connect(an);
    tmp = new Float32Array(an.fftSize);
  } catch { /* 拿不到电平不影响录音 */ }
  return {
    get seconds() { return (performance.now() - t0) / 1000; },
    get level() {
      if (!an) return 0;
      an.getFloatTimeDomainData(tmp);
      let peak = 0;
      for (let i = 0; i < tmp.length; i++) {
        const v = Math.abs(tmp[i]);
        if (v > peak) peak = v;
      }
      return peak;
    },
    async stop() {
      await new Promise((res) => { rec.onstop = res; rec.stop(); });
      stream.getTracks().forEach((t) => t.stop());
      if (mon) { try { await mon.close(); } catch { /* 已经关了 */ } }
      if (!chunks.length) return { pcm: new Float32Array(0), seconds: 0 };
      const blob = new Blob(chunks, mime ? { type: mime } : undefined);
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
      const ch0 = buf.getChannelData(0);
      const mono = new Float32Array(ch0.length);
      if (buf.numberOfChannels > 1) {
        const ch1 = buf.getChannelData(1);
        for (let i = 0; i < ch0.length; i++) mono[i] = (ch0[i] + ch1[i]) / 2;
      } else {
        mono.set(ch0);
      }
      ctx.close();
      return { pcm: resample16k(mono, buf.sampleRate), seconds: buf.duration };
    },
  };
}
