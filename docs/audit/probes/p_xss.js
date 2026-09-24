/* XSS 동적 프로브 — 전면 감사 2단계(2026-09-24).
 *
 *     node docs/audit/probes/p_xss.js            # [OK]/[FAIL]
 *     node docs/audit/probes/p_xss.js --selftest # 판정기가 날것의 태그를 잡는지
 *
 * 정적 스캔(`audit_scan innerHTML`)은 "escapeHtml 로 시작하지 않는 보간"을 78개 세지만,
 * 그중 무엇이 **실제로** 외부 문자열을 날것으로 넣는지는 말하지 못한다(도우미 함수가 안에서
 * 이스케이프할 수도 있다). 여기서는 실제 정규화 결과(골든)의 **모든 문자열 필드**에 공격
 * 문자열을 넣고 실제 렌더 함수를 불러, 결과 HTML 에 태그가 날것으로 남는지를 본다.
 *
 * 두 번 돈다: ① 모든 문자열에 태그 페이로드 ② http 로 시작하는 문자열(=URL 필드)에 javascript: 스킴.
 */
const path = require("path");
const fs = require("fs");
const { loadApp } = require(path.join(__dirname, "..", "..", "..", "tests", "harness"));

const ROOT = path.join(__dirname, "..", "..", "..");
const golden = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "golden", n), "utf8"));
const TAG = `X"'><img src=x onerror=__pwn(1)>`;
const RAW = /<img src=x onerror=__pwn/;
const JS_URL = "javascript:__pwn(2)//";
// img src 의 javascript: 는 Chromium 이 실행하지 않는다 — 실행 가능한 자리(href·iframe/embed src)만 본다
const RAW_URL = /(href|<iframe[^>]*\bsrc|<embed[^>]*\bsrc)\s*=\s*["']?\s*javascript:/i;

function poison(obj, mode) {
  if (typeof obj === "string") {
    if (mode === "tag") return TAG + obj;
    if (mode === "url" && /^https?:/.test(obj)) return JS_URL;
    return obj;
  }
  if (Array.isArray(obj)) return obj.map((x) => poison(x, mode));
  if (obj && typeof obj === "object") {
    const o = {};
    for (const [k, v] of Object.entries(obj)) o[k] = poison(v, mode);
    return o;
  }
  return obj;
}

function run(mode) {
  const app = loadApp();
  const { ctx, state } = app;
  const seen = [];
  const gid = ctx.document.getElementById;
  ctx.document.getElementById = (id) => { const e = gid(id); if (e) seen.push(e); return e; };
  const ce = ctx.document.createElement;
  ctx.document.createElement = (t) => { const e = ce(t); seen.push(e); return e; };

  // 좌표·outcome 같은 판정 필드는 그대로 두고 문자열만 오염 — 렌더가 분기로 빠지지 않게
  const keep = new Set(["id", "outcome", "net", "net_precision", "window_start", "window_end", "last_updated"]);
  const launches = golden("launches_upcoming.json").concat(golden("launches_previous.json")).map((d) => {
    const p = poison(d, mode);
    for (const k of keep) p[k] = d[k];
    return p;
  });
  const sats = golden("satellites_stations.json").map((s) => {
    const p = poison(s, mode);
    p.line1 = s.line1; p.line2 = s.line2; p.norad = s.norad; p.norad_id = s.norad_id;
    return p;
  });

  const errors = [];
  const tries = [];
  const hits = new Map();
  const re = mode === "tag" ? RAW : RAW_URL;
  let reached = 0;   // 오염 문자열이 (이스케이프돼서라도) 화면에 닿은 렌더 수 — 0 이면 공허한 통과
  const scan = (name) => {
    let touched = false;
    for (const e of seen) {
      const h = String(e.innerHTML || "");
      if (h.includes("__pwn")) touched = true;
      const m = re.exec(h);
      if (m) {
        const at = h.indexOf(m[0]);
        hits.set(`${name} → #${e.id}: …${h.slice(Math.max(0, at - 70), at + 30).replace(/\s+/g, " ")}`, 1);
      }
    }
    if (touched) reached++;
  };
  // 렌더마다 스캔한다 — 끝에서 한 번만 보면 다음 렌더가 덮어쓴 패널은 영영 안 보인다
  // (2026-09-24 실측: escapeHtml 을 뺀 되돌리는 변이를 그래서 못 잡았다)
  const attempt = (name, fn) => {
    tries.push(name);
    try { fn(); } catch (e) { errors.push(`${name}: ${e.message}`); }
    scan(name);
  };
  state.map = app.map;   // openPanel 이 지도로 날아간다 — 없으면 렌더 전에 죽는다
  state.allLaunches = launches;
  if ("liveLaunches" in state) state.liveLaunches = launches;
  attempt("renderSidebar", () => ctx.renderSidebar(launches));
  for (const d of launches) attempt("openPanel", () => ctx.openPanel(d));
  for (const d of launches.slice(0, 10)) attempt("renderFocus", () => ctx.renderFocus(d));
  attempt("showStats", () => ctx.showStats());
  for (const d of launches.slice(0, 10)) {
    attempt("showEntityStats site", () => ctx.showEntityStats("site", d.location_name));
    attempt("showEntityStats provider", () => ctx.showEntityStats("provider", d.provider));
    attempt("showEntityStats rocket", () => ctx.showEntityStats("rocket", d.rocket));
    attempt("openPadList", () => ctx.openPadList(d.lat, d.lng));
  }
  attempt("showLaunchTooltip", () => ctx.showLaunchTooltip({
    features: [{ properties: { id: launches[0].id } }], lngLat: { lng: 0, lat: 0 }, point: { x: 1, y: 1 },
    originalEvent: { clientX: 1, clientY: 1 },
  }));
  if ("satellites" in state) state.satellites = sats;
  if ("allSats" in state) state.allSats = sats;
  const meta = {};
  for (const s of sats) meta[s.norad] = poison({ name: "n", type: "PAY", owner: "US", launch_date: "2000-01-01", launch_site: "AFETR", size: "LARGE" }, mode);
  if ("satcat" in state) state.satcat = meta;
  for (const s of sats.slice(0, 20)) attempt("openSatPanel", () => ctx.openSatPanel(s));
  attempt("renderSatList", () => ctx.renderSatList());
  attempt("renderFavList", () => ctx.renderFavList());

  return { hits: [...hits.keys()], errors, tries: tries.length, elems: seen.length, reached };
}

function main() {
  let bad = 0;
  for (const mode of ["tag", "url"]) {
    const r = run(mode);
    console.log(`\n[${mode}] 렌더 시도 ${r.tries} · 본 요소 ${r.elems} · 오염이 닿은 요소 ${r.reached} · 예외 ${r.errors.length}`);
    if (r.reached < 10) { console.log("  [FAIL] 오염 문자열이 화면에 거의 안 닿았다 — 통과가 공허하다"); bad++; }
    // 골든 발사 6건 · 위성 픽스처 기준 — 2026-09-24 첫 실행은 예외로 빠져 공허했다(하한이 잡음)
    if (r.elems < 20 || r.tries < 40 || r.errors.length) { console.log("  [FAIL] 대상이 너무 적다 — 프로브가 비었다"); bad++; }
    for (const e of [...new Set(r.errors.map((x) => x.split(":")[0]))]) {
      console.log(`  [예외] ${r.errors.find((x) => x.startsWith(e)).slice(0, 140)}`);
    }
    for (const h of r.hits) { console.log(`  [FAIL] 날것 ${h}`); bad++; }
  }
  console.log(bad ? `\n[FAIL] p_xss: ${bad}` : "\n[OK] p_xss");
  process.exit(bad ? 1 : 0);
}

function selftest() {
  // 판정기가 날것을 잡는지, 이스케이프된 것은 통과시키는지
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const cases = [
    ["날것 태그", RAW.test(`<b>${TAG}</b>`), true],
    ["이스케이프된 태그", RAW.test(`<b>${esc(TAG)}</b>`), false],
    ["날것 javascript href", RAW_URL.test(`<a href="${JS_URL}">`), true],
    ["data-url 은 href 가 아니다", RAW_URL.test(`<a data-url="${JS_URL}">`), false],
    ["img src 의 javascript: 는 실행되지 않는다", RAW_URL.test(`<img src="${JS_URL}">`), false],
  ];
  let ok = true;
  for (const [n, got, want] of cases) { ok = ok && got === want; console.log(`  [${got === want ? "OK" : "FAIL"}]   ${n}`); }
  console.log(ok ? "[OK] selftest" : "[FAIL] selftest");
  process.exit(ok ? 0 : 1);
}

process.argv.includes("--selftest") ? selftest() : main();
