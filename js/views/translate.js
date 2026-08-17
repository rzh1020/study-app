import { $, esc, toast } from '../ui.js';
import { setTitle } from '../app.js';
import { asrStatus, asrStart, asrStop, speak, ttsHasVoice, ttsStop, isNative } from '../native.js';
import { load, translate, categories, phrasesOf } from '../translate.js';
import { importTSV } from '../store.js';

const DIRS = {
  cn2jp: { from: '中文', to: '日语', asrLang: 'zh-CN', ttsLang: 'ja-JP', ph: '说中文或在这里输入' },
  jp2cn: { from: '日语', to: '中文', asrLang: 'ja-JP', ttsLang: 'zh-CN', ph: '说日语或输入日语（汉字/假名都行）' },
};

export async function render(view) {
  setTitle('翻译');
  await load();

  let dir = 'cn2jp';
  let listening = false;
  let result = null;
  let lastInput = '';

  const asr = asrStatus();
  const cats = categories();
  let curCat = cats[0] ? cats[0].id : '';

  view.innerHTML = `
    <div class="card tr-dir">
      <button class="tr-side" id="sFrom"></button>
      <button class="tr-swap" id="btnSwap" title="互换方向">⇄</button>
      <button class="tr-side" id="sTo"></button>
    </div>

    <div class="card">
      <div id="asrBox"></div>
      <textarea id="trIn" rows="2" style="min-height:64px"></textarea>
      <div class="btn-row mt">
        <button class="btn btn-pri" id="btnGo">翻译</button>
        <button class="btn btn-ghost" id="btnClear">清空</button>
      </div>
    </div>

    <div id="trOut"></div>

    <div class="card">
      <h3>常用短语</h3>
      <div class="tiny dim mb">旅游时这里比语音识别更快更可靠。点一下就朗读。</div>
      <div class="tr-cats" id="trCats"></div>
      <div id="trPhrases"></div>
    </div>

    <div class="card tight">
      <div class="tiny dim">完全离线：短语库和词库都在本机，不联网。
      因此不做通用机翻 —— 结果会标出是「短语库」还是「逐词查询」，后者只能当参考。</div>
    </div>
  `;

  // ---- 方向 ----
  function drawDir() {
    const d = DIRS[dir];
    $('#sFrom').textContent = d.from;
    $('#sTo').textContent = d.to;
    $('#trIn').placeholder = d.ph;
  }
  $('#btnSwap').onclick = () => {
    dir = dir === 'cn2jp' ? 'jp2cn' : 'cn2jp';
    drawDir();
    drawAsr();
    if ($('#trIn').value.trim()) run();
  };

  // ---- 语音识别区 ----
  function drawAsr() {
    const box = $('#asrBox');
    if (!asr.available) {
      box.innerHTML = `
        <div class="tr-warn">
          <b>语音输入不可用</b>
          <div class="tiny dim" style="margin-top:3px">${esc(asr.reason)}${
            isNative ? '' : '（装成 APK 后用系统离线识别）'}<br>下面可以直接打字翻译。</div>
        </div>`;
      return;
    }
    box.innerHTML = `
      <button class="tr-mic ${listening ? 'on' : ''}" id="btnMic">
        <span class="tr-mic-ic">${listening ? '■' : '🎤'}</span>
        <span class="tr-mic-t">${listening ? '正在听… 点击结束' : `按一下，说${DIRS[dir].from}`}</span>
      </button>
      <div class="tiny dim center" id="asrHint" style="margin:6px 0 10px">${
        asr.offline ? '优先使用系统离线识别' : esc(asr.reason)}</div>`;
    $('#btnMic').onclick = toggleMic;
  }

  function toggleMic() {
    if (listening) { asrStop(); listening = false; drawAsr(); return; }
    listening = true;
    drawAsr();
    const ok = asrStart(DIRS[dir].asrLang, {
      onPartial: (t) => { $('#trIn').value = t; const h = $('#asrHint'); if (h) h.textContent = '听到：' + t; },
      onResult: (t) => {
        listening = false;
        drawAsr();
        $('#trIn').value = t;
        run();
      },
      onError: (e) => {
        listening = false;
        drawAsr();
        toast('识别失败：' + e, 4000);
      },
    });
    if (!ok) { listening = false; drawAsr(); }
  }

  // ---- 翻译 ----
  function run() {
    const text = $('#trIn').value.trim();
    if (!text) { toast('先输入或说一句话'); return; }
    lastInput = text;
    result = translate(text, dir);
    drawOut();
    // 短语库命中时自动朗读：旅游场景下这一步是刚需，省一次点击
    if (result.ok && result.level === 1 && result.speakText) doSpeak(result.speakText, result.speakLang);
  }

  function doSpeak(text, lang) {
    ttsStop();
    if (!speak(text, lang)) {
      toast(ttsHasVoice(lang)
        ? '朗读失败，再试一次'
        : `系统缺少${lang.startsWith('ja') ? '日语' : '中文'}语音包：设置 → 语言和输入法 → 文字转语音 → 安装语音数据`, 6000);
    }
  }

  function drawOut() {
    const r = result;
    const out = $('#trOut');
    if (!r) { out.innerHTML = ''; return; }
    if (!r.ok) {
      out.innerHTML = `
        <div class="card">
          <span class="pill bad">${esc(r.label || '没有结果')}</span>
          <div class="small muted mt">${esc(r.note || '')}</div>
          ${r.near ? `<div class="small mt">最接近的收录句：<b>${esc(r.near)}</b></div>` : ''}
          ${r.suggestions ? `<div class="mt">${r.suggestions.map((x) =>
            `<div class="tiny dim" style="padding:3px 0">· ${esc(x)}</div>`).join('')}</div>` : ''}
        </div>`;
      return;
    }
    const gradeCls = r.grade === 'high' ? 'ok' : r.grade === 'mid' ? 'warn' : 'bad';
    out.innerHTML = `
      <div class="card">
        <div class="row spread mb">
          <span class="pill ${gradeCls}">${esc(r.label)}</span>
          <span class="tiny dim">${esc(lastInput)}</span>
        </div>
        <div class="tr-main">${esc(r.text)}</div>
        ${r.kana && r.kana !== r.text ? `<div class="tr-kana">${esc(r.kana)}</div>` : ''}
        ${r.romaji ? `<div class="tr-romaji">${esc(r.romaji)}</div>` : ''}
        <div class="tr-note ${gradeCls}">${esc(r.note)}</div>
        ${r.level === 2 ? tokenTable(r) : ''}
        <div class="btn-row mt">
          <button class="btn btn-pri" id="btnSpeak">🔊 朗读</button>
          <button class="btn btn-ghost" id="btnSave">存为卡片</button>
        </div>
      </div>`;
    $('#btnSpeak').onclick = () => doSpeak(r.speakText || r.text, r.speakLang || DIRS[dir].ttsLang);
    $('#btnSave').onclick = () => saveCard(r);
  }

  function tokenTable(r) {
    return `<div class="tr-tokens">
      ${r.tokens.map((t) => t.hit
        ? `<span class="tr-tok"><b>${esc(dir === 'cn2jp' ? t.hit.jp : t.hit.cn)}</b><i>${esc(t.surface)}</i></span>`
        : `<span class="tr-tok miss"><b>?</b><i>${esc(t.surface)}</i></span>`).join('')}
      <div class="tiny dim" style="margin-top:6px">命中 ${r.hitCount} / 未收录 ${r.missCount}</div>
    </div>`;
  }

  async function saveCard(r) {
    const jp = dir === 'cn2jp' ? r.text : lastInput;
    const cn = dir === 'cn2jp' ? lastInput : r.text;
    if (!jp || !cn) return toast('内容不完整，存不了');
    try {
      const res = await importTSV(`${jp}\t${cn}\t翻译页保存`, 'vocab_jp2cn');
      toast(res.added ? '已存入日语卡片，之后会出现在复习里' : '这句已经存过了');
    } catch (e) {
      toast('保存失败：' + e.message);
    }
  }

  $('#btnGo').onclick = run;
  $('#btnClear').onclick = () => { $('#trIn').value = ''; result = null; drawOut(); };
  $('#trIn').onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); run(); }
  };

  // ---- 短语库 ----
  function drawCats() {
    $('#trCats').innerHTML = cats.map((c) =>
      `<button class="tr-cat ${c.id === curCat ? 'on' : ''}" data-cat="${esc(c.id)}">${esc(c.cn)}</button>`).join('');
    $('#trCats').querySelectorAll('[data-cat]').forEach((b) => {
      b.onclick = () => { curCat = b.dataset.cat; drawCats(); drawPhrases(); };
    });
  }
  function drawPhrases() {
    const list = phrasesOf(curCat);
    $('#trPhrases').innerHTML = list.map((p, i) => `
      <div class="tr-ph" data-ph="${i}">
        <div class="grow">
          <div class="tr-ph-cn">${esc(p.cn)}</div>
          <div class="tr-ph-jp">${esc(p.jp)}</div>
          <div class="tr-ph-rm">${esc(p.romaji)}</div>
        </div>
        <span class="tr-ph-play">🔊</span>
      </div>`).join('');
    $('#trPhrases').querySelectorAll('[data-ph]').forEach((el) => {
      el.onclick = () => {
        const p = list[+el.dataset.ph];
        doSpeak(p.jp, 'ja-JP');
        // 点短语也把它送进结果区，方便看假名和存卡片
        lastInput = p.cn;
        dir = 'cn2jp';
        drawDir();
        result = {
          ok: true, level: 1, source: 'phrase', label: '短语库 · 精确匹配', grade: 'high',
          note: '预置短语，可以直接说', text: p.jp, kana: p.kana, romaji: p.romaji,
          speakText: p.jp, speakLang: 'ja-JP',
        };
        drawOut();
      };
    });
  }

  drawDir();
  drawAsr();
  drawCats();
  drawPhrases();

  return {
    destroy() {
      asrStop();
      ttsStop();
    },
  };
}
