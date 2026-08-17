/**
 * Web Audio 层：出题用的合成音 + 麦克风实时音高。
 *
 * 手机上的两个坑：
 * 1. AudioContext 必须由用户手势触发才能 resume，否则静默不出声。
 * 2. ScriptProcessorNode 已废弃且在主线程跑；这里用 AnalyserNode 取时域数据
 *    配合 requestAnimationFrame 拉取，避免 AudioWorklet 的额外文件与跨域限制，
 *    对 20-30Hz 的分析率完全够用（音高检测不需要每帧都算）。
 */
import { detectPitch, decimate, midiToHz, hzToNote } from './pitch.js';

let ctx = null;

export function audioCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

/**
 * 弹一个音。带轻微谐波让音色不那么刺，ADSR 包络避免爆音（方波般的 click）。
 * @returns {Promise<void>} 播完后 resolve
 */
export function playNote(midi, durationSec = 0.7, opt = {}) {
  const c = audioCtx();
  const t0 = c.currentTime + (opt.delay || 0);
  const hz = midiToHz(midi, opt.a4 || 440);
  const gain = c.createGain();
  const peak = opt.gain ?? 0.22;
  // 短促的 attack/release，防止直接切断产生咔哒声
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.02);
  gain.gain.setValueAtTime(peak, t0 + durationSec - 0.08);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durationSec);
  gain.connect(c.destination);

  // 基频 + 二次谐波（弱），近似钢琴/风琴的听感
  const oscs = [];
  [[1, 1], [2, 0.25], [3, 0.08]].forEach(([mult, amp]) => {
    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.value = hz * mult;
    const g = c.createGain();
    g.gain.value = amp;
    o.connect(g).connect(gain);
    o.start(t0);
    o.stop(t0 + durationSec + 0.02);
    oscs.push(o);
  });
  return new Promise((res) => setTimeout(res, ((opt.delay || 0) + durationSec) * 1000 + 20));
}

/** 依次弹一串音（旋律） */
export async function playSequence(midis, noteSec = 0.55, gapSec = 0.05, opt = {}) {
  for (const m of midis) {
    await playNote(m, noteSec, opt);
    if (gapSec) await sleep(gapSec * 1000);
  }
}

/** 同时弹一组音（和弦） */
export function playChord(midis, durationSec = 1.2, opt = {}) {
  midis.forEach((m) => playNote(m, durationSec, { ...opt, gain: (opt.gain ?? 0.22) / Math.sqrt(midis.length) }));
  return sleep(durationSec * 1000);
}

/** 节拍器咔嗒声（用短噪声脉冲，比正弦更像打击乐） */
export function click(accent = false) {
  const c = audioCtx();
  const t0 = c.currentTime;
  const len = Math.floor(c.sampleRate * 0.03);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  }
  const src = c.createBufferSource();
  src.buffer = buf;
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = accent ? 2400 : 1400;
  bp.Q.value = 2;
  const g = c.createGain();
  g.gain.value = accent ? 0.5 : 0.3;
  src.connect(bp).connect(g).connect(c.destination);
  src.start(t0);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 麦克风 ----------

export class Mic {
  constructor() {
    this.stream = null;
    this.analyser = null;
    this.buf = null;
    this.recorder = null;
    this.chunks = [];
    this._raf = 0;
    this._onFrame = null;
  }

  get active() { return !!this.stream; }

  async start() {
    if (this.stream) return;
    // 关掉浏览器的语音增强：这些处理会改变音高稳定性和动态，
    // 用于音准检测时必须关，否则测出来的抖动是算法的而不是你的。
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    const c = audioCtx();
    const src = c.createMediaStreamSource(this.stream);
    const an = c.createAnalyser();
    an.fftSize = 2048;
    an.smoothingTimeConstant = 0;
    src.connect(an);
    this.analyser = an;
    this.buf = new Float32Array(an.fftSize);
    this.sampleRate = c.sampleRate;
    // 48kHz 降到 ~16kHz 再算 NSDF，开销降到约 1/9，精度够（人声 <1.2kHz）
    this.decFactor = this.sampleRate >= 32000 ? 3 : 1;
  }

  stop() {
    this.stopLoop();
    this.stopRecording();
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    this.analyser = null;
  }

  /** 取当前一帧的音高 */
  readPitch(opt = {}) {
    if (!this.analyser) return { hz: -1, clarity: 0, rms: 0 };
    this.analyser.getFloatTimeDomainData(this.buf);
    const b = this.decFactor > 1 ? decimate(this.buf, this.decFactor) : this.buf;
    const sr = this.sampleRate / this.decFactor;
    const r = detectPitch(b, sr, opt);
    if (r.hz > 0) {
      const n = hzToNote(r.hz, opt.a4 || 440);
      return { ...r, ...n };
    }
    return r;
  }

  /**
   * 启动分析循环。为了省电按 ~25Hz 节流，而不是跟满 60fps 的 rAF。
   * @param {(p:{hz:number,clarity:number,rms:number,name?:string,cents?:number})=>void} cb
   */
  startLoop(cb, opt = {}) {
    this._onFrame = cb;
    const interval = opt.intervalMs ?? 40;
    let last = 0;
    const tick = (t) => {
      if (!this._onFrame) return;
      this._raf = requestAnimationFrame(tick);
      if (t - last < interval) return;
      last = t;
      cb(this.readPitch(opt));
    };
    this._raf = requestAnimationFrame(tick);
  }

  stopLoop() {
    this._onFrame = null;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  startRecording() {
    if (!this.stream || this.recorder) return false;
    const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', ''];
    const mime = types.find((t) => t === '' || (window.MediaRecorder && MediaRecorder.isTypeSupported(t)));
    this.chunks = [];
    try {
      this.recorder = mime ? new MediaRecorder(this.stream, { mimeType: mime }) : new MediaRecorder(this.stream);
    } catch {
      this.recorder = new MediaRecorder(this.stream);
    }
    this.recorder.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.recorder.start();
    return true;
  }

  /** @returns {Promise<Blob|null>} */
  stopRecording() {
    const rec = this.recorder;
    if (!rec) return Promise.resolve(null);
    this.recorder = null;
    if (rec.state === 'inactive') return Promise.resolve(null);
    return new Promise((res) => {
      rec.onstop = () => res(new Blob(this.chunks, { type: rec.mimeType || 'audio/webm' }));
      rec.stop();
    });
  }
}

export const mic = new Mic();
