/**
 * GPS 속도 소스.
 * - coords.speed 우선, 없으면 하버사인 거리/시간.
 * - 알파-베타 필터(속도, 가속도) + 정확도 가중치.
 * - 1Hz 샘플 사이를 등가속도로 외삽하고, 새 샘플이 오면 오프셋을 300ms 코사인 곡선으로 수렴시켜 점프를 없앤다.
 * - 필터는 도착 시각이 아니라 실제 측정 시각(pos.timestamp)을 기준으로 갱신해, 브라우저 전달 지연이
 *   들쭉날쭉해도 dt·가속도 추정이 흔들리지 않게 한다.
 * - v < 1km/h가 1.5초 지속되면 0으로 스냅.
 * - 품질(quality 0~1, 정확도 기반)과 신호 단절(stale: 마지막 측정 후 2.5초 이상)을 함께 내보내
 *   시뮬레이터가 오차·단절 구간에서 불필요한 변속이나 고회전을 만들지 않게 한다.
 */

const KMH = 1 / 3.6;
const BLEND_MS = 300; // 새 샘플 보정을 최소 300ms 코사인 곡선으로 수렴
const BLEND_MAX_RATE = 3; // m/s² — 신호가 끊겼다 돌아온 큰 오차는 더 천천히 수렴
const EXTRAP_HORIZON_S = 1.5;
const STALE_MS = 2500;
const MAX_LATENCY_MS = 2000; // 이보다 큰 전달 지연은 시계 불일치로 보고 잘라낸다

/** 수평 정확도(m) → 신뢰도 0~1 */
export function accuracyQuality(acc) {
  if (acc == null || !Number.isFinite(acc)) return 0.6;
  if (acc <= 10) return 1;
  if (acc >= 60) return 0.15;
  return 1 - ((acc - 10) / 50) * 0.85;
}

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
    this.lastMeasMs = null;
    this.quality = 1;
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
    if (meas === null) return;
    // pos.timestamp(에포크 ms)를 performance 시계로 옮긴다. 기기 시계가 어긋나 미래·과거로 튀는 경우는 클램프.
    const latency = Math.min(MAX_LATENCY_MS, Math.max(0, Date.now() - pos.timestamp));
    this.ingest(meas, now - latency, c.accuracy, now);
  }

  onError(e) {
    if (e.code === 1) this.setStatus('denied');
    else if (e.code === 2) this.setStatus('unavailable');
    else this.setStatus('waiting');
  }

  /**
   * 측정값 하나를 필터에 넣는다. (테스트에서 직접 호출)
   * measMs: 실제 측정 시각, arrivalMs: 받은 시각(기본 = measMs). 둘 다 performance 시계 기준.
   */
  ingest(meas, measMs, accuracy = 5, arrivalMs = measMs) {
    const w = accuracy > 30 ? 0.3 : accuracy > 15 ? 0.7 : 1;
    this.quality = accuracyQuality(accuracy);
    if (!this.has) {
      this.vEst = meas;
      this.aEst = 0;
      this.tEst = measMs;
      this.offset = 0;
      this.offsetT = arrivalMs;
      this.lastMeasMs = measMs;
      this.has = true;
      return;
    }
    // 순서가 뒤바뀌었거나 중복된 측정은 버린다
    if (measMs <= this.tEst) return;
    this.lastMeasMs = measMs;
    const before = this.displayed(arrivalMs);
    const dt = Math.max(0.05, (measMs - this.tEst) / 1000);
    const pred = this.vEst + this.aEst * dt;
    const r = meas - pred;
    this.vEst = Math.max(0, pred + 0.55 * w * r);
    this.aEst = Math.max(-9, Math.min(7, this.aEst + (0.35 * w * r) / dt));
    this.tEst = measMs;
    // 새 기준선(도착 시각까지 외삽)과 현재 표시값의 차이를 오프셋으로 남겨 서서히 0으로 → 점프 없음
    const ext = Math.min((arrivalMs - measMs) / 1000, EXTRAP_HORIZON_S);
    this.offset = before - (this.vEst + this.aEst * ext);
    this.offsetT = arrivalMs;
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

  /** rAF마다 호출: 외삽된 속도(m/s), 가속도, 품질(0~1), 신호 단절 여부 */
  sample(nowMs) {
    const v = this.displayed(nowMs);
    const stale = this.has && this.lastMeasMs != null && nowMs - this.lastMeasMs > STALE_MS;
    if (v < 1 * KMH) {
      if (this.stillSince == null) this.stillSince = nowMs;
      if (nowMs - this.stillSince > 1500) this.stopped = true;
    } else {
      this.stillSince = null;
      if (v > 1.5 * KMH) this.stopped = false;
    }
    if (this.stopped) return { speed: 0, accel: 0, quality: this.quality, stale };
    const extending = (nowMs - this.tEst) / 1000 < EXTRAP_HORIZON_S;
    return { speed: v, accel: extending && !stale ? this.aEst : 0, quality: this.quality, stale };
  }
}
