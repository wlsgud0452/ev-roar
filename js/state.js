/**
 * 전역 상태 (선택 차량, 슬라이더, 단위, 모드) + localStorage 저장.
 */
import { STORAGE_KEY } from './config.js';
import { DEFAULT_PRESET_ID, PRESETS } from './presets/presets.js';

export const DEFAULTS = {
  presetId: DEFAULT_PRESET_ID,
  volume: 0.75,
  intensity: 0.5,
  character: 0.5,
  crackle: 0.4,
  bass: 0.4,
  space: 0.4,
  unit: 'kmh',
  mode: 'test',
  sampleMode: false,
};

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const saved = raw ? JSON.parse(raw) : {};
    const s = { ...DEFAULTS, ...saved };
    if (!PRESETS.some((p) => p.id === s.presetId)) s.presetId = DEFAULT_PRESET_ID;
    return s;
  } catch {
    return { ...DEFAULTS };
  }
}

export const state = load();
const listeners = new Set();

export function setState(patch) {
  Object.assign(state, patch);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* 저장 불가 환경(사파리 비공개 모드 등)은 무시 */ }
  for (const fn of listeners) fn(state, patch);
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
