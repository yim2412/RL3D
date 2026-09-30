#!/usr/bin/env node
/*
 * 실제 캐시로 "그럴듯하게 틀린 화면" 을 찾는다 (P106). 네트워크·마우스 없음.
 *
 *   node tools/cache_audit.js              # %APPDATA%\RL3D\cache 를 잰다
 *   node tools/cache_audit.js --selftest   # 검사마다 카나리아를 심어 정말 FAIL 하는지 먼저 본다
 *
 * 왜 도구인가: 발사·위성 데이터는 **날마다 바뀐다.** 2026-09-30 하루에 같은 방법으로 세 번 값을 냈다 —
 * 새 나라 코드 `???`(P95) · 앱이 받는 그룹의 소유국 35종(P96) · **재진입 예보가 SGP4 의 엉터리 값에 속은 것**(P103).
 * 테스트는 픽스처로 재서 **새로 들어온 값**을 못 본다. 그래서 캐시가 PC 마다 달라 CI 에는 넣지 않고 여기에 둔다.
 *
 * 규칙(그날 당한 것): ① 날짜는 **앱 환경(vm) 안에서** 만든다 — 밖의 Date 를 satellite.js 에 넘기면 instanceof 가
 * 실패해 값이 조용히 NaN 이 되고, NaN 비교는 늘 거짓이라 검사가 통과로 센다. ② 검사마다 **잰 개수**를 찍는다 —
 * 필드 이름을 틀리면 "값 0건" 인 채로 빈칸 0 이 나온다(P95). ③ 앱의 조회 로직을 따른다(`tr`·`countryKo`) —
 * 표만 보면 `AUS,SGP` 처럼 앱이 이미 처리하는 값을 빈칸으로 센다.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { loadApp } = require(path.join(__dirname, "..", "tests", "harness.js"));

const CACHE = path.join(process.env.APPDATA || "", "RL3D", "cache");
const SELFTEST = process.argv.includes("--selftest");
const MAX_SATS_FOR_PANELS = 3000;   // 위성 상세 렌더 상한(실측 2,924기 ≈ 수 초)
const DECAY_INVARIANT_SAMPLE = 40;  // 예보 불변식은 예보가 나온 위성 중 앞 N기만(호출당 실측 7.4ms)
const LEO_PERIOD_MIN = 130;         // 이보다 짧은 주기를 저궤도로 본다
// 전파 고도가 근지점~원지점을 벗어나도 되는 폭 — 지구 편평도(최대 ≈21km) + SGP4 단주기 변동(≈10km).
// 처음 30 으로 두었더니 낡지 않은 ALOS 가 33km 로 걸렸다(2026-10-01)
const APSIDES_SLACK_KM = 45;
// 재진입 예보 불변식의 허용치 — 예보의 1%(최소 0.1일). 100km 근처에선 궤도 한 바퀴 안에서도 고도가 편평도로
// ±15km 오르내려, "처음 100km 아래" 가 궤도 위상에 따라 흔들린다. 실측: 140~340일 예보에서 하루 차이가 0.94~2.26일.
// 화면은 100일 넘으면 개월로 적어 이 흔들림이 안 보인다. 가까운 예보(P103 테스트)는 0.05일 안으로 맞는다
const DECAY_TOL_FRAC = 0.01, DECAY_TOL_MIN_DAYS = 0.1;

function readJson(f) { return JSON.parse(fs.readFileSync(path.join(CACHE, f), "utf8")); }
function unwrap(j) { const d = j && j.data !== undefined ? j.data : j; return Array.isArray(d) ? d : (d && d.launches) || d; }

function loadCache() {
  const files = fs.existsSync(CACHE) ? fs.readdirSync(CACHE) : [];
  const launches = [], seenL = new Set();
  for (const f of files.filter((f) => /^(launches|archive_\d+)\.json$/.test(f)))
    for (const d of unwrap(readJson(f)) || []) if (d && !seenL.has(d.id)) { seenL.add(d.id); launches.push(d); }
  const tles = [], seenT = new Set();
  for (const f of files.filter((f) => /^tle_.*\.json$/.test(f)))
    for (const t of unwrap(readJson(f)) || []) if (t && !seenT.has(t.norad_id)) { seenT.add(t.norad_id); tles.push(t); }
  const satcat = {};
  for (const f of files.filter((f) => /^satcat_.*\.json$/.test(f))) Object.assign(satcat, unwrap(readJson(f)) || {});
  return { launches, tles, satcat };
}

// ── 검사 ─────────────────────────────────────────────────────────────────────
// 각 검사는 { measured, problems[] } 를 돌려준다. measured 가 0 이면 그 자체로 FAIL 이다(재지 않은 것).

/** satcat_codes.py 의 표 키 — 파이썬을 부르지 않고 `"코드": "한글"` 모양을 읽는다(표 네 개가 전부 그 모양이다). */
function satcatKnownCodes() {
  const src = fs.readFileSync(path.join(__dirname, "..", "satcat_codes.py"), "utf8");
  const keys = new Set();
  for (const m of src.matchAll(/"([^"]*)"\s*:\s*"[^"]*"/g)) keys.add(m[1]);
  return keys;
}

function checkTranslations(ctx, data) {
  const problems = [];
  let measured = 0;
  const T = (name) => vm.runInContext(name, ctx);
  const hangul = /[가-힣]/;
  const fields = [
    ["STATUS_KO", (d) => [d.status]], ["ORBIT_KO", (d) => [d.orbit]], ["MISSION_TYPE_KO", (d) => [d.mission_type]],
    ["AGENCY_TYPE_KO", (d) => (d.mission_agencies || []).map((a) => a && a.type)],
    ["TIMELINE_KO", (d) => (d.timeline || []).map((e) => e && e.abbrev)],
  ];
  for (const [table, get] of fields) {
    const t = T(table), miss = {};
    for (const d of data.launches) for (const v of get(d)) {
      if (v == null || v === "") continue;
      measured++;
      if (!(v in t)) miss[v] = (miss[v] || 0) + 1;
    }
    for (const [v, n] of Object.entries(miss)) problems.push(`${table}: '${v}' ${n}건`);
  }
  for (const d of data.launches) {   // 나라 코드는 앱의 조회 로직(countryKo)을 따른다 — 쉼표 값은 이미 "다국적"
    if (!d.provider_country) continue;
    measured++;
    const ko = ctx.countryKo(d.provider_country);
    if (!hangul.test(ko)) problems.push(`국가: '${d.provider_country}' (${d.name})`);
  }
  // SATCAT 은 **받을 때 번역해 캐시에 넣는다** — 표를 고친 뒤에도 다시 받기 전까지는 옛 번역이 남는다(TTL 24시간,
  // 안 쓰는 그룹은 아예 안 받는다). 그래서 지금 표(satcat_codes.py)에 있는 코드는 문제가 아니라 "갱신 대기" 로 센다
  const known = satcatKnownCodes();
  const satMiss = {};
  let pending = 0;
  for (const m of Object.values(data.satcat)) for (const k of ["type", "status", "owner", "launch_site"]) {
    const v = m && m[k];
    if (!v) continue;
    measured++;
    if (hangul.test(v) || v === "SES") continue;
    if (known.has(v)) { pending++; continue; }
    satMiss[`${k} '${v}'`] = (satMiss[`${k} '${v}'`] || 0) + 1;
  }
  for (const [v, n] of Object.entries(satMiss)) problems.push(`SATCAT ${v} ${n}기`);
  return { measured, problems, info: pending ? `SATCAT 캐시가 옛 번역 ${pending}기 — 표에는 있다, 다시 받으면 풀린다` : null };
}

const BROKEN = [/undefined/, /\bNaN\b/, /\bnull\b/, /Invalid Date/, /\[object/, /\(\s*\)/, /Infinity/];
const plain = (h) => String(h || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
function brokenIn(where, name, text, problems) {
  for (const re of BROKEN) {
    const m = re.exec(text);
    if (m) { problems.push(`${where} · ${name}: …${text.slice(Math.max(0, m.index - 30), m.index + 20)}…`); return; }
  }
}

function checkBrokenText(app, data, recs) {
  const { ctx, el, state } = app;
  const problems = [];
  let measured = 0;
  state.allLaunches = data.launches; state.launches = data.launches;
  for (const d of data.launches) {
    measured++;
    try { ctx.openPanel(d); brokenIn("발사 상세", d.name, plain(el("panel-body").innerHTML), problems); }
    catch (e) { problems.push(`발사 상세 예외 · ${d.name}: ${e.message}`); }
    brokenIn("순서표", d.name, plain(ctx.timelineHtml(d, 0)), problems);
  }
  try { ctx.renderSidebar(data.launches); brokenIn("사이드바", "(목록)", plain(el("sidebar-list").innerHTML), problems); }
  catch (e) { problems.push("사이드바 예외: " + e.message); }
  for (const s of recs.slice(0, MAX_SATS_FOR_PANELS)) {
    measured++;
    try { ctx.openSatPanel(s); brokenIn("위성 상세", s.name, plain(el("panel-body").innerHTML), problems); }
    catch (e) { problems.push(`위성 상세 예외 · ${s.name}: ${e.message}`); }
  }
  return { measured, problems };
}

function checkLaunchNumbers(data) {
  const problems = [];
  let measured = 0;
  const num = (v) => typeof v === "number" && isFinite(v);
  for (const d of data.launches) {
    for (const [tot, yr] of [["pad_count", "pad_year_count"], ["location_count", "location_year_count"],
                              ["agency_count", "agency_year_count"], ["orbital_count", "orbital_year_count"]]) {
      if (num(d[tot]) && num(d[yr])) { measured++; if (d[yr] > d[tot]) problems.push(`${d.name}: ${yr} ${d[yr]} > ${tot} ${d[tot]}`); }
    }
    if (d.probability != null) { measured++; if (!num(d.probability) || d.probability < 0 || d.probability > 100) problems.push(`${d.name}: 확률 ${d.probability}`); }
    if (d.pad_turnaround_sec != null) { measured++; if (!num(d.pad_turnaround_sec) || d.pad_turnaround_sec < 0) problems.push(`${d.name}: 발사대 간격 ${d.pad_turnaround_sec}`); }
  }
  const byYear = {};
  for (const d of data.launches) {
    if (d.outcome === "upcoming" || !num(d.orbital_year_count) || !d.net) continue;
    (byYear[new Date(d.net).getUTCFullYear()] = byYear[new Date(d.net).getUTCFullYear()] || []).push(d);
  }
  for (const arr of Object.values(byYear)) {
    arr.sort((a, b) => new Date(a.net) - new Date(b.net));
    for (let i = 1; i < arr.length; i++) {
      measured++;
      if (arr[i].orbital_year_count < arr[i - 1].orbital_year_count)
        problems.push(`연내 순번 역전: ${arr[i - 1].name} #${arr[i - 1].orbital_year_count} → ${arr[i].name} #${arr[i].orbital_year_count}`);
    }
  }
  return { measured, problems };
}

/** 위성 물리 — **앱 환경 안에서** 전파한다. 낡은 TLE(패널이 이미 경고하는 것)의 고도 벗어남은 세지 않는다. */
function checkSatPhysics(ctx) {
  return vm.runInContext(`(function(){
    const out = { measured: 0, problems: [] };
    for (const s of __auditRecs) {
      const d = satDetails(s.rec);
      if (!d) continue;
      out.measured++;
      if (![d.alt, d.lat, d.vel, d.incl].every(isFinite)) { out.problems.push(s.name + ": 값이 숫자가 아니다"); continue; }
      const maxLat = d.incl <= 90 ? d.incl : 180 - d.incl;
      if (Math.abs(d.lat) > maxLat + 0.5) out.problems.push(s.name + ": |위도| " + d.lat.toFixed(2) + " > 경사 " + d.incl.toFixed(2));
      const stale = tleAgeDays(s.rec) > tleStaleLimit(s.rec);
      const gap = d.alt < d.perigee ? d.perigee - d.alt : (d.alt > d.apogee ? d.alt - d.apogee : 0);
      if (!stale && gap > ${APSIDES_SLACK_KM}) out.problems.push(s.name + ": 고도 " + d.alt.toFixed(0) + " 가 근지점~원지점(" + d.perigee.toFixed(0) + "~" + d.apogee.toFixed(0) + ") 밖 — TLE 는 낡지 않았다");
    }
    return out;
  })()`, ctx);
}

/** 재진입 예보 불변식 — 하루가 흐르면 예보도 하루 준다(P103). 절대값 없이 단언할 수 있는 유일한 성질이다. */
function checkDecayInvariant(ctx) {
  return vm.runInContext(`(function(){
    const out = { measured: 0, problems: [] };
    const now = Date.now(), D = 86400000;
    let taken = 0;
    for (const s of __auditRecs) {
      if (taken >= ${DECAY_INVARIANT_SAMPLE}) break;
      const a = decayForecastDays(s.rec, now);
      if (a == null || a < 2) continue;
      taken++; out.measured++;
      const b = decayForecastDays(s.rec, now + D);
      if (b == null || Math.abs((a - b) - 1) > Math.max(${DECAY_TOL_MIN_DAYS}, ${DECAY_TOL_FRAC} * a)) out.problems.push(s.name + ": 오늘 " + a.toFixed(2) + "일 · 내일 " + (b == null ? "없음" : b.toFixed(2)) + "일");
    }
    return out;
  })()`, ctx);
}

// ── 실행 ─────────────────────────────────────────────────────────────────────
function makeRecs(ctx, tles) {
  ctx.__tlesIn = tles;
  return vm.runInContext(`__auditRecs = __tlesIn.map(function (t) {
    return { norad: String(t.norad_id), name: t.name, rec: satellite.twoline2satrec(t.tle1, t.tle2) }; })`, ctx);
}

function audit(data) {
  const app = loadApp({ realSatellite: true });
  app.state.map = app.map;
  vm.runInContext("satcat = __sc", Object.assign(app.ctx, { __sc: data.satcat }));
  const recs = makeRecs(app.ctx, data.tles);
  const quiet = console.error; console.error = () => {};
  try {
    return [
      ["번역 빈칸", checkTranslations(app.ctx, data)],
      ["깨진 글자", checkBrokenText(app, data, recs)],
      ["발사 숫자 대조", checkLaunchNumbers(data)],
      ["위성 물리", checkSatPhysics(app.ctx)],
      ["재진입 예보 불변식", checkDecayInvariant(app.ctx)],
    ];
  } finally { console.error = quiet; }
}

function report(results) {
  let fail = 0;
  for (const [name, r] of results) {
    const ok = r.measured > 0 && r.problems.length === 0;
    if (!ok) fail++;
    console.log(`${ok ? "[OK]  " : "[FAIL]"} ${name} — 잰 것 ${r.measured} · 문제 ${r.problems.length}` + (r.measured === 0 ? " (잰 것이 0 — 검사가 돌지 않았다)" : ""));
    if (r.info) console.log("         (참고) " + r.info);
    for (const p of r.problems.slice(0, 8)) console.log("         " + p);
    if (r.problems.length > 8) console.log(`         … 외 ${r.problems.length - 8}건`);
  }
  return fail;
}

/** 카나리아 — 검사마다 하나씩 깨진 값을 심고, **그 검사가** FAIL 하는지 본다. */
function selftest(base) {
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const data = { launches: clone(base.launches), tles: base.tles, satcat: clone(base.satcat) };
  const L = data.launches.find((d) => d.timeline && d.timeline.length) || data.launches[0];
  data.launches.push(Object.assign(clone(L), { id: "canary-1", name: "카나리아 번역", status: "Canary Status" }));
  data.launches.push(Object.assign(clone(L), { id: "canary-2", name: "카나리아 글자", mission_name: "undefined" }));
  data.launches.push(Object.assign(clone(L), { id: "canary-3", name: "카나리아 숫자", pad_count: 1, pad_year_count: 5 }));
  const first = Object.keys(data.satcat)[0];
  if (first) data.satcat[first] = Object.assign({}, data.satcat[first], { owner: "ZZCANARY" });
  const results = Object.fromEntries(audit(data));
  const expect = ["번역 빈칸", "깨진 글자", "발사 숫자 대조"];
  let bad = 0;
  for (const name of expect) {
    const caught = results[name].problems.some((p) => /카나리아|Canary|ZZCANARY/.test(p));
    console.log(`${caught ? "[OK]  " : "[FAIL]"} 카나리아 → ${name} 가 잡는다`);
    if (!caught) bad++;
  }
  // 위성 물리·예보 불변식은 캐시 값을 못 바꾸니, 판정식에 모순을 심는 대신 "잰 것" 이 0 이 아닌지로 본다
  for (const name of ["위성 물리", "재진입 예보 불변식"]) {
    const ok = results[name].measured > 0;
    console.log(`${ok ? "[OK]  " : "[FAIL]"} ${name} 가 실제로 잰다(잰 것 ${results[name].measured})`);
    if (!ok) bad++;
  }
  return bad;
}

if (require.main === module) {
  if (!fs.existsSync(CACHE)) { console.log(`[FAIL] 캐시 폴더가 없다: ${CACHE} — 앱을 한 번 실행해 캐시를 만든다`); process.exit(2); }
  const data = loadCache();
  console.log(`캐시: 발사 ${data.launches.length}건 · 위성 TLE ${data.tles.length}기 · SATCAT ${Object.keys(data.satcat).length}기`);
  const t0 = Date.now();
  const fail = SELFTEST ? selftest(data) : report(audit(data));
  console.log(`\n${fail ? "[FAIL]" : "[OK]"} cache_audit${SELFTEST ? " --selftest" : ""} (${((Date.now() - t0) / 1000).toFixed(1)}초)`);
  process.exit(fail ? 1 : 0);
}
