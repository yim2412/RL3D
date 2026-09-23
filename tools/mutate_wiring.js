/*
 * 배선·타이머 변이 점검 (P39 · P40 지도 · P41 타이머) — **정기 점검용 도구다. CI 에는 넣지 않는다**(파일을
 * 잠시 고쳤다 되돌리므로 다른 작업과 겹치면 안 된다).
 *
 * `bindUI()` 의 정적 배선은 `tests/test_frontend.js` 가 전수로 잰다(WIRING·PRESSES).
 * 그런데 **화면을 그리면서 붙는 배선**(`innerHTML` 로 만든 버튼에 그 자리에서
 * `addEventListener`)은 한 번도 전수로 재지 않았다 — 2026-09-23 에 재 봤더니
 * **25개 중 22개가 지워도 전부 초록**이었다. 관심 버튼·임박 발사 카드·관측 위치
 * 팝오버·위성 필터·통계 링크·배지 닫기가 통째로 죽어도 아무 일도 없었다.
 *
 * 재는 것: `addEventListener(` · **`map.on(`** · **`setInterval(`** 셋. 지도 쪽은 P40 에서 더했는데,
 * 그때 17개 중 **9개가 지워도 초록**이었다 — 위성을 눌러 고르는 것 · 지도를 옮긴 뒤
 * 위치를 저장하는 것 · 끌면 추적이 풀리는 것 · 커서 모양 넷.
 *
 * 쓰는 법:  node tools/mutate_wiring.js
 * 기대값:   "잡힘 51 / 못 잡음 0" — 못 잡는 줄이 나오면 그게 곧 다음 할 일이다.
 *
 * ⚠ 이 도구 자체가 한 번 틀렸다: 테스트가 **예외로 죽는 경우**를 "못 잡음"으로 세어
 *   결과를 뒤집었다. 요약 줄이 없으면 종료 코드로 판정한다.
 */
const fs = require("fs"), path = require("path"), cp = require("child_process");
const ROOT = "C:/Users/준/Desktop/RL3D";
const files = fs.readdirSync(path.join(ROOT, "web/js")).filter((f) => f.endsWith(".js"));
const PROGRESS_FILE = path.join(require("os").homedir(), ".claude", "bg-progress.txt");


/**
 * 터미널 상태줄에 진행률을 흘려 보낸다(~/.claude/bg-progress.txt 의 첫 줄).
 *
 * **백그라운드 작업은 터미널에 아무것도 안 띄운다.** 모델이 응답을 끝내면 화면이 조용해져
 * *"멈춘 것"* 처럼 보이는데, 실제로는 돌고 있다 — 그 간극을 메우는 줄이다.
 * 상태줄 스크립트가 10분 지난 파일을 무시하므로, 끝나면 지우되 못 지워도 거짓말은 안 된다.
 */
function reportProgress(done, total, missed) {
  try {
    const pct = Math.round((done / total) * 100);
    // 남은 시간은 **지금까지 실제로 걸린 시간**에서 낸다(고정 상수를 박지 않는다 —
    // 테스트가 늘면 한 건당 시간도 늘고, 그때 박아 둔 값은 거짓말이 된다).
    const perCase = (Date.now() - startedAt) / 1000 / Math.max(1, done);
    const left = Math.max(0, Math.round(((total - done) * perCase) / 60));
    fs.writeFileSync(PROGRESS_FILE,
      `배선 변이 ${done}/${total} (${pct}%) · 미검출 ${missed} · 남음 약 ${left}분
`, "utf8");
  } catch (_) { /* 진행 표시가 작업을 막지는 않는다 */ }
}

const startedAt = Date.now();

const targets = [];
for (const f of files) {
  const p = path.join(ROOT, "web/js", f);
  const lines = fs.readFileSync(p, "utf8").split("\n");
  lines.forEach((ln, i) => {
    if (!/addEventListener\(|\bmap\.on\(|\bsetInterval\(/.test(ln)) return;
    if (/^\s*(\/\/|\*|\/\*)/.test(ln)) return;   // 주석 줄(블록 주석 포함)은 대상이 아니다
    if (/document\.addEventListener|window\.addEventListener/.test(ln)) return;
    targets.push({ file: f, path: p, idx: i, text: ln.trim().slice(0, 72) });
  });
}
console.log(`동적 배선 ${targets.length}개를 하나씩 무력화한다\n`);

const caught = [], missed = [];
for (const t of targets) {
  const orig = fs.readFileSync(t.path, "utf8");
  const lines = orig.split("\n");
  // addEventListener 호출만 무력화한다(구문이 깨지지 않게 이름만 바꾼다)
  lines[t.idx] = lines[t.idx].replace(/addEventListener\(/g, "__noWire(")
    .replace(/\bmap\.on\(/g, "__noWire(").replace(/\bsetInterval\(/g, "__noWire(");
  const patched = lines.join("\n");
  // 무력화용 no-op 을 errors.js 맨 위에 넣는다(가장 먼저 로드된다)
  const errPath = path.join(ROOT, "web/js/errors.js");
  const errOrig = fs.readFileSync(errPath, "utf8");
  try {
    fs.writeFileSync(t.path, patched, "utf8");
    if (t.file !== "errors.js") fs.writeFileSync(errPath, "function __noWire(){}\n" + errOrig, "utf8");
    else fs.writeFileSync(errPath, "function __noWire(){}\n" + patched, "utf8");
    const r = cp.spawnSync("node", ["tests/test_frontend.js"], { cwd: ROOT, encoding: "utf8", timeout: 120000 });
    const out = (r.stdout || "") + (r.stderr || "");
    const m = /(\d+) passed, (\d+) failed/.exec(out);
    // **요약 줄이 없으면 테스트가 죽은 것**이고, 그것도 "잡았다"이다.
    // 처음에는 이걸 -1 로 두고 "못 잡음"으로 셌다 — 측정 도구가 결과를 뒤집고 있었다.
    const failed = m ? +m[2] : (r.status === 0 ? 0 : 999);
    (failed > 0 ? caught : missed).push({ ...t, failed });
    process.stdout.write(failed > 0 ? "." : "X");
    reportProgress(caught.length + missed.length, targets.length, missed.length);
  } finally {
    fs.writeFileSync(t.path, orig, "utf8");
    fs.writeFileSync(errPath, errOrig, "utf8");
  }
}
console.log(`\n\n잡힘 ${caught.length} / 못 잡음 ${missed.length}\n`);
console.log("=== 지워도 테스트가 전부 초록인 배선 ===");
for (const m of missed) console.log(`  ${m.file}:${m.idx + 1}  ${m.text}`);
