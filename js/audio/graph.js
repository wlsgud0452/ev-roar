/**
 * AudioContext와 후처리 체인 구성.
 *
 * worklet(stereo) → 새츄레이션(tanh, 4x 오버샘플) → 하이패스(오디오 구성) → EQ(로우셸프/바디/프레즌스/하이컷)
 *   → 실내/외부 청취(실내: 차체 차음 로우패스 + 캐빈 붐) → 리버브(절차적 IR, dry+wet)
 *   → 스테레오 폭(뱅크 L/R 60:40 + 하스 딜레이) → 컴프레서 → 소프트 리미터 → 볼륨 → destination
 */
import { createImpulseResponse } from './ir.js';
import { Sampler } from './sampler.js';
import { AUDIO_SYSTEMS } from '../presets/tesla.js';

export const WORKLET_URL = new URL('./engine-worklet.js', import.meta.url).href;
const SAT_K = 4;
const INPUT_TRIM = 0.6;

function tanhCurve(k, n = 2048) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(k * x);
  }
  return c;
}

/** |x| < 0.7 선형, 그 위는 0.7 + 0.3·tanh로 부드럽게 눌러 최대 ±0.93 */
function limiterCurve(n = 4096, range = 4) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) * range;
    const a = Math.abs(x);
    const y = a < 0.7 ? a : 0.7 + 0.3 * Math.tanh((a - 0.7) / 0.3);
    c[i] = Math.sign(x) * y;
  }
  return c;
}

export const volumeToGain = (v) => Math.pow(Math.max(0, Math.min(1, v)), 1.6);

/**
 * 후처리 체인. 실시간/오프라인 컨텍스트 모두에서 쓴다.
 * @param {BaseAudioContext} ctx
 * @param {AudioNode} source
 */
export function buildChain(ctx, source, { preset, settings }) {
  const input = ctx.createGain();
  input.gain.value = INPUT_TRIM;

  const pre = ctx.createGain();
  const shaper = ctx.createWaveShaper();
  shaper.curve = tanhCurve(SAT_K);
  shaper.oversample = '4x';
  const post = ctx.createGain();
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 22;
  hp.Q.value = 0.7;

  const low = ctx.createBiquadFilter();
  low.type = 'lowshelf';
  low.frequency.value = 90;
  const body = ctx.createBiquadFilter();
  body.type = 'peaking';
  body.Q.value = 1.2;
  body.gain.value = 3;
  const presence = ctx.createBiquadFilter();
  presence.type = 'peaking';
  presence.frequency.value = 3000;
  presence.Q.value = 0.9;
  const hicut = ctx.createBiquadFilter();
  hicut.type = 'lowpass';
  hicut.frequency.value = 12000;
  hicut.Q.value = 0.7;
  // 실내 청취: 차체가 고역을 깎고(로우패스) 실내 공명이 저역을 부풀린다(붐)
  const cabin = ctx.createBiquadFilter();
  cabin.type = 'lowpass';
  cabin.frequency.value = 18000;
  cabin.Q.value = 0.6;
  const boom = ctx.createBiquadFilter();
  boom.type = 'peaking';
  boom.frequency.value = 75;
  boom.Q.value = 1.1;
  boom.gain.value = 0;

  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const conv = ctx.createConvolver();
  conv.normalize = false;
  conv.buffer = createImpulseResponse(ctx);
  const sum = ctx.createGain();

  // 스테레오 폭: L' = 0.6L + 0.4R, R' = 0.4L + 0.6R (하스 딜레이)
  const split = ctx.createChannelSplitter(2);
  const merge = ctx.createChannelMerger(2);
  const gLL = ctx.createGain(); gLL.gain.value = 0.6;
  const gRL = ctx.createGain(); gRL.gain.value = 0.4;
  const gLR = ctx.createGain(); gLR.gain.value = 0.4;
  const gRR = ctx.createGain(); gRR.gain.value = 0.6;
  const haas = ctx.createDelay(0.01);
  haas.delayTime.value = 0.0005;

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18;
  comp.ratio.value = 4;
  comp.knee.value = 6;
  comp.attack.value = 0.005;
  comp.release.value = 0.15;
  const makeup = ctx.createGain();
  makeup.gain.value = 1.6;
  const limiter = ctx.createWaveShaper();
  limiter.curve = limiterCurve();
  limiter.oversample = '4x';
  const limIn = ctx.createGain();
  limIn.gain.value = 1 / 4; // 커브 입력 범위(±4)에 맞춤
  const vol = ctx.createGain();

  source.connect(input);
  input.connect(pre).connect(shaper).connect(post).connect(hp).connect(low).connect(body).connect(presence).connect(hicut)
    .connect(cabin).connect(boom);
  boom.connect(dry).connect(sum);
  boom.connect(wet).connect(conv).connect(sum);
  sum.connect(split);
  split.connect(gLL, 0); split.connect(gRL, 1);
  split.connect(gLR, 0); split.connect(gRR, 1);
  gLL.connect(merge, 0, 0); gRL.connect(merge, 0, 0);
  gLR.connect(haas); gRR.connect(haas);
  haas.connect(merge, 0, 1);
  merge.connect(comp).connect(makeup).connect(limIn).connect(limiter).connect(vol);

  const api = {
    input,
    output: vol,
    presenceDb: 0,
    setPreset(p, when = ctx.currentTime) {
      body.frequency.setTargetAtTime(p.eq.bodyResHz, when, 0.05);
      api.presenceDb = p.eq.presenceDb;
      api.applyListen(when);
    },
    setSettings(s, when = ctx.currentTime) {
      const sys = AUDIO_SYSTEMS[s.audioSystem] || AUDIO_SYSTEMS.premium;
      api.interior = s.listen === 'interior';
      low.gain.setTargetAtTime(3 + (s.bass ?? 0.4) * 6 + sys.bassDb, when, 0.05);
      hp.frequency.setTargetAtTime(sys.hpHz, when, 0.05);
      const space = (s.space ?? 0.4) * (api.interior ? 0.35 : 1);
      wet.gain.setTargetAtTime(space * 0.3, when, 0.05);
      dry.gain.setTargetAtTime(1 - space * 0.15, when, 0.05);
      vol.gain.setTargetAtTime(volumeToGain(s.volume ?? 0.8), when, 0.03);
      api.character = s.character ?? 0.5;
      api.applyListen(when);
    },
    /** 실내/외부 전환은 0.25초 시정수로 부드럽게 */
    applyListen(when = ctx.currentTime) {
      const inside = api.interior;
      cabin.frequency.setTargetAtTime(inside ? 2600 : 18000, when, 0.25);
      boom.gain.setTargetAtTime(inside ? 4.5 : 0, when, 0.25);
      presence.gain.setTargetAtTime(api.presenceDb - (inside ? 4 : 0), when, 0.25);
    },
    interior: false,
    /** 부하/캐릭터에 따른 새츄레이션 드라이브 */
    setDrive(load, when = ctx.currentTime) {
      const drive = 1 + load * 2 + api.character * 1.5;
      pre.gain.setTargetAtTime(drive / SAT_K, when, 0.05);
      post.gain.setTargetAtTime(1 / Math.sqrt(drive), when, 0.05);
    },
    character: 0.5,
  };
  api.setPreset(preset, 0);
  api.setSettings(settings, 0);
  api.setDrive(0, 0);
  return api;
}

export async function loadWorklet(ctx) {
  if (!ctx.audioWorklet) throw new Error('이 브라우저는 AudioWorklet을 지원하지 않습니다.');
  await ctx.audioWorklet.addModule(WORKLET_URL);
}

export function createEngineNode(ctx, processorOptions) {
  return new AudioWorkletNode(ctx, 'engine-processor', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions,
  });
}

/** 워크렛 파라미터로 보낼 설정만 추린다 */
export const workletSettings = (s) => ({
  character: s.character,
  crackle: s.crackle,
  bass: s.bass,
  valve: s.valve === 'closed' ? 0 : 1,
  intake: s.intake === 'sport' ? 1 : 0,
  pops: s.pops !== false,
});

/** 실시간 엔진 오디오 */
export class EngineAudio {
  constructor() {
    this.ctx = null;
    this.node = null;
    this.chain = null;
    this.onMessage = null;
    this.sampler = null;
    this.samplerActive = false;
  }

  /**
   * 반드시 사용자 제스처(클릭) 핸들러 안에서 호출한다. 첫 await 전에 컨텍스트를 만들고 resume한다.
   */
  async init({ preset, settings, layers }) {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = ctx;
    const resumed = ctx.resume();
    await loadWorklet(ctx);
    this.settings = { ...settings };
    this.preset = preset;
    this.node = createEngineNode(ctx, { preset, settings: workletSettings(settings), layers });
    this.chain = buildChain(ctx, this.node, { preset, settings });
    this.master = ctx.createGain();
    this.chain.output.connect(this.master);
    this.master.connect(ctx.destination);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 4096;
    this.analyser.smoothingTimeConstant = 0.6;
    this.chain.output.connect(this.analyser);
    this.node.port.onmessage = (e) => this.onMessage && this.onMessage(e.data);
    this.params = {
      rpm: this.node.parameters.get('rpm'),
      throttle: this.node.parameters.get('throttle'),
      load: this.node.parameters.get('load'),
      fuelCut: this.node.parameters.get('fuelCut'),
      overrun: this.node.parameters.get('overrun'),
      volume: this.node.parameters.get('volume'),
    };
    // 제스처 없이 호출되면 resume()이 끝나지 않을 수 있으므로 무한 대기하지 않는다
    await Promise.race([resumed, new Promise((r) => setTimeout(r, 1500))]);
  }

  get ready() {
    return !!this.node;
  }

  resume() {
    if (this.ctx && this.ctx.state !== 'running') return this.ctx.resume();
    return Promise.resolve();
  }

  /** 시뮬레이터 상태 → 워크렛 파라미터 (rAF마다) */
  setParams(s) {
    if (!this.node) return;
    const t = this.ctx.currentTime;
    this.params.rpm.setTargetAtTime(s.rpm, t, 0.02);
    this.params.throttle.setTargetAtTime(s.throttle, t, 0.02);
    this.params.load.setTargetAtTime(s.load, t, 0.02);
    this.params.fuelCut.setValueAtTime(s.fuelCut ? 1 : 0, t);
    this.params.overrun.setTargetAtTime(s.overrun || 0, t, 0.02);
    this.chain.setDrive(s.load, t);
    if (this.samplerActive) this.sampler.update(s.rpm, s.load);
  }

  post(msg) {
    if (this.node) this.node.port.postMessage(msg);
  }

  /** 음소거: 엔진·시뮬레이션은 계속 돌고 출력만 페이드 */
  setMuted(muted) {
    if (this.master) this.master.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.05);
  }

  setPreset(preset) {
    this.preset = preset;
    this.post({ type: 'preset', preset, crossfade: true });
    if (this.chain) this.chain.setPreset(preset);
    if (this.samplerActive) this.enableSamples(true);
  }

  setSettings(settings) {
    this.settings = { ...settings };
    this.post({ type: 'settings', settings: workletSettings(settings) });
    if (this.chain) this.chain.setSettings(settings);
  }

  /** (선택) 샘플 기반 하이브리드 모드. 매니페스트가 없으면 false를 돌려주고 합성 모드 유지 */
  async enableSamples(on) {
    if (!this.ctx) return false;
    if (!this.sampler) this.sampler = new Sampler(this.ctx, this.chain.input);
    if (!on) {
      this.sampler.unload();
      this.samplerActive = false;
      this.post({ type: 'layers', layers: { exhaust: 1, intake: 1, mech: 1 } });
      return false;
    }
    const ok = await this.sampler.load(this.preset.id);
    this.samplerActive = ok;
    this.post({ type: 'layers', layers: ok ? { exhaust: 0, intake: 0, mech: 0 } : { exhaust: 1, intake: 1, mech: 1 } });
    return ok;
  }
}
