/**
 * 音高检测 + 乐理换算。纯计算，不依赖 Web Audio，可在 node 里单测。
 *
 * 算法：MPM (McLeod Pitch Method) 的归一化平方差函数 NSDF + 抛物线插值。
 * 选它而不是裸自相关：NSDF 归一到 [-1,1]，配合「第一个达阈值的峰」策略
 * 能压住人声的八度错误（人声 2 次谐波常比基频还强）。
 */

/**
 * 从时域采样里估计基频。
 * @param {Float32Array} buf 单声道 [-1,1] 采样
 * @param {number} sampleRate
 * @param {{minHz?:number,maxHz?:number,threshold?:number,rmsGate?:number}} opt
 * @returns {{hz:number, clarity:number, rms:number}} hz<=0 表示未检出
 */
export function detectPitch(buf, sampleRate, opt = {}) {
  const minHz = opt.minHz ?? 65; // 人声最低约 E2=82Hz，留余量
  const maxHz = opt.maxHz ?? 1200; // 女高音哨音以下足够
  // MPM 推荐 0.8~0.9。取太低会选中 2 次谐波的峰 => 高八度错误
  const threshold = opt.threshold ?? 0.85;
  const rmsGate = opt.rmsGate ?? 0.008;

  const n = buf.length;
  let sumSq = 0;
  for (let i = 0; i < n; i++) sumSq += buf[i] * buf[i];
  const rms = Math.sqrt(sumSq / n);
  if (rms < rmsGate) return { hz: -1, clarity: 0, rms };

  // 大 lag 处参与相关的样本太少，NSDF 会变噪，所以封在 n/2
  const tauMax = Math.min(Math.floor(n / 2), Math.ceil(sampleRate / minHz));
  if (tauMax < 4) return { hz: -1, clarity: 0, rms };

  // NSDF: n'(tau) = 2*r(tau)/m(tau)，归一到 [-1,1]
  // 必须从 tau=0 开始算：MPM 靠「第一次负向过零」跳过 tau=0 的平凡主峰。
  // 直接从 tauMin 起步会把谐波峰当成第一个峰 => 低音区高八度错误。
  const nsdf = new Float32Array(tauMax + 1);
  for (let tau = 0; tau <= tauMax; tau++) {
    let acf = 0;
    let m = 0;
    const lim = n - tau;
    for (let i = 0; i < lim; i++) {
      const a = buf[i];
      const b = buf[i + tau];
      acf += a * b;
      m += a * a + b * b;
    }
    nsdf[tau] = m > 0 ? (2 * acf) / m : 0;
  }

  // 跳过 tau=0 的平凡主峰：走到第一次变负
  let start = 1;
  while (start <= tauMax && nsdf[start] > 0) start++;
  if (start > tauMax) return { hz: -1, clarity: 0, rms };

  // 收集每个正区间内的局部极大
  const peaks = [];
  let tau = start;
  while (tau <= tauMax) {
    if (nsdf[tau] > 0) {
      let best = tau;
      while (tau <= tauMax && nsdf[tau] > 0) {
        if (nsdf[tau] > nsdf[best]) best = tau;
        tau++;
      }
      peaks.push(best);
    } else {
      tau++;
    }
  }

  // 只保留落在目标频段内的峰
  const tauLo = sampleRate / maxHz;
  const inRange = peaks.filter((p) => p >= tauLo && p <= tauMax);
  if (!inRange.length) return { hz: -1, clarity: 0, rms };

  let globalMax = 0;
  for (const p of inRange) if (nsdf[p] > globalMax) globalMax = nsdf[p];
  if (globalMax <= 0) return { hz: -1, clarity: 0, rms };

  // 取第一个（=周期最短）达到阈值的峰。基频周期是各谐波周期的整数倍，
  // 谐波峰落在更短的 lag 上但幅值更低，靠阈值挡掉。
  const cut = threshold * globalMax;
  let chosen = inRange[0];
  for (const p of inRange) {
    if (nsdf[p] >= cut) {
      chosen = p;
      break;
    }
  }

  // 抛物线插值把整数 lag 精化到亚采样，否则高音区量化误差可达数十音分
  const y0 = chosen > 0 ? nsdf[chosen - 1] : nsdf[chosen];
  const y1 = nsdf[chosen];
  const y2 = chosen < tauMax ? nsdf[chosen + 1] : nsdf[chosen];
  const denom = 2 * (2 * y1 - y0 - y2);
  const shift = denom !== 0 ? (y2 - y0) / denom : 0;
  const tauRefined = chosen + (Math.abs(shift) < 1 ? shift : 0);

  const hz = sampleRate / tauRefined;
  if (hz < minHz || hz > maxHz) return { hz: -1, clarity: nsdf[chosen], rms };
  return { hz, clarity: nsdf[chosen], rms };
}

/**
 * 抽取降采样。NSDF 开销是 O(n × tauMax)，48kHz 下在手机上偏重；
 * 人声基频 < 1.2kHz，降到 ~16kHz 完全够用，开销降到约 1/9。
 * 先过 3 点 FIR 粗低通再抽点，抑制高次谐波折叠。
 */
export function decimate(buf, factor) {
  if (factor <= 1) return buf;
  const outLen = Math.floor(buf.length / factor);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const j = i * factor;
    const a = j > 0 ? buf[j - 1] : buf[j];
    const b = buf[j];
    const c = j + 1 < buf.length ? buf[j + 1] : buf[j];
    out[i] = 0.25 * a + 0.5 * b + 0.25 * c;
  }
  return out;
}

// ---------- 乐理换算 ----------

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** MIDI 音号 -> 频率（A4=440 = midi 69） */
export function midiToHz(midi, a4 = 440) {
  return a4 * Math.pow(2, (midi - 69) / 12);
}

/** 频率 -> 小数 MIDI 音号 */
export function hzToMidi(hz, a4 = 440) {
  return 69 + 12 * Math.log2(hz / a4);
}

/** 频率 -> {name:'A4', midi:69, cents:偏差音分} */
export function hzToNote(hz, a4 = 440) {
  const m = hzToMidi(hz, a4);
  const midi = Math.round(m);
  const cents = Math.round((m - midi) * 100);
  return { midi, cents, name: noteName(midi) };
}

export function noteName(midi) {
  return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

/** 解析 'A4' / 'C#3' / 'Bb2' -> midi */
export function parseNote(str) {
  const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(String(str).trim());
  if (!m) return NaN;
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1].toUpperCase()];
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return (parseInt(m[3], 10) + 1) * 12 + base + acc;
}

/**
 * 从一段音高轨迹算「音准得分」：相对最近半音的绝对音分偏差中位数。
 * 用中位数而非均值，避免起音/收音的滑音把整体拉垮。
 */
export function pitchAccuracy(track, minClarity = 0.85) {
  const errs = track
    .filter((p) => p.hz > 0 && p.clarity >= minClarity)
    .map((p) => {
      const m = hzToMidi(p.hz);
      return Math.abs(m - Math.round(m)) * 100;
    });
  if (!errs.length) return null;
  errs.sort((a, b) => a - b);
  const mid = Math.floor(errs.length / 2);
  const median = errs.length % 2 ? errs[mid] : (errs[mid - 1] + errs[mid]) / 2;
  return {
    medianCents: +median.toFixed(1),
    samples: errs.length,
    p90Cents: +errs[Math.floor(errs.length * 0.9)].toFixed(1),
  };
}

/** 从轨迹取音域上下界（去掉两端 5% 极端值，防毛刺） */
export function trackRange(track, minClarity = 0.85) {
  const ms = track.filter((p) => p.hz > 0 && p.clarity >= minClarity).map((p) => hzToMidi(p.hz));
  if (ms.length < 5) return null;
  ms.sort((a, b) => a - b);
  const lo = ms[Math.floor(ms.length * 0.05)];
  const hi = ms[Math.floor(ms.length * 0.95)];
  return {
    lowMidi: Math.round(lo),
    highMidi: Math.round(hi),
    semitones: Math.round(hi - lo),
    low: noteName(Math.round(lo)),
    high: noteName(Math.round(hi)),
  };
}

// ==========================================================================
// 复音音乐的主旋律提取
//
// 上面的 NSDF（时域自相关）只适合单音信号。真实音乐里有鼓、贝斯、和弦，
// 时域自相关会锁到贝斯或鼓的周期上，结果一片噪声 —— 这就是为什么
// 「加载真实音乐」不能直接复用唱歌用的那套检测。
//
// 这里换成频域的谐波累加显著度（harmonic summation salience，Melodia 一类做法）：
// 对每个候选基频 f，把 f、2f、3f… 各次谐波处的能量加权求和；
// 人声的谐波列完整且强，所以在正确的 f0 上显著度会明显高于伴奏成分。
// 再配合三条针对伴奏的处理：
//   1. 高通去掉贝斯与底鼓（< 130Hz），它们是最强的干扰源
//   2. 限定人声音域（130-1000Hz）
//   3. 帧间用维特比式路径连续性约束，抑制八度跳变和瞬时误判
// ==========================================================================

/** 原地 FFT（迭代 Cooley-Tukey）。re/im 长度必须是 2 的幂。 */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/**
 * 单帧的谐波显著度曲线。
 * @returns {{cands:{hz:number,sal:number}[], total:number}} 按显著度降序的候选
 */
export function salienceFrame(buf, sampleRate, opt = {}) {
  const minHz = opt.minHz ?? 130;      // 高于贝斯与底鼓
  const maxHz = opt.maxHz ?? 1000;
  const nHarm = opt.harmonics ?? 8;
  const nCand = opt.candidates ?? 6;

  // 补零到 2 的幂并加 Hann 窗
  let n = 1;
  while (n < buf.length) n <<= 1;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < buf.length; i++) {
    re[i] = buf[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (buf.length - 1)));
  }
  fft(re, im);
  const half = n >> 1;
  const mag = new Float64Array(half);
  let total = 0;
  for (let k = 0; k < half; k++) {
    mag[k] = Math.hypot(re[k], im[k]);
    total += mag[k];
  }
  if (total <= 0) return { cands: [], total: 0 };

  // 频谱白化：把幅度谱除以它自己的平滑包络。
  // 不做这步的话，响的贝斯/和弦低频会在显著度上压过安静的人声，
  // 实测「伴奏加大」的用例就会锁到和弦根音上。白化后各频段被拉到可比的量级，
  // 谐波结构（人声的特征）而不是绝对能量决定胜负。
  // 这是 Melodia / YIN-FFT 一类算法里的标准前处理。
  if (opt.whiten !== false) {
    const w = Math.max(4, Math.round((opt.whitenBins ?? 40)));
    const env = new Float64Array(half);
    let acc = 0;
    for (let k = 0; k < half; k++) {
      acc += mag[k];
      if (k >= w) acc -= mag[k - w];
      env[k] = acc / Math.min(k + 1, w);
    }
    const floor = total / half * 0.05;
    for (let k = 0; k < half; k++) mag[k] = mag[k] / Math.max(env[k], floor);
  }

  const binHz = sampleRate / n;
  // 每 1/4 半音扫一次候选，够细且不至于太慢
  const step = Math.pow(2, 1 / 48);
  const out = [];
  for (let f = minHz; f <= maxHz; f *= step) {
    let sal = 0;
    for (let h = 1; h <= nHarm; h++) {
      const fh = f * h;
      if (fh > sampleRate / 2) break;
      const b = fh / binHz;
      const b0 = Math.floor(b);
      if (b0 + 1 >= half) break;
      // 在谐波位置的邻域里取最大，而不是精确插值。
      // 真实歌声都有颤音（几个音分到半音的周期性起伏），加上录音的音高漂移，
      // 谐波能量会落到相邻频点上；只看精确 bin 会把它当成"这里没有谐波"，
      // 显著度直接崩掉 —— 实测给测试信号加 0.6% 颤音后检出率从 69% 掉到 0。
      // 邻域宽度按「相对频率」算而不是固定频点数：高频区频点密度高，
      // 固定宽度会让高频候选覆盖更大的频率范围、显著度被系统性高估，
      // 结果锁到高八度或不存在的高音上（实测锁到 F5）。
      // 取 ±1.2% 频率（约 ±0.2 个半音），刚好覆盖颤音和录音漂移。
      const span = Math.max(1, Math.round((fh * 0.012) / binHz));
      let v = 0;
      for (let d = -span; d <= span; d++) {
        const kk = b0 + d;
        if (kk >= 0 && kk < half && mag[kk] > v) v = mag[kk];
      }
      sal += v / Math.pow(h, 0.85);
    }
    out.push({ hz: f, sal });
  }
  // 局部极大 + 取前 nCand
  const peaks = [];
  for (let i = 1; i < out.length - 1; i++) {
    if (out[i].sal > out[i - 1].sal && out[i].sal >= out[i + 1].sal) peaks.push(out[i]);
  }
  peaks.sort((a, b) => b.sal - a.sal);
  // 白化改变了量级，voiced 判定要用白化后的总能量做基准
  let tot2 = 0;
  for (let k = 0; k < half; k++) tot2 += mag[k];
  return { cands: peaks.slice(0, nCand), total: tot2 || total };
}

/**
 * 从整段复音音频提取主旋律。
 *
 * 帧间用动态规划挑一条「显著度高且音高连续」的路径：
 * 只看单帧最大值会频繁跳八度（谐波和基频显著度接近时），
 * 加上连续性代价后旋律线会稳很多。
 *
 * @param {Float32Array} sig 单声道采样（建议已降采样到 ~16kHz）
 * @param {number} rate
 * @returns {{t:number,hz:number,midi:number|null,sal:number}[]}
 */
export function extractMelody(sig, rate, opt = {}) {
  const win = opt.win ?? 2048;
  const hop = opt.hop ?? Math.round(rate * 0.02);
  const jumpPenalty = opt.jumpPenalty ?? 0.55;   // 每半音跳变的代价
  // 有人声/没人声的判据。
  //
  // 原来用固定阈值（显著度占全帧能量的 6%），但这个比值的量级取决于谱里有多少
  // 频点、人声占多大比例，实测在不同素材上差了 28 倍：强人声的合成信号中位数 0.12，
  // 稍弱一点、带颤音的只有 0.004 —— 固定 6% 会把后者整段判成"没有人声"，
  // 表现就是"这首歌根本解析不了"。
  // 改成自适应：以本段显著度分布的分位数为主，再加一条相对于本段峰值的下限，
  // 免得纯伴奏段落里也挑出一堆"旋律"。
  const voicedRatio = opt.voicedRatio ?? 'auto';

  const frames = [];
  for (let i = 0; i + win <= sig.length; i += hop) {
    const f = salienceFrame(sig.subarray(i, i + win), rate, opt);
    frames.push({ t: i / rate, cands: f.cands, total: f.total });
  }
  if (!frames.length) return [];

  // 动态规划：state = 该帧的某个候选
  const NEG = -1e18;
  let prevScore = frames[0].cands.map((c) => c.sal / (frames[0].total || 1));
  const back = [];
  for (let i = 1; i < frames.length; i++) {
    const cur = frames[i].cands;
    const score = new Array(cur.length).fill(NEG);
    const bp = new Array(cur.length).fill(-1);
    for (let j = 0; j < cur.length; j++) {
      const base = cur[j].sal / (frames[i].total || 1);
      for (let k = 0; k < prevScore.length; k++) {
        if (prevScore[k] === NEG) continue;
        const semi = Math.abs(12 * Math.log2(cur[j].hz / frames[i - 1].cands[k].hz));
        const v = prevScore[k] + base - jumpPenalty * Math.min(semi, 24) / 12;
        if (v > score[j]) { score[j] = v; bp[j] = k; }
      }
      if (score[j] === NEG) { score[j] = base; bp[j] = -1; }
    }
    back.push(bp);
    prevScore = score;
  }
  // 回溯
  let best = 0;
  for (let j = 1; j < prevScore.length; j++) if (prevScore[j] > prevScore[best]) best = j;
  const path = new Array(frames.length).fill(-1);
  path[frames.length - 1] = best;
  for (let i = frames.length - 1; i > 0; i--) {
    const bp = back[i - 1];
    path[i - 1] = path[i] >= 0 && bp ? bp[path[i]] : -1;
  }

  // 先把选中路径上的相对显著度算出来，再定门限
  const picked = frames.map((f, i) => {
    const idx = path[i];
    const c = idx >= 0 ? f.cands[idx] : null;
    return { f, c, rel: c && f.total > 0 ? c.sal / f.total : 0 };
  });
  let cut = voicedRatio;
  if (voicedRatio === 'auto') {
    const sorted = picked.map((p) => p.rel).filter((v) => v > 0).sort((a, b) => a - b);
    if (!sorted.length) return picked.map((p) => ({ t: p.f.t, hz: -1, midi: null, sal: 0 }));
    const p55 = sorted[Math.floor(sorted.length * 0.55)];
    const peak = sorted[sorted.length - 1];
    cut = Math.max(p55, peak * 0.35);
  }
  return picked.map(({ f, c, rel }) => {
    const voiced = c && rel >= cut;
    return {
      t: f.t,
      hz: voiced ? c.hz : -1,
      midi: voiced ? hzToMidi(c.hz) : null,
      sal: rel,
    };
  });
}
