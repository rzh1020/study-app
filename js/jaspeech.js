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

/** 预渲染音频是否覆盖这段文本（整句 或 全部假名都有音节） */
export function coverage(text, kana) {
  if (!manifest) return 'none';
  if (manifest.phrases && manifest.phrases[text]) return 'phrase';
  const src = kana || text;
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
    const src = kana || text;
    if (coverage(text, src) === 'mora' && (await playMora(src))) return 'mora';
  } catch (e) { console.warn('音节拼接失败', e); }
  if (typeof systemSpeak === 'function' && systemSpeak(text, 'ja-JP')) return 'system';
  return false;
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
