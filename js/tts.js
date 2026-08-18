// 日语神经语音合成（Kokoro-82M，离线，模型打包在 APK 内）。
//
// 为什么要有这个文件：原来的日语朗读是「127 句预渲染录音 + 104 个音节录音拼接」
// （见 jaspeech.js）。翻译出来的句子几乎不可能命中那 127 句，于是每次都走
// 音节拼接 —— 一个假名一个假名拼，语调是平的、音节之间有断点，听着难受。
// Kokoro 是端到端 TTS，整句一次生成，有连读和自然语调。
//
// 链路：中文 → NMT（nmt.js）→ 日语文本 → toKana（jaspeech.js，汉字转假名）
//       → 本文件（假名转 IPA 音素）→ Kokoro → 24kHz 波形
//
// G2P 说明：Kokoro 吃 IPA 音素。官方前端是 misaki，它的日语部分靠 pyopenjtalk
// （C++，进不了 WebView）做汉字转假名和音调分析。但汉字转假名我们本来就有；
// 而音调（pitch accent）在 misaki 当前版本里是被注释掉的 —— 官方日语音素串
// 就是 mora 表直接拼接，所以这里只需要那张 193 条的 mora→音素表。
const DIR = './models/kokoro';
const ORT_DIR = './vendor/ort';
const SR = 24000;

let ort = null;
let sess = null;
let vocab = null;   // 音素字符 → token id
let m2p = null;     // 片假名 mora → IPA 音素
let readings = null; // 词典读音集合，用于判断 は/へ 是否落在词内部
let styles = null;  // voice 向量表 [511][1][256]
let loading = null;
let ctx = null;
const sources = [];   // 已排队的播放节点，stop 时要全部掐掉
let playToken = null; // 标识当前一次播放，异步合成回来时用它判断是否已被打断

export const state = { ready: false, loading: false, error: null, voice: 'jf_alpha' };

const HIRA_TO_KATA = (c) => {
  const n = c.codePointAt(0);
  return n >= 0x3041 && n <= 0x3096 ? String.fromCodePoint(n + 0x60) : c;
};
const PUNCT = { '、': ',', '。': '.', '！': '!', '？': '?', '「': '“', '」': '”',
                '：': ':', '；': ';', '（': '(', '）': ')', '，': ',' };
// misaki 用几个 IPA 扩展字符表示拗音，Kokoro 的 vocab 里没有它们，
// 但有 ʲ（palatalization），按 misaki 自己的 P2R 对应关系换写。
const FIX = { G: 'ɡw', K: 'kw', 'ƫ': 'tʲ', 'ᶀ': 'bʲ', 'ᶁ': 'dʲ', 'ᶃ': 'ɡʲ',
              'ᶄ': 'kʲ', 'ᶆ': 'mʲ', 'ᶈ': 'pʲ', 'ᶉ': 'rʲ' };

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

/** 加载模型（92MB int8 + 0.5MB 音色）。重复调用共用同一个 promise。 */
export function load(voice) {
  if (voice) state.voice = voice;
  if (loading) return loading;
  state.loading = true;
  loading = (async () => {
    try {
      const o = await loadOrt();
      const [tk, mp, vb] = await Promise.all([
        fetch(`${DIR}/tokenizer.json`).then((r) => r.json()),
        fetch(`${DIR}/m2p.json`).then((r) => r.json()),
        fetch(`${DIR}/${state.voice}.bin`).then((r) => r.arrayBuffer()),
      ]);
      vocab = (tk.model && tk.model.vocab) || tk.vocab;
      m2p = {};
      for (const [k, v] of Object.entries(mp)) {
        m2p[k] = [...v].map((c) => FIX[c] || c).join('');
      }
      const f = new Float32Array(vb);
      styles = { data: f, rows: f.length / 256 };
      sess = await o.InferenceSession.create(`${DIR}/model_quantized.onnx`,
        { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
      state.ready = true;
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

/** 词典读音集合（片假名），用来判断 は/へ 是不是词内部的音。 */
async function dictReadings() {
  if (readings) return readings;
  try {
    const d = await fetch('./data/k2k.json').then((r) => r.json());
    const w = d.words || d;
    readings = new Set(Object.values(w).filter((v) => typeof v === 'string'));
  } catch {
    readings = new Set();
  }
  return readings;
}

/**
 * 假名 → IPA 音素。
 *
 * 助词读音：を→o（を 只作助词，无条件）、は→wa、へ→e。
 * は/へ 要判断：句首或标点之后读本音，否则按助词读；如果「は + 后续假名」
 * 能构成词典里某个词的读音，也读本音 —— 否则 あさはやく 会被念成 asawayaku。
 * 这不是形态分析，但输入主要来自神经翻译的输出（含汉字、助词占绝大多数）。
 */
export function toPhonemes(kana) {
  const s = [...kana].map((c) => PUNCT[c] || HIRA_TO_KATA(c)).join('');
  const out = [];
  const unknown = [];
  let i = 0;
  while (i < s.length) {
    const one = s[i];
    if (one === 'ハ' || one === 'ヘ') {
      const atStart = i === 0 || '“”,.!?:;() '.includes(s[i - 1]);
      let inWord = false;
      if (!atStart && readings) {
        for (const L of [4, 3, 2]) {
          if (readings.has(s.slice(i, i + L))) { inWord = true; break; }
        }
      }
      if (!atStart && !inWord) {
        out.push(one === 'ハ' ? 'wa' : 'e');
        i++;
        continue;
      }
    }
    const two = s.slice(i, i + 2);
    if (two.length === 2 && m2p[two]) { out.push(m2p[two]); i += 2; continue; }
    if (m2p[one]) { out.push(m2p[one]); i++; continue; }
    if ('“”,.!?:;() '.includes(one)) { out.push(one); i++; continue; }
    unknown.push(one);
    i++;
  }
  return { phonemes: out.join(''), unknown };
}

function audioCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SR });
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

/** 合成波形。返回 Float32Array（24kHz 单声道）。 */
export async function synth(kana, opts = {}) {
  if (!state.ready) throw new Error('语音模型未加载');
  await dictReadings();
  const { phonemes, unknown } = toPhonemes(kana);
  const ids = [0];
  for (const c of phonemes) {
    const t = vocab[c];
    if (t !== undefined) ids.push(t);
  }
  ids.push(0);
  if (ids.length <= 2) throw new Error('没有可发音的内容');
  // voice 向量按「音素长度」索引：第 n 行对应长度 n 的输入
  const row = Math.min(ids.length - 2, styles.rows - 1);
  const style = styles.data.subarray(row * 256, row * 256 + 256);
  const t0 = performance.now();
  const out = await sess.run({
    input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
    style: new ort.Tensor('float32', Float32Array.from(style), [1, 256]),
    speed: new ort.Tensor('float32', Float32Array.from([opts.speed || 1.0]), [1]),
  });
  const pcm = out[sess.outputNames[0]].data;
  return { pcm, ms: Math.round(performance.now() - t0), phonemes, unknown,
           seconds: +(pcm.length / SR).toFixed(2) };
}

// ---------- 分句 + 缓存 ----------
// 合成耗时大致与句子长度成正比（手机上一整句长句要数秒）。按标点切成小句后
// 边合成边排队播放：第一小句一出来就出声，后面的在播放期间合成，
// 听感上等待时间从「整句合成完」缩短到「第一小句合成完」。
const cache = new Map();
const CACHE_MAX = 24;

function splitSentences(kana) {
  const parts = kana.split(/(?<=[。．.、,！!？?])/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const p of parts.length ? parts : [kana]) {
    // 太长的小句继续按逗号切不动了，只能整段合成；太短的合并，避免碎成一个字
    if (out.length && (out[out.length - 1].length < 6 || p.length < 4)) out[out.length - 1] += p;
    else out.push(p);
  }
  return out;
}

async function synthCached(part, speed) {
  const key = `${state.voice}|${speed}|${part}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const r = await synth(part, { speed });
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, r);
  return r;
}

/** 提前合成好放进缓存，点朗读时就能立刻出声。失败静默 —— 这只是优化。 */
export async function prewarm(kana, opts = {}) {
  if (!state.ready) return false;
  try {
    for (const p of splitSentences(kana)) await synthCached(p, opts.speed || 1.0);
    return true;
  } catch {
    return false;
  }
}

/** 合成并播放（分句流式）。返回合成信息。 */
export async function speak(kana, opts = {}) {
  const speed = opts.speed || 1.0;
  const parts = splitSentences(kana);
  stop();
  const c = audioCtx();
  const token = {};
  playToken = token;
  let cursor = c.currentTime + 0.05;
  let total = 0, ms = 0, first = 0;
  const t0 = performance.now();
  for (const p of parts) {
    const r = await synthCached(p, speed);
    if (playToken !== token) return { cancelled: true };  // 期间被 stop 了
    if (!first) first = Math.round(performance.now() - t0);
    ms += r.ms;
    const pcm = r.pcm instanceof Float32Array ? r.pcm : Float32Array.from(r.pcm);
    const buf = c.createBuffer(1, pcm.length, SR);
    buf.copyToChannel(pcm, 0);
    const src = c.createBufferSource();
    src.buffer = buf;
    src.connect(c.destination);
    const when = Math.max(c.currentTime, cursor);
    src.start(when);
    sources.push(src);
    cursor = when + buf.duration + 0.06;   // 句间留一点停顿，更像说话
    total += r.seconds;
  }
  return { seconds: +total.toFixed(2), ms, firstSoundMs: first, parts: parts.length };
}

export function stop() {
  playToken = null;
  for (const s of sources) {
    try { s.stop(); } catch { /* 已经停了 */ }
  }
  sources.length = 0;
}
