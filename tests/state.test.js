import test from 'node:test';
import assert from 'node:assert/strict';

// 메모리 localStorage (state.js import 전에 설치) — 이전 버전 저장값이 있는 상태에서 시작
const store = new Map([['ev-roar-state-v1', JSON.stringify({ presetId: 'v12-super', volume: 0.5, unit: 'mph', intensity: 0.9 })]]);
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const { state, carTuning, setTuning, resetTuning, hasCustomTuning, effectiveSettings, setState } = await import('../js/state.js');
const { getPreset } = await import('../js/presets/presets.js');

test('v1 저장값을 새 실차 프로파일로 옮긴다', () => {
  assert.equal(state.presetId, 'ferrari-812');
  assert.equal(state.volume, 0.5);
  assert.equal(state.unit, 'mph');
});

test('차량별 튜닝: 기본값 → 사용자 설정 저장 → 다른 차량에 영향 없음 → 초기화', () => {
  const gt3 = getPreset('porsche-911-gt3');
  assert.deepEqual(carTuning(gt3.id), gt3.tuning);
  assert.equal(hasCustomTuning(gt3.id), false);

  setTuning(gt3.id, 'crackle', 0.9);
  assert.equal(carTuning(gt3.id).crackle, 0.9);
  assert.equal(hasCustomTuning(gt3.id), true);
  assert.equal(carTuning('audi-rs3').crackle, getPreset('audi-rs3').tuning.crackle);
  const saved = JSON.parse(store.get('ev-roar-state-v2'));
  assert.equal(saved.tuning[gt3.id].crackle, 0.9);

  // 기본값과 같은 값으로 되돌리면 사용자 설정에서 빠진다
  setTuning(gt3.id, 'crackle', gt3.tuning.crackle);
  assert.equal(hasCustomTuning(gt3.id), false);

  setTuning(gt3.id, 'bass', 0.1);
  resetTuning(gt3.id);
  assert.deepEqual(carTuning(gt3.id), gt3.tuning);
});

test('effectiveSettings: 차량 튜닝 + 전역 설정 + 오디오 구성(모델 기본)', () => {
  setState({ presetId: 'elantra-n', teslaId: 'm3-rwd', audioSystem: 'auto', valve: 'closed' });
  const e = effectiveSettings();
  assert.equal(e.character, getPreset('elantra-n').tuning.character);
  assert.equal(e.audioSystem, 'standard');
  assert.equal(e.valve, 'closed');
  setState({ audioSystem: 'premium' });
  assert.equal(effectiveSettings().audioSystem, 'premium');
});
