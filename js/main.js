/**
 * 앱 부트스트랩: 입력(GPS/페달/데모/REV/변속) → 차량 시뮬 → 오디오 워크렛 + 계기판, 60Hz 루프.
 */
import { APP_NAME, APP_TAGLINE } from './config.js';
import { state, setState, carTuning, setTuning, resetTuning, hasCustomTuning, effectiveSettings } from './state.js';
import { PRESETS, getPreset } from './presets/presets.js';
import { TESLA_MODELS, REGEN, AUDIO_SYSTEMS, getTesla } from './presets/tesla.js';
import { Vehicle, SHIFT_REASON } from './sim/vehicle.js';
import { DemoRun } from './sim/demo.js';
import { GpsSource } from './input/gps.js';
import { Pedals } from './input/testdrive.js';
import { ShiftInput } from './input/shift.js';
import { EngineAudio } from './audio/graph.js';
import { Gauge } from './ui/gauge.js';
import { renderCarGrid, markSelected, renderBanner, renderCredit, renderDashCar } from './ui/cars.js';
import { buildSliders, setSliderValues, buildSliderHelp, bindSegment, bindHold } from './ui/controls.js';
import { runCompatChecks } from './ui/compat.js';

const $ = (sel) => document.querySelector(sel);
const UNIT = { kmh: { label: 'km/h', k: 3.6 }, mph: { label: 'mph', k: 2.236936 } };
const BLIP_S = 0.22;

// ── 정적 텍스트 ──
document.title = `${APP_NAME} — ${APP_TAGLINE}`;
document.querySelectorAll('[data-app-name]').forEach((e) => { e.textContent = APP_NAME; });
document.querySelectorAll('[data-app-tagline]').forEach((e) => { e.textContent = APP_TAGLINE; });

// ── 상태 ──
let preset = getPreset(state.presetId);
let audio = null;
let starting = false;
let demo = null;
let revHeld = false;
let revVal = 0;
let blipT = 0;
let muted = false;
let wakeLock = null;
let gpsStale = false;

const els = {
  start: $('#startBtn'),
  mute: $('#muteBtn'),
  pillGps: $('#pillGps'),
  pillEngine: $('#pillEngine'),
  pedals: $('#pedalArea'),
  revArea: $('#revArea'),
  rev: $('#revBtn'),
  blip: $('#blipBtn'),
  demo: $('#demoBtn'),
  throttle: $('#throttleBar'),
  notice: $('#notice'),
  grid: $('#carGrid'),
  banner: $('#banner'),
  credit: $('[data-banner-credit]'),
  dashCar: $('#dashCar'),
  badge: $('#driveBadge'),
  toast: $('#toast'),
  styleSeg: $('#styleSeg'),
  shiftBtns: $('#shiftBtns'),
  shiftHint: $('#shiftHint'),
  shiftDown: $('#shiftDown'),
  shiftUp: $('#shiftUp'),
  wheelStatus: $('#wheelStatus'),
  tuningFor: $('#tuningFor'),
  tuningState: $('#tuningState'),
};

const gauge = new Gauge($('#gauge'));
gauge.setPreset(preset);

const vehicle = new Vehicle(preset, { onEvent: onVehicleEvent });

const gps = new GpsSource({ onStatus: paintGps });
const pedals = new Pedals($('#pedalGas'), $('#pedalBrake'), {
  onTouch: () => { if (demo) stopDemo(); },
});

/** 설정 → 시뮬레이터/오디오. 흡배기·청취 설정은 오디오에만 영향을 준다. */
function applySettings() {
  const eff = effectiveSettings();
  vehicle.setSettings({
    response: eff.response,
    shiftStyle: eff.shiftStyle,
    crackle: eff.pops ? eff.crackle : 0,
    driveMode: eff.driveMode,
    autoStyle: eff.autoStyle,
    teslaId: eff.teslaId,
    regen: eff.regen,
  });
  if (audio) audio.setSettings(eff);
}
applySettings();

// ── 차량 선택 ──
renderCarGrid(els.grid, PRESETS, preset.id, selectPreset);
paintCar();

function paintCar() {
  renderBanner(els.banner, preset);
  renderCredit(els.credit, preset);
  renderDashCar(els.dashCar, preset);
  els.tuningFor.textContent = `— ${preset.name} 기준, 차량별로 저장`;
  paintDrive();
}

function selectPreset(id) {
  if (id === preset.id) return;
  preset = getPreset(id);
  setState({ presetId: id });
  markSelected(els.grid, id);
  paintCar();
  gauge.setPreset(preset);
  const wasOn = vehicle.engine !== 'off';
  const speed = vehicle.speed;
  vehicle.setPreset(preset);
  vehicle.speed = speed;
  setSliderValues(sliders, { ...carTuning(), volume: state.volume });
  paintTuningState();
  applySettings();
  if (audio) audio.setPreset(preset);
  shiftInput.setMetadata({ title: preset.fullName });
  if (wasOn && preset.type === 'ev') vehicle.engine = 'running';
}

// ── 튜닝 슬라이더 (볼륨은 전역, 나머지는 차량별) ──
const sliders = buildSliders($('#sliders'), { ...carTuning(), volume: state.volume }, (key, v) => {
  if (key === 'volume') setState({ volume: v });
  else setTuning(preset.id, key, v);
  paintTuningState();
  applySettings();
});
buildSliderHelp($('#sliderHelp'));

function paintTuningState() {
  els.tuningState.textContent = hasCustomTuning() ? '사용자 설정 저장됨' : '차량 기본값';
}
paintTuningState();

$('#resetTuning').addEventListener('click', () => {
  resetTuning(preset.id);
  setSliderValues(sliders, carTuning());
  paintTuningState();
  applySettings();
  toast('차량 기본값으로 복원했습니다');
});

// ── 변속 모드 / 흡배기 / 청취 ──
bindSegment($('#driveSeg'), state.driveMode, (driveMode) => {
  setState({ driveMode });
  applySettings();
  paintDrive();
});
bindSegment(els.styleSeg, state.autoStyle, (autoStyle) => {
  setState({ autoStyle });
  applySettings();
  paintDrive();
});
bindSegment($('#intakeSeg'), state.intake, (intake) => { setState({ intake }); applySettings(); });
bindSegment($('#valveSeg'), state.valve, (valve) => { setState({ valve }); applySettings(); });
bindSegment($('#popsSeg'), state.pops ? 'on' : 'off', (v) => { setState({ pops: v === 'on' }); applySettings(); });
bindSegment($('#listenSeg'), state.listen, (listen) => { setState({ listen }); applySettings(); });

function paintDrive() {
  const manual = state.driveMode === 'manual';
  const ev = preset.type === 'ev';
  els.styleSeg.hidden = manual || ev;
  els.shiftBtns.hidden = !manual || ev;
  els.shiftHint.hidden = !manual || ev;
  els.badge.textContent = ev ? 'EV' : manual ? 'MANUAL' : `AUTO · ${state.autoStyle === 'sport' ? 'S' : 'C'}`;
  els.badge.dataset.mode = ev ? 'ev' : manual ? 'manual' : state.autoStyle;
}

// ── 변속 입력: 화면 − / +, Q / E, 미디어 키, 미디어 세션(휠) ──
const shiftInput = new ShiftInput({
  onShift: (dir, source) => {
    if (preset.type === 'ev') return;
    if (state.driveMode !== 'manual') {
      if (source !== 'mediasession') toast('MANUAL 모드에서 변속할 수 있습니다');
      return;
    }
    const res = vehicle.requestShift(dir);
    const btn = dir > 0 ? els.shiftUp : els.shiftDown;
    btn.classList.remove('flash', 'deny');
    void btn.offsetWidth; // 애니메이션 재시작
    btn.classList.add(res.ok ? 'flash' : 'deny');
    if (!res.ok && res.reason !== 'stopped') toast(SHIFT_REASON[res.reason] || res.reason);
  },
  onDetect: paintWheel,
});
shiftInput.bindButtons(els.shiftDown, els.shiftUp);

function paintWheel() {
  const el = els.wheelStatus;
  const d = shiftInput.detected;
  if (!shiftInput.sessionSupported) {
    el.textContent = '이 브라우저는 미디어 세션을 지원하지 않습니다 — 화면 − / + 또는 Q / E 사용';
    el.dataset.state = 'fail';
  } else if (d) {
    const ago = Math.max(0, Math.round((Date.now() - d.at) / 1000));
    el.textContent = `감지됨: ${d.source === 'mediakey' ? '미디어 키' : '미디어 세션'} "${d.action}" (${ago}초 전)`;
    el.dataset.state = 'ok';
  } else {
    el.textContent = audio ? '대기 중: 휠의 다음/이전 곡 동작을 눌러 보세요' : '시동을 걸면 휠 입력 감지를 시작합니다';
    el.dataset.state = 'warn';
  }
}
paintWheel();
setInterval(() => { if (shiftInput.detected) paintWheel(); }, 5000);

// ── 탑승 차량 보정 ──
function fillSelect(sel, items, value, onChange) {
  sel.replaceChildren(...items.map(([v, label]) => {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    return o;
  }));
  sel.value = value;
  sel.addEventListener('change', () => onChange(sel.value));
}
fillSelect($('#teslaSel'), TESLA_MODELS.map((m) => [m.id, m.name]), state.teslaId, (teslaId) => {
  setState({ teslaId });
  applySettings();
  paintAudioOption();
});
fillSelect($('#regenSel'), Object.entries(REGEN).map(([k, r]) => [k, r.label]), state.regen, (regen) => {
  setState({ regen });
  applySettings();
});
const audioSel = $('#audioSel');
fillSelect(audioSel, [['auto', ''], ...Object.entries(AUDIO_SYSTEMS).map(([k, a]) => [k, a.label])], state.audioSystem, (audioSystem) => {
  setState({ audioSystem });
  applySettings();
});
function paintAudioOption() {
  audioSel.options[0].textContent = `모델 기본 (${AUDIO_SYSTEMS[getTesla(state.teslaId).audio].label})`;
}
paintAudioOption();

// ── 속도 소스 / 단위 / 샘플 / 패널 ──
bindSegment($('#modeSeg'), state.mode, (mode) => {
  setState({ mode });
  if (demo) stopDemo();
  applyMode();
});
bindSegment($('#unitSeg'), state.unit, (unit) => setState({ unit }));

const sampleToggle = $('#sampleToggle');
sampleToggle.checked = state.sampleMode;
sampleToggle.addEventListener('change', async () => {
  setState({ sampleMode: sampleToggle.checked });
  if (audio) {
    const ok = await audio.enableSamples(sampleToggle.checked);
    if (sampleToggle.checked && !ok) showNotice('이 차량에는 샘플 파일이 없어 합성 모드로 재생합니다. (README의 샘플 모드 참고)', 'info');
  }
});

const settingsBtn = $('#settingsBtn');
settingsBtn.addEventListener('click', () => {
  const panel = $('#settingsPanel');
  panel.hidden = !panel.hidden;
  settingsBtn.setAttribute('aria-expanded', String(!panel.hidden));
  settingsBtn.textContent = panel.hidden ? '상세 설정 ▾' : '상세 설정 ▴';
});

function applyMode() {
  const isGps = state.mode === 'gps';
  els.pedals.hidden = isGps;
  els.demo.hidden = isGps;
  if (isGps) gps.start();
  else {
    gps.stop();
    vehicle.speed = 0;
  }
  paintGps({ status: gps.status, accuracy: gps.accuracy });
}

// ── 음소거 ──
els.mute.addEventListener('click', () => {
  muted = !muted;
  els.mute.setAttribute('aria-pressed', String(muted));
  els.mute.textContent = muted ? '🔇' : '🔊';
  if (audio) audio.setMuted(muted);
});

// ── REV(길게) / BLIP(짧게) / 스페이스바 ──
bindHold(els.rev, () => { revHeld = true; }, () => { revHeld = false; });
els.blip.addEventListener('pointerdown', (e) => { e.preventDefault(); blipT = BLIP_S; });
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.target.closest?.('input, select, textarea, button')) { e.preventDefault(); revHeld = true; }
});
window.addEventListener('keyup', (e) => { if (e.code === 'Space') revHeld = false; });

// ── 시동 ──
els.start.addEventListener('click', toggleEngine);

async function toggleEngine() {
  if (starting) return;
  if (vehicle.engine === 'off' || vehicle.engine === 'stopping') {
    starting = true;
    // 미디어 세션(휠 연동)도 같은 사용자 제스처 안에서 시작해야 한다
    const session = shiftInput.enableMediaSession({ title: preset.fullName });
    try {
      if (!audio) {
        const a = new EngineAudio();
        a.onMessage = () => {};
        await a.init({ preset, settings: effectiveSettings() });
        audio = a;
        audio.setMuted(muted);
        if (state.sampleMode) audio.enableSamples(true);
      } else {
        await audio.resume();
      }
    } catch (err) {
      console.error(err);
      showNotice(`오디오를 시작할 수 없습니다: ${err.message}. 아래 호환성 체크를 확인하세요.`, 'error');
      starting = false;
      return;
    }
    starting = false;
    session.then(paintWheel);
    vehicle.start();
    acquireWakeLock();
    if (state.mode === 'gps') gps.start();
  } else {
    if (demo) stopDemo();
    vehicle.stop();
    releaseWakeLock();
  }
  paintEngine();
}

function onVehicleEvent(e) {
  if (audio) audio.post(e);
}

// ── 데모 런 ──
els.demo.addEventListener('click', async () => {
  if (demo) { stopDemo(); return; }
  if (state.mode !== 'test') return;
  if (vehicle.engine === 'off') {
    await toggleEngine();
    if (vehicle.engine === 'off') return;
  }
  vehicle.speed = 0;
  demo = new DemoRun();
  if (vehicle.engine === 'cranking' || vehicle.engine === 'starting') demo.t = -2.2; // 시동이 안착할 때까지 대기
  els.demo.textContent = '■ 데모 정지';
  els.demo.classList.add('active');
});

function stopDemo() {
  demo = null;
  els.demo.textContent = '▶ 데모 런';
  els.demo.classList.remove('active');
  pedals.show(null, null);
}

// ── 상태 표시 ──
let toastTimer = 0;
function toast(text) {
  els.toast.textContent = text;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 1600);
}

function paintEngine() {
  const on = vehicle.engine !== 'off';
  const label = { off: '엔진 꺼짐', cranking: '시동 중…', starting: '엔진 켜짐', running: '엔진 켜짐', stopping: '정지 중…' }[vehicle.engine];
  els.pillEngine.textContent = preset.type === 'ev' && on ? '모터 켜짐' : label;
  els.pillEngine.dataset.state = on ? 'on' : 'off';
  els.start.textContent = on && vehicle.engine !== 'stopping' ? 'STOP ENGINE' : 'START ENGINE';
  els.start.classList.toggle('running', on && vehicle.engine !== 'stopping');
  if (!on) shiftInput.disableMediaSession();
}

function paintGps({ status, accuracy }) {
  const pill = els.pillGps;
  if (state.mode !== 'gps') {
    pill.textContent = 'Test drive';
    pill.dataset.state = 'idle';
    return;
  }
  const text = {
    off: 'GPS 꺼짐',
    waiting: 'GPS 대기 중',
    ok: gpsStale ? 'GPS 신호 끊김 (정속 유지)' : `GPS 정상${accuracy != null ? ` (±${Math.round(accuracy)}m)` : ''}`,
    denied: '위치 권한 거부',
    unavailable: 'GPS 사용 불가',
  }[status] || status;
  pill.textContent = text;
  pill.dataset.state = status === 'ok' ? (gpsStale || accuracy > 30 ? 'warn' : 'on') : status === 'waiting' ? 'warn' : status === 'off' ? 'idle' : 'error';
  if (status === 'denied') {
    showNotice('위치 권한이 거부되었습니다. 브라우저 사이트 설정에서 위치를 허용하거나 Test drive로 체험해 보세요.', 'error', {
      label: 'Test drive로 전환',
      onClick: () => { $('#modeSeg button[data-value="test"]').click(); hideNotice(); },
    });
  } else if (status === 'unavailable') {
    showNotice('이 기기에서 GPS를 사용할 수 없습니다. Test drive로 체험할 수 있습니다.', 'error');
  }
}

function showNotice(text, kind = 'info', action) {
  const n = els.notice;
  n.hidden = false;
  n.dataset.kind = kind;
  n.querySelector('p').textContent = text;
  const btn = n.querySelector('button[data-action]');
  btn.hidden = !action;
  if (action) {
    btn.textContent = action.label;
    btn.onclick = action.onClick;
  }
}

function hideNotice() {
  els.notice.hidden = true;
}
els.notice.querySelector('button[data-close]').addEventListener('click', hideNotice);

// ── Wake Lock / 백그라운드 복귀 ──
async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* 배터리 절약 모드 등에서 거부될 수 있음 */ }
}

function releaseWakeLock() {
  if (wakeLock) wakeLock.release().catch(() => {});
  wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (audio) audio.resume();
    if (vehicle.engine !== 'off') acquireWakeLock();
  }
});

// ── 메인 루프 (rAF, 탭이 숨겨지면 setInterval로 계속) ──
let last = performance.now();
let lastEngine = '';

function tick(now) {
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;
  if (dt <= 0) return;

  // REV는 0.6초에 걸쳐 올라가고, BLIP은 짧은 반사인 펄스
  revVal = revHeld ? Math.min(1, revVal + dt / 0.6) : 0;
  if (blipT > 0) {
    blipT = Math.max(0, blipT - dt);
    revVal = Math.max(revVal, 0.7 * Math.sin((Math.PI * blipT) / BLIP_S));
  }
  let input;
  if (state.mode === 'gps') {
    const g = gps.sample(now);
    if (g.stale !== gpsStale) { gpsStale = g.stale; paintGps({ status: gps.status, accuracy: gps.accuracy }); }
    input = { mode: 'gps', speed: g.speed, accel: g.accel, quality: g.quality, stale: g.stale, rev: revVal };
  } else if (demo) {
    const d = demo.t < 0 ? (demo.t += dt, { gas: null, brake: null, rev: 0 }) : demo.step(dt);
    input = { mode: 'test', gas: d.gas, brake: d.brake, rev: d.rev };
    pedals.show(d.gas, d.brake);
    if (demo.done) stopDemo();
  } else {
    input = { mode: 'test', gas: pedals.gas, brake: pedals.brake, rev: revVal };
  }

  const s = vehicle.update(dt, input);
  if (audio) audio.setParams(s);

  const u = UNIT[state.unit];
  gauge.update({
    rpm: s.rpm,
    speed: s.speed * u.k,
    unit: u.label,
    gear: s.gearLabel,
    shiftLight: preset.type !== 'ev' && s.rpm > preset.redline * 0.93,
  });
  els.throttle.style.transform = `scaleX(${s.throttle.toFixed(3)})`;
  const moving = s.speed > 0.4;
  els.rev.disabled = moving;
  els.blip.disabled = moving;
  if (s.engine !== lastEngine) { lastEngine = s.engine; paintEngine(); }
}

function frame(now) {
  tick(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
setInterval(() => {
  const now = performance.now();
  if (now - last > 120) tick(now);
}, 50);

// ── 초기화 ──
applyMode();
paintEngine();
runCompatChecks($('#compatList'));
