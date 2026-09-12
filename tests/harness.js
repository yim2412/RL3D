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
  "state.js", "utils.js", "map.js", "launches.js", "sequence.js", "focus.js",
  "sats.js", "satfilter.js", "sattrack.js", "satpass.js", "observer.js", "trajectory.js", "panels.js", "keys.js", "settings.js", "update.js", "boot.js",
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
  "tlMin", "tlMax", "timelineInited", "archiveLaunches", "loadedYears", "truncatedYears", "tracking",
  "satcat", "satTypesOff", "satOwnersOff", "focusDismissed", "focusShownId", "focusTimer",
  "trackAheadMin", "futureMarker",
  "latestUpdateInfo", "settingsDismissedUpdate", "heatOn", "timeZoneMode", "panelLaunchId", "settingObserver", "observerMarker",
  // 읽기 전용 표도 여기로 꺼낸다 — 최상위 const 는 컨텍스트 객체에 안 보인다
  "CITIES",
];

/** 테스트가 만드는 가짜 엘리먼트. hidden 은 classList 로만 바뀌므로 그대로 흉내 낸다. */
function makeEl(id) {
  let hidden = true;
  const classes = new Set();
  let html = "";
  const children = [];
  return {
    id, checked: false, value: "", textContent: "",
    dataset: {}, style: {}, disabled: false,
    handlers: {},
    // 실제 DOM 은 innerHTML 을 덮어쓰면 자식이 **날아간다**. 스텁이 그걸 안 하면
    // 앞서 열었던 패널의 자식이 남아 "안 그렸는데 그려졌다"로 잘못 통과한다(P12-4 에서 실제로 겪음).
    get innerHTML() { return html; },
    set innerHTML(v) { html = v; children.length = 0; },
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
    children,
    appendChild(c) { children.push(c); return c; },
    querySelectorAll: () => ({ forEach() {} }),
    querySelector: () => null,
  };
}

const SAT_LIB = path.join(__dirname, "..", "web", "lib", "satellite.min.js");

/** 실제 satellite.js(SGP4) 를 **앱과 같은 컨텍스트**에 올린다 — 궤도 계산 검증용.
 *  별도 컨텍스트에 올리면 안 된다: 라이브러리 내부의 `date instanceof Date` 가
 *  realm 이 달라 false 가 되고, 좌표가 전부 NaN 으로 나온다(브라우저에선 생기지 않는 문제). */
function injectSatelliteLib(ctx) {
  vm.runInContext(fs.readFileSync(SAT_LIB, "utf8"), ctx, { filename: "satellite.min.js" });
  if (!ctx.satellite) throw new Error("satellite.js 를 로드하지 못했습니다");
}

/**
 * app.js 를 스텁 위에 올려 { ctx, state, el, map, win, api, sel } 를 돌려준다.
 *   ctx   — app.js 의 전역 함수들(ctx.orbitBand(...) 처럼 직접 호출)
 *   state — 모듈 스코프 상태 읽기/쓰기(state.satrecs = [...])
 *   el    — id 로 스텁 엘리먼트 얻기(el("sat-count").textContent)
 *   map   — map.fire("error", {...}) 로 지도 이벤트 발생, map.data("launches") 로 setData 결과 확인
 *   win   — win.fire("offline") 으로 window 이벤트 발생
 *   api   — window.pywebview.api 스텁(테스트에서 함수를 갈아끼운다)
 *   sel   — querySelectorAll 결과 지정(sel[".flt:checked"] = [{value:"success"}])
 *
 * options.realSatellite: true 면 실제 SGP4 라이브러리를 넣는다(궤도 계산 검증용).
 */
function loadApp(options = {}) {
  const els = {};
  const el = (id) => (els[id] = els[id] || makeEl(id));

  const mapHandlers = {};
  const winHandlers = {};
  const docHandlers = {};   // document 에 직접 붙는 핸들러(키보드 P12-14)
  const selectors = {};   // 테스트가 채우는 querySelectorAll 응답
  const sources = {};     // 지도 소스별 마지막 setData 값
  const layouts = {};     // setLayoutProperty 로 바뀐 값 ("레이어.속성" → 값)
  const paints = {};      // setPaintProperty 로 바뀐 값
  const api = Object.assign({
    get_settings: async () => ({}),
    save_settings: () => {},
    get_launches: async () => ({ launches: [] }),
    get_satellites: async () => ({ satellites: [] }),
    get_satellite_groups: async () => [],
    get_archive: async () => ({ launches: [] }),
    open_url: () => true,
    check_update: async () => null,
  }, options.api || {});

  const ctx = {
    console,
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    navigator: { language: "ko", onLine: options.onLine !== false },
    location: { hash: "" },
    document: {
      getElementById: el,
      querySelectorAll: (s) => selectors[s] || [],
      // 단축키(P12-14)가 `.flt[value="success"]` 처럼 하나만 찾는다 → 같은 맵에서 첫 항목을 준다
      querySelector: (s) => (selectors[s] && selectors[s][0]) || null,
      addEventListener: (ev, fn) => { docHandlers[ev] = fn; },
      createElement: () => makeEl("created"),
      body: el("body"),
    },
    addEventListener: (ev, fn) => { winHandlers[ev] = fn; },
    removeEventListener() {},
    satellite: options.satellite || {},   // realSatellite 면 라이브러리가 아래에서 덮어쓴다
    maplibregl: options.maplibregl || {},
    performance: { now: () => Date.now() },
  };
  ctx.window = ctx;
  ctx.self = ctx;          // satellite.min.js(UMD)가 self 에 전역을 붙인다
  ctx.pywebview = { api };
  vm.createContext(ctx);
  if (options.realSatellite) injectSatelliteLib(ctx);

  const accessors = STATE_KEYS
    .map((k) => `get ${k}() { return ${k}; }, set ${k}(v) { ${k} = v; },`)
    .join("\n  ");
  vm.runInContext(
    readApp() + `\n;globalThis.__state = {\n  ${accessors}\n};`,
    ctx,
    { filename: "web/js/*.js" },
  );

  const map = {
    // 실제 MapLibre 는 `on(ev, fn)` 과 `on(ev, 레이어, fn)` 을 둘 다 받고, **같은 이벤트에
    // 여러 핸들러**를 단다(클러스터 클릭·마커 클릭·관측지 지정이 전부 "click" 이다).
    // 스텁이 하나만 담으면 마지막 것만 남아 배선 테스트가 거짓으로 통과한다(P13-6 에서 드러났다).
    on: (ev, a, b) => {
      const fn = typeof a === "function" ? a : b;
      const layer = typeof a === "string" ? a : null;
      const key = layer ? ev + ":" + layer : ev;
      (mapHandlers[key] = mapHandlers[key] || []).push(fn);
    },
    /** 레이어 없는 핸들러를 전부 부른다. 레이어별은 fire("click:clusters", …). */
    fire: (ev, arg) => (mapHandlers[ev] || []).forEach((f) => { if (f) f(arg); }),
    has: (ev) => !!(mapHandlers[ev] && mapHandlers[ev].length),
    // 앱이 쓰는 최소한의 지도 API. setData 결과는 sources 에 남겨 테스트가 검사한다.
    addSource(id) { sources[id] = null; },
    addLayer() {},
    getSource: (id) => (id in sources
      ? { setData(d) { sources[id] = d; } }
      : undefined),
    getLayer: () => ({}),
    // 레이아웃·페인트 속성은 **남겨 둔다** — 히트맵(P12-15)처럼 "켜면 다른 레이어가
    // 같이 흐려지는" 배선은 setData 로는 안 보이고 이 값으로만 잴 수 있다.
    setLayoutProperty(id, prop, v) { layouts[`${id}.${prop}`] = v; },
    setPaintProperty(id, prop, v) { paints[`${id}.${prop}`] = v; },
    layout: (id, prop) => layouts[`${id}.${prop}`],
    paint: (id, prop) => paints[`${id}.${prop}`],
    getCanvas: () => ({ style: {} }),
    flyTo() {}, easeTo() {}, addControl() {},
    /** 마지막으로 setData 된 값 */
    data: (id) => sources[id],
    /** 소스를 미리 만들어 둔다(setupLaunchLayers 를 부르지 않고 applyFilters 만 볼 때) */
    stubSource: (id) => { sources[id] = null; },
  };
  // vm 컨텍스트는 **별도 realm** 이라 Date 생성자가 Node 쪽과 다르다. Node 에서 만든
  // Date 를 satellite.js 에 넘기면 `instanceof Date` 가 실패해 **예외 없이 NaN 좌표**가
  // 나온다(2026-09-11 P12-1 테스트에서 실제로 당했다 — 통과 예측이 조용히 전부 NaN).
  // realm 안의 Date 를 꺼내 주어 테스트가 같은 realm 의 시각을 만들 수 있게 한다.
  const RealmDate = vm.runInContext("Date", ctx);

  // 지도 라이브러리 스텁. **이게 있어야 `pywebviewready` 부트 경로 전체를 잴 수 있다** —
  // initMap 이 `new maplibregl.Map` 에서 던지면 부트가 거기서 멈춰, 그 앞뒤 배선
  // (initUpdateCheck·bindUI)이 실제로 불리는지 테스트가 볼 수 없다. 호출자가 직접
  // 넘긴 maplibregl 이 있으면 그쪽을 존중한다.
  if (!options.maplibregl) {
    const marker = () => ({
      setLngLat() { return this; }, addTo() { return this; }, remove() {},
      getElement: () => makeEl("marker"),
    });
    ctx.maplibregl = {
      Map: function () { return map; },
      NavigationControl: function () { return {}; },
      Marker: function () { return marker(); },
    };
  }

  return {
    ctx, state: ctx.__state, el, map, api, sel: selectors,
    /** vm realm 안의 Date. 위성 계산에 넘길 시각은 **반드시** 이걸로 만든다. */
    date: (ms) => new RealmDate(ms),
    win: {
      fire: (ev, a) => winHandlers[ev] && winHandlers[ev](a),
      /** window 에 붙은 핸들러가 있는지(배선 여부) */
      has: (ev) => !!winHandlers[ev],
    },
    /** document 에 붙은 핸들러 — has 로 배선 여부를, fire 로 실제 동작을 잰다. */
    doc: {
      has: (ev) => !!docHandlers[ev],
      fire: (ev, a) => docHandlers[ev] && docHandlers[ev](a),
    },
  };
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

module.exports = { loadApp, group, check, done, APP_FILES };
