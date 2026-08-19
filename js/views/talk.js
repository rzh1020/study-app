import { $, esc, toast } from '../ui.js';
import { setTitle } from '../app.js';
import { asrStatus, asrStart, asrStop, asrLanguages, speak, ttsStop } from '../native.js';

/**
 * 面对面对话。
 *
 * 场景是两个人拿着同一台手机轮流说话，所以版面上下对开：上半屏给对面的人看
 * （正对他），下半屏给自己看，中间一个说话按钮。
 *
 * 关于「自动识别说话人语言」：系统语音识别必须先指定语言（Android 的
 * SpeechRecognizer 没有语言自动检测），拿中文引擎去听日语只会得到一串谐音汉字。
 * 所以真正的自动检测做不到，这里的做法是：
 *   1. 按钮记住上一次说的语言，轮流对话时自然交替
 *   2. 识别出文本后用字符特征复核（有假名一定是日语；全汉字且含中文常用字
 *      判为中文），与按钮语言不符就按复核结果决定翻译方向 —— 点错也能救回来
 *   3. 两个语言按钮始终可见，一键指定
 * 设备上没装日语识别包时，如实把日语按钮禁掉并说明原因，而不是让它点了没反应。
 */

const LANGS = {
  zh: { tag: 'zh-CN', name: '中文', to: 'ja', ph: '说中文' },
  ja: { tag: 'ja-JP', name: '日本語', to: 'zh', ph: '日本語で話す' },
};

/** 用字符特征判断一段文本是中文还是日语。假名是决定性证据。 */
export function detectLang(text) {
  const s = String(text || '');
  if (/[\u3040-\u309f\u30a0-\u30ff]/.test(s)) return 'ja';   // 平假名/片假名
  if (/[\u4e00-\u9fff]/.test(s)) return 'zh';                 // 只有汉字：按中文处理
  return null;
}

export async function render(view) {
  setTitle('面对面');
  const asr = asrStatus();
  let from = 'zh';                 // 这一轮谁在说
  let jaAsrOk = null;              // 设备是否装了日语识别包，null=还在查
  let busy = false;
  const turns = [];                // { from, src, out, kana }

  view.innerHTML = `
    <div class="tk-wrap">
      <div class="tk-side tk-them"><div class="tk-empty">把手机转向对方，让他点下面的「日本語」说话</div></div>
      <div class="tk-mid">
        <button class="tk-mic" id="tkMic">🎤 <b>点击说话</b><i id="tkWho">中文</i></button>
        <div class="tk-langs">
          <button class="btn btn-ghost" id="tkZh">中文</button>
          <button class="btn btn-ghost" id="tkJa">日本語</button>
        </div>
        <div class="tiny dim" id="tkHint"></div>
      </div>
      <div class="tk-side tk-me"><div class="tk-empty">点「中文」说一句，会翻成日语显示在上面并读出来</div></div>
    </div>
  `;

  // 日语识别包是否存在，决定日语按钮能不能用
  asrLanguages().then(({ langs }) => {
    jaAsrOk = langs.some((l) => /^ja/i.test(l));
    if (!langs.length) jaAsrOk = null;   // 查不到就不下结论，让用户试
    drawHint();
  });

  function drawHint() {
    const h = $('#tkHint');
    if (!asr.available) {
      h.innerHTML = `语音识别不可用：${esc(asr.reason)}`;
      return;
    }
    if (jaAsrOk === false) {
      h.innerHTML = '这台设备没装日语识别包，对方说话识别不了；<br>中文→日语方向正常，日语可以让对方打字';
      $('#tkJa').disabled = true;
      return;
    }
    h.textContent = asr.offline ? '离线识别，不联网' : '识别可用';
  }

  function drawWho() {
    $('#tkWho').textContent = LANGS[from].name;
    $('#tkZh').classList.toggle('on', from === 'zh');
    $('#tkJa').classList.toggle('on', from === 'ja');
  }

  function drawTurns() {
    // 对方那半屏要倒过来显示（他正对着手机顶部），所以两侧各取各自最后一条
    const lastThem = [...turns].reverse().find((t) => t.from === 'ja');
    const lastMe = [...turns].reverse().find((t) => t.from === 'zh');
    const them = $('.tk-them');
    const me = $('.tk-me');
    // 上半屏 = 给对方看的内容：他说的话（原文）+ 我说的话翻成日语
    const themText = lastMe ? lastMe.out : '';
    const themSub = lastMe ? lastMe.kana || '' : '';
    them.innerHTML = themText
      ? `<div class="tk-big">${esc(themText)}</div>
         ${themSub ? `<div class="tk-sub">${esc(themSub)}</div>` : ''}
         <button class="btn btn-ghost tk-replay" data-side="them">🔊 再读一次</button>`
      : '<div class="tk-empty">把手机转向对方，让他点「日本語」说话</div>';
    // 下半屏 = 给我看的：对方说的话翻成中文
    me.innerHTML = lastThem
      ? `<div class="tk-big">${esc(lastThem.out)}</div>
         <div class="tk-sub">${esc(lastThem.src)}</div>`
      : '<div class="tk-empty">点「中文」说一句，会翻成日语显示在上面并读出来</div>';
    const rp = view.querySelector('.tk-replay');
    if (rp && lastMe) rp.onclick = () => sayJa(lastMe.out, lastMe.kana);
  }

  async function sayJa(text, kana) {
    ttsStop();
    try {
      const T = await import('../tts.js');
      if (!T.available()) await T.load();
      if (T.available()) { await T.speak(kana || text); return; }
    } catch { /* 落到系统 TTS */ }
    speak(text, 'ja-JP');
  }

  /** 中文 → 日语用神经翻译；日语 → 中文同理（模型都在 APK 里）。 */
  async function translate(text, dirFrom) {
    const N = await import('../nmt.js');
    if (!N.available(dirFrom === 'zh' ? 'zh2ja' : 'ja2zh')) {
      await N.load(dirFrom === 'zh' ? 'zh2ja' : 'ja2zh');
    }
    const r = await N.translate(text, { beams: 4, dir: dirFrom === 'zh' ? 'zh2ja' : 'ja2zh' });
    return r.text;
  }

  async function handle(text, spoken) {
    // 识别文本复核：假名是硬证据，点错按钮也能救回来
    const real = detectLang(text) || spoken;
    if (real !== spoken) {
      toast(`听起来是${LANGS[real].name}，按${LANGS[real].name}处理`);
      from = real;
      drawWho();
    }
    const out = await translate(text, real);
    let kana = '';
    if (real === 'zh') {
      try {
        const J = await import('../jaspeech.js');
        await J.loadDict();
        kana = J.toKana(out).kana;
      } catch { /* 没有假名也能显示 */ }
    }
    turns.push({ from: real, src: text, out, kana });
    drawTurns();
    // 翻成日语的要读给对方听；翻成中文的读给自己听
    if (real === 'zh') await sayJa(out, kana);
    else speak(out, 'zh-CN');
    // 轮流：下一次默认换成另一方说
    from = real === 'zh' ? 'ja' : 'zh';
    drawWho();
  }

  function startListen() {
    if (busy) { asrStop(); busy = false; $('#tkMic').classList.remove('on'); return; }
    if (!asr.available) { toast('语音识别不可用：' + asr.reason, 4000); return; }
    busy = true;
    $('#tkMic').classList.add('on');
    $('#tkHint').textContent = '在听…说完停一下就会自动结束';
    const spoken = from;
    const ok = asrStart(LANGS[from].tag, {
      onPartial: (t) => { $('#tkHint').textContent = '听到：' + t; },
      onResult: async (t) => {
        busy = false;
        $('#tkMic').classList.remove('on');
        if (!t) { drawHint(); return; }
        $('#tkHint').textContent = '翻译中…';
        try {
          await handle(t, spoken);
          drawHint();
        } catch (e) {
          $('#tkHint').textContent = '';
          toast('翻译失败：' + ((e && e.message) || e), 4000);
        }
      },
      onError: (e) => {
        busy = false;
        $('#tkMic').classList.remove('on');
        drawHint();
        toast('没听清：' + e, 3000);
      },
    });
    if (!ok) { busy = false; $('#tkMic').classList.remove('on'); }
  }

  $('#tkMic').onclick = startListen;
  $('#tkZh').onclick = () => { from = 'zh'; drawWho(); };
  $('#tkJa').onclick = () => { from = 'ja'; drawWho(); };
  drawWho();
  drawHint();
  drawTurns();

  return {
    destroy() {
      asrStop();
      ttsStop();
      import('../tts.js').then((T) => T.stop()).catch(() => {});
    },
  };
}
