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
];

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
    "  var pre = document.createElement('pre');",
    "  pre.id = 'RESULT';",
    "  pre.textContent = JSON.stringify(out);",
    "  document.body.appendChild(pre);",
    "})();",
    "</script>",
  ].join("\n");

  return html.replace("</body>", probe + "\n</body>");
}

function measure(edge, page, clickable, [w, h]) {
  // 한글 사용자명 경로(`C:\Users\준\`)를 Edge 에 넘기면 `ERR_FILE_NOT_FOUND` 가 난다
  // (2026-09-23 실측 — 인코딩해도 마찬가지였다). ASCII 경로에 쓴다.
  const dir = fs.mkdtempSync(path.join("C:\\Users\\Public", "rl3d-layout-"));
  const file = path.join(dir, "page.html");
  const withList = page.replace(
    "(function(){\n  syncUiTop();",
    "window.__CLICKABLE = " + JSON.stringify(clickable) + ";\n(function(){\n  syncUiTop();",
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
      problems = measure(edge, page, c.clickable, size);
    } catch (e) {
      failures.push(c.name + " " + label + " — 측정 실패: " + e.message);
      console.log("  FAIL " + label + " — 측정 실패: " + e.message);
      continue;
    }
    if (problems.length === 0) {
      pass++;
      console.log("  OK   " + label + " — 조작 대상 " + c.clickable.length + "개가 전부 클릭을 받는다");
    } else {
      const lines = problems.map((p) => "#" + p.id + ": " + p.problem).join(" · ");
      failures.push(c.name + " " + label + " — " + lines);
      console.log("  FAIL " + label + " — " + lines);
    }
  }
}

console.log("\n" + pass + " passed, " + failures.length + " failed");
if (failures.length) process.exit(1);
