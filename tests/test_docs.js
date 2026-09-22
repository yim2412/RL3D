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
  const missing = rows
    .map((r) => r.match(/^\| `?([\w./]+)`?/)[1])
    .filter((f) => !f.includes("*") && !fs.existsSync(path.join(ROOT, f)));
  check("표에 적힌 파일이 전부 실재한다", missing, []);
  check("표를 실제로 찾았다", rows.length > 5, true);
}

// ── README: 실행·검증 명령이 빠지지 않았다 ──────────────────────────────────
{
  group("README 의 실행·검증 명령");
  // 새 테스트를 만들고 README 에 안 적으면, 다음 사람은 **그게 있는 줄도 모른다.**
  const musts = ["python main.py", "build.bat", "python api_client.py",
                 "node tests/test_frontend.js", "python tests/test_parsing.py",
                 "python tests/test_cache.py", "node tests/test_docs.js"];
  check("README 에 빠진 명령", musts.filter((c) => !README.includes(c)), []);
  check("CLAUDE.md 에 빠진 명령", musts.filter((c) => !CLAUDE.includes(c)), []);
  // CI 가 안 돌리면 초록은 로컬에서만 초록이다(2026-09-12 에 실제로 다섯 커밋 동안 갈렸다).
  const ci = read(".github/workflows/tests.yml");
  const ciMusts = ["python tests/test_parsing.py", "python tests/test_cache.py",
                   "node tests/test_frontend.js", "node tests/test_docs.js"];
  check("CI 워크플로에 빠진 테스트", ciMusts.filter((c) => !ci.includes(c)), []);
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

done();
