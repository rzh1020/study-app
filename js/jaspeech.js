/**
 * 日语语音播放。
 *
 * 背景：实测这台设备（小米 15 Ultra / HyperOS）的系统 TTS 只有小米引擎，
 * **不支持日语**，所以日语朗读不能依赖系统。
 *
 * 方案是预渲染而不是内置模型：
 *   内置 Kokoro/VITS 之类要 147MB 模型 + 23MB 的 .so，APK 会涨到 200MB+。
 *   但需要朗读的日语文本其实有限且已知 —— 127 条短语是旅游主力，
 *   假名音节只有 104 个。在电脑上用 Open JTalk 离线渲染好，
 *   整包只占 0.55MB，还没有端上推理的延迟和耗电。
 *
 * 三级回退：
 *   1. 整句预渲染音频（短语库命中）—— 音质最好，零延迟
 *   2. 假名音节拼接 —— 任意假名文本都能读，机械但可辨
 *      （日语是拍为单位的语言，104 个音节能拼出任何假名串）
 *   3. 系统 TTS —— 万一以后装了支持日语的引擎，自动用上
 */

let manifest = null;
let k2k = null;          // 汉字 -> 假名词典
let k2kLoading = null;
let ctx = null;
const cache = new Map();      // 文件名 -> AudioBuffer
let loading = null;

function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

export async function loadManifest() {
  if (manifest) return manifest;
  if (loading) return loading;
  loading = fetch('./audio/manifest.json')
    .then((r) => (r.ok ? r.json() : null))
    .then((m) => { manifest = m || { phrases: {}, mora: {} }; return manifest; })
    .catch(() => { manifest = { phrases: {}, mora: {} }; return manifest; });
  return loading;
}

/**
 * 加载汉字→假名词典（22.6 万词条 + 单字兜底）。
 * 体积 7.9MB（APK 内压缩后约 2.3MB），首次用到时才加载，之后常驻。
 */
export async function loadDict() {
  if (k2k) return k2k;
  if (k2kLoading) return k2kLoading;
  k2kLoading = fetch('./data/k2k.json')
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      k2k = d ? { words: new Map(Object.entries(d.words)), single: new Map(Object.entries(d.single)), maxLen: d.maxLen || 12 }
              : { words: new Map(), single: new Map(), maxLen: 1 };
      return k2k;
    })
    .catch(() => { k2k = { words: new Map(), single: new Map(), maxLen: 1 }; return k2k; });
  return k2kLoading;
}

const IS_KANA = (c) => /[\u3040-\u309F\u30A0-\u30FFー]/.test(c);
const IS_KANJI = (c) => /[\u4E00-\u9FFF\u3005]/.test(c);
const KATA_TO_HIRA = (s2) => s2.replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

/**
 * 任意日语文本 -> 假名。词典最长匹配。
 *
 * 这不是形态分析，所以有明确局限，返回值里如实标出来：
 *   - 动词活用形（食べました）查不到原形，会退化成单字兜底
 *   - 同形多音（今日 きょう/こんにち）只能取词典里的第一个
 *   - 没有上下文消歧、没有音高重音
 * @returns {{kana:string, exact:boolean, unknown:string[], guessed:string[]}}
 *   exact=true 表示全部由词典/假名构成，没有用到单字推测
 */
export function toKana(text) {
  if (!k2k) return { kana: '', exact: false, unknown: [...text], guessed: [] };
  const out = [];
  const unknown = [];
  const guessed = [];
  const chars = [...text];
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    if (IS_KANA(c)) { out.push(KATA_TO_HIRA(c)); i++; continue; }
    if (!IS_KANJI(c)) {
      // 标点保留（拼读时会转成停顿），其他字符（数字/拉丁）无法朗读
      // 标点只在拼读时转成停顿，不写进假名串（否则显示出来会多个「、」）
      if (/[、。！？，,.!?\s]/.test(c)) out.push('\u0000');
      else unknown.push(c);
      i++;
      continue;
    }
    // 汉字：从最长往短试词典。
    //
    // 关键点：词条常带假名词尾（買った 的词典形是 買う，行くとき 里是 行く），
    // 所以匹配窗口要允许「汉字 + 后续假名」，否则会切错。
    // 实测过的两个错例：
    //   カメラを買った → 「ラを買」被当整体，買 单字读成 ばい
    //   本を           → 「本を」没命中，退化成单字取了训读 もと（应是 ほん）
    // 修法：① 片假名已在上面的 IS_KANA 分支处理，不会进这里
    //       ② 匹配时优先匹配到「汉字块 + 紧随的假名」，命中词典形就整段替换
    let hit = null, len = 0;
    const maxTry = Math.min(k2k.maxLen, chars.length - i);
    for (let L = maxTry; L >= 1; L--) {
      const seg = chars.slice(i, i + L).join('');
      // 只有以汉字开头的段才查词典，避免「ラを買」这种跨界切分
      if (!IS_KANJI(seg[0])) continue;
      const r = k2k.words.get(seg);
      if (r) { hit = r; len = L; break; }
    }
    if (hit) { out.push(KATA_TO_HIRA(hit)); i += len; continue; }

    // 词典没命中：试动词/形容词活用还原。
    //
    // 词典收的是辞书形（買う、食べる、行く），但正文里是活用形（買った、食べました）。
    // 做法：取连续汉字块 K，逐个试 K+辞书形词尾，命中后用「读音去掉最后一拍」当词干，
    // 再把原文的假名词尾接回去。
    //   買った → 试 買う=かう → 词干 か → か + った = かった ✓
    //   行きます → 试 行く=いく → 词干 い → い + きます = いきます ✓
    //   食べました → 试 食べる=たべる → 词干 たべ → たべ + ました = たべました ✓
    // 这不是完整形态分析（不处理音便和不规则），但能覆盖绝大多数常见活用。
    {
      let ke = i;
      while (ke < chars.length && IS_KANJI(chars[ke])) ke++;
      const K = chars.slice(i, ke).join('');
      let te = ke;
      while (te < chars.length && IS_KANA(chars[te])) te++;
      const tail = chars.slice(ke, te).join('');
      if (K && tail) {
        const ENDINGS = ['う', 'く', 'ぐ', 'す', 'つ', 'ぬ', 'ぶ', 'む', 'る', 'い'];
        for (const end of ENDINGS) {
          const r = k2k.words.get(K + end);
          if (!r || r.length < 2) continue;
          const stem = KATA_TO_HIRA(r).slice(0, -1);
          // 二类动词（食べる）辞书形是两拍以上的假名尾，词干要多去一位
          const dictTail = KATA_TO_HIRA(r).slice(-1);
          if (dictTail !== end) continue;
          out.push(stem + tail);
          i = te;
          break;
        }
        if (i === te) continue;
      }
    }

    // 再试一次连续汉字块整体（去掉尾部假名的干扰）
    let kEnd = i;
    while (kEnd < chars.length && IS_KANJI(chars[kEnd])) kEnd++;
    const kanjiBlock = chars.slice(i, kEnd).join('');
    if (kanjiBlock.length > 1) {
      const r2 = k2k.words.get(kanjiBlock);
      if (r2) { out.push(KATA_TO_HIRA(r2)); i = kEnd; continue; }
    }
    // 单字兜底。注意 KANJIDIC 的首选读音对复合词更准（音读），
    // 但单字成词时训读更常见 —— 这里无法消歧，所以标记为「推测」告知用户。
    const one = k2k.single.get(c);
    if (one) { out.push(KATA_TO_HIRA(one)); guessed.push(c); i++; continue; }
    unknown.push(c);
    i++;
  }
  // \u0000 是内部停顿标记，对外输出时去掉
  const joined = out.join('');
  return {
    kana: joined.replace(/\u0000/g, ''),
    kanaWithPause: joined,
    exact: guessed.length === 0 && unknown.length === 0,
    unknown, guessed,
  };
}

/** 预渲染音频是否覆盖这段文本（整句 或 全部假名都有音节） */
export function coverage(text, kana) {
  if (!manifest) return 'none';
  if (manifest.phrases && manifest.phrases[text]) return 'phrase';
  // 没给假名时，若词典已加载就现场转一次；这样任意汉字文本也能判定可读
  let src = kana;
  if (!src) {
    const t = k2k ? toKana(text) : null;
    src = t && t.kana ? t.kana : text;
  }
  const chars = [...src].filter((c) => /[\u3040-\u30FFー]/.test(c));
  if (!chars.length) return 'none';
  const mora = manifest.mora || {};
  // 允许小写拗音（ゃゅょ）和促音（っ）—— 它们靠拼接规则处理，不需要单独音节
  const ok = chars.every((c) => mora[c] || 'ゃゅょャュョっッんン ー'.includes(c));
  return ok ? 'mora' : 'none';
}

async function fetchBuf(dir, file) {
  const key = dir + '/' + file;
  if (cache.has(key)) return cache.get(key);
  const res = await fetch(`./audio/${dir}/${file}`);
  if (!res.ok) throw new Error('缺音频 ' + key);
  const buf = await audio().decodeAudioData(await res.arrayBuffer());
  cache.set(key, buf);
  return buf;
}

function playBuf(buf, when = 0, rate = 1) {
  const c = audio();
  const src = c.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = rate;
  src.connect(c.destination);
  src.start(when);
  return buf.duration / rate;
}

/** 播放整句预渲染音频 */
async function playPhrase(text) {
  const entry = manifest.phrases[text];
  const buf = await fetchBuf(manifest.phraseDir || 'phrases', entry.f);
  playBuf(buf, audio().currentTime + 0.02);
  return true;
}

/**
 * 假名音节拼接。
 * 处理三件事：拗音（きゃ 用「き」+「や」不对，退化成单独两拍会怪，
 * 所以拗音直接用 i 段音节 + 小写元音音节并压缩时长）、
 * 促音（っ 插一段静音）、长音（ー 把前一个音节放慢重播）。
 */
async function playMora(kana) {
  const mora = manifest.mora || {};
  const dir = manifest.moraDir || 'mora';
  const seq = [];
  const chars = [...kana];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const nx = chars[i + 1];
    if (c === '\u0000') { seq.push({ gap: 0.18 }); continue; }
    if (c === 'っ' || c === 'ッ') { seq.push({ gap: 0.12 }); continue; }
    if (c === 'ー') { const last = seq[seq.length - 1]; if (last && last.f) seq.push({ ...last, rate: 0.8 }); continue; }
    if (!mora[c]) { if (/[、。！？\s]/.test(c)) seq.push({ gap: 0.18 }); continue; }
    // 拗音：i 段 + 小写 ゃゅょ，两个都稍快，听起来更接近一个拍
    if (nx && 'ゃゅょャュョ'.includes(nx)) {
      seq.push({ f: mora[c].f, rate: 1.35 });
      const big = { ゃ: 'や', ゅ: 'ゆ', ょ: 'よ', ャ: 'や', ュ: 'ゆ', ョ: 'よ' }[nx];
      if (mora[big]) seq.push({ f: mora[big].f, rate: 1.2 });
      i++;
      continue;
    }
    seq.push({ f: mora[c].f, rate: 1.0 });
  }
  if (!seq.some((s) => s.f)) return false;

  // 先把所有需要的 buffer 取回来再排程，避免播到一半卡顿
  const files = [...new Set(seq.filter((s) => s.f).map((s) => s.f))];
  const bufs = {};
  await Promise.all(files.map(async (f) => { bufs[f] = await fetchBuf(dir, f); }));

  let t = audio().currentTime + 0.04;
  for (const s of seq) {
    if (s.gap) { t += s.gap; continue; }
    const d = playBuf(bufs[s.f], t, s.rate);
    // 稍微重叠，避免逐字顿挫
    t += Math.max(0.055, d * 0.86);
  }
  return true;
}

/**
 * 朗读日语。
 * @returns {Promise<'phrase'|'mora'|'system'|false>} 用了哪条路，false = 都不行
 */
export async function speakJa(text, kana, systemSpeak) {
  await loadManifest();
  audio();
  try {
    if (manifest.phrases && manifest.phrases[text]) {
      await playPhrase(text);
      return 'phrase';
    }
  } catch (e) { console.warn('整句音频播放失败', e); }
  try {
    // 没给假名（或给的假名里还有汉字）就查词典转一次 —— 任意文本都要能读
    let src = kana && ![...kana].some(IS_KANJI) ? kana : null;
    if (!src) {
      await loadDict();
      src = toKana(text).kanaWithPause;
    }
    if (src && (await playMora(src))) return 'mora';
  } catch (e) { console.warn('音节拼接失败', e); }
  if (typeof systemSpeak === 'function' && systemSpeak(text, 'ja-JP')) return 'system';
  return false;
}

/**
 * 读之前先问：这段文本能读成什么样。用于界面上如实标注，
 * 而不是让用户听完才发现读音是瞎猜的。
 */
export async function inspect(text) {
  await loadManifest();
  if (manifest.phrases && manifest.phrases[text]) {
    return { level: 'phrase', kana: (manifest.phrases[text] || {}).kana || '', note: '内置整句录音' };
  }
  await loadDict();
  const t = toKana(text);
  if (!t.kana) return { level: 'none', kana: '', note: '无法转成假名，读不出来', unknown: t.unknown };
  return {
    level: t.exact ? 'dict' : 'guess',
    kana: t.kana,
    guessed: t.guessed,
    unknown: t.unknown,
    note: t.exact
      ? '读音来自词典，逐音节拼读'
      : `有 ${t.guessed.length} 个字词典里没查到，按单字读音推测（可能不准）`,
  };
}

export function stopJa() {
  // BufferSource 无法统一停止，直接把 context 里的输出断掉最省事：
  // 重建一个 context，旧的会被 GC。相比逐个记录 source 更简单可靠。
  if (ctx) {
    try { ctx.close(); } catch (e) { void e; }
    ctx = null;
    cache.clear();
  }
}

/** 预渲染覆盖率统计，用于页面上如实展示能力 */
export async function stats() {
  await loadManifest();
  return {
    phrases: Object.keys(manifest.phrases || {}).length,
    mora: Object.keys(manifest.mora || {}).length,
    engine: manifest.engine || '',
  };
}
