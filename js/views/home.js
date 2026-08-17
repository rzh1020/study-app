import { esc } from '../ui.js';
import { setTitle } from '../app.js';
import { deckStats, getConfig, streak, todayReviewCount, DECKS } from '../store.js';
import { db, dayStart, dayKey } from '../db.js';

export async function render(view) {
  setTitle('今日');
  const [stats, cfg, st, revToday, earRows, voiceRows] = await Promise.all([
    deckStats(),
    getConfig(),
    streak(),
    todayReviewCount(),
    db.byIndex('earlog', 'ts', IDBKeyRange.lowerBound(dayStart())),
    db.byIndex('voice', 'ts', IDBKeyRange.lowerBound(dayStart())),
  ]);

  let jpDue = 0, jpNew = 0;
  for (const [d, s] of Object.entries(stats)) {
    if (!s.enabled || DECKS[d].group !== '日语') continue;
    jpDue += s.due; jpNew += s.newLeft;
  }
  const theory = stats.theory;
  const earDone = earRows.length;
  const earRight = earRows.filter((r) => r.correct).length;
  const voiceMin = Math.round(voiceRows.reduce((a, v) => a + (v.durationSec || 0), 0) / 60);

  const dow = new Date().getDay(); // 0=周日
  const isRegDay = dow === 0;
  const regRows = (await db.byIndex('voice', 'kind', IDBKeyRange.only('regression'))).sort((a, b) => b.ts - a.ts);
  const lastRegTs = regRows[0]?.ts || 0;
  const daysSinceReg = lastRegTs ? Math.floor((Date.now() - lastRegTs) / 86400000) : null;

  const task = (icon, title, sub, href, done) => `
    <a class="task ${done ? 'done' : ''}" href="${href}" style="text-decoration:none;color:inherit">
      <div class="tk-ic">${done ? '✓' : icon}</div>
      <div class="tk-main"><div class="tk-t">${esc(title)}</div><div class="tk-s">${esc(sub)}</div></div>
      <div class="dim">›</div>
    </a>`;

  view.innerHTML = `
    <div class="card">
      <div class="row spread">
        <div>
          <div class="streak">${st.days}<span style="font-size:14px;font-weight:400;color:var(--fg2)"> 天连续</span></div>
          <div class="tiny dim mt" style="margin-top:4px">${st.todayDone ? '今天已打卡' : '今天还没开始'}</div>
        </div>
        <div class="col" style="align-items:flex-end;gap:4px">
          <span class="pill ${revToday >= 30 ? 'ok' : ''}">复习 ${revToday}</span>
          <span class="pill ${earDone >= cfg.earDailyTarget ? 'ok' : ''}">练耳 ${earDone}/${cfg.earDailyTarget}</span>
          <span class="pill ${voiceMin >= cfg.voiceDailyMin ? 'ok' : ''}">练声 ${voiceMin}/${cfg.voiceDailyMin}分</span>
        </div>
      </div>
    </div>

    ${isRegDay || (daysSinceReg !== null && daysSinceReg >= 7) || daysSinceReg === null ? `
    <div class="card" style="border-color:rgba(163,123,255,.5);background:rgba(163,123,255,.08)">
      <h3 style="color:var(--purple)">${daysSinceReg === null ? '还没建立基线' : '该做回归了'}</h3>
      <div class="small muted mb">${daysSinceReg === null
        ? '先跑一次体检套件建立基线，之后每周同条件复测才有可比性。'
        : `上次回归是 ${daysSinceReg} 天前。固定素材、固定调、固定时段复测一次。`}</div>
      <a class="btn btn-pri btn-block" href="#/voice/regression">开始体检套件（约 6 分钟）</a>
    </div>` : ''}

    <div class="sec-title">碎片时间（不用出声）</div>
    <div class="card">
      ${task('語', '日语卡片', jpDue + jpNew > 0 ? `到期 ${jpDue} · 新卡 ${jpNew}` : '今天清空了', '#/jp', jpDue + jpNew === 0)}
      ${task('耳', '练耳', earDone ? `已做 ${earDone} 题 · 正确率 ${earDone ? Math.round((earRight / earDone) * 100) : 0}%` : `目标 ${cfg.earDailyTarget} 题`, '#/ear', earDone >= cfg.earDailyTarget)}
      ${task('理', '声乐/乐理科普', theory.due + theory.newLeft > 0 ? `到期 ${theory.due} · 新卡 ${theory.newLeft}` : '今天清空了', '#/review/theory', theory.due + theory.newLeft === 0)}
    </div>

    <div class="sec-title">需要出声（家里 15 分钟）</div>
    <div class="card">
      ${task('声', '引导练声', voiceMin ? `今天已练 ${voiceMin} 分钟` : '热身→气息→音阶→抠句', '#/voice/routine', voiceMin >= cfg.voiceDailyMin)}
      ${task('准', '音准实时反馈', '看着音分偏差唱，外部校正', '#/voice', false)}
    </div>

    <div class="card tight">
      <a href="#/plan" style="text-decoration:none;color:inherit" class="row spread">
        <div><div class="tk-t">12 周学习计划</div><div class="tk-s">每周做什么、判据是什么</div></div>
        <div class="dim">›</div>
      </a>
    </div>

    <div class="tiny dim center" style="margin-top:18px">${dayKey()} · 数据全部存在本机</div>
  `;
}
