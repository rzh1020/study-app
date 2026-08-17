import { $, esc, toast, fmtInterval } from '../ui.js';
import { setTitle } from '../app.js';
import { getQueue, reviewCard, previewFor, getConfig, DECKS } from '../store.js';
import { STATE } from '../fsrs.js';

// ---- 日语朗读。系统没装日语语音时静默降级，不报错打断复习。----
let jaVoice = null;
let voicesReady = false;
function pickVoice() {
  if (!('speechSynthesis' in window)) return null;
  const vs = speechSynthesis.getVoices();
  if (!vs.length) return null;
  voicesReady = true;
  jaVoice = vs.find((v) => /^ja(-|_)?/i.test(v.lang)) || null;
  return jaVoice;
}
if ('speechSynthesis' in window) {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
}
function speak(text) {
  if (!('speechSynthesis' in window) || !text) return false;
  if (!voicesReady) pickVoice();
  if (!jaVoice) return false;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.voice = jaVoice;
  u.lang = jaVoice.lang;
  u.rate = 0.9;
  speechSynthesis.speak(u);
  return true;
}

const SPEAKABLE = new Set(['kana_hira', 'kana_kata', 'vocab_jp2cn', 'vocab_cn2jp', 'grammar']);

function frontHTML(c) {
  const d = c.deck;
  if (d === 'kana_hira' || d === 'kana_kata') {
    return `<div class="q-front kana">${esc(c.front)}</div><div class="q-sub">读音？</div>`;
  }
  if (d === 'kana_rule') {
    return `<div class="q-front big">${esc(c.front)}</div><div class="q-sub">这条规则的内容是什么？</div>`;
  }
  if (d === 'vocab_jp2cn') {
    return `<div class="q-front big">${esc(c.front)}</div><div class="q-sub">读音 + 意思？</div>`;
  }
  if (d === 'vocab_cn2jp') {
    return `<div class="q-front">${esc(c.front)}</div><div class="q-sub">${esc(c.extra?.pos || '')} · 日语怎么说？</div>`;
  }
  if (d === 'grammar') {
    return `<div class="q-front big">${esc(c.front)}</div>
      <div class="q-sub" style="font-size:15px;color:var(--acc)">${esc(c.extra?.pattern || '')}</div>
      <div class="q-sub">什么意思、怎么用？</div>`;
  }
  return `<div class="q-front" style="font-size:20px;line-height:1.5">${esc(c.front)}</div>`;
}

/**
 * 记忆钩子。分「音」「训」两类显示，因为两类的记忆策略完全不同：
 * 音读词能从汉语推出读音（配合音读规律牌组），训读词只能靠词族和例句。
 * 明确标出类型，可以让人不在训读词上浪费时间找汉语线索。
 */
function hookHTML(e) {
  if (!e || !e.hook) return '';
  const tag = e.read === '音' ? '音读·可从汉语推'
    : e.read === '训' ? '训读·与汉语无关'
    : e.read ? `${e.read}读` : '记忆钩子';
  const cls = e.read === '音' ? 'on' : e.read === '训' ? 'kun' : '';
  return `<div class="hook ${cls}"><span class="hook-tag">${esc(tag)}</span>
    <div class="hook-body">${esc(e.hook)}</div></div>`;
}

function backHTML(c) {
  const d = c.deck;
  const e = c.extra || {};
  if (d === 'kana_hira' || d === 'kana_kata') {
    const src = d === 'kana_hira' ? e.srcHira : e.srcKata;
    return `<div class="q-answer kana">${esc(c.back)}</div>
      <div class="q-sub">${d === 'kana_hira' ? '片假名' : '平假名'} ${esc(d === 'kana_hira' ? e.kata : e.hira)} · ${esc(e.group || '')}</div>
      ${src ? `<div class="hook"><span class="hook-tag">字源</span>
        <b style="font-size:22px">${esc(src)}</b>
        <div class="hook-body">${esc(e.hook || '')}</div></div>` : ''}`;
  }
  if (d === 'kana_rule' || d === 'theory') {
    return `<div class="q-note" style="font-size:14.5px;color:var(--fg)">${esc(c.back)}</div>`;
  }
  if (d === 'vocab_jp2cn') {
    return `<div class="q-answer kana" style="font-size:30px">${esc(e.kana || '')}</div>
      <div class="q-sub">${esc(e.romaji || '')}${e.pitch ? ` · 声调 ${esc(e.pitch)}` : ''}</div>
      <div class="q-answer" style="font-size:22px;margin-top:8px">${esc(c.back)}</div>
      <div class="q-sub">${esc(e.pos || '')}${e.vclass ? ` · ${esc(e.vclass)}` : ''}${e.rank ? ` · 高频第 ${e.rank}` : ''}</div>
      ${hookHTML(e)}
      ${e.exJp ? `<div class="q-ex"><div class="jp">${esc(e.exJp)}</div><div class="cn">${esc(e.exCn)}</div></div>` : ''}`;
  }
  if (d === 'vocab_cn2jp') {
    return `<div class="q-answer">${esc(c.back)}</div>
      <div class="q-sub kana" style="font-size:20px">${esc(e.kana || '')} · ${esc(e.romaji || '')}</div>
      ${hookHTML(e)}
      ${e.exJp ? `<div class="q-ex"><div class="jp">${esc(e.exJp)}</div><div class="cn">${esc(e.exCn)}</div></div>` : ''}`;
  }
  if (d === 'grammar') {
    const ex = (e.ex || []).map(([j, cn]) => `<div class="q-ex"><div class="jp">${esc(j)}</div><div class="cn">${esc(cn)}</div></div>`).join('');
    return `<div class="q-note" style="font-size:14.5px;color:var(--fg)">${esc(c.back)}</div>
      ${ex}${e.note ? `<div class="q-note" style="margin-top:12px;border-top:1px solid var(--line);padding-top:9px">💡 ${esc(e.note)}</div>` : ''}`;
  }
  return `<div class="q-answer" style="font-size:18px">${esc(c.back)}</div>`;
}

function speakText(c) {
  const e = c.extra || {};
  if (c.deck === 'kana_hira' || c.deck === 'kana_kata') return c.front;
  if (c.deck === 'vocab_jp2cn') return e.exJp || c.front;
  if (c.deck === 'vocab_cn2jp') return e.exJp || c.back;
  if (c.deck === 'grammar') return (e.ex && e.ex[0] && e.ex[0][0]) || '';
  return '';
}

export async function render(view, { args }) {
  const deck = args[0] === 'all' || !args[0] ? null : args[0];
  const cfg = await getConfig();
  const { queue, counts } = await getQueue(deck);
  setTitle(deck ? DECKS[deck]?.name || '复习' : '今日全部', '<a class="pill" href="#/jp">牌组</a>');

  if (!queue.length) {
    view.innerHTML = `
      <div class="card center">
        <div style="font-size:38px">✓</div>
        <h3 style="margin-top:8px">这个牌组今天清空了</h3>
        <div class="small muted mb">FSRS 已经把下一次复习排到最省时间的时间点。提前刷会降低记忆增益。</div>
        <a class="btn btn-block" href="#/jp">回牌组列表</a>
      </div>`;
    return {};
  }

  let idx = 0;
  let revealed = false;
  const total = queue.length;
  let doneCount = 0;
  const again = [];

  view.innerHTML = `
    <div class="row spread mb">
      <div class="progress-mini">
        <span>剩 <b id="rLeft">${total}</b></span>
        <span>新 <b>${counts.new}</b></span>
        <span>到期 <b>${counts.review + counts.learn}</b></span>
      </div>
      <button class="btn-sm btn-ghost" id="btnSpeak" title="朗读">🔊</button>
    </div>
    <div class="bar mb"><i id="rBar" style="width:0%"></i></div>
    <div class="qcard" id="qcard"></div>
    <div id="ctrl"></div>
    <div class="tiny dim center" style="margin-top:14px" id="hint"></div>
  `;

  const qcard = $('#qcard');
  const ctrl = $('#ctrl');

  function currentCard() { return queue[idx]; }

  function draw() {
    const c = currentCard();
    if (!c) return finish();
    const stateLabel = c.state === STATE.NEW ? '新卡'
      : c.state === STATE.RELEARNING ? '重学'
      : c.state === STATE.LEARNING ? '学习中'
      : `第 ${c.reps + 1} 次 · 上次间隔 ${c.scheduledDays}天`;

    qcard.innerHTML = `<div class="q-sub" style="align-self:flex-start;position:absolute" hidden></div>${frontHTML(c)}
      ${revealed ? `<div class="q-back">${backHTML(c)}</div>` : ''}`;

    $('#btnSpeak').classList.toggle('hidden', !SPEAKABLE.has(c.deck));

    if (!revealed) {
      ctrl.innerHTML = `<button class="btn btn-pri btn-block" id="btnShow">显示答案</button>`;
      $('#btnShow').onclick = reveal;
      $('#hint').textContent = `${stateLabel} · 先在心里给出答案再翻面，否则这次复习基本无效`;
    } else {
      const p = previewFor(c, Date.now(), cfg);
      ctrl.innerHTML = `
        <div class="grade-row">
          <button class="g1" data-g="1"><b>忘了</b><i>${fmtInterval(p[1])}</i></button>
          <button class="g2" data-g="2"><b>困难</b><i>${fmtInterval(p[2])}</i></button>
          <button class="g3" data-g="3"><b>记得</b><i>${fmtInterval(p[3])}</i></button>
          <button class="g4" data-g="4"><b>简单</b><i>${fmtInterval(p[4])}</i></button>
        </div>`;
      ctrl.querySelectorAll('button[data-g]').forEach((b) => {
        b.onclick = () => grade(+b.dataset.g);
      });
      $('#hint').textContent = `${stateLabel} · 按钮下方是下一次复习的间隔`;
    }
  }

  function reveal() {
    revealed = true;
    draw();
    const c = currentCard();
    if (SPEAKABLE.has(c.deck)) speak(speakText(c));
  }

  async function grade(g) {
    const c = currentCard();
    ctrl.querySelectorAll('button').forEach((b) => (b.disabled = true));
    try {
      await reviewCard(c, g);
    } catch (err) {
      console.error(err);
      toast('保存失败：' + err.message);
      ctrl.querySelectorAll('button').forEach((b) => (b.disabled = false));
      return;
    }
    doneCount++;
    // 评「忘了」的卡放到队尾，本轮内再见一次，符合学习步进的设计
    if (g === 1 && again.length < 40) again.push(c);
    idx++;
    if (idx >= queue.length && again.length) {
      queue.push(...again.splice(0));
    }
    revealed = false;
    $('#rLeft').textContent = Math.max(queue.length - idx, 0);
    $('#rBar').style.width = `${Math.min((doneCount / (total + 0.0001)) * 100, 100)}%`;
    draw();
  }

  function finish() {
    qcard.innerHTML = `<div style="font-size:38px">✓</div>
      <div class="q-front" style="font-size:20px">本轮完成</div>
      <div class="q-sub">共 ${doneCount} 次复习</div>`;
    ctrl.innerHTML = `<div class="btn-row">
      <a class="btn" href="#/jp">牌组</a>
      <a class="btn btn-pri" href="#/home">回今日</a>
    </div>`;
    $('#hint').textContent = '';
  }

  $('#btnSpeak').onclick = () => {
    const c = currentCard();
    if (!c) return;
    if (!speak(speakText(c))) toast('系统没有日语语音，可在系统设置里安装日语 TTS');
  };

  const onKey = (e) => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (!revealed) reveal(); }
    else if (revealed && '1234'.includes(e.key)) grade(+e.key);
  };
  window.addEventListener('keydown', onKey);

  draw();

  return {
    destroy() {
      window.removeEventListener('keydown', onKey);
      if ('speechSynthesis' in window) speechSynthesis.cancel();
    },
  };
}
