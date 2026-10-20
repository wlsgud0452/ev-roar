/**
 * SVG 원형 RPM 게이지 (270°) + 중앙 속도/기어/rpm.
 */
const NS = 'http://www.w3.org/2000/svg';
const CX = 150;
const CY = 150;
const R = 128;
const START = 135; // 도, 시계방향 (SVG 좌표계)
const SWEEP = 270;

const el = (name, attrs = {}) => {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

const polar = (deg, r) => {
  const a = (deg * Math.PI) / 180;
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
};

function arcPath(t0, t1, r) {
  const a0 = START + SWEEP * t0;
  const a1 = START + SWEEP * t1;
  const [x0, y0] = polar(a0, r);
  const [x1, y1] = polar(a1, r);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export class Gauge {
  constructor(root) {
    this.root = root;
    this.svg = root.querySelector('svg');
    this.speedEl = root.querySelector('[data-speed]');
    this.unitEl = root.querySelector('[data-unit]');
    this.gearEl = root.querySelector('[data-gear]');
    this.rpmEl = root.querySelector('[data-rpm]');
    this.scaleEl = root.querySelector('[data-scale]');
    this.last = {};
  }

  setPreset(p) {
    const ev = p.type === 'ev';
    this.max = ev ? p.redline : Math.ceil((p.limiterRpm + 200) / 1000) * 1000;
    this.redline = ev ? p.redline * 0.85 : p.redline;
    const svg = this.svg;
    svg.replaceChildren();
    svg.append(
      el('path', { d: arcPath(0, 1, R), class: 'g-track' }),
      el('path', { d: arcPath(this.redline / this.max, 1, R), class: 'g-red' }),
    );
    this.progress = el('path', { d: arcPath(0, 1, R), class: 'g-progress', pathLength: 1000 });
    svg.append(this.progress);
    const ticks = el('g', { class: 'g-ticks' });
    const kMax = this.max / 1000;
    const step = kMax > 14 ? 2 : 1;
    for (let k = 0; k <= kMax; k += 0.5) {
      const t = k / kMax;
      const major = Number.isInteger(k);
      const deg = START + SWEEP * t;
      const [x0, y0] = polar(deg, R - 12);
      const [x1, y1] = polar(deg, R - (major ? 26 : 19));
      const red = k * 1000 >= this.redline;
      ticks.append(el('line', { x1: x0, y1: y0, x2: x1, y2: y1, class: `${major ? 'g-major' : 'g-minor'}${red ? ' red' : ''}` }));
      if (major && k % step === 0) {
        const [lx, ly] = polar(deg, R - 42);
        const label = el('text', { x: lx, y: ly + 5, class: `g-label${red ? ' red' : ''}` });
        label.textContent = String(k);
        ticks.append(label);
      }
    }
    svg.append(ticks);
    this.needle = el('g', { class: 'g-needle' });
    this.needle.append(el("line", { x1: CX + R - 62, y1: CY, x2: CX + R - 16, y2: CY }), el('circle', { cx: CX + R - 16, cy: CY, r: 4 }));
    svg.append(this.needle);
    if (this.scaleEl) this.scaleEl.textContent = ev ? '×1000 motor rpm' : '×1000 rpm';
    this.last = {};
  }

  update({ rpm, speed, unit, gear, shiftLight }) {
    const t = Math.max(0, Math.min(1, rpm / this.max));
    const deg = START + SWEEP * t;
    this.needle.setAttribute('transform', `rotate(${deg.toFixed(2)} ${CX} ${CY})`);
    this.progress.style.strokeDashoffset = String(1000 * (1 - t));
    this.root.classList.toggle('redzone', rpm >= this.redline);
    this.root.classList.toggle('shift-light', !!shiftLight);
    const sp = String(Math.round(speed));
    if (sp !== this.last.sp) { this.speedEl.textContent = sp; this.last.sp = sp; }
    if (unit !== this.last.unit) { this.unitEl.textContent = unit; this.last.unit = unit; }
    if (gear !== this.last.gear) { this.gearEl.textContent = gear; this.last.gear = gear; }
    const r = String(Math.round(rpm / 10) * 10);
    if (r !== this.last.r) { this.rpmEl.textContent = Number(r).toLocaleString(); this.last.r = r; }
  }
}
