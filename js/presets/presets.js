/**
 * 실차 기반 차량 프로파일.
 *
 * 한 프로파일에 엔진 사운드 파라미터 · 변속기 · 사진 · 기본 튜닝값 · 사양 출처를 함께 둔다.
 * 엔진/변속 시뮬(vehicle.js)과 워크렛(engine-worklet.js)은 같은 객체를 그대로 받는다.
 *
 * 점화: 실린더별 점화 크랭크각(firingAngles, 실린더 인덱스 0부터)과 뱅크 매핑(bankOf, 0=L / 1=R).
 * 4행정이므로 한 사이클은 720°.
 *
 * 사양 출처 표기(specs[].src): 'spec' = 제조사/공식 자료로 확인, 'est' = 공개 자료에서 역산·추정,
 * 'tuned' = 소리·주행감을 맞추려고 귀로 정한 튜닝값 (실차 수치가 아님).
 *
 * @typedef {Object} Preset
 * @property {string} id
 * @property {string} name          카드에 쓰는 짧은 이름
 * @property {string} fullName      연식·세부 모델·변속기까지 특정한 이름
 * @property {string} description
 * @property {string} image
 * @property {{author:string, license:string, url:string}|null} credit
 * @property {'ice'|'ev'} type
 * @property {string} layout
 * @property {number} cylinders
 * @property {number[]} firingOrder   1부터 시작하는 실린더 번호 점화 순서 (참고용)
 * @property {number[]} firingAngles  실린더 인덱스별 점화 크랭크각 (0~720)
 * @property {number[]} bankOf        실린더 인덱스별 뱅크
 * @property {Gearbox} gearbox
 * @property {'synth'|'sample'|'hybrid'} soundMethod
 *
 * @typedef {Object} Gearbox
 * @property {'manual'|'dct'|'auto'|'amt'|'mct'} type
 * @property {string} model
 * @property {number} upTime        업시프트 소요 시간 (s)
 * @property {number} downTime      다운시프트 소요 시간 (s)
 * @property {number} cutRetain     변속 중 남는 토크 비율 (0 = 완전 차단, 클러치 분리)
 * @property {boolean} sparkCut     업시프트 때 점화 컷("브랍")이 들리는지
 * @property {boolean} revMatch     다운시프트 자동 블리핑(레브매칭)
 * @property {boolean} kickdown     AUTO에서 다단 킥다운 허용
 * @property {number} lugRpm        이 rpm 아래로 떨어지면 MANUAL에서도 자동 다운시프트
 * @property {{stallRpm:number, lockSpeed:number}|null} converter 토크컨버터 슬립 (자동변속기)
 * @property {{comfort:ShiftMap, sport:ShiftMap}} maps
 *
 * @typedef {Object} ShiftMap  AUTO 변속 맵 (rpm, upFull은 레드라인 대비 비율)
 * @property {number} upLight   부하가 거의 없을 때 업시프트 rpm
 * @property {number} upFull    풀스로틀 업시프트 (× redline)
 * @property {number} downLight 코스팅 다운시프트 rpm
 * @property {number} downFull  풀스로틀 다운시프트 rpm
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

/** 타이어 규격 → 동하중 지름(m). 무부하 지름에 3% 눌림을 반영한다. */
export function tireDiameter(width, aspect, rim) {
  return ((rim * 25.4 + (2 * width * aspect) / 100) / 1000) * 0.97;
}

/**
 * 듀얼 종감속(기어마다 종감속비가 다른 DCT·수동)을 단일 종감속 기준 기어비로 환산한다.
 * 시뮬레이터는 gearRatio × finalDrive만 쓰므로 총감속비가 실제와 같아진다.
 */
const dualFinal = (ratios, finals, main) => ratios.map((r, i) => +((r * finals[i]) / main).toFixed(4));

/** 0→100 km/h 시간으로 테스트 드라이브용 최대 가속도(튜닝값)를 정한다. */
const accelFrom0100 = (s) => +((100 / 3.6 / s) * 1.3).toFixed(1);

// ── 엔진 형식 ────────────────────────────────────────────────

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

// 60° V12: 1-7-5-11-3-9-6-12-2-8-4-10, 1~6 좌뱅크, 7~12 우뱅크 (뱅크당 120° 등간격)
const V12_ORDER = [1, 7, 5, 11, 3, 9, 6, 12, 2, 8, 4, 10];
const V12 = {
  cylinders: 12,
  firingOrder: V12_ORDER,
  firingAngles: anglesFromOrder(V12_ORDER, 60),
  bankOf: [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1],
  valves: 48,
};

// 직렬 5: 1-2-4-5-3, 144° 등간격, 단일 배기 — 2.5차 점화 주파수가 만드는 특유의 워블
const I5_ORDER = [1, 2, 4, 5, 3];
const I5 = {
  layout: '직렬 5기통 터보',
  cylinders: 5,
  firingOrder: I5_ORDER,
  firingAngles: anglesFromOrder(I5_ORDER, 144),
  bankOf: [0, 0, 0, 0, 0],
  valves: 20,
};

// 60° V6 (닛산 VR): 1-2-3-4-5-6, 홀수 실린더 우뱅크·짝수 좌뱅크 → 뱅크당 240° 등간격
const V6_ORDER = [1, 2, 3, 4, 5, 6];
const V6 = {
  layout: 'V6 60° 트윈터보',
  cylinders: 6,
  firingOrder: V6_ORDER,
  firingAngles: anglesFromOrder(V6_ORDER, 120),
  bankOf: [1, 0, 1, 0, 1, 0],
  valves: 24,
};

// GM Gen V 스몰블록(LT4): 1-8-7-2-6-5-4-3, 홀수 = 좌뱅크, 짝수 = 우뱅크
const V8_GM_ORDER = [1, 8, 7, 2, 6, 5, 4, 3];
const V8_GM = {
  cylinders: 8,
  firingOrder: V8_GM_ORDER,
  firingAngles: anglesFromOrder(V8_GM_ORDER, 90),
  bankOf: [0, 1, 0, 1, 0, 1, 0, 1],
  valves: 16,
};

// 포드 Coyote: 1-5-4-8-6-3-7-2, 1~4 우뱅크, 5~8 좌뱅크 (크로스플레인)
const V8_FORD_ORDER = [1, 5, 4, 8, 6, 3, 7, 2];
const V8_FORD = {
  cylinders: 8,
  firingOrder: V8_FORD_ORDER,
  firingAngles: anglesFromOrder(V8_FORD_ORDER, 90),
  bankOf: [1, 1, 1, 1, 0, 0, 0, 0],
  valves: 32,
};

// 메르세데스 V8 관례: 1-5-4-2-6-3-7-8, 1~4 우뱅크, 5~8 좌뱅크 (크로스플레인, M177 개별 자료는 미확인)
const V8_MB_ORDER = [1, 5, 4, 2, 6, 3, 7, 8];
const V8_MB = {
  cylinders: 8,
  firingOrder: V8_MB_ORDER,
  firingAngles: anglesFromOrder(V8_MB_ORDER, 90),
  bankOf: [1, 1, 1, 1, 0, 0, 0, 0],
  valves: 32,
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

// ── 변속기 형식 기본값 ───────────────────────────────────────

const MAPS = {
  comfort: { upLight: 2000, upFull: 0.9, downLight: 1150, downFull: 2300 },
  sport: { upLight: 4200, upFull: 0.98, downLight: 2700, downFull: 4200 },
};

const GEARBOX = {
  dct: { type: 'dct', upTime: 0.09, downTime: 0.16, cutRetain: 0.35, sparkCut: true, revMatch: true, kickdown: true, converter: null },
  amt: { type: 'amt', upTime: 0.13, downTime: 0.22, cutRetain: 0, sparkCut: true, revMatch: true, kickdown: true, converter: null },
  mct: { type: 'mct', upTime: 0.14, downTime: 0.2, cutRetain: 0.45, sparkCut: true, revMatch: true, kickdown: true, converter: null },
  auto: { type: 'auto', upTime: 0.28, downTime: 0.32, cutRetain: 0.55, sparkCut: false, revMatch: true, kickdown: true, converter: { stallRpm: 2300, lockSpeed: 14 } },
  manual: { type: 'manual', upTime: 0.34, downTime: 0.4, cutRetain: 0, sparkCut: false, revMatch: false, kickdown: false, converter: null },
};

export const GEARBOX_LABEL = { dct: 'DCT', amt: '싱글클러치 AMT', mct: '습식클러치 자동(MCT)', auto: '토크컨버터 자동', manual: '수동' };

/** 모든 프로파일이 공유하는 기본값. 각 프로파일은 필요한 부분만 덮어쓴다. */
const BASE = {
  type: 'ice',
  soundMethod: 'synth',
  credit: null,
  idleRpm: 800,
  redline: 6500,
  limiterRpm: 6600,
  launchRpm: 1800,
  rpmTauUp: 0.1,
  rpmTauDown: 0.14,
  gearRatios: [3.0, 2.0, 1.4, 1.0, 0.8, 0.65],
  finalDrive: 3.5,
  tireDiameter: 0.68,
  bounceBeforeShift: 0,
  maxAccel: 5,
  gearbox: { ...GEARBOX.dct, model: '', lugRpm: 1100, maps: MAPS },
  exhaust: {
    headerLen: 0.6,
    tailLen: 0.45,
    feedback: -0.65,
    mufflerCutoffMin: 800,
    mufflerCutoffMax: 7000,
    xPipe: 0,
    combMs: [1.37, 2.23, 3.71],
    valveRange: 0.7, // 배기 밸브 닫힘↔열림 음색 차이 (0 = 밸브 없음)
  },
  pulse: { attackMs: 0.3, decayMs: 4, noiseAmt: 0.3 },
  lope: 0.2,
  jitter: 0.5,
  misfireProb: 0.01,
  intake: { centerMin: 300, centerMax: 1400, resHz: 260 },
  mix: { exhaust: 0.6, intake: 0.14, mech: 0.06, forced: 0, trans: 0.02, sub: 0.07 },
  forced: null,
  // 팝앤뱅 성향: amount = 차량 고유 빈도, big = 큰 백파이어 비율, minRpm = 레드라인 대비 발생 하한
  pops: { amount: 0.6, big: 0.5, minRpm: 0.3 },
  whine: { teeth: [19, 23, 27, 29, 31, 33, 35, 37, 39, 41] },
  eq: { bodyResHz: 150, presenceDb: 1.5 },
  outGain: 1,
  // 차량별 기본 튜닝값 (사용자 설정 초기화 시 이 값으로 복원)
  tuning: { character: 0.5, crackle: 0.4, bass: 0.4, space: 0.35, response: 0.5, shiftStyle: 0.5 },
  specs: [],
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
const gb = (type, over) => ({ ...GEARBOX[type], ...over });

/** @type {Preset[]} */
export const PRESETS = [
  // ── 대표 차종: 사양·변속·사운드를 가장 먼저 맞춘 기준 프로파일 ──
  make(FLAT6, {
    id: 'porsche-911-gt3',
    name: '911 GT3',
    fullName: 'Porsche 911 GT3 (992.1, 2022) · 7단 PDK',
    description: '4.0L 자연흡기 수평대향 6기통, 9,000rpm 레드라인. 짧은 헤더와 큰 흡기음이 6천rpm 이후 금속성 비명으로 바뀌고, PDK가 끊김 없이 꽂아 넣는다.',
    image: 'assets/cars/porsche-911-gt3.jpg',
    credit: { author: 'MrWalkr', license: 'CC BY-SA 4.0', url: 'https://commons.wikimedia.org/wiki/File:2021_Porsche_911_GT3_(992).jpg' },
    idleRpm: 900, redline: 9000, limiterRpm: 9050, launchRpm: 2600,
    rpmTauUp: 0.065, rpmTauDown: 0.095,
    gearRatios: [3.75, 2.38, 1.72, 1.34, 1.11, 0.96, 0.84], finalDrive: 4.19, tireDiameter: tireDiameter(315, 30, 21),
    maxAccel: accelFrom0100(3.4),
    gearbox: gb('dct', {
      model: 'PDK 7단 (듀얼클러치)', upTime: 0.07, downTime: 0.13, cutRetain: 0.4, lugRpm: 1300,
      maps: {
        comfort: { upLight: 2300, upFull: 0.92, downLight: 1300, downFull: 2800 },
        sport: { upLight: 5000, upFull: 0.985, downLight: 3600, downFull: 5200 },
      },
    }),
    exhaust: { headerLen: 0.44, tailLen: 0.34, feedback: -0.6, mufflerCutoffMin: 1300, mufflerCutoffMax: 8500, xPipe: 0.25, combMs: [0.9, 1.45, 2.3], valveRange: 0.8 },
    pulse: { attackMs: 0.24, decayMs: 3.0, noiseAmt: 0.24 },
    lope: 0.1, jitter: 0.3, misfireProb: 0.002,
    intake: { centerMin: 420, centerMax: 2200, resHz: 380 },
    mix: { exhaust: 0.56, intake: 0.24, mech: 0.09, forced: 0, trans: 0.025, sub: 0.05 },
    pops: { amount: 0.35, big: 0.25, minRpm: 0.35 },
    eq: { bodyResHz: 170, presenceDb: 2.5 },
    tuning: { character: 0.55, crackle: 0.3, bass: 0.35, space: 0.35, response: 0.55, shiftStyle: 0.6 },
    outGain: 1.0,
    specs: [
      ['엔진', '4.0L 수평대향 6, 자연흡기', 'spec'],
      ['최고출력', '510 PS @ 8,400 rpm', 'spec'],
      ['최대토크', '470 Nm @ 6,100 rpm', 'spec'],
      ['레드라인(회전 한계)', '9,000 rpm', 'spec'],
      ['공회전', '900 rpm', 'tuned'],
      ['변속기', 'PDK 7단 · 3.75 / 2.38 / 1.72 / 1.34 / 1.11 / 0.96 / 0.84', 'spec'],
      ['종감속비', '4.19', 'spec'],
      ['0→100 km/h', '3.4초', 'spec'],
      ['구동 타이어', '315/30 ZR21', 'spec'],
    ],
  }),
  make(V12, {
    id: 'lamborghini-aventador',
    name: 'Aventador',
    fullName: 'Lamborghini Aventador LP 780-4 Ultimae (2022) · 7단 ISR',
    description: '6.5L 자연흡기 60° V12. 촘촘한 펄스가 고rpm에서 찢어지는 하울이 되고, 싱글클러치 ISR은 변속마다 몸이 앞으로 쏠리는 "쾅" 하는 컷과 백파이어를 남긴다.',
    image: 'assets/cars/lamborghini-aventador.jpg',
    credit: { author: 'MrWalkr', license: 'CC BY-SA 4.0', url: 'https://commons.wikimedia.org/wiki/File:Lamborghini_Aventador_LP780_Ultimae.jpg' },
    layout: 'V12 60° 자연흡기',
    idleRpm: 1000, redline: 8500, limiterRpm: 8700, launchRpm: 3000,
    rpmTauUp: 0.075, rpmTauDown: 0.1,
    gearRatios: [3.909, 2.438, 1.81, 1.458, 1.185, 0.967, 0.844], finalDrive: 3.27, tireDiameter: tireDiameter(355, 25, 21),
    maxAccel: accelFrom0100(2.8),
    gearbox: gb('amt', {
      model: 'ISR 7단 (싱글클러치 자동화 수동)', upTime: 0.12, downTime: 0.2, lugRpm: 1500,
      maps: {
        comfort: { upLight: 2600, upFull: 0.9, downLight: 1500, downFull: 3000 },
        sport: { upLight: 4800, upFull: 0.98, downLight: 3400, downFull: 5000 },
      },
    }),
    exhaust: { headerLen: 0.5, tailLen: 0.36, feedback: -0.6, mufflerCutoffMin: 1400, mufflerCutoffMax: 9500, xPipe: 0.2, combMs: [1.0, 1.6, 2.5], valveRange: 0.75 },
    pulse: { attackMs: 0.22, decayMs: 2.6, noiseAmt: 0.24 },
    lope: 0.08, jitter: 0.25, misfireProb: 0.001,
    intake: { centerMin: 480, centerMax: 2600, resHz: 400 },
    mix: { exhaust: 0.62, intake: 0.18, mech: 0.06, forced: 0, trans: 0.02, sub: 0.06 },
    pops: { amount: 0.9, big: 0.8, minRpm: 0.28 },
    eq: { bodyResHz: 180, presenceDb: 2.5 },
    tuning: { character: 0.65, crackle: 0.6, bass: 0.4, space: 0.4, response: 0.55, shiftStyle: 0.6 },
    outGain: 0.9,
    specs: [
      ['엔진', '6.5L V12 60° (L539), 자연흡기', 'spec'],
      ['최고출력', '780 CV @ 8,500 rpm', 'spec'],
      ['최대토크', '720 Nm @ 6,750 rpm', 'spec'],
      ['레드라인 / 리미터', '8,500 / 8,700 rpm', 'est'],
      ['변속기', 'ISR 7단 싱글클러치 · 3.909–0.844 (애호가 자료)', 'est'],
      ['종감속비', '3.27 (공개값 2.867은 최고속에서 6,500rpm이 되어 부적합 → 역산)', 'est'],
      ['구동 타이어', '355/25 ZR21', 'spec'],
    ],
  }),
  make(V12, {
    id: 'ferrari-812',
    name: '812 Superfast',
    fullName: 'Ferrari 812 Superfast (2018) · 7단 F1 DCT',
    description: '6.5L 자연흡기 65° V12, 8,900rpm까지 도는 F140GA. 거칠지 않고 매끈하게 겹치는 펄스가 고음역 비명으로 올라가며 듀얼클러치가 쉼 없이 이어 붙인다.',
    image: 'assets/cars/ferrari-812.jpg',
    credit: { author: 'Harvey Bold', license: 'CC0', url: 'https://commons.wikimedia.org/wiki/File:2019_Ferrari_812_Superfast_-_6496cc_6.5_(800PS)_Petrol_-_Giallo_Modena_-_01-2025,_Front.jpg' },
    layout: 'V12 65° 자연흡기',
    idleRpm: 950, redline: 8900, limiterRpm: 8950, launchRpm: 2800,
    rpmTauUp: 0.07, rpmTauDown: 0.1,
    gearRatios: [3.27, 2.33, 1.73, 1.37, 1.09, 0.89, 0.70], finalDrive: 4.375, tireDiameter: tireDiameter(315, 35, 20),
    maxAccel: accelFrom0100(2.9),
    gearbox: gb('dct', {
      model: 'Getrag 7DCL750 F1 7단 DCT', upTime: 0.07, downTime: 0.12, cutRetain: 0.45, lugRpm: 1400,
      maps: {
        comfort: { upLight: 2400, upFull: 0.92, downLight: 1400, downFull: 2900 },
        sport: { upLight: 5000, upFull: 0.985, downLight: 3600, downFull: 5300 },
      },
    }),
    exhaust: { headerLen: 0.55, tailLen: 0.38, feedback: -0.55, mufflerCutoffMin: 1500, mufflerCutoffMax: 9500, xPipe: 0.3, combMs: [1.1, 1.7, 2.6], valveRange: 0.65 },
    pulse: { attackMs: 0.2, decayMs: 2.4, noiseAmt: 0.14 },
    lope: 0.05, jitter: 0.15, misfireProb: 0.0,
    intake: { centerMin: 500, centerMax: 2500, resHz: 420 },
    mix: { exhaust: 0.6, intake: 0.17, mech: 0.06, forced: 0, trans: 0.02, sub: 0.05 },
    pops: { amount: 0.3, big: 0.2, minRpm: 0.35 },
    eq: { bodyResHz: 190, presenceDb: 3 },
    tuning: { character: 0.55, crackle: 0.25, bass: 0.35, space: 0.4, response: 0.55, shiftStyle: 0.55 },
    outGain: 0.95,
    specs: [
      ['엔진', '6.5L V12 65° (F140GA), 자연흡기', 'spec'],
      ['최고출력', '800 cv @ 8,500 rpm', 'spec'],
      ['최대토크', '718 Nm @ 7,000 rpm', 'spec'],
      ['최고 회전수', '8,900 rpm', 'spec'],
      ['변속기', 'F1 7단 DCT · 3.27–0.70 (F12 기어비를 약 6% 단축)', 'est'],
      ['종감속비', '4.375 (F12 값)', 'est'],
      ['구동 타이어', '315/35 ZR20', 'spec'],
    ],
  }),
  make(I5, {
    id: 'audi-rs3',
    name: 'RS 3',
    fullName: 'Audi RS 3 Sportback (8Y, 2022) · 7단 S tronic',
    description: '2.5 TFSI 직렬 5기통 터보. 1-2-4-5-3 점화가 만드는 2.5차 "워블"이 V10을 반쯤 닮은 소리를 내고, 다이내믹 모드에선 변속·리프트오프마다 크래클이 터진다.',
    image: 'assets/cars/audi-rs3.jpg',
    credit: { author: 'Alexander Migl', license: 'CC BY-SA 4.0', url: 'https://commons.wikimedia.org/wiki/File:Audi_RS3_8Y_IMG_3244.jpg' },
    idleRpm: 800, redline: 7000, limiterRpm: 7200, launchRpm: 3000,
    rpmTauUp: 0.08, rpmTauDown: 0.11,
    // 듀얼 종감속: 1·4·5단 4.059 / 2·3·6·7단 3.450
    gearRatios: dualFinal([3.56, 2.53, 1.68, 1.02, 0.79, 0.76, 0.63], [4.059, 3.45, 3.45, 4.059, 4.059, 3.45, 3.45], 4.059),
    finalDrive: 4.059, tireDiameter: tireDiameter(245, 35, 19),
    maxAccel: accelFrom0100(3.8),
    gearbox: gb('dct', {
      model: 'S tronic 7단 (DQ500 듀얼클러치)', upTime: 0.09, downTime: 0.15, cutRetain: 0.3, lugRpm: 1150,
      maps: {
        comfort: { upLight: 1900, upFull: 0.9, downLight: 1100, downFull: 2200 },
        sport: { upLight: 3900, upFull: 0.98, downLight: 2600, downFull: 4000 },
      },
    }),
    exhaust: { headerLen: 0.55, tailLen: 0.42, feedback: -0.66, mufflerCutoffMin: 900, mufflerCutoffMax: 7000, xPipe: 0, combMs: [1.25, 2.0, 3.2], valveRange: 0.75 },
    pulse: { attackMs: 0.3, decayMs: 3.6, noiseAmt: 0.3 },
    lope: 0.12, jitter: 0.45, misfireProb: 0.004,
    intake: { centerMin: 340, centerMax: 1700, resHz: 300 },
    mix: { exhaust: 0.6, intake: 0.13, mech: 0.07, forced: 0.09, trans: 0.03, sub: 0.06 },
    forced: { type: 'turbo', lag: 0.75, fMin: 3000, fMax: 8200, bov: 'bov' },
    pops: { amount: 0.85, big: 0.55, minRpm: 0.28 },
    eq: { bodyResHz: 150, presenceDb: 2 },
    tuning: { character: 0.6, crackle: 0.55, bass: 0.45, space: 0.35, response: 0.55, shiftStyle: 0.5 },
    outGain: 1.05,
    specs: [
      ['엔진', '2.5L 직렬 5 TFSI, 싱글 터보', 'spec'],
      ['점화 순서', '1-2-4-5-3 (144° 등간격)', 'spec'],
      ['최고출력', '400 PS @ 5,600–7,000 rpm', 'spec'],
      ['최대토크', '500 Nm @ 2,250–5,600 rpm', 'spec'],
      ['레드라인 / 리미터', '7,000 / 7,200 rpm', 'est'],
      ['변속기', 'S tronic 7단 · 3.56 / 2.53 / 1.68 / 1.02 / 0.79 / 0.76 / 0.63', 'spec'],
      ['종감속비', '듀얼 4.059 (1·4·5단) / 3.450 (2·3·6·7단)', 'spec'],
    ],
  }),
  make(V6, {
    id: 'nissan-gtr',
    name: 'GT-R',
    fullName: 'Nissan GT-R (R35, 2017) · 6단 GR6 DCT',
    description: '3.8L VR38DETT 트윈터보 V6. 두툼하게 눌린 배기 위로 터보 흡기음과 휘슬이 올라오고, GR6 트랜스액슬 특유의 기어 소음과 "철컥" 하는 변속감이 섞인다.',
    image: 'assets/cars/nissan-gtr.jpg',
    credit: { author: 'Calreyn88', license: 'CC BY-SA 4.0', url: 'https://commons.wikimedia.org/wiki/File:2016_Nissan_GT-R_Recaro.jpg' },
    idleRpm: 750, redline: 7000, limiterRpm: 7100, launchRpm: 3200,
    rpmTauUp: 0.085, rpmTauDown: 0.12,
    gearRatios: [4.056, 2.301, 1.595, 1.248, 1.001, 0.796], finalDrive: 3.70, tireDiameter: tireDiameter(285, 35, 20),
    maxAccel: accelFrom0100(2.8),
    gearbox: gb('dct', {
      model: 'GR6 6단 듀얼클러치 트랜스액슬', upTime: 0.11, downTime: 0.17, cutRetain: 0.3, lugRpm: 1200,
      maps: {
        comfort: { upLight: 2000, upFull: 0.9, downLight: 1150, downFull: 2400 },
        sport: { upLight: 4000, upFull: 0.98, downLight: 2800, downFull: 4200 },
      },
    }),
    exhaust: { headerLen: 0.62, tailLen: 0.5, feedback: -0.62, mufflerCutoffMin: 650, mufflerCutoffMax: 5200, xPipe: 0.3, combMs: [1.6, 2.5, 3.9], valveRange: 0.5 },
    pulse: { attackMs: 0.34, decayMs: 4.2, noiseAmt: 0.26 },
    lope: 0.08, jitter: 0.3, misfireProb: 0.002,
    intake: { centerMin: 320, centerMax: 1500, resHz: 260 },
    mix: { exhaust: 0.58, intake: 0.12, mech: 0.07, forced: 0.13, trans: 0.06, sub: 0.07 },
    forced: { type: 'turbo', lag: 0.65, fMin: 3400, fMax: 9000, bov: 'bov' },
    pops: { amount: 0.3, big: 0.2, minRpm: 0.35 },
    whine: { teeth: [23, 27, 29, 31, 33, 37] },
    eq: { bodyResHz: 140, presenceDb: 1 },
    tuning: { character: 0.45, crackle: 0.25, bass: 0.45, space: 0.35, response: 0.55, shiftStyle: 0.5 },
    outGain: 1.1,
    specs: [
      ['엔진', '3.8L V6 60° (VR38DETT), 트윈터보', 'spec'],
      ['최고출력', '570 PS @ 6,800 rpm', 'spec'],
      ['최대토크', '637 Nm @ 3,300–5,800 rpm', 'spec'],
      ['레드라인 / 리미터', '7,000 / 7,100 rpm', 'est'],
      ['변속기', 'GR6 6단 DCT · 4.056 / 2.301 / 1.595 / 1.248 / 1.001 / 0.796', 'spec'],
      ['종감속비', '3.70', 'spec'],
      ['구동 타이어', '285/35 ZRF20', 'spec'],
    ],
  }),
  make(V8_GM, {
    id: 'camaro-zl1',
    name: 'Camaro ZL1',
    fullName: 'Chevrolet Camaro ZL1 (6세대, 2017) · 6단 수동 TR6060',
    description: '6.2L LT4 수퍼차저 크로스플레인 V8. "두둥" 거리는 버블 위로 rpm을 따라 솟는 수퍼차저 와인. 수동이라 클러치를 밟을 때마다 회전이 떨어졌다 다시 붙는다(액티브 레브매칭).',
    image: 'assets/cars/camaro-zl1.jpg',
    credit: { author: 'Matthew Lamb', license: 'CC BY-SA 2.0', url: 'https://commons.wikimedia.org/wiki/File:FoS20162016_0623_092213AA_(27761433212).jpg' },
    layout: 'V8 크로스플레인 수퍼차저',
    idleRpm: 800, redline: 6500, limiterRpm: 6600, launchRpm: 2000,
    rpmTauUp: 0.11, rpmTauDown: 0.15,
    gearRatios: [2.66, 1.78, 1.30, 1.00, 0.74, 0.50], finalDrive: 3.73, tireDiameter: tireDiameter(305, 30, 20),
    maxAccel: accelFrom0100(3.9),
    gearbox: gb('manual', {
      model: 'Tremec TR6060 6단 수동 (액티브 레브매칭)', upTime: 0.32, downTime: 0.36, revMatch: true, lugRpm: 1050,
      maps: {
        comfort: { upLight: 2000, upFull: 0.9, downLight: 1100, downFull: 2200 },
        sport: { upLight: 3600, upFull: 0.97, downLight: 2400, downFull: 3600 },
      },
    }),
    exhaust: { headerLen: 0.74, tailLen: 0.5, feedback: -0.7, mufflerCutoffMin: 750, mufflerCutoffMax: 6000, xPipe: 0.15, combMs: [1.7, 2.7, 4.1], valveRange: 0.8 },
    pulse: { attackMs: 0.36, decayMs: 4.6, noiseAmt: 0.42 },
    lope: 0.45, jitter: 0.7, misfireProb: 0.015,
    intake: { centerMin: 300, centerMax: 1200, resHz: 230 },
    mix: { exhaust: 0.6, intake: 0.1, mech: 0.05, forced: 0.1, trans: 0.04, sub: 0.1 },
    forced: { type: 'super', ratio: 2.4 * 8 },
    pops: { amount: 0.5, big: 0.6, minRpm: 0.3 },
    eq: { bodyResHz: 130, presenceDb: 1.5 },
    tuning: { character: 0.6, crackle: 0.35, bass: 0.5, space: 0.4, response: 0.5, shiftStyle: 0.45 },
    outGain: 1.0,
    specs: [
      ['엔진', '6.2L V8 (LT4), 이튼 TVS 수퍼차저', 'spec'],
      ['점화 순서', '1-8-7-2-6-5-4-3', 'spec'],
      ['최고출력', '650 hp @ 6,400 rpm', 'spec'],
      ['수퍼차저 구동비', '미확인 (와인 음정은 튜닝값)', 'tuned'],
      ['레드라인 / 리미터', '6,500 / 6,600 rpm', 'est'],
      ['변속기', 'TR6060 6단 수동 · 2.66 / 1.78 / 1.30 / 1.00', 'spec'],
      ['5·6단', '0.74 / 0.50 (자료 상충: 0.80 / 0.63)', 'est'],
      ['종감속비', '3.73', 'spec'],
    ],
  }),
  make(V8_MB, {
    id: 'amg-e63-wagon',
    name: 'E63 S 왜건',
    fullName: 'Mercedes-AMG E63 S 4MATIC+ Estate (S213, 2018) · 9단 MCT',
    description: '4.0L M177 핫-V 트윈터보 V8. 터보가 깎아낸 둥글고 묵직한 버블, 가속 1초 뒤 올라오는 휘슬, 스포츠+에서 변속·리프트오프마다 터지는 굵은 팝.',
    image: 'assets/cars/amg-e63-wagon.jpg',
    credit: { author: 'Mr.choppers', license: 'CC BY-SA 3.0', url: 'https://commons.wikimedia.org/wiki/File:2019_Mercedes-Benz_E-Class_E_63_AMG_S_4MATIC_Wagon,_front_left.jpg' },
    layout: 'V8 크로스플레인 트윈터보',
    idleRpm: 650, redline: 7000, limiterRpm: 7100, launchRpm: 2200,
    rpmTauUp: 0.12, rpmTauDown: 0.17,
    gearRatios: [5.35, 3.24, 2.25, 1.64, 1.21, 1.00, 0.86, 0.72, 0.60], finalDrive: 3.06, tireDiameter: tireDiameter(295, 30, 20),
    maxAccel: accelFrom0100(3.5),
    gearbox: gb('mct', {
      model: 'AMG Speedshift MCT 9G (습식 발진클러치)', upTime: 0.14, downTime: 0.2, lugRpm: 1000,
      maps: {
        comfort: { upLight: 1700, upFull: 0.88, downLight: 1000, downFull: 2000 },
        sport: { upLight: 3600, upFull: 0.97, downLight: 2500, downFull: 3800 },
      },
    }),
    exhaust: { headerLen: 0.9, tailLen: 0.6, feedback: -0.6, mufflerCutoffMin: 450, mufflerCutoffMax: 3400, xPipe: 0.35, combMs: [2.1, 3.3, 5.1], valveRange: 0.85 },
    pulse: { attackMs: 0.5, decayMs: 5.8, noiseAmt: 0.22 },
    lope: 0.25, jitter: 0.4, misfireProb: 0.004,
    intake: { centerMin: 240, centerMax: 900, resHz: 190 },
    mix: { exhaust: 0.62, intake: 0.07, mech: 0.04, forced: 0.11, trans: 0.015, sub: 0.12 },
    forced: { type: 'turbo', lag: 0.9, fMin: 2600, fMax: 7400, bov: 'bov' },
    pops: { amount: 0.8, big: 0.8, minRpm: 0.28 },
    eq: { bodyResHz: 110, presenceDb: -1 },
    tuning: { character: 0.55, crackle: 0.5, bass: 0.55, space: 0.35, response: 0.5, shiftStyle: 0.45 },
    outGain: 1.15,
    specs: [
      ['엔진', '4.0L V8 (M177), 트윈터보 핫-V', 'spec'],
      ['최고출력', '612 PS @ 5,750–6,500 rpm', 'spec'],
      ['최대토크', '850 Nm @ 2,500–4,500 rpm', 'spec'],
      ['점화 순서', '1-5-4-2-6-3-7-8 (메르세데스 관례)', 'est'],
      ['레드라인 / 리미터', '7,000 / 7,100 rpm', 'est'],
      ['변속기', 'Speedshift MCT 9단 · 5.35 / 3.24 / 2.25 / 1.64 / 1.21 / 1.00 / 0.86 / 0.72 / 0.60', 'spec'],
      ['종감속비', '3.06', 'spec'],
      ['구동 타이어', '295/30 R20', 'spec'],
    ],
  }),
  make(V8_FORD, {
    id: 'mustang-gt',
    name: 'Mustang GT',
    fullName: 'Ford Mustang GT (S550, 2018) · 10단 자동 10R80',
    description: '5.0L Coyote 자연흡기 크로스플레인 V8. 불규칙한 "두둥 두둥" 버블과 두툼한 저역. 10단 토크컨버터 자동이 촘촘히 올려 붙이고 킥다운엔 여러 단을 한 번에 내린다.',
    image: 'assets/cars/mustang-gt.jpg',
    credit: { author: 'Vauxford', license: 'CC BY-SA 4.0', url: 'https://commons.wikimedia.org/wiki/File:2018_Ford_Mustang_GT_V8_5.0_facelift.jpg' },
    layout: 'V8 크로스플레인 자연흡기',
    idleRpm: 700, redline: 7500, limiterRpm: 7600, launchRpm: 1800,
    rpmTauUp: 0.11, rpmTauDown: 0.16,
    gearRatios: [4.696, 2.985, 2.146, 1.769, 1.52, 1.275, 1.0, 0.854, 0.689, 0.636], finalDrive: 3.15, tireDiameter: tireDiameter(275, 40, 19),
    maxAccel: accelFrom0100(4.3),
    gearbox: gb('auto', {
      model: '10R80 10단 토크컨버터 자동', upTime: 0.26, downTime: 0.3, lugRpm: 950,
      converter: { stallRpm: 2400, lockSpeed: 12 },
      maps: {
        comfort: { upLight: 1600, upFull: 0.88, downLight: 950, downFull: 2000 },
        sport: { upLight: 3400, upFull: 0.97, downLight: 2300, downFull: 3600 },
      },
    }),
    exhaust: { headerLen: 0.82, tailLen: 0.55, feedback: -0.72, mufflerCutoffMin: 650, mufflerCutoffMax: 5200, xPipe: 0.1, combMs: [1.9, 2.9, 4.3], valveRange: 0.85 },
    pulse: { attackMs: 0.42, decayMs: 5.2, noiseAmt: 0.34 },
    lope: 0.4, jitter: 0.7, misfireProb: 0.012,
    intake: { centerMin: 260, centerMax: 1100, resHz: 210 },
    mix: { exhaust: 0.64, intake: 0.11, mech: 0.05, forced: 0, trans: 0.02, sub: 0.11 },
    pops: { amount: 0.4, big: 0.5, minRpm: 0.3 },
    eq: { bodyResHz: 120, presenceDb: 0.5 },
    tuning: { character: 0.55, crackle: 0.3, bass: 0.55, space: 0.4, response: 0.5, shiftStyle: 0.45 },
    outGain: 1.0,
    specs: [
      ['엔진', '5.0L V8 (Coyote Gen 3), 자연흡기', 'spec'],
      ['점화 순서', '1-5-4-8-6-3-7-2', 'spec'],
      ['최고출력', '460 hp @ 7,000 rpm', 'spec'],
      ['레드라인 / 리미터', '7,500 / 7,600 rpm', 'est'],
      ['변속기', '10R80 10단 자동 · 4.696–0.636', 'spec'],
      ['종감속비', '3.15 (미국 기본 자동, PP·유럽 3.55)', 'spec'],
      ['구동 타이어', '275/40 R19 (퍼포먼스 팩 기준)', 'est'],
    ],
  }),
  make(I4, {
    id: 'elantra-n',
    name: 'Elantra N',
    fullName: 'Hyundai Elantra N (CN7, 2022) · 6단 수동',
    description: '2.0 T-GDi 직렬 4기통 터보. 가볍고 빠른 "부웅" 위에 터보 흡기음, N 모드 가변 배기가 열리면 리프트오프·변속마다 "타다닥" 팝이 이어진다. 수동이지만 레브매칭을 지원한다.',
    image: 'assets/cars/elantra-n.jpg',
    credit: { author: 'Elise240SX', license: 'CC BY-SA 4.0', url: 'https://commons.wikimedia.org/wiki/File:2022_Hyundai_Elantra_N_in_Fiery_Red,_Front_Left,_04-01-2022.jpg' },
    idleRpm: 800, redline: 6750, limiterRpm: 6850, launchRpm: 2500,
    rpmTauUp: 0.075, rpmTauDown: 0.1,
    // 듀얼 종감속: 1·2단 4.154 / 3~6단 3.176
    gearRatios: dualFinal([3.083, 1.931, 1.696, 1.276, 1.027, 0.854], [4.154, 4.154, 3.176, 3.176, 3.176, 3.176], 4.154),
    finalDrive: 4.154, tireDiameter: tireDiameter(245, 35, 19),
    maxAccel: accelFrom0100(5.6),
    gearbox: gb('manual', {
      model: '6단 수동 (레브매칭)', upTime: 0.3, downTime: 0.34, revMatch: true, lugRpm: 1100,
      maps: {
        comfort: { upLight: 2000, upFull: 0.9, downLight: 1150, downFull: 2300 },
        sport: { upLight: 3800, upFull: 0.98, downLight: 2600, downFull: 4000 },
      },
    }),
    exhaust: { headerLen: 0.5, tailLen: 0.4, feedback: -0.62, mufflerCutoffMin: 900, mufflerCutoffMax: 6500, xPipe: 0, combMs: [1.2, 1.9, 3.0], valveRange: 0.85 },
    pulse: { attackMs: 0.28, decayMs: 3.4, noiseAmt: 0.3 },
    lope: 0.1, jitter: 0.35, misfireProb: 0.004,
    intake: { centerMin: 350, centerMax: 1700, resHz: 320 },
    mix: { exhaust: 0.58, intake: 0.15, mech: 0.07, forced: 0.1, trans: 0.03, sub: 0.04 },
    forced: { type: 'turbo', lag: 0.7, fMin: 3200, fMax: 8800, bov: 'flutter' },
    pops: { amount: 1.0, big: 0.45, minRpm: 0.25 },
    eq: { bodyResHz: 160, presenceDb: 2 },
    tuning: { character: 0.6, crackle: 0.6, bass: 0.4, space: 0.35, response: 0.55, shiftStyle: 0.5 },
    outGain: 1.1,
    specs: [
      ['엔진', '2.0L 직렬 4 T-GDi, 싱글 터보', 'spec'],
      ['최고출력', '280 PS @ 5,500–6,000 rpm', 'spec'],
      ['레드라인 / 리미터', '6,750 / 6,850 rpm', 'est'],
      ['최대토크', '392 Nm @ 2,100–4,700 rpm', 'spec'],
      ['변속기', 'M6GF2 6단 수동 (레브매칭) · 3.083 / 1.931 / 1.696 / 1.276 / 1.027 / 0.854', 'spec'],
      ['종감속비', '듀얼 4.154 (1·2단) / 3.176 (3~6단)', 'spec'],
      ['구동 타이어', '245/35 ZR19', 'spec'],
    ],
  }),
  make({
    id: 'ev-hum',
    name: '전기 모터',
    fullName: '전기 모터 (가상 사운드) · 단일 감속기',
    description: '엔진 없이 모터 속도에 비례하는 SF 느낌의 윙. 실차 모델이 아닌 가상 사운드이며 회생 제동 중에는 거의 무음.',
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
    maxAccel: 6.5,
    gearbox: gb('dct', { model: '단일 감속기', upTime: 0, downTime: 0, kickdown: false }),
    polePairs: 4,
    lope: 0, jitter: 0, misfireProb: 0,
    exhaust: { valveRange: 0 },
    mix: { exhaust: 0, intake: 0, mech: 0, forced: 0, trans: 0, sub: 0.3 },
    pops: { amount: 0, big: 0, minRpm: 1 },
    eq: { bodyResHz: 200, presenceDb: 0 },
    outGain: 0.4,
    specs: [['구동', '전기 모터 · 단일 감속기', 'tuned']],
  }),
];

export const DEFAULT_PRESET_ID = 'porsche-911-gt3';

/** 이전 버전(일반 명칭 프리셋) id → 새 실차 프로파일 id */
export const LEGACY_IDS = {
  'v8-muscle': 'mustang-gt',
  'sc-v8-manual': 'camaro-zl1',
  'tt-v8-wagon': 'amg-e63-wagon',
  'flat6-gt': 'porsche-911-gt3',
  'shift-maniac': 'porsche-911-gt3',
  'v12-super': 'ferrari-812',
  'race-v6': 'nissan-gtr',
  'i4-hothatch': 'elantra-n',
};

export function getPreset(id) {
  return PRESETS.find((p) => p.id === (LEGACY_IDS[id] || id)) || PRESETS[0];
}

/** 배너에 쓰는 사양 요약 */
export function presetSpecs(p) {
  if (p.type === 'ev') return [p.layout, '단일 감속기', `최대 ${(p.redline / 1000).toFixed(0)}k rpm`];
  return [
    p.layout,
    `공회전 ${p.idleRpm.toLocaleString()} / 레드 ${p.redline.toLocaleString()} rpm`,
    `${p.gearRatios.length}단 ${GEARBOX_LABEL[p.gearbox.type]}`,
    p.forced ? (p.forced.type === 'turbo' ? '터보' : '수퍼차저') : '자연흡기',
  ];
}
