import { $, esc, toast } from '../ui.js';
import { setTitle } from '../app.js';
import { audioCtx, playNote, playSequence, playChord, click, sleep } from '../audio.js';
import { noteName } from '../pitch.js';
import { db, dayStart } from '../db.js';
import { getConfig } from '../store.js';
import { LEVELS, LEVEL_BY_ID, FIXED_ROOT, UNLOCK, levelProgress, suggestLevel, nextSameGap } from '../ear-levels.js';

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

const SCALE = [0, 2, 4, 5, 7, 9, 11, 12];
const DEGREE_NAMES = ['do', 're', 'mi', 'fa', 'sol', 'la', 'ti', "do'"];
const TRI = [0, 2, 4]; // SCALE 下标：do mi sol

const RHYTHMS = [
  { name: '四个四分', beats: [1, 1, 1, 1] },
  { name: '前八后四×2', beats: [0.5, 0.5, 1, 0.5, 0.5, 1] },
  { name: '八分连续', beats: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5] },
  { name: '切分（四分-二分-四分）', beats: [1, 2, 1] },
  { name: '附点四分+八分', beats: [1.5, 0.5, 1.5, 0.5] },
  { name: '休止在第二拍', beats: [1, -1, 1, 1] },
];

const ROOT_LO = 55, ROOT_HI = 67;
const rand = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rand(a.length)];
const shuffle = (a) => {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i--) { const j = rand(i + 1); [b[i], b[j]] = [b[j], b[i]]; }
  return b;
};

export async function render(view, { args }) {
  const cfg = await getConfig();
  const id = args[0];
  if (!id || !LEVEL_BY_ID[id]) return menu(view, cfg);
  return quiz(view, LEVEL_BY_ID[id], cfg);
}

// ---------------- 菜单：课程阶梯 ----------------

async function menu(view, cfg) {
  setTitle('练耳');
  const all = await db.all('earlog');
  const today = all.filter((r) => r.ts >= dayStart());
  const prog = levelProgress(all);
  const next = suggestLevel(prog);
  const todayOk = today.filter((r) => r.correct).length;

  const card = (l) => {
    const p = prog[l.id];
    const isNext = l.id === next;
    const pill = !p.unlocked ? '<span class="pill dim">未解锁</span>'
      : p.passed ? '<span class="pill ok">已通关</span>'
      : p.acc !== null ? `<span class="pill ${p.acc >= UNLOCK.acc ? 'ok' : p.acc >= 0.6 ? 'warn' : 'bad'}">${Math.round(p.acc * 100)}%</span>`
      : '<span class="pill acc">未开始</span>';
    return `
    <div class="card" style="${isNext ? 'border-color:var(--acc)' : p.unlocked ? '' : 'opacity:.55'}">
      <div class="row spread mb">
        <div class="grow">
          <div class="row" style="gap:6px">
            <b>${esc(l.name)}</b>${pill}
            ${isNext ? '<span class="pill acc">建议练这个</span>' : ''}
          </div>
          <div class="tiny dim">${esc(l.desc)}</div>
        </div>
        ${p.unlocked
          ? `<a class="btn btn-sm ${isNext ? 'btn-pri' : ''}" href="#/ear/${l.id}">进入</a>`
          : '<button class="btn btn-sm" disabled>🔒</button>'}
      </div>
      <div class="tiny" style="color:var(--fg2)">为什么练：${esc(l.why)}</div>
      ${p.unlocked && !p.passed
        ? `<div class="bar mt"><i style="width:${Math.min((p.recentN / UNLOCK.window) * 100, 100)}%"></i></div>
           <div class="tiny dim" style="margin-top:4px">通关条件：最近 ${UNLOCK.window} 题正确率 ≥ ${Math.round(UNLOCK.acc * 100)}%（当前 ${p.recentN}/${UNLOCK.window} 题）· 累计 ${p.total} 题</div>`
        : p.total ? `<div class="tiny dim mt">累计 ${p.total} 题</div>` : ''}
    </div>`;
  };

  view.innerHTML = `
    <div class="card">
      <div class="row spread">
        <div><div class="tk-t">今天 ${today.length} / ${cfg.earDailyTarget} 题</div>
        <div class="tk-s">正确率 ${today.length ? Math.round((todayOk / today.length) * 100) : 0}%</div></div>
        <div class="pill ${today.length >= cfg.earDailyTarget ? 'ok' : 'acc'}">${today.length >= cfg.earDailyTarget ? '达标' : '进行中'}</div>
      </div>
      <div class="bar mt"><i style="width:${Math.min((today.length / cfg.earDailyTarget) * 100, 100)}%"></i></div>
    </div>

    <div class="card" style="border-color:rgba(91,140,255,.4);background:rgba(91,140,255,.06)">
      <h3 style="color:var(--acc)">零基础从①开始，不要跳</h3>
      <div class="small muted">前四级不需要任何乐理知识，主音固定在 C4。
      每一级都有「熟悉模式」——先听声音并直接看答案，可以无限重听，等听感建立了再测试。
      连续正确率达标才解锁下一级：练够不着的难度只会变成乱猜，乱猜不产生学习。</div>
      <a class="btn btn-pri btn-block mt" href="#/ear/${next}">从${esc(LEVEL_BY_ID[next].name)}开始</a>
    </div>

    <div class="sec-title">入门（不需要乐理基础）</div>
    ${LEVELS.filter((l) => l.tier === '入门').map(card).join('')}
    <div class="sec-title">进阶</div>
    ${LEVELS.filter((l) => l.tier === '进阶').map(card).join('')}

    <div class="card tight">
      <div class="tiny dim">戴耳机效果更好。手机扬声器低频缺失，会让低音区的判断变难。</div>
    </div>
  `;
}

// ---------------- 出题 ----------------

function quiz(view, level, cfg) {
  setTitle(level.name, '<a class="pill" href="#/ear">阶梯</a>');
  const a4 = cfg.a4;
  let q = null, answered = false, n = 0, ok = 0, destroyed = false;
  let learnMode = false;      // 熟悉模式：直接显示答案
  let logs = [];              // 本级历史，用于自适应

  view.innerHTML = `
    <div class="row spread mb">
      <div class="progress-mini"><span>本轮 <b id="qn">0</b></span><span>正确 <b id="qok">0</b></span><span id="qacc"></span></div>
      <label class="row tiny dim" style="gap:5px;margin:0">
        <input type="checkbox" id="cbLearn" style="width:auto"> 熟悉模式
      </label>
    </div>
    <div class="card tight" id="learnTip" style="display:none;border-color:rgba(242,178,62,.5);background:rgba(242,178,62,.07)">
      <div class="tiny" style="color:var(--warn)">熟悉模式：答案已经显示出来了。反复点播放，把声音和名称对上。
      听出感觉了就取消勾选开始测试 —— 熟悉模式的作答不计入正确率。</div>
    </div>
    <div class="card center" id="qbox">
      <div class="small muted" id="qtext">准备…</div>
      <div id="qextra" class="tiny dim"></div>
      <div class="btn-row mt">
        <button class="btn btn-pri" id="btnPlay">▶ 播放</button>
        <button class="btn btn-ghost" id="btnRef" title="重听参考音">🎵 参考音</button>
      </div>
    </div>
    <div id="opts"></div>
    <div id="fb" class="card tight hidden"></div>
    <div class="tiny dim center" style="margin-top:12px" id="tip"></div>
  `;

  const optsEl = $('#opts'), fbEl = $('#fb');

  $('#cbLearn').onchange = (e) => {
    learnMode = e.target.checked;
    $('#learnTip').style.display = learnMode ? '' : 'none';
    newQuestion();
  };

  async function loadLogs() {
    logs = (await db.all('earlog')).filter((r) => r.mode === level.id).sort((a, b) => a.ts - b.ts);
  }

  function newQuestion() {
    answered = false;
    fbEl.classList.add('hidden');
    $('#qextra').textContent = '';
    switch (level.kind) {
      case 'pair2': {
        // 高低：差距从 12 半音（一个八度，极易）随正确率收窄
        const recent = logs.slice(-8);
        const acc = recent.length >= 4 ? recent.filter((r) => r.correct).length / recent.length : 0;
        const gap = acc >= 0.85 ? pick([2, 3, 4]) : acc >= 0.6 ? pick([5, 7]) : pick([7, 12]);
        const up = Math.random() < 0.5;
        q = { root: FIXED_ROOT, gap, up, answer: up ? '更高' : '更低' };
        $('#qtext').textContent = '第二个音比第一个高还是低？';
        $('#qextra').textContent = `当前难度：相差 ${gap} 个半音（越小越难）`;
        break;
      }
      case 'same': {
        const gap = nextSameGap(logs.map((r) => ({ ...r, mode: level.id })));
        const isSame = Math.random() < 0.45;
        q = { root: FIXED_ROOT, gap, isSame, up: Math.random() < 0.5, answer: isSame ? '一样' : '不一样' };
        $('#qtext').textContent = '这两个音一样吗？';
        $('#qextra').textContent = `当前难度：不同时相差 ${gap} 个半音（会随你的表现自动调整）`;
        break;
      }
      case 'contour': {
        const shapes = {
          上行: [0, 2, 4], 下行: [4, 2, 0],
          先上后下: [0, 4, 1], 先下后上: [4, 0, 3],
        };
        const name = pick(Object.keys(shapes));
        q = { root: FIXED_ROOT, seq: shapes[name].map((i) => SCALE[i]), answer: name };
        $('#qtext').textContent = '这三个音的走向是？';
        break;
      }
      case 'degree3': {
        const i = pick(TRI);
        q = { root: FIXED_ROOT, degIdx: i, answer: DEGREE_NAMES[i] };
        $('#qtext').textContent = '先听 do（参考），再听目标音。它是哪个？';
        $('#qextra').textContent = '只可能是 do、mi、sol 三个之一';
        break;
      }
      case 'degree': {
        // 前 30 题固定主音，之后随机（随机主音才是真正的相对音高）
        const fixed = logs.length < 30;
        const root = fixed ? FIXED_ROOT : ROOT_LO + rand(ROOT_HI - ROOT_LO + 1);
        const di = 1 + rand(SCALE.length - 1);
        q = { root, degIdx: di, answer: String(di) };
        $('#qtext').textContent = '先听主音（do），再听目标音。它是第几级？';
        $('#qextra').textContent = fixed
          ? `主音固定在 ${noteName(FIXED_ROOT)}（还有 ${30 - logs.length} 题后改为随机主音）`
          : `主音随机：${noteName(root)}`;
        break;
      }
      case 'chord': {
        const pool = logs.length < 15 ? CHORDS.slice(0, 2) : CHORDS;
        const c = pick(pool);
        q = { root: logs.length < 15 ? FIXED_ROOT : ROOT_LO + rand(ROOT_HI - ROOT_LO + 1), chord: c, pool, answer: c.name };
        $('#qtext').textContent = pool.length === 2 ? '大三还是小三？' : '这是什么和弦？';
        $('#qextra').textContent = pool.length === 2 ? '大三明亮稳定，小三偏暗偏柔' : '';
        break;
      }
      case 'interval': {
        const pool = logs.length < 18 ? INTERVALS.filter((i) => [2, 3, 4, 7, 12].includes(i.s)) : INTERVALS;
        const iv = pick(pool);
        q = { root: ROOT_LO + rand(ROOT_HI - ROOT_LO + 1), iv, pool, answer: String(iv.s) };
        $('#qtext').textContent = '两个音相差多少？';
        break;
      }
      case 'melody': {
        const len = logs.length < 12 ? 3 : 4;
        const root = logs.length < 12 ? FIXED_ROOT : ROOT_LO + rand(ROOT_HI - ROOT_LO + 1);
        const seq = Array.from({ length: len }, () => rand(SCALE.length - 1));
        seq[0] = 0;
        const wrongs = [];
        for (let k = 0; k < 3; k++) {
          const w = seq.slice();
          const pos = 1 + rand(len - 1);
          let nv = rand(SCALE.length - 1), guard = 0;
          while (nv === w[pos] && guard++ < 20) nv = rand(SCALE.length - 1);
          w[pos] = nv;
          if (!wrongs.some((x) => x.join() === w.join()) && w.join() !== seq.join()) wrongs.push(w);
        }
        const options = shuffle([seq, ...wrongs]);
        q = { root, seq, options, answer: String(options.findIndex((o) => o.join() === seq.join())) };
        $('#qtext').textContent = '听旋律，选出对应的音级序列';
        break;
      }
      default: {
        const pool = logs.length < 10 ? RHYTHMS.slice(0, 4) : RHYTHMS;
        const p = pick(pool);
        q = { pat: p, pool, answer: p.name };
        $('#qtext').textContent = '听一小节节奏（先有两拍预备），选节奏型';
      }
    }
    renderOptions();
    $('#tip').textContent = learnMode
      ? '答案已标出。反复听，把声音和名字对应起来。'
      : '先做出判断再选。答错会自动重播一次。';
    play();
  }

  async function play() {
    try { audioCtx(); } catch { toast('浏览器不支持音频'); return; }
    const btn = $('#btnPlay');
    btn.disabled = true;
    try {
      switch (level.kind) {
        case 'pair2': {
          const second = q.root + (q.up ? q.gap : -q.gap);
          await playNote(q.root, 0.6, { a4 }); await sleep(180);
          await playNote(second, 0.7, { a4 });
          break;
        }
        case 'same': {
          const second = q.isSame ? q.root : q.root + (q.up ? q.gap : -q.gap);
          await playNote(q.root, 0.6, { a4 }); await sleep(180);
          await playNote(second, 0.7, { a4 });
          break;
        }
        case 'contour':
          await playSequence(q.seq.map((s) => q.root + s), 0.45, 0.05, { a4 });
          break;
        case 'degree3':
        case 'degree':
          await playNote(q.root, 0.6, { a4 }); await sleep(180);
          await playNote(q.root + SCALE[q.degIdx], 0.7, { a4 });
          break;
        case 'chord':
          await playChord(q.chord.steps.map((s) => q.root + s), 1.4, { a4 });
          break;
        case 'interval':
          await playNote(q.root, 0.55, { a4 }); await sleep(90);
          await playNote(q.root + q.iv.s, 0.65, { a4 }); await sleep(200);
          await playChord([q.root, q.root + q.iv.s], 0.9, { a4 });
          break;
        case 'melody':
          await playSequence(q.seq.map((i) => q.root + SCALE[i]), 0.45, 0.04, { a4 });
          break;
        default: {
          const beat = 60 / 92;
          click(true); await sleep(beat * 1000);
          click(); await sleep(beat * 1000);
          for (const b of q.pat.beats) { if (b > 0) click(false); await sleep(Math.abs(b) * beat * 1000); }
        }
      }
    } finally {
      if (!destroyed) btn.disabled = false;
    }
  }

  function renderOptions() {
    let html = '';
    if (level.options) {
      const cls = level.options.length > 2 ? 'c2' : 'c2';
      html = `<div class="opt-grid ${cls}">${level.options.map((o) =>
        `<button data-k="${esc(o)}"><b>${esc(o)}</b></button>`).join('')}</div>`;
    } else if (level.kind === 'degree3') {
      html = `<div class="opt-grid c3">${TRI.map((i) =>
        `<button data-k="${DEGREE_NAMES[i]}"><b>${DEGREE_NAMES[i]}</b><small>第 ${i + 1} 级</small></button>`).join('')}</div>`;
    } else if (level.kind === 'degree') {
      html = `<div class="opt-grid c4">${SCALE.slice(1).map((s, i) =>
        `<button data-k="${i + 1}"><b>${i + 2}</b><small>${DEGREE_NAMES[i + 1]}</small></button>`).join('')}</div>`;
    } else if (level.kind === 'chord') {
      html = `<div class="opt-grid c2">${q.pool.map((c) =>
        `<button data-k="${esc(c.name)}"><b>${esc(c.name)}</b><small>${esc(c.hint)}</small></button>`).join('')}</div>`;
    } else if (level.kind === 'interval') {
      html = `<div class="opt-grid ${q.pool.length > 6 ? 'c3' : 'c2'}">${q.pool.map((iv) =>
        `<button data-k="${iv.s}"><b>${esc(iv.name)}</b><small>${iv.s} 半音</small></button>`).join('')}</div>`;
    } else if (level.kind === 'melody') {
      html = `<div class="opt-grid">${q.options.map((o, i) =>
        `<button data-k="${i}"><b>${o.map((x) => DEGREE_NAMES[x]).join(' ')}</b></button>`).join('')}</div>`;
    } else {
      html = `<div class="opt-grid">${q.pool.map((p) =>
        `<button data-k="${esc(p.name)}"><b style="font-size:13px">${esc(p.name)}</b></button>`).join('')}</div>`;
    }
    optsEl.innerHTML = html;
    optsEl.querySelectorAll('button').forEach((b) => {
      if (learnMode && b.dataset.k === q.answer) b.classList.add('right');
      b.onclick = () => answer(b);
    });
  }

  async function answer(btn) {
    if (answered) return;
    answered = true;
    const correct = btn.dataset.k === q.answer;
    optsEl.querySelectorAll('button').forEach((b) => {
      if (b.dataset.k === q.answer) b.classList.add('right');
      else if (b === btn) b.classList.add('wrong');
      b.disabled = true;
    });

    if (!learnMode) {
      n++; if (correct) ok++;
      $('#qn').textContent = n;
      $('#qok').textContent = ok;
      $('#qacc').innerHTML = `<span class="pill ${ok / n >= UNLOCK.acc ? 'ok' : ''}">${Math.round((ok / n) * 100)}%</span>`;
      const rec = {
        ts: Date.now(), mode: level.id, correct: correct ? 1 : 0,
        item: q.answer, chose: btn.dataset.k,
      };
      if (q.gap) rec.gap = q.gap;
      await db.add('earlog', rec);
      logs.push(rec);
    }

    fbEl.classList.remove('hidden');
    fbEl.innerHTML = `
      <div class="small">${learnMode ? '<span class="pill">熟悉模式·不计分</span>'
        : correct ? '<span style="color:var(--ok)">✓ 对</span>' : '<span style="color:var(--bad)">✗ 错</span>'}
        ${explain()}</div>
      <div class="btn-row mt">
        <button class="btn btn-sm btn-ghost" id="btnAgain">重听</button>
        <button class="btn btn-sm btn-pri" id="btnNext">下一题</button>
      </div>
      ${!learnMode && n >= UNLOCK.window && ok / n >= UNLOCK.acc
        ? '<div class="tiny mt" style="color:var(--ok)">这一级已达标，回阶梯可以进下一级了</div>' : ''}`;
    $('#btnAgain').onclick = play;
    $('#btnNext').onclick = newQuestion;
    if (!correct && !learnMode) { await sleep(350); play(); }
  }

  function explain() {
    switch (level.kind) {
      case 'pair2': {
        const second = q.root + (q.up ? q.gap : -q.gap);
        return ` ${noteName(q.root)} → ${noteName(second)}，${q.up ? '上行' : '下行'} ${q.gap} 个半音。`;
      }
      case 'same': {
        if (q.isSame) return ` 两个音都是 ${noteName(q.root)}，完全相同。`;
        const second = q.root + (q.up ? q.gap : -q.gap);
        return ` ${noteName(q.root)} → ${noteName(second)}，相差 ${q.gap} 个半音。`;
      }
      case 'contour':
        return ` ${q.seq.map((s) => noteName(q.root + s)).join(' → ')}，走向是${q.answer}。`;
      case 'degree3':
      case 'degree':
        return ` 主音 ${noteName(q.root)}，目标 ${noteName(q.root + SCALE[q.degIdx])} = 第 ${q.degIdx + 1} 级（${DEGREE_NAMES[q.degIdx]}），差 ${SCALE[q.degIdx]} 个半音。`;
      case 'chord':
        return ` ${esc(q.chord.name)}：根音 ${noteName(q.root)}，${esc(q.chord.hint)}。`;
      case 'interval':
        return ` ${esc(q.iv.name)}（${q.iv.s} 半音）。参考旋律：${esc(q.iv.ref)}`;
      case 'melody':
        return ` 正确序列 ${q.seq.map((x) => DEGREE_NAMES[x]).join(' ')}，起音 ${noteName(q.root)}。`;
      default:
        return ` ${esc(q.pat.name)}`;
    }
  }

  $('#btnPlay').onclick = play;
  $('#btnRef').onclick = () => {
    if (level.kind === 'rhythm') { click(true); return; }
    playNote(q && q.root ? q.root : FIXED_ROOT, 0.9, { a4 });
  };

  loadLogs().then(() => {
    // 从没练过这一级就默认开熟悉模式：第一次接触直接测试等于乱猜
    if (!logs.length) { learnMode = true; $('#cbLearn').checked = true; $('#learnTip').style.display = ''; }
    newQuestion();
  });

  return { destroy() { destroyed = true; } };
}
