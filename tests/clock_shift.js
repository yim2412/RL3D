/* 시계를 앞으로 민다 (P54) — `node -r ./tests/clock_shift.js <테스트>` 로 먼저 올린다.
 *
 * CLOCK_SHIFT_DAYS 일만큼 Node 와 **앱 realm(vm 컨텍스트) 둘 다**의 `Date` 를 민다.
 * 한쪽만 밀면 두 시계를 비교하는 단언이 가짜로 깨지거나 가짜로 통과한다 — 이 도구를 처음
 * 만들 때 Node 쪽이 안 밀린 채 "39건 실패"를 냈다(2026-09-27).
 *
 * 인자 없는 `new Date()` 와 `Date.now()` 만 민다. 날짜를 넣어 만든 시각은 그대로다 —
 * 픽스처에 박힌 날짜와 "지금"이 어긋나는 자리를 찾는 것이 이 도구의 목적이다.
 */
const vm = require("vm");

const SHIFT_MS = Number(process.env.CLOCK_SHIFT_DAYS || 0) * 86400000;

function install(G, shift) {
  const Real = G.Date;
  class Shifted extends Real {
    constructor(...a) { if (a.length) super(...a); else super(Real.now() + shift); }
    static now() { return Real.now() + shift; }
  }
  G.Date = Shifted;
}

install(globalThis, SHIFT_MS);
const origCreate = vm.createContext;
vm.createContext = function (...args) {
  const c = origCreate.apply(this, args);
  vm.runInContext(`(${install})(globalThis, ${SHIFT_MS})`, c);
  return c;
};
