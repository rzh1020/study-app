/** 极简 hash 路由 + 公共 DOM 工具。不引框架：自用单页，依赖越少越好维护。 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** 转义，防止数据里的 < > 破坏 innerHTML 结构 */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer = 0;
export function toast(msg, ms = 1900) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

export function fmtInterval(ms) {
  if (ms < 0) return '-';
  const m = ms / 60000;
  if (m < 1) return '<1分';
  if (m < 60) return Math.round(m) + '分';
  const h2 = m / 60;
  if (h2 < 24) return h2.toFixed(h2 < 10 ? 1 : 0) + '时';
  const d = h2 / 24;
  if (d < 31) return (d < 10 ? d.toFixed(1) : Math.round(d)) + '天';
  const mo = d / 30.4;
  if (mo < 12) return mo.toFixed(1) + '月';
  return (d / 365).toFixed(1) + '年';
}

export function fmtDur(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function pct(x, digits = 0) {
  return x === null || x === undefined || Number.isNaN(x) ? '-' : (x * 100).toFixed(digits) + '%';
}

/** 画折线图。自己画而不引 chart 库：只需要折线，且要能离线。 */
export function lineChart(canvas, series, opt = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 300;
  const hgt = canvas.clientHeight || 150;
  canvas.width = w * dpr;
  canvas.height = hgt * dpr;
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, hgt);

  const pad = { l: 34, r: 8, t: 10, b: 20 };
  const pts = series.filter((p) => p.v !== null && p.v !== undefined && !Number.isNaN(p.v));
  const css = getComputedStyle(document.documentElement);
  const cLine = css.getPropertyValue('--line').trim() || '#2c3140';
  const cDim = css.getPropertyValue('--fg3').trim() || '#6b7285';

  if (pts.length === 0) {
    g.fillStyle = cDim; g.font = '12px sans-serif'; g.textAlign = 'center';
    g.fillText(opt.emptyText || '暂无数据', w / 2, hgt / 2);
    return;
  }
  let min = opt.min ?? Math.min(...pts.map((p) => p.v));
  let max = opt.max ?? Math.max(...pts.map((p) => p.v));
  if (min === max) { min -= 1; max += 1; }
  const pd = (max - min) * 0.12;
  min -= pd; max += pd;
  if (opt.min !== undefined) min = opt.min;
  if (opt.max !== undefined) max = opt.max;

  const X = (i) => pad.l + (series.length <= 1 ? 0 : (i / (series.length - 1)) * (w - pad.l - pad.r));
  const Y = (v) => pad.t + (1 - (v - min) / (max - min)) * (hgt - pad.t - pad.b);

  // 网格 + y 轴刻度
  g.strokeStyle = cLine; g.lineWidth = 1;
  g.fillStyle = cDim; g.font = '10px sans-serif'; g.textAlign = 'right'; g.textBaseline = 'middle';
  for (let k = 0; k <= 3; k++) {
    const v = min + ((max - min) * k) / 3;
    const y = Y(v);
    g.beginPath(); g.moveTo(pad.l, y); g.lineTo(w - pad.r, y); g.stroke();
    g.fillText(opt.fmtY ? opt.fmtY(v) : v.toFixed(0), pad.l - 5, y);
  }
  // 目标线
  if (opt.target !== undefined) {
    g.save(); g.strokeStyle = opt.targetColor || '#3ecf8e'; g.setLineDash([4, 4]);
    g.beginPath(); g.moveTo(pad.l, Y(opt.target)); g.lineTo(w - pad.r, Y(opt.target)); g.stroke(); g.restore();
  }
  // 折线（跳过空洞）
  g.strokeStyle = opt.color || '#5b8cff'; g.lineWidth = 2; g.lineJoin = 'round';
  g.beginPath();
  let started = false;
  series.forEach((p, i) => {
    if (p.v === null || p.v === undefined || Number.isNaN(p.v)) { started = false; return; }
    if (!started) { g.moveTo(X(i), Y(p.v)); started = true; } else g.lineTo(X(i), Y(p.v));
  });
  g.stroke();
  // 点
  g.fillStyle = opt.color || '#5b8cff';
  series.forEach((p, i) => {
    if (p.v === null || p.v === undefined || Number.isNaN(p.v)) return;
    g.beginPath(); g.arc(X(i), Y(p.v), 2.6, 0, Math.PI * 2); g.fill();
  });
  // x 轴首末标签
  g.fillStyle = cDim; g.textBaseline = 'top';
  g.textAlign = 'left'; g.fillText(series[0].label ?? '', pad.l, hgt - pad.b + 4);
  g.textAlign = 'right'; g.fillText(series[series.length - 1].label ?? '', w - pad.r, hgt - pad.b + 4);
}

/** 画柱状图（复习量用） */
export function barChart(canvas, series, opt = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 300;
  const hgt = canvas.clientHeight || 150;
  canvas.width = w * dpr; canvas.height = hgt * dpr;
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr); g.clearRect(0, 0, w, hgt);
  const pad = { l: 30, r: 6, t: 8, b: 18 };
  const max = Math.max(1, ...series.map((s) => s.v || 0));
  const css = getComputedStyle(document.documentElement);
  const cDim = css.getPropertyValue('--fg3').trim() || '#6b7285';
  const bw = (w - pad.l - pad.r) / series.length;
  g.fillStyle = cDim; g.font = '10px sans-serif'; g.textAlign = 'right'; g.textBaseline = 'middle';
  g.fillText(String(max), pad.l - 4, pad.t + 4);
  series.forEach((s, i) => {
    const bh = ((s.v || 0) / max) * (hgt - pad.t - pad.b);
    g.fillStyle = s.color || opt.color || '#5b8cff';
    g.fillRect(pad.l + i * bw + bw * 0.15, hgt - pad.b - bh, bw * 0.7, bh);
  });
  g.fillStyle = cDim; g.textBaseline = 'top';
  g.textAlign = 'left'; g.fillText(series[0]?.label ?? '', pad.l, hgt - pad.b + 3);
  g.textAlign = 'right'; g.fillText(series[series.length - 1]?.label ?? '', w - pad.r, hgt - pad.b + 3);
}
