/**
 * 전역 상태 + localStorage 저장.
 *
 * - 전역 설정: 선택 차량, 볼륨, 단위, 속도 소스, AUTO/MANUAL, 흡배기·팝·청취 위치, 탑승 테슬라 보정
 * - 차량별 튜닝(tuning[차량 id]): 캐릭터·크래클·저음·공간감·가속 반응 감도·변속 성향.
 *   저장된 값이 없으면 차량 프로파일의 기본값을 쓰고, 초기화하면 다시 기본값으로 돌아간다.
 */
import { STORAGE_KEY, LEGACY_STORAGE_KEY } from './config.js';
import { DEFAULT_PRESET_ID, PRESETS, getPreset } from './presets/presets.js';
import { DEFAULT_TESLA_ID, getTesla } from './presets/tesla.js';

export const TUNING_KEYS = ['character', 'crackle', 'bass', 'space', 'response', 'shiftStyle'];

export const DEFAULTS = {
  presetId: DEFAULT_PRESET_ID,
  volume: 0.75,
  unit: 'kmh',
  mode: 'test',
  sampleMode: false,
  driveMode: 'auto', // 'auto' | 'manual'
  autoStyle: 'comfort', // 'comfort' | 'sport'
  intake: 'stock', // 'stock' | 'sport'
  valve: 'open', // 'closed' | 'open'
  pops: true,
  listen: 'exterior', // 'exterior' | 'interior'
  teslaId: DEFAULT_TESLA_ID,
  regen: 'standard',
  audioSystem: 'auto', // 'auto'(모델 기본) | 'standard' | 'premium'
  tuning: {},
};

function readLegacy() {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return {};
    const old = JSON.parse(raw);
    const out = {};
    for (const k of ['volume', 'unit', 'mode', 'sampleMode']) if (k in old) out[k] = old[k];
    if (old.presetId) out.presetId = getPreset(old.presetId).id;
    return out;
  } catch {
    return {};
  }
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const saved = raw ? JSON.parse(raw) : readLegacy();
    const s = { ...DEFAULTS, ...saved, tuning: { ...(saved.tuning || {}) } };
    if (!PRESETS.some((p) => p.id === s.presetId)) s.presetId = getPreset(s.presetId).id;
    return s;
  } catch {
    return { ...DEFAULTS, tuning: {} };
  }
}

export const state = load();
const listeners = new Set();

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* 저장 불가 환경(사파리 비공개 모드 등)은 무시 */ }
}

export function setState(patch) {
  Object.assign(state, patch);
  save();
  for (const fn of listeners) fn(state, patch);
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 차량 기본값 위에 사용자가 바꾼 값만 덮은 튜닝 */
export function carTuning(presetId = state.presetId) {
  return { ...getPreset(presetId).tuning, ...(state.tuning[presetId] || {}) };
}

export function hasCustomTuning(presetId = state.presetId) {
  return Object.keys(state.tuning[presetId] || {}).length > 0;
}

export function setTuning(presetId, key, value) {
  const cur = { ...(state.tuning[presetId] || {}), [key]: value };
  if (getPreset(presetId).tuning[key] === value) delete cur[key];
  setState({ tuning: { ...state.tuning, [presetId]: cur } });
}

export function resetTuning(presetId) {
  const tuning = { ...state.tuning };
  delete tuning[presetId];
  setState({ tuning });
}

export function audioSystemFor(s = state) {
  return s.audioSystem === 'auto' ? getTesla(s.teslaId).audio : s.audioSystem;
}

/** 오디오·시뮬레이터에 넘길 평탄화된 설정 */
export function effectiveSettings(s = state) {
  return {
    ...carTuning(s.presetId),
    volume: s.volume,
    driveMode: s.driveMode,
    autoStyle: s.autoStyle,
    intake: s.intake,
    valve: s.valve,
    pops: s.pops,
    listen: s.listen,
    teslaId: s.teslaId,
    regen: s.regen,
    audioSystem: audioSystemFor(s),
  };
}
