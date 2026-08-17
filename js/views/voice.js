import { $, esc, toast, fmtDur } from '../ui.js';
import { setTitle } from '../app.js';
import { mic, audioCtx, playNote, playSequence, click, sleep } from '../audio.js';
import { noteName, parseNote, pitchAccuracy, trackRange, hzToMidi } from '../pitch.js';
import { db } from '../db.js';
import { getConfig } from '../store.js';
import { keepAwake, onNativePause } from '../native.js';

export async function render(view, { args }) {
  const cfg = await getConfig();
  const sub = args[0] || 'tuner';
  if (sub === 'routine') return routine(view, cfg);
  if (sub === 'regression') return regression(view, cfg);
  if (sub === 'range') return rangeTest(view, cfg);
  return tuner(view, cfg);
}

// ---------- 共用：音高显示组件 ----------

function tunerHTML(id = 'tn') {
  return `
  <div class="card tuner" id="${id}">
    <div class="row spread">
      <div>
        <div class="tuner-note" id="${id}Note">--</div>
        <div class="tuner-hz" id="${id}Hz">等待声音</div>
      </div>
      <div class="center">
        <div class="tuner-cents" id="${id}Cents">--</div>
        <div class="tiny dim">音分偏差</div>
      </div>
    </div>
    <div class="needle-wrap">
      <div class="needle-scale">
        <div class="needle-zone"></div><div class="needle-mid"></div>
        <div class="needle" id="${id}Needle"></div>
      </div>
    </div>
    <div class="needle-labels"><span>-50</span><span>-20</span><span>0</span><span>+20</span><span>+50</span></div>
    <div class="level"><i id="${id}Level"></i></div>
  </div>`;
}

function bindTuner(id, cfg) {
  const el = {
    note: $(`#${id}Note`), hz: $(`#${id}Hz`), cents: $(`#${id}Cents`),
    needle: $(`#${id}Needle`), level: $(`#${id}Level`),
  };
  let lastSeen = 0;
  return function update(p) {
    el.level.style.width = `${Math.min(p.rms * 900, 100)}%`;
    if (p.hz > 0) {
      lastSeen = Date.now();
      el.note.textContent = p.name;
      el.hz.textContent = `${p.hz.toFixed(1)} Hz`;
      const c = p.cents;
      el.cents.textContent = (c > 0 ? '+' : '') + c;
      el.cents.style.color = Math.abs(c) <= 20 ? 'var(--ok)' : Math.abs(c) <= 40 ? 'var(--warn)' : 'var(--bad)';
      const clamped = Math.max(-50, Math.min(50, c));
      el.needle.style.left = `${50 + clamped}%`;
      el.needle.className = 'needle' + (Math.abs(c) <= 20 ? '' : Math.abs(c) <= 40 ? ' off' : ' bad');
    } else if (Date.now() - lastSeen > 400) {
      el.note.textContent = '--';
      el.hz.textContent = p.rms > 0.004 ? '声音不够稳定' : '等待声音';
      el.cents.textContent = '--';
      el.cents.style.color = '';
    }
    void cfg;
  };
}

/**
 * 安全上下文自查。
 * getUserMedia 在非安全上下文下不是「调用失败」，而是 navigator.mediaDevices
 * 整个对象不存在，直接调用会抛 TypeError，报出来的信息对用户毫无指导意义。
 * 所以先显式判断，给出能照着做的提示。
 */
export function micUnavailableReason() {
  if (!window.isSecureContext) {
    return `当前是非安全上下文（${location.protocol}//${location.hostname}），浏览器不提供麦克风。`
      + '需要用 https:// 或 http://localhost 打开。局域网 IP 不行。';
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return '这个浏览器不支持 getUserMedia，换 Chrome 试试。';
  }
  return null;
}

async function ensureMic() {
  const reason = micUnavailableReason();
  if (reason) { toast(reason, 6000); return false; }
  try {
    audioCtx();
    await mic.start();
    return true;
  } catch (err) {
    const msg = err.name === 'NotAllowedError' ? '权限被拒绝，在浏览器地址栏的站点设置里允许麦克风'
      : err.name === 'NotFoundError' ? '找不到麦克风设备'
      : err.name === 'NotReadableError' ? '麦克风被其他应用占用'
      : err.message;
    toast('麦克风打开失败：' + msg, 5000);
    return false;
  }
}

/** 非安全上下文时在页面顶部挂一条说明，而不是等用户点了按钮才发现 */
function insecureBanner() {
  const reason = micUnavailableReason();
  if (!reason) return '';
  return `<div class="card" style="border-color:rgba(242,178,62,.5);background:rgba(242,178,62,.08)">
    <div class="small" style="color:var(--warn)"><b>麦克风不可用</b></div>
    <div class="tiny dim" style="margin-top:4px">${esc(reason)}
    日语卡片和练耳不受影响，可以正常用。</div>
  </div>`;
}

// ---------- 1. 实时音准 + 跟唱 ----------

async function tuner(view, cfg) {
  setTitle('音准', '<a class="pill" href="#/voice/routine">练声流程</a>');
  view.innerHTML = `
    ${insecureBanner()}
    <div class="card tight">
      <div class="tiny dim">自己听自己会被骨传导误导（低频被加强），必须靠外部显示校正。
      绿区 ±20 音分是普通听众听不出跑调的范围。</div>
    </div>
    ${tunerHTML('tn')}
    <div class="card">
      <h3>跟唱校准</h3>
      <div class="small muted mb">先听参考音，再用「啊」或哼鸣唱同一个音，保持 3 秒。系统会算你这 3 秒的中位偏差。</div>
      <div class="row wrap mb">
        <select id="refNote" style="flex:1">
          ${['C3','D3','E3','F3','G3','A3','B3','C4','D4','E4','F4','G4','A4','C5']
            .map((x) => `<option value="${x}" ${x === 'G3' ? 'selected' : ''}>${x} (${midiHzLabel(x, cfg.a4)})</option>`).join('')}
        </select>
        <button class="btn btn-sm" id="btnRef">🎵 听</button>
      </div>
      <button class="btn btn-pri btn-block" id="btnCal" disabled>开始跟唱（3 秒）</button>
      <div id="calOut" class="mt"></div>
    </div>
    <div class="card">
      <h3>音高轨迹</h3>
      <canvas class="track" id="trk"></canvas>
      <div class="tiny dim mt">横轴时间（约 12 秒窗口），横线是半音格。看你的音是否在一条线上停住，还是一直漂。</div>
    </div>
    <div class="btn-row mt">
      <button class="btn btn-pri" id="btnStart">开启麦克风</button>
      <a class="btn btn-ghost" href="#/voice/range">音域测试</a>
    </div>
    <a class="card mt" href="#/sing" style="display:flex;align-items:center;gap:12px;text-decoration:none;color:inherit;border-color:var(--purple)">
      <div class="grow"><div class="tk-t">带唱练习</div>
      <div class="tk-s">跟着目标音高唱，看自己的线对不对得上；也能从手机里的歌提取旋律</div></div>
      <div class="dim">›</div>
    </a>
  `;

  const update = bindTuner('tn', cfg);
  const canvas = $('#trk');
  const track = [];
  let running = false;

  function drawTrack() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, hgt = canvas.clientHeight;
    canvas.width = w * dpr; canvas.height = hgt * dpr;
    const g = canvas.getContext('2d');
    g.scale(dpr, dpr); g.clearRect(0, 0, w, hgt);
    const valid = track.filter((p) => p.m);
    if (valid.length < 2) {
      g.fillStyle = '#6b7285'; g.font = '12px sans-serif'; g.textAlign = 'center';
      g.fillText('开启麦克风后唱一声', w / 2, hgt / 2);
      return;
    }
    const ms = valid.map((p) => p.m);
    let lo = Math.floor(Math.min(...ms)) - 2, hi = Math.ceil(Math.max(...ms)) + 2;
    if (hi - lo < 12) { const c = (hi + lo) / 2; lo = c - 6; hi = c + 6; }
    const Y = (m) => hgt - ((m - lo) / (hi - lo)) * hgt;
    // 半音格线，整 C 加亮
    for (let m = Math.ceil(lo); m <= hi; m++) {
      const isC = ((m % 12) + 12) % 12 === 0;
      g.strokeStyle = isC ? '#3a4152' : '#252a36';
      g.beginPath(); g.moveTo(0, Y(m)); g.lineTo(w, Y(m)); g.stroke();
      if (isC) { g.fillStyle = '#6b7285'; g.font = '9px sans-serif'; g.textAlign = 'left'; g.fillText(noteName(m), 2, Y(m) - 2); }
    }
    g.strokeStyle = '#5b8cff'; g.lineWidth = 2; g.lineJoin = 'round';
    g.beginPath();
    let started = false;
    track.forEach((p, i) => {
      const x = (i / (track.length - 1)) * w;
      if (!p.m) { started = false; return; }
      if (!started) { g.moveTo(x, Y(p.m)); started = true; } else g.lineTo(x, Y(p.m));
    });
    g.stroke();
  }

  const MAXPTS = 300; // 40ms/帧 × 300 ≈ 12s
  function onFrame(p) {
    update(p);
    track.push({
      m: p.hz > 0 && p.clarity > 0.8 ? hzToMidi(p.hz, cfg.a4) : null,
      hz: p.hz, clarity: p.clarity, t: performance.now(),
    });
    if (track.length > MAXPTS) track.shift();
    drawTrack();
  }

  $('#btnStart').onclick = async () => {
    if (running) { mic.stop(); keepAwake(false); running = false; $('#btnStart').textContent = '开启麦克风'; $('#btnCal').disabled = true; return; }
    if (!(await ensureMic())) return;
    mic.startLoop(onFrame, { a4: cfg.a4 });
    keepAwake(true);
    running = true;
    $('#btnStart').textContent = '关闭麦克风';
    $('#btnCal').disabled = false;
  };

  $('#btnRef').onclick = () => playNote(parseNote($('#refNote').value), 1.2, { a4: cfg.a4 });

  $('#btnCal').onclick = async () => {
    const target = parseNote($('#refNote').value);
    const btn = $('#btnCal');
    btn.disabled = true;
    await playNote(target, 1.0, { a4: cfg.a4 });
    await sleep(250);
    const samples = [];
    const winStart = performance.now();
    for (let i = 3; i > 0; i--) { btn.textContent = `唱… ${i}`; await sleep(1000); }
    // 按时间窗口而不是帧数截取：rAF 的实际帧间隔不固定，按帧数会取错窗口
    for (const p of track) if (p.m !== null && p.t >= winStart) samples.push(p.m);
    btn.textContent = '开始跟唱（3 秒）';
    btn.disabled = false;
    if (samples.length < 15) {
      $('#calOut').innerHTML = `<div class="pill warn">采到的有效帧太少（${samples.length}），声音再稳一点、再响一点</div>`;
      return;
    }
    samples.sort((a, b) => a - b);
    const med = samples[Math.floor(samples.length / 2)];
    const cents = Math.round((med - target) * 100);
    const drift = Math.round((samples[Math.floor(samples.length * 0.9)] - samples[Math.floor(samples.length * 0.1)]) * 100);
    const verdict = Math.abs(cents) <= 20 ? ['ok', '准'] : Math.abs(cents) <= 40 ? ['warn', '偏了但听众多半听不出'] : ['bad', '明显跑调'];
    $('#calOut').innerHTML = `
      <div class="kv"><span>目标</span><b>${noteName(target)}</b></div>
      <div class="kv"><span>你唱的（中位）</span><b>${noteName(Math.round(med))} ${cents > 0 ? '+' : ''}${cents} 音分</b></div>
      <div class="kv"><span>稳定度（10-90分位跨度）</span><b>${drift} 音分</b></div>
      <div class="mt"><span class="pill ${verdict[0]}">${verdict[1]}</span>
      ${drift > 60 ? '<span class="pill warn">音在漂，多半是气息支撑不够</span>' : ''}</div>`;
    await db.add('voice', {
      ts: Date.now(), kind: 'calibrate', durationSec: 4,
      metrics: { targetMidi: target, medianCents: cents, driftCents: drift },
    });
  };

  drawTrack();
  const offPause = onNativePause(() => mic.stopLoop());
  return {
    // 旋转屏幕只重绘轨迹画布，不销毁视图：正在采集的 track 数据必须保留
    resize() { drawTrack(); },
    destroy() { keepAwake(false); offPause(); mic.stop(); },
  };
}

function midiHzLabel(n, a4) {
  const m = parseNote(n);
  return `${(a4 * Math.pow(2, (m - 69) / 12)).toFixed(0)}Hz`;
}

// ---------- 2. 引导练声流程 ----------

const ROUTINE = [
  { t: '哼鸣热身', sec: 90, d: '闭口哼 /m/，音量很小。注意鼻梁到额头的振动感。从舒适中音开始，缓慢滑上滑下半个八度。', tip: '牙关放松、下巴不用力。感觉不到振动多半是软腭塌了。' },
  { t: 'Lip trill 唇颤', sec: 90, d: '嘟嘟音，带声。从低往高滑，再滑回来，连续不断。做不出来就先不发声只吹唇，或用手指轻托嘴角。', tip: '这是半封闭声道练习：唇部阻塞让你无法用挤喉的方式作弊。' },
  { t: '气息 4-4-8', sec: 120, d: '吸 4 拍 → 保持 4 拍 → 均匀呼 8 拍，做 5 组。跟着节拍器。', tip: '「保持」那 4 拍是关键，别跳过。呼气时腹肌想内收、横膈膜维持下沉，两股力对抗。', metronome: 60 },
  { t: '长音（气息 + 稳定度）', sec: 90, d: '中音区一个舒适的音，用「啊」尽量长，音量和音高都不许变。做 3 次。', tip: '句尾往下掉就是支撑不够。开着音准页看着唱效果更好。' },
  { t: '五度音阶', sec: 180, d: '1-2-3-4-5-4-3-2-1，一口气走完。每遍升半音，一直到开始吃力就停。', tip: '感觉到「挤」立刻降音量，不要硬顶。这一步同时练音准、气息和换声过渡。', scale: true },
  { t: '八度滑音', sec: 60, d: '用「wu」或哼鸣从低音滑到高八度再滑回，像警笛。做 5 次。', tip: '专门练换声点的平滑过渡。破音处慢下来、减小音量再过。' },
  { t: '抠一句', sec: 300, d: '挑一首歌里最难的 2-4 拍。慢速唱 → 降调唱 → 原速原调唱。录下来对比。', tip: '通唱是测试不是训练。通唱会把每个问题都重复一遍且都不解决。' },
];

function routine(view, cfg) {
  setTitle('引导练声', '<a class="pill" href="#/voice">音准</a>');
  let cur = -1;
  let remain = 0;
  let timer = 0;
  let metro = 0;
  let startedAt = 0;
  let totalPracticed = 0;

  view.innerHTML = `
    <div class="card">
      <div class="timer" id="tmr">--:--</div>
      <div class="center small muted" id="curName">按下面「开始」按顺序走一遍，共约 ${Math.round(ROUTINE.reduce((a, s) => a + s.sec, 0) / 60)} 分钟</div>
      <div class="btn-row mt">
        <button class="btn btn-pri" id="btnGo">开始</button>
        <button class="btn btn-ghost" id="btnSkip" disabled>下一步</button>
        <button class="btn btn-ghost" id="btnStop" disabled>结束</button>
      </div>
    </div>
    <div class="card tight" id="tipBox" style="display:none">
      <div class="small" id="tipText"></div>
    </div>
    <div class="card" id="steps"></div>
    <div class="card tight">
      <div class="tiny dim">顺序不能反：没热身直接抠曲目最容易受伤，也最容易把错误动作固化。
      出现喉部灼烧、说话变哑、上限比平时低两三度，立刻停练并保持沉默休息。</div>
    </div>
  `;

  function drawSteps() {
    $('#steps').innerHTML = ROUTINE.map((s, i) => `
      <div class="step ${i === cur ? 'cur' : i < cur ? 'fin' : ''}">
        <div class="sn">${i < cur ? '✓' : i + 1}</div>
        <div class="grow">
          <div class="st">${esc(s.t)} <span class="tiny dim">${s.sec}s</span></div>
          <div class="sd">${esc(s.d)}</div>
        </div>
      </div>`).join('');
  }

  function stopMetro() { if (metro) { clearInterval(metro); metro = 0; } }

  async function enter(i) {
    stopMetro();
    cur = i;
    if (i >= ROUTINE.length) return finish();
    const s = ROUTINE[i];
    remain = s.sec;
    $('#curName').textContent = `${i + 1}/${ROUTINE.length} · ${s.t}`;
    $('#tipBox').style.display = '';
    $('#tipText').innerHTML = `💡 ${esc(s.tip)}`;
    drawSteps();
    if (s.metronome) {
      let beat = 0;
      audioCtx();
      metro = setInterval(() => { click(beat % 4 === 0); beat++; }, 60000 / s.metronome);
    }
    if (s.scale) {
      // 给一个起始参考：五度音阶示范一遍，之后自己升半音
      audioCtx();
      playSequence([55, 57, 59, 60, 62, 60, 59, 57, 55], 0.35, 0.02, { a4: cfg.a4 });
    }
  }

  function tick() {
    remain--;
    $('#tmr').textContent = fmtDur(remain);
    if (remain <= 0) {
      click(true);
      enter(cur + 1);
    }
  }

  async function finish() {
    clearInterval(timer); timer = 0; stopMetro();
    keepAwake(false);
    totalPracticed = Math.round((Date.now() - startedAt) / 1000);
    $('#tmr').textContent = '✓';
    $('#curName').textContent = `完成，共 ${Math.round(totalPracticed / 60)} 分钟`;
    $('#btnGo').textContent = '再来一轮';
    $('#btnGo').disabled = false;
    $('#btnSkip').disabled = true;
    $('#btnStop').disabled = true;
    cur = ROUTINE.length;
    drawSteps();
    await db.add('voice', { ts: Date.now(), kind: 'routine', durationSec: totalPracticed, metrics: { steps: ROUTINE.length } });
    toast('已记入今日练声时长');
  }

  $('#btnGo').onclick = () => {
    audioCtx();
    keepAwake(true);
    startedAt = Date.now();
    $('#btnGo').disabled = true;
    $('#btnSkip').disabled = false;
    $('#btnStop').disabled = false;
    enter(0);
    $('#tmr').textContent = fmtDur(remain);
    clearInterval(timer);
    timer = setInterval(tick, 1000);
  };
  $('#btnSkip').onclick = () => enter(cur + 1);
  $('#btnStop').onclick = finish;

  drawSteps();
  return { destroy() { clearInterval(timer); stopMetro(); keepAwake(false); mic.stop(); } };
}

// ---------- 3. 音域测试 ----------

function rangeTest(view, cfg) {
  setTitle('音域测试', '<a class="pill" href="#/voice">返回</a>');
  view.innerHTML = `
    ${insecureBanner()}
    <div class="card tight">
      <div class="tiny dim">从舒适音开始，向下滑到最低还能稳定发声的音，再向上滑到最高。
      不要硬挤：能稳定发出 1 秒以上才算，尖叫和漏气的假声不计入。</div>
    </div>
    ${tunerHTML('rg')}
    <div class="card">
      <div class="stat-grid">
        <div class="stat"><b id="rgLo">--</b><span>最低</span></div>
        <div class="stat"><b id="rgHi">--</b><span>最高</span></div>
        <div class="stat"><b id="rgSpan">--</b><span>跨度(半音)</span></div>
      </div>
      <div class="btn-row mt">
        <button class="btn btn-pri" id="rgStart">开始测量</button>
        <button class="btn btn-ghost" id="rgSave" disabled>保存结果</button>
      </div>
      <div class="tiny dim mt" id="rgHint"></div>
    </div>
    <div class="card">
      <h3>历史</h3>
      <canvas class="chart" id="rgChart"></canvas>
      <div class="tiny dim mt">上下两条线分别是最低/最高音（MIDI 音号，每格 1 个半音）。</div>
    </div>
  `;

  const update = bindTuner('rg', cfg);
  let lo = null, hi = null, running = false;
  // midi -> 首次稳定命中的时间戳。用时长而不是帧数判定，
  // 因为 rAF 的实际帧间隔不固定，按帧数算会随设备性能漂移。
  const held = new Map();
  const HOLD_MS = 800;

  function onFrame(p) {
    update(p);
    if (p.hz > 0 && p.clarity > 0.88 && p.rms > 0.015) {
      const m = Math.round(hzToMidi(p.hz, cfg.a4));
      const now = performance.now();
      const first = held.get(m);
      if (first === undefined) { held.set(m, now); return; }
      // 同一个音要稳住 HOLD_MS 才承认，避免滑音途经的音被记成边界
      if (now - first >= HOLD_MS) {
        if (lo === null || m < lo) { lo = m; $('#rgLo').textContent = noteName(m); }
        if (hi === null || m > hi) { hi = m; $('#rgHi').textContent = noteName(m); }
        if (lo !== null && hi !== null) {
          $('#rgSpan').textContent = hi - lo;
          $('#rgSave').disabled = false;
          $('#rgHint').textContent = `跨度 ${((hi - lo) / 12).toFixed(1)} 个八度`;
        }
      }
    }
  }

  $('#rgStart').onclick = async () => {
    if (running) { mic.stop(); keepAwake(false); running = false; $('#rgStart').textContent = '开始测量'; return; }
    if (!(await ensureMic())) return;
    held.clear();
    mic.startLoop(onFrame, { a4: cfg.a4, minHz: 60, maxHz: 1400 });
    keepAwake(true);
    running = true;
    $('#rgStart').textContent = '停止';
    $('#rgHint').textContent = '同一个音要稳住约 1 秒才会被记录。';
  };

  $('#rgSave').onclick = async () => {
    if (lo === null || hi === null) return;
    await db.add('voice', { ts: Date.now(), kind: 'range', durationSec: 60, metrics: { lowMidi: lo, highMidi: hi, semitones: hi - lo } });
    toast('已保存');
    drawHistory();
  };

  async function drawHistory() {
    const rows = (await db.byIndex('voice', 'kind', IDBKeyRange.only('range'))).sort((a, b) => a.ts - b.ts);
    const { lineChart } = await import('../ui.js');
    const c = $('#rgChart');
    if (!rows.length) { lineChart(c, [{ label: '', v: null }], { emptyText: '还没有记录' }); return; }
    const labels = rows.map((r) => new Date(r.ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }));
    const los = rows.map((r, i) => ({ label: labels[i], v: r.metrics.lowMidi }));
    const his = rows.map((r, i) => ({ label: labels[i], v: r.metrics.highMidi }));
    const allV = [...los, ...his].map((x) => x.v);
    const min = Math.min(...allV) - 2, max = Math.max(...allV) + 2;
    lineChart(c, his, { min, max, color: '#f2b23e', fmtY: (v) => noteName(Math.round(v)) });
    // 第二条线叠加：直接再画一次（lineChart 会 clear，所以用一个临时 canvas 合成）
    const tmp = document.createElement('canvas');
    tmp.style.width = c.clientWidth + 'px'; tmp.style.height = c.clientHeight + 'px';
    tmp.width = c.width; tmp.height = c.height;
    document.body.appendChild(tmp);
    lineChart(tmp, los, { min, max, color: '#5b8cff', fmtY: () => '' });
    c.getContext('2d').drawImage(tmp, 0, 0, c.width, c.height);
    tmp.remove();
  }

  drawHistory();
  return {
    resize() { drawHistory(); },
    destroy() { keepAwake(false); mic.stop(); },
  };
}

// ---------- 4. 每周回归体检 ----------

const REG_STEPS = [
  { id: 'sustain', t: '最长发声（气息）', sec: 40, d: '深吸一口气，用中音区一个舒适的音唱「啊」，音量保持不变，尽量长。系统自动记录你实际发声的秒数。', metric: '秒' },
  { id: 'scale', t: '五度音阶（音准）', sec: 40, d: '跟着示范唱 1-2-3-4-5-4-3-2-1，用「啊」。系统算你相对最近半音的中位偏差。', metric: '音分' },
  { id: 'range', t: '音域上下限', sec: 60, d: '从舒适音向下滑到最低、再向上滑到最高。每个边界音要稳住 1 秒。', metric: '半音' },
  { id: 'song', t: '固定曲目片段', sec: 40, d: '唱你每周都用的同一句（自己定，别换）。会录音存档，用来主观对比音色。', metric: '音分' },
];

function regression(view, cfg) {
  setTitle('每周体检', '<a class="pill" href="#/data">数据</a>');
  let stepIdx = -1;
  let collecting = false;
  let frames = [];
  let voicedFrames = 0;
  const results = {};
  let refMidi = 55;

  view.innerHTML = `
    ${insecureBanner()}
    <div class="card tight">
      <div class="tiny dim">固定四个变量才有可比性：同素材、同调、同时段、同设备距离。
      建议每周日同一时间做，手机放在离嘴约 20cm 的固定位置。</div>
    </div>
    ${tunerHTML('rr')}
    <div class="card">
      <div class="row spread mb">
        <div class="grow"><b id="rrTitle">准备开始</b><div class="tiny dim" id="rrDesc">共 4 项，约 6 分钟</div></div>
        <div class="tuner-cents" id="rrTimer">--</div>
      </div>
      <div class="row wrap mb">
        <span class="small muted">参考音</span>
        <select id="rrRef" style="width:auto;flex:1">
          ${['E3','F3','G3','A3','B3','C4','D4','E4'].map((x) => `<option ${x === 'G3' ? 'selected' : ''}>${x}</option>`).join('')}
        </select>
        <button class="btn btn-sm" id="rrPlay">🎵</button>
      </div>
      <button class="btn btn-pri btn-block" id="rrGo">开始第 1 项</button>
      <div id="rrOut" class="mt"></div>
    </div>
    <div class="card" id="rrSteps"></div>
  `;

  const update = bindTuner('rr', cfg);

  function drawSteps() {
    $('#rrSteps').innerHTML = REG_STEPS.map((s, i) => {
      const r = results[s.id];
      // 先判 r：已经测完的项即使 stepIdx 还停在它身上，也应该显示为完成
      const cls = r ? 'fin' : i === stepIdx ? 'cur' : '';
      return `<div class="step ${cls}">
        <div class="sn">${r ? '✓' : i + 1}</div>
        <div class="grow">
          <div class="st">${esc(s.t)} ${r ? `<span class="pill ok">${esc(r.label)}</span>` : ''}</div>
          <div class="sd">${esc(s.d)}</div>
        </div>
      </div>`;
    }).join('');
  }

  function onFrame(p) {
    update(p);
    if (!collecting) return;
    // 存真实时间戳而不是靠「帧数 × 假定帧间隔」换算：
    // startLoop 是 rAF 节流的，实际间隔会大于设定值（40ms 设定在 60Hz 下实测约 46ms），
    // 用固定系数换算会把「最长发声秒数」这个头条指标系统性低估 10-20%。
    frames.push({ hz: p.hz, clarity: p.clarity, rms: p.rms, t: performance.now() });
    if (p.hz > 0 && p.rms > 0.012) voicedFrames++;
  }

  let timer = 0;
  async function runStep(i) {
    stepIdx = i;
    if (i >= REG_STEPS.length) return finishAll();
    const s = REG_STEPS[i];
    $('#rrTitle').textContent = `${i + 1}/${REG_STEPS.length} · ${s.t}`;
    $('#rrDesc').textContent = s.d;
    $('#rrGo').disabled = true;
    $('#rrOut').innerHTML = '';
    drawSteps();

    if (!(await ensureMic())) { $('#rrGo').disabled = false; return; }
    if (!mic._onFrame) mic.startLoop(onFrame, { a4: cfg.a4, minHz: 60, maxHz: 1400 });

    refMidi = parseNote($('#rrRef').value);
    if (s.id === 'scale') {
      await playSequence([0, 2, 4, 5, 7, 5, 4, 2, 0].map((x) => refMidi + x), 0.4, 0.02, { a4: cfg.a4 });
      await sleep(250);
    } else if (s.id === 'sustain' || s.id === 'song') {
      await playNote(refMidi, 1.0, { a4: cfg.a4 });
      await sleep(250);
    }

    frames = []; voicedFrames = 0; collecting = true;
    if (s.id === 'song') mic.startRecording();
    let remain = s.sec;
    click(true);
    $('#rrTimer').textContent = fmtDur(remain);
    clearInterval(timer);
    timer = setInterval(async () => {
      remain--;
      $('#rrTimer').textContent = fmtDur(remain);
      if (remain <= 0) { clearInterval(timer); await endStep(s); }
    }, 1000);
    $('#rrGo').textContent = '提前结束本项';
    $('#rrGo').disabled = false;
    $('#rrGo').onclick = async () => { clearInterval(timer); await endStep(s); };
  }

  async function endStep(s) {
    collecting = false;
    const audio = s.id === 'song' ? await mic.stopRecording() : null;
    let r;
    if (s.id === 'sustain') {
      // 最长「连续」发声段，而不是有声帧总数：中间断了气就该重新计时。
      // 允许 1 帧的瞬时丢失（辅音、检测抖动），超过则视为断开。
      const voiced = (f) => f.hz > 0 && f.rms > 0.012;
      let best = 0, runStart = -1, gap = 0, lastVoiced = -1;
      for (let i = 0; i < frames.length; i++) {
        if (voiced(frames[i])) {
          if (runStart < 0) runStart = i;
          lastVoiced = i;
          gap = 0;
        } else if (runStart >= 0 && ++gap > 1) {
          best = Math.max(best, frames[lastVoiced].t - frames[runStart].t);
          runStart = -1;
        }
      }
      if (runStart >= 0 && lastVoiced > runStart) best = Math.max(best, frames[lastVoiced].t - frames[runStart].t);
      const sec = +(best / 1000).toFixed(1);
      const totalVoicedSec = frames.length > 1
        ? +((voicedFrames / frames.length) * ((frames[frames.length - 1].t - frames[0].t) / 1000)).toFixed(1)
        : 0;
      r = { value: sec, label: `${sec}s`, detail: { longestSec: sec, voicedSec: totalVoicedSec } };
    } else if (s.id === 'range') {
      const rg = trackRange(frames, 0.88);
      r = rg
        ? { value: rg.semitones, label: `${rg.low}–${rg.high}`, detail: rg }
        : { value: null, label: '数据不足', detail: null };
    } else {
      const acc = pitchAccuracy(frames, 0.85);
      r = acc
        ? { value: acc.medianCents, label: `${acc.medianCents}音分`, detail: acc }
        : { value: null, label: '数据不足', detail: null };
    }
    if (audio) r.audio = audio;
    results[s.id] = r;
    $('#rrTimer').textContent = '--';
    $('#rrOut').innerHTML = `<div class="kv"><span>${esc(s.t)}</span><b>${esc(r.label)}</b></div>
      ${r.value === null ? '<div class="tiny" style="color:var(--warn)">有效帧太少：靠近手机、提高音量后重做本项</div>' : ''}`;
    drawSteps();
    $('#rrGo').textContent = stepIdx + 1 >= REG_STEPS.length ? '完成并保存' : `开始第 ${stepIdx + 2} 项`;
    $('#rrGo').onclick = () => runStep(stepIdx + 1);
  }

  async function finishAll() {
    const metrics = {
      sustainSec: results.sustain?.value ?? null,
      scaleCents: results.scale?.value ?? null,
      songCents: results.song?.value ?? null,
      rangeLow: results.range?.detail?.lowMidi ?? null,
      rangeHigh: results.range?.detail?.highMidi ?? null,
      rangeSemitones: results.range?.value ?? null,
      refMidi,
    };
    await db.add('voice', {
      ts: Date.now(), kind: 'regression', durationSec: 360,
      metrics, audio: results.song?.audio || null,
    });
    mic.stop();
    $('#rrTitle').textContent = '体检完成，已存档';
    $('#rrDesc').textContent = '去「数据」页看趋势曲线。下周同条件再做一次。';
    $('#rrGo').textContent = '看趋势';
    $('#rrGo').onclick = () => (location.hash = '#/data');
    $('#rrOut').innerHTML = Object.entries({
      '最长发声': metrics.sustainSec === null ? '-' : metrics.sustainSec + ' s',
      '音阶音准': metrics.scaleCents === null ? '-' : metrics.scaleCents + ' 音分',
      '曲目音准': metrics.songCents === null ? '-' : metrics.songCents + ' 音分',
      '音域': metrics.rangeLow === null ? '-' : `${noteName(metrics.rangeLow)}–${noteName(metrics.rangeHigh)}（${metrics.rangeSemitones} 半音）`,
    }).map(([k, v]) => `<div class="kv"><span>${k}</span><b>${esc(v)}</b></div>`).join('');
    stepIdx = REG_STEPS.length;
    drawSteps();
    toast('回归数据已保存');
  }

  $('#rrPlay').onclick = () => playNote(parseNote($('#rrRef').value), 1.2, { a4: cfg.a4 });
  $('#rrGo').onclick = () => { keepAwake(true); runStep(0); };
  drawSteps();

  const offPause = onNativePause(() => { collecting = false; mic.stopLoop(); });
  return { destroy() { clearInterval(timer); keepAwake(false); offPause(); mic.stop(); } };
}
