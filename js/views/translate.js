import { $, esc, toast } from '../ui.js';
import { setTitle } from '../app.js';
import { asrStatus, asrStart, asrStop, speak, probeTts, ttsStop, isNative } from '../native.js';
import { load, translate, categories, phrasesOf } from '../translate.js';
import { importTSV } from '../store.js';
import { speakJa, stopJa, coverage, loadManifest, stats as jaStats } from '../jaspeech.js';

const DIRS = {
  cn2jp: { from: '中文', to: '日语', asrLang: 'zh-CN', ttsLang: 'ja-JP', ph: '中文，比如「这个多少钱」' },
  jp2cn: { from: '日语', to: '中文', asrLang: 'ja-JP', ttsLang: 'zh-CN', ph: '日语，汉字或假名都行' },
};

/**
 * 翻译页。
 *
 * 这一版的设计前提是「先确认哪条路真的能用，再决定界面怎么摆」，
 * 而不是把语音输入放在最显眼处然后让用户点了才发现不行。
 * 实测（小米 15 Ultra / HyperOS）：
 *   - 系统 TTS 只有小米引擎，**不支持日语**，中文可用
 *   - 系统 ASR 是小米引擎，代理录音被 AppOps 挡住，返回权限错误
 * 所以打字输入是唯一稳定通路，必须放主位；语音和朗读按实测能力决定是否呈现。
 */
export async function render(view) {
  setTitle('翻译', '<a class="pill" href="#/talk">面对面</a>');
  await load();

  let dir = 'cn2jp';
  let listening = false;
  let result = null;
  let lastInput = '';
  const asr = asrStatus();
  const tts = { 'ja-JP': null, 'zh-CN': null };   // null = 还没探测出结果
  const cats = categories();
  let curCat = cats[0] ? cats[0].id : '';
  await loadManifest();
  const ja = await jaStats();

  view.innerHTML = `
    <div class="card tr-dir">
      <div class="tr-side" id="sFrom"></div>
      <button class="tr-swap" id="btnSwap" title="互换">⇄</button>
      <div class="tr-side" id="sTo"></div>
    </div>

    <div class="card">
      <textarea id="trIn" rows="2" style="min-height:66px"></textarea>
      <div class="btn-row mt">
        <button class="btn btn-pri" id="btnGo">翻译</button>
        <button class="btn btn-ghost" id="btnMic" title="语音输入">🎤</button>
        <button class="btn btn-ghost" id="btnClear">清空</button>
      </div>
      <div class="tiny dim" id="micHint" style="margin-top:8px"></div>
    </div>

    <div id="trOut"></div>

    <div class="card">
      <h3>常用短语</h3>
      <div class="tr-cats" id="trCats"></div>
      <div id="trPhrases"></div>
    </div>

    <div class="card tight" id="capBox"></div>
  `;

  // ---------- 方向 ----------
  function drawDir() {
    $('#sFrom').textContent = DIRS[dir].from;
    $('#sTo').textContent = DIRS[dir].to;
    $('#trIn').placeholder = DIRS[dir].ph;
  }
  $('#btnSwap').onclick = () => {
    dir = dir === 'cn2jp' ? 'jp2cn' : 'cn2jp';
    drawDir();
    drawMicHint();
    if ($('#trIn').value.trim()) run();
  };

  // ---------- 语音输入 ----------
  function drawMicHint() {
    const btn = $('#btnMic');
    const hint = $('#micHint');
    if (!asr.available) {
      btn.disabled = true;
      hint.innerHTML = `语音输入不可用：${esc(asr.reason)}。打字翻译不受影响。`;
      return;
    }
    btn.disabled = false;
    btn.textContent = listening ? '■ 停止' : '🎤 说话';
    btn.classList.toggle('btn-bad', listening);
    hint.textContent = listening
      ? `正在听${DIRS[dir].from}…`
      : `点麦克风说${DIRS[dir].from}${asr.offline ? '（系统离线识别）' : ''}`;
  }

  $('#btnMic').onclick = () => {
    if (listening) { asrStop(); listening = false; drawMicHint(); return; }
    listening = true;
    drawMicHint();
    const ok = asrStart(DIRS[dir].asrLang, {
      onPartial: (t) => { $('#trIn').value = t; $('#micHint').textContent = '听到：' + t; },
      onResult: (t) => { listening = false; drawMicHint(); $('#trIn').value = t; run(); },
      onError: (e) => {
        listening = false;
        drawMicHint();
        // 识别失败时把提示留在页面上而不是一闪而过的 toast ——
        // 这类失败往往是系统侧的，用户需要看清原因才知道该不该重试
        $('#micHint').innerHTML = `<span style="color:var(--bad)">${esc(e)}</span>`;
      },
    });
    if (!ok) { listening = false; drawMicHint(); }
  };

  // ---------- 朗读 ----------
  /**
   * 朗读。日语走内置预渲染音频（系统没有日语引擎），中文走系统 TTS。
   * 预渲染分两级：整句音频（短语库命中，音质最好）→ 假名音节拼接（任意假名文本）。
   */
  async function doSpeak(text, lang, kana) {
    if (!text) return;
    stopJa();
    ttsStop();
    if (lang.startsWith('ja')) {
      // 分三层，按「又快又好」排序：
      //   1. 预渲染录音：短语库那 127 句有现成音频，瞬时播放且是完整录音
      //   2. 神经语音：任意句子都能读，但手机上一整句要 5-10 秒
      //   3. 音节拼接：一个假名一个假名拼，机械，只当最后兜底
      // 之前这里无条件走神经语音，结果连短语库的句子也要等合成 —— 是退步。
      if (coverage(text, kana) === 'phrase') {
        const how = await speakJa(text, kana, speak);
        if (how) { lastSpeakHow = how; return; }
      }
      try {
        const T = await import('../tts.js');
        T.stop();
        if (!T.available()) await T.load();
        if (T.available()) {
          const r = await T.speak(kana || text);
          if (!r.cancelled) { lastSpeakHow = 'neural'; return; }
          return;
        }
      } catch (e) {
        console.warn('神经语音不可用，退回音节拼接', e);
      }
      const how = await speakJa(text, kana, speak);
      if (how) { lastSpeakHow = how; return; }
      toast('这句读不出来：语音模型没加载成功，且系统没有日语引擎', 5000);
      return;
    }
    if (speak(text, lang)) return;
    tts[lang] = false;
    drawCaps();
    toast('这台设备没有中文语音，无法朗读', 4000);
  }
  let lastSpeakHow = '';

  // ---------- 能力说明 ----------
  function drawCaps() {
    const y = (v) => v === null ? '<span class="dim">检测中…</span>'
      : v ? '<span style="color:var(--ok)">可用</span>' : '<span style="color:var(--bad)">不可用</span>';
    $('#capBox').innerHTML = `
      <div class="tiny dim">本机能力（全部离线，App 不联网）</div>
      <div class="tr-cap">
        <span>打字翻译</span><span style="color:var(--ok)">可用</span>
        <span>朗读日语</span><span style="color:var(--ok)">内置语音</span>
        <span>朗读中文</span>${y(tts['zh-CN'])}
        <span>语音输入</span>${y(asr.available)}
      </div>
      <div class="tiny dim" style="margin-top:7px">
        日语朗读用的是 App 内置的预渲染语音（${ja.phrases} 条整句 + ${ja.mora} 个假名音节），
        不依赖系统语音引擎 —— 这台设备的系统引擎不支持日语。
      </div>
      ${!asr.available ? `<div class="tiny" style="color:var(--warn);margin-top:7px">${esc(asr.reason)}</div>` : ''}`;
  }

  // ---------- 翻译 ----------
  // ---------- 神经翻译（离线 NMT）----------
  // 模型 280MB 打包在 APK 里，加载约 1.3 秒。进页面后延迟预热，
  // 不挡住首屏；真要翻译时若还没好就等它。
  let nmt = null;
  let nmtWarm = null;
  async function nmtModule() {
    if (!nmt) nmt = await import('../nmt.js');
    return nmt;
  }
  async function nmtReady() {
    const N = await nmtModule();
    if (N.available()) return true;
    if (!nmtWarm) nmtWarm = N.load();
    return nmtWarm;
  }
  // 只有中→日有模型（Helsinki opus-mt-tc-big-zh-ja）。
  // 日→中暂时还是短语库，等把反向模型也量化进来再切。
  const nmtDir = () => dir === 'cn2jp';
  setTimeout(() => { if (nmtDir()) nmtReady().catch(() => {}); }, 800);
  // 语音模型（90MB）晚一点再预热：和翻译模型抢内存与 CPU 会让首屏更慢，
  // 而用户总是先看到译文、再点朗读。
  setTimeout(async () => {
    try {
      const T = await import('../tts.js');
      if (!T.available()) T.load();
    } catch { /* 没有语音模型时会退回音节拼接 */ }
  }, 2000);

  // 后台把译文的语音合成好。失败静默 —— 这只是把等待挪到用户读译文的时间里。
  async function prewarmSpeech(text, kana) {
    try {
      const T = await import('../tts.js');
      if (!T.available()) await T.load();
      if (T.available()) await T.prewarm(kana || text);
      const sp = $('#btnSpeak');
      if (sp && sp.dataset.label) sp.textContent = sp.dataset.label;
    } catch { /* 没有语音模型时会退回音节拼接 */ }
  }

  async function runNmt(text) {
    const N = await nmtModule();
    const ok = await nmtReady();
    if (!ok) throw new Error(N.state.error || '模型不可用');
    const r = await N.translate(text, { beams: 4 });
    let kana = '';
    try {
      const J = await import('../jaspeech.js');
      await J.loadDict();
      kana = J.toKana(r.text).kana;
    } catch { /* 没有假名也能显示，只是朗读会退化 */ }
    return { ok: true, level: 1, grade: 'high', label: '语义翻译', engine: 'nmt',
             text: r.text, kana, speakText: r.text, speakLang: 'ja-JP',
             note: `整句翻译，${r.ms}ms`, alts: r.alts || [] };
  }

  async function run() {
    const text = $('#trIn').value.trim();
    if (!text) { toast('先输入一句话'); return; }
    lastInput = text;
    if (nmtDir()) {
      const N = await nmtModule();
      if (!N.available()) {
        $('#trOut').innerHTML = '<div class="card"><div class="small muted">正在载入翻译模型…</div></div>';
      }
      try {
        result = await runNmt(text);
        drawOut();
        // 不自动朗读：神经语音在手机上合成一整句要 5-10 秒（比实时还慢），
        // 自动播等于让人干等。改成后台先合成好放进缓存，
        // 等用户看完译文点「朗读」时立刻出声。
        prewarmSpeech(result.text, result.kana);
        return;
      } catch (e) {
        // 模型出问题不能让页面变砖：退回短语库，并把原因如实说出来
        toast('神经翻译不可用，已退回短语库：' + e.message);
      }
    }
    result = translate(text, dir);
    drawOut();
    const lang = result.speakLang || DIRS[dir].ttsLang;
    if (result.ok && result.level === 1 && result.speakText
        && (lang.startsWith('ja') || tts[lang] === true)) {
      doSpeak(result.speakText, lang, result.kana);
    }
  }

  function drawOut() {
    const r = result;
    const out = $('#trOut');
    if (!r) { out.innerHTML = ''; return; }
    if (!r.ok) {
      out.innerHTML = `<div class="card">
        <span class="pill bad">${esc(r.label || '没有结果')}</span>
        <div class="small muted mt">${esc(r.note || '')}</div>
        ${r.near ? `<div class="small mt">最接近的收录句：<b>${esc(r.near)}</b></div>` : ''}
        ${(r.suggestions || []).map((x) => `<div class="tiny dim" style="padding:3px 0">· ${esc(x)}</div>`).join('')}
      </div>`;
      return;
    }
    const cls = r.grade === 'high' ? 'ok' : r.grade === 'mid' ? 'warn' : 'bad';
    const lang = r.speakLang || DIRS[dir].ttsLang;
    const cov = lang.startsWith('ja') ? coverage(r.text, r.kana) : (tts[lang] === false ? 'none' : 'system');
    const canSpeak = cov !== 'none';
    const covLabel = cov === 'phrase' ? '🔊 朗读' : cov === 'mora' ? '🔊 朗读（逐音节）' : '🔊 朗读';
    out.innerHTML = `<div class="card">
      <div class="row spread mb">
        <span class="pill ${cls}">${esc(r.label)}</span>
        <span class="tiny dim">${esc(lastInput)}</span>
      </div>
      <div class="tr-main">${esc(r.text)}</div>
      ${r.kana && r.kana !== r.text ? `<div class="tr-kana">${esc(r.kana)}</div>` : ''}
      ${r.romaji ? `<div class="tr-romaji">${esc(r.romaji)}</div>` : ''}
      <div class="tr-note ${cls}">${esc(r.note)}</div>
      ${r.level === 2 ? tokens(r) : ''}
      ${(r.alts && r.alts.length) ? `<div class="tr-alts">
        <div class="tiny dim">其他说法</div>
        ${r.alts.map((a) => `<div class="tr-alt">${esc(a)}</div>`).join('')}
      </div>` : ''}
      <div class="btn-row mt">
        ${canSpeak ? `<button class="btn btn-pri" id="btnSpeak">${covLabel}</button>`
          : '<button class="btn" disabled title="不在内置语音覆盖内">🔇 读不出</button>'}
        <button class="btn btn-ghost" id="btnSave">存为卡片</button>
      </div>
    </div>`;
    const sp = $('#btnSpeak');
    if (sp) {
      sp.dataset.label = sp.textContent;
      sp.onclick = async () => {
        // 若后台还没合成完，点下去会等几秒 —— 必须让按钮显示出「在做事」，
        // 否则看起来像没反应。
        sp.textContent = '⏳ 生成语音';
        sp.disabled = true;
        try {
          await doSpeak(r.speakText || r.text, lang, r.kana);
        } finally {
          sp.textContent = sp.dataset.label;
          sp.disabled = false;
        }
      };
    }
    $('#btnSave').onclick = () => saveCard(r);
  }

  function tokens(r) {
    return `<div class="tr-tokens">
      ${r.tokens.map((t) => t.hit
        ? `<span class="tr-tok"><b>${esc(dir === 'cn2jp' ? t.hit.jp : t.hit.cn)}</b><i>${esc(t.surface)}</i></span>`
        : `<span class="tr-tok miss"><b>?</b><i>${esc(t.surface)}</i></span>`).join('')}
      <div class="tiny dim" style="margin-top:6px;width:100%">命中 ${r.hitCount} · 未收录 ${r.missCount}</div>
    </div>`;
  }

  async function saveCard(r) {
    const jp = dir === 'cn2jp' ? r.text : lastInput;
    const cn = dir === 'cn2jp' ? lastInput : r.text;
    if (!jp || !cn) return toast('内容不完整');
    try {
      const res = await importTSV(`${jp}\t${cn}\t翻译页保存`, 'vocab_jp2cn');
      toast(res.added ? '已存入日语卡片' : '这句存过了');
    } catch (e) { toast('保存失败：' + e.message); }
  }

  $('#btnGo').onclick = run;
  $('#btnClear').onclick = () => { $('#trIn').value = ''; result = null; drawOut(); };
  $('#trIn').onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); run(); }
  };

  // ---------- 短语库 ----------
  function drawCats() {
    $('#trCats').innerHTML = cats.map((c) =>
      `<button class="tr-cat ${c.id === curCat ? 'on' : ''}" data-cat="${esc(c.id)}">${esc(c.cn)}</button>`).join('');
    $('#trCats').querySelectorAll('[data-cat]').forEach((b) => {
      b.onclick = () => { curCat = b.dataset.cat; drawCats(); drawPhrases(); };
    });
  }
  function showInline(el, p) {
    $('#trPhrases').querySelectorAll('.tr-ph-in').forEach((n) => n.remove());
    const d = document.createElement('div');
    d.className = 'tr-ph-in';
    d.innerHTML = `<b>${esc(p.jp)}</b>${p.kana ? `<i>${esc(p.kana)}</i>` : ''}`;
    el.appendChild(d);
  }

  function drawPhrases() {
    const list = phrasesOf(curCat);
    $('#trPhrases').innerHTML = list.map((p, i) => `
      <div class="tr-ph" data-ph="${i}">
        <div class="grow">
          <div class="tr-ph-cn">${esc(p.cn)}</div>
          <div class="tr-ph-jp">${esc(p.jp)}</div>
          <div class="tr-ph-rm">${esc(p.kana)} · ${esc(p.romaji)}</div>
        </div>
        <span class="tr-ph-play">🔊</span>
      </div>`).join('');
    $('#trPhrases').querySelectorAll('[data-ph]').forEach((el) => {
      el.onclick = () => {
        const p = list[+el.dataset.ph];
        lastInput = p.cn;
        dir = 'cn2jp';
        drawDir();
        result = {
          ok: true, level: 1, label: '短语库 · 精确匹配', grade: 'high',
          note: '预置短语，可以直接说', text: p.jp, kana: p.kana, romaji: p.romaji,
          speakText: p.jp, speakLang: 'ja-JP',
        };
        drawOut();
        // 不滚到上方结果区 —— 短语库在页面下部，跳上去会让人丢失位置。
        // 改成就地在这一条下面显示读音，结果区照样更新（滚上去能看到详情）。
        showInline(el, p);
        doSpeak(p.jp, 'ja-JP', p.kana);
      };
    });
  }

  drawDir();
  drawMicHint();
  drawCaps();
  drawCats();
  drawPhrases();

  // 异步探测真实 TTS 能力（原生侧 init 是异步的，早问会得到不可信的值）
  (async () => {
    tts['zh-CN'] = await probeTts('zh-CN');
    drawCaps();
    tts['ja-JP'] = await probeTts('ja-JP', 800);
    drawCaps();
    drawPhrases();
    if (result) drawOut();
  })();

  return { destroy() { asrStop(); ttsStop(); stopJa(); } };
}
