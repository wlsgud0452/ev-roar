/**
 * MANUAL 변속 입력: 화면 − / + 버튼, 키보드 Q / E, 하드웨어 미디어 키(이전/다음 곡), Media Session API.
 *
 * 테슬라 휠 노브 연동은 "브라우저가 미디어 세션 이벤트를 받는 경우"에만 동작한다.
 * 일반 웹 페이지는 차량 버튼을 직접 읽을 수 없으므로, 페이지가 재생 중인 미디어(무음에 가까운 루프 오디오)를 가진 상태에서
 * 휠의 다음/이전 곡 동작이 nexttrack / previoustrack 액션으로 전달되는지를 실제로 감지해 지원 여부를 판단한다.
 * 차종·소프트웨어 버전별 지원은 확인되지 않았으며, 감지 기록(detected)을 화면에 보여 사용자가 직접 확인하게 한다.
 *
 * 중복 입력 방지: 같은 물리 버튼이 미디어 키와 미디어 세션 두 경로로 동시에 들어오는 경우가 있어
 * 250ms 안에 다른 경로로 들어온 같은 방향 입력은 버린다. 키 반복(e.repeat)도 무시한다.
 */
const DEDUPE_MS = 250;
const BOUNCE_MS = 80;

const KEY_DIR = { KeyE: 1, KeyQ: -1 };
const MEDIA_KEY_DIR = { MediaTrackNext: 1, MediaFastForward: 1, MediaTrackPrevious: -1, MediaRewind: -1 };

/** 진폭 ±1 LSB 디더만 들어 있는 6초 모노 WAV (사실상 무음, 미디어 세션 유지용) */
function quietWavUrl() {
  const sr = 8000;
  const n = sr * 6;
  const buf = new ArrayBuffer(44 + n * 2);
  const d = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) d.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); d.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); d.setUint32(16, 16, true); d.setUint16(20, 1, true); d.setUint16(22, 1, true);
  d.setUint32(24, sr, true); d.setUint32(28, sr * 2, true); d.setUint16(32, 2, true); d.setUint16(34, 16, true);
  str(36, 'data'); d.setUint32(40, n * 2, true);
  let seed = 1;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    d.setInt16(44 + i * 2, (seed >> 16) & 1 ? 1 : -1, true);
  }
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

export class ShiftInput {
  /**
   * @param {{ onShift: (dir: 1|-1, source: string) => void, onDetect?: (info: object) => void }} opts
   */
  constructor({ onShift, onDetect }) {
    this.onShift = onShift;
    this.onDetect = onDetect || (() => {});
    this.last = { t: -1e9, dir: 0, source: '' };
    this.detected = null; // 마지막으로 감지한 미디어 입력 { source, action, at }
    this.keeper = null;
    this.sessionSupported = typeof navigator !== 'undefined' && 'mediaSession' in navigator;
    this.bindKeys();
  }

  /** 모든 입력 경로가 여기로 모인다. 받아들였으면 true */
  fire(dir, source) {
    const now = performance.now();
    const dt = now - this.last.t;
    if (dt < BOUNCE_MS) return false;
    if (dt < DEDUPE_MS && this.last.dir === dir && this.last.source !== source) return false;
    this.last = { t: now, dir, source };
    this.onShift(dir, source);
    return true;
  }

  detect(source, action) {
    this.detected = { source, action, at: Date.now() };
    this.onDetect(this.detected);
  }

  bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (e.target.closest?.('input, select, textarea')) return;
      const media = MEDIA_KEY_DIR[e.key];
      if (media) {
        e.preventDefault();
        this.detect('mediakey', e.key);
        if (!e.repeat) this.fire(media, 'mediakey');
        return;
      }
      const dir = KEY_DIR[e.code];
      if (!dir || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      this.fire(dir, 'keyboard');
    });
  }

  bindButtons(downBtn, upBtn) {
    for (const [btn, dir] of [[downBtn, -1], [upBtn, 1]]) {
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.fire(dir, 'screen');
      });
      // 키보드 접근(Tab → Enter/Space)
      btn.addEventListener('keydown', (e) => {
        if ((e.code === 'Enter' || e.code === 'Space') && !e.repeat) {
          e.preventDefault();
          e.stopPropagation();
          this.fire(dir, 'screen');
        }
      });
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
    }
  }

  /**
   * 미디어 세션 활성화. 반드시 사용자 제스처(START ENGINE 클릭) 안에서 호출한다.
   * @param {{title: string, album?: string}} meta
   */
  async enableMediaSession(meta) {
    if (!this.sessionSupported) return false;
    const ms = navigator.mediaSession;
    if (!this.keeper) {
      const el = new Audio();
      el.src = quietWavUrl();
      el.loop = true;
      el.setAttribute('playsinline', '');
      this.keeper = el;
      const handlers = {
        nexttrack: 1, seekforward: 1, previoustrack: -1, seekbackward: -1,
      };
      for (const [action, dir] of Object.entries(handlers)) {
        try {
          ms.setActionHandler(action, () => {
            this.detect('mediasession', action);
            this.fire(dir, 'mediasession');
          });
        } catch { /* 지원하지 않는 액션 */ }
      }
      // 재생/일시정지가 와도 세션을 놓치지 않도록 계속 재생 (엔진 소리는 Web Audio로 별도 출력)
      for (const action of ['play', 'pause', 'stop']) {
        try {
          ms.setActionHandler(action, () => {
            this.detect('mediasession', action);
            this.keeper.play().catch(() => {});
            ms.playbackState = 'playing';
          });
        } catch { /* 지원하지 않는 액션 */ }
      }
    }
    this.setMetadata(meta);
    try {
      await this.keeper.play();
      ms.playbackState = 'playing';
      return true;
    } catch {
      return false;
    }
  }

  setMetadata({ title, album = '' }) {
    if (!this.sessionSupported || typeof MediaMetadata === 'undefined') return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title, artist: 'EV Roar', album });
    } catch { /* 무시 */ }
  }

  disableMediaSession() {
    if (this.keeper) this.keeper.pause();
    if (this.sessionSupported) navigator.mediaSession.playbackState = 'paused';
  }
}
