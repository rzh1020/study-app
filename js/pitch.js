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
