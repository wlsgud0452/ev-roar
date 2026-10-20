import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, getPreset, bankIntervals, anglesFromOrder } from '../js/presets/presets.js';

test('anglesFromOrder: 점화 순서대로 등간격 각도를 실린더 인덱스에 배치', () => {
  assert.deepEqual(anglesFromOrder([1, 3, 4, 2], 180), [0, 540, 180, 360]);
});

test('크로스플레인 V8: 엔진 전체는 90° 등간격, 뱅크별로는 불균등 간격', () => {
  for (const id of ['v8-muscle', 'sc-v8-manual', 'tt-v8-wagon']) {
    const p = getPreset(id);
    const all = [...p.firingAngles].sort((a, b) => a - b);
    assert.deepEqual(all, [0, 90, 180, 270, 360, 450, 540, 630], id);
    for (const bank of [0, 1]) {
      const iv = bankIntervals(p, bank);
      assert.equal(iv.length, 4);
      assert.equal(iv.reduce((a, b) => a + b, 0), 720);
      assert.ok(new Set(iv).size > 1, `${id} bank ${bank} 간격이 균등함: ${iv}`);
    }
    // 1-8-4-3-6-5-7-2: 좌뱅크(홀수) 270,180,90,180 / 우뱅크(짝수) 90,180,270,180
    assert.deepEqual(bankIntervals(p, 0), [270, 180, 90, 180]);
    assert.deepEqual(bankIntervals(p, 1), [90, 180, 270, 180]);
  }
});

test('균등 점화 엔진: 플랫6/V6는 뱅크당 240°, V12는 120°, I4는 180°', () => {
  for (const id of ['flat6-gt', 'shift-maniac', 'race-v6']) {
    const p = getPreset(id);
    assert.deepEqual(bankIntervals(p, 0), [240, 240, 240], id);
    assert.deepEqual(bankIntervals(p, 1), [240, 240, 240], id);
  }
  const v12 = getPreset('v12-super');
  assert.deepEqual(bankIntervals(v12, 0), Array(6).fill(120));
  assert.deepEqual(bankIntervals(v12, 1), Array(6).fill(120));
  assert.deepEqual(bankIntervals(getPreset('i4-hothatch'), 0), [180, 180, 180, 180]);
});

test('모든 프리셋 필드 정합성', () => {
  assert.equal(PRESETS.length, 9);
  const ids = new Set();
  for (const p of PRESETS) {
    assert.ok(!ids.has(p.id), `중복 id ${p.id}`);
    ids.add(p.id);
    assert.equal(p.firingAngles.length, p.cylinders, p.id);
    assert.equal(p.bankOf.length, p.cylinders, p.id);
    assert.ok(p.limiterRpm > p.redline, p.id);
    assert.ok(p.gearRatios.length >= 1, p.id);
    for (let i = 1; i < p.gearRatios.length; i++) assert.ok(p.gearRatios[i] < p.gearRatios[i - 1], `${p.id} 기어비 내림차순`);
    for (const k of ['exhaust', 'intake', 'mech', 'forced', 'trans', 'sub']) assert.equal(typeof p.mix[k], 'number', `${p.id} mix.${k}`);
    assert.ok(p.image.startsWith('assets/cars/'), p.id);
  }
});
