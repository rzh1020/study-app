import { esc } from '../ui.js';
import { setTitle } from '../app.js';
import { deckStats, getConfig, streak, todayReviewCount, DECKS } from '../store.js';
import { db, dayStart, dayKey } from '../db.js';

/**
 * 首页 = 单一路径。
 *
 * 之前这一页是「树」：5 个任务行分成两组，外加计划卡，用户每次进来都要
 * 自己判断先做哪个。Duolingo 2022 改版把「树」换成单路径，理由是
 * 「两个人花同样时间做同样多课程，却停在不同地方」—— 选择本身是负担，
 * 而且会导致进度不可比。
 *
 * 所以这一版：
 *   1. 顶部只有一行状态（连续天数 + 今日完成度），不占版面
 *   2. 中间一张「现在做这个」大卡，只给一个动作
 *   3. 下面是今天的路径节点：做完的打勾、当前的高亮、后面的压暗
 *   4. 解释性文字全部去掉 —— 需要说明的写在各功能页里，首页只负责「开始」
 */

/** 一个节点的定义。order 决定路径顺序，也就是我建议的先后。 */
function buildSteps({ jpDue, jpNew, theory, earDone, earTarget, voiceMin, voiceTarget, needReg }) {
  const steps = [];
  if (needReg) {
    steps.push({
      id: 'reg', icon: '基', label: '声乐体检', href: '#/voice/regression',
      sub: '建立基线，之后每周复测才有可比性',
      done: false, weight: 0,
    });
  }
  steps.push({
    id: 'jp', icon: '語', label: '日语', href: '#/jp',
    sub: jpDue + jpNew > 0 ? `到期 ${jpDue}，新词 ${jpNew}` : '今天做完了',
    done: jpDue + jpNew === 0, weight: 1,
  });
  steps.push({
    id: 'ear', icon: '耳', label: '练耳', href: '#/ear',
    sub: earDone >= earTarget ? `今天 ${earDone} 题，达标` : `${earDone} / ${earTarget} 题`,
    done: earDone >= earTarget, weight: 2,
  });
  steps.push({
    id: 'sing', icon: '唱', label: '带唱', href: '#/sing',
    sub: '跟着目标音高唱，看自己准不准',
    done: false, weight: 3, optional: true,
  });
  steps.push({
    id: 'voice', icon: '声', label: '引导练声', href: '#/voice/routine',
    sub: voiceMin >= voiceTarget ? `今天 ${voiceMin} 分钟，达标` : `${voiceMin} / ${voiceTarget} 分钟 · 需要出声`,
    done: voiceMin >= voiceTarget, weight: 4,
  });
  steps.push({
    id: 'theory', icon: '理', label: '声乐科普', href: '#/review/theory',
    sub: theory.due + theory.newLeft > 0 ? `${theory.due + theory.newLeft} 张` : '今天做完了',
    done: theory.due + theory.newLeft === 0, weight: 5, optional: true,
  });
  return steps;
}

export async function render(view) {
  const [stats, cfg, st, revToday, earRows, voiceRows, regRows] = await Promise.all([
    deckStats(), getConfig(), streak(), todayReviewCount(),
    db.byIndex('earlog', 'ts', IDBKeyRange.lowerBound(dayStart())),
    db.byIndex('voice', 'ts', IDBKeyRange.lowerBound(dayStart())),
    db.byIndex('voice', 'kind', IDBKeyRange.only('regression')),
  ]);
  setTitle('今日', `<span class="pill ${st.todayDone ? 'ok' : ''}">🔥 ${st.days}</span>`);

  let jpDue = 0, jpNew = 0;
  for (const [d, s] of Object.entries(stats)) {
    if (!s.enabled || DECKS[d].group !== '日语') continue;
    jpDue += s.due; jpNew += s.newLeft;
  }
  const lastReg = regRows.sort((a, b) => b.ts - a.ts)[0];
  const daysSinceReg = lastReg ? Math.floor((Date.now() - lastReg.ts) / 86400000) : null;

  const steps = buildSteps({
    jpDue, jpNew, theory: stats.theory,
    earDone: earRows.length, earTarget: cfg.earDailyTarget,
    voiceMin: Math.round(voiceRows.reduce((a, v) => a + (v.durationSec || 0), 0) / 60),
    voiceTarget: cfg.voiceDailyMin,
    needReg: daysSinceReg === null || daysSinceReg >= 7,
  });

  // 「现在做这个」= 路径上第一个没完成的必做项；全做完了就给可选项
  const next = steps.find((s) => !s.done && !s.optional)
    || steps.find((s) => !s.done)
    || null;
  const required = steps.filter((s) => !s.optional);
  const doneCount = required.filter((s) => s.done).length;
  const pct = Math.round((doneCount / Math.max(required.length, 1)) * 100);

  view.innerHTML = `
    <div class="hp-top">
      <div class="hp-ring" style="--p:${pct}">
        <span>${pct}<i>%</i></span>
      </div>
      <div class="hp-top-t">
        <b>${st.todayDone ? '今天已经开始了' : '今天还没开始'}</b>
        <span>连续 ${st.days} 天 · 复习 ${revToday} 次 · 今日 ${doneCount}/${required.length} 项</span>
      </div>
    </div>

    ${next ? `
    <a class="hp-next" href="${next.href}">
      <div class="hp-next-ic">${esc(next.icon)}</div>
      <div class="hp-next-t">
        <span>现在做这个</span>
        <b>${esc(next.label)}</b>
        <i>${esc(next.sub)}</i>
      </div>
      <div class="hp-next-go">▶</div>
    </a>` : `
    <div class="hp-next done">
      <div class="hp-next-ic">✓</div>
      <div class="hp-next-t">
        <span>今天的都做完了</span>
        <b>去随便练点什么</b>
        <i>下面任选一项，或者休息</i>
      </div>
    </div>`}

    <div class="hp-path">
      ${steps.map((s, i) => {
        const isNext = next && s.id === next.id;
        const cls = s.done ? 'done' : isNext ? 'cur' : s.optional ? 'opt' : '';
        return `<a class="hp-step ${cls}" href="${s.href}">
          <span class="hp-line ${i === 0 ? 'first' : ''} ${i === steps.length - 1 ? 'last' : ''}"></span>
          <span class="hp-dot">${s.done ? '✓' : esc(s.icon)}</span>
          <span class="hp-txt"><b>${esc(s.label)}</b><i>${esc(s.sub)}</i></span>
          ${s.optional && !s.done ? '<span class="hp-opt">可选</span>' : ''}
        </a>`;
      }).join('')}
    </div>

    <div class="hp-more">
      <a href="#/plan"><b>计划</b><i>第几周该做什么</i></a>
      <a href="#/translate"><b>翻译</b><i>说一句，出日语</i></a>
      <a href="#/data"><b>数据</b><i>进度与设置</i></a>
    </div>

    <div class="tiny dim center" style="margin-top:16px">${dayKey()}</div>
  `;
}
