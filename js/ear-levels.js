/**
 * 练耳课程阶梯。
 *
 * 原来最低一档是「音级辨识」，但那已经要求听者具备相对音高感 —— 零基础只能乱猜，
 * 而乱猜不产生学习（没有可用的类别，误差信号无处可去）。
 *
 * 这里补上前四级，核心思路是把「听觉判别」拆到不需要任何先验知识的粒度：
 *   L1 高低    只需判断两个音谁高 —— 这是所有音高感知的地基，人人天生具备
 *   L2 同异    判断两个音是否相同，从 5 个半音差逐步收窄到 1 个
 *   L3 方向    三个音的走向（上行/下行/波浪/平），开始处理序列
 *   L4 三音音级 只在 do-mi-sol 三个音里选，固定主音
 * 然后才接原有的 音级 → 和弦 → 音程 → 旋律 → 节奏。
 *
 * 另外三条对零基础很关键的设计：
 * 1. 入门级固定主音（永远 C4）。随机主音要求相对音高，是进阶能力。
 * 2. 每级都有「熟悉模式」：先播放并直接显示答案，可无限重听，建立听感锚点。
 *    这不与「先猜后看答案」矛盾 —— 那条讲的是测试阶段；没有类别时得先靠
 *    暴露建立类别，再用提取练习强化。
 * 3. 自适应解锁：连续正确率达标才开下一级，避免在够不着的难度上耗时间。
 */

import { parseNote } from './pitch.js';

export const FIXED_ROOT = parseNote('C4'); // 入门级固定主音

/** 通关判据：最近 N 题里正确率达到 acc 才解锁下一级 */
export const UNLOCK = { window: 12, acc: 0.85 };

export const LEVELS = [
  {
    id: 'highlow',
    name: '① 哪个音高',
    tier: '入门',
    desc: '听两个音，判断第二个比第一个高还是低。不需要任何乐理基础，人人天生能分辨。',
    why: '这是所有音高判别的地基。听不出高低就谈不上音准，练这个的收益最直接。',
    kind: 'pair2',
    options: ['更高', '更低'],
  },
  {
    id: 'same',
    name: '② 一样吗',
    tier: '入门',
    desc: '两个音是否完全相同。差距会随正确率从 5 个半音逐步收窄到 1 个半音。',
    why: '训练分辨阈值。能稳定听出 1 个半音的差别，才有资格谈音准。',
    kind: 'same',
    options: ['一样', '不一样'],
  },
  {
    id: 'contour',
    name: '③ 走向',
    tier: '入门',
    desc: '三个音的走向：一路上行、一路下行、先上后下、先下后上。',
    why: '从单个音过渡到序列。唱歌跟不上旋律，多半是走向感没建立。',
    kind: 'contour',
    options: ['上行', '下行', '先上后下', '先下后上'],
  },
  {
    id: 'tri',
    name: '④ do mi sol',
    tier: '入门',
    desc: '只在 do、mi、sol 三个音里选。主音固定在 C4，每题都会先给 do 作参考。',
    why: '大三和弦的三个音是调性感的骨架。先把这三个听熟，再扩到七个音。',
    kind: 'degree3',
  },
  {
    id: 'degree',
    name: '⑤ 音级辨识',
    tier: '进阶',
    desc: '完整大调音阶里判断第几级。前期固定主音，正确率上来后改为随机主音。',
    why: '首调听感的核心。到这一步才算真正在建立相对音高。',
    kind: 'degree',
  },
  {
    id: 'chord',
    name: '⑥ 和弦性质',
    tier: '进阶',
    desc: '大三 / 小三，之后加入减三、增三。',
    why: '流行歌 90% 只有大小三和弦。听出明暗，就能跟着和声走。',
    kind: 'chord',
  },
  {
    id: 'interval',
    name: '⑦ 音程辨识',
    tier: '进阶',
    desc: '两个音差几度。先 2/3/5/8 度，再补 4/6/7 度。',
    why: '视唱与和声分析的基础单位。',
    kind: 'interval',
  },
  {
    id: 'melody',
    name: '⑧ 旋律模唱',
    tier: '进阶',
    desc: '听 3-4 个音的短句，选出对应的音级序列。',
    why: '把单音能力串成句子，直接迁移到学新歌。',
    kind: 'melody',
  },
  {
    id: 'rhythm',
    name: '⑨ 节奏辨识',
    tier: '进阶',
    desc: '听一小节节奏，选出节奏型。切分感是流行歌的关键。',
    why: '节奏不稳比音准不稳更破坏「好听」的感觉，但常被忽略。',
    kind: 'rhythm',
  },
];

export const LEVEL_BY_ID = Object.fromEntries(LEVELS.map((l) => [l.id, l]));

/**
 * 根据历史记录算每级的解锁状态与最近正确率。
 * 第一级永远解锁；后续级要求前一级最近 window 题正确率达标。
 */
export function levelProgress(logs) {
  const byLevel = {};
  for (const l of LEVELS) byLevel[l.id] = [];
  for (const r of logs) {
    if (byLevel[r.mode]) byLevel[r.mode].push(r);
  }
  const out = {};
  let prevPassed = true;
  for (const l of LEVELS) {
    const rows = byLevel[l.id].sort((a, b) => a.ts - b.ts);
    const recent = rows.slice(-UNLOCK.window);
    const acc = recent.length ? recent.filter((r) => r.correct).length / recent.length : null;
    const passed = recent.length >= UNLOCK.window && acc >= UNLOCK.acc;
    out[l.id] = {
      total: rows.length,
      recentN: recent.length,
      acc,
      allAcc: rows.length ? rows.filter((r) => r.correct).length / rows.length : null,
      passed,
      unlocked: prevPassed,
    };
    prevPassed = prevPassed && passed;
  }
  return out;
}

/** 建议下一个该练的级：第一个「已解锁但还没通关」的 */
export function suggestLevel(progress) {
  for (const l of LEVELS) {
    const p = progress[l.id];
    if (p.unlocked && !p.passed) return l.id;
  }
  return LEVELS[LEVELS.length - 1].id;
}

/**
 * 「同异」级的半音差随表现自适应：
 * 答对就收窄，答错就放宽。这样难度始终贴着你的分辨阈值，
 * 既不会一直太简单（无增益）也不会一直听不出（乱猜）。
 */
export function nextSameGap(recentLogs) {
  const recent = recentLogs.filter((r) => r.mode === 'same').slice(-6);
  if (recent.length < 3) return 5;
  const acc = recent.filter((r) => r.correct).length / recent.length;
  const lastGap = recent.map((r) => Number(r.gap)).filter((g) => Number.isFinite(g) && g > 0).pop() || 5;
  if (acc >= 0.85) return Math.max(1, lastGap - 1);
  if (acc < 0.6) return Math.min(7, lastGap + 1);
  return lastGap;
}
