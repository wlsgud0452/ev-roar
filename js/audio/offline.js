/**
 * OfflineAudioContext로 고정 시나리오(데모 런 등)를 렌더링하고 WAV로 인코딩한다 (사운드 비교·A/B·회귀 확인용).
 * 시뮬레이터를 고정 dt로 돌려 만든 프레임/이벤트 타임라인을 processorOptions로 워크렛에 넘긴다.
 */
import { simulateScenario, FRAME_STRIDE } from '../sim/demo.js';
import { buildChain, loadWorklet, createEngineNode, workletSettings } from './graph.js';

export async function renderScenario(scenario, preset, settings, { sampleRate = 48000, layers } = {}) {
  const { duration, frames, messages } = simulateScenario(scenario, preset, settings);
  const ctx = new OfflineAudioContext(2, Math.ceil(duration * sampleRate), sampleRate);
  await loadWorklet(ctx);
  const node = createEngineNode(ctx, {
    preset,
    settings: workletSettings(settings),
    layers,
    timeline: { frames, messages },
  });
  const chain = buildChain(ctx, node, { preset, settings });
  // 부하에 따른 새츄레이션 드라이브도 타임라인대로 예약
  for (let i = 0; i < frames.length; i += FRAME_STRIDE * 6) chain.setDrive(frames[i + 3], frames[i]);
  chain.output.connect(ctx.destination);
  return ctx.startRendering();
}

export const renderDemo = (preset, settings, opts) => renderScenario('demo', preset, settings, opts);

/** AudioBuffer → 16-bit PCM WAV Blob */
export function audioBufferToWav(buffer) {
  const nCh = buffer.numberOfChannels;
  const n = buffer.length;
  const sr = buffer.sampleRate;
  const data = new DataView(new ArrayBuffer(44 + n * nCh * 2));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); data.setUint32(4, 36 + n * nCh * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, nCh, true);
  data.setUint32(24, sr, true); data.setUint32(28, sr * nCh * 2, true); data.setUint16(32, nCh * 2, true); data.setUint16(34, 16, true);
  str(36, 'data'); data.setUint32(40, n * nCh * 2, true);
  const chans = [];
  for (let c = 0; c < nCh; c++) chans.push(buffer.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nCh; c++) {
      const v = Math.max(-1, Math.min(1, chans[c][i]));
      data.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([data], { type: 'audio/wav' });
}
