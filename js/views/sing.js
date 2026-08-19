import { $, esc, toast, fmtDur } from '../ui.js';
import { setTitle } from '../app.js';
import { mic, audioCtx, playNote, playSequence, sleep } from '../audio.js';
import { noteName, hzToMidi, decimate, extractMelody } from '../pitch.js';
import { db } from '../db.js';
import { getConfig } from '../store.js';
import { keepAwake, onNativePause } from '../native.js';

/**
 * 带唱 + 本地音乐分析。
 *
 * 为什么需要这两个：只显示一个「偏差 xx 音分」的数字，人不知道该往哪调；
 * 看到「目标线在这、我的线在那」才有可操作的反馈 —— 这也是卡拉OK
 * 和所有成熟音准训练软件的做法。
 *
 * 本地音乐分析：解析手机里的音频文件，画出它的音高轨迹，
 * 于是任何一首歌都能变成带唱素材（而不是只能用内置的几条音阶）。
 * 用 Web Audio 的 decodeAudioData，不需要任何额外依赖。
 */

// 内置练习旋律。[midi, 拍数]，null = 休止
const BUILTIN = [
  { id: 'scale5', name: '五度音阶 上下行', bpm: 84,
    notes: [[60, 1], [62, 1], [64, 1], [65, 1], [67, 1], [65, 1], [64, 1], [62, 1], [60, 2]],
    tip: '一口气走完九个音。这是最基础的音准+气息练习。' },
  { id: 'triad', name: '大三和弦 do mi sol', bpm: 76,
    notes: [[60, 1], [64, 1], [67, 1], [72, 1], [67, 1], [64, 1], [60, 2]],
    tip: '和弦骨架音。唱准这三个音，调性感就立起来了。' },
  { id: 'octave', name: '八度滑音', bpm: 60,
    notes: [[60, 2], [72, 2], [60, 2]],
    tip: '专门练换声点过渡。破音处放慢、减小音量再过。' },
  { id: 'joy', name: '欢乐颂 前两句', bpm: 92,
    notes: [[64, 1], [64, 1], [65, 1], [67, 1], [67, 1], [65, 1], [64, 1], [62, 1],
            [60, 1], [60, 1], [62, 1], [64, 1], [64, 1.5], [62, 0.5], [62, 2]],
    tip: '大家都会的旋律，容易判断自己唱得对不对。' },
];

export async function render(view, { args }) {
  const cfg = await getConfig();
  return args[0] === 'file' ? fileMode(view, cfg) : singMode(view, cfg);
}

// ============================ 带唱 ============================

async function singMode(view, cfg) {
  setTitle('带唱', '<a class="pill" href="#/sing/file">用我的歌</a>');
  const a4 = cfg.a4;
  let song = BUILTIN[0];
  let transpose = 0;
  let running = false;
  let raf = 0;
  let startT = 0;
  const sung = [];              // {t, midi}
  let custom = null;            // 从本地文件分析出的旋律

  const savedCustom = await db.get('meta', 'singCustom').catch(() => null);
  if (savedCustom && savedCustom.v) custom = savedCustom.v;

  view.innerHTML = `
    <div class="card">
      <label class="field" style="margin-bottom:10px"><span>练什么</span>
        <select id="songSel"></select></label>
      <div class="row wrap" style="gap:8px">
        <label class="field grow" style="margin:0"><span>移调（唱不上去就往下调）</span>
          <select id="trSel">${[-7, -5, -3, -2, -1, 0, 1, 2, 3, 5].map((t) =>
            `<option value="${t}" ${t === 0 ? 'selected' : ''}>${t > 0 ? '+' : ''}${t} 半音</option>`).join('')}</select></label>
      </div>
      <div class="tiny dim mt" id="songTip"></div>
      <div class="btn-row mt">
        <button class="btn" id="btnListen">🎵 先听一遍</button>
        <button class="btn btn-pri" id="btnSing">开始带唱</button>
      </div>
    </div>

    <div class="card">
      <canvas class="track" id="roll" style="height:210px"></canvas>
      <div class="row spread" style="margin-top:8px">
        <span class="tiny dim">灰块＝目标音，蓝线＝你唱的</span>
        <span class="tiny" id="liveNote" style="font-variant-numeric:tabular-nums"></span>
      </div>
    </div>

    <div class="card" id="scoreBox" style="display:none"></div>

    <div class="card tight">
      <div class="tiny dim">看着灰块唱。线在块中间就是准的，偏上是唱高了、偏下是唱低了。
      唱不上去就往下移调 —— 音域不够时硬顶只会练坏。</div>
    </div>
  `;

  function songList() {
    const opts = BUILTIN.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`);
    if (custom) opts.push(`<option value="__custom">我的歌：${esc(custom.name)}</option>`);
    $('#songSel').innerHTML = opts.join('');
    $('#songSel').value = song.id;
  }
  function pickSong(v) {
    song = v === '__custom' ? custom : (BUILTIN.find((s) => s.id === v) || BUILTIN[0]);
    $('#songTip').textContent = song.tip || `${song.notes.length} 个音`;
    sung.length = 0;
    draw();
  }

  // ---- 时间轴：把 [midi, beats] 展开成带起止秒数的事件 ----
  function timeline() {
    const spb = 60 / (song.bpm || 80);
    let t = 0;
    return song.notes.map(([m, b]) => {
      const ev = { midi: m === null ? null : m + transpose, t0: t, t1: t + b * spb };
      t = ev.t1;
      return ev;
    });
  }
  const totalSec = () => timeline().slice(-1)[0].t1;

  // ---- 绘制钢琴卷帘 ----
  function draw(cursor = -1) {
    const c = $('#roll');
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr; c.height = h * dpr;
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);

    const tl = timeline();
    const dur = tl.slice(-1)[0].t1 || 1;
    const ms = tl.filter((e) => e.midi !== null).map((e) => e.midi);
    let lo = Math.min(...ms) - 3, hi = Math.max(...ms) + 3;
    if (hi - lo < 14) { const mid = (hi + lo) / 2; lo = mid - 7; hi = mid + 7; }
    const X = (t) => (t / dur) * w;
    const Y = (m) => h - ((m - lo) / (hi - lo)) * h;
    const rowH = h / (hi - lo);

    // 半音格线，整 C 加亮
    for (let m = Math.ceil(lo); m <= hi; m++) {
      const isC = ((m % 12) + 12) % 12 === 0;
      g.strokeStyle = isC ? '#3a4152' : '#232733';
      g.beginPath(); g.moveTo(0, Y(m)); g.lineTo(w, Y(m)); g.stroke();
      if (isC) {
        g.fillStyle = '#6b7285'; g.font = '9px sans-serif'; g.textAlign = 'left';
        g.fillText(noteName(m), 2, Y(m) - 2);
      }
    }
    // 目标音块
    for (const e of tl) {
      if (e.midi === null) continue;
      g.fillStyle = '#3a4152';
      g.fillRect(X(e.t0) + 1, Y(e.midi) - rowH / 2, Math.max(3, X(e.t1) - X(e.t0) - 2), rowH);
    }
    // 唱的轨迹
    if (sung.length > 1) {
      g.strokeStyle = '#5b8cff'; g.lineWidth = 2.4; g.lineJoin = 'round';
      g.beginPath();
      let started = false;
      for (const p of sung) {
        if (p.midi === null) { started = false; continue; }
        const x = X(p.t), y = Y(p.midi);
        if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
      }
      g.stroke();
    }
    // 播放头
    if (cursor >= 0) {
      g.strokeStyle = '#3ecf8e'; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(X(cursor), 0); g.lineTo(X(cursor), h); g.stroke();
    }
  }

  // ---- 先听一遍 ----
  $('#btnListen').onclick = async () => {
    const btn = $('#btnListen');
    btn.disabled = true;
    try {
      audioCtx();
      const tl = timeline();
      for (const e of tl) {
        if (e.midi === null) { await sleep((e.t1 - e.t0) * 1000); continue; }
        await playNote(e.midi, (e.t1 - e.t0) * 0.92, { a4 });
        draw(e.t1);
      }
    } finally { btn.disabled = false; draw(); }
  };

  // ---- 带唱 ----
  async function startSing() {
    try { audioCtx(); await mic.start(); } catch (err) {
      toast('麦克风打开失败：' + (err.name === 'NotAllowedError' ? '权限被拒绝' : err.message), 4000);
      return;
    }
    sung.length = 0;
    running = true;
    keepAwake(true);
    $('#btnSing').textContent = '停止';
    $('#scoreBox').style.display = 'none';

    const tl = timeline();
    const dur = tl.slice(-1)[0].t1;
    startT = performance.now();
    // 边放参考音边采集。参考音音量压低，避免被麦克风拾进去干扰检测。
    (async () => {
      for (const e of tl) {
        if (!running) break;
        if (e.midi !== null) playNote(e.midi, (e.t1 - e.t0) * 0.9, { a4, gain: 0.08 });
        await sleep((e.t1 - e.t0) * 1000);
      }
    })();

    const loop = () => {
      if (!running) return;
      const t = (performance.now() - startT) / 1000;
      const p = mic.readPitch({ a4 });
      sung.push({ t, midi: p.hz > 0 && p.clarity > 0.82 ? hzToMidi(p.hz, a4) : null });
      $('#liveNote').textContent = p.hz > 0 ? `${p.name} ${p.cents > 0 ? '+' : ''}${p.cents}` : '—';
      draw(t);
      if (t >= dur + 0.3) { stopSing(); return; }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
  }

  function stopSing() {
    running = false;
    cancelAnimationFrame(raf);
    keepAwake(false);
    mic.stop();
    $('#btnSing').textContent = '开始带唱';
    draw();
    score();
  }

  /**
   * 打分。对每个目标音，取其时间窗内（去掉起音的前 25%，那段通常在滑音）
   * 唱到的音高中位数，与目标比较。
   */
  async function score() {
    const tl = timeline().filter((e) => e.midi !== null);
    const rows = [];
    for (const e of tl) {
      const w0 = e.t0 + (e.t1 - e.t0) * 0.25;
      const vals = sung.filter((p) => p.midi !== null && p.t >= w0 && p.t <= e.t1).map((p) => p.midi);
      if (vals.length < 2) { rows.push({ e, cents: null }); continue; }
      vals.sort((a, b) => a - b);
      const med = vals[Math.floor(vals.length / 2)];
      rows.push({ e, cents: Math.round((med - e.midi) * 100), sungMidi: med });
    }
    const hit = rows.filter((r) => r.cents !== null);
    if (!hit.length) {
      $('#scoreBox').style.display = '';
      $('#scoreBox').innerHTML = `<div class="small" style="color:var(--warn)">
        没采到有效音高。可能是没出声、离手机太远，或环境太吵。<br>
        建议：手机放在离嘴 20cm 左右，用「啊」或哼鸣唱，音量比说话稍大。</div>`;
      return;
    }
    const abs = hit.map((r) => Math.abs(r.cents)).sort((a, b) => a - b);
    const med = abs[Math.floor(abs.length / 2)];
    const good = hit.filter((r) => Math.abs(r.cents) <= 25).length;
    const verdict = med <= 20 ? ['ok', '准'] : med <= 40 ? ['warn', '偏了，但听众多半听不出'] : ['bad', '明显跑调'];
    $('#scoreBox').style.display = '';
    $('#scoreBox').innerHTML = `
      <div class="stat-grid mb">
        <div class="stat"><b>${med}</b><span>中位偏差(音分)</span></div>
        <div class="stat"><b>${good}/${hit.length}</b><span>唱准的音</span></div>
        <div class="stat"><b>${hit.length}/${tl.length}</b><span>采到的音</span></div>
      </div>
      <span class="pill ${verdict[0]}">${verdict[1]}</span>
      <div class="sing-notes mt">
        ${rows.map((r) => {
          if (r.cents === null) return `<span class="sing-n miss">${noteName(r.e.midi)}<i>—</i></span>`;
          const cls = Math.abs(r.cents) <= 25 ? 'ok' : Math.abs(r.cents) <= 50 ? 'warn' : 'bad';
          return `<span class="sing-n ${cls}">${noteName(r.e.midi)}<i>${r.cents > 0 ? '+' : ''}${r.cents}</i></span>`;
        }).join('')}
      </div>
      <div class="tiny dim mt">偏差为正＝唱高了，为负＝唱低了。「—」是这个音没采到（没唱或太轻）。</div>`;
    await db.add('voice', {
      ts: Date.now(), kind: 'sing', durationSec: Math.round(totalSec()),
      metrics: { song: song.name, transpose, medianCents: med, hit: hit.length, total: tl.length },
    });
  }

  $('#songSel').onchange = (e) => pickSong(e.target.value);
  $('#trSel').onchange = (e) => { transpose = +e.target.value; sung.length = 0; draw(); };
  $('#btnSing').onclick = () => (running ? stopSing() : startSing());

  songList();
  pickSong(song.id);
  const offPause = onNativePause(() => { if (running) stopSing(); });
  return {
    resize() { draw(); },
    destroy() { running = false; cancelAnimationFrame(raf); keepAwake(false); offPause(); mic.stop(); },
  };
}

// ==================== 本地音乐加载分析 ====================

function fileMode(view, cfg) {
  setTitle('用我的歌', '<a class="pill" href="#/sing">带唱</a>');
  const a4 = cfg.a4;
  let analyzed = null;

  view.innerHTML = `
    <div class="card">
      <h3>从手机里的音频提取旋律</h3>
      <div class="small muted mb">选一段音频（mp3 / m4a / wav / flac 都行），
      <b>带伴奏的正常歌曲可以直接用</b>。提取用的是频域谐波显著度 + 频谱白化，
      能在鼓和贝斯里把人声主旋律拉出来。建议一次取 10-30 秒（一句或一段），
      整首分析会慢且旋律会被切成太多碎片。</div>
      <input type="file" id="f" accept="audio/*">
      <div class="row wrap mt" style="gap:8px">
        <label class="field grow" style="margin:0"><span>从第几秒开始</span>
          <input type="number" id="off" value="0" min="0" step="1"></label>
        <label class="field grow" style="margin:0"><span>分析时长(秒，最多 40)</span>
          <input type="number" id="len" value="20" min="3" max="40" step="1"></label>
      </div>
      <button class="btn btn-pri btn-block mt" id="btnGo" disabled>分析</button>
      <div class="tiny dim mt" id="st"></div>
    </div>

    <div class="card" id="resBox" style="display:none">
      <canvas class="track" id="mel" style="height:190px"></canvas>
      <div id="melInfo" class="mt"></div>
      <div class="btn-row mt">
        <button class="btn btn-pri" id="btnUse">用它做带唱素材</button>
      </div>
    </div>

    <div class="card tight">
      <div class="tiny dim">全部在本机解析，音频不会离开手机（App 也没有联网权限）。
      提取用的是同一套音高检测算法，所以「它测你」和「它测原唱」用的是同一把尺子。</div>
    </div>
  `;

  let file = null;
  let userSetOff = false;
  $('#off').oninput = () => { userSetOff = $('#off').value !== '' && +$('#off').value > 0; };
  $('#f').onchange = (e) => {
    file = e.target.files[0] || null;
    $('#btnGo').disabled = !file;
    $('#st').textContent = file ? `${file.name} · ${(file.size / 1e6).toFixed(1)} MB` : '';
  };

  $('#btnGo').onclick = async () => {
    if (!file) return;
    const btn = $('#btnGo');
    btn.disabled = true;
    $('#st').textContent = '解码中…';
    try {
      const ctx = audioCtx();
      const buf = await ctx.decodeAudioData(await file.arrayBuffer());
      let off = Math.max(0, +$('#off').value || 0);
      const len = Math.min(40, Math.max(3, +$('#len').value || 20));
      // 起始时间留空/为 0 时先扫全曲找人声：流行歌前十几秒基本是前奏，
      // 从第 0 秒硬分析必然「没有稳定音高」—— 那不是算法失灵，是那段真没人声。
      let scan = null;
      if (!userSetOff) {
        $('#st').textContent = `解码完成 ${buf.duration.toFixed(1)}s，正在扫描人声段…`;
        await sleep(20);
        scan = await scanVocal(buf, len);
        if (scan.best) {
          off = scan.best.t;
          $('#off').value = Math.round(off);
        }
      }
      $('#st').textContent = `分析 ${fmtTime(off)} 起的 ${len} 秒…`;
      await sleep(30);
      analyzed = analyze(buf, off, len, a4);
      if (!analyzed.track.filter((x) => x.midi !== null).length) {
        const detail = scan
          ? `全曲扫了 ${scan.segs.length} 段，人声比例最高的一段是 ${fmtTime(scan.best ? scan.best.t : 0)}`
            + `（${Math.round((scan.best ? scan.best.ratio : 0) * 100)}%）`
          : '试试把「从第几秒开始」清空，让它自动找人声段';
        $('#st').innerHTML = `<span style="color:var(--warn)">这段里没提取到稳定音高。${esc(detail)}。`
          + '纯乐器、重混音或人声被压得很低的段落提不出旋律，换副歌试试。</span>';
        return;
      }
      $('#st').textContent = '完成';
      $('#resBox').style.display = '';
      drawMel();
    } catch (err) {
      $('#st').innerHTML = `<span style="color:var(--bad)">解码失败：${esc(err.message)}</span>`;
    } finally { btn.disabled = false; }
  };

  /**
   * 从解码后的音频提取音高轨迹并量化成音符。
   * 关键处理：
   *  - 转单声道并降采样到 ~16kHz（人声基频 <1.2kHz，省 9 倍算力）
   *  - 只保留 clarity 高的帧，再用中值滤波去掉八度跳变的毛刺
   *  - 相邻帧音高接近就并成一个音符，过短的音符丢弃（多是辅音/噪声）
   */
  const fmtTime = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

  /**
   * 扫全曲找人声最明显的一段。
   *
   * 为什么必要：默认从第 0 秒分析，而流行歌的前十几秒几乎都是前奏 ——
   * 那里确实没有人声，于是界面报「没有稳定音高」，看起来像功能坏了。
   * 这里用粗粒度（大 hop）扫一遍，按「检出到音高的帧占比」给每段打分，
   * 直接把分析窗口挪到人声最集中的地方。
   * 只扫前 4 分钟：再长的歌副歌一定已经出现过了，没必要为此多等。
   */
  async function scanVocal(buf, lenSec) {
    const sr = buf.sampleRate;
    const ch0 = buf.getChannelData(0);
    const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
    const limit = Math.min(ch0.length, Math.floor(240 * sr));
    const dec = sr >= 32000 ? Math.round(sr / 16000) : 1;
    const rate = sr / dec;
    const step = 4;                       // 每 4 秒一段
    const segs = [];
    for (let t = 0; t + step * sr <= limit; t += step * sr) {
      const n = Math.floor(step * sr);
      const mono = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        mono[i] = ch1 ? (ch0[t + i] + ch1[t + i]) / 2 : ch0[t + i];
      }
      const sig = dec > 1 ? decimate(mono, dec) : mono;
      const r = extractMelody(sig, rate, {
        win: 2048, hop: Math.round(rate * 0.06), minHz: 130, maxHz: 1000,
      });
      const voiced = r.filter((x) => x.midi !== null).length;
      segs.push({ t: t / sr, ratio: r.length ? voiced / r.length : 0 });
      if (segs.length % 8 === 0) {
        $('#st').textContent = `扫描人声段… ${fmtTime(t / sr)}`;
        await sleep(0);                   // 让出主线程，否则界面会卡住
      }
    }
    // 连续若干段一起看：分析窗口有 len 秒，要的是「持续有人声」而不是单点
    const span = Math.max(1, Math.round(lenSec / step));
    let best = null;
    for (let i = 0; i + span <= segs.length; i++) {
      const avg = segs.slice(i, i + span).reduce((a, x) => a + x.ratio, 0) / span;
      if (!best || avg > best.ratio) best = { t: segs[i].t, ratio: avg };
    }
    return { segs, best };
  }

  function analyze(buf, offSec, lenSec, a4v) {
    const sr = buf.sampleRate;
    const ch0 = buf.getChannelData(0);
    const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
    const start = Math.min(ch0.length - 1, Math.floor(offSec * sr));
    const end = Math.min(ch0.length, start + Math.floor(lenSec * sr));
    const mono = new Float32Array(end - start);
    for (let i = 0; i < mono.length; i++) {
      mono[i] = ch1 ? (ch0[start + i] + ch1[start + i]) / 2 : ch0[start + i];
    }
    // 降到 ~16kHz：人声基频 < 1kHz，FFT 规模减小直接决定能不能在手机上跑得动
    const dec = sr >= 32000 ? Math.round(sr / 16000) : 1;
    const sig = dec > 1 ? decimate(mono, dec) : mono;
    const rate = sr / dec;

    // 复音旋律提取（频域谐波显著度 + 频谱白化 + 帧间连续性）。
    // 不能用时域自相关：真实音乐里它会锁到贝斯或鼓上，实测直接检不出。
    const raw = extractMelody(sig, rate, {
      win: 2048,
      hop: Math.round(rate * 0.02),
      minHz: 130, maxHz: 1000,
    });
    const track = raw.map((p) => ({ t: p.t, midi: p.midi, sal: p.sal }));

    // 中值滤波压掉残余毛刺
    const med = track.map((p, i) => {
      const w = track.slice(Math.max(0, i - 2), i + 3).map((x) => x.midi).filter((x) => x !== null);
      if (w.length < 3) return { ...p, midi: null };
      w.sort((a, b) => a - b);
      return { ...p, midi: w[Math.floor(w.length / 2)] };
    });

    // 并成音符：量化到半音，相邻同音合并，丢掉太短的（多是滑音过渡）
    const notes = [];
    let cur = null;
    for (const p of med) {
      if (p.midi === null) { if (cur) { notes.push(cur); cur = null; } continue; }
      const q = Math.round(p.midi);
      if (cur && q === cur.midi) { cur.t1 = p.t; cur.n++; continue; }
      if (cur) notes.push(cur);
      cur = { midi: q, t0: p.t, t1: p.t, n: 1 };
    }
    if (cur) notes.push(cur);
    const kept = notes.filter((n) => n.t1 - n.t0 >= 0.1);
    const voicedRatio = med.filter((x) => x.midi !== null).length / Math.max(1, med.length);
    void a4v;
    return { track: med, notes: kept, offSec, lenSec, voicedRatio };
  }

  function drawMel() {
    const c = $('#mel');
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr; c.height = h * dpr;
    const g = c.getContext('2d');
    g.scale(dpr, dpr); g.clearRect(0, 0, w, h);
    const tr = analyzed.track;
    const ms = tr.filter((x) => x.midi !== null).map((x) => x.midi);
    let lo = Math.floor(Math.min(...ms)) - 2, hi = Math.ceil(Math.max(...ms)) + 2;
    if (hi - lo < 12) { const m = (hi + lo) / 2; lo = m - 6; hi = m + 6; }
    const dur = tr.length ? tr[tr.length - 1].t : 1;
    const X = (t) => (t / dur) * w;
    const Y = (m) => h - ((m - lo) / (hi - lo)) * h;
    for (let m = Math.ceil(lo); m <= hi; m++) {
      const isC = ((m % 12) + 12) % 12 === 0;
      g.strokeStyle = isC ? '#3a4152' : '#232733';
      g.beginPath(); g.moveTo(0, Y(m)); g.lineTo(w, Y(m)); g.stroke();
      if (isC) { g.fillStyle = '#6b7285'; g.font = '9px sans-serif'; g.fillText(noteName(m), 2, Y(m) - 2); }
    }
    // 量化出的音符块
    const rowH = h / (hi - lo);
    g.fillStyle = 'rgba(163,123,255,.32)';
    for (const n of analyzed.notes) g.fillRect(X(n.t0), Y(n.midi) - rowH / 2, Math.max(2, X(n.t1) - X(n.t0)), rowH);
    // 原始轨迹
    g.strokeStyle = '#a37bff'; g.lineWidth = 1.6;
    g.beginPath();
    let started = false;
    for (const p of tr) {
      if (p.midi === null) { started = false; continue; }
      const x = X(p.t), y = Y(p.midi);
      if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
    }
    g.stroke();

    const ns = analyzed.notes;
    const lowN = Math.min(...ns.map((n) => n.midi));
    const highN = Math.max(...ns.map((n) => n.midi));
    $('#melInfo').innerHTML = `
      <div class="stat-grid">
        <div class="stat"><b>${ns.length}</b><span>提取到的音</span></div>
        <div class="stat"><b>${noteName(lowN)}–${noteName(highN)}</b><span>音域</span></div>
        <div class="stat"><b>${highN - lowN}</b><span>跨度(半音)</span></div>
      </div>
      <div class="tiny dim mt">紫块是量化出的音符，紫线是提取出的音高轨迹。
      有声帧占比 ${Math.round((analyzed.voicedRatio || 0) * 100)}% —— 
      占比低说明这段里人声不明显（纯伴奏段/间奏），换一段人声清楚的会更好。
      块很碎通常是转音多或提取到了伴奏，可以缩短时长只取一句试试。</div>`;
  }

  $('#btnUse').onclick = async () => {
    if (!analyzed || !analyzed.notes.length) return;
    // 转成带唱用的 [midi, 拍数]。以 0.25 秒为一拍换算，bpm 固定 60 便于对齐真实时长
    const notes = analyzed.notes.map((n) => [n.midi, Math.max(0.5, Math.round((n.t1 - n.t0) / 0.25) * 0.5)]);
    const payload = {
      id: '__custom', name: (file && file.name || '我的片段').replace(/\.[^.]+$/, '').slice(0, 24),
      bpm: 60, notes: notes.slice(0, 64),
      tip: `从「${file ? file.name : '本地音频'}」第 ${analyzed.offSec}s 起提取，共 ${notes.length} 个音`,
    };
    await db.put('meta', { k: 'singCustom', v: payload });
    toast('已存为带唱素材');
    location.hash = '#/sing';
  };

  return { resize() { if (analyzed) drawMel(); } };
}
