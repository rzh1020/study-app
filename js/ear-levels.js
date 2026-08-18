/**
 * 练耳课程阶梯。
 *
 * 上一版是「抽象比较两个音」起步，这不是课堂上的教法。真实的视唱练耳有两条
 * 被反复验证的原则，之前都没做：
 *
 * 1. **先建立调性语境，再辨认音**（functional ear training 的核心）。
 *    课堂上不会孤零零丢两个音让你比高低 —— 而是先弹 I-V-I 之类的和声进行
 *    把「do 在哪」钉住，再让你判断听到的音是第几级。
 *    没有调性锚点时，绝对音高只有少数人有，多数人只能猜；
 *    有了锚点，判断变成「它相对 do 在哪」，这是可练的能力。
 *
 * 2. **唱回来，而不是做选择题**（视唱与练耳是一件事的两面）。
 *    唱出来才能暴露「听到了但唱不到」这一类问题，而选择题会被蒙对掩盖。
 *    本项目已经有麦克风和音高检测，所以第一级直接用唱。
 *
 * 另外把「一屏 8 把锁」去掉了 —— 那既打击人也像坏了。只展示当前和下一级。
 */

import { parseNote } from './pitch.js';

export const FIXED_ROOT = parseNote('C4'); // 入门级固定主音

/** 通关判据：最近 N 题里正确率达到 acc 才解锁下一级 */
export const UNLOCK = { window: 12, acc: 0.85 };

export const LEVELS = [
  {
    id: 'singback',
    name: "① 唱回来",
    tier: '入门',
    desc: '听一个音，用「啊」把它唱回来。系统听你唱的对不对。',
    how: '听一个音，唱回同一个音。',
    kind: 'singback',
    needsMic: true,
    demos: [
      { label: '会先弹一个音给你', seq: [60] },
      { label: '然后你唱同一个音', seq: [60] },
    ],
  },
  {
    id: 'isdo',
    name: "② 这是 do 吗",
    tier: '入门',
    desc: '先听一段和声把调性钉住，再听一个音，判断它是不是 do（主音）。',
    how: '先听和声定调，再判断是不是 do。',
    kind: 'isdo',
    options: ['是 do', '不是 do'],
    demos: [
      { label: '先听这段和声（定调）', cadence: true },
      { label: '这个是 do', cadence: true, degree: 0 },
      { label: '这个不是 do', cadence: true, degree: 4 },
    ],
  },
  {
    id: 'highlow',
    name: "③ 哪个音高",
    tier: '入门',
    desc: '听两个音，说出第二个比第一个高还是低。',
    kind: 'pair2',
    options: ['更高', '更低'],
    how: "听两个音，说出第二个比第一个高还是低。",
    demos: [{"label": "这是「更高」", "seq": [60, 72], "say": "第二个音明显更高"}, {"label": "这是「更低」", "seq": [72, 60], "say": "第二个音明显更低"}],
  },
  {
    id: 'same',
    name: "④ 一样吗",
    tier: '入门',
    desc: '两个音是不是同一个音。',
    kind: 'same',
    options: ['一样', '不一样'],
    how: "两个音是不是同一个音。",
    demos: [{"label": "这是「一样」", "seq": [60, 60], "say": "两次完全相同"}, {"label": "这是「不一样」", "seq": [60, 65], "say": "第二个偏高一点"}],
  },
  {
    id: 'contour',
    name: "⑤ 走向",
    tier: '入门',
    desc: '三个音往哪走。',
    kind: 'contour',
    options: ['上行', '下行', '先上后下', '先下后上'],
    how: "三个音往哪走。",
    demos: [{"label": "上行", "seq": [60, 64, 67]}, {"label": "下行", "seq": [67, 64, 60]}, {"label": "先上后下", "seq": [60, 67, 62]}, {"label": "先下后上", "seq": [67, 60, 64]}],
  },
  {
    id: 'tri',
    name: "⑥ do mi sol",
    tier: '入门',
    desc: '大三和弦的三个音：do mi sol。',
    kind: 'degree3',
    cadence: true,
    how: "大三和弦的三个音：do mi sol。",
    demos: [{"label": "do", "seq": [60]}, {"label": "mi", "seq": [64]}, {"label": "sol", "seq": [67]}, {"label": "三个连起来", "seq": [60, 64, 67]}],
  },
  {
    id: 'degree',
    name: "⑦ 音级辨识",
    tier: '进阶',
    desc: '完整大调音阶里的第几级。',
    kind: 'degree',
    cadence: true,
    how: "完整大调音阶里的第几级。",
    demos: [{"label": "音阶上行 do→do", "seq": [60, 62, 64, 65, 67, 69, 71, 72]}],
  },
  {
    id: 'chord',
    name: "⑧ 和弦性质",
    tier: '进阶',
    desc: '和弦是明亮还是暗。',
    kind: 'chord',
    how: "和弦是明亮还是暗。",
    demos: [{"label": "大三和弦（明亮）", "chord": [60, 64, 67]}, {"label": "小三和弦（暗）", "chord": [60, 63, 67]}],
  },
  {
    id: 'interval',
    name: "⑨ 音程辨识",
    tier: '进阶',
    desc: '两个音差多远。',
    kind: 'interval',
    how: "两个音差多远。",
    demos: [{"label": "大三度《欢乐颂》", "seq": [60, 64]}, {"label": "纯五度《星球大战》", "seq": [60, 67]}, {"label": "纯八度", "seq": [60, 72]}],
  },
  {
    id: 'melody',
    name: "⑩ 旋律模唱",
    tier: '进阶',
    desc: '记住并认出一小段旋律。',
    kind: 'melody',
    how: "记住并认出一小段旋律。",
    demos: [{"label": "do mi sol", "seq": [60, 64, 67]}, {"label": "do sol mi", "seq": [60, 67, 64]}],
  },
  {
    id: 'rhythm',
    name: "⑪ 节奏辨识",
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
