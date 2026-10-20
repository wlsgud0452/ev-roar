/**
 * 차량 시뮬레이터: 속도 → 휠rpm → 기어 → 엔진rpm, 변속/리미터/시동 시퀀스, 스로틀 추정.
 * DOM에 의존하지 않으므로 Node 단위 테스트와 오프라인 렌더링에서도 그대로 쓴다.
 */

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

export class Vehicle {
  /**
   * @param {import('../presets/presets.js').Preset} preset
   * @param {{ onEvent?: (e: object) => void, seed?: number }} [opts]
   */
  constructor(preset, opts = {}) {
    this.emit = opts.onEvent || (() => {});
    this.rand = opts.seed != null ? mulberry32(opts.seed) : Math.random;
    this.settings = { intensity: 0.5, crackle: 0.4 };
    this.state = {
      speed: 0, accel: 0, rpm: 0, gear: 1, gearLabel: 'P', throttle: 0, load: 0,
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
    this.lastRatio = -1;
  }

  setSettings(s) {
    Object.assign(this.settings, s);
  }

  reset() {
    this.speed = 0;
    this.accel = 0;
    this.rpm = 0;
    this.gear = 1;
    this.throttle = 0;
    this.rawThrottle = 0;
    this.load = 0;
    this.engine = 'off';
    this.engineT = 0;
    this.crankDur = 1;
    this.shift = null;
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

  upshiftRpm(throttle) {
    const p = this.p;
    const k = Math.pow(clamp(throttle, 0, 1), 1.5 - this.settings.intensity);
    return lerp(p.shiftLowRpm, p.redline * 0.97, k);
  }

  startShift(to) {
    const p = this.p;
    const up = to > this.gear;
    this.shift = { from: this.gear, to, t: 0, dur: p.shiftTime * (up ? 1 : 0.8), up };
    this.lastShiftT = this.time;
    if (up && this.settings.crackle > 0 && this.throttle > 0.4) this.emit({ type: 'shiftPop' });
    if (!up && this.throttle < 0.15) this.emit({ type: 'downshift' });
  }

  /**
   * @param {number} dt 초
   * @param {{mode:'test'|'gps', gas?:number|null, brake?:number|null, rev?:number, speed?:number, accel?:number}} input
   */
  update(dt, input) {
    if (!(dt > 0)) return this.state;
    dt = Math.min(dt, 0.1);
    const p = this.p;
    this.time += dt;
    this.engineT += dt;
    const running = this.running;
    const rev = clamp(input.rev || 0, 0, 1);

    // ── 1. 속도와 원시 스로틀 ───────────────────────────────
    let raw = 0;
    const moving = this.speed > 0.4;
    if (input.mode === 'gps') {
      const v = Math.max(0, input.speed || 0);
      const a = input.accel || 0;
      this.speed = v;
      this.accel = a;
      if (running) {
        if (v < 0.4) raw = rev;
        else {
          const gain = lerp(0.6, 2.0, this.settings.intensity);
          const aNeeded = a + drag(v);
          const aM = this.aMax(this.gear, Math.max(this.rpm, p.idleRpm || 1000), v);
          if (a < -0.4) raw = 0;
          else if (Math.abs(a) < 0.15) raw = clamp((aNeeded / aM) * gain, 0.12, 0.25);
          else if (a < 0) raw = clamp((aNeeded / aM) * gain * ((a + 0.4) / 0.25), 0, 0.25);
          else raw = clamp((aNeeded / aM) * gain, 0, 1);
        }
      }
    } else {
      const gas = input.gas == null ? null : clamp(input.gas, 0, 1);
      const brake = input.brake == null ? 0 : clamp(input.brake, 0, 1);
      if (running) {
        if (gas != null) {
          const hold = this.holdThrottle(this.speed);
          raw = hold + (1 - hold) * Math.pow(gas, 1.15);
        } else if (!moving) raw = rev;
      }
      const shiftingDrive = this.shift && (this.shift.up || p.manual);
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

    // ── 2. 스로틀/부하 스무딩 ──────────────────────────────
    const gps = input.mode === 'gps';
    const tTau = raw > this.throttle ? (gps ? 0.18 : 0.06) : (gps ? 0.2 : 0.08);
    this.throttle = smooth(this.throttle, raw, dt, tTau);
    const cutNow = (this.shift && this.shift.up) || this.limCut;
    const loadTarget = cutNow ? 0 : this.throttle;
    this.load = smooth(this.load, loadTarget, dt, loadTarget > this.load ? 0.05 : 0.45);

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
    if (!this.isEV && running) this.updateGear(dt, v);

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
      if (this.shift) {
        const s = this.shift;
        if (s.up && p.manual) { target = idle; tau = p.rpmTauDown * 1.3; }
        else { target = this.rpmInGear(v, s.to) * (s.up ? 1 : 1.04); tau = Math.max(s.dur / 2.5, 0.012); }
      } else if (v < 0.4) {
        tau = target > this.rpm ? p.rpmTauUp * 0.85 : p.rpmTauDown;
      }
      if (this.engine === 'starting') {
        const over = idle * (1 + 0.85 * Math.exp(-Math.max(0, this.engineT - 0.25) / 0.5));
        target = Math.max(target, this.engineT < 0.25 ? idle * 1.85 : over);
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

    // ── 7. 출력 상태 ─────────────────────────────────────
    const st = this.state;
    st.speed = this.speed;
    st.accel = this.accel;
    st.rpm = this.rpm;
    st.gear = this.gear;
    st.throttle = this.throttle;
    st.load = this.load;
    st.fuelCut = !!((this.shift && (this.shift.up ? true : this.shift.t < this.shift.dur * 0.3)) || this.limCut);
    st.engine = this.engine;
    st.shifting = !!this.shift;
    st.gearLabel = this.gearLabel();

    const ratio = this.isEV || v < 0.4 || !running ? 0 : p.gearRatios[this.gear - 1];
    if (ratio !== this.lastRatio) {
      this.lastRatio = ratio;
      this.emit({ type: 'gear', gear: ratio ? this.gear : 0, ratio });
    }
    return st;
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
    if (g === 1) {
      // 클러치 슬립: 출발 rpm에서 시작해 속도와 함께 오르다가 휠 rpm에 붙는다
      const launch = idle + this.throttle * p.launchRpm;
      return Math.max(rw, launch * 0.85 + rw * 0.3, idle);
    }
    return Math.max(rw, idle);
  }

  updateGear(dt, v) {
    const p = this.p;
    const n = p.gearRatios.length;
    if (this.shift) {
      this.shift.t += dt;
      if (this.shift.t >= this.shift.dur) {
        this.gear = this.shift.to;
        this.shift = null;
      }
      return;
    }
    if (v < 0.4) {
      this.gear = 1;
      return;
    }
    const rw = this.rpmInGear(v, this.gear);
    const since = this.time - this.lastShiftT;
    if (this.gear < n && since > 0.35) {
      const upR = this.upshiftRpm(this.throttle);
      // 코스팅(오버런) 중에는 기어를 유지해 크래클 구간을 살린다
      let ready = rw > upR && (this.rawThrottle > 0.1 || rw > p.redline * 0.97);
      if (p.bounceBeforeShift > 0 && this.throttle > 0.9) {
        ready = this.limHold >= p.bounceBeforeShift || rw > p.limiterRpm + 200;
      }
      const nextRpm = this.rpmInGear(v, this.gear + 1);
      if (ready && nextRpm > p.downshiftRpm * 1.15) {
        this.startShift(this.gear + 1);
        return;
      }
    }
    if (this.gear > 1) {
      const lower = this.rpmInGear(v, this.gear - 1);
      if (rw < p.downshiftRpm && lower < p.redline * 0.85 && since > 0.3) {
        this.startShift(this.gear - 1);
      } else if (this.throttle > 0.8 && rw < 0.55 * p.redline && lower < p.redline * 0.9 && since > 0.5) {
        this.startShift(this.gear - 1); // 킥다운
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
