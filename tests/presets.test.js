import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, getPreset, bankIntervals, anglesFromOrder, tireDiameter, LEGACY_IDS } from '../js/presets/presets.js';

test('anglesFromOrder: 점화 순서대로 등간격 각도를 실린더 인덱스에 배치', () => {
  assert.deepEqual(anglesFromOrder([1, 3, 4, 2], 180), [0, 540, 180, 360]);
});

test('크로스플레인 V8: 엔진 전체는 90° 등간격, 뱅크별로는 불균등 간격', () => {
  for (const id of ['camaro-zl1', 'amg-e63-wagon', 'mustang-gt']) {
    const p = getPreset(id);
    const all = [...p.firingAngles].sort((a, b) => a - b);
    assert.deepEqual(all, [0, 90, 180, 270, 360, 450, 540, 630], id);
    for (const bank of [0, 1]) {
      const iv = bankIntervals(p, bank);
      assert.equal(iv.length, 4);
      assert.equal(iv.reduce((a, b) => a + b, 0), 720);
      assert.ok(new Set(iv).size > 1, `${id} bank ${bank} 간격이 균등함: ${iv}`);
    }
  }
  // LT4 1-8-7-2-6-5-4-3: 좌뱅크(홀수) 180,270,180,90 / 우뱅크(짝수) 180,90,180,270
  assert.deepEqual(bankIntervals(getPreset('camaro-zl1'), 0), [180, 270, 180, 90]);
  assert.deepEqual(bankIntervals(getPreset('camaro-zl1'), 1), [180, 90, 180, 270]);
});

test('균등 점화 엔진: 플랫6/V6는 뱅크당 240°, V12는 120°, I5는 144°, I4는 180°', () => {
  for (const id of ['porsche-911-gt3', 'nissan-gtr']) {
    const p = getPreset(id);
    assert.deepEqual(bankIntervals(p, 0), [240, 240, 240], id);
    assert.deepEqual(bankIntervals(p, 1), [240, 240, 240], id);
  }
  for (const id of ['lamborghini-aventador', 'ferrari-812']) {
    assert.deepEqual(bankIntervals(getPreset(id), 0), Array(6).fill(120), id);
    assert.deepEqual(bankIntervals(getPreset(id), 1), Array(6).fill(120), id);
  }
  assert.deepEqual(bankIntervals(getPreset('audi-rs3'), 0), Array(5).fill(144));
  assert.deepEqual(bankIntervals(getPreset('elantra-n'), 0), [180, 180, 180, 180]);
});

test('타이어 규격 → 동하중 지름', () => {
  // 315/30 R21: 533.4 + 189 = 722.4mm × 0.97
  assert.ok(Math.abs(tireDiameter(315, 30, 21) - 0.7007) < 0.001);
});

test('이전 버전 프리셋 id는 새 실차 프로파일로 연결된다', () => {
  for (const [old, id] of Object.entries(LEGACY_IDS)) assert.equal(getPreset(old).id, id);
});

test('모든 프로파일 필드 정합성 (엔진·변속기·이미지·기본 튜닝·사양 출처)', () => {
  assert.equal(PRESETS.length, 10);
  const ids = new Set();
  for (const p of PRESETS) {
    assert.ok(!ids.has(p.id), `중복 id ${p.id}`);
    ids.add(p.id);
    assert.ok(p.fullName && p.name && p.description, p.id);
    assert.equal(p.firingAngles.length, p.cylinders, p.id);
    assert.equal(p.bankOf.length, p.cylinders, p.id);
    assert.ok(p.limiterRpm > p.redline, p.id);
    assert.ok(p.gearRatios.length >= 1, p.id);
    for (let i = 1; i < p.gearRatios.length; i++) assert.ok(p.gearRatios[i] < p.gearRatios[i - 1], `${p.id} 기어비 내림차순`);
    for (const k of ['exhaust', 'intake', 'mech', 'forced', 'trans', 'sub']) assert.equal(typeof p.mix[k], 'number', `${p.id} mix.${k}`);
    assert.ok(p.image.startsWith('assets/cars/'), p.id);
    assert.ok(['synth', 'sample', 'hybrid'].includes(p.soundMethod), p.id);
    const g = p.gearbox;
    assert.ok(['manual', 'dct', 'auto', 'amt', 'mct'].includes(g.type), p.id);
    assert.ok(g.model, `${p.id} 변속기 모델명`);
    for (const m of [g.maps.comfort, g.maps.sport]) {
      assert.ok(m.upLight < m.upFull * p.redline, `${p.id} 업시프트 맵`);
      assert.ok(m.downLight < m.downFull, `${p.id} 다운시프트 맵`);
      assert.ok(m.downFull < m.upFull * p.redline * 0.8, `${p.id} 업/다운 히스테리시스`);
    }
    assert.ok(g.maps.sport.upLight > g.maps.comfort.upLight, `${p.id} 스포츠가 더 늦게 변속`);
    for (const k of ['character', 'crackle', 'bass', 'space', 'response', 'shiftStyle']) {
      assert.ok(p.tuning[k] >= 0 && p.tuning[k] <= 1, `${p.id} tuning.${k}`);
    }
    for (const [label, value, src] of p.specs) {
      assert.ok(label && value, p.id);
      assert.ok(['spec', 'est', 'tuned'].includes(src), `${p.id} ${label} 출처 표기`);
    }
  }
});
