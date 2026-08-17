import { esc } from '../ui.js';
import { setTitle } from '../app.js';
import { deckStats, DECKS } from '../store.js';

export async function render(view) {
  setTitle('日语', '<a class="pill" href="#/data">设置</a>');
  const stats = await deckStats();
  const decks = Object.keys(DECKS).sort((a, b) => DECKS[a].order - DECKS[b].order);

  const totalDue = decks.filter((d) => stats[d].enabled && DECKS[d].group === '日语')
    .reduce((a, d) => a + stats[d].due + stats[d].newLeft, 0);

  const row = (d) => {
    const s = stats[d];
    const meta = DECKS[d];
    const pending = s.due + s.newLeft;
    const learned = s.total - s.new;
    const progress = s.total ? Math.round((learned / s.total) * 100) : 0;
    return `
    <div class="card">
      <div class="row spread mb">
        <div class="grow">
          <div class="row" style="gap:6px">
            <b>${esc(meta.name)}</b>
            ${!s.enabled ? '<span class="pill dim">已停用</span>' : ''}
            ${pending ? `<span class="pill acc">${pending}</span>` : '<span class="pill ok">✓</span>'}
          </div>
          <div class="tiny dim">${esc(meta.hint)}</div>
        </div>
        <a class="btn btn-sm ${pending ? 'btn-pri' : 'btn-ghost'}" href="#/review/${d}">${pending ? '学习' : '预习'}</a>
      </div>
      <div class="bar"><i style="width:${progress}%"></i></div>
      <div class="progress-mini" style="margin-top:6px">
        <span>已学 <b>${learned}</b>/${s.total}</span>
        <span>到期 <b>${s.due}</b></span>
        <span>新卡 <b>${s.newLeft}</b></span>
        <span>熟 <b>${s.mature}</b></span>
      </div>
    </div>`;
  };

  view.innerHTML = `
    ${totalDue ? `<a class="btn btn-pri btn-block mb" href="#/review/all">开始今日全部（${totalDue}）</a>`
      : '<div class="card center small muted">今天的日语卡都清空了。想多学可以进单个牌组预习。</div>'}
    <div class="sec-title">日语</div>
    ${decks.filter((d) => DECKS[d].group === '日语').map(row).join('')}
    <div class="sec-title">声乐</div>
    ${decks.filter((d) => DECKS[d].group === '声乐').map(row).join('')}
    <div class="card tight">
      <div class="tiny dim">牌组的每日新卡数、启用状态在「数据」页调整。想导入自己的词表（比如看动漫记下的台词）也在那里。</div>
    </div>
  `;
}
