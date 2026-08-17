/**
 * 离线中日互译引擎。
 *
 * 没有联网，所以不做通用机翻。做的是**分层查找**，每一层可靠性不同，
 * 而且**必须把层级告诉用户** —— 把逐词查询伪装成通顺译文，会让人拿着
 * 语序错乱的句子去跟日本人说话，比明确说「这是逐词结果」有害得多。
 *
 *   第 1 层 短语库   预置 127 条旅游/日常高频句，精确或相近匹配。最可靠，可直接说。
 *   第 2 层 词典逐词  用本机 2000 词词库逐词查。只给对照，不保证成句。
 *   第 3 层 查不到    明确说查不到并给出下一步建议，不编造。
 */

let PH = null;      // 短语库
let VOC = null;     // 词库
let IDX = null;     // 反查索引

const CN_STRIP = /[\s，。！？、；：""''（）()【】,.!?;:~—\-]/g;
const JP_STRIP = /[\s　，。！？、；：「」『』（）()・,.!?;:~ー－]/g;

const normCn = (s) => (s || '').replace(CN_STRIP, '').toLowerCase();
const normJp = (s) => (s || '').replace(JP_STRIP, '');
/** 片假名转平假名，让「コンビニ」和「こんびに」都能查到 */
const kataToHira = (s) => (s || '').replace(/[\u30a1-\u30f6]/g, (c) =>
  String.fromCharCode(c.charCodeAt(0) - 0x60));
const jpKey = (s) => kataToHira(normJp(s));

export async function load() {
  if (PH && VOC) return;
  const [ph, vc] = await Promise.all([
    fetch('./data/phrases.json').then((r) => r.json()),
    fetch('./data/vocab.json').then((r) => r.json()),
  ]);
  PH = ph;
  VOC = vc.vocab || [];
  IDX = buildIndex();
}

function buildIndex() {
  const cn = new Map(), jp = new Map(), kana = new Map();
  let maxCn = 1, maxJp = 1;
  for (const w of VOC) {
    // 一个词条的中文释义常是「话，说话，讲话」这种多义并列，
    // 逐个拆开建反查键，否则中→日只能整串精确匹配，基本查不中。
    for (const part of String(w.cn || '').split(/[,，、;；/]/)) {
      const k = normCn(part);
      if (k && !cn.has(k)) { cn.set(k, w); maxCn = Math.max(maxCn, k.length); }
    }
    if (w.jp) { const k = jpKey(w.jp); if (k && !jp.has(k)) { jp.set(k, w); maxJp = Math.max(maxJp, k.length); } }
    if (w.kana) { const k = jpKey(w.kana); if (k && !kana.has(k)) { kana.set(k, w); maxJp = Math.max(maxJp, k.length); } }
  }
  return { cn, jp, kana, maxCn: Math.min(maxCn, 10), maxJp: Math.min(maxJp, 12) };
}

export function categories() { return (PH && PH.categories) || []; }
export function phrasesOf(cat) { return ((PH && PH.phrases) || []).filter((p) => p.cat === cat); }
export function allPhrases() { return (PH && PH.phrases) || []; }

// ---------- 相似度 ----------

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let cur = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

/**
 * 编辑距离 + 字符重叠的加权。
 * 只用编辑距离的话，「这个多少钱呀」对「这个多少钱」会因为长度差被压低；
 * 只用字符重叠的话，语序完全不同的句子会被误判为相近。两者结合更稳。
 */
function similarity(a, b) {
  if (!a || !b) return 0;
  const edit = 1 - levenshtein(a, b) / Math.max(a.length, b.length);
  const A = new Set(a), B = new Set(b);
  let inter = 0;
  for (const c of A) if (B.has(c)) inter++;
  const overlap = inter / Math.max(A.size, B.size);
  return 0.6 * edit + 0.4 * overlap;
}

// ---------- 分词（最长匹配） ----------

function segment(text, dict, maxLen) {
  const out = [];
  for (let i = 0; i < text.length;) {
    let hit = null, len = 0;
    for (let L = Math.min(maxLen, text.length - i); L >= 1; L--) {
      const w = dict(text.slice(i, i + L));
      if (w) { hit = w; len = L; break; }
    }
    if (hit) { out.push({ surface: text.slice(i, i + len), hit }); i += len; }
    else { out.push({ surface: text[i], hit: null }); i += 1; }
  }
  return out;
}

// ---------- 主入口 ----------

export const EXACT = 0.995;
export const FUZZY = 0.55;

/**
 * @param {string} text 输入
 * @param {'cn2jp'|'jp2cn'} dir 方向
 */
export function translate(text, dir = 'cn2jp') {
  const raw = (text || '').trim();
  if (!raw) return { ok: false, level: 0, label: '', text: '', note: '先说一句话或输入文字' };
  const cn2jp = dir === 'cn2jp';
  const key = cn2jp ? normCn(raw) : jpKey(raw);

  // ---- 第 1 层：短语库 ----
  let best = null, bestScore = 0;
  for (const p of allPhrases()) {
    const s = cn2jp
      ? similarity(key, normCn(p.cn))
      : Math.max(similarity(key, jpKey(p.jp)), similarity(key, jpKey(p.kana)));
    if (s > bestScore) { bestScore = s; best = p; }
  }
  if (best && bestScore >= EXACT) {
    return {
      ok: true, level: 1, source: 'phrase', label: '短语库 · 精确匹配',
      grade: 'high', note: '预置短语，可以直接说',
      text: cn2jp ? best.jp : best.cn,
      kana: best.kana, romaji: best.romaji, phrase: best,
      speakText: cn2jp ? best.jp : best.cn,
      speakLang: cn2jp ? 'ja-JP' : 'zh-CN',
    };
  }
  if (best && bestScore >= FUZZY) {
    return {
      ok: true, level: 1, source: 'phrase-fuzzy', label: '短语库 · 相近句',
      grade: 'mid',
      note: `没有完全一致的句子。最接近的是「${cn2jp ? best.cn : best.jp}」（相似 ${Math.round(bestScore * 100)}%），意思可能有偏差`,
      text: cn2jp ? best.jp : best.cn,
      kana: best.kana, romaji: best.romaji, phrase: best,
      speakText: cn2jp ? best.jp : best.cn,
      speakLang: cn2jp ? 'ja-JP' : 'zh-CN',
    };
  }

  // ---- 第 2 层：词典逐词 ----
  const tokens = cn2jp
    ? segment(key, (t) => IDX.cn.get(t), IDX.maxCn)
    : segment(key, (t) => IDX.jp.get(t) || IDX.kana.get(t), IDX.maxJp);
  const hits = tokens.filter((t) => t.hit);
  if (hits.length) {
    const joined = hits.map((t) => (cn2jp ? t.hit.jp : t.hit.cn)).join(cn2jp ? '' : ' ');
    return {
      ok: true, level: 2, source: 'dict', label: '词典 · 逐词查询',
      grade: 'low',
      note: '这是逐词查询，不是完整翻译 —— 语序、助词、动词变形都没有处理，直接照读日本人可能听不懂',
      text: joined,
      kana: cn2jp ? hits.map((t) => t.hit.kana || '').join(' ') : '',
      romaji: cn2jp ? hits.map((t) => t.hit.romaji || '').join(' ') : '',
      tokens,
      hitCount: hits.length,
      missCount: tokens.length - hits.length,
      speakText: cn2jp ? joined : '',
      speakLang: cn2jp ? 'ja-JP' : 'zh-CN',
    };
  }

  // ---- 第 3 层：查不到 ----
  return {
    ok: false, level: 3, source: 'none', label: '未收录',
    grade: 'none', text: '',
    note: '离线词库里查不到',
    suggestions: [
      '换更短更常见的说法（说「多少钱」而不是「这个大概卖多少钱呀」）',
      '在下面的常用短语里找现成的句子',
      '之后开启联网增强可以做通用翻译',
    ],
    near: best && bestScore > 0.3 ? (cn2jp ? best.cn : best.jp) : null,
  };
}
