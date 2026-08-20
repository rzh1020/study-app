import { $, esc, toast } from '../ui.js';
import { setTitle } from '../app.js';
import { speak, ttsStop } from '../native.js';

/**
 * 面对面对话。
 *
 * 场景是两个人拿着同一台手机轮流说话，所以版面上下对开：上半屏给对面的人看
 * （正对他），下半屏给自己看，中间一个说话按钮。
 *
 * 识别不走系统的 SpeechRecognizer —— 这台设备的系统语音服务拿不到录音 AppOps
 * （"AppOps: Operation not found: pkg=com.xiaomi.mibrain.speech op=RECORD_AUDIO"），
 * isRecognitionAvailable() 返回 true 但一录就报权限错误，反复授权也没用。
 * 改成自己采音（应用自己的麦克风是好的）+ APK 内的 Whisper 模型识别。
 *
 * 语言是自动判的：SenseVoice 输出里自带 <|zh|>/<|ja|> 标签，实测对中日判别正确，
 * 所以点一下就能说，不用先选「我说中文还是日文」。
 * 下面两个语言按钮只是兜底（想强制指定时用），正常用不到。
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
  let from = 'zh';                 // 上一轮是谁在说（只用于兜底）
  let force = null;                // 非 null = 用户强制指定只听某种语言
  let rec = null;                  // 正在进行的录音
  let busy = false;
  const turns = [];                // { from, src, out, kana }

  view.innerHTML = `
    <div class="tk-wrap">
      <div class="tk-side tk-them"><div class="tk-empty">把手机转向对方，让他点下面的「日本語」说话</div></div>
      <div class="tk-mid">
        <button class="tk-mic" id="tkMic">🎤 <b>点击说话</b><i id="tkWho">自动识别语言</i></button>
        <div class="tk-langs">
          <button class="btn btn-ghost" id="tkAuto">自动</button>
          <button class="btn btn-ghost" id="tkZh">只听中文</button>
          <button class="btn btn-ghost" id="tkJa">只听日语</button>
        </div>
        <div class="tk-level" id="tkLevel"><i></i></div>
        <div class="tiny dim" id="tkHint"></div>
      </div>
      <div class="tk-side tk-me"><div class="tk-empty">点「中文」说一句，会翻成日语显示在上面并读出来</div></div>
    </div>
  `;

  // 进页面就按「用得最早」的顺序预热：识别 → 翻译 → 语音。
  // 串行而不是并行，避免同时解析几百 MB 把内存峰值推高一倍。
  setTimeout(async () => {
    try {
      const A = await import('../asr.js');
      if (!A.available()) { await A.load(); drawHint(); }
      const N = await import('../nmt.js');
      if (!N.available('zh2ja')) await N.load('zh2ja');
      if (!N.available('ja2zh')) await N.load('ja2zh');
      const T = await import('../tts.js');
      if (!T.available()) await T.load();
      drawHint();
    } catch { /* 加载失败时点说话会给出提示 */ }
  }, 600);

  async function drawHint(msg) {
    const h = $('#tkHint');
    if (msg) { h.textContent = msg; return; }
    try {
      const A = await import('../asr.js');
      if (A.state.error) { h.textContent = '识别模型加载失败：' + A.state.error; return; }
      if (!A.available()) { h.textContent = A.state.loading ? '识别模型载入中…' : '点按钮开始，会先载入识别模型'; return; }
    } catch { /* 忽略 */ }
    h.textContent = '全部离线，语言自动判断';
  }

  function drawWho() {
    $('#tkWho').textContent = force ? `只听${LANGS[force].name}` : '自动识别语言';
    $('#tkAuto').classList.toggle('on', !force);
    $('#tkZh').classList.toggle('on', force === 'zh');
    $('#tkJa').classList.toggle('on', force === 'ja');
  }

  function drawTurns() {
    // 两侧各显示两样东西：对方说的话的译文（大字，是这一侧的人要读的），
    // 以及这一侧的人自己刚被听成了什么（小字回显）。
    // 没有这个回显，识别错了只会看到一句莫名其妙的译文，
    // 分不清是听错了还是翻错了。
    const lastThem = [...turns].reverse().find((t) => t.from === 'ja');
    const lastMe = [...turns].reverse().find((t) => t.from === 'zh');
    const them = $('.tk-them');
    const me = $('.tk-me');

    const block = (main, mainSub, heard, heardLabel, replay, speaking) => {
      if (!main && !heard) return null;
      let h = '';
      if (main) {
        h += `<div class="tk-big">${esc(main)}</div>`;
        if (mainSub) h += `<div class="tk-sub">${esc(mainSub)}</div>`;
      } else {
        h += '<div class="tk-sub">对方还没说话</div>';
      }
      if (heard) {
        h += `<div class="tk-heard"><span>${esc(heardLabel)}</span>${esc(heard)}
              <button class="tk-redo" data-redo="1">听错了，重说</button></div>`;
      }
      if (main && replay) {
        h += speaking
          ? '<div class="tk-speaking">🔊 正在生成语音…</div>'
          : '<button class="btn btn-ghost tk-replay">🔊 再读一次</button>';
      }
      return h;
    };

    const themHtml = block(
      lastMe ? lastMe.out : '', lastMe ? lastMe.kana : '',
      lastThem ? lastThem.src : '', 'あなたの発話：', true,
      !!(lastMe && lastMe.speaking));
    them.innerHTML = themHtml
      || '<div class="tk-empty">把手机转向对方，让他点「日本語」说话</div>';

    const meHtml = block(
      lastThem ? lastThem.out : '', '',
      lastMe ? lastMe.src : '', '听到你说：', false);
    me.innerHTML = meHtml
      || '<div class="tk-empty">点「中文」说一句，会翻成日语显示在上面并读出来</div>';

    const rp = view.querySelector('.tk-replay');
    if (rp && lastMe) rp.onclick = () => sayJa(lastMe.out, lastMe.kana);
    view.querySelectorAll('[data-redo]').forEach((btn) => {
      btn.onclick = () => {
        // 丢掉这一侧最后一轮，重新说 —— 比让人对着错译文干瞪眼有用
        const side = btn.closest('.tk-them') ? 'ja' : 'zh';
        for (let i = turns.length - 1; i >= 0; i--) {
          if (turns[i].from === side) { turns.splice(i, 1); break; }
        }
        from = side;
        drawWho();
        drawTurns();
        startListen();
      };
    });
  }

  async function sayJa(text, kana) {
    ttsStop();
    try {
      const T = await import('../tts.js');
      if (!T.available()) { drawHint('载入语音…'); await T.load(); }
      if (T.available()) {
        await T.speak(kana || text);
        return;
      }
    } catch { /* 落到系统 TTS */ }
    speak(text, 'ja-JP');
  }

  /**
   * 中文 → 日语 / 日语 → 中文，模型都在 APK 里。
   *
   * 两个方向都常驻，不再用完就卸。早先做过互斥卸载，是因为当时还背着 Whisper
   * 和 transformers.js 那套独立的 onnxruntime（两个 wasm 实例各占一份内存），
   * 加起来会把渲染进程挤爆。换成 SenseVoice 后识别与翻译共用同一份运行时，
   * 实测四套模型（识别 229 + 中→日 267 + 日→中 142 + 语音 90）同时驻留没问题，
   * 于是每轮省掉几秒的加载等待。
   */
  async function translate(text, dirFrom) {
    const want = dirFrom === 'zh' ? 'zh2ja' : 'ja2zh';
    const N = await import('../nmt.js');
    if (!N.available(want)) {
      drawHint('载入翻译模型…');
      await N.load(want);
    }
    const r = await N.translate(text, { beams: 4, dir: want });
    return r.text;
  }

  async function handle(text, real) {
    // 先把识别结果显示出来再去翻译：翻译要一两秒，这段时间里人应该已经能
    // 看到「你被听成了什么」，错了可以直接重说，不用等完。
    const turn = { from: real, src: text, out: '', kana: '' };
    turns.push(turn);
    drawTurns();
    const out = await translate(text, real);
    turn.out = out;
    if (real === 'zh') {
      try {
        const J = await import('../jaspeech.js');
        await J.loadDict();
        turn.kana = J.toKana(out).kana;
      } catch { /* 没有假名也能显示 */ }
    }
    drawTurns();
    from = real === 'zh' ? 'ja' : 'zh';
    drawWho();
    // 不等语音：合成一句要几秒（wasm 单线程，Kokoro 比实时慢），
    // 但对面已经能看屏幕上的大字了。所以文字立刻给出，语音在后台补上，
    // 感知等待从「识别+翻译+合成」缩短到「识别+翻译」。
    if (real === 'zh') {
      turn.speaking = true;
      drawTurns();
      sayJa(out, turn.kana).finally(() => { turn.speaking = false; drawTurns(); });
    } else {
      speak(out, 'zh-CN');
    }
  }

  async function startListen() {
    const btn = $('#tkMic');
    if (busy) return;
    if (rec) {                       // 第二次点击 = 说完了
      const r = rec;
      rec = null;
      btn.classList.remove('on');
      const bar0 = $('#tkLevel');
      bar0.classList.remove('on');
      bar0.firstElementChild.style.width = '0%';
      busy = true;
      const spoken = from;
      try {
        drawHint('识别中…');
        const A = await import('../asr.js');
        const { pcm, seconds } = await r.stop();
        if (!pcm.length || seconds < 0.3) { busy = false; drawHint('没录到声音'); return; }
        const heard = force
          ? await A.recognize(pcm, { language: force })
          : await A.recognizeChecked(pcm, spoken);
        if (!heard.text) { busy = false; drawHint('没听清，再说一次'); return; }
        drawHint('翻译中…');
        await handle(heard.text, heard.lang || force || spoken, false);
        drawHint();
      } catch (e) {
        toast('识别失败：' + ((e && e.message) || e), 4000);
        drawHint();
      } finally {
        busy = false;
      }
      return;
    }
    try {
      const A = await import('../asr.js');
      if (!A.available()) {
        drawHint('第一次要先载入识别模型（约 77MB）…');
        const ok = await A.load();
        if (!ok) { toast('识别模型加载失败：' + A.state.error, 5000); return; }
      }
      const bar = $('#tkLevel');
      bar.classList.add('on');
      rec = await A.startRecording({
        // 电平条：没有它，用户不知道麦克风到底有没有在收音
        onLevel: (v) => {
          bar.firstElementChild.style.width = `${Math.round(Math.min(1, v * 3.5) * 100)}%`;
        },
        // 边说边识别：识别比说话快（RTF 约 0.33），所以说的过程中就能看到字，
        // 不用等说完再从零开始认
        onPartial: (t) => { if (rec) drawHint('听到：' + t); },
        // 说完自动收：省掉「再点一下按钮」这一步，也省掉人犹豫的时间
        onAutoStop: () => { if (rec) startListen(); },
      });
      btn.classList.add('on');
      drawHint('在听… 说完会自动结束，也可以点按钮结束');
    } catch (e) {
      toast('打不开麦克风：' + ((e && e.message) || e), 4000);
      rec = null;
      btn.classList.remove('on');
    }
  }

  $('#tkMic').onclick = startListen;
  $('#tkAuto').onclick = () => { force = null; drawWho(); };
  $('#tkZh').onclick = () => { force = 'zh'; drawWho(); };
  $('#tkJa').onclick = () => { force = 'ja'; drawWho(); };
  drawWho();
  drawHint();
  drawTurns();

  return {
    destroy() {
      if (rec) { rec.stop().catch(() => {}); rec = null; }
      ttsStop();
      import('../tts.js').then((T) => T.stop()).catch(() => {});
    },
  };
}
