/* 시한폭탄 테스트 (P54) — 달력이 흐르면 깨질 단언을 **미리** 찾는다.
 *
 *     node tests/test_future.js
 *
 * **왜**: 2026-09-27 에 `test_frontend` 가 코드 변경 없이 빨개졌다. 재진입 예보를 재던 로켓
 * 몸체(2026-09-14 기준 약 14일 뒤 재진입)가 그날 **실제로 재진입해**, 지금 시각으로 전파한
 * 위치가 null 이 됐다. 시계를 밀어 보니 41~45일 뒤 · 해가 바뀔 때 · 400일 뒤 · 10년 뒤에
 * 터질 것이 스무 건 가까이 더 있었다. 실제 TLE·실제 날짜를 먹이는 테스트는 `loadApp({ now })`
 * 로 시각을 고정해야 한다 — 그걸 빠뜨린 묶음을 여기서 잡는다.
 *
 * 과거 방향은 재지 않는다 — 시계는 뒤로 가지 않는다.
 */
const path = require("path");
const { spawnSync } = require("child_process");
const { group, check, done } = require("./harness");

const SHIFT = path.join(__dirname, "clock_shift.js");
const FE = path.join(__dirname, "test_frontend.js");
// 한 달 반(첫 폭탄이 터지던 곳) · 해 넘김을 넘는 1년 남짓 · 10년
const HORIZONS = [45, 400, 3650];

const run = (days, args) => spawnSync(process.execPath, ["-r", SHIFT].concat(args), {
  cwd: path.join(__dirname, ".."), encoding: "utf-8", errors: "replace",
  env: Object.assign({}, process.env, { CLOCK_SHIFT_DAYS: String(days) }),
});

// ── 도구부터 잰다: 시계가 정말 밀렸나 ─────────────────────────────────────────
// 안 밀렸으면 아래는 오늘 날짜로 한 번 더 돌 뿐이라 **공허하게 초록**이다.
{
  group("시계 밀기 도구");
  const probe = `const h = require("./tests/harness"); const a = h.loadApp();
    console.log(JSON.stringify({ node: Date.now(), nodeNew: new Date().getTime(), app: a.now(),
      pinned: h.loadApp({ now: 1e12 }).now() }));`;
  const t0 = Date.now();
  const r = run(400, ["-e", probe]);
  let v = null;
  try { v = JSON.parse(r.stdout.trim().split("\n").pop()); } catch (_) { /* 아래에서 실패 */ }
  const days = (ms) => Math.round((ms - t0) / 86400000);
  check("탐침이 돌았다", !!v, true);
  check("Node 의 Date.now 가 400일 밀렸다", v && days(v.node), 400);
  check("Node 의 new Date() 가 400일 밀렸다", v && days(v.nodeNew), 400);
  check("앱 realm 의 시계도 400일 밀렸다", v && days(v.app), 400);
  // 고정한 묶음은 밀린 시계 위에서도 제 시각을 지켜야 한다 — 그게 고정의 뜻이다
  check("loadApp({ now }) 는 밀린 시계 위에서도 그 시각이다", v && Math.abs(v.pinned - 1e12) < 60000, true);
}

// ── 앞날에 프론트 스위트를 돌린다 ─────────────────────────────────────────────
for (const d of HORIZONS) {
  group(`${d}일 뒤`);
  const r = run(d, [FE]);
  const m = /(\d+) passed, (\d+) failed/.exec(r.stdout || "");
  const fails = (r.stdout || "").split("\n").filter((l) => l.startsWith("  FAIL")).map((l) => l.trim().slice(5));
  check(`${d}일 뒤에도 전부 통과(종료 코드)`, r.status, 0);
  check(`${d}일 뒤에 깨지는 단언`, fails, []);
  // 스위트가 도중에 죽으면 실패 줄도 없이 끝난다 — 건수가 나왔는지 따로 본다
  check(`${d}일 뒤 스위트가 끝까지 돌았다`, !!m && Number(m[1]) > 1000, true);
}

done(14);   // 건수 하한 — 2026-09-27 실측(도구 5 + 기간 3 × 3)
