import { $, esc, toast, fmtDur } from '../ui.js';
import { setTitle } from '../app.js';
import { mic, audioCtx, playNote, playSequence, sleep } from '../audio.js';
import { noteName, parseNote, hzToMidi, midiToHz, detectPitch, decimate, pitchAccuracy } from '../pitch.js';
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
      <div class="small muted mb">选一段音频（mp3 / m4a / wav / flac 都行）。
      建议选 <b>10-30 秒的清唱或人声突出的片段</b> —— 伴奏越少，提取的旋律越准。
      整首歌里鼓和贝斯会干扰基频检测。</div>
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
      const off = Math.max(0, +$('#off').value || 0);
      const len = Math.min(40, Math.max(3, +$('#len').value || 20));
      $('#st').textContent = `解码完成 ${buf.duration.toFixed(1)}s / ${buf.sampleRate}Hz，分析中…`;
      await sleep(30);
      analyzed = analyze(buf, off, len, a4);
      if (!analyzed.track.filter((x) => x.midi !== null).length) {
        $('#st').innerHTML = '<span style="color:var(--warn)">这段里没提取到稳定音高。'
          + '换一段人声更突出的（清唱、副歌人声段），或缩短分析时长。</span>';
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
    const dec = sr >= 32000 ? 3 : 1;
    const sig = dec > 1 ? decimate(mono, dec) : mono;
    const rate = sr / dec;
    const win = 1024;
    const hop = Math.round(rate * 0.02);        // 20ms 一帧
    const track = [];
    for (let i = 0; i + win <= sig.length; i += hop) {
      const p = detectPitch(sig.subarray(i, i + win), rate, { minHz: 70, maxHz: 1100 });
      track.push({
        t: i / rate,
        midi: p.hz > 0 && p.clarity > 0.9 ? hzToMidi(p.hz, a4v) : null,
      });
    }
    // 中值滤波：单帧的八度跳变很常见，取 5 帧中值能压掉
    const med = track.map((p, i) => {
      const w = track.slice(Math.max(0, i - 2), i + 3).map((x) => x.midi).filter((x) => x !== null);
      if (w.length < 3) return { ...p, midi: null };
      w.sort((a, b) => a - b);
      return { ...p, midi: w[Math.floor(w.length / 2)] };
    });
    // 并成音符
    const notes = [];
    let cur = null;
    for (const p of med) {
      if (p.midi === null) { if (cur) { notes.push(cur); cur = null; } continue; }
      const q = Math.round(p.midi);
      if (cur && Math.abs(q - cur.midi) <= 0 ) { cur.t1 = p.t; cur.n++; continue; }
      if (cur) notes.push(cur);
      cur = { midi: q, t0: p.t, t1: p.t, n: 1 };
    }
    if (cur) notes.push(cur);
    const kept = notes.filter((n) => n.t1 - n.t0 >= 0.09);
    return { track: med, notes: kept, offSec, lenSec };
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
      <div class="tiny dim mt">紫块是量化出的音符，紫线是原始音高轨迹。
      如果块很碎、线乱跳，说明这段伴奏太重，换清唱段落效果会好很多。</div>`;
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
