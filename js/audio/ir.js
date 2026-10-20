/**
 * 절차적 리버브 IR: 초기 반사 몇 개 + 0.25~0.4초 감쇠 노이즈 꼬리 (시간이 갈수록 어두워짐).
 * 실내/차체 공간감을 주는 정도의 짧은 잔향이 목표.
 */
export function createImpulseResponse(ctx, { duration = 0.34, seed = 12345 } = {}) {
  const sr = ctx.sampleRate;
  const n = Math.floor(duration * sr);
  const buf = ctx.createBuffer(2, n, sr);
  let s = seed >>> 0;
  const rand = () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return ((s >>> 0) / 4294967296) * 2 - 1;
  };
  const early = [
    [0.0031, 0.55], [0.0057, 0.42], [0.0083, 0.36], [0.0119, 0.3], [0.0161, 0.22], [0.0213, 0.16],
  ];
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const env = Math.exp(-t / (duration / 6.5)) * Math.min(1, t / 0.004);
      // 시간이 갈수록 컷오프가 내려가는 1-pole LPF
      const k = 0.65 * Math.exp(-t / 0.12) + 0.08;
      lp += (rand() - lp) * k;
      d[i] = lp * env * 0.5;
    }
    for (const [t, a] of early) {
      const i = Math.floor((t * (ch ? 1.07 : 0.94)) * sr);
      if (i < n) d[i] += a * (ch ? -1 : 1) * (0.8 + 0.2 * rand());
    }
  }
  return buf;
}
