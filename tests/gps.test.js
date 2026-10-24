import test from 'node:test';
import assert from 'node:assert/strict';
import { GpsSource, haversine } from '../js/input/gps.js';

test('하버사인 거리', () => {
  // 위도 1° ≈ 111.2km
  assert.ok(Math.abs(haversine(37, 127, 38, 127) - 111195) < 200);
});

test('1Hz GPS 가속 구간에서도 60Hz 출력이 계단 없이 매끄럽다', () => {
  const g = new GpsSource();
  const out = [];
  // 0 → 30 m/s를 15초 동안 등가속(2 m/s²), GPS는 1초마다 측정
  for (let i = 0; i <= 60 * 16; i++) {
    const ms = (i * 1000) / 60;
    if (i % 60 === 0) g.ingest(Math.min(30, 2 * (ms / 1000)), ms, 5);
    out.push(g.sample(ms).speed);
  }
  // 프레임 간 변화량이 등가속(2 m/s² → 0.033 m/s/frame)의 몇 배 이내
  let maxStep = 0;
  for (let i = 60 * 3; i < out.length; i++) maxStep = Math.max(maxStep, Math.abs(out[i] - out[i - 1]));
  assert.ok(maxStep < 0.12, `최대 프레임 변화 ${maxStep.toFixed(3)} m/s`);
  // 추종 오차
  const t10 = out[60 * 10];
  assert.ok(Math.abs(t10 - 20) < 2.5, `10초 시점 속도 ${t10.toFixed(2)}`);
});

test('정차 판정: 저속 드리프트는 1.5초 뒤 0으로 스냅', () => {
  const g = new GpsSource();
  g.ingest(5, 0, 5);
  g.ingest(0.2, 1000, 5);
  let s;
  for (let ms = 1000; ms < 6000; ms += 1000 / 60) {
    if (Math.abs((ms % 1000)) < 1) g.ingest(0.15 + 0.1 * Math.sin(ms), ms, 20);
    s = g.sample(ms);
  }
  assert.equal(s.speed, 0);
  assert.equal(s.accel, 0);
});

test('정확도 나쁜 샘플은 가중치가 낮다', () => {
  const a = new GpsSource();
  const b = new GpsSource();
  for (const gps of [a, b]) gps.ingest(20, 0, 5);
  a.ingest(30, 1000, 5);
  b.ingest(30, 1000, 50);
  assert.ok(b.vEst < a.vEst);
});

test('GPS가 3초 끊겼다가 돌아와도 속도가 급변하지 않는다', () => {
  const g = new GpsSource();
  const out = [];
  for (let i = 0; i <= 60 * 14; i++) {
    const ms = (i * 1000) / 60;
    const t = ms / 1000;
    const dropout = t > 4.5 && t < 7.5;
    if (i % 60 === 0 && !dropout) g.ingest(Math.min(25, 2 * t), ms, 5);
    out.push(g.sample(ms).speed);
  }
  let maxStep = 0;
  for (let i = 60 * 3; i < out.length; i++) maxStep = Math.max(maxStep, Math.abs(out[i] - out[i - 1]));
  assert.ok(maxStep < 0.12, `최대 프레임 변화 ${maxStep.toFixed(3)} m/s`);
});

test('전달 지연이 들쭉날쭉해도 측정 시각 기준이면 가속도 추정이 안정적이다', () => {
  // 2 m/s² 등가속, 1Hz 측정, 도착 지연 0~600ms 랜덤
  const lat = [0, 550, 80, 600, 20, 400, 0, 580, 100, 500, 30, 600, 60, 450];
  const byMeas = new GpsSource();
  const byArrival = new GpsSource();
  const errMeas = [];
  const errArrival = [];
  for (let k = 0; k < lat.length; k++) {
    const measMs = k * 1000;
    const arrivalMs = measMs + lat[k];
    const v = 2 * k;
    byMeas.ingest(v, measMs, 5, arrivalMs);
    byArrival.ingest(v, arrivalMs, 5);
    if (k >= 4) {
      errMeas.push(Math.abs(byMeas.aEst - 2));
      errArrival.push(Math.abs(byArrival.aEst - 2));
    }
  }
  const maxMeas = Math.max(...errMeas);
  const maxArrival = Math.max(...errArrival);
  assert.ok(maxMeas < 0.3, `측정 시각 기준 가속도 오차 ${maxMeas.toFixed(2)}`);
  assert.ok(maxMeas < maxArrival, `측정 ${maxMeas.toFixed(2)} vs 도착 ${maxArrival.toFixed(2)}`);
});

test('지연 도착 샘플도 표시 속도가 튀지 않는다', () => {
  const g = new GpsSource();
  const out = [];
  for (let i = 0; i <= 60 * 12; i++) {
    const ms = (i * 1000) / 60;
    // 측정은 정각, 도착은 매번 400ms 뒤
    if (i % 60 === 24) {
      const measMs = ms - 400;
      g.ingest(Math.min(20, 2 * (measMs / 1000)), measMs, 5, ms);
    }
    out.push(g.sample(ms).speed);
  }
  let maxStep = 0;
  for (let i = 60 * 3; i < out.length; i++) maxStep = Math.max(maxStep, Math.abs(out[i] - out[i - 1]));
  assert.ok(maxStep < 0.12, `최대 프레임 변화 ${maxStep.toFixed(3)} m/s`);
});

test('순서가 뒤바뀐 측정은 무시한다', () => {
  const g = new GpsSource();
  g.ingest(10, 0, 5);
  g.ingest(12, 1000, 5);
  const v = g.vEst;
  g.ingest(50, 900, 5);
  assert.equal(g.vEst, v);
});
