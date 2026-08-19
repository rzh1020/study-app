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
 * 关于「自动识别说话人语言」：Whisper 有语言自检，但实测它会把日语听成英文
 * 并转写成一串谐音英文，不能依赖。所以做法是：
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
  let from = 'zh';                 // 这一轮谁在说
  let rec = null;                  // 正在进行的录音
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

  // 识别模型（约 77MB）后台预热，省掉第一次说话时的等待
  setTimeout(async () => {
    try {
      const A = await import('../asr.js');
      if (!A.available()) { await A.load(); drawHint(); }
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
    h.textContent = '全部离线：识别、翻译、朗读都在本机';
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
      if (!T.available()) { drawHint('载入语音…'); await T.load(); }
      if (T.available()) {
        const r = await T.speak(kana || text);
        // 播放是异步排队的，等它放完再释放这 90MB，否则会把正在放的声音掐掉
        const wait = Math.max(1200, ((r && r.seconds) || 2) * 1000 + 600);
        setTimeout(() => { T.unload().catch(() => {}); }, wait);
        return;
      }
    } catch { /* 落到系统 TTS */ }
    speak(text, 'ja-JP');
  }

  /**
   * 中文 → 日语 / 日语 → 中文，模型都在 APK 里。
   *
   * 一次只留一个方向：四套模型全常驻会把 WebView 渲染进程挤爆（实测被系统杀掉）。
   * 换方向要重新加载几秒，但对话是轮流说话，这几秒落在对方开口的间隙里。
   */
  async function translate(text, dirFrom) {
    const want = dirFrom === 'zh' ? 'zh2ja' : 'ja2zh';
    const other = want === 'zh2ja' ? 'ja2zh' : 'zh2ja';
    const N = await import('../nmt.js');
    if (N.available(other)) await N.unload(other);
    if (!N.available(want)) {
      drawHint('载入翻译模型…');
      await N.load(want);
    }
    const r = await N.translate(text, { beams: 4, dir: want });
    return r.text;
  }

  async function handle(text, real, retried) {
    if (retried) toast(`听起来是${LANGS[real].name}，已按${LANGS[real].name}重识别`);
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

  async function startListen() {
    const btn = $('#tkMic');
    if (busy) return;
    if (rec) {                       // 第二次点击 = 说完了
      const r = rec;
      rec = null;
      btn.classList.remove('on');
      busy = true;
      const spoken = from;
      try {
        drawHint('识别中…');
        const A = await import('../asr.js');
        const { pcm, seconds } = await r.stop();
        if (!pcm.length || seconds < 0.3) { busy = false; drawHint('没录到声音'); return; }
        const heard = await A.recognizeChecked(pcm, spoken);
        if (!heard.text) { busy = false; drawHint('没听清，再说一次'); return; }
        drawHint('翻译中…');
        await handle(heard.text, heard.lang || spoken, heard.retried);
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
      rec = await A.startRecording();
      btn.classList.add('on');
      drawHint('在听… 说完再点一下按钮');
    } catch (e) {
      toast('打不开麦克风：' + ((e && e.message) || e), 4000);
      rec = null;
      btn.classList.remove('on');
    }
  }

  $('#tkMic').onclick = startListen;
  $('#tkZh').onclick = () => { from = 'zh'; drawWho(); };
  $('#tkJa').onclick = () => { from = 'ja'; drawWho(); };
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
