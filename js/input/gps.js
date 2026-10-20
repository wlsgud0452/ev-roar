/**
 * GPS 속도 소스.
 * - coords.speed 우선, 없으면 하버사인 거리/시간.
 * - 알파-베타 필터(속도, 가속도) + 정확도 가중치.
 * - 1Hz 샘플 사이를 등가속도로 외삽하고, 새 샘플이 오면 오프셋을 300ms 코사인 곡선으로 수렴시켜 점프를 없앤다.
 * - v < 1km/h가 1.5초 지속되면 0으로 스냅.
 */

const KMH = 1 / 3.6;
const BLEND_MS = 300; // 새 샘플 보정을 최소 300ms 코사인 곡선으로 수렴
const BLEND_MAX_RATE = 3; // m/s² — 신호가 끊겼다 돌아온 큰 오차는 더 천천히 수렴
const EXTRAP_HORIZON_S = 1.5;

export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export class GpsSource {
  constructor({ onStatus } = {}) {
    this.onStatus = onStatus || (() => {});
    this.watchId = null;
    this.status = 'off';
    this.accuracy = null;
    this.reset();
  }

  reset() {
    this.vEst = 0;
    this.aEst = 0;
    this.tEst = 0;
    this.offset = 0;
    this.offsetT = 0;
    this.blendMs = BLEND_MS;
    this.has = false;
    this.lastFix = null;
    this.stillSince = null;
    this.stopped = true;
  }

  setStatus(status) {
    this.status = status;
    this.onStatus({ status, accuracy: this.accuracy });
  }

  start() {
    if (this.watchId != null) return;
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      this.setStatus('unavailable');
      return;
    }
    this.reset();
    this.setStatus('waiting');
    this.watchId = navigator.geolocation.watchPosition(
      (p) => this.onPosition(p),
      (e) => this.onError(e),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 },
    );
  }

  stop() {
    if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    this.reset();
    this.setStatus('off');
  }

  onPosition(pos) {
    const now = performance.now();
    const c = pos.coords;
    let meas = typeof c.speed === 'number' && Number.isFinite(c.speed) && c.speed >= 0 ? c.speed : null;
    if (meas === null && this.lastFix) {
      const dt = (pos.timestamp - this.lastFix.ts) / 1000;
      if (dt > 0.2) meas = haversine(this.lastFix.lat, this.lastFix.lon, c.latitude, c.longitude) / dt;
    }
    this.lastFix = { lat: c.latitude, lon: c.longitude, ts: pos.timestamp };
    this.accuracy = c.accuracy;
    this.setStatus('ok');
    if (meas !== null) this.ingest(meas, now, c.accuracy);
  }

  onError(e) {
    if (e.code === 1) this.setStatus('denied');
    else if (e.code === 2) this.setStatus('unavailable');
    else this.setStatus('waiting');
  }

  /** 측정값 하나를 필터에 넣는다. (테스트에서 직접 호출) */
  ingest(meas, nowMs, accuracy = 5) {
    const w = accuracy > 30 ? 0.3 : accuracy > 15 ? 0.7 : 1;
    if (!this.has) {
      this.vEst = meas;
      this.aEst = 0;
      this.tEst = nowMs;
      this.offset = 0;
      this.offsetT = nowMs;
      this.has = true;
      return;
    }
    const before = this.displayed(nowMs);
    const dt = Math.max(0.05, (nowMs - this.tEst) / 1000);
    const pred = this.vEst + this.aEst * dt;
    const r = meas - pred;
    this.vEst = Math.max(0, pred + 0.55 * w * r);
    this.aEst = Math.max(-9, Math.min(7, this.aEst + (0.35 * w * r) / dt));
    this.tEst = nowMs;
    // 새 기준선과 현재 표시값의 차이를 오프셋으로 남겨 서서히 0으로 → 점프 없음
    this.offset = before - this.vEst;
    this.offsetT = nowMs;
    this.blendMs = Math.max(BLEND_MS, (Math.abs(this.offset) / BLEND_MAX_RATE) * 1000);
  }

  displayed(nowMs) {
    if (!this.has) return 0;
    const ext = Math.min((nowMs - this.tEst) / 1000, EXTRAP_HORIZON_S);
    const base = this.vEst + this.aEst * Math.max(0, ext);
    const k = Math.min(1, (nowMs - this.offsetT) / this.blendMs);
    const off = this.offset * 0.5 * (1 + Math.cos(Math.PI * k));
    return Math.max(0, base + off);
  }

  /** rAF마다 호출: 외삽된 속도(m/s)와 가속도 */
  sample(nowMs) {
    const v = this.displayed(nowMs);
    if (v < 1 * KMH) {
      if (this.stillSince == null) this.stillSince = nowMs;
      if (nowMs - this.stillSince > 1500) this.stopped = true;
    } else {
      this.stillSince = null;
      if (v > 1.5 * KMH) this.stopped = false;
    }
    if (this.stopped) return { speed: 0, accel: 0 };
    const extending = (nowMs - this.tEst) / 1000 < EXTRAP_HORIZON_S;
    return { speed: v, accel: extending ? this.aEst : 0 };
  }
}
