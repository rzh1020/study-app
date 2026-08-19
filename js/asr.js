// 离线语音识别（Whisper base，模型打包在 APK 内）。
//
// 为什么要自己做，而不用系统的 SpeechRecognizer：
// 这台设备上系统语音服务（com.xiaomi.mibrain.speech）拿不到录音 AppOps ——
// 日志里是 "AppOps: Operation not found: pkg=com.xiaomi.mibrain.speech
// op=RECORD_AUDIO"，表现为 isRecognitionAvailable() 返回 true 但一录就报
// ERROR_INSUFFICIENT_PERMISSIONS。这是系统服务侧的限制，本应用反复申请权限也没用。
// 而应用自己的麦克风（getUserMedia）是好的（练声页一直在用），
// 所以路子是：自己采音 + 自己跑模型。
//
// 附带好处：Whisper 自己会判断说的是哪种语言，面对面对话不用先手动选
// 「我说中文还是日文」—— 系统 ASR 做不到这一点（它必须先指定语言）。
//
// 用 transformers.js 而不像 nmt.js 那样手写推理：Whisper 的官方 ONNX 是
// 现成量化好的，而且 mel 特征、分词、时间戳解码都由它处理，没必要重做。
const MODEL = 'whisper-base';
const MODEL_ROOT = '/models/';
// 单独一份 ORT：transformers.js 自带的 onnxruntime 版本比 nmt.js 用的 1.20.1 新，
// 需要 asyncify 变体的 wasm，两者不能混用。
const ORT_DIR = '/vendor/ort-tf/';
// 用 transformers.min.js 而不是 .web.min.js：后者把 onnxruntime-web 当外部
// 依赖（裸模块名 import），浏览器里解析不了；前者是自包含的。
const LIB = './vendor/transformers/transformers.min.js';

let tf = null;        // transformers.js 命名空间
let pipe = null;      // 识别 pipeline
let loading = null;

export const state = { ready: false, loading: false, error: null, ms: 0 };

async function lib() {
  if (tf) return tf;
  tf = await import(new URL(LIB, location.href).href);
  const env = tf.env;
  // 全部本地：这个 App 没有联网权限，任何远程拉取都会失败
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  // 必须是「路径」而不是完整 URL：transformers.js 内部会自己做拼接，
  // 传 http://... 进去会拼坏，表现为读 tokenizer_config.json 得到 undefined。
  env.localModelPath = MODEL_ROOT;
  env.backends.onnx.wasm.wasmPaths = ORT_DIR;
  env.backends.onnx.wasm.numThreads = 1;   // WebView 里拿不到 SharedArrayBuffer
  return tf;
}

/** 加载识别模型（约 77MB）。重复调用共用一个 promise。 */
export function load() {
  if (loading) return loading;
  state.loading = true;
  loading = (async () => {
    const t0 = performance.now();
    try {
      const T = await lib();
      pipe = await T.pipeline('automatic-speech-recognition', MODEL, {
        dtype: 'q8',
        device: 'wasm',
        // 关掉图优化：q8 的 decoder 在新版 onnxruntime 的 QDQ 优化里会报
        // "TransposeDQWeightsForMatMulNBits Missing required scale"，
        // 优化本身对 wasm 单线程收益也有限。
        session_options: { graphOptimizationLevel: 'disabled' },
      });
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

/** 释放识别模型（77MB）。 */
export async function unload() {
  const p = pipe;
  pipe = null;
  loading = null;
  state.ready = false;
  if (p && p.dispose) { try { await p.dispose(); } catch { /* 已经释放了 */ } }
}

/** 把任意采样率的单声道 PCM 重采样到 Whisper 要的 16kHz。 */
export function resample16k(pcm, srcRate) {
  if (srcRate === 16000) return pcm;
  const ratio = srcRate / 16000;
  const out = new Float32Array(Math.floor(pcm.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const i1 = Math.min(pcm.length - 1, i0 + 1);
    out[i] = pcm[i0] + (pcm[i1] - pcm[i0]) * (x - i0);   // 线性插值够用
  }
  return out;
}

/**
 * 识别一段音频。
 * @param {Float32Array} pcm16k 16kHz 单声道
 * @param {{language?:string}} opt language 留空 = 让模型自己判断说的是什么语言
 */
export async function recognize(pcm16k, opt = {}) {
  if (!state.ready) throw new Error('识别模型未加载');
  const t0 = performance.now();
  // task 必须显式给 transcribe。默认会走 translate —— Whisper 会把日语
  // 直接翻成英文（实测「これはいくらですか」变成 "This is Sakura."），
  // 而我们要的是原文转写，翻译交给后面的 NMT。
  const args = { task: 'transcribe', chunk_length_s: 30, return_timestamps: false };
  // language 留空 = 让模型自己判断说的是什么语言，这正是面对面对话需要的
  if (opt.language) args.language = opt.language;
  const r = await pipe(pcm16k, args);
  const text = String((r && r.text) || '').trim();
  return { text, ms: Math.round(performance.now() - t0), lang: guessLang(text) };
}

/**
 * 从识别结果判断语言。
 * Whisper 内部检测到的语言 transformers.js 不直接回传，而实测它对合成语音的
 * 语言判别并不可靠（日语音频被判成英文，转写出一串谐音英文）。
 * 好在中日两种语言的输出文本本身就是硬证据：日语正常句子必然带助词假名，
 * 中文一个假名都不会有。
 */
export function guessLang(text) {
  const s = String(text || '');
  const kana = (s.match(/[\u3040-\u309f\u30a0-\u30ff]/g) || []).length;
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  if (!kana && !cjk) return null;
  return kana / Math.max(1, kana + cjk) > 0.12 ? 'ja' : 'zh';
}

/**
 * 指定语言识别，并对结果做一次语言复核。
 *
 * 为什么不直接用自动检测：实测 Whisper 的语言自检会把日语听成英文。
 * 所以由界面给出「这一轮谁在说」，指定语言识别（准确得多）；
 * 万一说话人和按钮不符（日语按钮说了中文），用文本里的假名比例能看出来，
 * 这时才用另一种语言重识别一次 —— 只有判错时才付双倍时间。
 */
export async function recognizeChecked(pcm16k, preferLang) {
  const first = await recognize(pcm16k, { language: preferLang });
  const seen = guessLang(first.text);
  if (seen && seen !== preferLang) {
    const second = await recognize(pcm16k, { language: seen });
    return { ...second, lang: seen, retried: true, firstText: first.text };
  }
  return { ...first, lang: seen || preferLang, retried: false };
}

// ---------- 录音 ----------
// 用 MediaRecorder 而不是 Mic 那套 AnalyserNode + requestAnimationFrame：
// 后者是为实时音高显示做的，每帧只取当前分析窗口，帧之间会重叠或漏采，
// 拼不出完整波形。识别要的是连续、无缺口的音频。

/** 开始录音。返回一个对象，调用它的 stop() 拿到 16kHz 单声道 PCM。 */
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
  let tmp = null;
  let an = null;
  try {
    mon = new (window.AudioContext || window.webkitAudioContext)();
    an = mon.createAnalyser();
    an.fftSize = 1024;
    mon.createMediaStreamSource(stream).connect(an);
    tmp = new Float32Array(an.fftSize);
  } catch { /* 拿不到电平不影响录音 */ }
  return {
    get seconds() { return (performance.now() - t0) / 1000; },
    /** 当前输入电平 0..1，用来画电平条 */
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
