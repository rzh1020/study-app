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
    desc: '听两个音，说出第二个比第一个高还是低。',
    kind: 'pair2',
    options: ['更高', '更低'],
    how: "听两个音，说出第二个比第一个高还是低。",
    demos: [{"label": "这是「更高」", "seq": [60, 72], "say": "第二个音明显更高"}, {"label": "这是「更低」", "seq": [72, 60], "say": "第二个音明显更低"}],
  },
  {
    id: 'same',
    name: '② 一样吗',
    tier: '入门',
    desc: '两个音是不是同一个音。',
    kind: 'same',
    options: ['一样', '不一样'],
    how: "两个音是不是同一个音。",
    demos: [{"label": "这是「一样」", "seq": [60, 60], "say": "两次完全相同"}, {"label": "这是「不一样」", "seq": [60, 65], "say": "第二个偏高一点"}],
  },
  {
    id: 'contour',
    name: '③ 走向',
    tier: '入门',
    desc: '三个音往哪走。',
    kind: 'contour',
    options: ['上行', '下行', '先上后下', '先下后上'],
    how: "三个音往哪走。",
    demos: [{"label": "上行", "seq": [60, 64, 67]}, {"label": "下行", "seq": [67, 64, 60]}, {"label": "先上后下", "seq": [60, 67, 62]}, {"label": "先下后上", "seq": [67, 60, 64]}],
  },
  {
    id: 'tri',
    name: '④ do mi sol',
    tier: '入门',
    desc: '大三和弦的三个音：do mi sol。',
    kind: 'degree3',
    how: "大三和弦的三个音：do mi sol。",
    demos: [{"label": "do", "seq": [60]}, {"label": "mi", "seq": [64]}, {"label": "sol", "seq": [67]}, {"label": "三个连起来", "seq": [60, 64, 67]}],
  },
  {
    id: 'degree',
    name: '⑤ 音级辨识',
    tier: '进阶',
    desc: '完整大调音阶里的第几级。',
    kind: 'degree',
    how: "完整大调音阶里的第几级。",
    demos: [{"label": "音阶上行 do→do", "seq": [60, 62, 64, 65, 67, 69, 71, 72]}],
  },
  {
    id: 'chord',
    name: '⑥ 和弦性质',
    tier: '进阶',
    desc: '和弦是明亮还是暗。',
    kind: 'chord',
    how: "和弦是明亮还是暗。",
    demos: [{"label": "大三和弦（明亮）", "chord": [60, 64, 67]}, {"label": "小三和弦（暗）", "chord": [60, 63, 67]}],
  },
  {
    id: 'interval',
    name: '⑦ 音程辨识',
    tier: '进阶',
    desc: '两个音差多远。',
    kind: 'interval',
    how: "两个音差多远。",
    demos: [{"label": "大三度《欢乐颂》", "seq": [60, 64]}, {"label": "纯五度《星球大战》", "seq": [60, 67]}, {"label": "纯八度", "seq": [60, 72]}],
  },
  {
    id: 'melody',
    name: '⑧ 旋律模唱',
    tier: '进阶',
    desc: '记住并认出一小段旋律。',
    kind: 'melody',
    how: "记住并认出一小段旋律。",
    demos: [{"label": "do mi sol", "seq": [60, 64, 67]}, {"label": "do sol mi", "seq": [60, 67, 64]}],
  },
  {
    id: 'rhythm',
    name: '⑨ 节奏辨识',
    tier: '进阶',
    desc: '节奏的长短组合。',
    kind: 'rhythm',
    how: "节奏的长短组合。",
    demos: [{"label": "四个四分", "beats": [1, 1, 1, 1]}, {"label": "八分连续", "beats": [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]}, {"label": "切分", "beats": [1, 2, 1]}],
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
