import { $, esc, toast } from '../ui.js';
import { setTitle } from '../app.js';
import { audioCtx, playNote, playSequence, playChord, click, sleep } from '../audio.js';
import { noteName } from '../pitch.js';
import { db, dayStart } from '../db.js';
import { getConfig } from '../store.js';

const INTERVALS = [
  { s: 1, name: '小二度', ref: '《大白鲨》主题' },
  { s: 2, name: '大二度', ref: '《生日快乐》头两音' },
  { s: 3, name: '小三度', ref: '《绿袖子》开头' },
  { s: 4, name: '大三度', ref: '《欢乐颂》头两音' },
  { s: 5, name: '纯四度', ref: '《婚礼进行曲》开头' },
  { s: 6, name: '增四度', ref: '《辛普森》主题' },
  { s: 7, name: '纯五度', ref: '《星球大战》主题' },
  { s: 8, name: '小六度', ref: '《爱的礼赞》' },
  { s: 9, name: '大六度', ref: '《NBC》台标音' },
  { s: 10, name: '小七度', ref: '《西城故事》Somewhere' },
  { s: 11, name: '大七度', ref: '张力很强，少见' },
  { s: 12, name: '纯八度', ref: '《Somewhere over the rainbow》' },
];

const CHORDS = [
  { name: '大三和弦', steps: [0, 4, 7], hint: '明亮、稳定' },
  { name: '小三和弦', steps: [0, 3, 7], hint: '暗、柔' },
  { name: '减三和弦', steps: [0, 3, 6], hint: '紧张、不稳' },
  { name: '增三和弦', steps: [0, 4, 8], hint: '悬浮、怪异' },
];

const SCALE = [0, 2, 4, 5, 7, 9, 11, 12]; // 大调音阶（含高八度主音）
const DEGREE_NAMES = ['do', 're', 'mi', 'fa', 'sol', 'la', 'ti', "do'"];

const MODES = {
  degree: { name: '音级辨识', desc: '先听主音，再听一个音，判断它是第几级。首调听感的基础。', level: 1 },
  chord: { name: '和弦性质', desc: '大三 / 小三（进阶加减三、增三）。流行歌 90% 只有前两种。', level: 2 },
  interval: { name: '音程辨识', desc: '两个音之间差几度。先练 2/3/5/8 度，再补 4/6/7。', level: 3 },
  melody: { name: '旋律模唱', desc: '听 3-4 个音的短句，选出音级序列。', level: 4 },
  rhythm: { name: '节奏辨识', desc: '听一小节节奏，选出对应的节奏型。切分感是流行歌的关键。', level: 5 },
};

// 音程/和弦的根音范围：控制在中央区，避免极低极高影响听辨
const ROOT_LO = 55; // G3
const ROOT_HI = 67; // G4

const rand = (n) => Math.floor(Math.random() * n);
const pick = (arr) => arr[rand(arr.length)];

export async function render(view, { args }) {
  const cfg = await getConfig();
  const mode = args[0] && MODES[args[0]] ? args[0] : null;
  if (!mode) return menu(view, cfg);
  return quiz(view, mode, cfg);
}

async function menu(view, cfg) {
  setTitle('练耳');
  const rows = await db.byIndex('earlog', 'ts', IDBKeyRange.lowerBound(dayStart()));
  const all = await db.all('earlog');
  const byMode = {};
  for (const r of all) {
    byMode[r.mode] = byMode[r.mode] || { n: 0, ok: 0 };
    byMode[r.mode].n++;
    if (r.correct) byMode[r.mode].ok++;
  }
  const today = rows.length;
  const todayOk = rows.filter((r) => r.correct).length;

  view.innerHTML = `
    <div class="card">
      <div class="row spread">
        <div><div class="tk-t">今天 ${today} / ${cfg.earDailyTarget} 题</div>
        <div class="tk-s">正确率 ${today ? Math.round((todayOk / today) * 100) : 0}%</div></div>
        <div class="pill ${today >= cfg.earDailyTarget ? 'ok' : 'acc'}">${today >= cfg.earDailyTarget ? '达标' : '进行中'}</div>
      </div>
      <div class="bar mt"><i style="width:${Math.min((today / cfg.earDailyTarget) * 100, 100)}%"></i></div>
    </div>

    <div class="card tight">
      <div class="tiny dim">戴耳机效果更好。必须先猜再看答案——先看答案只是在验证已知信息，几乎不产生学习。</div>
    </div>

    ${Object.entries(MODES).map(([k, m]) => {
      const s = byMode[k];
      const acc = s && s.n ? Math.round((s.ok / s.n) * 100) : null;
      return `
      <div class="card">
        <div class="row spread mb">
          <div class="grow">
            <div class="row" style="gap:6px"><b>${esc(m.name)}</b>
            ${acc !== null ? `<span class="pill ${acc >= 90 ? 'ok' : acc >= 70 ? '' : 'warn'}">${acc}%</span>` : '<span class="pill dim">未开始</span>'}</div>
            <div class="tiny dim">${esc(m.desc)}</div>
          </div>
          <a class="btn btn-sm btn-pri" href="#/ear/${k}">开始</a>
        </div>
        ${s ? `<div class="tiny dim">累计 ${s.n} 题</div>` : ''}
      </div>`;
    }).join('')}

    <div class="card tight">
      <div class="tiny dim">建议顺序：音级 → 和弦 → 音程 → 旋律 → 节奏。前一项正确率稳定 90% 以上再进下一项，
      否则是在用蒙的方式做题。</div>
    </div>
  `;
}

function quiz(view, mode, cfg) {
  setTitle(MODES[mode].name, '<a class="pill" href="#/ear">返回</a>');
  let q = null;
  let answered = false;
  let n = 0, ok = 0;
  let destroyed = false;

  view.innerHTML = `
    <div class="row spread mb">
      <div class="progress-mini"><span>本轮 <b id="qn">0</b></span><span>正确 <b id="qok">0</b></span><span id="qacc"></span></div>
      <a class="pill" href="#/ear">结束</a>
    </div>
    <div class="card center" id="qbox">
      <div class="small muted" id="qtext">准备…</div>
      <div class="btn-row mt">
        <button class="btn btn-pri" id="btnPlay">▶ 播放</button>
        <button class="btn btn-ghost" id="btnRef" title="重听参考音">🎵 主音</button>
      </div>
    </div>
    <div id="opts"></div>
    <div id="fb" class="card tight hidden"></div>
    <div class="tiny dim center" style="margin-top:12px" id="tip"></div>
  `;

  const optsEl = $('#opts');
  const fbEl = $('#fb');

  function newQuestion() {
    answered = false;
    fbEl.classList.add('hidden');
    const a4 = cfg.a4;
    if (mode === 'degree') {
      const root = ROOT_LO + rand(ROOT_HI - ROOT_LO + 1);
      const di = 1 + rand(SCALE.length - 1); // 不出主音本身（太简单）
      q = { root, degIdx: di, target: root + SCALE[di], a4 };
      $('#qtext').textContent = '先听主音（do），再听目标音。它是第几级？';
    } else if (mode === 'chord') {
      const pool = n < 12 ? CHORDS.slice(0, 2) : CHORDS; // 前 12 题只出大小三
      const c = pick(pool);
      const root = ROOT_LO + rand(ROOT_HI - ROOT_LO + 1);
      q = { root, chord: c, pool, a4 };
      $('#qtext').textContent = pool.length === 2 ? '大三还是小三？' : '这是什么和弦？';
    } else if (mode === 'interval') {
      const pool = n < 15 ? INTERVALS.filter((i) => [2, 3, 4, 7, 12].includes(i.s)) : INTERVALS;
      const iv = pick(pool);
      const root = ROOT_LO + rand(ROOT_HI - ROOT_LO + 1);
      q = { root, iv, pool, a4 };
      $('#qtext').textContent = '两个音相差多少？';
    } else if (mode === 'melody') {
      const root = ROOT_LO + rand(ROOT_HI - ROOT_LO + 1);
      const len = n < 10 ? 3 : 4;
      const seq = Array.from({ length: len }, () => rand(SCALE.length - 1));
      seq[0] = 0; // 从主音起，给听觉一个锚
      const wrongs = [];
      for (let k = 0; k < 3; k++) {
        const w = seq.slice();
        // 只改一个音，逼你听清具体哪一个音不同，而不是靠整体轮廓蒙
        let pos = 1 + rand(len - 1);
        let nv = rand(SCALE.length - 1);
        let guard = 0;
        while (nv === w[pos] && guard++ < 20) nv = rand(SCALE.length - 1);
        w[pos] = nv;
        if (!wrongs.some((x) => x.join() === w.join()) && w.join() !== seq.join()) wrongs.push(w);
      }
      q = { root, seq, options: shuffle([seq, ...wrongs]), a4 };
      $('#qtext').textContent = '听旋律，选出对应的音级序列。';
    } else {
      // rhythm: 一小节 4/4，用 1=四分音符 0.5=八分 的时值序列表示
      const PATTERNS = [
        { name: '四个四分', beats: [1, 1, 1, 1] },
        { name: '前八后四×2', beats: [0.5, 0.5, 1, 0.5, 0.5, 1] },
        { name: '八分连续', beats: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5] },
        { name: '切分（四分-二分-四分）', beats: [1, 2, 1] },
        { name: '附点四分+八分', beats: [1.5, 0.5, 1.5, 0.5] },
        { name: '休止在第二拍', beats: [1, -1, 1, 1] },
      ];
      const pool = n < 10 ? PATTERNS.slice(0, 4) : PATTERNS;
      const p = pick(pool);
      q = { pat: p, pool, a4 };
      $('#qtext').textContent = '听一小节节奏（先有两拍预备），选节奏型。';
    }
    renderOptions();
    $('#tip').textContent = '先做出判断再选，答错会给出重听机会。';
    play();
  }

  async function play() {
    try { audioCtx(); } catch { toast('浏览器不支持音频'); return; }
    const btn = $('#btnPlay');
    btn.disabled = true;
    try {
      if (mode === 'degree') {
        await playNote(q.root, 0.6, { a4: q.a4 });
        await sleep(160);
        await playNote(q.target, 0.7, { a4: q.a4 });
      } else if (mode === 'chord') {
        await playChord(q.chord.steps.map((s) => q.root + s), 1.4, { a4: q.a4 });
      } else if (mode === 'interval') {
        await playNote(q.root, 0.55, { a4: q.a4 });
        await sleep(90);
        await playNote(q.root + q.iv.s, 0.65, { a4: q.a4 });
        await sleep(200);
        await playChord([q.root, q.root + q.iv.s], 0.9, { a4: q.a4 }); // 再叠一次，帮助听和声色彩
      } else if (mode === 'melody') {
        await playSequence(q.seq.map((i) => q.root + SCALE[i]), 0.45, 0.04, { a4: q.a4 });
      } else {
        const bpm = 92;
        const beat = 60 / bpm;
        click(true); await sleep(beat * 1000);
        click(); await sleep(beat * 1000);
        for (const b of q.pat.beats) {
          if (b > 0) click(false);
          await sleep(Math.abs(b) * beat * 1000);
        }
      }
    } finally {
      if (!destroyed) btn.disabled = false;
    }
  }

  function renderOptions() {
    let html = '';
    if (mode === 'degree') {
      html = `<div class="opt-grid c4">${SCALE.slice(1).map((s, i) =>
        `<button data-i="${i + 1}"><b>${i + 2}</b><small>${DEGREE_NAMES[i + 1]}</small></button>`).join('')}</div>`;
    } else if (mode === 'chord') {
      html = `<div class="opt-grid ${q.pool.length > 2 ? 'c2' : 'c2'}">${q.pool.map((c) =>
        `<button data-name="${esc(c.name)}"><b>${esc(c.name)}</b><small>${esc(c.hint)}</small></button>`).join('')}</div>`;
    } else if (mode === 'interval') {
      html = `<div class="opt-grid ${q.pool.length > 6 ? 'c3' : 'c2'}">${q.pool.map((iv) =>
        `<button data-s="${iv.s}"><b>${esc(iv.name)}</b><small>${iv.s} 半音</small></button>`).join('')}</div>`;
    } else if (mode === 'melody') {
      html = `<div class="opt-grid">${q.options.map((o, i) =>
        `<button data-o="${i}"><b>${o.map((x) => DEGREE_NAMES[x]).join(' ')}</b></button>`).join('')}</div>`;
    } else {
      html = `<div class="opt-grid">${q.pool.map((p) =>
        `<button data-name="${esc(p.name)}"><b style="font-size:13px">${esc(p.name)}</b></button>`).join('')}</div>`;
    }
    optsEl.innerHTML = html;
    optsEl.querySelectorAll('button').forEach((b) => (b.onclick = () => answer(b)));
  }

  function correctKey() {
    if (mode === 'degree') return String(q.degIdx);
    if (mode === 'chord') return q.chord.name;
    if (mode === 'interval') return String(q.iv.s);
    if (mode === 'melody') return String(q.options.findIndex((o) => o.join() === q.seq.join()));
    return q.pat.name;
  }
  function keyOf(btn) {
    return btn.dataset.i ?? btn.dataset.name ?? btn.dataset.s ?? btn.dataset.o;
  }

  async function answer(btn) {
    if (answered) return;
    answered = true;
    const correct = keyOf(btn) === correctKey();
    n++;
    if (correct) ok++;
    optsEl.querySelectorAll('button').forEach((b) => {
      const k = keyOf(b);
      if (k === correctKey()) b.classList.add('right');
      else if (b === btn) b.classList.add('wrong');
      b.disabled = true;
    });
    $('#qn').textContent = n;
    $('#qok').textContent = ok;
    $('#qacc').innerHTML = `<span class="${ok / n >= 0.9 ? 'pill ok' : 'pill'}">${Math.round((ok / n) * 100)}%</span>`;

    await db.add('earlog', { ts: Date.now(), mode, correct: correct ? 1 : 0, item: correctKey(), chose: keyOf(btn) });

    fbEl.classList.remove('hidden');
    fbEl.innerHTML = `
      <div class="row spread">
        <div class="grow small">
          ${correct ? '<span style="color:var(--ok)">✓ 对</span>' : '<span style="color:var(--bad)">✗ 错</span>'}
          ${explain()}
        </div>
      </div>
      <div class="btn-row mt">
        <button class="btn btn-sm btn-ghost" id="btnAgain">重听</button>
        <button class="btn btn-sm btn-pri" id="btnNext">下一题</button>
      </div>`;
    $('#btnAgain').onclick = play;
    $('#btnNext').onclick = newQuestion;
    // 答错必须重听一遍：只看正确答案不会修正听觉判别
    if (!correct) { await sleep(300); play(); }
  }

  function explain() {
    if (mode === 'degree') return ` 主音 ${noteName(q.root)}，目标 ${noteName(q.target)} = 第 ${q.degIdx + 1} 级（${DEGREE_NAMES[q.degIdx]}），差 ${SCALE[q.degIdx]} 个半音。`;
    if (mode === 'chord') return ` ${esc(q.chord.name)}：根音 ${noteName(q.root)}，结构 +${q.chord.steps[1]}+${q.chord.steps[2] - q.chord.steps[1]} 半音。${esc(q.chord.hint)}`;
    if (mode === 'interval') return ` ${esc(q.iv.name)}（${q.iv.s} 半音）。参考旋律：${esc(q.iv.ref)}`;
    if (mode === 'melody') return ` 正确序列 ${q.seq.map((x) => DEGREE_NAMES[x]).join(' ')}，起音 ${noteName(q.root)}。`;
    return ` ${esc(q.pat.name)}`;
  }

  $('#btnPlay').onclick = play;
  $('#btnRef').onclick = () => playNote(mode === 'rhythm' ? 69 : q.root, 0.8, { a4: cfg.a4 });
  newQuestion();

  return { destroy() { destroyed = true; } };
}

function shuffle(a) {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}
