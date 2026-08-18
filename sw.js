/**
 * Service Worker：离线可用是这个应用的硬需求（地铁里没信号）。
 *
 * 策略：
 * - 应用外壳与数据文件用 stale-while-revalidate：先给缓存（秒开），
 *   后台更新下一次生效。不用 network-first，否则弱网时会卡住等超时。
 * - 导航请求失败时兜底返回缓存的 index.html，保证断网也能进。
 */
const VERSION = 'v1';
const CACHE = `study-app-${VERSION}`;

const ASSETS = [
  './',
  './index.html',
  './check.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/ui.js',
  './js/db.js',
  './js/store.js',
  './js/fsrs.js',
  './js/pitch.js',
  './js/audio.js',
  './js/native.js',
  './js/ear-levels.js',
  './js/translate.js',
  './js/jaspeech.js',
  './audio/manifest.json',
  './data/k2k.json',
  './js/views/home.js',
  './js/views/jp.js',
  './js/views/review.js',
  './js/views/ear.js',
  './js/views/voice.js',
  './js/views/data.js',
  './js/views/plan.js',
  './js/views/translate.js',
  './js/views/sing.js',
  './js/views/course.js',
  './data/kana.json',
  './data/vocab.json',
  './data/grammar.json',
  './data/theory.json',
  './data/plan.json',
  './data/phrases.json',
  './data/course.json',
  './icons/icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // 单个资源 404 不应该让整个 install 失败，所以逐个 add 并忽略失败
      .then((c) => Promise.all(ASSETS.map((u) => c.add(u).catch((err) => console.warn('缓存失败', u, err)))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: false });
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);

      if (cached) return cached;
      const res = await network;
      if (res) return res;
      if (req.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      return new Response('离线且无缓存', { status: 503, statusText: 'Offline' });
    })
  );
});
