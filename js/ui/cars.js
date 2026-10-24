/**
 * 차량 카드 그리드, 선택 차량 배너(사양 + 출처 표기), 주행 화면 차량 표시.
 */
import { GEARBOX_LABEL } from '../presets/presets.js';

const FALLBACK_IMG = 'assets/icon.svg';
const SRC_LABEL = { spec: '확인', est: '추정', tuned: '튜닝값' };

function setImg(img, p) {
  img.onerror = () => { img.onerror = null; img.src = FALLBACK_IMG; img.classList.add('fallback'); };
  img.classList.remove('fallback');
  img.src = p.image;
  img.alt = p.name;
}

export const gearboxText = (p) => (p.type === 'ev' ? '단일 감속기' : `${p.gearRatios.length}단 ${GEARBOX_LABEL[p.gearbox.type]}`);

export function renderCarGrid(container, presets, selectedId, onSelect) {
  container.replaceChildren();
  for (const p of presets) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'car-card';
    btn.dataset.id = p.id;
    btn.setAttribute('aria-pressed', String(p.id === selectedId));
    const img = document.createElement('img');
    img.loading = 'lazy';
    setImg(img, p);
    img.alt = '';
    const name = document.createElement('span');
    name.textContent = p.name;
    const sub = document.createElement('small');
    sub.textContent = gearboxText(p);
    btn.append(img, name, sub);
    btn.addEventListener('click', () => onSelect(p.id));
    container.append(btn);
  }
}

export function markSelected(container, id) {
  for (const b of container.querySelectorAll('.car-card')) {
    b.setAttribute('aria-pressed', String(b.dataset.id === id));
  }
}

export function renderBanner(el, p) {
  setImg(el.querySelector('[data-banner-img]'), p);
  el.querySelector('[data-banner-name]').textContent = p.fullName || p.name;
  el.querySelector('[data-banner-desc]').textContent = p.description;
  const specs = el.querySelector('[data-banner-specs]');
  specs.replaceChildren(...(p.specs || []).map(([k, v, src]) => {
    const li = document.createElement('li');
    const b = document.createElement('b');
    b.textContent = k;
    const tag = document.createElement('i');
    tag.className = `src src-${src}`;
    tag.textContent = SRC_LABEL[src] || src;
    li.append(b, ` ${v} `, tag);
    return li;
  }));
}

export function renderCredit(el, p) {
  el.replaceChildren();
  if (!p.credit) return;
  el.append('사진: ');
  const a = document.createElement('a');
  a.href = p.credit.url;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = `${p.credit.author} · ${p.credit.license}`;
  el.append(a, ' (Wikimedia Commons)');
}

export function renderDashCar(el, p) {
  setImg(el.querySelector('[data-dash-img]'), p);
  el.querySelector('[data-dash-name]').textContent = p.fullName || p.name;
  el.querySelector('[data-dash-sub]').textContent = `${p.layout} · ${gearboxText(p)}`;
}
