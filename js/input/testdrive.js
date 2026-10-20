/**
 * 테스트 드라이브 페달 UI.
 * 포인터를 누른 세로 위치로 강도를 정한다 (아래일수록 강하게). GAS 맨 위 = 현재 속도 유지.
 * 키보드: ↑/W = 가속, ↓/S = 브레이크 (Shift와 함께 누르면 약하게).
 */
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

export class Pedals {
  constructor(gasEl, brakeEl, { onTouch } = {}) {
    this.ptr = { gas: null, brake: null };
    this.key = { gas: null, brake: null };
    this.onTouch = onTouch || (() => {});
    this.els = { gas: gasEl, brake: brakeEl };
    this.bind(gasEl, 'gas');
    this.bind(brakeEl, 'brake');
    this.bindKeys();
  }

  get gas() { return this.ptr.gas ?? this.key.gas; }
  get brake() { return this.ptr.brake ?? this.key.brake; }

  bind(el, name) {
    const set = (e) => {
      const r = el.getBoundingClientRect();
      this.ptr[name] = clamp01((e.clientY - r.top) / r.height);
      this.paint(name);
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      set(e);
      this.onTouch(name);
    });
    el.addEventListener('pointermove', (e) => {
      if (el.hasPointerCapture(e.pointerId)) set(e);
    });
    const end = () => {
      this.ptr[name] = null;
      this.paint(name);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', end);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  bindKeys() {
    const map = { ArrowUp: 'gas', KeyW: 'gas', ArrowDown: 'brake', KeyS: 'brake' };
    window.addEventListener('keydown', (e) => {
      const name = map[e.code];
      if (!name || e.target.closest?.('input, select, textarea')) return;
      e.preventDefault();
      this.key[name] = e.shiftKey ? 0.35 : name === 'gas' ? 1 : 0.6;
      this.paint(name);
      if (!e.repeat) this.onTouch(name);
    });
    window.addEventListener('keyup', (e) => {
      const name = map[e.code];
      if (!name) return;
      this.key[name] = null;
      this.paint(name);
    });
  }

  /** 데모 런 등 외부 입력을 페달 그림에 반영 */
  show(gas, brake) {
    this.paintValue('gas', gas);
    this.paintValue('brake', brake);
  }

  paint(name) {
    this.paintValue(name, this[name]);
  }

  paintValue(name, v) {
    const el = this.els[name];
    el.style.setProperty('--press', v == null ? 0 : 0.12 + 0.88 * v);
    el.classList.toggle('active', v != null);
  }
}
