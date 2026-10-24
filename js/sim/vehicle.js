/**
 * 차량 시뮬레이터: 속도 → 휠rpm → 기어 → 엔진rpm, 변속기 모델(AUTO/MANUAL), 리미터, 시동 시퀀스, 스로틀 추정.
 * DOM에 의존하지 않으므로 Node 단위 테스트와 오프라인 렌더링에서도 그대로 쓴다.
 *
 * 변속은 세 구간으로 나눈다: ① 토크 감소(부하 ↓) → ② 회전수 이동(새 기어 rpm, 다운시프트는 블리핑) → ③ 부하 회복.
 * 구간 길이와 남는 토크는 변속기 형식(수동·DCT·AMT·MCT·토크컨버터 자동)별 프로파일 값에서 온다.
 */
import { DEFAULT_TESLA_ID, getTesla, teslaMaxAccel, REGEN } from '../presets/tesla.js';

export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
export const lerp = (a, b, t) => a + (b - a) * t;

/** 구름저항 + 공기저항 근사 감속도 (m/s²) */
export function drag(v) {
  return v > 0.05 ? 0.14 + 0.00042 * v * v : 0;
}

export function wheelRpm(speed, tireDiameter) {
  return (speed / (tireDiameter * Math.PI)) * 60;
}

/** gear는 1부터 시작 */
export function engineRpmFromSpeed(speed, preset, gear) {
  return wheelRpm(speed, preset.tireDiameter) * preset.gearRatios[gear - 1] * preset.finalDrive;
}

export function speedFromEngineRpm(rpm, preset, gear) {
  return (rpm / (preset.gearRatios[gear - 1] * preset.finalDrive) / 60) * preset.tireDiameter * Math.PI;
}

function torqueCurve(x) {
  return clamp(0.62 + 1.15 * x - 0.95 * x * x, 0.45, 1);
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smooth = (cur, target, dt, tau) => cur + (target - cur) * (1 - Math.exp(-dt / Math.max(tau, 1e-4)));

/** requestShift() 거절 사유 → 화면 문구 */
export const SHIFT_REASON = {
  overrev: '과회전 방지: 다운시프트 차단',
  lug: '회전수가 너무 낮아 업시프트 불가',
  max: '최고단입니다',
  min: '1단입니다',
  stopped: '정차 중',
  auto: 'AUTO 모드',
  off: '엔진이 꺼져 있음',
  ev: '변속기 없음',
  busy: '변속 중',
};

export class Vehicle {
  /**
   * @param {import('../presets/presets.js').Preset} preset
   * @param {{ onEvent?: (e: object) => void, seed?: number }} [opts]
   */
  constructor(preset, opts = {}) {
    this.emit = opts.onEvent || (() => {});
    this.rand = opts.seed != null ? mulberry32(opts.seed) : Math.random;
    this.settings = {
      response: 0.5, // 가속 반응 감도: 페달/GPS 가속 → 스로틀
      shiftStyle: 0.5, // 변속 성향: AUTO 변속 맵 안에서 이른 변속(0) ↔ 늦은 변속(1)
      crackle: 0.4,
      driveMode: 'auto', // 'auto' | 'manual'
      autoStyle: 'comfort', // 'comfort' | 'sport'
      teslaId: DEFAULT_TESLA_ID,
      regen: 'standard',
    };
    this.tesla = getTesla(this.settings.teslaId);
    this.state = {
      speed: 0, accel: 0, rpm: 0, gear: 1, gearLabel: 'P', throttle: 0, load: 0, overrun: 0,
      fuelCut: false, engine: 'off', shifting: false, redline: 6500,
    };
    this.setPreset(preset);
    this.reset();
  }

  setPreset(preset) {
    this.p = preset;
    this.isEV = preset.type === 'ev';
    this.state.redline = preset.redline;
    if (this.gear > preset.gearRatios.length) this.gear = preset.gearRatios.length;
    this.shift = null;
    this.pending = 0;
    this.lastRatio = -1;
  }

  setSettings(s) {
    Object.assign(this.settings, s);
    if ('teslaId' in s) this.tesla = getTesla(s.teslaId);
  }

  reset() {
    this.speed = 0;
    this.accel = 0;
    this.rpm = 0;
    this.gear = 1;
    this.throttle = 0;
    this.rawThrottle = 0;
    this.load = 0;
    this.overrun = 0;
    this.engine = 'off';
    this.engineT = 0;
    this.crankDur = 1;
    this.shift = null;
    this.pending = 0;
    this.lastShiftDir = 0;
    this.kdT = 0;
    this.limCut = false;
    this.limT = 0;
    this.limDur = 0.04;
    this.limHold = 0;
    this.lastShiftT = -10;
    this.time = 0;
    this.thrPeak = 0;
    this.overrunArmed = false;
    this.ignitionSent = false;
    this.lastRatio = -1;
  }

  get running() {
    return this.engine === 'running' || this.engine === 'starting';
  }

  get manual() {
    return this.settings.driveMode === 'manual';
  }

  start() {
    if (this.engine !== 'off' && this.engine !== 'stopping') return;
    this.engineT = 0;
    if (this.isEV) {
      this.engine = 'running';
      this.setIgnition(true);
      this.emit({ type: 'evReady' });
      return;
    }
    this.engine = 'cranking';
    this.crankDur = 0.8 + this.rand() * 0.4;
    this.setIgnition(false);
    this.emit({ type: 'starter', on: true });
  }

  stop() {
    if (this.engine === 'off' || this.engine === 'stopping') return;
    if (this.engine === 'cranking') this.emit({ type: 'starter', on: false });
    this.engine = 'stopping';
    this.engineT = 0;
    this.shift = null;
    this.pending = 0;
  }

  setIgnition(on) {
    this.ignitionSent = on;
    this.emit({ type: 'ignition', on });
  }

  drag(v) { return drag(v); }

  rpmInGear(v, g) {
    return engineRpmFromSpeed(v, this.p, g);
  }

  /** 현재 기어·rpm에서 낼 수 있는 최대 가속도 */
  aMax(g, rpm, v) {
    const p = this.p;
    if (this.isEV) return p.maxAccel * (1 - 0.65 * clamp((v - 14) / 40, 0, 1));
    const ratio = Math.pow(p.gearRatios[g - 1] / p.gearRatios[0], 0.85);
    return p.maxAccel * ratio * torqueCurve(clamp(rpm / p.redline, 0, 1));
  }

  /** 정속 유지에 필요한 스로틀 (GAS 페달 맨 위 위치) */
  holdThrottle(v) {
    if (v < 0.3) return 0;
    const a = this.aMax(this.gear, Math.max(this.rpm, this.p.idleRpm), v);
    return clamp(drag(v) / Math.max(a, 0.1), 0, 0.9);
  }

  /** 변속 공격성 0(컴포트·이른 변속) ~ 1(스포츠·늦은 변속): 주행 모드 + 변속 성향 슬라이더 */
  aggression() {
    const s = this.settings;
    const base = s.driveMode === 'manual' ? 0.7 : s.autoStyle === 'sport' ? 0.85 : 0.15;
    return clamp(base + (s.shiftStyle - 0.5) * 0.7, 0, 1);
  }

  shiftMap() {
    const { comfort: c, sport: s } = this.p.gearbox.maps;
    const a = this.aggression();
    return {
      upLight: lerp(c.upLight, s.upLight, a),
      upFull: lerp(c.upFull, s.upFull, a),
      downLight: lerp(c.downLight, s.downLight, a),
      downFull: lerp(c.downFull, s.downFull, a),
    };
  }

  upshiftRpm(throttle) {
    const m = this.shiftMap();
    return lerp(m.upLight, m.upFull * this.p.redline, Math.pow(clamp(throttle, 0, 1), 1.3));
  }

  downshiftRpm(throttle) {
    const m = this.shiftMap();
    return lerp(m.downLight, m.downFull, clamp(throttle, 0, 1));
  }

  lugRpm() {
    return Math.max(this.p.gearbox.lugRpm || 0, this.p.idleRpm * 1.1);
  }

  startShift(to) {
    const gbx = this.p.gearbox;
    const up = to > this.gear;
    const steps = Math.abs(to - this.gear);
    const base = up ? gbx.upTime : gbx.downTime;
    const dur = Math.max(0.02, base * lerp(1.15, 0.8, this.aggression()) * (steps > 1 ? 1.25 : 1));
    this.shift = { from: this.gear, to, t: 0, dur, up, blip: !up && gbx.revMatch };
    this.lastShiftT = this.time;
    this.lastShiftDir = up ? 1 : -1;
    if (up && this.settings.crackle > 0 && this.throttle > 0.4) this.emit({ type: 'shiftPop' });
    if (!up && this.throttle < 0.15) this.emit({ type: 'downshift' });
  }

  /**
   * MANUAL 모드 변속 요청. 입력 1회에 변속 1회. 변속 중이면 한 번만 예약한다.
   * @param {1|-1} dir
   * @returns {{ok: boolean, reason?: string, gear?: number, queued?: boolean}}
   */
  requestShift(dir) {
    if (this.isEV) return { ok: false, reason: 'ev' };
    if (!this.running) return { ok: false, reason: 'off' };
    if (!this.manual) return { ok: false, reason: 'auto' };
    if (this.shift) {
      if (this.pending) return { ok: false, reason: 'busy' };
      this.pending = dir > 0 ? 1 : -1;
      return { ok: true, queued: true, gear: this.shift.to + this.pending };
    }
    return this.tryShift(dir > 0 ? 1 : -1);
  }

  tryShift(dir) {
    const n = this.p.gearRatios.length;
    if (this.speed < 0.4) return { ok: false, reason: 'stopped' };
    const to = this.gear + dir;
    if (to > n) return { ok: false, reason: 'max' };
    if (to < 1) return { ok: false, reason: 'min' };
    const rpmTo = this.rpmInGear(this.speed, to);
    if (dir < 0 && rpmTo > this.p.redline) return { ok: false, reason: 'overrev' };
    if (dir > 0 && rpmTo < this.lugRpm() * 1.05) return { ok: false, reason: 'lug' };
    this.startShift(to);
    return { ok: true, gear: to };
  }

  /** 변속 진행률 x(0~1)에서 남는 토크 비율 (① 감소 → ② 유지 → ③ 회복) */
  shiftLoadMul(s) {
    const x = s.t / s.dur;
    const r = this.p.gearbox.cutRetain;
    const [a, b] = s.up ? [0.2, 0.7] : [0.15, 0.65];
    if (x < a) return lerp(1, r, x / a);
    if (x < b) return r;
    return lerp(r, 1, (x - b) / (1 - b));
  }

  /** 레브매칭 다운시프트의 블리핑 스로틀 (소리용) */
  shiftBlip(s) {
    if (!s.blip) return 0;
    const x = s.t / s.dur;
    if (x < 0.12 || x > 0.6) return 0;
    return (0.35 + 0.35 * this.aggression()) * Math.sin((Math.PI * (x - 0.12)) / 0.48);
  }

  /**
   * @param {number} dt 초
   * @param {{mode:'test'|'gps', gas?:number|null, brake?:number|null, rev?:number,
   *          speed?:number, accel?:number, quality?:number, stale?:boolean}} input
   */
  update(dt, input) {
    if (!(dt > 0)) return this.state;
    dt = Math.min(dt, 0.1);
    const p = this.p;
    this.time += dt;
    this.engineT += dt;
    const running = this.running;
    const rev = clamp(input.rev || 0, 0, 1);
    const gps = input.mode === 'gps';

    // ── 1. 속도와 원시 스로틀 ───────────────────────────────
    let raw = 0;
    const moving = this.speed > 0.4;
    if (gps) {
      const v = Math.max(0, input.speed || 0);
      const a = clamp(input.accel || 0, -9, this.tesla.peakAccel * 1.1);
      this.speed = v;
      this.accel = a;
      if (running) raw = v < 0.4 ? rev : this.gpsThrottle(v, a, input);
    } else {
      const gas = input.gas == null ? null : clamp(input.gas, 0, 1);
      const brake = input.brake == null ? 0 : clamp(input.brake, 0, 1);
      if (running) {
        if (gas != null) {
          const hold = this.holdThrottle(this.speed);
          raw = hold + (1 - hold) * Math.pow(gas, lerp(1.5, 0.75, this.settings.response));
        } else if (!moving) raw = rev;
      }
      const shiftingDrive = this.shift && this.shiftLoadMul(this.shift) < 0.2;
      const drive = running && gas != null && !shiftingDrive && !this.limCut
        ? raw * this.aMax(this.gear, Math.max(this.rpm, p.idleRpm), this.speed) : 0;
      let engineBrake = 0;
      if (this.speed > 0.3 && gas == null) {
        engineBrake = this.isEV ? 1.2 : running ? 0.25 + 0.6 * clamp(this.rpm / p.redline, 0, 1) : 0.1;
      }
      const a = drive - drag(this.speed) - brake * 9 - engineBrake;
      this.speed = Math.max(0, this.speed + a * dt);
      this.accel = smooth(this.accel, this.speed > 0 ? a : 0, dt, 0.15);
    }
    this.rawThrottle = raw;
    this.kdT = raw > 0.85 ? this.kdT + dt : 0;

    // ── 2. 스로틀/부하 스무딩 (변속 중엔 토크 감소·블리핑 반영) ─────
    const tTau = raw > this.throttle ? (gps ? 0.18 : 0.06) : (gps ? 0.2 : 0.08);
    this.throttle = smooth(this.throttle, raw, dt, tTau);
    const blip = this.shift ? this.shiftBlip(this.shift) : 0;
    let loadTarget = this.throttle;
    if (this.limCut) loadTarget = 0;
    else if (this.shift) loadTarget = Math.max(this.throttle * this.shiftLoadMul(this.shift), blip * 0.6);
    const lTau = this.shift ? 0.02 : loadTarget > this.load ? 0.05 : 0.45;
    this.load = smooth(this.load, loadTarget, dt, lTau);
    const thrOut = Math.max(this.throttle, blip);

    // 리프트오프 감지
    this.thrPeak = Math.max(this.thrPeak * Math.exp(-dt / 0.4), this.throttle);
    if (this.throttle > 0.3) this.overrunArmed = false;
    if (!this.isEV && running && !this.overrunArmed && this.throttle < 0.06 && this.thrPeak > 0.25
        && this.rpm > 0.4 * p.redline) {
      this.overrunArmed = true;
      this.emit({ type: 'liftoff' });
    }

    // ── 3. 변속 로직 ──────────────────────────────────────
    const v = this.speed;
    if (!this.isEV && running) this.updateGear(dt, v, input);

    // ── 4. 목표 rpm ───────────────────────────────────────
    let target = 0;
    let tau = p.rpmTauUp;
    const idle = p.idleRpm;
    if (this.engine === 'off') {
      target = 0; tau = 0.3;
    } else if (this.engine === 'stopping') {
      target = 0; tau = 0.28;
      if (this.ignitionSent && this.engineT > 0.15) this.setIgnition(false);
      if (this.rpm < 40) { this.engine = 'off'; this.rpm = 0; }
    } else if (this.engine === 'cranking') {
      target = 210 + 30 * Math.sin(this.engineT * 23);
      tau = 0.12;
      if (this.engineT >= this.crankDur) {
        this.engine = 'starting';
        this.engineT = 0;
        this.emit({ type: 'starter', on: false });
        this.setIgnition(true);
      }
    } else if (this.isEV) {
      target = this.rpmInGear(v, 1);
      tau = 0.05;
    } else {
      target = this.runningTarget(v, rev, input);
      tau = target > this.rpm ? p.rpmTauUp : p.rpmTauDown;
      if (this.shift) [target, tau] = this.shiftTarget(this.shift, v, target, tau);
      else if (v < 0.4) tau = target > this.rpm ? p.rpmTauUp * 0.85 : p.rpmTauDown;
      if (this.engine === 'starting') {
        // 점화 직후 회전이 한 번 솟았다가 공회전으로 내려앉는다 (너무 높이·깨끗하게 솟으면 "삐융" 하는 전자음처럼 들림)
        const over = idle * (1 + 0.55 * Math.exp(-Math.max(0, this.engineT - 0.25) / 0.45));
        target = Math.max(target, this.engineT < 0.25 ? idle * 1.55 : over);
        tau = this.engineT < 0.25 ? 0.07 : 0.2;
        if (this.engineT > 2) this.engine = 'running';
      }
    }

    // ── 5. 레브 리미터 ────────────────────────────────────
    if (!this.isEV && running) {
      if (this.limCut) {
        this.limT += dt;
        target = Math.min(target, p.limiterRpm - 380);
        tau = p.rpmTauDown * 0.6;
        if (this.limT >= this.limDur) this.limCut = false;
      } else if (this.rpm >= p.limiterRpm) {
        this.limCut = true;
        this.limT = 0;
        this.limDur = 0.03 + this.rand() * 0.03;
        this.emit({ type: 'limiterCut' });
        target = Math.min(target, p.limiterRpm - 380);
      }
      if (this.rpm >= p.limiterRpm - 120) this.limHold += dt;
      else this.limHold = 0;
    } else {
      this.limCut = false;
    }

    // ── 6. 엔진 관성 ─────────────────────────────────────
    this.rpm = Math.max(0, smooth(this.rpm, target, dt, tau));
    if (this.isEV) this.rpm = Math.min(this.rpm, p.redline);

    // 오버런(감속 연료 차단): 같은 rpm이라도 가속·정속과 다른 음색을 내도록 워크렛에 전달
    const ovOn = running && !this.isEV && thrOut < 0.05 && (v > 1 || this.rpm > idle * 1.6) && this.rpm > idle * 1.25;
    this.overrun = smooth(this.overrun, ovOn ? 1 : 0, dt, ovOn ? 0.15 : 0.06);

    // ── 7. 출력 상태 ─────────────────────────────────────
    const st = this.state;
    st.speed = this.speed;
    st.accel = this.accel;
    st.rpm = this.rpm;
    st.gear = this.gear;
    st.throttle = thrOut;
    st.load = this.load;
    st.overrun = this.overrun;
    const s = this.shift;
    const sparkCut = s && s.up && p.gearbox.sparkCut && this.throttle > 0.3 && s.t < s.dur * 0.6 && s.t > s.dur * 0.1;
    st.fuelCut = !!(sparkCut || this.limCut);
    st.engine = this.engine;
    st.shifting = !!s;
    st.gearLabel = this.gearLabel();
    st.driveMode = this.settings.driveMode;

    const ratio = this.isEV || v < 0.4 || !running ? 0 : p.gearRatios[this.gear - 1];
    if (ratio !== this.lastRatio) {
      this.lastRatio = ratio;
      this.emit({ type: 'gear', gear: ratio ? this.gear : 0, ratio });
    }
    return st;
  }

  /**
   * GPS 속도·가속도 → 스로틀 추정.
   * 테슬라 성능(모델별 최대 가속)으로 "페달을 얼마나 밟았는지"를 추정해 가상 엔진의 스로틀로 쓴다.
   * 회생제동으로 줄어드는 정도의 감속은 리프트오프(오버런), 신호 단절 중엔 정속 부하로 고정한다.
   */
  gpsThrottle(v, a, input) {
    const aT = teslaMaxAccel(this.tesla, v);
    const cruise = clamp(0.12 + (drag(v) / aT) * 1.5, 0.12, 0.3);
    if (input.stale) return cruise * 0.8;
    const q = clamp(input.quality ?? 1, 0, 1);
    const aq = a * (0.4 + 0.6 * q); // 정확도가 나쁘면 가속도를 덜 믿는다
    const regen = (REGEN[this.settings.regen] || REGEN.standard).decel;
    const liftA = -Math.min(0.3, regen * 0.15);
    if (aq <= liftA) return 0;
    if (aq < 0) return cruise * (1 - aq / liftA);
    if (aq < 0.15) return cruise;
    const gain = lerp(0.75, 1.7, this.settings.response);
    const pedal = Math.pow(clamp((aq + drag(v)) / aT, 0, 1), 0.8);
    return Math.max(cruise, clamp(pedal * gain, 0, 1));
  }

  /** 변속 구간별 목표 rpm과 시정수 */
  shiftTarget(s, v, target, tau) {
    const p = this.p;
    const gbx = p.gearbox;
    const idle = p.idleRpm;
    const x = s.t / s.dur;
    const rwTo = Math.max(this.rpmInGear(v, s.to), idle);
    const clutch = gbx.type === 'manual';
    // 회전 이동 시정수: 9천rpm DCT도 한 프레임에 수천 rpm씩 떨어지지 않게 하한을 둔다
    const fast = Math.max(s.dur * 0.3, 0.055);
    if (s.up) {
      if (x < 0.2) return [this.rpm, 0.05]; // 토크 감소 구간: 회전 유지
      if (clutch && x < 0.75) return [idle, p.rpmTauDown * 1.3]; // 클러치 분리: 자유 감속
      return [rwTo, fast];
    }
    if (x < 0.12) return [this.rpm, 0.05];
    if (s.blip) return [x < 0.7 ? rwTo * 1.03 : rwTo, Math.max(s.dur * 0.2, 0.03)];
    if (x < 0.7) return [idle, p.rpmTauDown * 1.3]; // 레브매칭 없는 수동: 클러치 분리 중 회전 하락
    return [rwTo, 0.03]; // 클러치 연결 순간 회전이 휠에 끌려 올라간다
  }

  runningTarget(v, rev, input) {
    const p = this.p;
    const idle = p.idleRpm;
    const gasHeld = input.mode === 'test' && input.gas != null;
    if (v < 0.4 && !gasHeld) {
      // 중립 공회전 / 레브
      return rev > 0 ? idle + rev * (p.limiterRpm + 400 - idle) : idle;
    }
    const g = this.shift ? this.shift.from : this.gear;
    const rw = this.rpmInGear(v, g);
    let slip = 0;
    const conv = p.gearbox.converter;
    if (conv && g <= 3 && v < conv.lockSpeed) {
      // 토크컨버터 슬립: 저속 가속 중 rpm이 휠 rpm보다 먼저 오른다
      slip = lerp(idle, conv.stallRpm, Math.pow(this.throttle, 0.8)) * (1 - v / conv.lockSpeed) + rw * (v / conv.lockSpeed);
    }
    if (g === 1) {
      // 클러치 슬립: 출발 rpm에서 시작해 속도와 함께 오르다가 휠 rpm에 붙는다
      const launch = idle + this.throttle * p.launchRpm;
      return Math.max(rw, launch * 0.85 + rw * 0.3, slip, idle);
    }
    return Math.max(rw, slip, idle);
  }

  updateGear(dt, v, input) {
    const p = this.p;
    const n = p.gearRatios.length;
    if (this.shift) {
      this.shift.t += dt;
      if (this.shift.t >= this.shift.dur) {
        this.gear = this.shift.to;
        this.shift = null;
        if (this.pending) {
          const dir = this.pending;
          this.pending = 0;
          if (this.manual) this.tryShift(dir);
        }
      }
      return;
    }
    if (v < 0.4) {
      this.gear = 1;
      return;
    }
    const rw = this.rpmInGear(v, this.gear);
    const since = this.time - this.lastShiftT;
    const minGap = input.mode === 'gps' ? 0.7 : 0.35;

    // MANUAL: 운전자 입력으로만 변속, 회전이 너무 떨어지면 자동 다운시프트(시동 꺼짐 방지)
    if (this.manual) {
      if (this.gear > 1 && rw < this.lugRpm() && since > 0.3 && this.rpmInGear(v, this.gear - 1) < p.redline) {
        this.startShift(this.gear - 1);
      }
      return;
    }

    // AUTO
    const t = this.throttle;
    const upR = this.upshiftRpm(t);
    const downR = this.downshiftRpm(t);
    if (this.gear < n && since > minGap) {
      // 코스팅(오버런) 중에는 기어를 유지해 크래클 구간을 살린다
      let ready = rw > upR && (this.rawThrottle > 0.05 || rw > p.redline * 0.97);
      if (p.bounceBeforeShift > 0 && t > 0.9) {
        ready = this.limHold >= p.bounceBeforeShift || rw > p.limiterRpm + 200;
      }
      // 다운시프트 직후 곧바로 다시 올리는 헌팅 방지
      if (this.lastShiftDir < 0 && since < 1.0 && rw < p.redline * 0.97) ready = false;
      if (ready && this.rpmInGear(v, this.gear + 1) > downR * 1.08) {
        this.startShift(this.gear + 1);
        return;
      }
    }
    if (this.gear > 1) {
      // 킥다운: 페달을 깊게 밟고 유지하면 회전이 맞는 가장 낮은 기어로 한 번에 내린다 (최대 3단).
      // 판단하는 동안(kdHold)엔 한 단씩 내려가는 일반 다운시프트를 미룬다. GPS는 잡음 때문에 더 오래 지켜본다.
      if (p.gearbox.kickdown && this.rawThrottle > 0.85) {
        const kdHold = input.mode === 'gps' ? 0.35 : 0.08;
        if (this.kdT < kdHold) return;
        const upK = this.upshiftRpm(1);
        if (since > 0.5 && rw < upK * 0.7) {
          let g = this.gear;
          for (let k = this.gear - 1; k >= Math.max(1, this.gear - 3); k--) {
            if (this.rpmInGear(v, k) < upK * 0.9) g = k;
            else break;
          }
          if (g < this.gear) {
            this.startShift(g);
            return;
          }
        }
      }
      const lower = this.rpmInGear(v, this.gear - 1);
      const huntGuard = this.lastShiftDir > 0 && since < 1.2 && rw > this.lugRpm();
      if (!huntGuard && rw < downR && lower < upR * 0.95 && lower < p.redline * 0.92 && since > minGap * 0.8) {
        this.startShift(this.gear - 1);
      }
    }
  }

  gearLabel() {
    if (this.isEV) return this.running ? 'D' : 'P';
    if (!this.running) return this.engine === 'off' ? 'P' : 'N';
    if (this.speed < 0.4 && this.throttle < 0.05) return 'N';
    if (this.speed < 0.4 && this.rawThrottle > 0 && this.state.gear === 1) return '1';
    return String(this.shift ? this.shift.to : this.gear);
  }
}
