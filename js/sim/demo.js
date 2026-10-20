/**
 * 데모 런: 정차 공회전 → REV 블립 2회 → 풀가속 → 크루즈 → 리프트오프(크래클) → 다운시프트 감속 → 정차.
 * 테스트 드라이브 입력(gas/brake/rev)을 keyframe 구간으로 정의한다.
 */
import { Vehicle } from './vehicle.js';

// gas: null이면 페달에서 발을 뗀 상태, 0이면 페달 맨 위(정속 유지)
export const DEMO_SEGMENTS = [
  { t: 0.0, dur: 2.0 },
  { t: 2.0, dur: 0.45, rev: 0.75 },
  { t: 2.45, dur: 0.75 },
  { t: 3.2, dur: 0.6, rev: 1.0 },
  { t: 3.8, dur: 0.9 },
  { t: 4.7, dur: 7.8, gas: 1.0 },
  { t: 12.5, dur: 1.5 },
  { t: 14.0, dur: 3.0, gas: 0.0 },
  { t: 17.0, dur: 2.0 },
  { t: 19.0, dur: 5.5, brake: 0.55 },
  { t: 24.5, dur: 1.5 },
];
export const DEMO_DURATION = 26;

export class DemoRun {
  constructor() {
    this.t = 0;
  }

  get done() {
    return this.t >= DEMO_DURATION;
  }

  step(dt) {
    this.t += dt;
    return this.at(this.t);
  }

  at(t) {
    const seg = DEMO_SEGMENTS.find((s) => t >= s.t && t < s.t + s.dur);
    if (!seg) return { gas: null, brake: null, rev: 0, done: t >= DEMO_DURATION };
    const local = t - seg.t;
    const rev = seg.rev ? seg.rev * Math.min(1, local / 0.25) : 0;
    return { gas: seg.gas ?? null, brake: seg.brake ?? null, rev, done: false };
  }
}

export const FRAME_STRIDE = 5; // [t, rpm, throttle, load, fuelCut]

/**
 * 오프라인 렌더용: 시동 → 데모 런 → 시동 끄기를 고정 dt로 시뮬레이트해 프레임과 이벤트를 기록한다.
 * @returns {{ duration: number, frames: Float32Array, messages: {t:number, msg:object}[], loads: number[] }}
 */
export function simulateDemo(preset, settings, { fps = 120, lead = 2.8, tail = 1.8 } = {}) {
  const messages = [];
  let now = 0;
  const vehicle = new Vehicle(preset, { seed: 7, onEvent: (msg) => messages.push({ t: now, msg }) });
  vehicle.setSettings(settings);
  const demo = new DemoRun();
  const duration = lead + DEMO_DURATION + tail;
  const n = Math.ceil(duration * fps);
  const frames = new Float32Array(n * FRAME_STRIDE);
  const dt = 1 / fps;
  let stopped = false;
  for (let i = 0; i < n; i++) {
    now = i * dt;
    if (i === Math.round(0.2 * fps)) vehicle.start();
    let input = { mode: 'test', gas: null, brake: null, rev: 0 };
    if (now >= lead && !demo.done) input = { mode: 'test', ...demo.step(dt) };
    if (demo.done && !stopped) { vehicle.stop(); stopped = true; }
    const s = vehicle.update(dt, input);
    const o = i * FRAME_STRIDE;
    frames[o] = now;
    frames[o + 1] = s.rpm;
    frames[o + 2] = s.throttle;
    frames[o + 3] = s.load;
    frames[o + 4] = s.fuelCut ? 1 : 0;
  }
  return { duration, frames, messages };
}
