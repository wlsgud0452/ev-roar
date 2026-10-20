/**
 * 차량 프리셋 정의.
 *
 * 각 엔진 형식의 표준 점화 순서로 실린더별 점화 크랭크각(firingAngles, 실린더 인덱스 0부터)과
 * 뱅크 매핑(bankOf, 0=L / 1=R)을 채운다. 4행정이므로 한 사이클은 720°.
 *
 * @typedef {Object} Preset
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {string} image
 * @property {'ice'|'ev'} type
 * @property {string} layout
 * @property {number} cylinders
 * @property {number[]} firingOrder   1부터 시작하는 실린더 번호 점화 순서 (참고용)
 * @property {number[]} firingAngles  실린더 인덱스별 점화 크랭크각 (0~720)
 * @property {number[]} bankOf        실린더 인덱스별 뱅크
 */

/** 점화 순서(1부터 시작하는 실린더 번호)와 등간격 크랭크각으로 실린더별 점화각 배열을 만든다. */
export function anglesFromOrder(order, interval) {
  const angles = new Array(order.length);
  order.forEach((cyl, i) => { angles[cyl - 1] = i * interval; });
  return angles;
}

/** 뱅크별 점화 간격(도) 목록. 단위 테스트와 랩 페이지에서 사용. */
export function bankIntervals(preset, bank) {
  const angles = preset.firingAngles
    .map((a, i) => ({ a, b: preset.bankOf[i] }))
    .filter((x) => x.b === bank)
    .map((x) => x.a)
    .sort((x, y) => x - y);
  return angles.map((a, i) => {
    const next = i + 1 < angles.length ? angles[i + 1] : angles[0] + 720;
    return next - a;
  });
}

// GM 스몰블록 계열 크로스플레인: 1-8-4-3-6-5-7-2, 홀수 실린더 = 좌뱅크, 짝수 = 우뱅크
const V8_CROSS_ORDER = [1, 8, 4, 3, 6, 5, 7, 2];
const V8_CROSSPLANE = {
  layout: 'V8 크로스플레인',
  cylinders: 8,
  firingOrder: V8_CROSS_ORDER,
  firingAngles: anglesFromOrder(V8_CROSS_ORDER, 90),
  bankOf: [0, 1, 0, 1, 0, 1, 0, 1],
  valves: 16,
};

// 수평대향 6: 1-6-2-4-3-5, 1~3 좌뱅크, 4~6 우뱅크 (뱅크당 240° 등간격)
const FLAT6_ORDER = [1, 6, 2, 4, 3, 5];
const FLAT6 = {
  layout: '수평대향 6기통',
  cylinders: 6,
  firingOrder: FLAT6_ORDER,
  firingAngles: anglesFromOrder(FLAT6_ORDER, 120),
  bankOf: [0, 0, 0, 1, 1, 1],
  valves: 24,
};

// 60° V12: 1-7-5-11-3-9-6-12-2-8-4-10, 1~6 좌뱅크, 7~12 우뱅크
const V12_ORDER = [1, 7, 5, 11, 3, 9, 6, 12, 2, 8, 4, 10];
const V12 = {
  layout: 'V12 60°',
  cylinders: 12,
  firingOrder: V12_ORDER,
  firingAngles: anglesFromOrder(V12_ORDER, 60),
  bankOf: [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1],
  valves: 48,
};

// 90° V6 (스플릿핀 등간격): 1-4-2-5-3-6, 1~3 좌뱅크, 4~6 우뱅크
const V6_ORDER = [1, 4, 2, 5, 3, 6];
const V6 = {
  layout: 'V6 90° 터보',
  cylinders: 6,
  firingOrder: V6_ORDER,
  firingAngles: anglesFromOrder(V6_ORDER, 120),
  bankOf: [0, 0, 0, 1, 1, 1],
  valves: 24,
};

// 직렬 4: 1-3-4-2, 180° 등간격, 단일 배기
const I4_ORDER = [1, 3, 4, 2];
const I4 = {
  layout: '직렬 4기통 터보',
  cylinders: 4,
  firingOrder: I4_ORDER,
  firingAngles: anglesFromOrder(I4_ORDER, 180),
  bankOf: [0, 0, 0, 0],
  valves: 16,
};

/** 모든 프리셋이 공유하는 기본값. 각 프리셋은 필요한 부분만 덮어쓴다. */
const BASE = {
  type: 'ice',
  idleRpm: 800,
  redline: 6500,
  limiterRpm: 6600,
  launchRpm: 1800,
  rpmTauUp: 0.1,
  rpmTauDown: 0.14,
  gearRatios: [3.0, 2.0, 1.4, 1.0, 0.8, 0.65],
  finalDrive: 3.5,
  tireDiameter: 0.68,
  shiftTime: 0.15,
  manual: false,
  shiftLowRpm: 2200,
  downshiftRpm: 1200,
  bounceBeforeShift: 0,
  maxAccel: 5,
  exhaust: {
    headerLen: 0.6,
    tailLen: 0.45,
    feedback: -0.65,
    mufflerCutoffMin: 800,
    mufflerCutoffMax: 7000,
    xPipe: 0,
    combMs: [1.37, 2.23, 3.71],
  },
  pulse: { attackMs: 0.3, decayMs: 4, noiseAmt: 0.3 },
  lope: 0.2,
  jitter: 0.5,
  misfireProb: 0.01,
  intake: { centerMin: 300, centerMax: 1400, resHz: 260 },
  mix: { exhaust: 0.6, intake: 0.14, mech: 0.06, forced: 0, trans: 0.02, sub: 0.07 },
  forced: null,
  trans: { teeth: [19, 23, 27, 29, 31, 33, 35, 37, 39, 41] },
  eq: { bodyResHz: 150, presenceDb: 1.5 },
  outGain: 1,
};

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

const make = (...parts) => parts.reduce((acc, p) => merge(acc, p), BASE);

/** @type {Preset[]} */
export const PRESETS = [
  make(V8_CROSSPLANE, {
    id: 'v8-muscle',
    name: 'V8 머슬',
    description: '크로스플레인 V8의 불규칙한 "두둥 두둥" 버블. 큰 캠이 만드는 출렁이는 공회전과 두툼한 저역.',
    image: 'assets/cars/muscle.svg',
    idleRpm: 750, redline: 6500, limiterRpm: 6600, launchRpm: 1600,
    rpmTauUp: 0.12, rpmTauDown: 0.17,
    gearRatios: [2.97, 2.07, 1.43, 1.0, 0.84, 0.56], finalDrive: 3.73, tireDiameter: 0.70,
    shiftTime: 0.16, shiftLowRpm: 2000, downshiftRpm: 1100, maxAccel: 5.5,
    exhaust: { headerLen: 0.82, tailLen: 0.55, feedback: -0.72, mufflerCutoffMin: 650, mufflerCutoffMax: 5200, xPipe: 0, combMs: [1.9, 2.9, 4.3] },
    pulse: { attackMs: 0.42, decayMs: 5.2, noiseAmt: 0.34 },
    lope: 0.95, jitter: 0.85, misfireProb: 0.03,
    intake: { centerMin: 260, centerMax: 1000, resHz: 200 },
    mix: { exhaust: 0.64, intake: 0.1, mech: 0.05, forced: 0, trans: 0.02, sub: 0.11 },
    eq: { bodyResHz: 120, presenceDb: 0.5 },
    outGain: 1.0,
  }),
  make(V8_CROSSPLANE, {
    id: 'sc-v8-manual',
    name: '수퍼차저 V8 수동',
    description: '크로스플레인 버블 위로 rpm을 따라 솟는 수퍼차저 와인. 수동 변속이라 시프트마다 잠깐 끊긴다.',
    image: 'assets/cars/sc-v8.svg',
    idleRpm: 800, redline: 6500, limiterRpm: 6600, launchRpm: 2000,
    rpmTauUp: 0.11, rpmTauDown: 0.15,
    gearRatios: [2.66, 1.78, 1.30, 1.0, 0.74, 0.50], finalDrive: 3.73, tireDiameter: 0.70,
    shiftTime: 0.25, manual: true, shiftLowRpm: 2400, downshiftRpm: 1200, maxAccel: 6,
    exhaust: { headerLen: 0.74, tailLen: 0.5, feedback: -0.7, mufflerCutoffMin: 750, mufflerCutoffMax: 6000, xPipe: 0.15, combMs: [1.7, 2.7, 4.1] },
    pulse: { attackMs: 0.36, decayMs: 4.6, noiseAmt: 0.42 },
    lope: 0.6, jitter: 0.7, misfireProb: 0.018,
    intake: { centerMin: 300, centerMax: 1200, resHz: 230 },
    mix: { exhaust: 0.6, intake: 0.1, mech: 0.05, forced: 0.1, trans: 0.04, sub: 0.1 },
    forced: { type: 'super', ratio: 2.6 * 8 },
    eq: { bodyResHz: 130, presenceDb: 1.5 },
    outGain: 1.0,
  }),
  make(V8_CROSSPLANE, {
    id: 'tt-v8-wagon',
    name: '트윈터보 V8 왜건',
    description: '강한 머플러와 터보가 깎아낸 둥글고 눌린 버블. 가속 1초 뒤 휘슬, 리프트오프 때 "치익".',
    image: 'assets/cars/wagon.svg',
    idleRpm: 650, redline: 6800, limiterRpm: 6900, launchRpm: 1800,
    rpmTauUp: 0.13, rpmTauDown: 0.18,
    gearRatios: [5.0, 3.2, 2.14, 1.72, 1.31, 1.0, 0.82, 0.64], finalDrive: 2.82, tireDiameter: 0.72,
    shiftTime: 0.12, shiftLowRpm: 1800, downshiftRpm: 1000, maxAccel: 6,
    exhaust: { headerLen: 0.9, tailLen: 0.6, feedback: -0.6, mufflerCutoffMin: 450, mufflerCutoffMax: 3000, xPipe: 0.35, combMs: [2.1, 3.3, 5.1] },
    pulse: { attackMs: 0.5, decayMs: 5.8, noiseAmt: 0.22 },
    lope: 0.25, jitter: 0.4, misfireProb: 0.004,
    intake: { centerMin: 240, centerMax: 900, resHz: 190 },
    mix: { exhaust: 0.62, intake: 0.07, mech: 0.04, forced: 0.11, trans: 0.015, sub: 0.12 },
    forced: { type: 'turbo', lag: 0.9, fMin: 2600, fMax: 7400, bov: 'bov' },
    eq: { bodyResHz: 110, presenceDb: -1 },
    outGain: 1.15,
  }),
  make(FLAT6, {
    id: 'flat6-gt',
    name: '플랫6 GT',
    description: '120° 등간격 수평대향 6기통. 짧은 헤더와 큰 흡기음, 6천rpm 이후 금속성 "끼이잉" 비명.',
    image: 'assets/cars/flat6.svg',
    idleRpm: 950, redline: 9000, limiterRpm: 9100, launchRpm: 2600,
    rpmTauUp: 0.07, rpmTauDown: 0.1,
    gearRatios: [3.75, 2.38, 1.72, 1.34, 1.11, 0.96, 0.84], finalDrive: 4.19, tireDiameter: 0.68,
    shiftTime: 0.06, shiftLowRpm: 2800, downshiftRpm: 1500, maxAccel: 7,
    exhaust: { headerLen: 0.44, tailLen: 0.34, feedback: -0.6, mufflerCutoffMin: 1300, mufflerCutoffMax: 8500, xPipe: 0.25, combMs: [0.9, 1.45, 2.3] },
    pulse: { attackMs: 0.24, decayMs: 3.0, noiseAmt: 0.24 },
    lope: 0.1, jitter: 0.3, misfireProb: 0.002,
    intake: { centerMin: 420, centerMax: 2200, resHz: 380 },
    mix: { exhaust: 0.56, intake: 0.22, mech: 0.08, forced: 0, trans: 0.03, sub: 0.05 },
    eq: { bodyResHz: 170, presenceDb: 2.5 },
    outGain: 1.0,
  }),
  make(FLAT6, {
    id: 'shift-maniac',
    name: '시프트 매니악',
    description: '가상의 10단 초단기어 플랫6. 쉴 새 없이 변속하는 재미에 집중했고 최고속은 낮다.',
    image: 'assets/cars/shift-maniac.svg',
    idleRpm: 1000, redline: 9000, limiterRpm: 9100, launchRpm: 3000,
    rpmTauUp: 0.06, rpmTauDown: 0.09,
    gearRatios: [3.2, 2.75, 2.38, 2.07, 1.81, 1.6, 1.42, 1.27, 1.14, 1.03], finalDrive: 7.0, tireDiameter: 0.66,
    shiftTime: 0.05, shiftLowRpm: 4500, downshiftRpm: 3000, maxAccel: 7,
    exhaust: { headerLen: 0.4, tailLen: 0.3, feedback: -0.66, mufflerCutoffMin: 1500, mufflerCutoffMax: 9000, xPipe: 0.2, combMs: [0.85, 1.4, 2.2] },
    pulse: { attackMs: 0.22, decayMs: 2.8, noiseAmt: 0.3 },
    lope: 0.15, jitter: 0.35, misfireProb: 0.003,
    intake: { centerMin: 450, centerMax: 2300, resHz: 400 },
    mix: { exhaust: 0.56, intake: 0.2, mech: 0.08, forced: 0, trans: 0.06, sub: 0.05 },
    trans: { teeth: [23, 25, 27, 29, 31, 33, 35, 37, 39, 41] },
    eq: { bodyResHz: 180, presenceDb: 2.5 },
    outGain: 1.0,
  }),
  make(V12, {
    id: 'v12-super',
    name: 'V12 슈퍼카',
    description: '60° 등간격으로 촘촘히 겹치는 펄스. 고rpm에서 거의 연속음에 가까운 매끈하고 배음 풍부한 하울.',
    image: 'assets/cars/v12.svg',
    idleRpm: 900, redline: 8900, limiterRpm: 9000, launchRpm: 2500,
    rpmTauUp: 0.08, rpmTauDown: 0.11,
    gearRatios: [3.08, 2.19, 1.63, 1.29, 1.03, 0.84, 0.69], finalDrive: 4.44, tireDiameter: 0.70,
    shiftTime: 0.07, shiftLowRpm: 2800, downshiftRpm: 1500, maxAccel: 7.5,
    exhaust: { headerLen: 0.55, tailLen: 0.38, feedback: -0.55, mufflerCutoffMin: 1500, mufflerCutoffMax: 9500, xPipe: 0.3, combMs: [1.1, 1.7, 2.6] },
    pulse: { attackMs: 0.2, decayMs: 2.4, noiseAmt: 0.14 },
    lope: 0.05, jitter: 0.15, misfireProb: 0.0,
    intake: { centerMin: 500, centerMax: 2500, resHz: 420 },
    mix: { exhaust: 0.6, intake: 0.17, mech: 0.06, forced: 0, trans: 0.02, sub: 0.05 },
    eq: { bodyResHz: 190, presenceDb: 3 },
    outGain: 0.95,
  }),
  make(V6, {
    id: 'race-v6',
    name: '터보 V6 레이스카',
    description: '가상의 고회전 레이스 V6. 높은 공회전, 30ms 변속의 "뚝" 끊김, 시프트 직전 리미터 바운스.',
    image: 'assets/cars/race.svg',
    idleRpm: 4000, redline: 12500, limiterRpm: 12600, launchRpm: 6000,
    rpmTauUp: 0.035, rpmTauDown: 0.05,
    gearRatios: [2.9, 2.3, 1.9, 1.62, 1.42, 1.26, 1.13, 1.02], finalDrive: 4.48, tireDiameter: 0.66,
    shiftTime: 0.03, shiftLowRpm: 8000, downshiftRpm: 6500, bounceBeforeShift: 0.12, maxAccel: 9,
    exhaust: { headerLen: 0.36, tailLen: 0.25, feedback: -0.7, mufflerCutoffMin: 2500, mufflerCutoffMax: 11000, xPipe: 0, combMs: [0.6, 0.97, 1.5] },
    pulse: { attackMs: 0.15, decayMs: 1.9, noiseAmt: 0.2 },
    lope: 0.0, jitter: 0.2, misfireProb: 0.0,
    intake: { centerMin: 900, centerMax: 3500, resHz: 600 },
    mix: { exhaust: 0.62, intake: 0.15, mech: 0.05, forced: 0.05, trans: 0.06, sub: 0.02 },
    forced: { type: 'turbo', lag: 0.4, fMin: 4500, fMax: 9500, bov: 'none' },
    trans: { teeth: [27, 29, 31, 33, 35, 37, 39, 41] },
    eq: { bodyResHz: 260, presenceDb: 3 },
    outGain: 0.9,
  }),
  make(I4, {
    id: 'i4-hothatch',
    name: '인라인4 핫해치',
    description: '180° 등간격 직렬 4기통 터보. 가볍고 빠른 "부웅", 리프트오프 때 "트트트" 플러터와 가벼운 팝.',
    image: 'assets/cars/hothatch.svg',
    idleRpm: 850, redline: 7000, limiterRpm: 7100, launchRpm: 2500,
    rpmTauUp: 0.07, rpmTauDown: 0.1,
    gearRatios: [3.31, 2.13, 1.48, 1.14, 0.97, 0.81], finalDrive: 3.65, tireDiameter: 0.64,
    shiftTime: 0.1, shiftLowRpm: 2200, downshiftRpm: 1300, maxAccel: 5,
    exhaust: { headerLen: 0.5, tailLen: 0.4, feedback: -0.62, mufflerCutoffMin: 900, mufflerCutoffMax: 6500, xPipe: 0, combMs: [1.2, 1.9, 3.0] },
    pulse: { attackMs: 0.28, decayMs: 3.4, noiseAmt: 0.3 },
    lope: 0.1, jitter: 0.35, misfireProb: 0.004,
    intake: { centerMin: 350, centerMax: 1700, resHz: 320 },
    mix: { exhaust: 0.58, intake: 0.15, mech: 0.07, forced: 0.1, trans: 0.03, sub: 0.04 },
    forced: { type: 'turbo', lag: 0.7, fMin: 3200, fMax: 8800, bov: 'flutter' },
    eq: { bodyResHz: 160, presenceDb: 2 },
    outGain: 1.1,
  }),
  make({
    id: 'ev-hum',
    name: '일렉트릭',
    description: '엔진 없이 모터 속도에 비례하는 SF 느낌의 윙. 회생 제동 중에는 거의 무음.',
    image: 'assets/cars/ev.svg',
    type: 'ev',
    layout: '전기 모터',
    cylinders: 0,
    firingOrder: [],
    firingAngles: [],
    bankOf: [],
    valves: 0,
    idleRpm: 0, redline: 16000, limiterRpm: 16500, launchRpm: 0,
    rpmTauUp: 0.05, rpmTauDown: 0.05,
    gearRatios: [9.0], finalDrive: 1, tireDiameter: 0.70,
    shiftTime: 0, maxAccel: 6.5,
    polePairs: 4,
    lope: 0, jitter: 0, misfireProb: 0,
    mix: { exhaust: 0, intake: 0, mech: 0, forced: 0, trans: 0, sub: 0.3 },
    eq: { bodyResHz: 200, presenceDb: 0 },
    outGain: 0.4,
  }),
];

export const DEFAULT_PRESET_ID = 'v8-muscle';

export function getPreset(id) {
  return PRESETS.find((p) => p.id === id) || PRESETS[0];
}

/** 배너에 쓰는 사양 요약 */
export function presetSpecs(p) {
  if (p.type === 'ev') return [p.layout, '단일 감속기', `최대 ${(p.redline / 1000).toFixed(0)}k rpm`];
  return [
    p.layout,
    `공회전 ${p.idleRpm.toLocaleString()} / 레드 ${p.redline.toLocaleString()} rpm`,
    `${p.gearRatios.length}단 ${p.manual ? '수동' : (p.shiftTime <= 0.08 ? 'DCT' : '자동')}`,
    p.forced ? (p.forced.type === 'turbo' ? '터보' : '수퍼차저') : '자연흡기',
  ];
}
