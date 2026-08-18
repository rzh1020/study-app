import { $, esc, toast } from '../ui.js';
import { setTitle } from '../app.js';
import { metaGet, metaSet, db } from '../db.js';
import { speakJa, stopJa, loadDict } from '../jaspeech.js';
import { getQueue, DECKS } from '../store.js';

/**
 * 课程页。这一页是为了解决「看不懂、死记硬背」。
 *
 * 之前日语部分只有「练」——2000 张词卡 + 42 张语法卡一股脑推过来，
 * 没有课、没有讲解、没有把句子拆开，所以只能靠背。
 *
 * 现在按教材的课堂流程组织：讲(explain) → 句型(pattern) → 例句逐成分拆解(examples)
 * → 练(drill) → 过关判据(gate)。顺序照《みんなの日本語初級Ⅰ》第 1-25 课的
 * 句型大纲重切成 31 课（见 tools/gen_course.py 里的依据说明）。
 *
 * 例句拆解是关键：用户说「看不懂」，就是因为之前只给整句不给成分。
 */
// 讲解正文里用 **重点** 标记关键概念，直接 esc 会把星号原样显示出来。
// 这里只支持加粗和分段 —— 讲解是自己生成的数据，不需要完整 Markdown。
function explainHtml(text) {
  return String(text || '')
    .split(/\n+/)
    .filter((l) => l.trim())
    .map((l) => `<p>${esc(l).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}</p>`)
    .join('');
}

export async function render(view, { args }) {
  const course = await fetch('./data/course.json').then((r) => r.json());
  const doneSet = new Set((await metaGet('lessonDone', [])) || []);
  const n = args[0] ? parseInt(args[0], 10) : 0;
  if (n >= 1 && n <= course.lessons.length) {
    return lessonView(view, course, course.lessons[n - 1], doneSet);
  }
  return listView(view, course, doneSet);
}

// ---------------- 课程列表 ----------------

function listView(view, course, doneSet) {
  setTitle('日语课程');
  const total = course.lessons.length;
  const done = course.lessons.filter((l) => doneSet.has(l.id)).length;
  // 下一课 = 第一个没学完的
  const next = course.lessons.find((l) => !doneSet.has(l.id)) || course.lessons[total - 1];

  view.innerHTML = `
    <a class="hp-next" href="#/course/${next.n}">
      <div class="hp-next-ic">${next.n}</div>
      <div class="hp-next-t">
        <span>接着学 · 第 ${next.n} / ${total} 课</span>
        <b>${esc(next.title)}</b>
        <i>${esc(next.pattern)}</i>
      </div>
      <div class="hp-next-go">▶</div>
    </a>

    <div class="card tight">
      <div class="row spread">
        <span class="small">已学完 <b>${done}</b> / ${total} 课</span>
        <span class="tiny dim">${esc(course.units.map((u) => u.name).join(' · '))}</span>
      </div>
      <div class="bar" style="margin-top:7px"><i style="width:${Math.round((done / total) * 100)}%"></i></div>
    </div>

    ${course.units.map((u) => {
      const ls = course.lessons.filter((l) => l.n >= u.from && l.n <= u.to);
      const uDone = ls.filter((l) => doneSet.has(l.id)).length;
      const isCur = ls.some((l) => l.n === next.n);
      return `
      <details class="cu" ${isCur ? 'open' : ''}>
        <summary>
          <span class="cu-n">${uDone}/${ls.length}</span>
          <span class="cu-t"><b>${esc(u.name)}</b><i>第 ${u.from}-${u.to} 课</i></span>
          <span class="plan-chev">›</span>
        </summary>
        <div class="cu-body">
          ${ls.map((l) => {
            const d = doneSet.has(l.id);
            const cur = l.n === next.n;
            return `<a class="cl ${d ? 'done' : ''} ${cur ? 'cur' : ''}" href="#/course/${l.n}">
              <span class="cl-n">${d ? '✓' : l.n}</span>
              <span class="cl-t"><b>${esc(l.title)}</b><i>${esc(l.pattern)}</i></span>
            </a>`;
          }).join('')}
        </div>
      </details>`;
    }).join('')}

    <div class="card tight">
      <div class="tiny dim">语法点顺序照《みんなの日本語初級Ⅰ》第 1-25 课的句型大纲，
      不是随便排的。每课先讲再练，例句都拆开讲成分。</div>
    </div>
  `;
}

// ---------------- 单课 ----------------

async function lessonView(view, course, lesson, doneSet) {
  setTitle(`第 ${lesson.n} 课`, `<a class="pill" href="#/course">目录</a>`);
  await loadDict();
  const isDone = doneSet.has(lesson.id);
  const prev = course.lessons[lesson.n - 2];
  const nextL = course.lessons[lesson.n];
  const deckName = DECKS[lesson.drill] ? DECKS[lesson.drill].name : lesson.drill;

  // 这一课绑定的词，从词表里取出来直接显示，不用跳去别处
  let words = [];
  if (lesson.words.length) {
    const voc = await fetch('./data/vocab.json').then((r) => r.json());
    const by = new Map();
    for (const v of voc.vocab) { by.set(v.jp, v); by.set(v.kana, v); }
    words = lesson.words.map((w) => by.get(w)).filter(Boolean);
  }

  view.innerHTML = `
    <div class="ls-hd">
      <div class="tiny dim">${esc(lesson.unit)} · 第 ${lesson.n} / ${course.lessons.length} 课</div>
      <h2>${esc(lesson.title)}</h2>
      <div class="ls-pat">${esc(lesson.pattern)}</div>
    </div>

    <div class="card ls-explain">${explainHtml(lesson.explain)}</div>

    <div class="sec-title">例句 · 点句子听读音</div>
    ${lesson.examples.map((e, i) => `
      <div class="ls-ex" data-ex="${i}">
        <div class="ls-ex-jp">${esc(e.jp)}<span class="ls-ex-play">🔊</span></div>
        <div class="ls-ex-cn">${esc(e.cn)}</div>
        <div class="ls-ex-note">${esc(e.note)}</div>
      </div>`).join('')}

    ${words.length ? `
    <div class="sec-title">这一课的词</div>
    <div class="card">
      ${words.map((w, i) => `
        <div class="ls-w" data-w="${i}">
          <div class="grow">
            <div class="ls-w-jp">${esc(w.jp)}<span class="ls-w-kana">${esc(w.kana)}</span></div>
            <div class="ls-w-cn">${esc(w.cn)}<span class="dim"> · ${esc(w.pos || '')}</span></div>
          </div>
          <span class="ls-w-play">🔊</span>
        </div>`).join('')}
    </div>` : ''}

    <div class="card ls-gate">
      <div class="tiny" style="color:var(--warn);font-weight:600">过关判据</div>
      <div class="small" style="margin-top:4px">${esc(lesson.gate)}</div>
    </div>

    <a class="btn btn-pri btn-block" href="#/review/${lesson.drill}">开始练 · ${esc(deckName)}</a>

    <label class="ls-done">
      <input type="checkbox" id="cbDone" ${isDone ? 'checked' : ''}>
      <span>这一课我学明白了</span>
    </label>

    <div class="btn-row" style="margin-top:6px">
      ${prev ? `<a class="btn btn-ghost" href="#/course/${prev.n}">← 第 ${prev.n} 课</a>` : '<span class="grow"></span>'}
      ${nextL ? `<a class="btn" href="#/course/${nextL.n}">第 ${nextL.n} 课 →</a>` : '<span class="grow"></span>'}
    </div>

    <div class="tiny dim center" style="margin-top:14px">出处：${esc(lesson.src)}</div>
  `;

  // 例句朗读。用内置日语语音（系统没有日语引擎），任意句子都能读。
  view.querySelectorAll('[data-ex]').forEach((el) => {
    el.onclick = async () => {
      const e = lesson.examples[+el.dataset.ex];
      el.classList.add('on');
      try { await speakJa(e.jp, null, null); } finally {
        setTimeout(() => el.classList.remove('on'), 600);
      }
    };
  });
  view.querySelectorAll('[data-w]').forEach((el) => {
    el.onclick = async () => {
      const w = words[+el.dataset.w];
      el.classList.add('on');
      try { await speakJa(w.jp, w.kana, null); } finally {
        setTimeout(() => el.classList.remove('on'), 600);
      }
    };
  });

  $('#cbDone').onchange = async (e) => {
    const s = new Set((await metaGet('lessonDone', [])) || []);
    if (e.target.checked) s.add(lesson.id); else s.delete(lesson.id);
    await metaSet('lessonDone', [...s]);
    toast(e.target.checked ? `第 ${lesson.n} 课已标记学完` : '已取消');
  };

  void getQueue;
  void db;
  return { destroy() { stopJa(); } };
}
