/**
 * 슬라이더, 세그먼트 토글, 길게 누르기 버튼.
 */
export const SLIDERS = [
  { key: 'volume', label: '볼륨', desc: '전체 음량. 사이렌·경고음이 묻히지 않을 만큼만.' },
  { key: 'intensity', label: '인텐시티', desc: '변속 시점과 스로틀 민감도. 높을수록 더 높은 rpm까지 끌고 올라가고, GPS 가속에 더 민감하게 반응합니다.' },
  { key: 'character', label: '캐릭터', desc: '0% 순정 머플러(둔하고 조용한 실내음) → 100% 스트레이트 파이프(밝고 거칠고 공명이 강함).' },
  { key: 'crackle', label: '크래클', desc: '리프트오프·변속·리미터 때 나오는 팝/백파이어 양. 0%면 완전히 깨끗합니다.' },
  { key: 'bass', label: '저음 강화', desc: '점화 기본주파수 서브베이스와 저역 셸프. 차량 스피커에서 존재감을 키웁니다.' },
  { key: 'space', label: '공간감', desc: '짧은 잔향으로 배기음이 공간에서 울리는 느낌을 더합니다.' },
];

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
    input.value = String(Math.round(values[s.key] * 100));
    val.textContent = `${input.value}%`;
    input.addEventListener('input', () => {
      val.textContent = `${input.value}%`;
      onChange(s.key, Number(input.value) / 100);
    });
    row.append(head, input);
    container.append(row);
    inputs[s.key] = input;
  }
  return inputs;
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
