import { $, esc, toast, lineChart, barChart, pct } from '../ui.js';
import { setTitle } from '../app.js';
import { db, metaSet } from '../db.js';
import { getConfig, setConfig, deckStats, reviewHistory, exportAll, importAll, importTSV, seed, DECKS } from '../store.js';
import { noteName } from '../pitch.js';
import { saveTextFile, pickTextFile, isNative } from '../native.js';

export async function render(view) {
  setTitle('数据');
  const [cfg, stats, hist, voiceRows, earRows] = await Promise.all([
    getConfig(), deckStats(), reviewHistory(30),
    db.all('voice'), db.all('earlog'),
  ]);

  const reg = voiceRows.filter((v) => v.kind === 'regression').sort((a, b) => a.ts - b.ts);
  const totalRev = hist.reduce((a, d) => a + d.total, 0);
  const matureRev = hist.reduce((a, d) => a + d.reviewed, 0);
  const matureAgain = hist.reduce((a, d) => a + d.again, 0);
  const ret30 = matureRev ? 1 - matureAgain / matureRev : null;
  const earAcc = earRows.length ? earRows.filter((r) => r.correct).length / earRows.length : null;
  const practiceMin = Math.round(voiceRows.reduce((a, v) => a + (v.durationSec || 0), 0) / 60);

  const cards = Object.entries(stats).reduce((a, [, s]) => a + s.total, 0);
  const learned = Object.entries(stats).reduce((a, [, s]) => a + (s.total - s.new), 0);

  view.innerHTML = `
    <div class="card">
      <h3>总览</h3>
      <div class="stat-grid mb">
        <div class="stat"><b>${learned}</b><span>已学卡片 /${cards}</span></div>
        <div class="stat"><b>${pct(ret30)}</b><span>30天保持率</span></div>
        <div class="stat"><b>${practiceMin}</b><span>练声分钟</span></div>
      </div>
      <div class="stat-grid">
        <div class="stat"><b>${totalRev}</b><span>30天复习次数</span></div>
        <div class="stat"><b>${pct(earAcc)}</b><span>练耳正确率</span></div>
        <div class="stat"><b>${reg.length}</b><span>回归次数</span></div>
      </div>
    </div>

    <div class="card">
      <h3>每日复习量（30 天）</h3>
      <canvas class="chart" id="cRev"></canvas>
    </div>

    <div class="card">
      <h3>记忆保持率</h3>
      <canvas class="chart" id="cRet"></canvas>
      <div class="tiny dim mt">绿虚线是目标保持率 ${Math.round(cfg.requestRetention * 100)}%。
      只统计已毕业卡片（初学阶段点「忘了」不计入，否则这条线没有参考价值）。
      长期明显低于目标 → 间隔排得太长；明显高于目标 → 复习过于频繁，可以调低目标省时间。
      已毕业复习 ${matureRev} 次 / 总复习 ${totalRev} 次。</div>
    </div>

    <div class="sec-title">声乐回归趋势</div>
    ${reg.length === 0 ? `<div class="card center small muted">还没有回归数据。<a href="#/voice/regression">先做一次体检套件</a>建立基线。</div>` : `
    <div class="card">
      <h3>音准（越低越好，单位音分）</h3>
      <canvas class="chart" id="cCents"></canvas>
      <div class="tiny dim mt">橙=五度音阶，蓝=固定曲目。绿虚线 20 音分 = 普通听众听不出跑调的门槛。</div>
    </div>
    <div class="card">
      <h3>最长发声（气息，秒）</h3>
      <canvas class="chart" id="cSus"></canvas>
      <div class="tiny dim mt">男性健康参考 20-30 秒。同音高同音量下上升说明支撑变好。</div>
    </div>
    <div class="card">
      <h3>音域（MIDI 音号）</h3>
      <canvas class="chart" id="cRange"></canvas>
      <div class="tiny dim mt">橙=最高音，蓝=最低音，每 1 格 = 1 个半音。</div>
    </div>
    <div class="card">
      <h3>历次记录</h3>
      <div style="overflow-x:auto">
      <table class="tbl">
        <thead><tr><th>日期</th><th class="num">音阶</th><th class="num">曲目</th><th class="num">气息</th><th>音域</th><th></th></tr></thead>
        <tbody>${reg.slice().reverse().map((r) => `
          <tr>
            <td>${new Date(r.ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}</td>
            <td class="num">${r.metrics.scaleCents ?? '-'}</td>
            <td class="num">${r.metrics.songCents ?? '-'}</td>
            <td class="num">${r.metrics.sustainSec ?? '-'}</td>
            <td>${r.metrics.rangeLow ? `${noteName(r.metrics.rangeLow)}–${noteName(r.metrics.rangeHigh)}` : '-'}</td>
            <td>${r.audio ? `<button class="btn btn-sm btn-ghost" data-play="${r.id}">▶</button>` : ''}</td>
          </tr>`).join('')}</tbody>
      </table></div>
      <audio id="player" controls style="width:100%;margin-top:10px;display:none"></audio>
    </div>`}

    <div class="sec-title">设置</div>
    <div class="card">
      <h3>每日新卡数</h3>
      <div class="tiny dim mb">复习量大约是新卡数的 8-12 倍。先从小开始，两周后看复习负载再调，
      一上来就 30 张会在第三周被复习债压垮。</div>
      ${Object.keys(DECKS).sort((a, b) => DECKS[a].order - DECKS[b].order).map((d) => `
        <div class="row spread" style="padding:7px 0;border-bottom:1px solid var(--line)">
          <label class="row grow" style="gap:8px;margin:0">
            <input type="checkbox" data-en="${d}" ${cfg.enabled[d] ? 'checked' : ''} style="width:auto">
            <span class="grow">${esc(DECKS[d].name)}</span>
          </label>
          <input type="number" min="0" max="60" value="${cfg.newPerDay[d] || 0}" data-np="${d}" style="width:72px;text-align:right">
        </div>`).join('')}
    </div>

    <div class="card">
      <label class="field"><span>目标保持率（越高复习越频繁；0.9 是效率最优点附近）</span>
        <input type="number" step="0.01" min="0.7" max="0.97" value="${cfg.requestRetention}" id="setRet"></label>
      <label class="field"><span>A4 基准频率（Hz，跟别的乐器合时才需要改）</span>
        <input type="number" step="1" min="392" max="466" value="${cfg.a4}" id="setA4"></label>
      <div class="row" style="gap:8px">
        <label class="field grow" style="margin:0"><span>练耳每日目标（题）</span>
          <input type="number" min="0" max="200" value="${cfg.earDailyTarget}" id="setEar"></label>
        <label class="field grow" style="margin:0"><span>练声每日目标（分钟）</span>
          <input type="number" min="0" max="120" value="${cfg.voiceDailyMin}" id="setVoice"></label>
      </div>
      <button class="btn btn-pri btn-block" id="btnSaveCfg">保存设置</button>
    </div>

    <div class="card">
      <h3>导入自己的词表</h3>
      <div class="tiny dim mb">每行「正面⇥背面」（Tab 分隔），第三列可选备注。
      看动漫时记下的台词、别处抄来的词表都能直接贴进来。以 # 开头的行会被忽略。</div>
      <label class="field"><span>导入到牌组</span>
        <select id="impDeck">${Object.keys(DECKS).map((d) => `<option value="${d}">${esc(DECKS[d].name)}</option>`).join('')}</select></label>
      <textarea id="impText" placeholder="やめて&#9;停下&#10;お前はもう死んでいる&#9;你已经死了"></textarea>
      <button class="btn btn-block mt" id="btnImpTSV">导入</button>
    </div>

    <div class="card">
      <h3>备份与恢复</h3>
      <div class="tiny dim mb">${isNative
        ? '数据存在 App 私有目录，卸载 App 会一并删除，所以定期导出到手机存储或网盘。'
        : '数据只存在这台手机的浏览器里，清除浏览器数据会全部丢失，所以定期导出。'}
      导出不含录音（体积太大），录音只在本机。</div>
      <div class="btn-row mb">
        <button class="btn btn-sm" id="btnExport">导出 JSON</button>
        <button class="btn btn-sm" id="btnImport">导入 JSON</button>
      </div>
      <div class="btn-row">
        <button class="btn btn-sm btn-ghost" id="btnReseed">重新种卡</button>
        <button class="btn btn-sm btn-bad" id="btnReset">清空全部数据</button>
      </div>
      <div class="tiny dim mt">「重新种卡」用于 data/*.json 更新后补进新内容，不会动已有卡的记忆状态。</div>
    </div>
  `;

  // ---- 图表 ----
  // 抽成函数是为了让 resize 钩子能重画：canvas 尺寸是按 clientWidth×DPR 定的，
  // 平板旋转后不重画会被拉伸模糊。
  function drawCharts() {
  const days = hist.map((d) => ({ label: d.day.slice(5), v: d.total }));
  barChart($('#cRev'), days);
  lineChart($('#cRet'), hist.map((d) => ({ label: d.day.slice(5), v: d.retention })),
    { min: 0.5, max: 1, target: cfg.requestRetention, fmtY: (v) => Math.round(v * 100) + '%' });

  if (reg.length) {
    const lbl = reg.map((r) => new Date(r.ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }));
    drawTwo($('#cCents'),
      reg.map((r, i) => ({ label: lbl[i], v: r.metrics.scaleCents })),
      reg.map((r, i) => ({ label: lbl[i], v: r.metrics.songCents })),
      { min: 0, target: 20, fmtY: (v) => v.toFixed(0) });
    lineChart($('#cSus'), reg.map((r, i) => ({ label: lbl[i], v: r.metrics.sustainSec })),
      { min: 0, target: 20, color: '#3ecf8e', fmtY: (v) => v.toFixed(0) });
    drawTwo($('#cRange'),
      reg.map((r, i) => ({ label: lbl[i], v: r.metrics.rangeHigh })),
      reg.map((r, i) => ({ label: lbl[i], v: r.metrics.rangeLow })),
      { fmtY: (v) => noteName(Math.round(v)) });

  }
  }
  drawCharts();

  if (reg.length) {
    view.querySelectorAll('[data-play]').forEach((b) => {
      b.onclick = async () => {
        const row = await db.get('voice', +b.dataset.play);
        if (!row || !row.audio) return toast('没有录音');
        const p = $('#player');
        p.src = URL.createObjectURL(row.audio);
        p.style.display = '';
        p.play();
      };
    });
  }

  /** 两条线叠在一张图上：lineChart 每次会清空画布，所以第二条画到离屏 canvas 再合成 */
  function drawTwo(canvas, sHigh, sLow, opt) {
    const all = [...sHigh, ...sLow].map((x) => x.v).filter((v) => v !== null && v !== undefined && !Number.isNaN(v));
    if (!all.length) { lineChart(canvas, sHigh, { ...opt, emptyText: '数据不足' }); return; }
    const min = opt.min ?? Math.min(...all) - 2;
    const max = opt.max ?? Math.max(...all) + 2;
    lineChart(canvas, sHigh, { ...opt, min, max, color: '#f2b23e' });
    const tmp = document.createElement('canvas');
    tmp.style.width = canvas.clientWidth + 'px';
    tmp.style.height = canvas.clientHeight + 'px';
    tmp.width = canvas.width; tmp.height = canvas.height;
    tmp.style.position = 'fixed'; tmp.style.left = '-9999px';
    document.body.appendChild(tmp);
    lineChart(tmp, sLow, { ...opt, min, max, color: '#5b8cff', fmtY: () => '' });
    canvas.getContext('2d').drawImage(tmp, 0, 0, canvas.width, canvas.height);
    tmp.remove();
  }

  // ---- 设置交互 ----
  $('#btnSaveCfg').onclick = async () => {
    const newPerDay = {}, enabled = {};
    view.querySelectorAll('[data-np]').forEach((i) => (newPerDay[i.dataset.np] = Math.max(0, +i.value || 0)));
    view.querySelectorAll('[data-en]').forEach((i) => (enabled[i.dataset.en] = i.checked));
    const ret = Math.min(Math.max(+$('#setRet').value || 0.9, 0.7), 0.97);
    await setConfig({
      newPerDay, enabled, requestRetention: ret,
      a4: Math.min(Math.max(+$('#setA4').value || 440, 392), 466),
      earDailyTarget: Math.max(0, +$('#setEar').value || 0),
      voiceDailyMin: Math.max(0, +$('#setVoice').value || 0),
    });
    toast('已保存');
    setTimeout(() => location.reload(), 500);
  };

  $('#btnImpTSV').onclick = async () => {
    const text = $('#impText').value;
    if (!text.trim()) return toast('先粘贴内容');
    try {
      const r = await importTSV(text, $('#impDeck').value);
      toast(`导入 ${r.added} 条，跳过 ${r.skipped} 条`);
      $('#impText').value = '';
    } catch (e) { toast('导入失败：' + e.message); }
  };

  $('#btnExport').onclick = async () => {
    const btn = $('#btnExport');
    btn.disabled = true;
    try {
      const data = await exportAll();
      const name = `study-backup-${new Date().toISOString().slice(0, 10)}.json`;
      await saveTextFile(name, JSON.stringify(data));
      toast('已导出 ' + name);
    } catch (err) {
      toast('导出失败：' + err.message, 4000);
    } finally {
      btn.disabled = false;
    }
  };

  $('#btnImport').onclick = async () => {
    try {
      const text = await pickTextFile('.json');
      const r = await importAll(JSON.parse(text), { merge: true });
      toast('已导入：' + JSON.stringify(r));
      setTimeout(() => location.reload(), 900);
    } catch (err) {
      if (!/已取消|未选择/.test(err.message)) toast('导入失败：' + err.message, 4000);
    }
  };

  $('#btnReseed').onclick = async () => {
    const r = await seed();
    toast(`新增 ${r.added}，更新 ${r.updated}`);
  };

  $('#btnReset').onclick = async () => {
    if (!confirm('清空全部卡片、复习记录、练耳与练声数据？此操作不可撤销。建议先导出备份。')) return;
    if (!confirm('再确认一次：真的要清空吗？')) return;
    await Promise.all([db.clear('cards'), db.clear('reviews'), db.clear('earlog'), db.clear('voice'), db.clear('meta')]);
    await metaSet('config', {});
    toast('已清空，重新载入…');
    setTimeout(() => location.reload(), 700);
  };

  return { resize: drawCharts };
}
