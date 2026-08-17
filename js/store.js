/**
 * 业务层：把 data/*.json 种成卡、组队列、记录复习、算统计。
 *
 * 关键设计：种卡是「合并」而非「覆盖」。以后往 data 里加词，重新种卡时
 * 已有卡的记忆状态（stability/difficulty/due）必须保留，否则一次数据更新
 * 就把几个月的复习进度清零了。
 */
import { db, metaGet, metaSet, dayKey, dayStart } from './db.js';
import { schedule, newCardState, STATE, previewIntervals } from './fsrs.js';

export const DECKS = {
  kana_hira: { name: '平假名', hint: '看假名读音', group: '日语', order: 1 },
  kana_kata: { name: '片假名', hint: '看假名读音', group: '日语', order: 2 },
  kana_rule: { name: '发音规则', hint: '促音/长音/助词变音', group: '日语', order: 3 },
  vocab_jp2cn: { name: '词汇 日→中', hint: '识别（听懂动漫靠这个）', group: '日语', order: 4 },
  vocab_cn2jp: { name: '词汇 中→日', hint: '产出（想说出来才需要）', group: '日语', order: 5 },
  grammar: { name: '语法', hint: 'N5 语法点', group: '日语', order: 6 },
  theory: { name: '声乐/乐理', hint: '科普与原理', group: '声乐', order: 7 },
};

export const DEFAULT_CONFIG = {
  requestRetention: 0.9,
  a4: 440,
  newPerDay: {
    kana_hira: 12, kana_kata: 8, kana_rule: 2,
    vocab_jp2cn: 12, vocab_cn2jp: 0, grammar: 2, theory: 3,
  },
  enabled: {
    kana_hira: true, kana_kata: true, kana_rule: true,
    vocab_jp2cn: true, vocab_cn2jp: false, grammar: true, theory: true,
  },
  earDailyTarget: 20,
  voiceDailyMin: 15,
};

export async function getConfig() {
  const saved = (await metaGet('config')) || {};
  return {
    ...DEFAULT_CONFIG,
    ...saved,
    newPerDay: { ...DEFAULT_CONFIG.newPerDay, ...(saved.newPerDay || {}) },
    enabled: { ...DEFAULT_CONFIG.enabled, ...(saved.enabled || {}) },
  };
}
export async function setConfig(patch) {
  const cur = (await metaGet('config')) || {};
  await metaSet('config', { ...cur, ...patch });
}

// ---------- 种卡 ----------

function mk(id, deck, seq, front, back, extra = {}) {
  return { id, deck, seq, front, back, extra, suspended: 0, ...newCardState() };
}

export async function buildSeedCards() {
  const [kana, vocab, grammar, theory] = await Promise.all([
    fetch('./data/kana.json').then((r) => r.json()),
    fetch('./data/vocab.json').then((r) => r.json()),
    fetch('./data/grammar.json').then((r) => r.json()),
    fetch('./data/theory.json').then((r) => r.json()),
  ]);

  const out = [];
  // 假名按「清音 → 浊音 → 拗音」的顺序引入，与 12 周计划一致
  const tagOrder = { seion: 0, dakuon: 1, yoon: 2 };
  const kanaSorted = [...kana.cards].sort(
    (a, b) => tagOrder[a.tag] - tagOrder[b.tag] || a.id.localeCompare(b.id)
  );
  kanaSorted.forEach((c, i) => {
    out.push(mk(`kh-${c.id}`, 'kana_hira', i + 1, c.hira, c.romaji, { kata: c.kata, group: c.group, tag: c.tag }));
    out.push(mk(`kk-${c.id}`, 'kana_kata', i + 1, c.kata, c.romaji, { hira: c.hira, group: c.group, tag: c.tag }));
  });
  kana.rules.forEach((r, i) => out.push(mk(`kr-${r.id}`, 'kana_rule', i + 1, r.title, r.body)));

  const stageOrder = { s1: 1, s2: 2, s3: 3, s4: 4, s5: 5 };
  const vSorted = [...vocab.vocab].sort(
    (a, b) => stageOrder[a.stage] - stageOrder[b.stage] || a.id.localeCompare(b.id)
  );
  vSorted.forEach((v, i) => {
    const ex = { kana: v.kana, romaji: v.romaji, pos: v.pos, exJp: v.exJp, exCn: v.exCn, stage: v.stage };
    out.push(mk(`vj-${v.id}`, 'vocab_jp2cn', i + 1, v.jp, v.cn, ex));
    out.push(mk(`vc-${v.id}`, 'vocab_cn2jp', i + 1, v.cn, v.jp, ex));
  });

  const gSorted = [...grammar.grammar].sort((a, b) => stageOrder[a.stage] - stageOrder[b.stage] || a.id.localeCompare(b.id));
  gSorted.forEach((g, i) =>
    out.push(mk(`g-${g.id}`, 'grammar', i + 1, g.title, g.cn, { pattern: g.pattern, ex: g.ex, note: g.note, stage: g.stage }))
  );

  theory.theory.forEach((t, i) => out.push(mk(`t-${t.id}`, 'theory', i + 1, t.q, t.a, { cat: t.cat })));

  return out;
}

/** 合并种卡：新增缺失的卡，更新已有卡的正反面内容，但保留记忆状态 */
export async function seed() {
  const seeds = await buildSeedCards();
  const existing = await db.all('cards');
  const byId = new Map(existing.map((c) => [c.id, c]));
  const toPut = [];
  let added = 0, updated = 0;
  for (const s of seeds) {
    const old = byId.get(s.id);
    if (!old) { toPut.push(s); added++; continue; }
    if (old.front !== s.front || old.back !== s.back || JSON.stringify(old.extra) !== JSON.stringify(s.extra) || old.seq !== s.seq) {
      toPut.push({ ...old, front: s.front, back: s.back, extra: s.extra, seq: s.seq });
      updated++;
    }
  }
  if (toPut.length) await db.putMany('cards', toPut);
  await metaSet('lastSeed', Date.now());
  return { added, updated, total: seeds.length };
}

// ---------- 队列 ----------

async function newDoneToday() {
  return (await metaGet('newDone:' + dayKey())) || {};
}

/**
 * 组今天的学习队列。
 * 排序策略：到期的学习/重学卡最优先（它们在分钟级窗口内，错过就废了），
 * 然后是到期复习卡，最后按配额插入新卡。
 */
export async function getQueue(deckFilter = null, now = Date.now()) {
  const cfg = await getConfig();
  const done = await newDoneToday();
  const all = await db.all('cards');
  const decks = deckFilter ? [deckFilter] : Object.keys(DECKS).filter((d) => cfg.enabled[d]);
  const set = new Set(decks);

  const learn = [], review = [], fresh = [];
  for (const c of all) {
    if (c.suspended || !set.has(c.deck)) continue;
    if (c.state === STATE.NEW) fresh.push(c);
    else if (c.due <= now) (c.state === STATE.REVIEW ? review : learn).push(c);
  }
  learn.sort((a, b) => a.due - b.due);
  review.sort((a, b) => a.due - b.due);
  fresh.sort((a, b) => a.deck.localeCompare(b.deck) || a.seq - b.seq);

  // 按每个 deck 的剩余配额挑新卡
  const quotaLeft = {};
  for (const d of decks) quotaLeft[d] = Math.max((cfg.newPerDay[d] || 0) - (done[d] || 0), 0);
  const newPicked = [];
  for (const c of fresh) {
    if (quotaLeft[c.deck] > 0) { newPicked.push(c); quotaLeft[c.deck]--; }
  }

  // 交错：每 3 张到期卡插 1 张新卡，避免开头连着一堆陌生内容
  const dueAll = [...learn, ...review];
  const queue = [];
  let ni = 0, di = 0;
  while (di < dueAll.length || ni < newPicked.length) {
    for (let k = 0; k < 3 && di < dueAll.length; k++) queue.push(dueAll[di++]);
    if (ni < newPicked.length) queue.push(newPicked[ni++]);
    if (di >= dueAll.length) while (ni < newPicked.length) queue.push(newPicked[ni++]);
  }
  return { queue, counts: { learn: learn.length, review: review.length, new: newPicked.length } };
}

export async function deckStats(now = Date.now()) {
  const cfg = await getConfig();
  const done = await newDoneToday();
  const all = await db.all('cards');
  const out = {};
  for (const d of Object.keys(DECKS)) {
    out[d] = { total: 0, new: 0, due: 0, learning: 0, young: 0, mature: 0, newLeft: 0, enabled: !!cfg.enabled[d] };
  }
  for (const c of all) {
    const s = out[c.deck];
    if (!s || c.suspended) continue;
    s.total++;
    if (c.state === STATE.NEW) s.new++;
    else {
      if (c.due <= now) s.due++;
      if (c.state === STATE.LEARNING || c.state === STATE.RELEARNING) s.learning++;
      else if (c.scheduledDays < 21) s.young++;
      else s.mature++;
    }
  }
  for (const d of Object.keys(DECKS)) {
    out[d].newLeft = Math.min(Math.max((cfg.newPerDay[d] || 0) - (done[d] || 0), 0), out[d].new);
  }
  return out;
}

export function previewFor(card, now = Date.now(), cfg = {}) {
  return previewIntervals(card, now, { requestRetention: cfg.requestRetention ?? 0.9 });
}

/** 记一次复习：更新卡状态 + 写日志 + 计新卡配额 */
export async function reviewCard(card, grade, now = Date.now()) {
  const cfg = await getConfig();
  const wasNew = card.state === STATE.NEW;
  const next = schedule(card, grade, now, { requestRetention: cfg.requestRetention });
  const merged = { ...card, ...next };
  await db.put('cards', merged);
  await db.add('reviews', {
    ts: now, cardId: card.id, deck: card.deck, grade,
    prevState: card.state, newState: next.state,
    scheduledDays: next.scheduledDays, stability: +next.stability.toFixed(3),
  });
  if (wasNew) {
    const k = 'newDone:' + dayKey(now);
    const done = (await metaGet(k)) || {};
    done[card.deck] = (done[card.deck] || 0) + 1;
    await metaSet(k, done);
  }
  return merged;
}

// ---------- 统计 ----------

/**
 * 近 days 天：每天复习总数 + 真实保持率。
 *
 * 保持率只统计「复习前已处于 REVIEW 状态」的卡：初学阶段点忘了是正常摸索，
 * 混进去会把保持率压到 60% 以下，让「是否该调整目标保持率」失去判断依据。
 * 这与 Anki 的 true retention 口径一致。
 */
export async function reviewHistory(days = 30) {
  const from = dayStart() - (days - 1) * 86400000;
  const rows = await db.byIndex('reviews', 'ts', IDBKeyRange.lowerBound(from));
  const map = new Map();
  for (let i = 0; i < days; i++) {
    map.set(dayKey(from + i * 86400000), { total: 0, mature: 0, matureAgain: 0 });
  }
  for (const r of rows) {
    const k = dayKey(r.ts);
    if (!map.has(k)) continue;
    const e = map.get(k);
    e.total++;
    if (r.prevState === STATE.REVIEW) {
      e.mature++;
      if (r.grade === 1) e.matureAgain++;
    }
  }
  return [...map.entries()].map(([day, v]) => ({
    day,
    total: v.total,
    reviewed: v.mature,
    again: v.matureAgain,
    retention: v.mature ? 1 - v.matureAgain / v.mature : null,
  }));
}

/** 连续学习天数（今天没学则从昨天往前数，不打断 streak 显示） */
export async function streak() {
  const rows = await db.byIndex('reviews', 'ts', IDBKeyRange.lowerBound(dayStart() - 400 * 86400000));
  const daysSet = new Set(rows.map((r) => dayKey(r.ts)));
  const voice = await db.all('voice');
  for (const v of voice) daysSet.add(dayKey(v.ts));
  let n = 0;
  let t = Date.now();
  if (!daysSet.has(dayKey(t))) t -= 86400000;
  while (daysSet.has(dayKey(t))) { n++; t -= 86400000; }
  return { days: n, todayDone: daysSet.has(dayKey()) };
}

export async function todayReviewCount() {
  const rows = await db.byIndex('reviews', 'ts', IDBKeyRange.lowerBound(dayStart()));
  return rows.length;
}

/** 导出全部数据（录音 Blob 不含在内，太大；单独导出） */
export async function exportAll() {
  const [cards, reviews, earlog, voice, meta] = await Promise.all([
    db.all('cards'), db.all('reviews'), db.all('earlog'), db.all('voice'), db.all('meta'),
  ]);
  return {
    app: 'study-app', version: 1, exportedAt: new Date().toISOString(),
    cards, reviews, earlog,
    voice: voice.map(({ audio, ...rest }) => { void audio; return rest; }),
    meta,
  };
}

export async function importAll(obj, { merge = true } = {}) {
  if (!obj || obj.app !== 'study-app') throw new Error('不是本应用的备份文件');
  if (!merge) {
    await Promise.all([db.clear('cards'), db.clear('reviews'), db.clear('earlog'), db.clear('voice'), db.clear('meta')]);
  }
  const stats = {};
  for (const [store, rows] of [['cards', obj.cards], ['reviews', obj.reviews], ['earlog', obj.earlog], ['voice', obj.voice], ['meta', obj.meta]]) {
    if (!Array.isArray(rows) || !rows.length) continue;
    // 自增主键的表在 merge 模式下去掉 id，避免和现有记录撞键
    const prepared = merge && store !== 'cards' && store !== 'meta'
      ? rows.map(({ id, ...rest }) => { void id; return rest; })
      : rows;
    for (const r of prepared) await db.put(store, r).catch(() => db.add(store, r));
    stats[store] = prepared.length;
  }
  return stats;
}

/**
 * 从 TSV 导入自定义词表（把动漫台词/别处的词表做成卡）。
 * 每行：正面<TAB>背面[<TAB>备注]
 */
export async function importTSV(text, deck = 'vocab_jp2cn', prefix = 'u') {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const existing = await db.all('cards');
  let maxSeq = 0;
  for (const c of existing) if (c.deck === deck && c.seq > maxSeq) maxSeq = c.seq;
  const ids = new Set(existing.map((c) => c.id));
  const cards = [];
  let skipped = 0;
  for (const line of lines) {
    const [front, back, note] = line.split('\t').map((x) => (x || '').trim());
    if (!front || !back) { skipped++; continue; }
    const id = `${prefix}-${deck}-${hash(front + '|' + back)}`;
    if (ids.has(id)) { skipped++; continue; }
    ids.add(id);
    cards.push(mk(id, deck, ++maxSeq, front, back, { note: note || '', custom: true }));
  }
  if (cards.length) await db.putMany('cards', cards);
  return { added: cards.length, skipped };
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
