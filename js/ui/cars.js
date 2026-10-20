/**
 * 차량 카드 그리드와 선택 차량 배너.
 */
import { presetSpecs } from '../presets/presets.js';

export function renderCarGrid(container, presets, selectedId, onSelect) {
  container.replaceChildren();
  for (const p of presets) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'car-card';
    btn.dataset.id = p.id;
    btn.setAttribute('aria-pressed', String(p.id === selectedId));
    const img = document.createElement('img');
    img.src = p.image;
    img.alt = '';
    img.loading = 'lazy';
    const name = document.createElement('span');
    name.textContent = p.name;
    btn.append(img, name);
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
  el.querySelector('[data-banner-img]').src = p.image;
  el.querySelector('[data-banner-name]').textContent = p.name;
  el.querySelector('[data-banner-desc]').textContent = p.description;
  const specs = el.querySelector('[data-banner-specs]');
  specs.replaceChildren(...presetSpecs(p).map((s) => {
    const li = document.createElement('li');
    li.textContent = s;
    return li;
  }));
}
