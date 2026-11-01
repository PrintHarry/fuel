// Hand-drawn SVG charts. One y-axis each, recessive grid, touch-and-drag readout.
import { parseIso } from './calc.js';

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};
const shortDate = s => parseIso(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

function niceTicks(min, max, count = 4) {
  const span = max - min || 1;
  const raw = span / count, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw);
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(6));
  return ticks;
}

// Shared frame: axes, grid, and a pointer readout driven by `readout(index)`.
function frame(host, { n, yMin, yMax, fmtY, xLabels, readout }) {
  host.innerHTML = '';
  const W = host.clientWidth || 340, H = 200, pad = { l: 44, r: 8, t: 12, b: 24 };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'chart', role: 'img' });
  const ticks = niceTicks(yMin, yMax);
  const lo = ticks[0], hi = ticks[ticks.length - 1];
  const x = i => pad.l + (n <= 1 ? (W - pad.l - pad.r) / 2 : (i * (W - pad.l - pad.r)) / (n - 1));
  const y = v => pad.t + (1 - (v - lo) / (hi - lo || 1)) * (H - pad.t - pad.b);
  for (const t of ticks) {
    svg.append(el('line', { x1: pad.l, x2: W - pad.r, y1: y(t), y2: y(t), class: 'grid' }));
    const lbl = el('text', { x: pad.l - 8, y: y(t) + 4, class: 'axis', 'text-anchor': 'end' });
    lbl.textContent = fmtY(t);
    svg.append(lbl);
  }
  const step = Math.max(1, Math.ceil(n / 4));
  for (let i = 0; i < n; i += step) {
    const t = el('text', { x: x(i), y: H - 6, class: 'axis', 'text-anchor': i === 0 ? 'start' : 'middle' });
    t.textContent = xLabels[i];
    svg.append(t);
  }
  const marks = el('g');
  svg.append(marks);

  const cross = el('line', { y1: pad.t, y2: H - pad.b, class: 'crosshair', visibility: 'hidden' });
  svg.append(cross);
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  host.style.position = 'relative';
  host.append(svg, tip);

  const show = evt => {
    const r = svg.getBoundingClientRect();
    const px = ((evt.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (n - 1))));
    const html = readout(i);
    if (!html) return hide();
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
    tip.innerHTML = html; tip.hidden = false;
    const left = (x(i) / W) * r.width;
    tip.style.left = Math.max(0, Math.min(r.width - tip.offsetWidth, left - tip.offsetWidth / 2)) + 'px';
  };
  const hide = () => { cross.setAttribute('visibility', 'hidden'); tip.hidden = true; };
  svg.addEventListener('pointerdown', e => { svg.setPointerCapture(e.pointerId); show(e); });
  svg.addEventListener('pointermove', e => { if (e.pointerType === 'mouse' || e.buttons) show(e); });
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('pointerup', e => { if (e.pointerType !== 'mouse') setTimeout(hide, 1600); });
  return { svg, marks, x, y };
}

/* Weight: faint dots for each weigh-in, a solid line for the trend. */
export function weightChart(host, days, { toUnit, fmt }) {
  // days: [{date, kg|null, trend|null}] one per calendar day
  const vals = days.flatMap(d => [d.kg, d.trend]).filter(v => v != null).map(toUnit);
  if (!vals.length) { host.innerHTML = ''; return; }
  const min = Math.min(...vals), max = Math.max(...vals), padV = Math.max(0.5, (max - min) * 0.15);
  const f = frame(host, {
    n: days.length, yMin: min - padV, yMax: max + padV, fmtY: v => v.toFixed(Math.abs(max - min) < 4 ? 1 : 0),
    xLabels: days.map(d => shortDate(d.date)),
    readout: i => {
      const d = days[i];
      if (d.trend == null) return '';
      return `<b>${shortDate(d.date)}</b><span>Trend ${fmt(d.trend)}</span>${d.kg != null ? `<span>Scale ${fmt(d.kg)}</span>` : ''}`;
    },
  });
  days.forEach((d, i) => { if (d.kg != null) f.marks.append(el('circle', { cx: f.x(i), cy: f.y(toUnit(d.kg)), r: 3, class: 'dot-scale' })); });
  const pts = days.map((d, i) => (d.trend == null ? null : `${f.x(i)},${f.y(toUnit(d.trend))}`)).filter(Boolean);
  if (pts.length > 1) f.marks.append(el('polyline', { points: pts.join(' '), class: 'line-trend' }));
  const last = days.map((d, i) => [d, i]).filter(([d]) => d.trend != null).pop();
  if (last) f.marks.append(el('circle', { cx: f.x(last[1]), cy: f.y(toUnit(last[0].trend)), r: 4.5, class: 'dot-trend' }));
}

/* Intake: a bar per day, the target as a dashed line, expenditure estimate as a solid line. */
export function intakeChart(host, days, { target, expenditure }) {
  // days: [{date, kcal}]
  const vals = days.map(d => d.kcal).concat([target, expenditure].filter(Boolean));
  const max = Math.max(...vals, 1000);
  const f = frame(host, {
    n: days.length, yMin: 0, yMax: max * 1.08, fmtY: v => (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v),
    xLabels: days.map(d => shortDate(d.date)),
    readout: i => {
      const d = days[i];
      return `<b>${shortDate(d.date)}</b><span>${d.kcal ? d.kcal.toLocaleString('en-GB') + ' kcal' : 'Not logged'}</span>`;
    },
  });
  const slot = (f.x(1) - f.x(0)) || 40;
  const bw = Math.max(3, Math.min(22, slot - 4));
  days.forEach((d, i) => {
    if (!d.kcal) return;
    const top = f.y(d.kcal), base = f.y(0), h = Math.max(2, base - top), r = Math.min(4, bw / 2, h);
    const x0 = f.x(i) - bw / 2;
    // Rounded at the data end only, square on the baseline.
    f.marks.append(el('path', {
      class: 'bar',
      d: `M${x0},${base} V${top + r} Q${x0},${top} ${x0 + r},${top} H${x0 + bw - r} Q${x0 + bw},${top} ${x0 + bw},${top + r} V${base} Z`,
    }));
  });
  const x1 = f.x(0) - bw / 2, x2 = f.x(days.length - 1) + bw / 2;
  if (expenditure) f.marks.append(el('line', { x1, x2, y1: f.y(expenditure), y2: f.y(expenditure), class: 'line-burn' }));
  if (target) f.marks.append(el('line', { x1, x2, y1: f.y(target), y2: f.y(target), class: 'line-target' }));
}
