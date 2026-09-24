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
  "errors.js", "state.js", "utils.js", "map.js", "launches.js", "sequence.js", "focus.js",
  "sats.js", "satfilter.js", "sattrack.js", "satpass.js", "observer.js", "trajectory.js", "favorites.js", "sidebar.js", "panels.js", "satpanel.js", "stats.js", "keys.js", "settings.js", "update.js", "firstrun.js", "boot.js",
];
const JS_DIR = path.join(__dirname, "..", "web", "js");
const INDEX_HTML = path.join(__dirname, "..", "web", "index.html");

/**
 * `index.html` 의 **초기 상태**를 id → {text} 로 읽는다(P31-2).
 *
 * 스텁은 늘 빈 문자열로 시작했다. 그래서 *"데이터가 오기 전에 화면이 뭐라고 말하나"* 를
 * **한 번도 잰 적이 없다** — 사이드바 머리글이 `0건` 으로 시작하는 것(아직 못 받았는데
 * 0건이라고 말하는 것)도 테스트가 아니라 **파일을 직접 열어 보고** 알았다.
 *
 * 아주 단순한 파서다: 여는 태그에 `id="X"` 가 있으면 다음 여는/닫는 태그 전까지의
 * 텍스트를 그 id 의 초기 `textContent` 로 쓴다. 중첩 구조는 보지 않는다 —
 * **초기 문구를 잴 수 있으면 충분**하고, 더 하면 하네스가 브라우저 흉내를 내기 시작한다.
 */
function readInitialDom() {
  let html = "";
  try { html = fs.readFileSync(INDEX_HTML, "utf8"); } catch (_) { return {}; }
  const out = {};
  const tag = /<([a-z]+)[^>]*\bid="([\w-]+)"[^>]*>/gi;
  let m;
  while ((m = tag.exec(html))) {
    const [open, name, id] = m;
    const rest = html.slice(m.index + open.length);
    // 자식 없이 바로 텍스트가 오는 흔한 경우. 없으면 닫는 태그까지 훑어 태그를 걷어낸다
    // (`<div id="sidebar-list"><div class="sb-empty">불러오는 중…</div></div>` 같은 모양).
    let text = (rest.match(/^([^<]*)/) || ["", ""])[1].trim();
    if (!text) {
      const close = rest.search(new RegExp("</" + name + ">", "i"));
      if (close > 0) {
        text = rest.slice(0, close).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
      }
    }
    if (text) out[id] = text.slice(0, 200);
  }
  return out;
}
const INITIAL_DOM = readInitialDom();

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
  "trackAheadMin", "futureMarker", "firstRun", "satLoadError", "lastLaunchLoad", "tonightToken", "tonightRows", "updateTimer",
  "latestUpdateInfo", "settingsDismissedUpdate", "heatOn", "timeZoneMode", "panelLaunchId", "settingObserver", "observerMarker",
  // **여기 없는 전역은 테스트가 볼 수 없다** — `satPanelId` 가 그래서 오래 비어 있었고,
  // "위성 상세를 열어 둔 채 선택을 놓으면 그 패널도 닫는다"를 아무도 재지 않았다(P45).
  "satPanelId", "trackTimer", "tickerTimer", "autoTimer", "terminatorTimer",
  // 읽기 전용 표도 여기로 꺼낸다 — 최상위 const 는 컨텍스트 객체에 안 보인다
  "CITIES", "SIDEBAR_CAP",
];

/** 테스트가 만드는 가짜 엘리먼트. hidden 은 classList 로만 바뀌므로 그대로 흉내 낸다.
 *  `lookup` 은 id 로 다른 스텁 엘리먼트를 얻는 함수(`querySelector("#id")` 가 쓴다). */
function makeEl(id, lookup) {
  let hidden = true;
  const classes = new Set();
  // `index.html` 이 정해 둔 초기 문구로 시작한다(P31-2) — 실제 첫 화면과 같은 상태.
  // `innerHTML` 에도 같은 텍스트를 넣는다(태그는 뺀 채로): 화면을 그리는 쪽은 대부분
  // `innerHTML` 로 읽고 덮으므로, 여기가 비어 있으면 **"처음에 뭐라고 쓰여 있었나"** 를
  // 그쪽에서는 여전히 못 본다. 태그까지 흉내 내지는 않는다 — 문구를 재면 충분하다.
  const initialText = INITIAL_DOM[id] || "";
  let html = initialText;
  const children = [];
  return {
    id, checked: false, value: "", textContent: initialText,
    dataset: {}, style: {}, disabled: false,
    handlers: {},
    // 실제 DOM 은 innerHTML 을 덮어쓰면 자식이 **날아간다**. 스텁이 그걸 안 하면
    // 앞서 열었던 패널의 자식이 남아 "안 그렸는데 그려졌다"로 잘못 통과한다(P12-4 에서 실제로 겪음).
    get innerHTML() { return html; },
    set innerHTML(v) {
      html = v; children.length = 0;
      // **`data-*` 를 그 id 의 스텁에 실어 준다**(P28-2). 이 앱은 `innerHTML` 로 버튼을 만들고
      // `b.dataset.kind` 로 **분기**한다(`bindFavBtn` 이 launch/sat 을 그렇게 가른다).
      // 안 실어 주면 배선이 붙은 것까지만 보이고 **엉뚱한 분기로 가는 것**은 못 본다 —
      // 실제로 그래서 관심 버튼이 발사인데 위성 쪽 함수를 부르는 것처럼 보였다.
      if (!lookup) return;
      const tag = /<[a-z]+[^>]*\bid="([\w-]+)"[^>]*>/gi;
      let m;
      while ((m = tag.exec(v))) {
        const child = lookup(m[1]);
        if (!child) continue;
        const attr = /\bdata-([\w-]+)="([^"]*)"/g;
        let d;
        while ((d = attr.exec(m[0]))) {
          child.dataset[d[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = d[2];
        }
      }
    },
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
    /**
     * 엘리먼트 단위 `querySelectorAll` — 기본은 빈 응답이고, 테스트가 채워 넣는다
     * (`el("stats-panel").sel[".site-link"] = [btn]`).
     *
     * 이게 없으면 `panel.querySelectorAll(...).forEach(addEventListener)` 로 거는
     * **배선을 잴 수 없다.** innerHTML 단언은 전부 통과하는데 버튼만 죽어 있는 자리다.
     */
    sel: {},
    /**
     * 스텁에는 원래 좌표가 없다(그래서 기하는 `tests/test_layout.js` 가 실제 Edge 로 잰다).
     * 다만 **"툴바를 재서 그 값을 쓰는가"** 는 배선이라 여기서 재야 한다 — 테스트가
     * `el("toolbar").rect = { bottom: 130 }` 처럼 정해 둔 값을 그대로 돌려준다.
     */
    rect: null,
    getBoundingClientRect() { return this.rect; },
    querySelectorAll(s) { return this.sel[s] || { forEach() {} }; },
    /**
     * 엘리먼트 단위 `querySelector` — **예전에는 언제나 null 이었다**(P28-2).
     *
     * `bindFavBtn(root)` 처럼 `root.querySelector("#fav-btn")` 로 버튼을 찾는 배선은
     * 테스트에서 **항상 "버튼이 없다"로 빠져나갔다** — 배선이 죽어도 전부 초록이었다.
     * 복수형(`sel`)은 P12-4 에서 이미 열어 뒀는데 단수형만 빈 채로 남아 있었다.
     *
     * 규칙: `sel` 에 지정한 것이 있으면 그 **첫 항목**을, 없고 `#id` 꼴이면 그 id 의
     * 스텁 엘리먼트를 준다(실제 DOM 이 패널 안에서 찾는 것과 같은 결과가 된다).
     */
    querySelector(s) {
      if (this.sel[s] && this.sel[s].length) return this.sel[s][0];
      const m = /^#([\w-]+)$/.exec(s);
      return m && lookup ? lookup(m[1]) : null;
    },
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
  /**
   * options.missing: 이 id 들은 **없는 요소**로 친다(`getElementById` 가 null).
   *
   * 스텁은 원래 **묻는 id 마다 요소를 만들어 준다.** 편하지만 그래서
   * *"`index.html` 에서 요소를 지웠을 때"* 를 영영 잴 수 없었다 — 지워도 테스트는
   * 전부 통과한다. `wire()`(P23-1)가 지키려는 것이 정확히 그 경로라, 그걸 재려면
   * 없는 요소를 만들 수 있어야 한다.
   */
  const missing = new Set(options.missing || []);
  const el = (id) => (missing.has(id) ? null : (els[id] = els[id] || makeEl(id, (x) => el(x))));

  const mapHandlers = {};
  const winHandlers = {};
  const docHandlers = {};   // document 에 직접 붙는 핸들러(키보드 P12-14)
  const cssVars = {};     // documentElement 에 쓰인 CSS 변수(P34-2)
  const selectors = {};   // 테스트가 채우는 querySelectorAll 응답
  const sources = {};     // 지도 소스별 마지막 setData 값
  const cameraMoves = [];  // flyTo/easeTo 호출 기록(P23-2 — 안 움직인 것도 단언한다)
  const clusterZooms = {}; // 클러스터 id → 펼침 줌(테스트가 정한다)
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
    // 타이머는 **기록한다**(P41). 예전에는 `() => 0` 이라 "무엇을 몇 초마다 도는지"를
    // 테스트가 볼 수 없었고, 그래서 `setInterval` 여섯 줄이 죽어도 전부 초록이었다 —
    // 위성 위치·지상궤적·터미네이터·속보 띠·임박 카드·갱신 표시가 **멈춘 채로**.
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval(id) { if (id && intervals[id - 1]) intervals[id - 1].cleared = true; },
    setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length; },
    clearTimeout(id) { if (id && timeouts[id - 1]) timeouts[id - 1].cleared = true; },
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
      // `--ui-top`(P34-2)을 어디에 쓰는지 재려면 루트 엘리먼트가 있어야 한다.
      // 쓴 값은 `cssVars` 에 남아 테스트가 읽는다.
      documentElement: {
        style: {
          setProperty: (k, v) => { cssVars[k] = v; },
          getPropertyValue: (k) => cssVars[k] || "",
        },
      },
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

  const intervals = [];   // setInterval 등록 기록(P41)
  const timeouts = [];    // setTimeout 등록 기록
  const canvas = { style: {} };
  let camera = { center: { lng: 0, lat: 0 }, zoom: 2 };
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
      ? {
        setData(d) { sources[id] = d; },
        /** 클러스터를 펼치는 줌. 앱은 Promise 를 기대한다(MapLibre 와 같은 모양). */
        getClusterExpansionZoom: (cid) => Promise.resolve(clusterZooms[cid] === undefined ? 7 : clusterZooms[cid]),
      }
      : undefined),
    getLayer: () => ({}),
    // 레이아웃·페인트 속성은 **남겨 둔다** — 히트맵(P12-15)처럼 "켜면 다른 레이어가
    // 같이 흐려지는" 배선은 setData 로는 안 보이고 이 값으로만 잴 수 있다.
    setLayoutProperty(id, prop, v) { layouts[`${id}.${prop}`] = v; },
    setPaintProperty(id, prop, v) { paints[`${id}.${prop}`] = v; },
    layout: (id, prop) => layouts[`${id}.${prop}`],
    paint: (id, prop) => paints[`${id}.${prop}`],
    // **같은 객체를 돌려준다** — 매번 새로 만들면 `style.cursor = "pointer"` 를 써도
    // 테스트가 그걸 읽을 수 없어, 커서를 바꾸는 배선(마우스 올림/내림)을 못 잰다.
    getCanvas: () => canvas,
    /** 지금 커서 모양. 배선이 죽으면 바뀌지 않는다. */
    cursor: () => canvas.style.cursor,
    // 카메라 위치 저장(P11-4)을 재려면 지도가 "지금 어디를 보고 있는지" 말해야 한다.
    getCenter: () => camera.center,
    getZoom: () => camera.zoom,
    /** 테스트가 카메라를 옮겨 둔다. */
    setCamera: (lng, lat, zoom) => { camera = { center: { lng, lat }, zoom }; },
    // 카메라 이동은 **남겨 둔다** — "확대해도 안 갈라지는 클러스터"(P23-2)는
    // *움직이지 않았다*를 단언해야 잴 수 있고, 빈 함수로는 그걸 못 잰다.
    flyTo(o) { cameraMoves.push(["flyTo", o]); },
    easeTo(o) { cameraMoves.push(["easeTo", o]); },
    addControl() {},
    /** 마지막으로 setData 된 값 */
    data: (id) => sources[id],
    /** 소스를 미리 만들어 둔다(setupLaunchLayers 를 부르지 않고 applyFilters 만 볼 때) */
    stubSource: (id) => { sources[id] = null; },
    /** 지금까지의 카메라 이동 [종류, 옵션] 목록. 비어 있으면 안 움직인 것이다. */
    moves: () => cameraMoves,
    /** 클러스터 id → 펼침 줌을 테스트가 정한다. */
    setClusterZoom: (cid, z) => { clusterZooms[cid] = z; },
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
    /** `document.documentElement.style.setProperty` 로 쓰인 CSS 변수 */
    cssVars,
    /**
     * 등록된 타이머. `every(ms)` 로 그 주기의 것들을, `run(ms)` 으로 그것들을 실제로 돌린다.
     * **주기까지 재는 이유**: 1초짜리를 60초로 바꿔도 "등록됐다"만 보면 안 잡힌다.
     */
    timers: {
      all: () => intervals.filter((t) => !t.cleared),
      every: (ms) => intervals.filter((t) => !t.cleared && t.ms === ms),
      run: (ms) => intervals.filter((t) => !t.cleared && t.ms === ms).forEach((t) => t.fn()),
      timeouts: () => timeouts.filter((t) => !t.cleared),
      runTimeouts: () => timeouts.filter((t) => !t.cleared).forEach((t) => t.fn()),
    },
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

// minPass — 건수 하한(전면 감사 2026-09-24). 주입·수집이 조용히 실패하면 검사가
// **0건으로 통과**한다 — 이 프로젝트에서 도구가 그렇게 여러 번 틀렸다. 테스트를 지웠으면
// 하한도 같이 내린다(그게 의도한 삭제인지 한 번 묻게 하려는 것).
function done(minPass) {
  console.log(`\n${results.pass} passed, ${results.fail} failed`);
  if (minPass && results.pass < minPass) {
    console.log(`FAIL 건수 하한: ${results.pass} < ${minPass} — 검사가 빠졌거나 주입이 실패했다`);
    process.exit(1);
  }
  process.exit(results.fail ? 1 : 0);
}

module.exports = { loadApp, group, check, done, APP_FILES };
