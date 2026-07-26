/* 프론트엔드 테스트 하네스 — web/app.js 를 브라우저 없이 Node 에서 불러오는 장치.
 *
 * app.js 는 DOM·MapLibre·pywebview 를 전제로 하므로, 필요한 만큼만 흉내 낸 스텁 위에 올린다.
 * **로딩 방식은 이 파일에만 있다** — app.js 가 ES 모듈로 쪼개지면(P11-5) 여기만 갈아끼우고
 * test_frontend.js 본문은 그대로 둘 수 있게 격리해 둔 것이다.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

/** index.html 의 <script> 순서와 같아야 한다 — 클래식 스크립트라 순서가 곧 의존 관계다.
 *  파일을 늘리면 여기에도 추가한다(빠뜨리면 "함수가 없다"는 에러로 바로 드러난다). */
const APP_FILES = [
  "state.js", "utils.js", "map.js", "launches.js",
  "sats.js", "panels.js", "settings.js", "boot.js",
];
const JS_DIR = path.join(__dirname, "..", "web", "js");

/** 여러 파일을 한 스크립트로 이어 붙인다 — 브라우저에서 여러 <script> 가 같은 전역
 *  렉시컬 스코프를 공유하는 것과 같은 상태를 vm 안에서 재현한다. */
function readApp() {
  return APP_FILES.map((f) => fs.readFileSync(path.join(JS_DIR, f), "utf8")).join("\n");
}

/** app.js 의 모듈 스코프 `let` 상태는 컨텍스트 객체에 노출되지 않는다(전역 프로퍼티가 아니다).
 *  테스트에서 읽고 쓰려면 같은 스코프에 접근자를 만들어 밖으로 꺼내야 한다. */
const STATE_KEYS = [
  "map", "launches", "allLaunches", "satrecs", "satGroups", "satBands",
  "favLaunches", "favSats", "selectedSat", "sidebarTab", "basemap",
  "tileFails", "badgeDismissed", "observer", "timelineMax", "satTimer", "savedCamera",
];

/** 테스트가 만드는 가짜 엘리먼트. hidden 은 classList 로만 바뀌므로 그대로 흉내 낸다. */
function makeEl(id) {
  let hidden = true;
  const classes = new Set();
  return {
    id, checked: false, value: "", textContent: "", innerHTML: "",
    dataset: {}, style: {}, disabled: false,
    handlers: {},
    get hidden() { return hidden; },
    classList: {
      add: (c) => { if (c === "hidden") hidden = true; else classes.add(c); },
      remove: (c) => { if (c === "hidden") hidden = false; else classes.delete(c); },
      toggle: (c, on) => {
        const next = on === undefined ? !(c === "hidden" ? hidden : classes.has(c)) : !!on;
        if (c === "hidden") hidden = next;
        else if (next) classes.add(c); else classes.delete(c);
      },
      contains: (c) => (c === "hidden" ? hidden : classes.has(c)),
    },
    addEventListener(ev, fn) { this.handlers[ev] = fn; },
    /** 테스트에서 클릭 등을 직접 발생시킨다(마우스 자동화 대신). */
    fire(ev, arg) { if (this.handlers[ev]) this.handlers[ev](arg); },
    querySelectorAll: () => ({ forEach() {} }),
    querySelector: () => null,
  };
}

/**
 * app.js 를 스텁 위에 올려 { ctx, state, el, map, win, api } 를 돌려준다.
 *   ctx   — app.js 의 전역 함수들(ctx.orbitBand(...) 처럼 직접 호출)
 *   state — 모듈 스코프 상태 읽기/쓰기(state.satrecs = [...])
 *   el    — id 로 스텁 엘리먼트 얻기(el("sat-count").textContent)
 *   map   — map.fire("error", {...}) 로 지도 이벤트 발생
 *   win   — win.fire("offline") 으로 window 이벤트 발생
 *   api   — window.pywebview.api 스텁(테스트에서 함수를 갈아끼운다)
 */
function loadApp(options = {}) {
  const els = {};
  const el = (id) => (els[id] = els[id] || makeEl(id));

  const mapHandlers = {};
  const winHandlers = {};
  const api = Object.assign({
    get_settings: async () => ({}),
    save_settings: () => {},
    get_launches: async () => ({ launches: [] }),
    get_satellites: async () => ({ satellites: [] }),
    get_satellite_groups: async () => [],
    get_archive: async () => ({ launches: [] }),
    open_url: () => true,
  }, options.api || {});

  const ctx = {
    console,
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    navigator: { language: "ko", onLine: options.onLine !== false },
    location: { hash: "" },
    document: {
      getElementById: el,
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener() {},
      createElement: () => makeEl("created"),
      body: el("body"),
    },
    addEventListener: (ev, fn) => { winHandlers[ev] = fn; },
    removeEventListener() {},
    satellite: options.satellite || {},
    maplibregl: options.maplibregl || {},
  };
  ctx.window = ctx;
  ctx.pywebview = { api };
  vm.createContext(ctx);

  const accessors = STATE_KEYS
    .map((k) => `get ${k}() { return ${k}; }, set ${k}(v) { ${k} = v; },`)
    .join("\n  ");
  vm.runInContext(
    readApp() + `\n;globalThis.__state = {\n  ${accessors}\n};`,
    ctx,
    { filename: "web/js/*.js" },
  );

  const map = {
    on: (ev, fn) => { mapHandlers[ev] = fn; },
    fire: (ev, arg) => { if (mapHandlers[ev]) mapHandlers[ev](arg); },
    has: (ev) => !!mapHandlers[ev],
  };
  return { ctx, state: ctx.__state, el, map, win: { fire: (ev, a) => winHandlers[ev] && winHandlers[ev](a) }, api };
}

// ── 아주 작은 테스트 러너 (의존성 0) ──────────────────────────────────────────
const results = { pass: 0, fail: 0, group: "" };

function group(name) {
  results.group = name;
  console.log(`\n${name}`);
}

function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { results.pass++; console.log("  OK   " + name); }
  else { results.fail++; console.log(`  FAIL ${name}\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`); }
}

function done() {
  console.log(`\n${results.pass} passed, ${results.fail} failed`);
  process.exit(results.fail ? 1 : 0);
}

module.exports = { loadApp, group, check, done };
