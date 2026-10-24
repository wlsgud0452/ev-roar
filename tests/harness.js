/**
 * Node에서 engine-worklet.js를 실행하기 위한 최소 AudioWorkletGlobalScope 흉내.
 * 단위 테스트와 레벨 측정에서 사용한다.
 */
const SR = 48000;
let Registered = null;

export async function loadWorklet(sampleRate = SR) {
  globalThis.sampleRate = sampleRate;
  globalThis.currentTime = 0;
  globalThis.AudioWorkletProcessor = class {
    constructor() {
      this.port = { postMessage: (m) => { (this._sent ||= []).push(m); }, onmessage: null };
    }
  };
  globalThis.registerProcessor = (name, cls) => { Registered = cls; };
  if (!Registered) await import('../js/audio/engine-worklet.js');
  return Registered;
}

/** 프로세서 래퍼: 파라미터를 설정하고 블록 단위로 렌더 */
export class Runner {
  constructor(Proc, processorOptions, sampleRate = SR) {
    this.sr = sampleRate;
    this.proc = new Proc({ processorOptions });
    this.params = { rpm: 0, throttle: 0, load: 0, fuelCut: 0, overrun: 0, volume: 1 };
    this.L = new Float32Array(128);
    this.R = new Float32Array(128);
    this.t = 0;
  }

  send(msg) { this.proc.port.onmessage({ data: msg }); }

  /** seconds만큼 렌더해 [L, R] Float32Array 반환. onBlock(t)으로 파라미터 변경 가능 */
  render(seconds, onBlock) {
    const nBlocks = Math.ceil((seconds * this.sr) / 128);
    const L = new Float32Array(nBlocks * 128);
    const R = new Float32Array(nBlocks * 128);
    const p = {};
    for (let b = 0; b < nBlocks; b++) {
      if (onBlock) onBlock(this.t, this.params);
      for (const k of Object.keys(this.params)) p[k] = [this.params[k]];
      globalThis.currentTime = this.t;
      this.proc.process([], [[this.L, this.R]], p);
      L.set(this.L, b * 128);
      R.set(this.R, b * 128);
      this.t += 128 / this.sr;
    }
    return [L, R];
  }
}

export function rms(a, from = 0, to = a.length) {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

export function peak(a) {
  let m = 0;
  for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > m) m = v; }
  return m;
}

export function hasNaN(a) {
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return true;
  return false;
}

export const db = (x) => 20 * Math.log10(Math.max(x, 1e-9));

/** 16-bit PCM 스테레오 WAV (테스트 결과 확인용) */
export function encodeWav(L, R, sr = SR) {
  const n = L.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.max(-1, Math.min(1, L[i])) * 32767 | 0, 44 + i * 4);
    buf.writeInt16LE(Math.max(-1, Math.min(1, R[i])) * 32767 | 0, 46 + i * 4);
  }
  return buf;
}
