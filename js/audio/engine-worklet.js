/**
 * EV Roar — 엔진 합성 AudioWorkletProcessor ('engine-processor')
 *
 * 구조 (스테레오 출력, 채널 0 = 좌뱅크 배기, 채널 1 = 우뱅크 배기, 나머지 레이어는 가운데):
 *   크랭크 위상 누적 → 점화각 통과 시 실린더별 펄스 보이스 생성 (실린더별 고정 편차 + 매 점화 지터 + 로프/미스파이어)
 *   → 뱅크별 배기 웨이브가이드: 헤더 공명(분수 지연 + 반전 피드백 + 루프 LPF) → 머플러(콤 3개 + 2단 LPF) → 테일파이프 공명
 *   + 흡기(대역 노이즈 × 점화 AM + 헬름홀츠 공명) + 기계음(밸브 틱 + 고차 협대역) + 과급(터보 휘슬/블로우오프, 수퍼차저 와인)
 *   + 변속기 와인 + 팝/크래클/백파이어(점화 사이클 동기, 배기관 주입) + 서브베이스 + 스타터 모터
 *
 * 같은 rpm이라도 부하(load)와 오버런(overrun, 감속 연료 차단)에 따라 펄스 세기·길이·머플러 밝기·흡기량이 달라져
 * 가속 / 정속 / 감속 음색이 구분된다. 흡기(순정/스포츠)·배기 밸브(닫힘/열림)는 음색만 바꾸며 0.35초에 걸쳐 부드럽게 전환한다.
 *
 * 외부 import 없음 (모든 브라우저의 워크렛 스코프에서 동작하도록). process() 안에서는 메모리를 할당하지 않는다.
 */

const TWO_PI = Math.PI * 2;
const MAX_VOICES = 32;
const MAX_POPS = 12;
const DL_SIZE = 4096;
const DL_MASK = DL_SIZE - 1;
const SOUND_SPEED = 343;
const FRAME_STRIDE = 6; // [t, rpm, throttle, load, fuelCut, overrun]

const nowMs = typeof globalThis.performance !== 'undefined' && typeof globalThis.performance.now === 'function'
  ? () => globalThis.performance.now()
  : () => Date.now();

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const lerp = (a, b, t) => a + (b - a) * t;

/** 분수 지연(선형 보간) 링버퍼 딜레이 */
class DelayLine {
  constructor() {
    this.buf = new Float32Array(DL_SIZE);
    this.w = 0;
  }

  clear() {
    this.buf.fill(0);
  }

  /** d 샘플 전에 쓴 값 (d >= 1) */
  read(d) {
    let r = this.w - d;
    if (r < 0) r += DL_SIZE;
    const i = r | 0;
    const f = r - i;
    const a = this.buf[i & DL_MASK];
    const b = this.buf[(i + 1) & DL_MASK];
    return a + (b - a) * f;
  }

  write(x) {
    this.buf[this.w] = x;
    this.w = (this.w + 1) & DL_MASK;
  }
}

/** RBJ 바이쿼드 (Transposed Direct Form II) */
class Biquad {
  constructor() {
    this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0;
    this.z1 = 0; this.z2 = 0;
  }

  reset() { this.z1 = 0; this.z2 = 0; }

  copyFrom(o) {
    this.b0 = o.b0; this.b1 = o.b1; this.b2 = o.b2; this.a1 = o.a1; this.a2 = o.a2;
  }

  set(type, f, q, sr, gainDb = 0) {
    const w0 = TWO_PI * clamp(f, 10, sr * 0.48) / sr;
    const cw = Math.cos(w0);
    const sw = Math.sin(w0);
    const alpha = sw / (2 * q);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'lp') {
      b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
    } else if (type === 'hp') {
      b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
    } else if (type === 'bp') {
      b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
    } else { // peak
      const A = Math.pow(10, gainDb / 40);
      b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
  }

  run(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 이중 지수 펄스 exp(-t/τd) - exp(-t/τa)의 최대값 역수 */
function peakNorm(ta, td) {
  if (td <= ta * 1.001) return 1;
  const tp = (Math.log(td / ta) * ta * td) / (td - ta);
  const pk = Math.exp(-tp / td) - Math.exp(-tp / ta);
  return pk > 1e-6 ? 1 / pk : 1;
}

const FALLBACK_PRESET = {
  id: 'fallback', type: 'ice', cylinders: 4, firingAngles: [0, 540, 180, 360], bankOf: [0, 0, 0, 0], valves: 16,
  idleRpm: 800, redline: 6500, gearRatios: [3, 2, 1.4, 1],
  exhaust: { headerLen: 0.6, tailLen: 0.45, feedback: -0.65, mufflerCutoffMin: 800, mufflerCutoffMax: 7000, xPipe: 0, combMs: [1.37, 2.23, 3.71] },
  pulse: { attackMs: 0.3, decayMs: 4, noiseAmt: 0.3 }, lope: 0.2, jitter: 0.5, misfireProb: 0.01,
  intake: { centerMin: 300, centerMax: 1400, resHz: 260 },
  mix: { exhaust: 0.6, intake: 0.14, mech: 0.06, forced: 0, trans: 0.02, sub: 0.07 },
  forced: null, whine: { teeth: [29] }, pops: { amount: 0.6, big: 0.5, minRpm: 0.3 }, outGain: 1,
};

class EngineProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rpm', defaultValue: 0, minValue: 0, maxValue: 30000, automationRate: 'k-rate' },
      { name: 'throttle', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'load', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'fuelCut', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'overrun', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'volume', defaultValue: 1, minValue: 0, maxValue: 2, automationRate: 'k-rate' },
    ];
  }

  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.sr = sampleRate;
    this.seed = 0x2545f491;

    // 점화 펄스 보이스
    this.vActive = new Uint8Array(MAX_VOICES);
    this.vWait = new Float64Array(MAX_VOICES);
    this.vE1 = new Float64Array(MAX_VOICES);
    this.vE2 = new Float64Array(MAX_VOICES);
    this.vD1 = new Float64Array(MAX_VOICES);
    this.vD2 = new Float64Array(MAX_VOICES);
    this.vAmp = new Float64Array(MAX_VOICES);
    this.vNoise = new Float64Array(MAX_VOICES);
    this.vBank = new Uint8Array(MAX_VOICES);
    this.vNext = 0;

    // 팝 보이스
    this.pActive = new Uint8Array(MAX_POPS);
    this.pT = new Float64Array(MAX_POPS);
    this.pE = new Float64Array(MAX_POPS);
    this.pD = new Float64Array(MAX_POPS);
    this.pAtk = new Float64Array(MAX_POPS);
    this.pAmp = new Float64Array(MAX_POPS);
    this.pTh = new Float64Array(MAX_POPS);
    this.pThD = new Float64Array(MAX_POPS);
    this.pPh = new Float64Array(MAX_POPS);
    this.pInc = new Float64Array(MAX_POPS);
    this.pBank = new Uint8Array(MAX_POPS);
    this.pNext = 0;

    // 뱅크별 배기 웨이브가이드
    this.hDL = [new DelayLine(), new DelayLine()];
    this.tDL = [new DelayLine(), new DelayLine()];
    this.cDL = [
      [new DelayLine(), new DelayLine(), new DelayLine()],
      [new DelayLine(), new DelayLine(), new DelayLine()],
    ];
    this.hLen = new Float64Array(2);
    this.tLen = new Float64Array(2);
    this.cLen = [new Float64Array(3), new Float64Array(3)];
    this.hLp = new Float64Array(2);
    this.mufA = [new Biquad(), new Biquad()];
    this.mufB = [new Biquad(), new Biquad()];
    this.nzLp = new Float64Array(2);
    this.dcX = new Float64Array(2);
    this.dcY = new Float64Array(2);

    // 레이어 필터
    this.inBP = new Biquad();
    this.inRes = new Biquad();
    this.mechBP = new Biquad();
    this.turbBP = new Biquad();
    this.bovHP = new Biquad();
    this.evLP = new Biquad();
    this.bovHP.set('hp', 1400, 0.8, this.sr);
    this.stBP = new Biquad();
    this.stBP.set('bp', 900, 0.8, this.sr);
    this.mechEnvD = Math.exp(-1 / (0.0015 * this.sr));
    this.tickInc = TWO_PI * 2300 / this.sr;
    this.inLpK = 1 - Math.exp(-TWO_PI * 1600 / this.sr);
    this.stLoadK = 1 - Math.exp(-1 / (0.015 * this.sr));

    // 상태
    this.tRpm = 0; this.tThr = 0; this.tLoad = 0; this.tVol = 1; this.tOv = 0; this.ov = 0;
    this.valveS = 1; this.intakeS = 0;
    this.rpm = 0; this.rpmPrev = 0; this.thr = 0; this.thrSlow = 0; this.load = 0; this.vol = 1;
    this.fuelCut = false;
    this.ignition = false;
    this.ignGain = 0;
    this.starterOn = false;
    this.starterGain = 0;
    this.gearRatio = 0;
    this.gearIndex = 0;
    this.phase = 0; this.nextIdx = 0; this.cycleOff = 0; this.nextAngle = 0;
    this.lopePh = 0; this.lopeS = 0; this.lopeHz = 1;
    this.inPh = 0; this.camPh = 0; this.clickE = 0; this.mechEnv = 0; this.tickPh = 0; this.inLp = 0;
    this.stLoad = 0;
    this.whPh = 0; this.scPh = 0; this.trPh = 0; this.subPh = 0; this.stPh = 0;
    this.spool = 0; this.bovT = -1; this.bovAmp = 0; this.bovCool = 0;
    this.overrunT = 0; this.overrunDur = 1; this.limiterT = 0; this.shiftPopPending = false;
    this.intakeLvl = 0;
    this.evPh = 0; this.evPh2 = 0; this.evPh3 = 0; this.evLvl = 0; this.chimeT = -1; this.chimePh = 0;
    this.fade = 1; this.fadeTarget = 1; this.pendingPreset = null;
    this.statsOn = false; this.stAcc = 0; this.stBlocks = 0; this.stAudio = 0; this.stMax = 0;

    this.settings = { character: 0.5, crackle: 0.4, bass: 0.4, valve: 1, intake: 0, pops: true };
    this.layer = { exhaust: 1, intake: 1, mech: 1, forced: 1, trans: 1, pops: 1, sub: 1 };
    this.P = null;
    this.applyPreset(opts.preset || FALLBACK_PRESET, true);
    if (opts.settings) {
      this.applySettings(opts.settings);
      this.valveS = this.settings.valve;
      this.intakeS = this.settings.intake;
    }
    if (opts.layers) Object.assign(this.layer, opts.layers);

    this.timeline = null;
    if (opts.timeline) {
      this.timeline = { frames: opts.timeline.frames, msgs: opts.timeline.messages || [], fi: 0, mi: 0 };
    }
    this.port.onmessage = (e) => this.handle(e.data);
  }

  // ───────────────────────────── 메시지 / 프리셋 ─────────────────────────────

  handle(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'preset':
        if (msg.crossfade && this.P) {
          this.pendingPreset = msg.preset;
          this.fadeTarget = 0;
        } else {
          this.applyPreset(msg.preset, !msg.live);
        }
        break;
      case 'settings': this.applySettings(msg.settings || {}); break;
      case 'layers': Object.assign(this.layer, msg.layers || {}); break;
      case 'ignition': this.ignition = !!msg.on; break;
      case 'starter': this.starterOn = !!msg.on; break;
      case 'gear': this.gearRatio = msg.ratio || 0; this.gearIndex = msg.gear || 0; break;
      case 'liftoff':
        this.overrunDur = 0.3 + 1.7 * this.crackle();
        this.overrunT = this.overrunDur;
        break;
      case 'downshift':
        this.overrunDur = Math.max(0.6, this.overrunT);
        this.overrunT = this.overrunDur;
        break;
      case 'shiftPop': this.shiftPopPending = true; break;
      case 'limiterCut': this.limiterT = 0.12; break;
      case 'evReady': this.chimeT = 0; break;
      case 'stats':
        this.statsOn = !!msg.on;
        this.stAcc = 0; this.stBlocks = 0; this.stAudio = 0; this.stMax = 0;
        break;
      default: break;
    }
  }

  applySettings(s) {
    if (typeof s.character === 'number') this.settings.character = clamp(s.character, 0, 1);
    if (typeof s.crackle === 'number') this.settings.crackle = clamp(s.crackle, 0, 1);
    if (typeof s.bass === 'number') this.settings.bass = clamp(s.bass, 0, 1);
    if (typeof s.valve === 'number') this.settings.valve = clamp(s.valve, 0, 1);
    if (typeof s.intake === 'number') this.settings.intake = clamp(s.intake, 0, 1);
    if (typeof s.pops === 'boolean') this.settings.pops = s.pops;
  }

  /** 팝앤뱅 OFF면 0 — 크래클 슬라이더는 강도 */
  crackle() {
    return this.settings.pops ? this.settings.crackle : 0;
  }

  applyPreset(p, hard) {
    const sr = this.sr;
    const prevN = this.nEv || 0;
    this.P = p;
    this.isEV = p.type === 'ev';
    this.outGain = p.outGain ?? 1;
    const rnd = mulberry32(hashString(String(p.id || 'preset')));
    this.lopeHz = 0.8 + rnd() * 0.6;

    if (!this.isEV) {
      const n = p.cylinders;
      const order = [];
      for (let c = 0; c < n; c++) order.push(c);
      order.sort((a, b) => (p.firingAngles[a] % 720) - (p.firingAngles[b] % 720));
      this.nEv = n;
      this.evCyl = Int32Array.from(order);
      this.evAngles = Float64Array.from(order.map((c) => ((p.firingAngles[c] % 720) + 720) % 720));
      this.bankOf = Uint8Array.from(p.bankOf.map((b) => (b ? 1 : 0)));
      this.singleBank = p.bankOf.every((b) => b === p.bankOf[0]);
      // 실린더별 고정 편차: 진폭 ±6%, 펄스 길이 ±5%, 배기 경로 길이 차이(0~0.6ms)
      this.cylAmp = new Float64Array(n);
      this.cylDecay = new Float64Array(n);
      this.cylDelay = new Float64Array(n);
      for (let c = 0; c < n; c++) {
        this.cylAmp[c] = 1 + (rnd() * 2 - 1) * 0.06;
        this.cylDecay[c] = 1 + (rnd() * 2 - 1) * 0.05;
        this.cylDelay[c] = rnd() * 0.0006 * sr;
      }
      const ex = p.exhaust;
      const combMs = ex.combMs || [1.37, 2.23, 3.71];
      for (let b = 0; b < 2; b++) {
        const hl = ex.headerLen * (b ? 1.035 : 0.98);
        const tl = ex.tailLen * (b ? 0.97 : 1.03);
        this.hLen[b] = clamp((2 * hl / SOUND_SPEED) * sr, 2, DL_SIZE - 4);
        this.tLen[b] = clamp((2 * tl / SOUND_SPEED) * sr, 2, DL_SIZE - 4);
        for (let k = 0; k < 3; k++) {
          this.cLen[b][k] = clamp(combMs[k % combMs.length] * (1 + (rnd() * 2 - 1) * 0.03) * sr / 1000, 2, DL_SIZE - 4);
        }
      }
      this.xPipe = clamp(ex.xPipe || 0, 0, 1);
      if (hard || prevN !== n) {
        this.phase = 0;
        this.nextIdx = 0;
        this.cycleOff = 0;
        this.nextAngle = this.evAngles[0];
      }
    }
    if (hard) this.resetDsp();
  }

  resetDsp() {
    for (let b = 0; b < 2; b++) {
      this.hDL[b].clear(); this.tDL[b].clear();
      for (let k = 0; k < 3; k++) this.cDL[b][k].clear();
      this.hLp[b] = 0; this.nzLp[b] = 0; this.dcX[b] = 0; this.dcY[b] = 0;
      this.mufA[b].reset(); this.mufB[b].reset();
    }
    this.vActive.fill(0);
    this.pActive.fill(0);
    this.stBP.reset();
    this.inBP.reset(); this.inRes.reset(); this.mechBP.reset(); this.turbBP.reset(); this.bovHP.reset(); this.evLP.reset();
    this.spool = 0; this.bovT = -1;
  }

  rand() {
    let x = this.seed;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.seed = x;
    return (x >>> 0) / 4294967296;
  }

  // ───────────────────────────── 점화 / 팝 이벤트 ─────────────────────────────

  fire(cyl, frac) {
    const sr = this.sr;
    let amp;
    let shortK = 1;
    if (!this.ignition) {
      amp = this.starterOn ? 0.3 : 0.07; // 압축·공기 펄스만 (크랭킹의 "그르릉"은 주로 이 펄스)
      shortK = 0.6;
    } else if (this.fuelCut) {
      amp = 0.09;
      shortK = 0.6;
    } else {
      // 오버런(감속 연료 차단) 중엔 압축·잔류 연소만 남은 약하고 짧은 펄스
      amp = lerp(0.32 + 0.68 * this.load, 0.13, this.ov);
      shortK = 1 - 0.3 * this.ov;
      if (this.misfire > 0 && this.rand() < this.misfire) amp *= 0.12 + 0.3 * this.rand();
    }
    amp *= this.cylAmp[cyl] * (1 + this.ampJit * (this.rand() * 2 - 1)) * (1 + this.lopeAmp * this.lopeS);

    const tauD = this.tauD * this.cylDecay[cyl] * shortK;
    const tauA = Math.min(this.tauA, tauD * 0.5);
    const jit = this.timeJit * this.fireInterval;
    const wait = 3 + jit + this.cylDelay[cyl] + (this.rand() * 2 - 1) * jit - frac;

    let v = -1;
    for (let k = 0; k < MAX_VOICES; k++) {
      const idx = (this.vNext + k) % MAX_VOICES;
      if (!this.vActive[idx]) { v = idx; break; }
    }
    if (v < 0) v = this.vNext; // 가득 차면 가장 오래된 보이스를 훔친다
    this.vNext = (v + 1) % MAX_VOICES;

    this.vActive[v] = 1;
    this.vWait[v] = Math.max(0.001, wait);
    this.vE1[v] = 1;
    this.vE2[v] = 1;
    this.vD1[v] = Math.exp(-1 / (tauD * sr));
    this.vD2[v] = Math.exp(-1 / (tauA * sr));
    this.vAmp[v] = amp * peakNorm(tauA, tauD);
    this.vNoise[v] = amp * this.noiseAmt;
    this.vBank[v] = this.bankOf[cyl];

    this.maybePop(this.bankOf[cyl], wait);
  }

  maybePop(bank, wait) {
    const c = this.crackle();
    const pp = this.P.pops || FALLBACK_PRESET.pops;
    if (c <= 0.001 || this.layer.pops <= 0) {
      this.shiftPopPending = false;
      return;
    }
    const rn = this.rpm / this.P.redline;
    if (this.shiftPopPending) {
      this.shiftPopPending = false;
      if (this.rand() < 0.3 + 0.7 * c) this.spawnPop(bank, wait, 0.9 + 0.8 * this.rand(), this.rand() < 0.35 * c);
      return;
    }
    let p = 0;
    if (this.fuelCut && this.limiterT > 0) p = 0.4;
    else if (this.ignition && this.thr < 0.1) {
      if (this.overrunT > 0) p = 0.55 * (this.overrunT / this.overrunDur);
      else if (rn > 0.4 || this.ov > 0.5) p = 0.025;
    }
    if (p <= 0) return;
    // 차량 고유 성향(빈도·하한 rpm) × 크래클 강도 × 배기 밸브(열림일수록 잦음)
    const vk = (this.valveS - 1) * (this.P.exhaust.valveRange ?? 0.7);
    p *= Math.pow(c, 1.3) * clamp((rn - pp.minRpm) / 0.45, 0, 1) * (0.4 + pp.amount) * (1 + 0.8 * vk);
    if (this.rand() < p) {
      const big = this.rand() < (0.05 + 0.13 * c) * (0.4 + 1.2 * pp.big);
      this.spawnPop(bank, wait, big ? 1.8 + 1.0 * this.rand() : 0.3 + 0.6 * this.rand(), big);
    }
  }

  spawnPop(bank, wait, amp, big) {
    const sr = this.sr;
    let k = -1;
    for (let j = 0; j < MAX_POPS; j++) {
      const idx = (this.pNext + j) % MAX_POPS;
      if (!this.pActive[idx]) { k = idx; break; }
    }
    if (k < 0) k = this.pNext;
    this.pNext = (k + 1) % MAX_POPS;
    const tau = big ? 0.0045 + 0.003 * this.rand() : 0.0007 + 0.0016 * this.rand();
    const thTau = big ? 0.045 : 0.014;
    this.pActive[k] = 1;
    this.pT[k] = -(wait + (0.003 + 0.008 * this.rand()) * sr); // 배기관 안에서 터지는 지연
    this.pE[k] = 1;
    this.pD[k] = Math.exp(-1 / (tau * sr));
    this.pAtk[k] = 0;
    this.pAmp[k] = amp;
    this.pTh[k] = amp * (big ? 1.1 : 0.35);
    this.pThD[k] = Math.exp(-1 / (thTau * sr));
    this.pPh[k] = 0;
    this.pInc[k] = TWO_PI * (60 + 60 * this.rand()) / sr;
    this.pBank[k] = this.singleBank ? (this.rand() < 0.5 ? 0 : 1) : bank;
  }

  // ───────────────────────────── 블록 단위 계수 ─────────────────────────────

  stepTimeline() {
    const tl = this.timeline;
    const t = currentTime;
    const f = tl.frames;
    const nF = (f.length / FRAME_STRIDE) | 0;
    while (tl.fi + 1 < nF && f[(tl.fi + 1) * FRAME_STRIDE] <= t) tl.fi++;
    const o = tl.fi * FRAME_STRIDE;
    this.tRpm = f[o + 1];
    this.tThr = f[o + 2];
    this.tLoad = f[o + 3];
    this.fuelCut = f[o + 4] >= 0.5;
    this.tOv = f[o + 5];
    this.tVol = 1;
    while (tl.mi < tl.msgs.length && tl.msgs[tl.mi].t <= t) {
      this.handle(tl.msgs[tl.mi].msg);
      tl.mi++;
    }
  }

  blockUpdate(n) {
    const sr = this.sr;
    const dtB = n / sr;
    const P = this.P;
    this.rpmPrev = this.rpm;
    this.rpm += (this.tRpm - this.rpm) * (1 - Math.exp(-dtB / 0.012));
    this.thr += (this.tThr - this.thr) * (1 - Math.exp(-dtB / 0.015));
    this.load += (this.tLoad - this.load) * (1 - Math.exp(-dtB / 0.025));
    this.vol += (this.tVol - this.vol) * (1 - Math.exp(-dtB / 0.02));
    this.thrSlow += (this.thr - this.thrSlow) * (1 - Math.exp(-dtB / 0.15));
    this.ov += (this.tOv - this.ov) * (1 - Math.exp(-dtB / 0.04));
    const kSw = 1 - Math.exp(-dtB / 0.35);
    this.valveS += (this.settings.valve - this.valveS) * kSw;
    this.intakeS += (this.settings.intake - this.intakeS) * kSw;
    this.ignGain += ((this.ignition ? 1 : 0) - this.ignGain) * (1 - Math.exp(-dtB / 0.06));
    this.starterGain += ((this.starterOn ? 1 : 0) - this.starterGain) * (1 - Math.exp(-dtB / 0.03));
    if (this.overrunT > 0) this.overrunT -= dtB;
    if (this.limiterT > 0) this.limiterT -= dtB;
    if (this.bovCool > 0) this.bovCool -= dtB;
    if (this.chimeT >= 0) { this.chimeT += dtB; if (this.chimeT > 0.6) this.chimeT = -1; }

    if (this.isEV) {
      const target = this.ignition && this.rpm > 5
        ? (this.thr < 0.03 ? 0.05 : 0.12 + 0.88 * Math.pow(this.thr, 0.7)) * Math.min(1, this.rpm / 500) : 0;
      this.evLvl += (target - this.evLvl) * (1 - Math.exp(-dtB / (target > this.evLvl ? 0.08 : 0.25)));
      const rn = Math.min(1, this.rpm / P.redline);
      this.evLP.set('lp', 900 + 7000 * rn, 0.9, sr);
      return;
    }

    const rpm = this.rpm;
    const rn = Math.min(1.2, rpm / P.redline);
    const rn1 = Math.min(rn, 1);
    const ch = this.settings.character;
    const load = this.load;
    const thr = this.thr;
    const idleF = clamp(1 - (rpm - P.idleRpm) / (P.idleRpm * 0.9), 0, 1);
    const L = this.layer;
    const ov = this.ov;
    const vk = (this.valveS - 1) * (P.exhaust.valveRange ?? 0.7); // 밸브 열림 0 ~ 닫힘 -valveRange
    const isp = this.intakeS;

    this.fireFreq = (rpm / 60) * (P.cylinders / 2);
    this.fireInterval = this.fireFreq > 1 ? sr / this.fireFreq : sr;
    this.fireInc = TWO_PI * this.fireFreq / sr;

    // 펄스 모양: rpm 높을수록, 부하 낮을수록 짧게
    this.tauD = P.pulse.decayMs * 0.001 * (1 - 0.55 * rn1) * (0.65 + 0.35 * load);
    this.tauA = P.pulse.attackMs * 0.001 * (1 - 0.3 * rn1);
    this.noiseAmt = P.pulse.noiseAmt * (0.55 + 0.9 * ch) * (0.6 + 0.4 * load) * (1 + 0.5 * ov) * (1 + 0.5 * vk);
    this.timeJit = (0.002 + 0.008 * idleF) * P.jitter * (0.7 + 0.6 * ch) * (1 - 0.6 * rn1);
    this.ampJit = (0.02 + 0.03 * idleF) * P.jitter * (0.8 + 0.4 * ch) * (1 - 0.5 * rn1);
    this.lopeDepth = P.lope * 0.045 * idleF * (0.4 + ch);
    this.lopeAmp = P.lope * 0.22 * idleF * (0.4 + ch);
    this.lopeInc = TWO_PI * this.lopeHz / sr;
    this.misfire = P.misfireProb * idleF * (0.3 + 1.2 * ch);

    // 배기
    const ex = P.exhaust;
    const fc = clamp(lerp(ex.mufflerCutoffMin, ex.mufflerCutoffMax, ch) * (0.8 + 0.4 * load) * (0.85 + 0.35 * rn1)
      * (1 - 0.35 * ov) * (1 + 0.6 * vk), 120, sr * 0.45);
    this.mufA[0].set('lp', fc, 0.62, sr);
    this.mufA[1].copyFrom(this.mufA[0]);
    this.mufB[0].set('lp', fc * 1.35, 0.7, sr);
    this.mufB[1].copyFrom(this.mufB[0]);
    this.hFb = clamp(ex.feedback * (0.85 + 0.25 * ch), -0.93, 0.93);
    this.hLpA = 1 - Math.exp(-TWO_PI * (2500 + 6000 * ch) / sr);
    this.combG = 0.15 + 0.5 * ch;
    this.combMix = clamp(0.35 + 0.35 * ch - 0.3 * vk, 0.1, 0.9);
    this.tFb = -(0.12 + 0.28 * ch) * (1 + 0.8 * vk);
    // 연소 난류 노이즈 대역: 너무 밝으면 고rpm에서 "치지직" 지글거림으로 들린다
    this.nzK = 1 - Math.exp(-TWO_PI * (1200 + 3800 * ch) * (1 + 0.6 * vk) / sr);
    this.exGain = P.mix.exhaust * (0.65 + 0.7 * ch) * (1 + 0.5 * vk);
    this.exIn = L.exhaust;

    // 흡기: 풀스로틀 고rpm에서 "후아앙", 오프스로틀은 빠르게 감소
    const it = P.intake;
    const inCenter = lerp(it.centerMin, it.centerMax, rn1) * (1 + 0.12 * isp);
    this.inBP.set('bp', inCenter, 1.1, sr);
    this.inNorm = Math.sqrt(500 / inCenter); // 대역 노이즈 에너지는 중심주파수에 비례하므로 보정
    this.inRes.set('bp', it.resHz * (0.9 + 0.3 * rn1), 6 + 4 * isp, sr);
    // 기본 흡기 소음은 엔진이 돌 때만 (꺼져 있을 때 노이즈가 남지 않도록)
    const inBase = 0.012 * this.ignGain * Math.min(1, rpm / 300);
    const inTarget = (inBase + Math.pow(thr, 1.5) * Math.min(rn * 1.2, 1.2)) * P.mix.intake * L.intake * 7
      * (1 + 1.3 * isp) * (1 - 0.8 * ov);
    this.intakeLvl += (inTarget - this.intakeLvl) * (1 - Math.exp(-dtB / (inTarget > this.intakeLvl ? 0.05 : 0.03)));

    // 기계음
    this.valveInc = (rpm / 120) * P.valves / sr;
    this.mechBP.set('bp', clamp(this.fireFreq * 9, 300, 7500), 7, sr);
    this.clickD = Math.exp(-1 / (0.0004 * sr));
    this.mechLvl = P.mix.mech * L.mech * (0.3 + 0.7 * rn1) * (0.6 + 0.4 * load) * this.ignGain * 4;

    // 과급기
    const F = P.forced;
    this.whLvl = 0; this.scLvl = 0;
    if (F && F.type === 'turbo') {
      const target = thr > 0.25 ? clamp(thr * (0.25 + rn), 0, 1) : 0;
      const tau = target > this.spool ? F.lag : 0.4;
      this.spool += (target - this.spool) * (1 - Math.exp(-dtB / tau));
      if (F.bov !== 'none' && this.bovCool <= 0 && this.thrSlow > 0.45 && thr < 0.12 && this.spool > 0.55) {
        this.bovT = 0;
        this.bovAmp = this.spool;
        this.bovCool = 1;
        this.spool *= 0.35;
      }
      const f = lerp(F.fMin, F.fMax, this.spool);
      this.whInc = TWO_PI * f / sr;
      this.turbBP.set('bp', f * 0.5, 4, sr);
      this.whLvl = this.spool * this.spool * (0.25 + 0.75 * thr) * P.mix.forced * L.forced * 1.5 * (1 + 0.8 * isp);
      this.bovLvl = P.mix.forced * L.forced * 2.2 * (1 + 0.6 * isp);
      this.flutter = F.bov === 'flutter';
    } else if (F && F.type === 'super') {
      this.scInc = TWO_PI * ((rpm / 60) * F.ratio) / sr;
      this.scLvl = (0.15 + 0.85 * load) * Math.pow(rn1, 0.8) * (0.3 + 0.7 * thr) * P.mix.forced * L.forced * this.ignGain * (1 + 0.5 * isp);
    }

    // 변속기 와인 (출력축 rpm × 기어 잇수)
    if (this.gearRatio > 0) {
      const wt = (P.whine || FALLBACK_PRESET.whine).teeth;
      const teeth = wt[Math.max(0, this.gearIndex - 1) % wt.length];
      this.trInc = TWO_PI * ((rpm / this.gearRatio / 60) * teeth) / sr;
      this.trLvl = P.mix.trans * L.trans * (0.3 + 0.7 * load) * Math.min(1, rpm / 1500);
    } else {
      this.trLvl = 0;
    }

    // 서브베이스: 점화 기본 주파수, 35Hz 미만이면 옥타브 위로
    let sf = this.fireFreq;
    while (sf > 0 && sf < 35) sf *= 2;
    this.subInc = TWO_PI * sf / sr;
    this.subLvl = P.mix.sub * L.sub * (0.3 + 0.7 * load) * (0.4 + 1.2 * this.settings.bass) * this.ignGain * Math.min(1, rpm / 300)
      * (1 - 0.5 * ov);

    this.popGain = L.pops * 0.22 * (1 + 0.8 * vk);
  }

  // ───────────────────────────── 렌더 ─────────────────────────────

  process(inputs, outputs, parameters) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const outL = out[0];
    const outR = out.length > 1 ? out[1] : null;
    const n = outL.length;
    const t0 = this.statsOn ? nowMs() : 0;

    if (this.timeline) this.stepTimeline();
    else {
      this.tRpm = parameters.rpm[0];
      this.tThr = parameters.throttle[0];
      this.tLoad = parameters.load[0];
      this.fuelCut = parameters.fuelCut[0] >= 0.5;
      this.tOv = parameters.overrun ? parameters.overrun[0] : 0;
      this.tVol = parameters.volume[0];
    }

    this.blockUpdate(n);
    if (this.isEV) this.renderEV(outL, outR, n);
    else this.renderICE(outL, outR, n);

    // 프리셋 크로스페이드: 페이드아웃 → 교체 → 페이드인
    if (this.fade <= 0 && this.pendingPreset) {
      this.applyPreset(this.pendingPreset, true);
      this.pendingPreset = null;
      this.fadeTarget = 1;
    }
    // 수치 폭주 보호
    if (!Number.isFinite(this.dcY[0]) || !Number.isFinite(this.dcY[1])) this.resetDsp();

    if (this.statsOn) {
      const dt = nowMs() - t0;
      this.stAcc += dt;
      if (dt > this.stMax) this.stMax = dt;
      this.stBlocks++;
      this.stAudio += n / this.sr;
      if (this.stAudio >= 1) {
        this.port.postMessage({
          type: 'stats',
          avgMs: this.stAcc / this.stBlocks,
          maxMs: this.stMax,
          load: this.stAcc / 1000 / this.stAudio,
          voices: this.activeVoices(),
        });
        this.stAcc = 0; this.stBlocks = 0; this.stAudio = 0; this.stMax = 0;
      }
    }
    return true;
  }

  activeVoices() {
    let c = 0;
    for (let i = 0; i < MAX_VOICES; i++) c += this.vActive[i];
    return c;
  }

  bankStep(b, x, popTail) {
    const h = this.hDL[b];
    // 헤더: 열린 끝 반사(위상 반전 피드백) + 루프 내 1-pole LPF
    const lp = this.hLp[b] + this.hLpA * (h.read(this.hLen[b]) - this.hLp[b]);
    this.hLp[b] = lp;
    const hy = x + this.hFb * lp;
    h.write(hy);
    // 머플러: 서로소 비 딜레이의 콤 3개 + 2단 LPF
    const cd = this.cDL[b];
    const cl = this.cLen[b];
    const g = this.combG;
    let cs = 0;
    for (let k = 0; k < 3; k++) {
      const c = hy + g * cd[k].read(cl[k]);
      cd[k].write(c);
      cs += c;
    }
    const m = hy * (1 - this.combMix) + cs * this.combMix * (1 - g) * (1 / 3);
    const l = this.mufB[b].run(this.mufA[b].run(m)) + popTail;
    // 테일파이프: 짧은 딜레이 + 약한 반전 피드백
    const t = this.tDL[b];
    const ty = l + this.tFb * t.read(this.tLen[b]);
    t.write(ty);
    return ty;
  }

  renderICE(outL, outR, n) {
    const sr = this.sr;
    const rpmA = this.rpmPrev;
    const dR = (this.rpm - rpmA) / n;
    const degPerRpm = 6 / sr; // 360°/60s
    const vA = this.vActive, vW = this.vWait, vE1 = this.vE1, vE2 = this.vE2, vD1 = this.vD1, vD2 = this.vD2;
    const vAmp = this.vAmp, vNz = this.vNoise, vB = this.vBank;
    const pA = this.pActive, pT = this.pT, pE = this.pE, pD = this.pD, pAtk = this.pAtk, pAmp = this.pAmp;
    const pTh = this.pTh, pThD = this.pThD, pPh = this.pPh, pInc = this.pInc, pB = this.pBank;
    const single = this.singleBank;
    const xp = this.xPipe * 0.5;
    const nzK = this.nzK;
    const exGain = this.exGain;
    const popGain = this.popGain;
    const fadeStep = 1 / (0.1 * sr);
    const gOut = this.outGain;
    const forced = this.P.forced;
    const isTurbo = forced && forced.type === 'turbo';
    const isSuper = forced && forced.type === 'super';
    let phase = this.phase;
    let lopePh = this.lopePh;

    for (let i = 0; i < n; i++) {
      const rpm = rpmA + dR * i;

      // ── 크랭크 위상 & 점화 ──
      const lopeS = Math.sin(lopePh);
      lopePh += this.lopeInc;
      if (lopePh > TWO_PI) lopePh -= TWO_PI;
      this.lopeS = lopeS;
      const dphi = rpm * (1 + this.lopeDepth * lopeS) * degPerRpm;
      if (dphi > 0) {
        phase += dphi;
        let guard = 0;
        while (phase >= this.nextAngle && guard++ < 64) {
          this.fire(this.evCyl[this.nextIdx], (phase - this.nextAngle) / dphi);
          this.nextIdx++;
          if (this.nextIdx >= this.nEv) { this.nextIdx = 0; this.cycleOff += 720; }
          this.nextAngle = this.evAngles[this.nextIdx] + this.cycleOff;
        }
        if (phase >= 720) { phase -= 720; this.cycleOff -= 720; this.nextAngle -= 720; }
      }

      // ── 펄스 보이스 합산 ──
      let pL = 0, pR = 0, nL = 0, nR = 0;
      for (let v = 0; v < MAX_VOICES; v++) {
        if (!vA[v]) continue;
        let w = vW[v];
        if (w > 0) {
          w -= 1;
          if (w > 0) { vW[v] = w; continue; }
          // 분수 시작점: 지난만큼 엔벨로프를 미리 진행
          const adv = -w;
          vW[v] = 0;
          vE1[v] = Math.pow(vD1[v], adv);
          vE2[v] = Math.pow(vD2[v], adv);
        }
        const e1 = vE1[v];
        const s = vAmp[v] * (e1 - vE2[v]);
        const ne = vNz[v] * e1;
        if (vB[v]) { pR += s; nR += ne; } else { pL += s; nL += ne; }
        vE1[v] = e1 * vD1[v];
        vE2[v] *= vD2[v];
        if (e1 < 1e-3) vA[v] = 0;
      }

      // ── 팝 / 크래클 ──
      let popTL = 0, popTR = 0;
      const nzP = this.rand() * 2 - 1;
      for (let k = 0; k < MAX_POPS; k++) {
        if (!pA[k]) continue;
        const t = pT[k];
        pT[k] = t + 1;
        if (t < 0) continue;
        pAtk[k] += (1 - pAtk[k]) * 0.35;
        const s = nzP * pE[k] * pAtk[k] * pAmp[k] + Math.sin(pPh[k]) * pTh[k];
        pPh[k] += pInc[k];
        pE[k] *= pD[k];
        pTh[k] *= pThD[k];
        if (pB[k]) popTR += s; else popTL += s;
        if (pE[k] < 1e-3 && Math.abs(pTh[k]) < 1e-3) pA[k] = 0;
      }
      popTL *= popGain;
      popTR *= popGain;

      // ── 연소 난류 노이즈 → 뱅크 입력 ──
      this.nzLp[0] += ((this.rand() * 2 - 1) - this.nzLp[0]) * nzK;
      this.nzLp[1] += ((this.rand() * 2 - 1) - this.nzLp[1]) * nzK;
      let inL, inR;
      const exIn = this.exIn;
      pL *= exIn; pR *= exIn; nL *= exIn; nR *= exIn;
      if (single) {
        inL = pL + nL * this.nzLp[0];
        inR = pL + nL * this.nzLp[1];
      } else {
        const a = pL + nL * this.nzLp[0];
        const b = pR + nR * this.nzLp[1];
        inL = a + (b - a) * xp;
        inR = b + (a - b) * xp;
      }

      // ── 배기 웨이브가이드 (팝은 30% 헤더, 나머지는 테일 쪽에 주입) ──
      const b0 = this.bankStep(0, inL + popTL * 0.3, popTL * 0.8);
      const b1 = this.bankStep(1, inR + popTR * 0.3, popTR * 0.8);

      // ── 흡기 ──
      this.inPh += this.fireInc;
      if (this.inPh > TWO_PI) this.inPh -= TWO_PI;
      let center = 0;
      if (this.intakeLvl > 1e-5) {
        const am = 0.55 + 0.45 * Math.sin(this.inPh);
        // 흡기 바람 소리는 1.6kHz 위를 깎아 "치익" 하는 고역 지글거림이 남지 않게 한다
        this.inLp += (this.inBP.run(this.rand() * 2 - 1) - this.inLp) * this.inLpK;
        center += (this.inLp * am * 0.8 * this.inNorm + this.inRes.run((pL + pR) * 0.5) * 0.6) * this.intakeLvl;
      }

      // ── 기계음: 밸브 틱 + 고차 협대역 ──
      if (this.mechLvl > 1e-5) {
        this.camPh += this.valveInc;
        if (this.camPh >= 1) { this.camPh -= 1; this.clickE = 0.6 + 0.4 * this.rand(); this.mechEnv = 1; this.tickPh = 0; }
        // 밸브 틱: 짧게 울리는 감쇠 사인 (미분한 화이트 노이즈를 쓰면 rpm이 오를수록 "치지직" 지글거림이 됨)
        const tick = Math.sin(this.tickPh) * this.clickE;
        this.tickPh += this.tickInc;
        this.clickE *= this.clickD;
        // 협대역 노이즈는 밸브 이벤트마다 아주 짧고 작게만
        this.mechEnv *= this.mechEnvD;
        const nzm = this.mechEnv > 1e-3 ? this.rand() * 2 - 1 : 0;
        center += (tick * 0.3 + this.mechBP.run(nzm) * 0.35 * this.mechEnv) * this.mechLvl;
      }

      // ── 과급기 ──
      if (isTurbo) {
        if (this.whLvl > 1e-5) {
          this.whPh += this.whInc;
          if (this.whPh > TWO_PI) this.whPh -= TWO_PI;
          center += (Math.sin(this.whPh) * 0.6 + this.turbBP.run(this.rand() * 2 - 1) * 0.5) * this.whLvl;
        }
        if (this.bovT >= 0) {
          const t = this.bovT;
          const env = this.bovAmp * Math.exp(-t / 0.085) * Math.min(1, t / 0.004);
          let am = 1;
          if (this.flutter) {
            const s = Math.sin(TWO_PI * (17 - 18 * t) * t);
            am = s > 0 ? s * s : 0;
          }
          center += this.bovHP.run(this.rand() * 2 - 1) * env * am * this.bovLvl;
          this.bovT += 1 / sr;
          if (this.bovT > 0.45) this.bovT = -1;
        }
      } else if (isSuper && this.scLvl > 1e-5) {
        this.scPh += this.scInc * (1 + 0.003 * Math.sin(this.lopePh * 7));
        if (this.scPh > TWO_PI) this.scPh -= TWO_PI;
        const ph = this.scPh;
        center += (Math.sin(ph) + 0.4 * Math.sin(2 * ph) + 0.18 * Math.sin(3 * ph)) * this.scLvl;
      }

      // ── 변속기 와인 ──
      if (this.trLvl > 1e-5) {
        this.trPh += this.trInc;
        if (this.trPh > TWO_PI) this.trPh -= TWO_PI;
        center += (Math.sin(this.trPh) + 0.3 * Math.sin(2 * this.trPh)) * this.trLvl;
      }

      // ── 서브베이스 ──
      if (this.subLvl > 1e-5) {
        this.subPh += this.subInc;
        if (this.subPh > TWO_PI) this.subPh -= TWO_PI;
        center += Math.sin(this.subPh) * this.subLvl;
      }

      // ── 스타터 모터: 순음 없이 기어·브러시가 갈리는 대역 노이즈만, 압축 행정마다 "그르르" 하고 굵어진다 ──
      // (음정이 있는 성분을 넣으면 시동 때 사이렌이나 전자음처럼 들린다)
      if (this.starterGain > 1e-4) {
        const comp = Math.max(0, Math.sin(this.inPh));
        this.stLoad += (comp - this.stLoad) * this.stLoadK;
        const grind = this.stBP.run(this.rand() * 2 - 1);
        center += grind * 0.045 * this.starterGain * (0.3 + 0.7 * this.stLoad);
      }

      // ── 믹스 & DC 블록 ──
      const yL = b0 * exGain + center;
      const yR = b1 * exGain + center;
      const dL = yL - this.dcX[0] + 0.998 * this.dcY[0];
      this.dcX[0] = yL; this.dcY[0] = dL;
      const dRr = yR - this.dcX[1] + 0.998 * this.dcY[1];
      this.dcX[1] = yR; this.dcY[1] = dRr;

      if (this.fade !== this.fadeTarget) {
        this.fade += this.fade < this.fadeTarget ? fadeStep : -fadeStep;
        if (Math.abs(this.fade - this.fadeTarget) < fadeStep) this.fade = this.fadeTarget;
      }
      const g = gOut * this.fade * this.vol;
      outL[i] = dL * g;
      if (outR) outR[i] = dRr * g;
    }
    this.phase = phase;
    this.lopePh = lopePh;
  }

  renderEV(outL, outR, n) {
    const sr = this.sr;
    const rpmA = this.rpmPrev;
    const dR = (this.rpm - rpmA) / n;
    const pp = this.P.polePairs || 4;
    const fadeStep = 1 / (0.1 * sr);
    const bass = 0.4 + 1.2 * this.settings.bass;
    const subMix = (this.P.mix.sub ?? 0.3) * this.layer.sub;
    for (let i = 0; i < n; i++) {
      const rpm = rpmA + dR * i;
      const f0 = (rpm / 60) * pp;
      this.evPh += TWO_PI * f0 / sr;
      if (this.evPh > TWO_PI * 64) this.evPh -= TWO_PI * 64;
      this.evPh2 += TWO_PI * (f0 * 4.62 + 180) / sr;
      if (this.evPh2 > TWO_PI) this.evPh2 -= TWO_PI;
      this.evPh3 += TWO_PI * (f0 * 0.5) / sr;
      if (this.evPh3 > TWO_PI) this.evPh3 -= TWO_PI;
      const ph = this.evPh;
      const motor = Math.sin(ph) + 0.45 * Math.sin(2 * ph) + 0.3 * Math.sin(3 * ph) + 0.16 * Math.sin(6 * ph);
      const inverter = Math.sin(this.evPh2) * 0.3 * (0.5 + 0.5 * Math.sin(this.evPh3 * 0.25));
      const sub = Math.sin(this.evPh3) * subMix * bass;
      let y = this.evLP.run(motor * 0.4 + inverter + sub) * this.evLvl;

      // 준비 차임 (두 음)
      if (this.chimeT >= 0) {
        const t = this.chimeT;
        const f = t < 0.18 ? 659.25 : 987.77;
        this.chimePh += TWO_PI * f / sr;
        y += Math.sin(this.chimePh) * 0.12 * Math.exp(-((t < 0.18 ? t : t - 0.18) / 0.12));
      }

      const dL = y - this.dcX[0] + 0.998 * this.dcY[0];
      this.dcX[0] = y; this.dcY[0] = dL;
      if (this.fade !== this.fadeTarget) {
        this.fade += this.fade < this.fadeTarget ? fadeStep : -fadeStep;
        if (Math.abs(this.fade - this.fadeTarget) < fadeStep) this.fade = this.fadeTarget;
      }
      const v = dL * this.outGain * this.fade * this.vol;
      outL[i] = v;
      if (outR) outR[i] = v;
    }
    this.dcY[1] = 0;
  }
}

registerProcessor('engine-processor', EngineProcessor);
