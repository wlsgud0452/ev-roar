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

export const FRAME_STRIDE = 6; // [t, rpm, throttle, load, fuelCut, overrun]

/** Sound Lab A/B 비교와 오프라인 렌더에 쓰는 고정 시나리오 */
export const SCENARIOS = [
  { id: 'demo', label: '데모 런 (시동→가속→크루즈→리프트오프→감속)' },
  { id: 'tone', label: '같은 rpm: 가속 → 정속 → 감속 (각 3초)' },
  { id: 'shifts', label: '변속: 풀가속 업시프트 → 블리핑 다운시프트 (스포츠)' },
];

function record(frames, i, now, s) {
  const o = i * FRAME_STRIDE;
  frames[o] = now;
  frames[o + 1] = s.rpm;
  frames[o + 2] = s.throttle;
  frames[o + 3] = s.load;
  frames[o + 4] = s.fuelCut ? 1 : 0;
  frames[o + 5] = s.overrun || 0;
}

/**
 * 오프라인 렌더용: 시동 → 데모 런 → 시동 끄기를 고정 dt로 시뮬레이트해 프레임과 이벤트를 기록한다.
 * @returns {{ duration: number, frames: Float32Array, messages: {t:number, msg:object}[] }}
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
    record(frames, i, now, vehicle.update(dt, input));
  }
  return { duration, frames, messages };
}

/** 같은 rpm에서 부하만 바꾼 고정 프레임 (가속 → 정속 → 감속). 시뮬레이터를 거치지 않는다. */
function simulateTone(preset, { fps = 120 } = {}) {
  const rpm = Math.round(preset.type === 'ev' ? preset.redline * 0.4 : Math.max(preset.idleRpm * 2, preset.redline * 0.5));
  const gear = Math.min(3, preset.gearRatios.length);
  const duration = 9.6;
  const n = Math.ceil(duration * fps);
  const frames = new Float32Array(n * FRAME_STRIDE);
  const messages = [
    { t: 0, msg: { type: 'ignition', on: true } },
    { t: 0, msg: { type: 'gear', gear, ratio: preset.gearRatios[gear - 1] } },
    { t: 6.3, msg: { type: 'liftoff' } },
  ];
  const s = { rpm, throttle: 0, load: 0, fuelCut: false, overrun: 0 };
  for (let i = 0; i < n; i++) {
    const t = i / fps;
    const seg = t < 0.3 ? -1 : t < 3.3 ? 0 : t < 6.3 ? 1 : 2;
    const target = seg === 0 ? [1, 1, 0] : seg === 1 ? [0.2, 0.2, 0] : seg === 2 ? [0, 0, 1] : [0.2, 0.2, 0];
    const k = 1 - Math.exp(-1 / fps / 0.08);
    s.throttle += (target[0] - s.throttle) * k;
    s.load += (target[1] - s.load) * k;
    s.overrun += (target[2] - s.overrun) * k;
    record(frames, i, t, s);
  }
  return { duration, frames, messages };
}

/** 풀가속 업시프트 → 브레이크로 다운시프트(블리핑) → 정차. 스포츠 AUTO 고정. */
function simulateShifts(preset, settings, { fps = 120 } = {}) {
  const messages = [];
  let now = 0;
  const vehicle = new Vehicle(preset, { seed: 11, onEvent: (msg) => messages.push({ t: now, msg }) });
  vehicle.setSettings({ ...settings, driveMode: 'auto', autoStyle: 'sport' });
  const duration = 19;
  const n = Math.ceil(duration * fps);
  const frames = new Float32Array(n * FRAME_STRIDE);
  const dt = 1 / fps;
  vehicle.start();
  for (let i = 0; i < n; i++) {
    now = i * dt;
    let input = { mode: 'test', gas: null, brake: null, rev: 0 };
    if (now >= 2.5 && now < 11) input = { mode: 'test', gas: 1, brake: null };
    else if (now >= 11.6 && now < 17.5) input = { mode: 'test', gas: null, brake: 0.45 };
    record(frames, i, now, vehicle.update(dt, input));
  }
  return { duration, frames, messages };
}

export function simulateScenario(id, preset, settings, opts) {
  if (id === 'tone') return simulateTone(preset, opts);
  if (id === 'shifts') return simulateShifts(preset, settings, opts);
  return simulateDemo(preset, settings, opts);
}
