import { esc, toast } from '../ui.js';
import { setTitle } from '../app.js';
import { metaGet, metaSet } from '../db.js';

export async function render(view) {
  setTitle('12 周计划', '<a class="pill" href="#/home">今日</a>');
  const plan = await fetch('./data/plan.json').then((r) => r.json());
  const startTs = await metaGet('planStart', 0);
  const curWeek = startTs ? Math.min(Math.floor((Date.now() - startTs) / (7 * 86400000)) + 1, 13) : 0;
  const doneWeeks = new Set((await metaGet('planDone', [])) || []);

  view.innerHTML = `
    <div class="card">
      <div class="small muted mb">${esc(plan.meta.premise)}</div>
      <div class="kv"><span>时间预算</span></div>
      <div class="tiny dim" style="padding:6px 0">${esc(plan.meta.budget)}</div>
      ${startTs
        ? `<div class="row spread mt"><span class="pill acc">进行到第 ${curWeek > 12 ? '12+' : curWeek} 周</span>
           <button class="btn btn-sm btn-ghost" id="btnResetPlan">重设起始日</button></div>`
        : `<button class="btn btn-pri btn-block mt" id="btnStartPlan">把今天设为第 1 周第 1 天</button>`}
    </div>

    <div class="card">
      <h3>四条原则</h3>
      ${plan.meta.principle.map((p, i) => `<div class="step"><div class="sn">${i + 1}</div><div class="grow"><div class="sd" style="color:var(--fg2)">${esc(p)}</div></div></div>`).join('')}
    </div>

    ${plan.weeks.map((w) => {
      const isCur = w.w === curWeek;
      const done = doneWeeks.has(w.w);
      return `
      <div class="card" style="${isCur ? 'border-color:var(--acc)' : ''}">
        <div class="row spread mb">
          <div class="row" style="gap:7px">
            <b>第 ${w.w} 周</b>
            <span class="pill ${done ? 'ok' : isCur ? 'acc' : ''}">${esc(w.phase)}</span>
          </div>
          <label class="row tiny dim" style="gap:5px;margin:0">
            <input type="checkbox" data-wk="${w.w}" ${done ? 'checked' : ''} style="width:auto"> 过关
          </label>
        </div>
        <div style="border-left:2px solid var(--acc);padding-left:10px;margin-bottom:10px">
          <div class="small"><b>日语</b> · ${esc(w.jp.focus)}</div>
          <div class="tiny dim">${esc(w.jp.daily)}</div>
          <div class="tiny" style="color:var(--fg2);margin-top:3px">目标：${esc(w.jp.target)}</div>
        </div>
        <div style="border-left:2px solid var(--purple);padding-left:10px;margin-bottom:10px">
          <div class="small"><b>声乐</b> · ${esc(w.voice.focus)}</div>
          <div class="tiny dim">${esc(w.voice.daily)}</div>
          <div class="tiny" style="color:var(--fg2);margin-top:3px">目标：${esc(w.voice.target)}</div>
        </div>
        <div class="tiny dim mb">练耳：${esc(w.ear)}</div>
        <div class="pill ${done ? 'ok' : 'warn'}" style="white-space:normal;text-align:left;line-height:1.4">
          过关判据：${esc(w.gate)}
        </div>
      </div>`;
    }).join('')}

    <div class="card">
      <h3>${esc(plan.after.title)}</h3>
      <div class="sec-title" style="margin-top:4px">日语</div>
      ${plan.after.jp.map((x) => `<div class="tiny dim" style="padding:4px 0">· ${esc(x)}</div>`).join('')}
      <div class="sec-title">声乐</div>
      ${plan.after.voice.map((x) => `<div class="tiny dim" style="padding:4px 0">· ${esc(x)}</div>`).join('')}
    </div>
  `;

  const startBtn = view.querySelector('#btnStartPlan');
  if (startBtn) startBtn.onclick = async () => {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    await metaSet('planStart', d.getTime());
    toast('已设为第 1 周');
    location.reload();
  };
  const resetBtn = view.querySelector('#btnResetPlan');
  if (resetBtn) resetBtn.onclick = async () => {
    if (!confirm('重设起始日为今天？')) return;
    const d = new Date(); d.setHours(0, 0, 0, 0);
    await metaSet('planStart', d.getTime());
    location.reload();
  };

  view.querySelectorAll('[data-wk]').forEach((cb) => {
    cb.onchange = async () => {
      const w = +cb.dataset.wk;
      const s = new Set((await metaGet('planDone', [])) || []);
      if (cb.checked) s.add(w); else s.delete(w);
      await metaSet('planDone', [...s]);
    };
  });
}
