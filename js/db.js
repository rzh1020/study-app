/**
 * IndexedDB 薄封装。
 * 选 IndexedDB 而非 localStorage 的原因：要存录音 Blob（localStorage 只能存字符串
 * 且上限 5MB），而且复习日志会长到上万条，需要索引查询。
 */

const DB_NAME = 'study-app';
const DB_VER = 1;

let _db = null;

export function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (e) => {
      const d = req.result;
      if (!d.objectStoreNames.contains('cards')) {
        const s = d.createObjectStore('cards', { keyPath: 'id' });
        s.createIndex('deck', 'deck');
        s.createIndex('due', 'due');
        s.createIndex('deck_state', ['deck', 'state']);
      }
      if (!d.objectStoreNames.contains('reviews')) {
        const s = d.createObjectStore('reviews', { keyPath: 'id', autoIncrement: true });
        s.createIndex('ts', 'ts');
        s.createIndex('cardId', 'cardId');
      }
      if (!d.objectStoreNames.contains('earlog')) {
        const s = d.createObjectStore('earlog', { keyPath: 'id', autoIncrement: true });
        s.createIndex('ts', 'ts');
      }
      if (!d.objectStoreNames.contains('voice')) {
        const s = d.createObjectStore('voice', { keyPath: 'id', autoIncrement: true });
        s.createIndex('ts', 'ts');
        s.createIndex('kind', 'kind');
      }
      if (!d.objectStoreNames.contains('meta')) {
        d.createObjectStore('meta', { keyPath: 'k' });
      }
      void e;
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function run(storeName, mode, fn) {
  return openDB().then(
    (d) =>
      new Promise((resolve, reject) => {
        const tx = d.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        let result;
        try {
          result = fn(store, tx);
        } catch (err) {
          reject(err);
          return;
        }
        tx.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
  );
}

const wrap = (req) => ({ __req: req });

export const db = {
  get: (store, key) => run(store, 'readonly', (s) => wrap(s.get(key))),
  all: (store) => run(store, 'readonly', (s) => wrap(s.getAll())),
  put: (store, val) => run(store, 'readwrite', (s) => wrap(s.put(val))),
  add: (store, val) => run(store, 'readwrite', (s) => wrap(s.add(val))),
  clear: (store) => run(store, 'readwrite', (s) => wrap(s.clear())),
  count: (store) => run(store, 'readonly', (s) => wrap(s.count())),
  putMany: (store, vals) =>
    run(store, 'readwrite', (s) => {
      for (const v of vals) s.put(v);
      return vals.length;
    }),
  /** 用索引取范围，range 用 IDBKeyRange 构造 */
  byIndex: (store, index, range, limit = Infinity) =>
    run(store, 'readonly', (s, tx) => {
      const out = [];
      const req = s.index(index).openCursor(range);
      req.onsuccess = () => {
        const c = req.result;
        if (!c || out.length >= limit) return;
        out.push(c.value);
        c.continue();
      };
      void tx;
      return out;
    }),
};

// ---- meta 便捷方法 ----
export async function metaGet(k, dflt = null) {
  const r = await db.get('meta', k);
  return r === undefined || r === null ? dflt : r.v;
}
export function metaSet(k, v) {
  return db.put('meta', { k, v });
}

/** 本地日期 key，YYYY-MM-DD。用本地时区，避免跨零点被 UTC 切错天 */
export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 本地 0 点时间戳 */
export function dayStart(ts = Date.now()) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
