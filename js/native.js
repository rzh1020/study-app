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
