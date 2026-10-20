/**
 * 앱 부트스트랩: 입력(GPS/페달/데모/REV) → 차량 시뮬 → 오디오 워크렛 + 계기판, 60Hz 루프.
 */
import { APP_NAME, APP_TAGLINE } from './config.js';
import { state, setState } from './state.js';
import { PRESETS, getPreset } from './presets/presets.js';
import { Vehicle } from './sim/vehicle.js';
import { DemoRun } from './sim/demo.js';
import { GpsSource } from './input/gps.js';
import { Pedals } from './input/testdrive.js';
import { EngineAudio } from './audio/graph.js';
import { Gauge } from './ui/gauge.js';
import { renderCarGrid, markSelected, renderBanner } from './ui/cars.js';
import { buildSliders, buildSliderHelp, bindSegment, bindHold } from './ui/controls.js';
import { runCompatChecks } from './ui/compat.js';

const $ = (sel) => document.querySelector(sel);
const UNIT = { kmh: { label: 'km/h', k: 3.6 }, mph: { label: 'mph', k: 2.236936 } };

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
let wakeLock = null;

const els = {
  start: $('#startBtn'),
  pillGps: $('#pillGps'),
  pillEngine: $('#pillEngine'),
  pedals: $('#pedalArea'),
  revArea: $('#revArea'),
  rev: $('#revBtn'),
  demo: $('#demoBtn'),
  throttle: $('#throttleBar'),
  notice: $('#notice'),
  grid: $('#carGrid'),
  banner: $('#banner'),
};

const gauge = new Gauge($('#gauge'));
gauge.setPreset(preset);

const vehicle = new Vehicle(preset, { onEvent: onVehicleEvent });
vehicle.setSettings({ intensity: state.intensity, crackle: state.crackle });

const gps = new GpsSource({ onStatus: paintGps });
const pedals = new Pedals($('#pedalGas'), $('#pedalBrake'), {
  onTouch: () => { if (demo) stopDemo(); },
});

// ── 차량 선택 ──
renderCarGrid(els.grid, PRESETS, preset.id, selectPreset);
renderBanner(els.banner, preset);

function selectPreset(id) {
  if (id === preset.id) return;
  preset = getPreset(id);
  setState({ presetId: id });
  markSelected(els.grid, id);
  renderBanner(els.banner, preset);
  gauge.setPreset(preset);
  const wasOn = vehicle.engine !== 'off';
  const speed = vehicle.speed;
  vehicle.setPreset(preset);
  vehicle.speed = speed;
  if (audio) audio.setPreset(preset);
  if (wasOn && preset.type === 'ev') vehicle.engine = 'running';
}

// ── 슬라이더 / 토글 ──
buildSliders($('#sliders'), state, (key, v) => {
  setState({ [key]: v });
  vehicle.setSettings({ intensity: state.intensity, crackle: state.crackle });
  if (audio) audio.setSettings(state);
});
buildSliderHelp($('#sliderHelp'));

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

function applyMode() {
  const isGps = state.mode === 'gps';
  els.pedals.hidden = isGps;
  els.revArea.hidden = !isGps;
  els.demo.hidden = isGps;
  if (isGps) gps.start();
  else {
    gps.stop();
    vehicle.speed = 0;
  }
  paintGps({ status: gps.status, accuracy: gps.accuracy });
}

// ── REV 버튼 / 스페이스바 ──
bindHold(els.rev, () => { revHeld = true; }, () => { revHeld = false; });
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
    try {
      if (!audio) {
        const a = new EngineAudio();
        a.onMessage = () => {};
        await a.init({ preset, settings: state });
        audio = a;
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
function paintEngine() {
  const on = vehicle.engine !== 'off';
  const label = { off: '엔진 꺼짐', cranking: '시동 중…', starting: '엔진 켜짐', running: '엔진 켜짐', stopping: '정지 중…' }[vehicle.engine];
  els.pillEngine.textContent = preset.type === 'ev' && on ? '모터 켜짐' : label;
  els.pillEngine.dataset.state = on ? 'on' : 'off';
  els.start.textContent = on && vehicle.engine !== 'stopping' ? 'STOP ENGINE' : 'START ENGINE';
  els.start.classList.toggle('running', on && vehicle.engine !== 'stopping');
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
    ok: `GPS 정상${accuracy != null ? ` (±${Math.round(accuracy)}m)` : ''}`,
    denied: '위치 권한 거부',
    unavailable: 'GPS 사용 불가',
  }[status] || status;
  pill.textContent = text;
  pill.dataset.state = status === 'ok' ? (accuracy > 30 ? 'warn' : 'on') : status === 'waiting' ? 'warn' : status === 'off' ? 'idle' : 'error';
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

  revVal = revHeld ? Math.min(1, revVal + dt / 0.6) : 0;
  let input;
  if (state.mode === 'gps') {
    const g = gps.sample(now);
    input = { mode: 'gps', speed: g.speed, accel: g.accel, rev: revVal };
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
  els.rev.disabled = s.speed > 0.4;
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
