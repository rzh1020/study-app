import { esc, toast } from '../ui.js';
import { setTitle } from '../app.js';
import { metaGet, metaSet } from '../db.js';

/**
 * 12 周计划页。
 *
 * 设计原则：打开这一页时想知道的是「这周该做什么」，不是通读 12 周的说明书。
 * 所以只展开当前周，其余 11 周折叠成一行摘要。
 *
 * 用 <details>/<summary> 而不是自己写折叠逻辑：原生元素自带无障碍语义和键盘操作，
 * 代码量最小，而且 12 周全部渲染进 DOM（折叠 ≠ 不渲染），
 * 离线和搜索都不受影响。
 *
 * 之前页面上还渲染了学习者背景、时间预算、四条设计原则 —— 那些是我跟用户对话时
 * 的输入和设计说明，使用者不需要看，已从 data/plan.json 里删掉。
 */
export async function render(view) {
  setTitle('12 周计划');
  const plan = await fetch('./data/plan.json').then((r) => r.json());
  const startTs = await metaGet('planStart', 0);
  const doneWeeks = new Set((await metaGet('planDone', [])) || []);
  const total = plan.weeks.length;
  const rawWeek = startTs ? Math.floor((Date.now() - startTs) / (7 * 86400000)) + 1 : 0;
  const curWeek = Math.min(Math.max(rawWeek, 1), total);
  const started = !!startTs;

  const block = (label, color, focus, daily, target) => `
    <div class="plan-block" style="--bc:${color}">
      <div class="plan-block-hd"><span class="plan-block-tag">${esc(label)}</span>${esc(focus)}</div>
      <div class="plan-block-do">${esc(daily)}</div>
      ${target ? `<div class="plan-block-goal"><span>目标</span>${esc(target)}</div>` : ''}
    </div>`;

  const detail = (w) => `
    ${block('日语', 'var(--acc)', w.jp.focus, w.jp.daily, w.jp.target)}
    ${block('声乐', 'var(--purple)', w.voice.focus, w.voice.daily, w.voice.target)}
    ${block('练耳', 'var(--ok)', w.ear, '', '')}
    <div class="plan-gate">
      <div class="plan-gate-hd">过关判据 · 达到了才进下一周</div>
      ${w.gate.split(/\s*\+\s*/).map((g) => `<div class="plan-gate-item">${esc(g.trim())}</div>`).join('')}
    </div>`;

  const weekCard = (w) => {
    const done = doneWeeks.has(w.w);
    const isCur = started && w.w === curWeek;
    const state = done ? '<span class="pill ok">已过关</span>'
      : isCur ? '<span class="pill acc">本周</span>' : '';
    return `
    <details class="plan-week ${isCur ? 'cur' : ''} ${done ? 'done' : ''}" ${isCur ? 'open' : ''}>
      <summary>
        <span class="plan-wn">${w.w}</span>
        <span class="plan-sum">
          <span class="plan-sum-t">${esc(w.phase)} ${state}</span>
          <span class="plan-sum-b">${esc(w.brief || '')}</span>
        </span>
        <span class="plan-chev">›</span>
      </summary>
      <div class="plan-body">
        ${detail(w)}
        <label class="plan-check">
          <input type="checkbox" data-wk="${w.w}" ${done ? 'checked' : ''}>
          <span>第 ${w.w} 周过关了</span>
        </label>
      </div>
    </details>`;
  };

  const cur = plan.weeks.find((w) => w.w === curWeek) || plan.weeks[0];

  view.innerHTML = `
    ${started ? `
    <div class="card plan-hero">
      <div class="row spread">
        <div>
          <div class="plan-hero-w">第 ${curWeek} <span>/ ${total} 周</span></div>
          <div class="tiny dim">${esc(cur.phase)}</div>
        </div>
        <div class="center">
          <div class="plan-hero-n">${doneWeeks.size}</div>
          <div class="tiny dim">已过关</div>
        </div>
      </div>
      <div class="bar mt"><i style="width:${Math.round((curWeek / total) * 100)}%"></i></div>
      <div class="plan-dots">
        ${plan.weeks.map((w) => `<i class="${doneWeeks.has(w.w) ? 'ok' : w.w === curWeek ? 'cur' : ''}"
          title="第 ${w.w} 周"></i>`).join('')}
      </div>
    </div>` : `
    <div class="card">
      <h3>还没开始</h3>
      <div class="small muted mb">设定起始日后，这里会只展开当前周该做的事，其余周折叠起来。</div>
      <button class="btn btn-pri btn-block" id="btnStartPlan">把今天设为第 1 周第 1 天</button>
    </div>`}

    ${plan.weeks.map(weekCard).join('')}

    <details class="plan-week">
      <summary>
        <span class="plan-wn">→</span>
        <span class="plan-sum">
          <span class="plan-sum-t">${esc(plan.after.title)}</span>
          <span class="plan-sum-b">12 周之后往哪走</span>
        </span>
        <span class="plan-chev">›</span>
      </summary>
      <div class="plan-body">
        ${block('日语', 'var(--acc)', '', plan.after.jp.join('\n\n'), '')}
        ${block('声乐', 'var(--purple)', '', plan.after.voice.join('\n\n'), '')}
      </div>
    </details>

    ${started ? `<button class="btn btn-ghost btn-block" id="btnResetPlan"
      style="margin-top:14px">重设起始日为今天</button>` : ''}
  `;

  const startBtn = view.querySelector('#btnStartPlan');
  const resetBtn = view.querySelector('#btnResetPlan');
  const setToday = async () => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    await metaSet('planStart', d.getTime());
    render(view);
  };
  if (startBtn) startBtn.onclick = async () => { await setToday(); toast('已设为第 1 周'); };
  if (resetBtn) resetBtn.onclick = async () => {
    if (!confirm('把今天重设为第 1 周第 1 天？已勾选的过关记录会保留。')) return;
    await setToday();
    toast('已重设');
  };

  view.querySelectorAll('[data-wk]').forEach((cb) => {
    cb.onchange = async () => {
      const s = new Set((await metaGet('planDone', [])) || []);
      if (cb.checked) s.add(+cb.dataset.wk); else s.delete(+cb.dataset.wk);
      await metaSet('planDone', [...s]);
      // 只更新头部计数，不整页重渲染 —— 否则会把用户展开的其它周合回去
      const hero = view.querySelector('.plan-hero-n');
      if (hero) hero.textContent = String(s.size);
      const card = cb.closest('.plan-week');
      if (card) card.classList.toggle('done', cb.checked);
      const dots = view.querySelectorAll('.plan-dots i');
      if (dots.length) {
        dots.forEach((d, i) => {
          d.className = s.has(i + 1) ? 'ok' : i + 1 === curWeek ? 'cur' : '';
        });
      }
    };
  });
}
