/**
 * FSRS-5 调度器（Free Spaced Repetition Scheduler）
 *
 * 为什么用 FSRS 而不是 SM-2：SM-2 只看「上次间隔 × 难度系数」，
 * FSRS 把记忆拆成 stability(S, 记忆保持多久) 和 difficulty(D, 这张卡多难)
 * 两个状态量，用可提取性 R(t,S) 反推下一次该在什么时候复习，
 * 使实际保持率收敛到你设定的 requestRetention。实测比 SM-2 少 20~30% 复习量。
 *
 * 纯函数、无依赖，可在 node 里直接单测。
 *
 * 注意 4.5 和 5 的初始难度公式不同（线性 vs 指数），参数不能混用：
 *   4.5: D0(G) = w4 - w5*(G-3)          17 个参数
 *   5  : D0(G) = w4 - e^(w5*(G-1)) + 1  19 个参数，多出的 w17/w18 管同日重复
 * 这里统一用 5。
 */

// 官方 FSRS-5 默认权重（w0..w18）
export const DEFAULT_W = [
  0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046,
  1.54575, 0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315,
  2.9898, 0.51655, 0.6621,
];

const DECAY = -0.5;
const FACTOR = Math.pow(0.9, 1 / DECAY) - 1; // = 19/81

// 评分
export const RATING = { AGAIN: 1, HARD: 2, GOOD: 3, EASY: 4 };
export const STATE = { NEW: 0, LEARNING: 1, REVIEW: 2, RELEARNING: 3 };

const clampD = (d) => Math.min(Math.max(d, 1), 10);

/** 可提取性：距上次复习 t 天、稳定度 S 时，还能想起来的概率 */
export function retrievability(elapsedDays, stability) {
  if (stability <= 0) return 0;
  return Math.pow(1 + FACTOR * (elapsedDays / stability), DECAY);
}

/** 由目标保持率反解间隔天数 */
function nextInterval(stability, requestRetention, maximumInterval) {
  const ivl = (stability / FACTOR) * (Math.pow(requestRetention, 1 / DECAY) - 1);
  return Math.min(Math.max(Math.round(ivl), 1), maximumInterval);
}

function initStability(w, grade) {
  return Math.max(w[grade - 1], 0.1);
}

function initDifficulty(w, grade) {
  return clampD(w[4] - Math.exp(w[5] * (grade - 1)) + 1);
}

function nextDifficulty(w, d, grade) {
  const deltaD = -w[6] * (grade - 3);
  const dp = d + deltaD * ((10 - d) / 9); // 线性阻尼：越难越难再变难
  // 均值回归，防止 D 单向漂移锁死
  return clampD(w[7] * initDifficulty(w, RATING.EASY) + (1 - w[7]) * dp);
}

function stabilityAfterRecall(w, d, s, r, grade) {
  const hardPenalty = grade === RATING.HARD ? w[15] : 1;
  const easyBonus = grade === RATING.EASY ? w[16] : 1;
  return (
    s *
    (1 +
      Math.exp(w[8]) *
        (11 - d) *
        Math.pow(s, -w[9]) *
        (Math.exp(w[10] * (1 - r)) - 1) *
        hardPenalty *
        easyBonus)
  );
}

function stabilityAfterForget(w, d, s, r) {
  const sMin = w[11] * Math.pow(d, -w[12]) * (Math.pow(s + 1, w[13]) - 1) * Math.exp(w[14] * (1 - r));
  // FSRS-4.5+：遗忘后的稳定度不应超过遗忘前
  return Math.max(Math.min(sMin, s), 0.1);
}

/** FSRS-5 新增：同一天内再次复习（学习/重学阶段的连续点击）走短期公式 */
function stabilityShortTerm(w, s, grade) {
  return Math.max(s * Math.exp(w[17] * (grade - 3 + w[18])), 0.1);
}

/**
 * 复习一张卡，返回新的记忆状态。
 * @param {{state:number,stability:number,difficulty:number,due:number,lastReview:number,reps:number,lapses:number}} card
 * @param {number} grade 1=again 2=hard 3=good 4=easy
 * @param {number} now epoch ms
 * @param {{w?:number[],requestRetention?:number,maximumInterval?:number,learnSteps?:number[],relearnSteps?:number[]}} opt
 */
export function schedule(card, grade, now = Date.now(), opt = {}) {
  const w = opt.w || DEFAULT_W;
  const requestRetention = opt.requestRetention ?? 0.9;
  const maximumInterval = opt.maximumInterval ?? 36500;
  // 学习阶段用固定的分钟级步进，避免新卡第一天就被推到几天后
  const learnSteps = opt.learnSteps || [1, 10];      // 分钟
  const relearnSteps = opt.relearnSteps || [10];     // 分钟

  const MIN = 60 * 1000;
  const DAY = 24 * 60 * 60 * 1000;
  const out = { ...card };
  out.reps = (card.reps || 0) + 1;
  out.lastReview = now;

  const isNew = !card.state || card.state === STATE.NEW || !card.stability;

  if (isNew) {
    out.difficulty = initDifficulty(w, grade);
    out.stability = initStability(w, grade);
    if (grade === RATING.EASY) {
      out.state = STATE.REVIEW;
      out.scheduledDays = nextInterval(out.stability, requestRetention, maximumInterval);
      out.due = now + out.scheduledDays * DAY;
    } else {
      out.state = STATE.LEARNING;
      out.scheduledDays = 0;
      if (grade === RATING.AGAIN) {
        out.step = 0;
        out.due = now + learnSteps[0] * MIN;
      } else if (grade === RATING.HARD) {
        // 停在当前步，但延迟取两步的中间值。
        // 否则 Hard 和 Good 都会排到 learnSteps[1]，四个按钮里有两个完全等价，
        // 用户就失去了「有点吃力」这一档的表达能力。
        out.step = 0;
        out.due = now + (learnSteps.length > 1 ? (learnSteps[0] + learnSteps[1]) / 2 : learnSteps[0] * 1.5) * MIN;
      } else {
        out.step = Math.min(1, learnSteps.length - 1);
        out.due = now + learnSteps[out.step] * MIN;
      }
    }
    if (grade === RATING.AGAIN) out.lapses = (card.lapses || 0) + 1;
    return out;
  }

  const elapsedDays = Math.max((now - (card.lastReview || now)) / DAY, 0);
  const r = retrievability(elapsedDays, card.stability);
  out.difficulty = nextDifficulty(w, card.difficulty, grade);

  if (grade === RATING.AGAIN) {
    // lapse 只统计「已毕业的卡又忘了」。初学阶段点忘了不算 lapse，
    // 否则保持率统计会被初学的正常摸索污染，失去参考价值。
    if (card.state === STATE.REVIEW) out.lapses = (card.lapses || 0) + 1;
    out.stability = stabilityAfterForget(w, card.difficulty, card.stability, r);
    out.scheduledDays = 0;
    out.step = 0;
    if (card.state === STATE.LEARNING) {
      // 还在初学就忘了 → 退回第一个学习步（1 分钟），不是进重学。
      // 重学步进是给「已毕业的卡失手」用的，两者难度不同。
      out.state = STATE.LEARNING;
      out.due = now + learnSteps[0] * MIN;
    } else {
      out.state = STATE.RELEARNING;
      out.due = now + relearnSteps[0] * MIN;
    }
    return out;
  }

  // 同一天内的再次复习（典型是学习阶段连点）走短期公式：
  // 长期公式在 R≈1 时增益趋 0，会导致学习阶段稳定度原地踏步。
  out.stability = elapsedDays < 1
    ? stabilityShortTerm(w, card.stability, grade)
    : stabilityAfterRecall(w, card.difficulty, card.stability, r, grade);

  // 学习/重学阶段：走完 steps 才毕业进 review
  if (card.state === STATE.LEARNING || card.state === STATE.RELEARNING) {
    const steps = card.state === STATE.LEARNING ? learnSteps : relearnSteps;
    const cur = card.step || 0;
    if (grade === RATING.HARD) {
      // 停在当前步，延迟取当前步与下一步的中间值（末步则 ×1.5）。
      // 若直接重复当前步的延迟，Hard 会和 Again 撞成同一个间隔。
      out.state = card.state;
      out.step = cur;
      out.scheduledDays = 0;
      const delay = cur + 1 < steps.length ? (steps[cur] + steps[cur + 1]) / 2 : steps[cur] * 1.5;
      out.due = now + delay * MIN;
      return out;
    }
    if (grade === RATING.GOOD && cur + 1 < steps.length) {
      out.state = card.state;
      out.step = cur + 1;
      out.scheduledDays = 0;
      out.due = now + steps[cur + 1] * MIN;
      return out;
    }
    // GOOD 走到最后一步、或 EASY：毕业，落到下面的 REVIEW 分支
  }

  out.state = STATE.REVIEW;
  out.step = 0;
  out.scheduledDays = nextInterval(out.stability, requestRetention, maximumInterval);
  out.due = now + out.scheduledDays * DAY;
  return out;
}

/** 新建一张卡的初始记忆状态 */
export function newCardState() {
  return {
    state: STATE.NEW,
    stability: 0,
    difficulty: 0,
    due: 0,
    lastReview: 0,
    scheduledDays: 0,
    step: 0,
    reps: 0,
    lapses: 0,
  };
}

/** 给 UI 预览四个按钮各自会排到多久后 */
export function previewIntervals(card, now = Date.now(), opt = {}) {
  const out = {};
  for (const g of [1, 2, 3, 4]) {
    const s = schedule(card, g, now, opt);
    out[g] = s.due - now;
  }
  return out;
}
