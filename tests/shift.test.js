import test from 'node:test';
import assert from 'node:assert/strict';

// 최소 window 흉내: keydown 리스너만 모은다
const listeners = [];
globalThis.window = { addEventListener: (type, fn) => { if (type === 'keydown') listeners.push(fn); } };
const { ShiftInput } = await import('../js/input/shift.js');

let now = 1000;
globalThis.performance = { now: () => now };

function key(fields) {
  const e = { repeat: false, target: { closest: () => null }, preventDefault() {}, ...fields };
  for (const fn of listeners) fn(e);
}

test('Q / E: 누를 때마다 한 번씩, 키 반복은 무시', () => {
  const got = [];
  const si = new ShiftInput({ onShift: (d, s) => got.push([d, s]) });
  key({ code: 'KeyE' }); now += 300;
  key({ code: 'KeyE', repeat: true }); now += 300;
  key({ code: 'KeyQ' }); now += 300;
  assert.deepEqual(got, [[1, 'keyboard'], [-1, 'keyboard']]);
  si.onShift = () => {};
});

test('같은 버튼이 미디어 키와 미디어 세션으로 동시에 들어와도 변속은 1회', () => {
  const got = [];
  const si = new ShiftInput({ onShift: (d, s) => got.push([d, s]) });
  now += 1000;
  key({ key: 'MediaTrackNext', code: '' });
  now += 30;
  si.detect('mediasession', 'nexttrack');
  si.fire(1, 'mediasession');
  assert.equal(got.length, 1);
  assert.equal(si.detected.action, 'nexttrack');
  // 충분히 지난 뒤 다음 입력은 받아들인다
  now += 400;
  si.fire(1, 'mediasession');
  assert.equal(got.length, 2);
});

test('채터링(80ms 이내 연속 입력)은 경로와 무관하게 무시', () => {
  const got = [];
  const si = new ShiftInput({ onShift: (d) => got.push(d) });
  now += 1000;
  si.fire(1, 'screen');
  now += 40;
  si.fire(-1, 'screen');
  assert.deepEqual(got, [1]);
});
