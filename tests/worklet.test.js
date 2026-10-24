import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorklet, Runner, rms, peak, hasNaN, db } from './harness.js';
import { PRESETS, getPreset } from '../js/presets/presets.js';
import { simulateDemo, simulateScenario } from '../js/sim/demo.js';

const Proc = await loadWorklet();
const SETTINGS = { character: 0.5, crackle: 0.5, bass: 0.4 };

function steady(preset, rpm, thr, load, seconds = 1, settings = SETTINGS) {
  const r = new Runner(Proc, { preset, settings });
  r.send({ type: 'ignition', on: true });
  return r.render(seconds, (t, p) => { p.rpm = rpm; p.throttle = thr; p.load = load; });
}

test('모든 프리셋: NaN 없음, 워크렛 출력 피크 < 1.0, 소리가 남', () => {
  for (const p of PRESETS) {
    const idle = p.type === 'ev' ? 3000 : p.idleRpm;
    for (const [rpm, thr, load] of [[idle, 0, 0], [p.redline * 0.5, 1, 1], [p.redline * 0.98, 1, 1]]) {
      const [L, R] = steady(p, rpm, thr, load);
      assert.ok(!hasNaN(L) && !hasNaN(R), `${p.id} NaN @${rpm}`);
      assert.ok(peak(L) < 1 && peak(R) < 1, `${p.id} 피크 ${peak(L).toFixed(2)} @${rpm}`);
      assert.ok(rms(L, 12000) > 0.005, `${p.id} 무음 @${rpm}`);
    }
  }
});

test('크래클 100% + 풀스로틀 리프트오프 + 리미터: 워크렛 출력이 폭주하지 않는다', () => {
  for (const p of PRESETS.filter((x) => x.type !== 'ev')) {
    const r = new Runner(Proc, { preset: p, settings: { character: 1, crackle: 1, bass: 1 } });
    r.send({ type: 'ignition', on: true });
    const [L] = r.render(4, (t, prm) => {
      prm.rpm = t < 1 ? p.redline : p.redline * 0.7;
      prm.throttle = t < 1 ? 1 : 0;
      prm.load = prm.throttle;
      prm.fuelCut = t < 1 && Math.floor(t * 25) % 2 === 0 ? 1 : 0;
      if (Math.abs(t - 1) < 0.003) r.send({ type: 'liftoff' });
      if (t < 1 && Math.floor(t * 25) % 2 === 0) r.send({ type: 'limiterCut' });
    });
    assert.ok(!hasNaN(L), p.id);
    assert.ok(peak(L) < 2, `${p.id} 피크 ${peak(L).toFixed(2)} (후단 리미터가 처리하는 범위)`);
  }
});

function popEnergy(crackle) {
  // 같은 시드에서 크래클만 바꿔 오버런 구간의 고역 과도 에너지를 비교
  const p = getPreset('elantra-n');
  const r = new Runner(Proc, { preset: p, settings: { character: 0.5, crackle, bass: 0.4 } });
  r.send({ type: 'ignition', on: true });
  const [L] = r.render(2.5, (t, prm) => {
    prm.rpm = 4500; prm.throttle = t < 0.5 ? 1 : 0; prm.load = prm.throttle;
    if (Math.abs(t - 0.5) < 0.002) r.send({ type: 'liftoff' });
  });
  let e = 0;
  for (let i = 24000 + 1; i < L.length; i++) { const d = L[i] - L[i - 1]; e += d * d; }
  return e;
}

test('크래클 0%면 오버런이 완전히 깨끗하고, 크래클을 올리면 팝 에너지가 늘어난다', () => {
  const p = getPreset('mustang-gt');
  const count = (crackle) => {
    const r = new Runner(Proc, { preset: p, settings: { character: 0.5, crackle, bass: 0.4 } });
    r.send({ type: 'ignition', on: true });
    let pops = 0;
    const spawn = r.proc.spawnPop.bind(r.proc);
    r.proc.spawnPop = (...args) => { pops++; spawn(...args); };
    r.render(2.5, (t, prm) => {
      prm.rpm = 4500; prm.throttle = t < 0.5 ? 1 : 0; prm.load = prm.throttle;
      if (Math.abs(t - 0.5) < 0.002) r.send({ type: 'liftoff' });
    });
    return { pops, active: Array.from(r.proc.pActive).some(Boolean) };
  };
  const c0 = count(0);
  assert.equal(c0.pops, 0);
  assert.equal(c0.active, false);
  const c1 = count(1);
  assert.ok(c1.pops >= 5, `크래클 100% 팝 수 ${c1.pops}`);
  assert.ok(popEnergy(1) > popEnergy(0) * 1.5);
});

test('rpm 스윕: 샘플 간 급격한 불연속(클릭) 없음', () => {
  const p = getPreset('ferrari-812');
  const r = new Runner(Proc, { preset: p, settings: SETTINGS });
  r.send({ type: 'ignition', on: true });
  const [L] = r.render(4, (t, prm) => { prm.rpm = p.idleRpm + (p.redline - p.idleRpm) * Math.min(1, t / 3.5); prm.throttle = 1; prm.load = 1; });
  let maxJump = 0;
  for (let i = 4800; i < L.length; i++) maxJump = Math.max(maxJump, Math.abs(L[i] - L[i - 1]));
  assert.ok(maxJump < 0.5, `최대 샘플 점프 ${maxJump.toFixed(3)}`);
});

test('프리셋 크로스페이드 교체 중 NaN/튐 없음', () => {
  const r = new Runner(Proc, { preset: getPreset('mustang-gt'), settings: SETTINGS });
  r.send({ type: 'ignition', on: true });
  let sent = false;
  const [L] = r.render(1.5, (t, prm) => {
    prm.rpm = 3000; prm.throttle = 0.5; prm.load = 0.5;
    if (!sent && t > 0.5) { r.send({ type: 'preset', preset: getPreset('porsche-911-gt3'), crossfade: true }); sent = true; }
  });
  assert.ok(!hasNaN(L));
  assert.equal(r.proc.P.id, 'porsche-911-gt3');
  // 교체 순간(페이드 바닥) 근처 레벨이 아주 작아야 함
  const swapAt = Math.round((0.5 + 0.1) * 48000);
  assert.ok(rms(L, swapAt - 200, swapAt + 200) < rms(L, 12000, 24000) * 0.2);
});

test('타임라인 모드(오프라인 렌더 경로)로 데모 런 전체를 재생', () => {
  const p = getPreset('elantra-n');
  const { duration, frames, messages } = simulateDemo(p, { crackle: 0.6 });
  const r = new Runner(Proc, { preset: p, settings: SETTINGS, timeline: { frames, messages } });
  const [L] = r.render(duration);
  assert.ok(!hasNaN(L));
  assert.ok(rms(L) > 0.01);
  assert.ok(peak(L) < 1.6);
});

test('워크렛 CPU: 블록당 처리 시간이 실시간 예산(128샘플 ≈ 2.67ms)의 25% 미만', () => {
  const p = getPreset('ferrari-812');
  const r = new Runner(Proc, { preset: p, settings: SETTINGS });
  r.send({ type: 'ignition', on: true });
  r.render(0.5, (t, prm) => { prm.rpm = 8000; prm.throttle = 1; prm.load = 1; });
  const t0 = performance.now();
  const sec = 5;
  r.render(sec, (t, prm) => { prm.rpm = 8000; prm.throttle = 1; prm.load = 1; });
  const perBlock = (performance.now() - t0) / ((sec * 48000) / 128);
  assert.ok(perBlock < 2.67 * 0.25, `${perBlock.toFixed(3)} ms/블록`);
});

test('장시간 재생에도 보이스가 누적되지 않는다 (메모리 고정)', () => {
  const p = getPreset('mustang-gt');
  const r = new Runner(Proc, { preset: p, settings: { character: 1, crackle: 1, bass: 0.5 } });
  r.send({ type: 'ignition', on: true });
  r.render(30, (t, prm) => {
    prm.rpm = 2000 + 4000 * (0.5 + 0.5 * Math.sin(t)); prm.throttle = Math.sin(t) > 0 ? 1 : 0; prm.load = prm.throttle;
    if (Math.abs((t % 6.28) - 1.57) < 0.003) r.send({ type: 'liftoff' });
  });
  const active = Array.from(r.proc.vActive).filter(Boolean).length;
  assert.ok(active < 20, `활성 보이스 ${active}`);
});

/** 1차 차분 RMS / RMS — 값이 클수록 고역이 많은(밝은) 소리 */
function brightness(a, from) {
  let d = 0;
  for (let i = from + 1; i < a.length; i++) { const x = a[i] - a[i - 1]; d += x * x; }
  return Math.sqrt(d / (a.length - from)) / Math.max(rms(a, from), 1e-9);
}

function render(preset, { rpm, thr, load, overrun = 0, settings = SETTINGS, seconds = 1.2 }) {
  const r = new Runner(Proc, { preset, settings });
  r.send({ type: 'ignition', on: true });
  r.send({ type: 'gear', gear: 3, ratio: preset.gearRatios[2] });
  const [L] = r.render(seconds, (t, p) => { p.rpm = rpm; p.throttle = thr; p.load = load; p.overrun = overrun; });
  return L;
}

test('같은 rpm에서 가속 · 정속 · 감속(오버런) 음색이 구별된다 (모든 차종)', () => {
  const noPops = { ...SETTINGS, crackle: 0 };
  for (const p of PRESETS.filter((x) => x.type !== 'ev')) {
    const rpm = p.redline * 0.5;
    const acc = render(p, { rpm, thr: 1, load: 1, settings: noPops });
    const cru = render(p, { rpm, thr: 0.2, load: 0.2, settings: noPops });
    const dec = render(p, { rpm, thr: 0, load: 0, overrun: 1, settings: noPops });
    const from = 24000;
    const [ra, rc, rd] = [acc, cru, dec].map((a) => db(rms(a, from)));
    assert.ok(ra > rc + 2, `${p.id}: 가속 ${ra.toFixed(1)} / 정속 ${rc.toFixed(1)} dB`);
    assert.ok(rc > rd + 2, `${p.id}: 정속 ${rc.toFixed(1)} / 감속 ${rd.toFixed(1)} dB`);
    assert.ok(brightness(acc, from) > brightness(dec, from) * 0.9 || ra - rd > 8, `${p.id}: 밝기`);
  }
});

test('배기 밸브 열림은 닫힘보다 크고 밝다 · 흡기 스포츠는 흡기 레이어를 키운다', () => {
  const p = getPreset('porsche-911-gt3');
  const base = { rpm: 5000, thr: 0.8, load: 0.8 };
  const closed = render(p, { ...base, settings: { ...SETTINGS, crackle: 0, valve: 0 } });
  const open = render(p, { ...base, settings: { ...SETTINGS, crackle: 0, valve: 1 } });
  assert.ok(db(rms(open, 24000)) > db(rms(closed, 24000)) + 1.5);
  const exhaustOnly = (valve) => {
    const r = new Runner(Proc, { preset: p, settings: { ...SETTINGS, crackle: 0, valve }, layers: { intake: 0, mech: 0, forced: 0, trans: 0, pops: 0, sub: 0 } });
    r.send({ type: 'ignition', on: true });
    const [L] = r.render(1.2, (t, prm) => { Object.assign(prm, base); });
    return brightness(L, 24000);
  };
  assert.ok(exhaustOnly(1) > exhaustOnly(0) * 1.1, `밝기 열림 ${exhaustOnly(1).toFixed(3)} / 닫힘 ${exhaustOnly(0).toFixed(3)}`);

  const intakeOnly = (intake) => {
    const r = new Runner(Proc, { preset: p, settings: { ...SETTINGS, intake }, layers: { exhaust: 0, mech: 0, forced: 0, trans: 0, pops: 0, sub: 0 } });
    r.send({ type: 'ignition', on: true });
    const [L] = r.render(1.2, (t, prm) => { Object.assign(prm, base); });
    return rms(L, 24000);
  };
  assert.ok(db(intakeOnly(1)) > db(intakeOnly(0)) + 3);
});

test('흡배기 전환은 0.35초에 걸쳐 부드럽게 바뀐다 (클릭 없음)', () => {
  const p = getPreset('audi-rs3');
  const r = new Runner(Proc, { preset: p, settings: { ...SETTINGS, crackle: 0, valve: 0, intake: 0 } });
  r.send({ type: 'ignition', on: true });
  let sent = false;
  const [L] = r.render(2, (t, prm) => {
    prm.rpm = 4000; prm.throttle = 0.6; prm.load = 0.6;
    if (!sent && t > 1) { r.send({ type: 'settings', settings: { valve: 1, intake: 1 } }); sent = true; }
  });
  let maxJump = 0;
  for (let i = 4800; i < L.length; i++) maxJump = Math.max(maxJump, Math.abs(L[i] - L[i - 1]));
  assert.ok(maxJump < 0.5, `최대 샘플 점프 ${maxJump.toFixed(3)}`);
  assert.ok(r.proc.valveS > 0.9 && r.proc.intakeS > 0.9);
});

test('팝앤뱅 OFF면 크래클 강도와 무관하게 팝이 없다', () => {
  const p = getPreset('elantra-n');
  const r = new Runner(Proc, { preset: p, settings: { character: 1, crackle: 1, bass: 0.4, pops: false } });
  r.send({ type: 'ignition', on: true });
  let pops = 0;
  const spawn = r.proc.spawnPop.bind(r.proc);
  r.proc.spawnPop = (...args) => { pops++; spawn(...args); };
  r.render(2.5, (t, prm) => {
    prm.rpm = 5000; prm.throttle = t < 0.5 ? 1 : 0; prm.load = prm.throttle; prm.overrun = t < 0.5 ? 0 : 1;
    if (Math.abs(t - 0.5) < 0.002) { r.send({ type: 'liftoff' }); r.send({ type: 'shiftPop' }); }
  });
  assert.equal(pops, 0);
});

test('A/B 시나리오(같은 rpm 3상태 · 변속)를 타임라인 모드로 재생', () => {
  for (const id of ['porsche-911-gt3', 'camaro-zl1']) {
    const p = getPreset(id);
    for (const sc of ['tone', 'shifts']) {
      const { duration, frames, messages } = simulateScenario(sc, p, p.tuning);
      const r = new Runner(Proc, { preset: p, settings: SETTINGS, timeline: { frames, messages } });
      const [L] = r.render(duration);
      assert.ok(!hasNaN(L), `${id} ${sc}`);
      assert.ok(rms(L) > 0.01, `${id} ${sc} 무음`);
    }
  }
});
