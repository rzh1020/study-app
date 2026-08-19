/**
 * 原生外壳桥接层。在浏览器里跑时全部降级为 Web 实现，所以同一份代码
 * 既能装成 APK 也能当网页用。
 */

const B = typeof window !== 'undefined' ? window.AndroidBridge : undefined;

export const isNative = !!(B && typeof B.platform === 'function' && B.platform() === 'android');

/**
 * 导出备份文件。
 *
 * 为什么必须走原生：WebView 里 `<a download href="blob:...">` 会静默失败
 * （没有 DownloadManager 能处理 blob: 协议），点了没反应也没报错。
 * 而这个 App 唯一的数据丢失风险就是没有备份，这条链路不能悄悄坏掉。
 */
export function saveTextFile(filename, text, mime = 'application/json') {
  if (isNative) {
    return new Promise((resolve, reject) => {
      window.__bridgeExportDone = (ok, err) => {
        window.__bridgeExportDone = null;
        ok ? resolve() : reject(new Error(err || '导出失败'));
      };
      try {
        // btoa 只接受 Latin-1，中文内容必须先 UTF-8 编码再转 base64
        const bytes = new TextEncoder().encode(text);
        let bin = '';
        const CH = 0x8000; // 分块，避免超长内容触发参数上限
        for (let i = 0; i < bytes.length; i += CH) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
        }
        B.exportFile(filename, btoa(bin));
      } catch (e) {
        window.__bridgeExportDone = null;
        reject(e);
      }
    });
  }
  // 浏览器路径
  const blob = new Blob([text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return Promise.resolve();
}

/** 读取一个文本文件。原生走 SAF，浏览器走 <input type=file>。 */
export function pickTextFile(accept = '.json') {
  if (isNative) {
    return new Promise((resolve, reject) => {
      window.__bridgeImportDone = (ok, payload) => {
        window.__bridgeImportDone = null;
        ok ? resolve(payload) : reject(new Error(payload || '已取消'));
      };
      B.importFile();
    });
  }
  return new Promise((resolve, reject) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = accept;
    inp.onchange = async () => {
      const f = inp.files && inp.files[0];
      if (!f) return reject(new Error('未选择文件'));
      resolve(await f.text());
    };
    inp.click();
  });
}

/**
 * 保持屏幕常亮。
 * 引导练声有倒计时、回归体检要连续采集 40 秒，中途灭屏会打断采集，
 * 而此时用户双手可能正在做呼吸支撑，没法去点屏幕。
 */
export function keepAwake(on) {
  if (isNative && typeof B.setKeepAwake === 'function') {
    B.setKeepAwake(!!on);
    return true;
  }
  return false;
}

export function nativeToast(msg) {
  if (isNative && typeof B.toast === 'function') { B.toast(msg); return true; }
  return false;
}

/** 注册「App 切到后台」回调。原生外壳在 onPause 时调用。 */
const pauseHandlers = new Set();
export function onNativePause(fn) {
  pauseHandlers.add(fn);
  return () => pauseHandlers.delete(fn);
}
if (typeof window !== 'undefined') {
  window.__onNativePause = () => {
    for (const fn of pauseHandlers) {
      try { fn(); } catch (e) { console.warn('pause handler failed', e); }
    }
  };
}

// ==========================================================================
// 语音识别 / 语音合成桥（翻译功能用）
//
// 契约在这里定义，Android 侧按此实现，网页侧按此调用，两边可并行开发。
// 浏览器环境下自动降级：ASR 用 Web Speech API（Chrome 有，但需联网），
// TTS 用 speechSynthesis。原生环境优先走系统能力（可离线）。
// ==========================================================================

/**
 * 语音识别是否可用。
 * @returns {{available:boolean, offline:boolean, reason:string}}
 */
export function asrStatus() {
  if (isNative && typeof B.asrAvailable === 'function') {
    try {
      const raw = B.asrAvailable();
      const j = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return { available: !!j.available, offline: !!j.offline, reason: j.reason || '' };
    } catch (e) {
      return { available: false, offline: false, reason: String(e.message || e) };
    }
  }
  const W = window.SpeechRecognition || window.webkitSpeechRecognition;
  return W
    ? { available: true, offline: false, reason: '浏览器 Web Speech API（需联网）' }
    : { available: false, offline: false, reason: '此环境不支持语音识别' };
}

let _asrHandlers = null;

/**
 * 开始语音识别。
 * @param {string} lang BCP-47，如 'zh-CN' / 'ja-JP'
 * @param {{onPartial?:(t:string)=>void, onResult:(t:string)=>void, onError:(e:string)=>void}} cb
 * @returns {boolean} 是否成功启动
 */
/**
 * 查系统语音识别支持哪些语言（例如设备上有没有装日语离线包）。
 * 对话模式要双向听说，不能假设 ja-JP 一定可用 —— 拿到真实列表才能如实提示。
 * 非原生环境或查询失败时返回空数组。
 */
export function asrLanguages(timeout = 2500) {
  return new Promise((resolve) => {
    if (!B || !B.asrLanguages) { resolve({ langs: [], pref: null }); return; }
    let done = false;
    const finish = (langs, pref) => {
      if (done) return;
      done = true;
      resolve({ langs: langs || [], pref: pref || null });
    };
    window.__asrLangs = (langs, pref) => finish(langs, pref);
    try { B.asrLanguages(); } catch { finish([], null); }
    setTimeout(() => finish([], null), timeout);
  });
}

export function asrStart(lang, cb) {
  _asrHandlers = cb;
  if (isNative && typeof B.asrStart === 'function') {
    window.__asrPartial = (t) => _asrHandlers && _asrHandlers.onPartial && _asrHandlers.onPartial(t);
    window.__asrResult = (t) => { const h = _asrHandlers; _asrHandlers = null; h && h.onResult(t); };
    window.__asrError = (e) => { const h = _asrHandlers; _asrHandlers = null; h && h.onError(e); };
    B.asrStart(lang);
    return true;
  }
  const W = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!W) { cb.onError('此环境不支持语音识别'); return false; }
  const r = new W();
  r.lang = lang;
  r.interimResults = true;
  r.continuous = false;
  r.onresult = (e) => {
    let finalTxt = '', partial = '';
    for (const res of e.results) {
      if (res.isFinal) finalTxt += res[0].transcript;
      else partial += res[0].transcript;
    }
    if (partial && cb.onPartial) cb.onPartial(partial);
    if (finalTxt) cb.onResult(finalTxt);
  };
  r.onerror = (e) => cb.onError(e.error || '识别失败');
  r.onend = () => { _asrHandlers = null; };
  r.start();
  _asrHandlers = { ...cb, _webRec: r };
  return true;
}

export function asrStop() {
  if (isNative && typeof B.asrStop === 'function') { B.asrStop(); return; }
  if (_asrHandlers && _asrHandlers._webRec) {
    try { _asrHandlers._webRec.stop(); } catch { /* 已停 */ }
  }
  _asrHandlers = null;
}

/**
 * 朗读文本。
 * @param {string} text
 * @param {string} lang 'ja-JP' / 'zh-CN'
 * @returns {boolean} 是否已交付播放（false = 该语言无可用语音）
 */
export function speak(text, lang = 'ja-JP') {
  if (!text) return false;
  if (isNative && typeof B.ttsSpeak === 'function') {
    return !!B.ttsSpeak(text, lang);
  }
  if (!('speechSynthesis' in window)) return false;
  const base = lang.split('-')[0];
  const v = speechSynthesis.getVoices().find((x) => x.lang.toLowerCase().startsWith(base));
  if (!v) return false;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.voice = v;
  u.lang = v.lang;
  u.rate = 0.92;
  speechSynthesis.speak(u);
  return true;
}

/**
 * 探测某语言实际能不能朗读。
 *
 * 不能只看 ttsHasVoice()：原生侧在 TTS 异步 init 完成前会乐观返回 true
 * （否则会误报「缺语音包」），所以刚进页面时它的值不可信。
 * 这里等待 init 落定后再问，拿到的才是真值。
 */
export async function probeTts(lang, waitMs = 2600) {
  if (!isNative) {
    // 浏览器：语音列表可能异步加载，等一轮再看
    if (!('speechSynthesis' in window)) return false;
    if (!speechSynthesis.getVoices().length) await new Promise((r) => setTimeout(r, 600));
    return ttsHasVoice(lang);
  }
  if (typeof B.ttsSpeak !== 'function') return false;
  // 触发 ensureTts() 让引擎开始初始化，再等它落定
  B.ttsSpeak('', lang);
  await new Promise((r) => setTimeout(r, waitMs));
  return ttsHasVoice(lang);
}

/** 某语言是否有可用的合成语音 */
export function ttsHasVoice(lang = 'ja-JP') {
  if (isNative && typeof B.ttsHasVoice === 'function') return !!B.ttsHasVoice(lang);
  if (!('speechSynthesis' in window)) return false;
  const base = lang.split('-')[0];
  return speechSynthesis.getVoices().some((x) => x.lang.toLowerCase().startsWith(base));
}

export function ttsStop() {
  if (isNative && typeof B.ttsStop === 'function') { B.ttsStop(); return; }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}
