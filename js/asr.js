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
const MODEL_ROOT = './models/';
// 单独一份 ORT：transformers.js 自带的 onnxruntime 版本比 nmt.js 用的 1.20.1 新，
// 需要 asyncify 变体的 wasm，两者不能混用。
const ORT_DIR = './vendor/ort-tf/';
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
  env.localModelPath = new URL(MODEL_ROOT, location.href).href;
  env.backends.onnx.wasm.wasmPaths = new URL(ORT_DIR, location.href).href;
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
  const args = { chunk_length_s: 30, return_timestamps: false };
  if (opt.language) args.language = opt.language;
  const r = await pipe(pcm16k, args);
  const text = String((r && r.text) || '').trim();
  return { text, ms: Math.round(performance.now() - t0), lang: guessLang(text) };
}

/**
 * 从识别结果判断语言。
 * Whisper 内部检测到的语言 transformers.js 不直接回传，但对中日两种语言，
 * 输出文本本身就是最可靠的证据：有假名一定是日语。
 */
export function guessLang(text) {
  const s = String(text || '');
  if (/[\u3040-\u309f\u30a0-\u30ff]/.test(s)) return 'ja';
  if (/[\u4e00-\u9fff]/.test(s)) return 'zh';
  return null;
}
