/**
 * (선택) 샘플 기반 하이브리드 엔진 모드.
 *
 * assets/samples/<presetId>/manifest.json 예:
 *   { "samples": [ { "rpm": 1000, "on": "on_1000.wav", "off": "off_1000.wav" }, ... ] }
 *
 * 현재 rpm 기준 인접 두 샘플을 playbackRate로 피치 보정하고 이퀄파워로 크로스페이드,
 * 부하에 따라 on-load/off-load를 섞는다. 팝/터보/변속 레이어는 합성 엔진이 그대로 얹는다.
 * 직접 녹음했거나 CC0 등 라이선스가 허용된 녹음만 쓸 것.
 */
export class Sampler {
  constructor(ctx, destination) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.connect(destination);
    this.layers = [];
  }

  async decode(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    return this.ctx.decodeAudioData(await res.arrayBuffer());
  }

  voice(buffer) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    src.connect(g).connect(this.out);
    src.start();
    return { src, g };
  }

  async load(presetId) {
    this.unload();
    const base = `assets/samples/${presetId}/`;
    try {
      const res = await fetch(base + 'manifest.json');
      if (!res.ok) return false;
      const manifest = await res.json();
      for (const s of manifest.samples || []) {
        const on = await this.decode(base + s.on);
        const off = s.off ? await this.decode(base + s.off) : on;
        this.layers.push({ rpm: s.rpm, on: this.voice(on), off: this.voice(off) });
      }
      this.layers.sort((a, b) => a.rpm - b.rpm);
      return this.layers.length > 0;
    } catch (e) {
      console.warn('[sampler] 샘플을 불러오지 못해 합성 모드로 폴백합니다:', e);
      this.unload();
      return false;
    }
  }

  update(rpm, load) {
    const L = this.layers;
    if (!L.length) return;
    const t = this.ctx.currentTime;
    let i = 0;
    while (i < L.length - 1 && L[i + 1].rpm <= rpm) i++;
    const j = Math.min(i + 1, L.length - 1);
    const span = L[j].rpm - L[i].rpm;
    const x = span > 0 ? Math.min(1, Math.max(0, (rpm - L[i].rpm) / span)) : 0;
    const onMix = Math.min(1, Math.max(0, load));
    L.forEach((layer, k) => {
      let g = 0;
      if (k === i) g = Math.cos((x * Math.PI) / 2);
      if (k === j && j !== i) g = Math.sin((x * Math.PI) / 2);
      const rate = Math.max(0.25, rpm / layer.rpm);
      layer.on.src.playbackRate.setTargetAtTime(rate, t, 0.02);
      layer.off.src.playbackRate.setTargetAtTime(rate, t, 0.02);
      layer.on.g.gain.setTargetAtTime(g * onMix, t, 0.03);
      layer.off.g.gain.setTargetAtTime(g * (1 - onMix), t, 0.03);
    });
  }

  unload() {
    for (const l of this.layers) {
      for (const v of [l.on, l.off]) {
        try { v.src.stop(); } catch { /* 이미 정지됨 */ }
        v.src.disconnect();
        v.g.disconnect();
      }
    }
    this.layers = [];
  }
}
