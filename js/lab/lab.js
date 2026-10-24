/**
 * 사운드 튜닝 랩: rpm/스로틀 직접 조작, 레이어 솔로/뮤트, 프리셋 실시간 편집 + JSON 복사,
 * 스펙트럼/스펙트로그램/파형, 로컬 레퍼런스 A/B, 같은 시나리오 오프라인 렌더 A/B 비교, 워크렛 CPU 측정.
 */
import { APP_NAME } from '../config.js';
import { PRESETS, getPreset, bankIntervals } from '../presets/presets.js';
import { EngineAudio, volumeToGain } from '../audio/graph.js';
import { renderScenario, audioBufferToWav } from '../audio/offline.js';
import { Vehicle } from '../sim/vehicle.js';
import { DemoRun, SCENARIOS } from '../sim/demo.js';
import { state as appState, effectiveSettings } from '../state.js';

const $ = (s) => document.querySelector(s);
document.querySelectorAll('[data-app-name]').forEach((e) => { e.textContent = APP_NAME; });
document.title = `${APP_NAME} Sound Lab`;

const LAYERS = [
  ['exhaust', '배기'], ['intake', '흡기'], ['mech', '기계음'], ['forced', '과급기'],
  ['trans', '변속기 와인'], ['pops', '팝/크래클'], ['sub', '서브베이스'],
];
const settings = effectiveSettings(appState);
const clone = (o) => JSON.parse(JSON.stringify(o));

let working = clone(getPreset(appState.presetId));
let audio = null;
let driver = 'direct'; // 'direct' | 'vehicle'
let demo = null;
let sweep = null;
const vehicle = new Vehicle(working, { onEvent: (e) => audio && audio.post(e) });
vehicle.setSettings(settings);

const ctl = {
  rpm: 0, thr: 0, load: 0, gear: 1, shiftT: 0, shiftTarget: 0,
  limHeld: false, limCut: false, limT: 0, limDur: 0.04,
};

// ── 프리셋 선택 ──
const sel = $('#presetSel');
for (const p of PRESETS) {
  const o = document.createElement('option');
  o.value = p.id;
  o.textContent = p.name;
  sel.append(o);
}
sel.value = working.id;
sel.addEventListener('change', () => loadPreset(getPreset(sel.value)));

function loadPreset(p) {
  working = clone(p);
  vehicle.setPreset(working);
  ctl.gear = 1;
  $('#gearOut').textContent = '1';
  setupRpmSlider();
  buildEditor();
  if (audio) {
    audio.setPreset(working);
    audio.post({ type: 'gear', gear: 1, ratio: working.gearRatios[0] });
  }
}

/** 편집 중인 프리셋을 워크렛/체인에 즉시 반영 (크로스페이드 없이) */
function applyWorking() {
  vehicle.setPreset(working);
  if (audio) {
    audio.preset = working;
    audio.post({ type: 'preset', preset: working, live: true });
    audio.chain.setPreset(working);
  }
  setupRpmSlider(false);
  paintBankInfo();
}

// ── 오디오 시작 ──
$('#audioBtn').addEventListener('click', async () => {
  if (audio) {
    if (audio.ctx.state === 'running') { await audio.ctx.suspend(); $('#audioBtn').textContent = '오디오 재개'; }
    else { await audio.resume(); $('#audioBtn').textContent = '오디오 일시정지'; }
    return;
  }
  await startAudio();
});

async function startAudio() {
  const a = new EngineAudio();
  await a.init({ preset: working, settings });
  audio = a;
  audio.onMessage = onWorkletMessage;
  audio.post({ type: 'stats', on: true });
  audio.post({ type: 'gear', gear: ctl.gear, ratio: working.gearRatios[ctl.gear - 1] });
  enterDirect();
  if (ctl.rpm === 0) setRpm(working.idleRpm || 0);
  pushLayers();
  $('#audioBtn').textContent = '오디오 일시정지';
  startViz();
}

function onWorkletMessage(m) {
  if (m.type === 'stats') {
    const pill = $('#cpuPill');
    pill.textContent = `CPU ${(m.load * 100).toFixed(1)}% · ${m.avgMs.toFixed(3)}ms/블록 (최대 ${m.maxMs.toFixed(2)}) · 보이스 ${m.voices}`;
    pill.dataset.state = m.load < 0.25 ? 'on' : m.load < 0.5 ? 'warn' : 'error';
  }
}

function enterDirect() {
  if (driver !== 'direct') {
    driver = 'direct';
    demo = null;
    $('#demoBtn').classList.remove('active');
    if (vehicle.rpm > 0) setRpm(vehicle.rpm);
  }
  if (audio) {
    audio.post({ type: 'ignition', on: true });
    audio.post({ type: 'starter', on: false });
  }
}

// ── 직접 조작 ──
const rpmIn = $('#rpm');
const thrIn = $('#thr');
const loadIn = $('#load');
const linkIn = $('#linkLoad');

function setupRpmSlider(resetValue = true) {
  rpmIn.max = String(Math.round((working.limiterRpm || working.redline) + 500));
  if (resetValue) setRpm(working.idleRpm || 0);
}

function setRpm(v) {
  rpmIn.value = String(Math.round(v));
  $('#rpmOut').textContent = `${Math.round(v)} rpm`;
}

rpmIn.addEventListener('input', () => { enterDirect(); sweep = null; setRpm(Number(rpmIn.value)); });
thrIn.addEventListener('input', () => {
  enterDirect();
  $('#thrOut').textContent = `${thrIn.value}%`;
  if (linkIn.checked) { loadIn.value = thrIn.value; $('#loadOut').textContent = `${loadIn.value}%`; }
});
loadIn.addEventListener('input', () => { linkIn.checked = false; $('#loadOut').textContent = `${loadIn.value}%`; });
$('#thrOut').textContent = '0%';
$('#loadOut').textContent = '0%';

$('#gearUp').addEventListener('click', () => shiftTo(ctl.gear + 1));
$('#gearDown').addEventListener('click', () => shiftTo(ctl.gear - 1));

function shiftTo(g) {
  const n = working.gearRatios.length;
  if (g < 1 || g > n || !audio) return;
  enterDirect();
  const r = working.gearRatios;
  const up = g > ctl.gear;
  const newRpm = Number(rpmIn.value) * (r[g - 1] / r[ctl.gear - 1]);
  if (up && settings.crackle > 0 && Number(thrIn.value) > 40) audio.post({ type: 'shiftPop' });
  if (!up && Number(thrIn.value) < 15) audio.post({ type: 'downshift' });
  ctl.shiftT = up ? working.gearbox.upTime : working.gearbox.downTime;
  ctl.shiftTarget = newRpm;
  ctl.gear = g;
  $('#gearOut').textContent = String(g);
  setRpm(Math.min(newRpm, Number(rpmIn.max)));
  audio.post({ type: 'gear', gear: g, ratio: r[g - 1] });
}

$('#liftBtn').addEventListener('click', () => {
  enterDirect();
  thrIn.value = '0';
  thrIn.dispatchEvent(new Event('input'));
  if (audio) audio.post({ type: 'liftoff' });
});
$('#popBtn').addEventListener('click', () => audio && audio.post({ type: 'shiftPop' }));
const limBtn = $('#limBtn');
limBtn.addEventListener('pointerdown', () => { enterDirect(); ctl.limHeld = true; limBtn.classList.add('active'); });
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) {
  limBtn.addEventListener(ev, () => { ctl.limHeld = false; limBtn.classList.remove('active'); });
}

$('#sweepBtn').addEventListener('click', () => {
  enterDirect();
  sweep = { t: 0 };
});

// ── 시동/정지/데모 (시뮬레이터 구동) ──
$('#ignBtn').addEventListener('click', async () => {
  if (!audio) await startAudio();
  driver = 'vehicle';
  demo = null;
  vehicle.setPreset(working);
  vehicle.reset();
  vehicle.start();
});
$('#stopBtn').addEventListener('click', () => {
  if (!audio) return;
  if (driver === 'direct') {
    driver = 'vehicle';
    vehicle.reset();
    vehicle.engine = 'running';
    vehicle.rpm = ctl.rpm;
  }
  demo = null;
  vehicle.stop();
});
$('#demoBtn').addEventListener('click', async () => {
  if (!audio) await startAudio();
  if (demo) { enterDirect(); return; }
  driver = 'vehicle';
  vehicle.setPreset(working);
  vehicle.setSettings(settings);
  vehicle.reset();
  vehicle.start();
  demo = new DemoRun();
  demo.t = -2.6;
  $('#demoBtn').classList.add('active');
});

// ── 전역 설정 ──
const GLOBALS = [['character', '캐릭터'], ['crackle', '팝앤뱅 강도'], ['bass', '저음 강화'], ['space', '공간감'],
  ['response', '가속 반응 감도'], ['shiftStyle', '변속 성향'], ['volume', '볼륨']];
for (const [key, label] of GLOBALS) {
  const l = document.createElement('label');
  const out = document.createElement('output');
  const input = document.createElement('input');
  input.type = 'range';
  input.min = '0';
  input.max = '100';
  input.value = String(Math.round(settings[key] * 100));
  out.textContent = `${input.value}%`;
  input.addEventListener('input', () => {
    settings[key] = Number(input.value) / 100;
    out.textContent = `${input.value}%`;
    vehicle.setSettings(settings);
    if (audio) audio.setSettings(settings);
  });
  l.append(label, out, input);
  $('#globalSliders').append(l);
}

// 흡배기·팝·청취 토글 (음색만 바뀌고 시뮬레이터 계산은 그대로)
const TOGGLES = [
  ['#tglValve', 'valve', 'open', 'closed'], ['#tglIntake', 'intake', 'sport', 'stock'],
  ['#tglPops', 'pops', true, false], ['#tglInterior', 'listen', 'interior', 'exterior'],
];
for (const [sel, key, on, off] of TOGGLES) {
  const cb = $(sel);
  cb.checked = settings[key] === on;
  cb.addEventListener('change', () => {
    settings[key] = cb.checked ? on : off;
    vehicle.setSettings({ crackle: settings.pops ? settings.crackle : 0 });
    if (audio) audio.setSettings(settings);
  });
}

// ── 레이어 솔로/뮤트 ──
const layerState = Object.fromEntries(LAYERS.map(([k]) => [k, { solo: false, mute: false }]));
const table = $('#layerTable');
table.innerHTML = '<tr><td></td><td>솔로</td><td>뮤트</td></tr>';
for (const [key, label] of LAYERS) {
  const tr = document.createElement('tr');
  const name = document.createElement('td');
  name.textContent = label;
  tr.append(name);
  for (const kind of ['solo', 'mute']) {
    const td = document.createElement('td');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.addEventListener('change', () => { layerState[key][kind] = cb.checked; pushLayers(); });
    td.append(cb);
    tr.append(td);
  }
  table.append(tr);
}

function currentLayers() {
  const anySolo = Object.values(layerState).some((s) => s.solo);
  return Object.fromEntries(Object.entries(layerState).map(([k, s]) => [k, (anySolo ? s.solo : true) && !s.mute ? 1 : 0]));
}

function pushLayers() {
  if (audio) audio.post({ type: 'layers', layers: currentLayers() });
}

// ── 파라미터 편집기 ──
const RANGES = {
  idleRpm: [0, 5000, 10], redline: [3000, 16000, 50], limiterRpm: [3000, 17000, 50], launchRpm: [0, 8000, 50],
  rpmTauUp: [0.01, 0.4, 0.005], rpmTauDown: [0.01, 0.5, 0.005], finalDrive: [1, 10, 0.01], tireDiameter: [0.5, 0.9, 0.005],
  bounceBeforeShift: [0, 0.5, 0.01],
  'gearbox.upTime': [0, 0.6, 0.005], 'gearbox.downTime': [0, 0.6, 0.005], 'gearbox.cutRetain': [0, 1, 0.01], 'gearbox.lugRpm': [500, 4000, 10],
  'exhaust.valveRange': [0, 1, 0.01], 'pops.amount': [0, 1.5, 0.01], 'pops.big': [0, 1.5, 0.01], 'pops.minRpm': [0, 1, 0.01],
  maxAccel: [1, 12, 0.1], valves: [0, 64, 1], polePairs: [1, 8, 1], lope: [0, 1.5, 0.01], jitter: [0, 1.5, 0.01],
  misfireProb: [0, 0.1, 0.001], outGain: [0, 3, 0.01],
  'exhaust.headerLen': [0.1, 1.5, 0.01], 'exhaust.tailLen': [0.1, 1.2, 0.01], 'exhaust.feedback': [-0.95, 0, 0.01],
  'exhaust.mufflerCutoffMin': [100, 5000, 10], 'exhaust.mufflerCutoffMax': [1000, 16000, 50], 'exhaust.xPipe': [0, 1, 0.01],
  'pulse.attackMs': [0.05, 2, 0.01], 'pulse.decayMs': [0.5, 12, 0.05], 'pulse.noiseAmt': [0, 1.5, 0.01],
  'intake.centerMin': [100, 3000, 10], 'intake.centerMax': [300, 6000, 10], 'intake.resHz': [80, 1500, 5],
  'mech.tickHz': [500, 8000, 10], 'eq.bodyResHz': [60, 400, 1], 'eq.presenceDb': [-6, 9, 0.1],
  'forced.lag': [0.1, 3, 0.01], 'forced.fMin': [500, 12000, 50], 'forced.fMax': [1000, 16000, 50], 'forced.ratio': [1, 40, 0.1],
};
const SKIP = new Set(['id', 'name', 'fullName', 'description', 'image', 'credit', 'type', 'layout', 'firingOrder', 'cylinders',
  'soundMethod', 'specs', 'tuning']);
const FORCED_DEFAULTS = {
  turbo: { type: 'turbo', lag: 0.8, fMin: 3000, fMax: 8000, bov: 'bov' },
  super: { type: 'super', ratio: 20 },
};

function rangeFor(path, v) {
  if (RANGES[path]) return RANGES[path];
  if (path.startsWith('mix.')) return [0, 1, 0.005];
  const max = Math.max(1, Math.abs(v) * 3);
  return [Math.min(0, v * 3), max, max / 200];
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
  o[keys[keys.length - 1]] = value;
}

function numberField(path, value) {
  const [min, max, step] = rangeFor(path, value);
  const label = document.createElement('label');
  label.textContent = path.split('.').pop();
  const pair = document.createElement('div');
  pair.className = 'pair';
  const range = document.createElement('input');
  range.type = 'range';
  Object.assign(range, { min, max, step, value });
  const num = document.createElement('input');
  num.type = 'number';
  Object.assign(num, { step, value });
  const commit = (v) => {
    if (!Number.isFinite(v)) return;
    setPath(working, path, v);
    applyWorking();
  };
  range.addEventListener('input', () => { num.value = range.value; commit(Number(range.value)); });
  num.addEventListener('change', () => { range.value = num.value; commit(Number(num.value)); });
  pair.append(range, num);
  label.append(pair);
  return label;
}

function arrayField(path, arr) {
  const label = document.createElement('label');
  label.textContent = `${path.split('.').pop()} (쉼표 구분)`;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = arr.join(', ');
  input.addEventListener('change', () => {
    const vals = input.value.split(',').map((s) => Number(s.trim())).filter((x) => Number.isFinite(x));
    if (!vals.length) return;
    setPath(working, path, vals);
    if (path === 'firingAngles') {
      working.cylinders = vals.length;
      if (working.bankOf.length !== vals.length) working.bankOf = vals.map((_, i) => working.bankOf[i] ?? 0);
    }
    if (path === 'bankOf' && vals.length !== working.firingAngles.length) return;
    applyWorking();
    if (path === 'firingAngles') buildEditor();
  });
  label.append(input);
  return label;
}

function forcedField() {
  const label = document.createElement('label');
  label.textContent = '과급기 종류';
  const s = document.createElement('select');
  for (const [v, t] of [['none', '없음 (자연흡기)'], ['turbo', '터보'], ['super', '수퍼차저']]) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = t;
    s.append(o);
  }
  s.value = working.forced ? working.forced.type : 'none';
  s.addEventListener('change', () => {
    working.forced = s.value === 'none' ? null : clone(FORCED_DEFAULTS[s.value]);
    if (working.forced && !working.mix.forced) working.mix.forced = 0.08;
    applyWorking();
    buildEditor();
  });
  label.append(s);
  return label;
}

function buildEditor() {
  const root = $('#paramEditor');
  root.replaceChildren();
  const groups = new Map();
  for (const [k, v] of Object.entries(working)) {
    if (SKIP.has(k)) continue;
    if (k === 'forced') {
      const fs = document.createElement('fieldset');
      const lg = document.createElement('legend');
      lg.textContent = 'forced';
      fs.append(lg, forcedField());
      if (v) {
        for (const [fk, fv] of Object.entries(v)) {
          if (typeof fv === 'number') fs.append(numberField(`forced.${fk}`, fv));
          if (fk === 'bov') fs.append(bovField(fv));
        }
      }
      groups.set(k, fs);
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      const fs = document.createElement('fieldset');
      const lg = document.createElement('legend');
      lg.textContent = k;
      fs.append(lg);
      for (const [sk, sv] of Object.entries(v)) {
        if (typeof sv === 'number') fs.append(numberField(`${k}.${sk}`, sv));
        else if (Array.isArray(sv)) fs.append(arrayField(`${k}.${sk}`, sv));
      }
      groups.set(k, fs);
    } else if (Array.isArray(v)) {
      root.append(arrayField(k, v));
    } else if (typeof v === 'number') {
      root.append(numberField(k, v));
    } else if (typeof v === 'boolean') {
      const l = document.createElement('label');
      l.className = 'check';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = v;
      cb.addEventListener('change', () => { working[k] = cb.checked; applyWorking(); });
      l.append(cb, k);
      root.append(l);
    }
  }
  for (const fs of groups.values()) root.append(fs);
  paintBankInfo();
}

function bovField(v) {
  const label = document.createElement('label');
  label.textContent = 'bov';
  const s = document.createElement('select');
  for (const opt of ['bov', 'flutter', 'none']) {
    const o = document.createElement('option');
    o.value = opt;
    o.textContent = opt;
    s.append(o);
  }
  s.value = v;
  s.addEventListener('change', () => { working.forced.bov = s.value; applyWorking(); });
  label.append(s);
  return label;
}

function paintBankInfo() {
  const el = $('#bankInfo');
  if (working.type === 'ev' || !working.firingAngles.length) { el.textContent = ''; return; }
  const L = bankIntervals(working, 0);
  const R = bankIntervals(working, 1);
  el.textContent = `뱅크별 점화 간격(°) — L: [${L.join(', ')}]${R.length ? `  R: [${R.join(', ')}]` : ''}`;
}

$('#copyBtn').addEventListener('click', async () => {
  const text = JSON.stringify(working, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    $('#copyMsg').textContent = '복사됨 — presets.js의 해당 프리셋에 붙여넣으세요';
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    $('#copyMsg').textContent = '복사됨';
  }
  setTimeout(() => { $('#copyMsg').textContent = ''; }, 3000);
});
$('#resetBtn').addEventListener('click', () => loadPreset(getPreset(working.id)));

// ── 시나리오 A/B: 같은 입력 타임라인을 오프라인 렌더해 동기 재생 ──
const scenarioSel = $('#scenarioSel');
for (const sc of SCENARIOS) {
  const o = document.createElement('option');
  o.value = sc.id;
  o.textContent = sc.label;
  scenarioSel.append(o);
}
const abSlots = { A: null, B: null };
let abSources = null;
let abListen = 'A';
let abGains = null;

async function renderSlot(slot) {
  const btn = $(`#render${slot}`);
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = '렌더링 중…';
  try {
    stopAB();
    const snapshot = { preset: clone(working), settings: { ...settings }, scenario: scenarioSel.value };
    const buffer = await renderScenario(snapshot.scenario, snapshot.preset, snapshot.settings, { layers: currentLayers() });
    abSlots[slot] = { ...snapshot, buffer };
    const url = URL.createObjectURL(audioBufferToWav(buffer));
    const link = $(`#wav${slot}`);
    link.href = url;
    link.download = `${snapshot.preset.id}-${snapshot.scenario}-${slot}.wav`;
    link.hidden = false;
    paintABInfo();
  } catch (e) {
    console.error(e);
    $('#abInfo').textContent = `렌더 실패: ${e.message}`;
  }
  btn.textContent = label;
  btn.disabled = false;
}

function paintABInfo() {
  const desc = (s) => (s ? `${s.preset.name} · ${s.scenario} · 밸브 ${s.settings.valve} · 흡기 ${s.settings.intake} · ${s.buffer.duration.toFixed(1)}초` : '—');
  $('#abInfo').textContent = `A: ${desc(abSlots.A)}  /  B: ${desc(abSlots.B)}`;
  const ready = abSlots.A || abSlots.B;
  $('#abPlay').disabled = !ready;
  $('#abSwitch').disabled = !(abSlots.A && abSlots.B);
  if (abSlots.A && abSlots.B && abSlots.A.scenario !== abSlots.B.scenario) $('#abInfo').textContent += '  ⚠ 시나리오가 다릅니다';
}

function stopAB() {
  if (abSources) for (const s of abSources) { try { s.stop(); } catch { /* 이미 정지 */ } }
  abSources = null;
  $('#abPlay').textContent = '▶ 재생';
}

function setABListen(slot) {
  abListen = slot;
  $('#abSwitch').textContent = `듣는 중: ${slot}`;
  if (abGains && audio) {
    const t = audio.ctx.currentTime;
    abGains.A.gain.setTargetAtTime(slot === 'A' ? 1 : 0, t, 0.005);
    abGains.B.gain.setTargetAtTime(slot === 'B' ? 1 : 0, t, 0.005);
  }
}

$('#renderA').addEventListener('click', () => renderSlot('A'));
$('#renderB').addEventListener('click', () => renderSlot('B'));
$('#abPlay').addEventListener('click', async () => {
  if (abSources) { stopAB(); return; }
  if (!audio) await startAudio();
  const ctx = audio.ctx;
  if (!abGains) {
    abGains = { A: ctx.createGain(), B: ctx.createGain() };
    abGains.A.connect(ctx.destination);
    abGains.B.connect(ctx.destination);
  }
  audio.master.gain.setTargetAtTime(0, ctx.currentTime, 0.01); // 실시간 합성음은 잠시 끈다
  const when = ctx.currentTime + 0.05;
  abSources = [];
  for (const slot of ['A', 'B']) {
    if (!abSlots[slot]) continue;
    const src = ctx.createBufferSource();
    src.buffer = abSlots[slot].buffer;
    src.connect(abGains[slot]);
    src.start(when);
    src.onended = () => { if (abSources && abSources[0] === src) { stopAB(); audio.master.gain.setTargetAtTime(1, ctx.currentTime, 0.05); } };
    abSources.push(src);
  }
  setABListen(abSlots[abListen] ? abListen : abSlots.A ? 'A' : 'B');
  $('#abPlay').textContent = '■ 정지';
});
$('#abSwitch').addEventListener('click', () => setABListen(abListen === 'A' ? 'B' : 'A'));
window.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, select, textarea') || !abSources) return;
  if (e.code === 'KeyA' && abSlots.A) setABListen('A');
  if (e.code === 'KeyB' && abSlots.B) setABListen('B');
});

// ── 레퍼런스 A/B ──
let refBuffer = null;
let refSrc = null;
let refGain = null;
let refAnalyser = null;
let refLevel = 1;
let ab = 'synth';
let synthRms = 0;

$('#refFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!audio) await startAudio();
  refBuffer = await audio.ctx.decodeAudioData(await file.arrayBuffer());
  if (!refGain) {
    refGain = audio.ctx.createGain();
    refGain.gain.value = 0;
    refAnalyser = audio.ctx.createAnalyser();
    refAnalyser.fftSize = 4096;
    refAnalyser.smoothingTimeConstant = 0.6;
    refGain.connect(refAnalyser);
    refAnalyser.connect(audio.ctx.destination);
  }
  $('#refInfo').textContent = `${file.name} · ${refBuffer.duration.toFixed(1)}초 · RMS ${(20 * Math.log10(bufferRms(refBuffer))).toFixed(1)} dBFS`;
  for (const id of ['#refPlay', '#abBtn', '#matchBtn']) $(id).disabled = false;
});

function bufferRms(buf) {
  let s = 0;
  let n = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i += 4) { s += d[i] * d[i]; n++; }
  }
  return Math.sqrt(s / Math.max(1, n));
}

$('#refPlay').addEventListener('click', () => {
  if (refSrc) {
    refSrc.stop();
    refSrc = null;
    $('#refPlay').textContent = '레퍼런스 재생';
    return;
  }
  refSrc = audio.ctx.createBufferSource();
  refSrc.buffer = refBuffer;
  refSrc.loop = true;
  refSrc.connect(refGain);
  refSrc.start();
  $('#refPlay').textContent = '레퍼런스 정지';
  setAB(ab);
});

function setAB(mode) {
  ab = mode;
  const t = audio.ctx.currentTime;
  audio.master.gain.setTargetAtTime(mode === 'synth' ? 1 : 0, t, 0.01);
  if (refGain) refGain.gain.setTargetAtTime(mode === 'ref' ? refLevel * volumeToGain(settings.volume) : 0, t, 0.01);
  $('#abBtn').textContent = mode === 'synth' ? 'A/B: 합성음' : 'A/B: 레퍼런스';
}
$('#abBtn').addEventListener('click', () => setAB(ab === 'synth' ? 'ref' : 'synth'));
$('#matchBtn').addEventListener('click', () => {
  const r = bufferRms(refBuffer);
  if (r > 0 && synthRms > 0) refLevel = synthRms / volumeToGain(settings.volume) / r;
  $('#matchBtn').textContent = `레벨 맞춤 (×${refLevel.toFixed(2)})`;
  setAB(ab);
});

// ── 시각화 ──
const FMIN = 30;
const FMAX = 12000;
let freqBuf = null;
let timeBuf = null;

function colorMap(v) {
  // v: 0..1 → 검정-보라-주황-노랑
  const r = Math.min(255, Math.max(0, 255 * Math.min(1, v * 1.8)));
  const g = Math.min(255, Math.max(0, 255 * (v - 0.45) * 1.9));
  const b = Math.min(255, Math.max(0, 255 * (v < 0.4 ? v * 1.6 : (0.8 - v) * 1.6)));
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

function logBin(analyser, frac) {
  const f = FMIN * Math.pow(FMAX / FMIN, frac);
  return Math.min(analyser.frequencyBinCount - 1, Math.round((f / (audio.ctx.sampleRate / 2)) * analyser.frequencyBinCount));
}

function drawSpectrogram(canvas, analyser) {
  const c = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  c.drawImage(canvas, -2, 0);
  c.fillStyle = '#07090b';
  c.fillRect(W - 2, 0, 2, H);
  if (!analyser) return;
  analyser.getFloatFrequencyData(freqBuf);
  for (let y = 0; y < H; y += 2) {
    const v = (freqBuf[logBin(analyser, 1 - y / H)] + 100) / 80;
    if (v <= 0.02) continue;
    c.fillStyle = colorMap(Math.min(1, v));
    c.fillRect(W - 2, y, 2, 2);
  }
}

function drawSpectrum() {
  const cv = $('#spectrum');
  const c = cv.getContext('2d');
  const W = cv.width;
  const H = cv.height;
  c.fillStyle = '#07090b';
  c.fillRect(0, 0, W, H);
  c.strokeStyle = '#222a33';
  c.fillStyle = '#5a6370';
  c.font = '11px sans-serif';
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    const x = (Math.log(f / FMIN) / Math.log(FMAX / FMIN)) * W;
    c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke();
    c.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x + 3, H - 4);
  }
  const draw = (an, color) => {
    if (!an) return;
    an.getFloatFrequencyData(freqBuf);
    c.strokeStyle = color;
    c.lineWidth = 1.5;
    c.beginPath();
    for (let x = 0; x < W; x += 2) {
      const v = (freqBuf[logBin(an, x / W)] + 100) / 90;
      const y = H - Math.max(0, Math.min(1, v)) * H;
      if (x === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.stroke();
  };
  draw(audio.analyser, '#ffb03a');
  if (refSrc) draw(refAnalyser, '#4aa3ff');
}

function drawWave() {
  const cv = $('#wave');
  const c = cv.getContext('2d');
  const W = cv.width;
  const H = cv.height;
  audio.analyser.getFloatTimeDomainData(timeBuf);
  let s = 0;
  for (let i = 0; i < timeBuf.length; i++) s += timeBuf[i] * timeBuf[i];
  const r = Math.sqrt(s / timeBuf.length);
  synthRms = synthRms * 0.95 + r * 0.05;
  c.fillStyle = '#07090b';
  c.fillRect(0, 0, W, H);
  c.strokeStyle = '#35d07f';
  c.beginPath();
  const step = timeBuf.length / W;
  for (let x = 0; x < W; x++) {
    const y = H / 2 - timeBuf[Math.floor(x * step)] * H * 0.48;
    if (x === 0) c.moveTo(x, y); else c.lineTo(x, y);
  }
  c.stroke();
  c.fillStyle = '#8b95a3';
  c.fillText(`RMS ${(20 * Math.log10(Math.max(r, 1e-6))).toFixed(1)} dBFS`, 8, 14);
}

function startViz() {
  freqBuf = new Float32Array(audio.analyser.frequencyBinCount);
  timeBuf = new Float32Array(audio.analyser.fftSize);
}

// ── 루프 ──
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (audio && dt > 0) {
    let s;
    if (driver === 'vehicle') {
      let input = { mode: 'test', gas: null, brake: null, rev: 0 };
      if (demo) {
        if (demo.t < 0) demo.t += dt;
        else input = { mode: 'test', ...demo.step(dt) };
        if (demo.done) { demo = null; $('#demoBtn').classList.remove('active'); }
      }
      s = vehicle.update(dt, input);
      ctl.rpm = s.rpm;
      setRpm(s.rpm);
      $('#gearOut').textContent = s.gearLabel;
    } else {
      s = directStep(dt);
    }
    audio.setParams(s);
    drawSpectrum();
    drawSpectrogram($('#specSynth'), audio.analyser);
    drawSpectrogram($('#specRef'), refSrc ? refAnalyser : null);
    drawWave();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function directStep(dt) {
  const P = working;
  if (sweep) {
    sweep.t += dt;
    const idle = P.idleRpm || 0;
    if (sweep.t < 6) {
      setRpm(idle + (P.redline - idle) * (sweep.t / 6));
      thrIn.value = '100';
    } else if (sweep.t < 10) {
      setRpm(P.redline - (P.redline - idle) * ((sweep.t - 6) / 4));
      thrIn.value = '0';
    } else {
      sweep = null;
      setRpm(idle);
    }
    thrIn.dispatchEvent(new Event('input'));
  }
  let target = ctl.limHeld ? (P.limiterRpm || P.redline) + 400 : Number(rpmIn.value);
  let fuelCut = false;
  let tau = target > ctl.rpm ? P.rpmTauUp : P.rpmTauDown;
  if (ctl.shiftT > 0) {
    ctl.shiftT -= dt;
    fuelCut = true;
    target = ctl.shiftTarget;
    tau = Math.max(P.gearbox.upTime / 2.5, 0.02);
  }
  if (P.type !== 'ev' && P.limiterRpm) {
    if (ctl.limCut) {
      ctl.limT += dt;
      target = Math.min(target, P.limiterRpm - 380);
      tau = P.rpmTauDown * 0.6;
      if (ctl.limT >= ctl.limDur) ctl.limCut = false;
    } else if (ctl.rpm >= P.limiterRpm) {
      ctl.limCut = true;
      ctl.limT = 0;
      ctl.limDur = 0.03 + Math.random() * 0.03;
      audio.post({ type: 'limiterCut' });
    }
    fuelCut = fuelCut || ctl.limCut;
  }
  ctl.rpm += (target - ctl.rpm) * (1 - Math.exp(-dt / Math.max(tau, 1e-3)));
  const thr = Number(thrIn.value) / 100;
  const loadT = fuelCut ? 0 : (linkIn.checked ? thr : Number(loadIn.value) / 100);
  ctl.load += (loadT - ctl.load) * (1 - Math.exp(-dt / (loadT > ctl.load ? 0.05 : 0.3)));
  ctl.thr = thr;
  $('#rpmOut').textContent = `${Math.round(ctl.rpm)} rpm`;
  const overrun = thr < 0.05 && P.type !== 'ev' && ctl.rpm > (P.idleRpm || 0) * 1.3 ? 1 : 0;
  return { rpm: ctl.rpm, throttle: thr, load: ctl.load, fuelCut, overrun };
}

setupRpmSlider();
buildEditor();
