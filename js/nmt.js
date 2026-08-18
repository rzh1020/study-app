// 中日神经机器翻译（离线，模型打包在 APK 内）。
//
// 模型：Helsinki-NLP/opus-mt-tc-big-zh-ja，Marian 架构，6+6 层 d=1024。
// 导出成 ONNX 后动态量化到 int8（encoder 110MB + decoder 169MB），
// 用 onnxruntime-web 在 WebView 里跑。导出脚本见 .nmt/export.py。
//
// 这里为什么自己写分词和解码，而不用 transformers.js：
//   1. transformers.js 要 decoder_model_merged.onnx，那张图整体裹在一个 If 节点里，
//      onnxruntime 的量化器不递归进子图，量化后 670MB 一点没降 —— 进不了 APK。
//      改用无 KV cache 的 decoder_model.onnx，每步重喂整段已生成序列，
//      句子只有二三十个 token，O(n²) 的代价换掉了一张 156MB 的图。
//   2. Marian 没有 fast tokenizer，生成不出 transformers.js 要的 tokenizer.json。
//   3. 上游仓库的 vocab.json 是坏的 —— 它只对齐 target.spm（日语），
//      拿它切中文会整句变 <unk>，模型输出垃圾。所以源端直接用 source.spm 的
//      piece id（实测正确），vocab.json 完全弃用。
// 也就是说：手写的只是分词与解码这层胶水，翻译能力来自成熟 NMT 模型本身。

const MODEL_DIR = './models/zh-ja';
const ORT_DIR = './vendor/ort';

let ort = null;      // onnxruntime-web 命名空间
let enc = null;      // encoder session
let dec = null;      // decoder session
let cfg = null;      // eos / pad / decoder_start / max_new_tokens
let src = null;      // { pieces, scores, unk, trie }
let tgt = null;      // id → piece
let loading = null;  // 进行中的加载 promise，防止并发重复加载

export const state = { ready: false, loading: false, error: null, ms: 0 };

// ---------- 加载 ----------

async function loadOrt() {
  if (ort) return ort;
  // ort.min.mjs 是 ES module，import() 进来即可。注意 import() 的相对路径是相对
  // 「当前模块文件」解析的（会变成 /js/vendor/...），而 fetch 是相对文档 —— 这里
  // 统一用 new URL(..., location.href) 按文档根解析，两种加载方式才一致。
  const url = new URL(`${ORT_DIR}/ort.min.mjs`, location.href).href;
  const mod = await import(url);
  ort = mod.default || mod;
  ort.env.wasm.wasmPaths = new URL(`${ORT_DIR}/`, location.href).href;
  // SharedArrayBuffer 在 WebView 里拿不到（crossOriginIsolated=false），只能单线程。
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.simd = true;
  ort.env.logLevel = 'error';
  return ort;
}

/** 加载模型。280MB，首次约数秒；重复调用共用同一个 promise。 */
export function load() {
  if (loading) return loading;
  state.loading = true;
  loading = (async () => {
    const t0 = performance.now();
    try {
      const o = await loadOrt();
      const [c, s, t] = await Promise.all([
        fetch(`${MODEL_DIR}/nmt.json`).then((r) => r.json()),
        fetch(`${MODEL_DIR}/spm-src.json`).then((r) => r.json()),
        fetch(`${MODEL_DIR}/vocab-tgt.json`).then((r) => r.json()),
      ]);
      cfg = c;
      tgt = t;
      src = buildTokenizer(s);
      const opt = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
      // 顺序加载而不是并行：两张图加起来 280MB，同时解析会把内存峰值推高一倍。
      enc = await o.InferenceSession.create(`${MODEL_DIR}/encoder.int8.onnx`, opt);
      dec = await o.InferenceSession.create(`${MODEL_DIR}/decoder_step.int8.onnx`, opt);
      state.ready = true;
      state.ms = Math.round(performance.now() - t0);
      return true;
    } catch (e) {
      state.error = String(e && e.message ? e.message : e);
      return false;
    } finally {
      state.loading = false;
    }
  })();
  return loading;
}

export function available() {
  return state.ready;
}

// ---------- 分词：SentencePiece Unigram ----------

/**
 * Unigram 分词等价于在字符网格上求最大 log 概率路径（Viterbi）。
 * SentencePiece 的规则：先把空格换成 ▁，再在整串上做最长匹配集合的 DP。
 * 这里用一个 piece→id 的 Map + 最大 piece 字节长度限制搜索范围，
 * 对二三十字的句子足够快（<1ms）。
 */
function buildTokenizer(s) {
  const map = new Map();
  let maxLen = 1;
  for (let i = 0; i < s.pieces.length; i++) {
    map.set(s.pieces[i], i);
    if (s.pieces[i].length > maxLen) maxLen = s.pieces[i].length;
  }
  return { map, scores: s.scores, unk: s.unk, maxLen };
}

export function encode(text) {
  const t = '\u2581' + text.trim().replace(/\s+/g, '\u2581');
  const n = t.length;
  // best[i] = 切到第 i 个字符为止的最优得分；prev[i] = 上一个切点；pid[i] = 该段的 piece id
  const best = new Float64Array(n + 1).fill(-Infinity);
  const prev = new Int32Array(n + 1).fill(-1);
  const pid = new Int32Array(n + 1).fill(-1);
  best[0] = 0;
  for (let i = 0; i < n; i++) {
    if (best[i] === -Infinity) continue;
    const lim = Math.min(n, i + src.maxLen);
    let matched = false;
    for (let j = i + 1; j <= lim; j++) {
      const id = src.map.get(t.slice(i, j));
      if (id === undefined) continue;
      matched = true;
      const sc = best[i] + src.scores[id];
      if (sc > best[j]) { best[j] = sc; prev[j] = i; pid[j] = id; }
    }
    // 单字都不在词表里：退化成 unk，保证路径不断
    if (!matched) {
      const sc = best[i] - 10;
      if (sc > best[i + 1]) { best[i + 1] = sc; prev[i + 1] = i; pid[i + 1] = src.unk; }
    }
  }
  const ids = [];
  for (let i = n; i > 0; i = prev[i]) {
    if (prev[i] < 0) break;
    ids.push(pid[i]);
  }
  ids.reverse();
  ids.push(cfg.eos);
  return ids;
}

/** target piece 拼回文本。▁ 是词首标记，日语不写空格所以直接丢掉。 */
export function decodePieces(ids) {
  let out = '';
  for (const i of ids) {
    const p = i >= 0 && i < tgt.length ? tgt[i] : '';
    out += p;
  }
  return out.replace(/\u2581/g, ' ').trim();
}

// ---------- 解码：beam search ----------

function softmaxTop(logits, vocab, k) {
  // 只需要 top-k，不做完整 softmax（避免 3.2 万个 exp）。
  // beam 之间比较用 log-prob，所以这里取 log(exp(x)/Σexp(x)) = x - logsumexp(x)。
  let max = -Infinity;
  for (let i = 0; i < vocab; i++) if (logits[i] > max) max = logits[i];
  let sum = 0;
  for (let i = 0; i < vocab; i++) sum += Math.exp(logits[i] - max);
  const lse = max + Math.log(sum);
  const idx = [];
  // 部分选择：维护一个长度 k 的最小堆太重，vocab 才 3.2 万，直接线性扫两遍更省事
  const th = [];
  for (let i = 0; i < vocab; i++) {
    if (th.length < k) {
      th.push([logits[i], i]);
      if (th.length === k) th.sort((a, b) => a[0] - b[0]);
    } else if (logits[i] > th[0][0]) {
      th[0] = [logits[i], i];
      th.sort((a, b) => a[0] - b[0]);
    }
  }
  for (const [v, i] of th.sort((a, b) => b[0] - a[0])) idx.push([i, v - lse]);
  return idx;
}

/**
 * 中文 → 日语。beam search（默认 4），self-attention 带 KV cache。
 *
 * 为什么不用 greedy：实测「请问车站怎么走」greedy 会跑偏成「駅はどういったところ
 * でしょうか」，beam4 才给出「駅への行き方を教えてください」；而且 beam 倾向
 * ですます 体，greedy 常出 だ/なの 的口语体，旅游场景要前者。
 *
 * 每个 beam 各自持有一份 KV cache。候选继承父 beam 的 cache（只读共享，不拷贝），
 * 所以不需要按 beam 索引 gather —— 这是用「一 beam 一次 run」换来的简化，
 * batch=1 在 wasm 单线程下反正也吃不到批量并行的好处。
 */
export async function translate(text, opts = {}) {
  if (!state.ready) throw new Error('模型未加载');
  const beams = opts.beams || 4;
  const maxNew = opts.maxNewTokens || cfg.max_new_tokens;
  const t0 = performance.now();

  const ids = encode(text);
  const len = ids.length;
  const inputIds = new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, len]);
  const mask = new ort.Tensor('int64', BigInt64Array.from(new Array(len).fill(1), BigInt), [1, len]);
  const encOut = await enc.run({ input_ids: inputIds, attention_mask: mask });
  const h = encOut[enc.outputNames[0]];

  const L = cfg.layers, H = cfg.heads, D = cfg.head_dim;
  const emptyPast = [];
  for (let i = 0; i < 2 * L; i++) {
    emptyPast.push(new ort.Tensor('float32', new Float32Array(0), [1, H, 0, D]));
  }

  async function step(token, past) {
    const feed = {
      input_ids: new ort.Tensor('int64', BigInt64Array.from([BigInt(token)]), [1, 1]),
      encoder_hidden_states: h,
      encoder_attention_mask: mask,
    };
    for (let i = 0; i < L; i++) {
      feed[`past.${i}.key`] = past[2 * i];
      feed[`past.${i}.value`] = past[2 * i + 1];
    }
    const out = await dec.run(feed);
    const present = [];
    for (let i = 0; i < L; i++) {
      present.push(out[`present.${i}.key`], out[`present.${i}.value`]);
    }
    return { logits: out.logits, present };
  }

  let live = [{ seq: [cfg.decoder_start], score: 0, past: emptyPast }];
  const finished = [];
  for (let s = 0; s < maxNew; s++) {
    const cands = [];
    for (const b of live) {
      const { logits, present } = await step(b.seq[b.seq.length - 1], b.past);
      const V = cfg.vocab_size;
      const last = logits.data.subarray(logits.data.length - V);
      for (const [id, lp] of softmaxTop(last, V, beams)) {
        cands.push({ seq: b.seq.concat(id), score: b.score + lp, tok: id, past: present });
      }
    }
    cands.sort((a, b) => b.score - a.score);
    live = [];
    for (const c of cands) {
      if (live.length >= beams) break;
      if (c.tok === cfg.eos) {
        // 长度归一化：不除以长度，beam search 会系统性偏好短句
        finished.push({ seq: c.seq.slice(1, -1), score: c.score / (c.seq.length - 1) });
      } else {
        live.push(c);
      }
    }
    if (!live.length || finished.length >= beams) break;
  }
  if (!finished.length) {
    finished.push({ seq: live[0].seq.slice(1), score: live[0].score });
  }
  finished.sort((a, b) => b.score - a.score);
  const ms = Math.round(performance.now() - t0);
  return { text: decodePieces(finished[0].seq), ms, beams,
           alts: finished.slice(1, 3).map((f) => decodePieces(f.seq)) };
}
