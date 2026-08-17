import { $, $$, toast } from './ui.js';
import { seed } from './store.js';
import { mic } from './audio.js';
import { isNative } from './native.js';

const routes = {
  home: () => import('./views/home.js'),
  jp: () => import('./views/jp.js'),
  review: () => import('./views/review.js'),
  ear: () => import('./views/ear.js'),
  voice: () => import('./views/voice.js'),
  data: () => import('./views/data.js'),
  plan: () => import('./views/plan.js'),
  translate: () => import('./views/translate.js'),
  sing: () => import('./views/sing.js'),
};

const TAB_OF = { home: 'home', jp: 'jp', review: 'jp', ear: 'ear', voice: 'voice',
  data: 'data', plan: 'home', translate: 'translate', sing: 'voice' };

let current = null;

function parseHash() {
  const raw = (location.hash || '#/home').replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  const parts = path.split('/').filter(Boolean);
  const params = new URLSearchParams(qs || '');
  return { name: parts[0] || 'home', args: parts.slice(1), params };
}

export function setTitle(t, right = '') {
  $('#tbTitle').textContent = t;
  $('#tbRight').innerHTML = right;
}

async function render() {
  const { name, args, params } = parseHash();
  const loader = routes[name] || routes.home;

  // 离开上一个视图时释放资源：麦克风不释放会一直亮着录音指示灯并耗电
  if (current && current.destroy) {
    try { current.destroy(); } catch (e) { console.warn('destroy failed', e); }
  }
  if (mic.active && name !== 'voice' && name !== 'ear') mic.stop();
  current = null;

  const view = $('#view');
  view.innerHTML = '<div class="loading">加载中…</div>';
  $$('#tabbar a').forEach((a) => a.classList.toggle('on', a.dataset.tab === (TAB_OF[name] || name)));

  try {
    const mod = await loader();
    current = (await mod.render(view, { args, params })) || {};
  } catch (err) {
    console.error(err);
    view.innerHTML = `<div class="card"><h3>出错了</h3><div class="small muted" style="white-space:pre-wrap">${String(err && err.stack || err)}</div></div>`;
  }
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', render);

/**
 * 屏幕尺寸变化的处理。
 *
 * 图表和音高轨迹的 canvas 是在渲染那一刻按 clientWidth × devicePixelRatio 定尺寸的，
 * 平板旋转后不重绘会被拉伸成模糊的。
 *
 * 但**不能**因此整页重渲染：那会销毁正在进行的状态 ——
 * 练声的倒计时会归零、回归体检正在采集的音频帧会丢、麦克风循环会断。
 * 所以只调用视图自己暴露的 resize() 钩子，由它重绘画布，DOM 和状态都保留。
 */
let resizeTimer = 0;
let lastW = window.innerWidth;
function onResize() {
  const w = window.innerWidth;
  if (Math.abs(w - lastW) < 2) return; // 软键盘只改高度，不需要重绘画布
  lastW = w;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (current && typeof current.resize === 'function') {
      try { current.resize(); } catch (e) { console.warn('resize hook failed', e); }
    }
  }, 200);
}
window.addEventListener('resize', onResize);
window.addEventListener('orientationchange', onResize);

async function boot() {
  try {
    const r = await seed();
    if (r.added || r.updated || r.removed) {
      console.log(`种卡: 新增 ${r.added}, 更新 ${r.updated}, 清理孤儿 ${r.removed}, 共 ${r.total}`);
    }
  } catch (err) {
    console.error('种卡失败', err);
    toast('数据加载失败，检查是否用 http 打开而非 file://', 5000);
  }
  // 用 replace 而不是赋值：赋值会多压一条历史记录，
  // 装成 APK 后在首页按返回键会先回到「无 hash」状态再退出，多按一次才退。
  if (!location.hash) location.replace('#/home');
  await render();

  // 只有网页版需要 Service Worker 来实现离线。
  // 装成 APK 后资源本来就在 APK 里，永远可用；而且 WebView 不支持为
  // shouldInterceptRequest 提供的响应注册 SW（会报 "unknown error when fetching
  // the script"），留着它只会每次启动报一个无意义的错，更新后还可能供应旧缓存。
  if (!isNative && 'serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW 注册失败', e));
  }
}

// 页面隐藏时停麦克风：手机切后台后 AudioContext 会被挂起，
// 不主动停会留下一个僵死的音轨，回前台后读不到数据。
document.addEventListener('visibilitychange', () => {
  if (document.hidden && mic.active) mic.stopLoop();
});

boot();
