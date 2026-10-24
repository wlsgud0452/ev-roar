/**
 * 탑승 차량(실제 테슬라) 보정 프로파일. 가상 엔진 차량과는 별개로 고른다.
 *
 * GPS 가속도를 "테슬라 가속 페달을 얼마나 밟았는가"로 바꾸는 데 쓴다.
 *   peakAccel   저속 최대 가속도 (m/s²) — 공식 0→100 km/h(또는 0→60 mph) 시간에서 역산한 추정값
 *   powerAccel  출력/중량 (W/kg) — 고속에서 a_max ≈ powerAccel / v
 *   audio       기본 오디오 구성 ('standard' = 서브우퍼 없음, 'premium' = 서브우퍼 포함)
 * 모두 공개 제원에서 계산한 추정값이며 실측값이 아니다.
 */
export const TESLA_MODELS = [
  { id: 'm3-rwd', name: 'Model 3 RWD', peakAccel: 5.6, powerAccel: 115, audio: 'standard' },
  { id: 'm3-lr', name: 'Model 3 Long Range AWD', peakAccel: 7.8, powerAccel: 175, audio: 'premium' },
  { id: 'm3-p', name: 'Model 3 Performance', peakAccel: 10.0, powerAccel: 230, audio: 'premium' },
  { id: 'my-rwd', name: 'Model Y RWD', peakAccel: 5.0, powerAccel: 105, audio: 'standard' },
  { id: 'my-lr', name: 'Model Y Long Range AWD', peakAccel: 6.9, powerAccel: 150, audio: 'premium' },
  { id: 'my-p', name: 'Model Y Performance', peakAccel: 8.8, powerAccel: 190, audio: 'premium' },
  { id: 'ms-lr', name: 'Model S / X Long Range', peakAccel: 9.0, powerAccel: 230, audio: 'premium' },
  { id: 'ms-plaid', name: 'Model S / X Plaid', peakAccel: 13.0, powerAccel: 330, audio: 'premium' },
];

export const DEFAULT_TESLA_ID = 'm3-lr';

/** 회생제동 설정별 발을 뗐을 때의 감속도 (m/s²) */
export const REGEN = {
  standard: { label: '표준', decel: 2.0 },
  low: { label: '낮음', decel: 1.1 },
};

/** 오디오 구성별 저음 보정 (dB, 로우셸프에 더함) */
export const AUDIO_SYSTEMS = {
  standard: { label: '기본 오디오', bassDb: 3, hpHz: 45 },
  premium: { label: '프리미엄 (서브우퍼)', bassDb: 0, hpHz: 22 },
};

export function getTesla(id) {
  return TESLA_MODELS.find((m) => m.id === id) || TESLA_MODELS.find((m) => m.id === DEFAULT_TESLA_ID);
}

/** 속도 v(m/s)에서 이 테슬라가 낼 수 있는 최대 가속도 */
export function teslaMaxAccel(model, v) {
  return Math.max(1.5, Math.min(model.peakAccel, model.powerAccel / Math.max(v, 1)));
}
