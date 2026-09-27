/* 문서 회귀 테스트 (P32) — 문서가 코드와 같은 말을 하는가.
 *
 *     node tests/test_docs.js
 *
 * **사람이 기억해서 고치는 규칙은 또 어긋난다.** 실제로 이 리포에서:
 *   · 끝난 Phase **12개**의 제목이 `착수 전` 인 채로 남아 한 절이 스스로 모순됐다
 *   · `CLAUDE.md` 가 *"UI 로직 22개 파일"* 이라 적었는데 실제는 23개였고, 빠진
 *     `errors.js` 는 하필 **로드 순서 맨 앞**이었다 — 순서를 지키라는 문장이 틀린 순서를 보여줬다
 *   · `README` 에 `python tests/test_cache.py` 실행법이 빠져 있었다
 *
 * 여기서 재는 것은 **이름·개수·존재·명령**뿐이다. *"이 설명이 지금도 옳은 설명인가"* 는
 * 기계가 못 잰다 — 그건 여전히 사람이 읽어야 한다.
 */
const fs = require("fs");
const path = require("path");
const { group, check, done } = require("./harness");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const PLAN = read("PLAN.md");
const CLAUDE = read("CLAUDE.md");
const README = read("README.md");
const HTML = read("web/index.html");
const JS_FILES = fs.readdirSync(path.join(ROOT, "web", "js")).filter((f) => f.endsWith(".js"));

// ── 계획서: 끝난 Phase 는 제목도 끝났다고 말해야 한다 ────────────────────────
{
  group("계획서의 제목이 본문과 같은 말을 한다 (P32-1)");
  const lines = PLAN.split("\n");
  const heads = [];
  lines.forEach((l, i) => { if (/^### Phase \d+ — /.test(l)) heads.push(i); });
  const contradictions = [];
  heads.forEach((start, n) => {
    const end = n + 1 < heads.length ? heads[n + 1] : lines.length;
    const num = lines[start].match(/^### Phase (\d+) —/)[1];
    const body = lines.slice(start, end).join("\n");
    const finished = body.includes("**Phase " + num + " 끝");
    const titleSaysTodo = /— 착수 전/.test(lines[start]);
    if (finished && titleSaysTodo) contradictions.push("Phase " + num);
  });
  check("끝 블록이 있는데 제목이 '착수 전' 인 절", contradictions, []);
  check("Phase 절을 실제로 찾았다(정규식이 헛돌지 않았다)", heads.length > 10, true);
}

// ── CLAUDE.md: 파일 표가 실제 트리와 같아야 한다 ────────────────────────────
{
  group("CLAUDE.md 의 파일 표 (P32-2)");
  const m = CLAUDE.match(/UI 로직 (\d+)개 파일: ([^|]+)/);
  check("파일 개수를 적어 둔 줄이 있다", !!m, true);
  if (m) {
    check("적어 둔 개수가 실제와 같다", Number(m[1]), JS_FILES.length);
    // 이 줄은 **로드 순서**를 말하는 줄이다 — 순서가 틀리면 "순서를 지켜야 한다"는
    // 문장 자체가 거짓이 된다. `index.html` 이 정답지다(앱이 실제로 읽는 순서).
    // 순서는 `a` → `b` → … 로 적혀 있다. 그 사슬까지만 읽는다 — 뒤 설명 문장에도
    // 백틱이 있어서(`let`·`function`), 줄 전체를 긁으면 그것들이 파일 이름으로 들어온다.
    const chain = (m[2].split(".")[0] || "");
    const doc = (chain.match(/`([\w-]+)`/g) || []).map((x) => x.slice(1, -1) + ".js");
    const real = [...HTML.matchAll(/js\/([\w-]+\.js)/g)].map((x) => x[1]);
    check("적어 둔 순서가 index.html 과 같다", doc, real);
  }
  // 표에 적은 파일이 실제로 있어야 한다(이름이 바뀌면 여기서 걸린다).
  const rows = CLAUDE.split("\n").filter((l) => /^\| `?[\w./]+\.(py|js|css|html|bat|spec|md)`? *\|/.test(l));
  // **생성물은 빼고 본다.** `RL3D.spec` 은 빌드가 만들고 커밋하지 않는다 — 문서가 그 줄에
  // *"생성물"* 이라고 적어 뒀다. 로컬에는 있고 **CI 체크아웃에는 없어서**, 이 검사를 처음
  // 올린 날 CI 가 바로 빨개졌다(로컬만 보고 만든 검사였다).
  const missing = rows
    .filter((r) => !r.includes("생성물"))
    .map((r) => r.match(/^\| `?([\w./]+)`?/)[1])
    .filter((f) => !f.includes("*") && !fs.existsSync(path.join(ROOT, f)));
  check("표에 적힌 파일이 전부 실재한다(생성물 제외)", missing, []);
  check("표를 실제로 찾았다", rows.length > 5, true);
}

// ── README: 실행·검증 명령이 빠지지 않았다 ──────────────────────────────────
{
  group("README 의 실행·검증 명령");
  // 새 테스트를 만들고 README 에 안 적으면, 다음 사람은 **그게 있는 줄도 모른다.**
  const musts = ["python main.py", "build.bat", "python api_client.py",
                 "node tests/test_frontend.js", "python tests/test_parsing.py",
                 "python tests/test_cache.py", "node tests/test_docs.js",
                 "node tests/test_layout.js"];
  check("README 에 빠진 명령", musts.filter((c) => !README.includes(c)), []);
  check("CLAUDE.md 에 빠진 명령", musts.filter((c) => !CLAUDE.includes(c)), []);
  // CI 가 안 돌리면 초록은 로컬에서만 초록이다(2026-09-12 에 실제로 다섯 커밋 동안 갈렸다).
  const ci = read(".github/workflows/tests.yml");
  const ciMusts = ["python tests/test_parsing.py", "python tests/test_cache.py",
                   "node tests/test_frontend.js", "node tests/test_docs.js",
                   "node tests/test_layout.js"];
  check("CI 워크플로에 빠진 테스트", ciMusts.filter((c) => !ci.includes(c)), []);
}

// ── 제어 문자: 셸에서 파일을 쓰다 백슬래시가 먹힌 흔적 ─────────────────────────
// 이 PC 의 Bash 는 **인용 heredoc 에서도** `\b` 를 백스페이스(0x08)로 바꾼다. 2026-09-24 에
// `build.bat` 의 `tools\build_licenses.py` 가 `tools<0x08>uild_licenses.py` 로 커밋돼
// **빌드가 깨진 채** 세 커밋·약 7시간을 지나갔다(빌드를 안 돌려 몰랐다). 문서 둘에도 같은 흔적이 있었다.
// 사람이 기억하는 규칙(메모리)은 이미 있었는데 네 번째로 당했다 — 그래서 여기서 잰다.
{
  group("텍스트 파일에 제어 문자가 없다");
  const EXT = /\.(py|js|bat|md|json|html|css|txt|yml|spec)$/;
  const SKIP = new Set(["node_modules", ".venv", "build", "dist", "lib", ".git", "__pycache__"]);
  const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = dir ? dir + "/" + e.name : e.name;
    if (e.isDirectory()) return SKIP.has(e.name) ? [] : walk(rel);
    return EXT.test(e.name) ? [rel] : [];
  });
  const files = walk("");
  // 목록이 비면 검사도 0건으로 초록이다 — 대상 수를 먼저 단언한다
  check("훑은 파일이 충분하다(대상이 비면 검사가 공허하다)", files.length > 40, true);
  const bad = files.filter((f) => /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(read(f)));
  check("제어 문자가 든 파일", bad, []);
}

// ── 아이콘만 있는 버튼에는 이름이 있다 (P52) ──────────────────────────────────
// 2026-09-24 실측: 버튼 43개 중 닫기(✕) 넷이 `title`·`aria-label` 없이 글자 하나뿐이었다 —
// 화면 읽기 프로그램은 "버튼"이라고만 읽고 마우스를 올려도 설명이 안 뜬다. 같은 앱의 다른
// 닫기 버튼(`sat-ctrl-close`·`focus-close`)에는 있었다. 한쪽만 고친 자리는 조용히 남는다.
{
  group("아이콘 버튼의 이름");
  const srcs = [["web/index.html", HTML]].concat(JS_FILES.map((f) => ["web/js/" + f, read("web/js/" + f)]));
  let total = 0;
  const bad = [];
  for (const [f, s] of srcs) {
    const re = /<button\b([^>]*)>([\s\S]*?)<\/button>/g;
    let m;
    while ((m = re.exec(s))) {
      total++;
      const inner = m[2].replace(/<[^>]+>/g, "").replace(/\$\{[^}]*\}/g, "X").trim();
      const named = /\b(title|aria-label)=/.test(m[1]);
      if (!named && !/[A-Za-z가-힣0-9X]/.test(inner)) bad.push(f + " " + (m[1].match(/id="([^"]+)"/) || [, inner])[1]);
    }
  }
  // 버튼을 못 찾으면 이름 없는 버튼도 0개로 초록이다 — 찾은 수부터 단언한다
  check("버튼을 충분히 찾았다(정규식이 빗나가면 검사가 공허하다)", total >= 30, true);
  check("글자·숫자 없이 기호뿐인데 이름도 없는 버튼", bad, []);
}

// ── 누르라고 생긴 것은 키보드로도 닿는다 (P53) ────────────────────────────────
// 2026-09-27 실측: `cursor: pointer` 규칙 21개가 가리키는 요소 중 업데이트 배지의 두 칸
// (`ub-text` 받기 · `ub-close` 닫기)만 `<span>` 이었다 — Tab 으로 못 가고 Enter 가 안 먹는다.
// P52 는 `<button>` 만 훑어서 이 둘을 대상 밖으로 남겼다. 마우스 커서가 "눌러라"고 말하는
// 자리를 CSS 에서 모아, 그 클래스·id 를 단 요소가 조작 요소인지 잰다.
{
  group("누르는 요소가 키보드로 닿는다");
  const CSS = read("web/style.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const OK_TAGS = new Set(["button", "a", "input", "select", "label", "summary", "textarea"]);
  const targets = new Set();
  const ruleRe = /([^{}]+)\{([^}]*)\}/g;
  let r;
  while ((r = ruleRe.exec(CSS))) {
    if (!/cursor:\s*pointer/.test(r[2])) continue;
    for (const sel of r[1].split(",")) {
      const last = sel.trim().split(/[\s>+~]+/).pop().replace(/:.*$/, "");
      const cls = last.match(/\.([\w-]+)$/);
      const id = last.match(/#([\w-]+)/);
      if (cls) targets.add("." + cls[1]); else if (id) targets.add("#" + id[1]);
    }
  }
  const srcs = [["web/index.html", HTML]].concat(JS_FILES.map((f) => ["web/js/" + f, read("web/js/" + f)]));
  let found = 0;
  const bad = [];
  for (const t of targets) {
    const name = t.slice(1).replace(/-/g, "\\-");
    const attr = t[0] === "." ? `class="[^"]*(?<![\\w-])${name}(?![\\w-])` : `id="${name}"`;
    const re = new RegExp(`<(\\w+)\\b[^>]*${attr}`, "g");
    for (const [f, s] of srcs) {
      let m;
      while ((m = re.exec(s))) {
        found++;
        if (!OK_TAGS.has(m[1].toLowerCase())) bad.push(`${f} <${m[1]}> ${t}`);
      }
    }
  }
  // 규칙이나 요소를 못 찾으면 위반도 0건으로 초록이다 — 찾은 수부터 단언한다
  check("포인터 커서 규칙을 충분히 찾았다", targets.size >= 15, true);
  check("그 규칙이 가리키는 요소를 충분히 찾았다", found >= 20, true);
  check("포인터 커서인데 조작 요소(button·a·input·label…)가 아닌 것", bad, []);
}

// ── 떠 있는 요소는 레이아웃 장면에 들어 있다 (P61) ─────────────────────────────
// 겹침 검사(`test_layout`)는 **장면에 넣은 요소끼리만** 본다. 두 번 연속 여기서 샜다 —
// 상태 알림이 첫 실행 카드의 `나중에` 를 덮었고(P60), 오류 알림 띠가 툴바를 31~68px 덮었다(P61).
// 둘 다 `position: absolute` 인데 어느 장면에도 없었다. CSS 에서 떠 있는 요소를 모아 장면과 대조한다.
{
  group("떠 있는 요소가 레이아웃 장면에 있다");
  const CSS = read("web/style.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const LAYOUT = read("tests/test_layout.js");
  // 늘 떠 있는 바탕·틀이라 장면으로 "여는" 대상이 아닌 것 — 사유 필수
  const ALWAYS = {
    map: "바탕 지도 — 다른 요소가 그 위에 뜬다",
    toolbar: "늘 보인다 — 장면마다 툴바 버튼을 clickable 로 잰다",
    "ui-stack": "좌하단 스택 컨테이너 — 자식들을 연다",
    timeline: "늘 보인다 — 장면마다 tl-range·arch-load 를 잰다",
    "pass-panel": "`.panel` 과 같은 자리(openRightPanel 이 하나만 연다) — panel 장면이 잰다",
    "stats-panel": "`.panel` 과 같은 자리 — panel 장면이 잰다",
  };
  const sels = [];
  const ruleRe = /([^{}]+)\{([^}]*)\}/g;
  let r;
  while ((r = ruleRe.exec(CSS))) {
    if (!/position:\s*(absolute|fixed)/.test(r[2])) continue;
    for (const sel of r[1].split(",")) sels.push(sel.trim().split(/[\s>+~]+/).pop().replace(/:.*$/, ""));
  }
  const opened = new Set();
  for (const o of LAYOUT.match(/open:\s*\[[^\]]*\]/g) || []) {
    for (const x of o.match(/"([^"]+)"/g) || []) opened.add(x.slice(1, -1));
  }
  const floating = new Set();
  const tagRe = /<\w+\b[^>]*\bid="([^"]+)"[^>]*>/g;
  let m;
  while ((m = tagRe.exec(HTML))) {
    const cls = ((m[0].match(/class="([^"]*)"/) || [, ""])[1]).split(/\s+/);
    // 패널 **안**의 닫기 버튼처럼 부모 기준으로 뜨는 것은 제외 — 최상위 오버레이만 본다
    if (sels.some((s) => s === "#" + m[1] || (s.startsWith(".") && cls.includes(s.slice(1))))
        && !/-close$/.test(m[1])) floating.add(m[1]);
  }
  // 좌하단 스택의 자식은 CSS 로는 안 떠 있지만(스택이 쌓는다) 서로 밀고 잘린다 — 같이 잰다.
  // 상태 알림을 스택으로 옮긴 뒤(P60) 이 줄이 없으면 장면에서 빠져도 조용했다(변이로 확인).
  const stack = (HTML.match(/<div id="ui-stack"[\s\S]*?\n  <\/div>/) || [""])[0];
  const stackKids = (stack.match(/\n    <\w+\b[^>]*\bid="([^"]+)"/g) || []).map((t) => t.match(/id="([^"]+)"/)[1]);
  check("스택 자식을 충분히 찾았다", stackKids.length >= 5, true);
  stackKids.forEach((id) => floating.add(id));
  check("떠 있는 요소를 충분히 찾았다(정규식이 빗나가면 검사가 공허하다)", floating.size >= 12, true);
  check("장면을 충분히 찾았다", opened.size >= 10, true);
  const missing = [...floating].filter((id) => !opened.has(id) && !ALWAYS[id]);
  check("어느 레이아웃 장면에도 없는 떠 있는 요소", missing, []);
  // 허용 목록이 낡으면 조용히 넓어진다 — 없어진 id 는 목록에서도 지운다
  check("허용 목록의 id 가 전부 실제로 있다", Object.keys(ALWAYS).filter((id) => !floating.has(id)), []);
}

// ── 버전: 세 곳이 같은 버전을 말한다 ────────────────────────────────────────
{
  group("버전 표기");
  const ver = (read("main.py").match(/__version__ = "([\d.]+)"/) || [])[1];
  check("main.py 에 버전이 있다", !!ver, true);
  // 버전을 올리면서 CHANGELOG 를 빠뜨리면, 릴리스 노트를 쓸 때가 되어서야 안다.
  check("CHANGELOG 에 그 버전의 절이 있다", read("CHANGELOG.md").includes("## [" + ver + "]"), true);
  check("PLAN 머리글이 그 버전을 말한다", PLAN.slice(0, 400).includes(ver), true);
}

// ── 문서 수치 ↔ 코드 상수 (전면 감사 2026-09-24) ─────────────────────────────
// 문서에 적힌 TTL·주기·상한은 **바뀌어도 아무도 모른다** — P47 에서 TTL 을 15분 → 6시간으로
// 바꿔도 테스트가 전부 초록이었다. 문구와 상수를 쌍으로 두고 값이 같은지 잰다.
// 상수식은 숫자와 * 만 허용한다(15 * 60 같은 것) — 그 밖의 식이면 대조표를 고친다.
{
  group("문서 수치 ↔ 코드 상수");
  const constSec = (file, name) => {
    const m = new RegExp("^\\s*(?:const\\s+)?" + name + "\\s*=\\s*([\\d\\s*]+)", "m").exec(read(file));
    if (!m) return null;
    return m[1].split("*").reduce((a, x) => a * Number(x.trim()), 1);
  };
  // [설명, 문서 문자열, 문구 정규식(첫 캡처 = 숫자), 단위(초), 코드 파일, 상수, 상수 단위(초)]
  const PAIRS = [
    ["README 표 · 발사 TTL", README, /\| 발사 \|[^\n]*\| (\d+)분 \|/, 60, "api_client.py", "TTL_LAUNCHES", 1],
    ["README 표 · TLE TTL", README, /\| 위성 TLE \|[^\n]*\| (\d+)시간 \|/, 3600, "api_client.py", "TTL_TLE", 1],
    ["CLAUDE · 발사 TTL", CLAUDE, /TTL: 발사 (\d+)분/, 60, "api_client.py", "TTL_LAUNCHES", 1],
    ["CLAUDE · TLE TTL", CLAUDE, /TTL: 발사 \d+분 \/ TLE (\d+)시간/, 3600, "api_client.py", "TTL_TLE", 1],
    ["README · 자동 갱신 주기", README, /(\d+)분마다 백그라운드 폴링/, 60, "web/js/state.js", "AUTO_REFRESH_MS", 0.001],
    ["CLAUDE · 폴링 주기", CLAUDE, /프론트는 (\d+)분마다 폴링/, 60, "web/js/state.js", "AUTO_REFRESH_MS", 0.001],
    ["CLAUDE · 아카이브 페이지 상한", CLAUDE, /연도당 최대\s*(\d+)페이지/, 1, "api_client.py", "ARCHIVE_MAX_PAGES", 1],
    ["CLAUDE · 강제 갱신 간격", CLAUDE, /강제 갱신 최소 간격 (\d+)초/, 1, "api_client.py", "FORCE_MIN_INTERVAL", 1],
    ["README · 새로고침 간격", README, /방금\((\d+)초 안\)/, 1, "api_client.py", "FORCE_MIN_INTERVAL", 1],
  ];
  for (const [label, doc, re, unit, file, name, cunit] of PAIRS) {
    const m = re.exec(doc);
    const code = constSec(file, name);
    // 문구나 상수를 못 찾으면 null 로 실패한다 — 못 찾은 것을 통과로 두면 이 표가 공허해진다
    check(`${label}: 문서 ${m ? m[1] : "문구 없음"} ↔ ${name}`,
      m && code != null ? Number(m[1]) * unit : "문서 문구 없음",
      code != null ? code * cunit : "상수 없음");
  }
}

done(26);   // 건수 하한 — 2026-09-24 실측(+ 제어 문자 2 + 아이콘 버튼 2)
