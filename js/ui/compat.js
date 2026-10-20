/**
 * 호환성 체크: HTTPS / Web Audio / AudioWorklet / Geolocation / 위치 권한 / Wake Lock.
 */
const LABEL = { ok: '정상', warn: '확인 필요', fail: '불가' };

function item(name, status, note) {
  const li = document.createElement('li');
  li.className = `compat-item ${status}`;
  const badge = document.createElement('span');
  badge.className = 'compat-badge';
  badge.textContent = status === 'ok' ? '✓' : status === 'warn' ? '!' : '✕';
  const text = document.createElement('div');
  const strong = document.createElement('strong');
  strong.textContent = name;
  const small = document.createElement('small');
  small.textContent = `${LABEL[status]} · ${note}`;
  text.append(strong, small);
  li.append(badge, text);
  return li;
}

async function geoPermission() {
  if (!navigator.permissions?.query) return { state: 'unknown' };
  try {
    return await navigator.permissions.query({ name: 'geolocation' });
  } catch {
    return { state: 'unknown' };
  }
}

export async function runCompatChecks(list) {
  const render = async () => {
    const secure = window.isSecureContext;
    const webAudio = !!(window.AudioContext || window.webkitAudioContext);
    const worklet = typeof window.AudioWorkletNode !== 'undefined';
    const geo = 'geolocation' in navigator;
    const perm = await geoPermission();
    const wake = 'wakeLock' in navigator;
    const permStatus = perm.state === 'granted' ? 'ok' : perm.state === 'denied' ? 'fail' : 'warn';
    const permNote = {
      granted: '허용됨',
      denied: '거부됨 — 브라우저 사이트 설정에서 위치 권한을 허용하거나 Test drive를 쓰세요',
      prompt: 'GPS drive를 켜면 권한을 요청합니다',
    }[perm.state] || '확인할 수 없음 (GPS drive를 켜면 요청)';
    list.replaceChildren(
      item('HTTPS (보안 컨텍스트)', secure ? 'ok' : 'fail', secure ? location.protocol.replace(':', '') : 'HTTPS가 아니면 위치와 오디오워크렛이 막힙니다'),
      item('Web Audio', webAudio ? 'ok' : 'fail', webAudio ? '지원' : '미지원 브라우저'),
      item('AudioWorklet', worklet ? 'ok' : 'fail', worklet ? '지원 (실시간 합성 가능)' : '미지원 — 소리를 낼 수 없습니다'),
      item('Geolocation', geo ? 'ok' : 'fail', geo ? '지원' : '미지원 — Test drive만 사용 가능'),
      item('위치 권한', geo ? permStatus : 'fail', permNote),
      item('화면 꺼짐 방지 (Wake Lock)', wake ? 'ok' : 'warn', wake ? '지원' : '미지원 — 화면 자동 꺼짐 설정을 늘려주세요'),
    );
    return perm;
  };
  const perm = await render();
  if (perm && 'onchange' in perm) perm.onchange = render;
}
