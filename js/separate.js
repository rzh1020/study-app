// 人声分离（Spleeter 2stems 的 vocals 分支，模型打包在 APK 内，int8 26MB）。
//
// 为什么需要：带唱要从「我自己的歌」里提取主旋律，而从商业混音里直接提旋律
// 是研究级难题 —— 人声被压缩、混响、和声、电子音色包围，谐波显著度不突出，
// 实测拿真实歌曲（陶喆那种录音）根本提不出来。先把人声分出来再提，才站得住。
//
// 分离效果（用神经 TTS 合成的语音 + 合成伴奏做对照，相关系数）：
//   分离出的人声轨 vs 真人声 +0.244，vs 真伴奏 +0.000
//   分离出的伴奏轨 vs 真伴奏 +0.221，vs 真人声 +0.001
// 相关系数绝对值不高是因为 Spleeter 走幅度谱 mask + 原相位重建，波形级不精确；
// 但选择性很干净（人声轨里几乎没有伴奏成分），这正是提旋律需要的。
//
// Spleeter 的前端参数是固定的（照 deezer/spleeter 的实现）：
//   STFT n_fft=4096 hop=1024 hann 窗，只取前 1024 个频点（模型输入宽度）
//   时间上每 512 帧切一块，模型一次吃 [2声道, 块数, 512帧, 1024频点] 的幅度谱
const DIR = './models/spleeter';
const ORT_DIR = './vendor/ort';
const N_FFT = 4096;
const HOP = 1024;
const N_BINS = 1024;     // 模型只看前 1024 个频点（约到 11kHz，人声够用）
const T_CHUNK = 512;     // 每块 512 帧

let ort = null;
let sess = null;
let loading = null;
let hann = null;

export const state = { ready: false, loading: false, error: null, ms: 0 };

async function loadOrt() {
  if (ort) return ort;
  const mod = await import(new URL(`${ORT_DIR}/ort.min.mjs`, location.href).href);
  ort = mod.default || mod;
  ort.env.wasm.wasmPaths = new URL(`${ORT_DIR}/`, location.href).href;
  ort.env.wasm.numThreads = 1;
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
      hann = new Float32Array(N_FFT);
      for (let i = 0; i < N_FFT; i++) {
        hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT);
      }
      sess = await o.InferenceSession.create(`${DIR}/vocals.int8.onnx`,
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

export async function unload() {
  const s = sess;
  sess = null;
  loading = null;
  state.ready = false;
  if (s) { try { await s.release(); } catch { /* 已经释放了 */ } }
}

/** 原地 radix-2 复数 FFT（正变换 sign=-1，逆变换 sign=+1）。 */
function fft(re, im, sign) {
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
    const ang = (sign * 2 * Math.PI) / len;
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
 * 分离出人声。
 * @param {Float32Array} left 左声道（单声道时右声道传同一份）
 * @param {Float32Array} right 右声道
 * @param {(p:number)=>void} onProgress 0..1
 * @returns {Promise<Float32Array>} 人声波形（与输入同长、单声道混合）
 */
export async function separateVocals(left, right, onProgress) {
  if (!state.ready) throw new Error('人声分离模型未加载');
  const N = left.length;
  const frames = N >= N_FFT ? 1 + Math.floor((N - N_FFT) / HOP) : 0;
  if (!frames) throw new Error('音频太短');
  const chunks = Math.ceil(frames / T_CHUNK);
  const padded = chunks * T_CHUNK;

  // 幅度谱给模型；相位留着重建波形用（Spleeter 本身也是这么做的）
  const mag = new Float32Array(2 * chunks * T_CHUNK * N_BINS);
  const phRe = [new Float32Array(frames * N_BINS), new Float32Array(frames * N_BINS)];
  const phIm = [new Float32Array(frames * N_BINS), new Float32Array(frames * N_BINS)];
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);

  for (let c = 0; c < 2; c++) {
    const src = c === 0 ? left : right;
    for (let f = 0; f < frames; f++) {
      const off = f * HOP;
      re.fill(0); im.fill(0);
      for (let i = 0; i < N_FFT; i++) re[i] = src[off + i] * hann[i];
      fft(re, im, -1);
      const base = (c * padded + f) * N_BINS;
      const pb = f * N_BINS;
      for (let k = 0; k < N_BINS; k++) {
        mag[base + k] = Math.hypot(re[k], im[k]);
        phRe[c][pb + k] = re[k];
        phIm[c][pb + k] = im[k];
      }
    }
    if (onProgress) onProgress(0.4 * ((c + 1) / 2));
    await new Promise((r) => setTimeout(r, 0));   // 让出主线程，界面不卡
  }

  const out = await sess.run({
    x: new ort.Tensor('float32', mag, [2, chunks, T_CHUNK, N_BINS]),
  });
  const y = out[sess.outputNames[0]].data;
  if (onProgress) onProgress(0.75);

  // iSTFT：模型给的人声幅度 + 原始相位，overlap-add 回波形。
  // 两个声道直接平均成单声道 —— 后面只用来提音高，不需要立体声。
  const acc = new Float32Array(N);
  const wsum = new Float32Array(N);
  for (let c = 0; c < 2; c++) {
    for (let f = 0; f < frames; f++) {
      const base = (c * padded + f) * N_BINS;
      const pb = f * N_BINS;
      re.fill(0); im.fill(0);
      for (let k = 0; k < N_BINS; k++) {
        const m0 = Math.hypot(phRe[c][pb + k], phIm[c][pb + k]);
        const scale = m0 > 1e-9 ? y[base + k] / m0 : 0;    // 相位保持，只换幅度
        re[k] = phRe[c][pb + k] * scale;
        im[k] = phIm[c][pb + k] * scale;
        if (k > 0 && k < N_FFT / 2) {                       // 共轭对称补全
          re[N_FFT - k] = re[k];
          im[N_FFT - k] = -im[k];
        }
      }
      fft(re, im, +1);
      const off = f * HOP;
      for (let i = 0; i < N_FFT; i++) {
        acc[off + i] += (re[i] / N_FFT) * hann[i] * 0.5;    // 0.5 = 两声道平均
        if (c === 0) wsum[off + i] += hann[i] * hann[i];
      }
    }
    if (onProgress) onProgress(0.75 + 0.24 * ((c + 1) / 2));
    await new Promise((r) => setTimeout(r, 0));
  }
  let peak = 0;
  for (let i = 0; i < N; i++) {
    if (wsum[i] > 1e-6) acc[i] /= wsum[i];
    const a = Math.abs(acc[i]);
    if (a > peak) peak = a;
  }
  // 重建后可能略微过冲（实测峰值 1.08），归一化避免后续处理里被削波
  if (peak > 1) {
    for (let i = 0; i < N; i++) acc[i] /= peak;
  }
  if (onProgress) onProgress(1);
  return acc;
}
