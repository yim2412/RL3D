/*
 * RL3D — 레이아웃 회귀 테스트 (P34).
 *
 * **스텁 DOM 이 영영 못 재는 부류가 있다.** `tests/test_frontend.js` 는 함수를 직접 불러
 * 판정·배선을 재지만, 요소가 화면 어디에 놓이는지는 모른다(스텁에 좌표가 없다).
 * 그래서 다음 둘이 **688건이 전부 초록인 채로** 살아 있었다(2026-09-23 실측):
 *
 *   ① 상세 패널(`bottom: 24px`)이 타임라인 위쪽 34px 을 덮어, 패널이 열려 있으면
 *      **과거 연도 선택과 `불러오기` 버튼이 클릭을 못 받았다** — 창 크기와 무관.
 *   ② 창을 1,085px 보다 좁히면 툴바가 두 줄이 되어 **사이드바 탭 넷이 통째로 툴바 뒤로**
 *      들어갔다. 탭 자리를 누르면 `↻ 갱신`(강제 API 요청)이 눌린다. 최소 창이 900px 이라
 *      **허용된 크기 안에서** 일어난다.
 *
 * 재는 법: 실제 `index.html` + 실제 `style.css` + 실제 `utils.js`(`syncUiTop`)를 정적
 * HTML 로 합쳐 **헤드리스 Edge**(WebView2 와 같은 Chromium)에 띄우고, 조작해야 하는
 * 요소마다 **중심점에서 `elementFromPoint`** 를 불러 *정말 그것이 잡히는지*를 본다.
 * 마우스는 쓰지 않는다(프로젝트 규칙) — 좌표 판정만 브라우저에게 맡긴다.
 *
 * Edge 가 없는 환경에서는 **스킵하고 0 으로 끝낸다**(CI 는 windows-latest 라 있다).
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const WEB = path.join(__dirname, "..", "web");
const EDGE_CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];

function findEdge() {
  for (const p of EDGE_CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

/**
 * 조작 가능해야 하는 요소들. `open` 은 그 상태에서 **hidden 을 벗겨 둘** 요소다 —
 * 실제 앱에서 동시에 떠 있을 수 있는 조합만 적는다.
 */
const CASES = [
  {
    name: "기본 화면 (사이드바만)",
    open: ["sidebar"],
    clickable: ["search", "tz-btn", "more-btn", "toggle-list", "refresh", "sat-groups-btn",
      "tab-launches", "tab-sats", "tab-favs", "tab-tonight",
      "tl-range", "arch-year", "arch-load"],
  },
  {
    name: "상세 패널을 연 화면",
    open: ["sidebar", "panel"],
    clickable: ["search", "toggle-list", "refresh",
      "tab-launches", "tab-sats", "tab-favs", "tab-tonight",
      "tl-range", "arch-year", "arch-load", "panel-close"],
  },
  {
    name: "위성 그룹 팝오버를 연 화면",
    open: ["sidebar", "sat-groups"],
    clickable: ["search", "sat-groups-btn", "refresh", "tl-range", "arch-year", "arch-load"],
  },
  {
    // 좌하단 배지 셋이 전부 사이드바 뒤로 숨어 있었다(P35-1). 배지는 **눌러야**
    // 닫히고(오프라인) **눌러야** 받는다(업데이트) — 안 보이면 그 기능이 없는 것과 같다.
    name: "좌하단 배지가 다 뜬 화면 (사이드바 열림)",
    open: ["sidebar", "heat-legend", "update-badge", "offline-badge"],
    clickable: ["update-badge", "offline-badge",
      "toggle-list", "refresh", "tl-range", "arch-load"],
    // 범례는 `pointer-events: none` 이다(지도 조작을 막지 않는다) — 클릭으로는 못 잰다.
    // 그리고 **클릭을 받는 것만으로는 모자라다**: z-index 만 올리면 배지가 사이드바
    // *위에* 떠서 클릭은 되지만 **목록을 가린다.** 그래서 셋 다 "겹치지도 않는다"를 잰다.
    visible: ["heat-legend", "update-badge", "offline-badge"],
  },
  {
    // 임박 발사 카드(z-index 28)는 밀어낸 배지 자리와 겹친다 — 배지가 그 위에 온다.
    name: "배지 + 임박 발사 카드 (사이드바 열림)",
    open: ["sidebar", "update-badge", "offline-badge", "focus"],
    clickable: ["update-badge", "offline-badge", "tl-range", "arch-load"],
  },
  {
    // 위성을 고르면 뜨는 제어줄은 **좌하단 스택과 같은 열**이다(left 12 · bottom 62).
    name: "위성 제어줄 + 오프라인 배지",
    open: ["sat-ctrl", "offline-badge"],
    clickable: ["sat-track-btn", "sat-obs-btn", "sat-pass-btn", "sat-ctrl-close",
      "offline-badge", "tl-range"],
  },
  {
    name: "위성 제어줄 + 오프라인 배지 (사이드바 열림)",
    open: ["sidebar", "sat-ctrl", "offline-badge"],
    clickable: ["sat-track-btn", "sat-obs-btn", "sat-pass-btn", "sat-ctrl-close",
      "offline-badge", "toggle-list", "tl-range"],
  },
  {
    // 스택에 들어갈 수 있는 것이 **전부** 뜬 상태. 계단을 손으로 계산하던 때에는
    // 이 조합이 성립하지 않았다(겹쳐서 아래 것이 안 보였다).
    name: "좌하단 스택 전원 (사이드바 열림)",
    open: ["sidebar", "sat-ctrl", "offline-badge", "update-badge", "firstrun", "heat-legend"],
    clickable: ["sat-track-btn", "sat-ctrl-close", "offline-badge", "update-badge",
      // 스택은 위로 자란다 — 세로 상한이 없으면 **툴바를 덮는다**. 검색창이 그 첫 희생자다.
      "search", "toggle-list", "tl-range", "arch-load"],
    // **범례는 빠져 있다.** 다섯이 다 뜨면 900×600 에서는 세로가 모자라 스택이
    // 툴바 밑으로 넘치는데, 그때 희생되는 것이 **스택 맨 위**인 범례다(읽기 전용이라
    // 손실이 가장 작다 — 그게 순서를 이렇게 정한 이유다). 나머지 넷은 **조작 대상이라
    // 절대 안 잘린다**: 그걸 여기서 잰다.
    visible: ["firstrun", "update-badge", "offline-badge", "sat-ctrl",
      // 스택 **컨테이너**가 툴바 밑으로 파고들지 않는다 = 세로 상한이 살아 있다.
      "ui-stack"],
    // 스택은 자식 사이의 빈 곳으로 **지도를 계속 끌 수 있어야 한다**(P36-2).
    // `pointer-events: none` 을 빠뜨리면 투명한 사각형이 지도를 통째로 막는다.
    mapThrough: true,
    // 스택은 위로 자란다 — **세로 상한이 없으면 툴바 구역으로 파고든다**(실측 507×13).
    // 누가 위에 그려지든 둘이 겹치면 한쪽은 읽히지 않으므로, 방향을 따지지 않고 금지한다.
    noOverlap: [["ui-stack", "toolbar"]],
  },
  {
    // 관측 위치 팝오버(P13-6)는 화면 중앙 하단 — 타임라인·집중 화면과 같은 구역이다.
    name: "관측 위치 팝오버 (위성 제어줄·집중 화면과 함께)",
    open: ["obs-popover", "sat-ctrl", "focus"],
    clickable: ["obs-search", "obs-coord", "obs-map-btn", "sat-ctrl-close", "tl-range", "arch-load"],
  },
  {
    // 툴바 오버플로(P17-1)는 툴바 아래로 펼쳐진다 — 사이드바 탭과 같은 자리다.
    name: "툴바 오버플로 팝오버 (사이드바 열림)",
    open: ["sidebar", "toolbar-more"],
    clickable: ["basemap-btn", "stats-btn", "more-btn", "refresh",
      "tab-launches", "tab-tonight", "tl-range"],
  },
  {
    // 단축키 도움말(P12-14)은 화면 한가운데 — 무엇 위에든 떠야 한다.
    name: "단축키 도움말 (패널·사이드바와 함께)",
    open: ["sidebar", "panel", "keyhelp"],
    // 도움말은 닫기 버튼이 없다(아무 키나 누르면 닫힌다) — **가려지지만 않으면 된다.**
    clickable: [],
    visible: ["keyhelp"],
  },
];

/**
 * 비어 있으면 부피가 없는 것들에 **앱이 실제로 넣는 문구**를 넣는다.
 * 문구가 길어져 배지가 두 줄이 되면 겹침도 달라지므로, 여기를 실제와 맞춰 둔다.
 */
const FILL = {
  "heat-legend": '<div class="hl-title">🔥 발사 밀도</div><div class="hl-bar"></div>'
    + '<div class="hl-ends"><span>1건</span><span>한 발사장 최다 27건</span></div>'
    + '<p class="st-note">지금 지도에 보이는 2026년 발사 100건을 셉니다.</p>',
  "update-badge": '<span class="ub-text">⬆ 새 버전 v1.59.0 가 있습니다 (현재 v1.58.2) — 눌러서 받기</span>'
    + '<span class="ub-close">✕</span>',
  "offline-badge": "🌐 오프라인 — 배경 지도를 못 받았습니다 (발사·위성은 저장된 데이터)",
  "sat-ctrl-name": "ISS (ZARYA)",
  "firstrun": '<div class="fr-title">지금 지도에 2026년 발사 100건이 있습니다</div>'
    + '<div class="fr-row">위성을 켜면 실시간 위치가 함께 움직입니다</div>',
  "obs-popover": '<div class="obs-head">📍 관측 위치</div><div class="obs-cur">아직 정하지 않았습니다</div>'
    + '<input id="obs-search" class="obs-input" type="text" placeholder="도시 · 발사장 이름 (예: 서울)" />'
    + '<div id="obs-results" class="obs-results"></div>'
    + '<input id="obs-coord" class="obs-input" type="text" placeholder="좌표 직접 입력" />'
    + '<div class="obs-btns"><button id="obs-map-btn" class="btn sm">지도에서 클릭</button></div>',
  "keyhelp": '<div class="kh-head">⌨ 단축키</div>'
    + '<div class="kh-row"><kbd>/</kbd><span>검색</span></div>'
    + '<div class="kh-row"><kbd>Esc</kbd><span>열린 패널 닫기</span></div>'
    + '<div class="kh-foot">아무 키나 누르면 닫힙니다</div>',
  "focus": '<div class="focus-head">🚀 발사 임박</div><div class="focus-cd">T-00:12:34</div>'
    + '<div class="focus-name">Falcon 9 Block 5 | Starlink Group 15-27</div>',
};

/** 앱이 실제로 허용하는 창 크기. 900x600 은 `main.py` 의 `min_size` 다. */
const SIZES = [[900, 600], [1024, 700], [1280, 800], [1920, 1080]];

function buildPage(open) {
  let html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  const css = fs.readFileSync(path.join(WEB, "style.css"), "utf8");
  const utils = fs.readFileSync(path.join(WEB, "js", "utils.js"), "utf8");

  html = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<link[^>]*>/g, "");
  for (const id of open) {
    const re = new RegExp('(id="' + id + '"[^>]*class="[^"]*?) hidden(")');
    html = html.replace(re, "$1$2");
  }
  // 사이드바 목록은 스크롤이 생길 만큼 채운다 — 빈 목록은 실제 높이를 대변하지 않는다.
  html = html.replace(
    '<div id="sidebar-list" class="sidebar-list">',
    '<div id="sidebar-list" class="sidebar-list"><div style="height:1200px">행</div>',
  );
  // 위성 그룹 팝오버는 JS 가 채운다 — 실제와 비슷한 부피만 준다.
  html = html.replace(
    '<div id="sat-groups" class="sat-groups">',
    '<div id="sat-groups" class="sat-groups"><label>그룹</label><label>그룹</label><label>그룹</label>',
  );
  // 배지·카드는 JS 가 문구를 넣어야 부피가 생긴다 — **실제로 넣는 문구**를 쓴다
  // (빈 배지는 높이 18px 이라 아무 것도 안 겹친다: 그렇게 재면 전부 초록이다).
  for (const [id, inner] of Object.entries(FILL)) {
    html = html.replace(new RegExp('(<[a-z]+ id="' + id + '"[^>]*>)'), "$1" + inner);
  }
  // 사이드바가 열린 상태는 body 클래스로 온다(P35-1 · `toggleSidebar` 가 건다).
  if (open.includes("sidebar")) html = html.replace("<body>", '<body class="sidebar-open">');

  const probe = [
    "<style>", css, "</style>",
    "<script>", utils, "</script>",
    "<script>",
    "(function(){",
    "  syncUiTop();",   // 실제 앱과 같은 경로로 --ui-top 을 잡는다
    "  var out = [], vw = innerWidth, vh = innerHeight;",
    "  (window.__CLICKABLE || []).forEach(function(id){",
    "    var el = document.getElementById(id);",
    "    if (!el) { out.push({id: id, problem: '요소가 없다'}); return; }",
    "    var r = el.getBoundingClientRect();",
    "    if (r.width === 0 || r.height === 0) { out.push({id: id, problem: '크기가 0 이다'}); return; }",
    "    if (r.left < 0 || r.top < 0 || r.right > vw || r.bottom > vh) {",
    "      out.push({id: id, problem: '화면 밖으로 나갔다'}); return;",
    "    }",
    "    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;",
    "    var hit = document.elementFromPoint(cx, cy);",
    "    if (hit === el || el.contains(hit)) return;",
    "    var owner = hit;",
    "    while (owner && !owner.id) owner = owner.parentElement;",
    "    out.push({id: id, problem: '가려졌다 → ' + (owner ? '#' + owner.id : '알 수 없음')});",
    "  });",
    "  var COVERS = ['sidebar', 'panel', 'toolbar', 'sat-groups'];",
    "  (window.__VISIBLE || []).forEach(function(id){",
    "    var el = document.getElementById(id);",
    "    if (!el) { out.push({id: id, problem: '요소가 없다'}); return; }",
    "    var r = el.getBoundingClientRect();",
    "    if (r.width === 0 || r.height === 0) { out.push({id: id, problem: '크기가 0 이다'}); return; }",
    "    COVERS.forEach(function(oid){",
    "      var other = document.getElementById(oid);",
    "      if (!other || other === el || other.classList.contains('hidden')) return;",
    "      var o = other.getBoundingClientRect();",
    "      if (o.width === 0 || o.height === 0) return;",
    "      var ow = Math.min(r.right, o.right) - Math.max(r.left, o.left);",
    "      var oh = Math.min(r.bottom, o.bottom) - Math.max(r.top, o.top);",
    "      if (ow <= 2 || oh <= 2) return;",
    // 겹쳤다고 다 못 읽는 것은 아니다 — **상대가 위에 그려질 때만** 가려진다.
    // 단축키 도움말(z-index 40)은 일부러 무엇 위에든 뜨므로 겹쳐도 읽힌다.
    "      var za = +getComputedStyle(el).zIndex || 0, zb = +getComputedStyle(other).zIndex || 0;",
    "      var overMe = za !== zb ? zb > za",
    "        : !!(el.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING);",
    "      if (!overMe) return;",
    "      out.push({id: id, problem: '#' + oid + ' 와 ' +",
    "        Math.round(ow) + 'x' + Math.round(oh) + ' 겹쳐 읽을 수 없다'});",
    "    });",
    "  });",
    "  (window.__NO_OVERLAP || []).forEach(function(pair){",
    "    var a = document.getElementById(pair[0]), b = document.getElementById(pair[1]);",
    "    if (!a || !b) { out.push({id: pair.join('+'), problem: '요소가 없다'}); return; }",
    "    var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();",
    "    if (ra.width === 0 || rb.width === 0) return;",
    "    var ow = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);",
    "    var oh = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);",
    "    if (ow > 2 && oh > 2) out.push({id: pair[0], problem: '#' + pair[1] + ' 의 구역을 ' +",
    "      Math.round(ow) + 'x' + Math.round(oh) + ' 침범했다'});",
    "  });",
    "  if (window.__MAP_THROUGH) {",
    "    var stack = document.getElementById('ui-stack');",
    "    var kids = stack ? Array.prototype.filter.call(stack.children, function(c){",
    "      var b = c.getBoundingClientRect(); return b.width > 0 && b.height > 0; }) : [];",
    "    if (kids.length < 2) { out.push({id: 'ui-stack', problem: '자식이 둘 미만이라 못 쟀다'}); }",
    "    else {",
    "      var a = kids[0].getBoundingClientRect(), b = kids[1].getBoundingClientRect();",
    "      var gx = a.left + 4, gy = (a.top + b.bottom) / 2;",
    "      var hit = document.elementFromPoint(gx, gy);",
    "      var oid = hit ? (hit.id || (hit.parentElement && hit.parentElement.id) || hit.tagName) : 'null';",
    "      if (hit && hit.id !== 'map' && !(hit.closest && hit.closest('#map'))) {",
    "        out.push({id: 'ui-stack', problem: '자식 사이 빈 곳이 지도를 막는다 → #' + oid});",
    "      }",
    "    }",
    "  }",
    "  var pre = document.createElement('pre');",
    "  pre.id = 'RESULT';",
    "  pre.textContent = JSON.stringify(out);",
    "  document.body.appendChild(pre);",
    "})();",
    "</script>",
  ].join("\n");

  return html.replace("</body>", probe + "\n</body>");
}

function measure(edge, page, clickable, visible, mapThrough, noOverlap, [w, h]) {
  // 한글 사용자명 경로(`C:\Users\준\`)를 Edge 에 넘기면 `ERR_FILE_NOT_FOUND` 가 난다
  // (2026-09-23 실측 — 인코딩해도 마찬가지였다). ASCII 경로에 쓴다.
  const dir = fs.mkdtempSync(path.join("C:\\Users\\Public", "rl3d-layout-"));
  const file = path.join(dir, "page.html");
  const withList = page.replace(
    "(function(){\n  syncUiTop();",
    "window.__CLICKABLE = " + JSON.stringify(clickable) + ";\n"
    + "window.__VISIBLE = " + JSON.stringify(visible || []) + ";\n"
    + "window.__MAP_THROUGH = " + (mapThrough ? "true" : "false") + ";\n"
    + "window.__NO_OVERLAP = " + JSON.stringify(noOverlap || []) + ";\n(function(){\n  syncUiTop();",
  );
  fs.writeFileSync(file, withList, "utf8");
  try {
    const dom = execFileSync(edge, [
      "--headless=new", "--disable-gpu", "--hide-scrollbars",
      "--window-size=" + w + "," + h,
      "--virtual-time-budget=3000",
      "--dump-dom", "file:///" + file.replace(/\\/g, "/"),
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60000 });
    const m = /<pre id="RESULT">([\s\S]*?)<\/pre>/.exec(dom);
    if (!m) throw new Error("측정 결과가 없다 (페이지가 안 떴다)");
    return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── 실행 ──────────────────────────────────────────────────────────────────────
const edge = findEdge();
if (!edge) {
  console.log("Edge 를 찾지 못해 레이아웃 테스트를 건너뜁니다 (" + os.platform() + ")");
  process.exit(0);
}

let pass = 0;
const failures = [];
for (const c of CASES) {
  console.log("\n" + c.name);
  const page = buildPage(c.open);
  for (const size of SIZES) {
    const label = size[0] + "x" + size[1];
    let problems;
    try {
      problems = measure(edge, page, c.clickable, c.visible, c.mapThrough,
        c.noOverlap, size);
    } catch (e) {
      failures.push(c.name + " " + label + " — 측정 실패: " + e.message);
      console.log("  FAIL " + label + " — 측정 실패: " + e.message);
      continue;
    }
    if (problems.length === 0) {
      pass++;
      console.log("  OK   " + label + " — 대상 " + (c.clickable.length + (c.visible || []).length) + "개가 전부 제 몫을 한다");
    } else {
      const lines = problems.map((p) => "#" + p.id + ": " + p.problem).join(" · ");
      failures.push(c.name + " " + label + " — " + lines);
      console.log("  FAIL " + label + " — " + lines);
    }
  }
}

console.log("\n" + pass + " passed, " + failures.length + " failed");
if (failures.length) process.exit(1);
