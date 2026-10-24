import test from 'node:test';
import assert from 'node:assert/strict';
import { getPreset, PRESETS } from '../js/presets/presets.js';
import { Vehicle, engineRpmFromSpeed, wheelRpm, speedFromEngineRpm } from '../js/sim/vehicle.js';
import { simulateDemo, simulateScenario, FRAME_STRIDE } from '../js/sim/demo.js';

const near = (a, b, tol) => Math.abs(a - b) <= tol;
const DT = 1 / 60;

test('기어비 → rpm 계산', () => {
  const p = getPreset('mustang-gt');
  const v = 100 / 3.6;
  const w = wheelRpm(v, p.tireDiameter);
  assert.ok(near(wheelRpm(v, 0.7), 757.9, 0.5));
  assert.ok(near(engineRpmFromSpeed(v, p, 10), w * p.gearRatios[9] * p.finalDrive, 1e-6));
  assert.ok(near(speedFromEngineRpm(engineRpmFromSpeed(v, p, 3), p, 3), v, 1e-9));
});

function runWithInput(preset, seconds, inputFn, settings = {}) {
  const events = [];
  const v = new Vehicle(preset, { seed: 3, onEvent: (e) => events.push(e) });
  v.setSettings(settings);
  v.start();
  const log = [];
  for (let t = 0; t < seconds; t += DT) {
    const s = v.update(DT, inputFn(t, v));
    log.push({ t, ...s });
  }
  return { log, events, vehicle: v };
}

/** 시동 후 정속으로 특정 기어·속도에 맞춰 둔 차량 */
function cruising(preset, gear, speed, settings = {}) {
  const v = new Vehicle(preset, { seed: 5 });
  v.setSettings(settings);
  v.start();
  for (let i = 0; i < 180; i++) v.update(DT, { mode: 'test' });
  v.speed = speed;
  v.gear = gear;
  v.rpm = v.rpmInGear(speed, gear);
  v.lastShiftT = -10;
  return v;
}

test('AUTO 풀스로틀: 모든 차종에서 업시프트가 일어나고 변속 후 rpm이 떨어지며 리미터를 넘지 않는다', () => {
  for (const p of PRESETS.filter((x) => x.type !== 'ev')) {
    const { log } = runWithInput(p, 16, (t) => (t < 3 ? { mode: 'test' } : { mode: 'test', gas: 1 }));
    const gears = new Set(log.map((s) => s.gear));
    assert.ok(gears.size >= 3, `${p.id}: 기어 ${[...gears]}`);
    const maxRpm = Math.max(...log.map((s) => s.rpm));
    assert.ok(maxRpm < p.limiterRpm + 120, `${p.id}: 최대 rpm ${maxRpm.toFixed(0)}`);
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

test('rpm이 프레임 간 비정상적으로 튀지 않는다 (엔진 관성, 모든 변속기 형식)', () => {
  for (const id of ['mustang-gt', 'porsche-911-gt3', 'camaro-zl1', 'lamborghini-aventador', 'amg-e63-wagon']) {
    const { log } = runWithInput(getPreset(id), 16, (t) => (t < 3 ? { mode: 'test' } : t < 11 ? { mode: 'test', gas: 1 } : { mode: 'test', brake: 0.5 }),
      { autoStyle: 'sport' });
    for (let i = 1; i < log.length; i++) {
      const d = Math.abs(log[i].rpm - log[i - 1].rpm);
      assert.ok(d < 900, `${id} t=${log[i].t.toFixed(2)} 변화량 ${d.toFixed(0)}`);
    }
  }
});

test('업시프트: 부하 감소 → rpm 변화 → 부하 회복이 순서대로 이어진다', () => {
  const p = getPreset('porsche-911-gt3');
  const { log } = runWithInput(p, 10, (t) => (t < 3 ? { mode: 'test' } : { mode: 'test', gas: 1 }));
  const i = log.findIndex((s, k) => k > 0 && s.shifting && !log[k - 1].shifting && Number(s.gearLabel) === 3);
  assert.ok(i > 0, '2→3 변속 없음');
  const before = log[i - 1];
  let j = i;
  while (log[j].shifting) j++;
  const during = log.slice(i, j);
  const minLoad = Math.min(...during.map((s) => s.load));
  assert.ok(minLoad < before.load * 0.6, `변속 중 부하 ${minLoad.toFixed(2)} (변속 전 ${before.load.toFixed(2)})`);
  // 부하가 바닥을 찍는 시점이 rpm이 가장 많이 내려간 시점보다 앞선다
  const tLoad = during.findIndex((s) => s.load === minLoad);
  assert.ok(tLoad <= during.length - 1);
  assert.ok(log[j + 6].load > before.load * 0.85, `변속 후 부하 회복 ${log[j + 6].load.toFixed(2)}`);
  assert.ok(log[j].rpm < before.rpm - 1000, 'rpm이 새 기어로 이동');
});

test('다운시프트 레브매칭: 오프스로틀이어도 블리핑으로 rpm이 먼저 올라간다', () => {
  const p = getPreset('porsche-911-gt3');
  const v = cruising(p, 5, 22, { driveMode: 'manual' });
  for (let i = 0; i < 30; i++) v.update(DT, { mode: 'test', gas: null });
  const r0 = v.rpm;
  const res = v.requestShift(-1);
  assert.ok(res.ok);
  let maxThr = 0;
  let maxRpm = 0;
  while (v.shift) {
    const s = v.update(DT, { mode: 'test', gas: null });
    maxThr = Math.max(maxThr, s.throttle);
    maxRpm = Math.max(maxRpm, s.rpm);
  }
  assert.ok(maxThr > 0.2, `블리핑 스로틀 ${maxThr.toFixed(2)}`);
  assert.ok(maxRpm > r0 * 1.15, `블리핑 rpm ${maxRpm.toFixed(0)} (전 ${r0.toFixed(0)})`);
  assert.equal(v.gear, 4);
});

test('MANUAL: 입력 1회당 변속 1회, 변속 중 추가 입력은 한 번만 예약', () => {
  const p = getPreset('porsche-911-gt3');
  const v = cruising(p, 2, 15, { driveMode: 'manual' });
  assert.equal(v.requestShift(1).ok, true);
  const q = v.requestShift(1);
  assert.equal(q.ok, true);
  assert.equal(q.queued, true);
  assert.equal(v.requestShift(1).reason, 'busy');
  for (let i = 0; i < 120; i++) v.update(DT, { mode: 'test', gas: 0.3 });
  assert.equal(v.gear, 4, '2 → 3 → 4 (세 번째 입력은 무시)');
  // 이후 입력 없이 기어가 그대로 유지된다 (자동 업시프트 없음)
  for (let i = 0; i < 300; i++) v.update(DT, { mode: 'test', gas: 0.3 });
  assert.equal(v.gear, 4);
});

test('MANUAL: 과회전이 되는 다운시프트는 차단된다', () => {
  const p = getPreset('porsche-911-gt3');
  const v = cruising(p, 3, 0, { driveMode: 'manual' });
  v.speed = speedFromEngineRpm(p.redline * 0.85, p, 3);
  v.rpm = p.redline * 0.85;
  const res = v.requestShift(-1);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'overrev');
  assert.equal(v.gear, 3);
  assert.equal(v.shift, null);
});

test('MANUAL: 리미터에 닿아도 자동 업시프트 없이 리미터 바운스', () => {
  const p = getPreset('ferrari-812');
  const { log, events } = runWithInput(p, 10, (t) => (t < 3 ? { mode: 'test' } : { mode: 'test', gas: 1 }), { driveMode: 'manual' });
  assert.ok(log.every((s) => s.gear === 1), '1단 유지');
  assert.ok(events.filter((e) => e.type === 'limiterCut').length >= 3);
});

test('MANUAL: 회전이 너무 떨어지면 자동 다운시프트 (시동 꺼짐 방지)', () => {
  const p = getPreset('camaro-zl1');
  const v = cruising(p, 6, 30, { driveMode: 'manual' });
  for (let i = 0; i < 60 * 25; i++) v.update(DT, { mode: 'test', gas: null, brake: 0.3 });
  assert.ok(v.gear <= 2, `감속 후 기어 ${v.gear}`);
  assert.ok(v.rpm >= p.idleRpm * 0.95);
});

test('AUTO 킥다운: 정속 중 풀스로틀이면 여러 단을 한 번에 내린다', () => {
  const p = getPreset('mustang-gt');
  const v = cruising(p, 8, 80 / 3.6);
  const from = v.gear;
  let first = null;
  for (let i = 0; i < 60; i++) {
    v.update(DT, { mode: 'test', gas: 1 });
    if (v.shift && !first) first = { ...v.shift };
  }
  assert.ok(first, '킥다운 없음');
  assert.ok(from - first.to >= 2, `${from} → ${first.to}`);
});

test('AUTO Sport는 Comfort보다 높은 rpm에서 업시프트', () => {
  const p = getPreset('porsche-911-gt3');
  const shiftRpm = (autoStyle) => {
    const { log } = runWithInput(p, 12, (t) => (t < 3 ? { mode: 'test' } : { mode: 'test', gas: 0.35 }), { autoStyle });
    const i = log.findIndex((s, k) => k > 0 && s.shifting && !log[k - 1].shifting);
    return log[i - 1].rpm;
  };
  const c = shiftRpm('comfort');
  const s = shiftRpm('sport');
  assert.ok(s > c + 1000, `comfort ${c.toFixed(0)} / sport ${s.toFixed(0)}`);
});

test('흡배기·청취 설정은 rpm·기어 계산에 영향을 주지 않는다', () => {
  const p = getPreset('audi-rs3');
  const input = (t) => (t < 3 ? { mode: 'test' } : t < 9 ? { mode: 'test', gas: 1 } : { mode: 'test', gas: null });
  const a = runWithInput(p, 12, input, { intake: 'stock', valve: 'closed', listen: 'exterior' }).log;
  const b = runWithInput(p, 12, input, { intake: 'sport', valve: 'open', listen: 'interior' }).log;
  assert.deepEqual(a.map((s) => [s.rpm, s.gear, s.load]), b.map((s) => [s.rpm, s.gear, s.load]));
});

test('시동 시퀀스: 크랭킹 → 오버슈트 → 공회전 안착', () => {
  const p = getPreset('mustang-gt');
  const { log, events } = runWithInput(p, 5, () => ({ mode: 'test' }));
  assert.equal(events[0].type, 'ignition');
  assert.ok(events.some((e) => e.type === 'starter' && e.on));
  const peak = Math.max(...log.map((s) => s.rpm));
  assert.ok(peak > p.idleRpm * 1.5 && peak < p.idleRpm * 2.1, `오버슈트 ${peak}`);
  assert.ok(near(log[log.length - 1].rpm, p.idleRpm, 15));
  assert.equal(log[log.length - 1].engine, 'running');
});

test('정차 REV: 리미터에서 연료 컷 바운스가 발생', () => {
  const p = getPreset('mustang-gt');
  const { log, events } = runWithInput(p, 6, (t) => ({ mode: 'test', rev: t > 3 ? 1 : 0 }));
  assert.ok(events.filter((e) => e.type === 'limiterCut').length >= 3);
  assert.ok(log.some((s) => s.fuelCut));
});

test('오버런 신호: 가속 중 0, 고rpm 리프트오프 후 1에 가깝다', () => {
  const p = getPreset('elantra-n');
  const { log } = runWithInput(p, 12, (t) => (t < 3 ? { mode: 'test' } : t < 8 ? { mode: 'test', gas: 1 } : { mode: 'test', gas: null }));
  const at = (t) => log.find((s) => s.t >= t);
  assert.ok(at(7).overrun < 0.05);
  assert.ok(at(9).overrun > 0.8, `오버런 ${at(9).overrun}`);
});

test('GPS 스로틀 추정: 정속은 낮은 부하, 회생 정도의 감속은 0 (오버런), 가속은 높음', () => {
  const p = getPreset('mustang-gt');
  const v = new Vehicle(p, { seed: 1 });
  v.start();
  for (let i = 0; i < 300; i++) v.update(DT, { mode: 'gps', speed: 0, accel: 0 });
  let s;
  for (let i = 0; i < 240; i++) s = v.update(DT, { mode: 'gps', speed: 25, accel: 0 });
  assert.ok(s.throttle >= 0.1 && s.throttle <= 0.3, `크루즈 스로틀 ${s.throttle}`);
  for (let i = 0; i < 120; i++) s = v.update(DT, { mode: 'gps', speed: 25, accel: -1.5 });
  assert.ok(s.throttle < 0.02, `감속 스로틀 ${s.throttle}`);
  for (let i = 0; i < 120; i++) s = v.update(DT, { mode: 'gps', speed: 10, accel: 3 });
  assert.ok(s.throttle > 0.5, `가속 스로틀 ${s.throttle}`);
});

test('테슬라 보정: 같은 가속도라도 강한 차(Plaid)일수록 페달을 덜 밟은 것으로 추정', () => {
  const p = getPreset('mustang-gt');
  const thr = (teslaId) => {
    const v = new Vehicle(p, { seed: 1 });
    v.setSettings({ teslaId });
    v.start();
    for (let i = 0; i < 300; i++) v.update(DT, { mode: 'gps', speed: 0, accel: 0 });
    let s;
    for (let i = 0; i < 90; i++) s = v.update(DT, { mode: 'gps', speed: 12, accel: 3 });
    return s.throttle;
  };
  assert.ok(thr('my-rwd') > thr('ms-plaid') + 0.2, `${thr('my-rwd')} vs ${thr('ms-plaid')}`);
});

function gpsRun(p, seconds, fn, settings = {}) {
  const v = new Vehicle(p, { seed: 9 });
  v.setSettings(settings);
  v.start();
  for (let i = 0; i < 300; i++) v.update(DT, { mode: 'gps', speed: 0, accel: 0 });
  const log = [];
  let shifts = 0;
  let prevShift = false;
  for (let t = 0; t < seconds; t += DT) {
    const s = v.update(DT, { mode: 'gps', ...fn(t) });
    if (s.shifting && !prevShift) shifts++;
    prevShift = s.shifting;
    log.push({ t, ...s, shifts });
  }
  return { log, shifts, v };
}

test('GPS 잡음(속도·가속도 오차)에도 정속 중 연속 변속이 없다', () => {
  let seed = 42;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  for (const autoStyle of ['comfort', 'sport']) {
    const { log } = gpsRun(getPreset('amg-e63-wagon'), 70, (t) => ({
      speed: Math.min(20, t * 2.5) + rnd() * 0.6,
      accel: (t < 8 ? 2.5 : 0) + rnd() * 1.2,
      quality: 0.5,
    }), { autoStyle });
    const settled = log.filter((s) => s.t > 15);
    const n = settled[settled.length - 1].shifts - settled[0].shifts;
    assert.ok(n <= 1, `${autoStyle}: 정속 55초 동안 변속 ${n}회`);
  }
});

test('GPS 단절: 고rpm 가속 중 신호가 끊겨도 고회전에 고정되지 않는다', () => {
  const p = getPreset('porsche-911-gt3');
  const { log } = gpsRun(p, 14, (t) => (t < 5
    ? { speed: 3 + t * 5, accel: 5 }
    : { speed: 28, accel: 0, stale: true }), { autoStyle: 'sport' });
  const end = log[log.length - 1];
  assert.ok(end.rpm < p.redline * 0.6, `단절 후 rpm ${end.rpm.toFixed(0)}`);
  const staleLog = log.filter((s) => s.t > 6);
  assert.ok(Math.max(...staleLog.map((s) => s.throttle)) < 0.3, '단절 중 스로틀 급등 없음');
});

test('데모 런 시뮬레이션: 리프트오프·시프트 팝·다운시프트 이벤트 포함, 끝에서 정차', () => {
  const p = getPreset('mustang-gt');
  const { frames, messages, duration } = simulateDemo(p, { crackle: 0.5 });
  const types = new Set(messages.map((m) => m.msg.type));
  for (const t of ['starter', 'ignition', 'liftoff', 'shiftPop', 'downshift', 'limiterCut', 'gear']) assert.ok(types.has(t), `이벤트 ${t} 없음`);
  assert.ok(duration > 26);
  const n = frames.length / FRAME_STRIDE;
  const maxRpm = Math.max(...Array.from({ length: n }, (_, i) => frames[i * FRAME_STRIDE + 1]));
  assert.ok(maxRpm > p.redline * 0.85);
  assert.ok(frames[(n - 1) * FRAME_STRIDE + 1] < 50, '마지막에 엔진 정지');
});

test('A/B 시나리오: 모든 차종에서 프레임이 유한값으로 생성된다', () => {
  for (const p of PRESETS) {
    for (const id of ['tone', 'shifts']) {
      const { frames, duration } = simulateScenario(id, p, p.tuning);
      assert.ok(duration > 5);
      assert.ok(frames.every(Number.isFinite), `${p.id} ${id}`);
    }
  }
});
