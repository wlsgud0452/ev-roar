import test from 'node:test';
import assert from 'node:assert/strict';
import { getPreset, PRESETS } from '../js/presets/presets.js';
import { Vehicle, engineRpmFromSpeed, wheelRpm, speedFromEngineRpm } from '../js/sim/vehicle.js';
import { simulateDemo, FRAME_STRIDE } from '../js/sim/demo.js';

const near = (a, b, tol) => Math.abs(a - b) <= tol;

test('기어비 → rpm 계산', () => {
  const p = getPreset('v8-muscle');
  // 100 km/h, 타이어 0.70m: 휠 rpm = 27.78 / (0.70π) × 60 ≈ 757.9
  const v = 100 / 3.6;
  assert.ok(near(wheelRpm(v, 0.7), 757.9, 0.5));
  assert.ok(near(engineRpmFromSpeed(v, p, 6), 757.9 * 0.56 * 3.73, 2));
  assert.ok(near(engineRpmFromSpeed(v, p, 1), 757.9 * 2.97 * 3.73, 5));
  // 왕복 변환
  assert.ok(near(speedFromEngineRpm(engineRpmFromSpeed(v, p, 3), p, 3), v, 1e-9));
});

function runWithInput(preset, seconds, inputFn, dt = 1 / 60) {
  const events = [];
  const v = new Vehicle(preset, { seed: 3, onEvent: (e) => events.push(e) });
  v.start();
  const log = [];
  for (let t = 0; t < seconds; t += dt) {
    const s = v.update(dt, inputFn(t));
    log.push({ t, ...s });
  }
  return { log, events, vehicle: v };
}

test('풀스로틀: 업시프트가 일어나고 변속 후 rpm이 떨어지며 리미터를 넘지 않는다', () => {
  for (const p of PRESETS.filter((x) => x.type !== 'ev')) {
    const { log } = runWithInput(p, 16, (t) => (t < 3 ? { mode: 'test' } : { mode: 'test', gas: 1 }));
    const gears = new Set(log.map((s) => s.gear));
    assert.ok(gears.size >= 3, `${p.id}: 기어 ${[...gears]}`);
    const maxRpm = Math.max(...log.map((s) => s.rpm));
    assert.ok(maxRpm < p.limiterRpm + 120, `${p.id}: 최대 rpm ${maxRpm.toFixed(0)}`);
    // 업시프트 시작 후 0.3초 안에 rpm 하락
    let checked = 0;
    for (let i = 1; i < log.length - 20; i++) {
      if (log[i].shifting && !log[i - 1].shifting && Number(log[i].gearLabel) > log[i - 1].gear) {
        const after = log[i + 18].rpm;
        assert.ok(after < log[i - 1].rpm - 300, `${p.id}: ${log[i - 1].gear}→${log[i].gearLabel} 변속 후 rpm 하락 없음`);
        checked++;
      }
    }
    assert.ok(checked >= 2, `${p.id}: 확인한 변속 ${checked}`);
  }
});

test('rpm이 프레임 간 비정상적으로 튀지 않는다 (엔진 관성)', () => {
  const p = getPreset('v8-muscle');
  const { log } = runWithInput(p, 14, (t) => (t < 3 ? { mode: 'test' } : t < 10 ? { mode: 'test', gas: 1 } : { mode: 'test', brake: 0.5 }));
  for (let i = 1; i < log.length; i++) {
    const d = Math.abs(log[i].rpm - log[i - 1].rpm);
    assert.ok(d < 900, `t=${log[i].t.toFixed(2)} 변화량 ${d.toFixed(0)}`);
  }
});

test('시동 시퀀스: 크랭킹 → 오버슈트 → 공회전 안착', () => {
  const p = getPreset('v8-muscle');
  const { log, events } = runWithInput(p, 5, () => ({ mode: 'test' }));
  assert.equal(events[0].type, 'ignition');
  assert.ok(events.some((e) => e.type === 'starter' && e.on));
  const peak = Math.max(...log.map((s) => s.rpm));
  assert.ok(peak > p.idleRpm * 1.5 && peak < p.idleRpm * 2.1, `오버슈트 ${peak}`);
  assert.ok(near(log[log.length - 1].rpm, p.idleRpm, 15));
  assert.equal(log[log.length - 1].engine, 'running');
});

test('정차 REV: 리미터에서 연료 컷 바운스가 발생', () => {
  const p = getPreset('v8-muscle');
  const { log, events } = runWithInput(p, 6, (t) => ({ mode: 'test', rev: t > 3 ? 1 : 0 }));
  assert.ok(events.filter((e) => e.type === 'limiterCut').length >= 3);
  assert.ok(log.some((s) => s.fuelCut));
});

test('GPS 모드 스로틀 추정: 정속은 낮은 부하, 감속은 0 (오버런)', () => {
  const p = getPreset('v8-muscle');
  const v = new Vehicle(p, { seed: 1 });
  v.start();
  for (let i = 0; i < 300; i++) v.update(1 / 60, { mode: 'gps', speed: 0, accel: 0 });
  let s;
  for (let i = 0; i < 240; i++) s = v.update(1 / 60, { mode: 'gps', speed: 25, accel: 0 });
  assert.ok(s.throttle >= 0.1 && s.throttle <= 0.26, `크루즈 스로틀 ${s.throttle}`);
  for (let i = 0; i < 120; i++) s = v.update(1 / 60, { mode: 'gps', speed: 25, accel: -1.5 });
  assert.ok(s.throttle < 0.02, `감속 스로틀 ${s.throttle}`);
  for (let i = 0; i < 120; i++) s = v.update(1 / 60, { mode: 'gps', speed: 10, accel: 3 });
  assert.ok(s.throttle > 0.5, `가속 스로틀 ${s.throttle}`);
});

test('데모 런 시뮬레이션: 리프트오프·시프트 팝·다운시프트 이벤트 포함, 끝에서 정차', () => {
  const p = getPreset('v8-muscle');
  const { frames, messages, duration } = simulateDemo(p, { intensity: 0.5, crackle: 0.5 });
  const types = new Set(messages.map((m) => m.msg.type));
  for (const t of ['starter', 'ignition', 'liftoff', 'shiftPop', 'downshift', 'limiterCut', 'gear']) assert.ok(types.has(t), `이벤트 ${t} 없음`);
  assert.ok(duration > 26);
  const n = frames.length / FRAME_STRIDE;
  const maxRpm = Math.max(...Array.from({ length: n }, (_, i) => frames[i * FRAME_STRIDE + 1]));
  assert.ok(maxRpm > p.redline * 0.85);
  assert.ok(frames[(n - 1) * FRAME_STRIDE + 1] < 50, '마지막에 엔진 정지');
});
