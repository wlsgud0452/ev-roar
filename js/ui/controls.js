/**
 * 슬라이더, 세그먼트 토글, 길게 누르기 버튼.
 */
export const SLIDERS = [
  { key: 'volume', label: '볼륨', desc: '전체 음량 (모든 차량 공통). 사이렌·경고음이 묻히지 않을 만큼만.' },
  { key: 'character', label: '캐릭터', desc: '0% 순정 머플러(둔하고 조용함) → 100% 스트레이트 파이프(밝고 거칠고 공명이 강함).' },
  { key: 'crackle', label: '팝앤뱅 강도', desc: '리프트오프·변속·리미터 때 나오는 팝/백파이어 양. 팝앤뱅 OFF거나 0%면 완전히 깨끗합니다. 발생 빈도는 차량 특성·rpm·배기 밸브에 따라 달라집니다.' },
  { key: 'bass', label: '저음 강화', desc: '점화 기본주파수 서브베이스와 저역 셸프. 오디오 구성 보정과 별개로 취향에 맞춰 더합니다.' },
  { key: 'space', label: '공간감', desc: '짧은 잔향으로 배기음이 공간에서 울리는 느낌을 더합니다. 실내 청취에선 자동으로 줄어듭니다.' },
  { key: 'response', label: '가속 반응 감도', desc: '페달·GPS 가속에 스로틀이 얼마나 민감하게 반응할지. 높을수록 살짝만 가속해도 엔진이 크게 반응합니다.' },
  { key: 'shiftStyle', label: '변속 성향', desc: 'AUTO 변속 맵 안에서 이른 변속(낮음, 조용) ↔ 늦은 변속(높음, 고회전 유지). Comfort / Sport 위에 덧붙는 미세 조정입니다.' },
];

const pct = (v) => `${Math.round(v * 100)}%`;

export function buildSliders(container, values, onChange) {
  container.replaceChildren();
  const inputs = {};
  for (const s of SLIDERS) {
    const row = document.createElement('label');
    row.className = 'slider';
    const head = document.createElement('div');
    head.className = 'slider-head';
    const name = document.createElement('span');
    name.textContent = s.label;
    const val = document.createElement('output');
    head.append(name, val);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = '0';
    input.max = '100';
    input.step = '1';
    input.addEventListener('input', () => {
      val.textContent = `${input.value}%`;
      onChange(s.key, Number(input.value) / 100);
    });
    row.append(head, input);
    container.append(row);
    inputs[s.key] = { input, val };
  }
  setSliderValues(inputs, values);
  return inputs;
}

/** 차량 변경·초기화 후 슬라이더 위치만 다시 맞춘다 (onChange는 부르지 않음) */
export function setSliderValues(inputs, values) {
  for (const [key, { input, val }] of Object.entries(inputs)) {
    if (typeof values[key] !== 'number') continue;
    input.value = String(Math.round(values[key] * 100));
    val.textContent = pct(values[key]);
  }
}

export function buildSliderHelp(container) {
  container.replaceChildren(...SLIDERS.map((s) => {
    const dt = document.createElement('dt');
    dt.textContent = s.label;
    const dd = document.createElement('dd');
    dd.textContent = s.desc;
    return [dt, dd];
  }).flat());
}

/** <div class="segmented"><button data-value>...</button></div> */
export function bindSegment(el, value, onChange) {
  const buttons = [...el.querySelectorAll('button[data-value]')];
  const paint = (v) => buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === v)));
  paint(value);
  buttons.forEach((b) => b.addEventListener('click', () => {
    paint(b.dataset.value);
    onChange(b.dataset.value);
  }));
  return { set: paint };
}

/** 누르고 있는 동안 활성화되는 버튼 (터치/마우스/키보드 공통) */
export function bindHold(btn, onDown, onUp) {
  let held = false;
  const down = (e) => {
    e.preventDefault();
    if (e.pointerId != null) btn.setPointerCapture(e.pointerId);
    if (!held) { held = true; btn.classList.add('active'); onDown(); }
  };
  const up = () => {
    if (held) { held = false; btn.classList.remove('active'); onUp(); }
  };
  btn.addEventListener('pointerdown', down);
  btn.addEventListener('pointerup', up);
  btn.addEventListener('pointercancel', up);
  btn.addEventListener('lostpointercapture', up);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  btn.addEventListener('keydown', (e) => { if ((e.code === 'Enter' || e.code === 'Space') && !e.repeat) down(e); });
  btn.addEventListener('keyup', (e) => { if (e.code === 'Enter' || e.code === 'Space') up(); });
}
