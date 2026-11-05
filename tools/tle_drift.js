#!/usr/bin/env node
/*
 * TLE 가 묵으면 예보가 실제와 얼마나 어긋나는가 (P112). 네트워크·마우스 없음.
 *
 *   python tools/refresh_cache.py --tle    # 먼저 TLE 를 받는다(Celestrak 그룹당 1회)
 *   node tools/tle_drift.js snapshot       # 지금 캐시의 TLE 를 기록해 둔다
 *   node tools/tle_drift.js compare        # 옛 기록을 가장 새 기록의 에포크까지 전파해 새 TLE 와 대조
 *   node tools/tle_drift.js --selftest     # 답을 아는 입력으로 도구부터 잰다
 *
 * 왜: Skyfield 대조(P111)는 같은 TLE 를 먹여 **계산**만 쟀다. TLE 자체가 낡아서 생기는 오차는 어떤 계산 대조로도 안 보인다.
 * 위성의 진짜 궤도에 가장 가까운 공개 값은 **그 뒤에 나온 TLE** 이므로, 묵은 TLE 의 전파 결과를 새 TLE 에 댄다.
 * Celestrak 은 최신값만 주어 과거 TLE 를 나중에 구할 수 없다 — 그래서 미리 찍어 둔다.
 *
 * 값 읽는 법: 궤도 진행 방향의 어긋남을 속도로 나눈 **시각 차이(초)** 가 곧 통과 시각 오차다(지상 궤적이 그만큼 일찍·늦게 지난다).
 * 한계: 새 TLE 도 측정값이라 바닥 오차(약 1km)가 있다. 궤도 기동·재부스트는 어떤 전파로도 예측되지 않으니 그런 위성은 큰 값으로 나온다.
 * 시각 차이는 궤도 반 바퀴(저궤도 약 46분)가 상한이다 — 그보다 어긋나면 되돌아 읽혀 실제보다 작게 나온다.
 */
const fs = require("fs");
const path = require("path");
const { loadApp } = require(path.join(__dirname, "..", "tests", "harness.js"));

const APP_DIR = path.join(process.env.APPDATA || "", "RL3D");
const CACHE = path.join(APP_DIR, "cache");
const HISTORY = path.join(APP_DIR, "tle_history");
const FIXTURE = path.join(__dirname, "..", "tests", "fixtures", "celestrak_stations.txt");
const DAY_MS = 86400000;
const MIN_PAIR_AGE_DAYS = 0.01;   // 이보다 가까운 두 TLE 는 사실상 같은 관측이다
const AGE_BUCKETS = [1, 3, 7, 14, 30, Infinity];   // 일. 앱의 낡음 경고 기준(저궤도 3 · 그 위 30)이 경계에 오게 둔다
const SHIFT_PROBE_DEG = 1;        // selftest 가 평균근점이각을 밀 각도
const SHIFT_PROBE_WIDE_DEG = 90;
const SHIFT_PROBE_TOL_SEC = 2;

/** TLE 1행의 에포크 → ms. SGP4 라이브러리와 무관하게 읽는다 — 같은 값을 재는 데 재는 대상을 쓰지 않는다. */
function epochMs(tle1) {
  const yy = Number(tle1.slice(18, 20));
  const dayOfYear = Number(tle1.slice(20, 32));
  if (!isFinite(yy) || !isFinite(dayOfYear) || tle1.length < 32) return null;
  return Date.UTC(yy < 57 ? 2000 + yy : 1900 + yy, 0, 1) + (dayOfYear - 1) * DAY_MS;
}

function readCacheTles() {
  const out = {};
  if (!fs.existsSync(CACHE)) return out;
  for (const f of fs.readdirSync(CACHE).filter((n) => /^tle_.*\.json$/.test(n))) {
    const j = JSON.parse(fs.readFileSync(path.join(CACHE, f), "utf8"));
    for (const t of (j && j.data) || []) {
      if (t && t.norad_id && t.tle1 && t.tle2) out[t.norad_id] = { name: t.name, tle1: t.tle1, tle2: t.tle2 };
    }
  }
  return out;
}

function listSnapshots() {
  if (!fs.existsSync(HISTORY)) return [];
  return fs.readdirSync(HISTORY).filter((f) => /^\d{4}-\d{2}-\d{2}T\d{4}\.json$/.test(f)).sort();
}
const readSnapshot = (f) => JSON.parse(fs.readFileSync(path.join(HISTORY, f), "utf8"));

function takeSnapshot(now = new Date()) {
  const tles = readCacheTles();
  const n = Object.keys(tles).length;
  if (!n) { console.log(`[FAIL] 캐시에 TLE 가 없다: ${CACHE} — python tools/refresh_cache.py --tle`); return 2; }
  const prev = listSnapshots().pop();
  if (prev) {
    const old = readSnapshot(prev).tles;
    const changed = Object.keys(tles).filter((k) => !old[k] || old[k].tle1 !== tles[k].tle1).length;
    if (!changed) { console.log(`[건너뜀] ${prev} 와 TLE 가 같다(${n}기) — 먼저 refresh_cache.py --tle`); return 0; }
  }
  fs.mkdirSync(HISTORY, { recursive: true });
  const stamp = now.toISOString().slice(0, 16).replace(":", "");
  fs.writeFileSync(path.join(HISTORY, `${stamp}.json`), JSON.stringify({ taken: now.toISOString(), tles }), "utf8");
  const ages = Object.values(tles).map((t) => (now.getTime() - epochMs(t.tle1)) / DAY_MS);
  console.log(`[OK] 스냅샷 ${stamp}.json · ${n}기 · 에포크 나이 중앙 ${quant(ages, 0.5).toFixed(2)}일 · 최대 ${Math.max(...ages).toFixed(1)}일`);
  return 0;
}

function quant(a, p) {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

/** 묵은 TLE 를 새 TLE 의 에포크까지 전파해 대조. 전파가 실패하면 null(재진입 등). */
function driftOf(ctx, older, newer) {
  const t = new Date(epochMs(newer.tle1));
  const a = ctx.satellite.propagate(ctx.satellite.twoline2satrec(older.tle1, older.tle2), t);
  const recB = ctx.satellite.twoline2satrec(newer.tle1, newer.tle2);
  const b = ctx.satellite.propagate(recB, t);
  if (!a || !b || !a.position || !b.position || !b.velocity) return null;
  const pa = a.position, pb = b.position, v = b.velocity;
  const dot = (p, q) => p.x * q.x + p.y * q.y + p.z * q.z;
  const cross = (p, q) => ({ x: p.y * q.z - p.z * q.y, y: p.z * q.x - p.x * q.z, z: p.x * q.y - p.y * q.x });
  const d = { x: pa.x - pb.x, y: pa.y - pb.y, z: pa.z - pb.z };
  const km = Math.sqrt(dot(d, d));
  const speed = Math.sqrt(dot(v, v));
  const r = Math.sqrt(dot(pb, pb));
  // 궤도면 안의 각도로 잰다. 직선 차이를 진행 방향으로 투영하면 곡률만큼 작게 나온다 —
  // 첫 판이 ISS 위치 차이 9,088km 를 881초로 읽었다(실제 약 1,190초). 오차가 클수록 관대해지는 방향이다.
  const h = cross(pb, v);
  const hLen = Math.sqrt(dot(h, h));
  const angle = Math.atan2(dot(cross(pb, pa), h) / hLen, dot(pb, pa));
  const alongKm = angle * r;
  if (!isFinite(km) || !isFinite(alongKm) || !(speed > 0)) return null;
  return { km, alongKm, shiftSec: Math.abs(alongKm) / speed, band: ctx.orbitBand(recB) };
}

/** 옛 기록 전부 → 가장 새 기록. 같은 에포크의 TLE 는 여러 기록에 있어도 한 번만 잰다. */
function compareSnapshots(ctx, olders, newest) {
  const rows = [];
  let failed = 0;
  const seen = new Set();
  for (const snap of olders) {
    for (const [norad, oldT] of Object.entries(snap.tles)) {
      const newT = newest.tles[norad];
      if (!newT) continue;
      const age = (epochMs(newT.tle1) - epochMs(oldT.tle1)) / DAY_MS;
      if (!(age >= MIN_PAIR_AGE_DAYS)) continue;
      const key = norad + "|" + oldT.tle1;
      if (seen.has(key)) continue;
      seen.add(key);
      const r = driftOf(ctx, oldT, newT);
      if (!r) { failed++; continue; }
      rows.push(Object.assign(r, { norad, name: newT.name, age }));
    }
  }
  return { rows, failed };
}

function bucketLabel(i) {
  const lo = i ? AGE_BUCKETS[i - 1] : 0, hi = AGE_BUCKETS[i];
  return hi === Infinity ? `${lo}일~` : `${lo}~${hi}일`;
}
function bucketIndex(age) { return AGE_BUCKETS.findIndex((hi) => age < hi); }

function printTable({ rows, failed }) {
  console.log(`대조 ${rows.length}쌍 · 전파 실패 ${failed}쌍(재진입 등)`);
  console.log("대역 · 나이 | 쌍 | 시각 차이 중앙/95%/최대(초) | 위치 차이 중앙/95%(km)");
  for (const band of ["leo", "meo", "geo", null]) {
    const inBand = rows.filter((r) => (band === null ? !["leo", "meo", "geo"].includes(r.band) : r.band === band));
    AGE_BUCKETS.forEach((_, i) => {
      const b = inBand.filter((r) => bucketIndex(r.age) === i);
      if (!b.length) return;
      const s = b.map((r) => r.shiftSec), km = b.map((r) => r.km);
      console.log(`${band || "기타"} · ${bucketLabel(i)} | ${b.length} | ${quant(s, .5).toFixed(1)} / ${quant(s, .95).toFixed(1)} / ${Math.max(...s).toFixed(1)} | ${quant(km, .5).toFixed(1)} / ${quant(km, .95).toFixed(1)}`);
    });
  }
  const worst = [...rows].sort((a, b) => b.shiftSec - a.shiftSec).slice(0, 5);
  if (worst.length) console.log("가장 큰 차이(기동·재부스트 후보): " + worst.map((r) => `${r.name} ${r.shiftSec.toFixed(0)}초/${r.age.toFixed(1)}일`).join(" ; "));
}

function compare() {
  const files = listSnapshots();
  if (files.length < 2) {
    console.log(`[대기] 스냅샷 ${files.length}개 — 두 개가 있어야 잰다. 며칠 뒤: python tools/refresh_cache.py --tle → node tools/tle_drift.js snapshot → compare`);
    return 0;
  }
  const { ctx } = loadApp({ realSatellite: true });
  const newest = readSnapshot(files[files.length - 1]);
  const result = compareSnapshots(ctx, files.slice(0, -1).map(readSnapshot), newest);
  console.log(`스냅샷 ${files.length}개: ${files[0]} ~ ${files[files.length - 1]}`);
  if (!result.rows.length) { console.log(`[대기] 대조할 쌍이 0 — 위성들의 TLE 가 아직 안 바뀌었다(전파 실패 ${result.failed}쌍)`); return 0; }
  printTable(result);
  return 0;
}

/** 답을 아는 입력. 판정식이 망가지면 "차이 0" 도 "차이 큼" 도 그럴듯해 보인다. */
function selftest() {
  const { ctx } = loadApp({ realSatellite: true });
  const lines = fs.readFileSync(FIXTURE, "utf8").trim().split(/\r?\n/);
  const iss = { name: "ISS", tle1: lines[1], tle2: lines[2] };
  let bad = 0;
  const say = (ok, msg) => { console.log(`${ok ? "[OK]  " : "[FAIL]"} ${msg}`); if (!ok) bad++; };

  const year = 2000 + Number(iss.tle1.slice(18, 20)), day = Number(iss.tle1.slice(20, 32));
  const parsed = epochMs(iss.tle1);
  say(new Date(parsed).getUTCFullYear() === year, `에포크를 읽는다 ${new Date(parsed).toISOString()}`);
  const jdMs = (ctx.satellite.twoline2satrec(iss.tle1, iss.tle2).jdsatepoch - 2440587.5) * DAY_MS;
  say(Math.abs(parsed - jdMs) < 1000, `에포크가 SGP4 라이브러리와 1초 안에서 같다(차이 ${Math.abs(parsed - jdMs).toFixed(0)}ms)`);

  const same = driftOf(ctx, iss, iss);
  say(!!same && same.km < 1e-6 && same.shiftSec < 1e-6, `같은 TLE 는 차이 0 (${same && same.km.toExponential(1)}km)`);

  // 평균근점이각을 밀면 위성이 궤도 위에서 정확히 그만큼 앞선다 — 답은 주기 × 각도/360.
  // 90° 는 직선 투영이 곡률만큼 작게 읽는 것을 잡는다(1° 만 재면 두 방식이 같은 값이라 못 본다)
  const ma = Number(iss.tle2.slice(43, 51));
  const meanMotion = Number(iss.tle2.slice(52, 63));
  const pushedBy = (deg) => {
    const text = ((ma + deg) % 360).toFixed(4).padStart(8, " ");
    return { name: "ISS", tle1: iss.tle1, tle2: iss.tle2.slice(0, 43) + text + iss.tle2.slice(51) };
  };
  let got = null;
  for (const deg of [SHIFT_PROBE_DEG, SHIFT_PROBE_WIDE_DEG]) {
    const expectSec = (86400 / meanMotion) * (deg / 360);
    const r = driftOf(ctx, pushedBy(deg), iss);
    if (deg === SHIFT_PROBE_DEG) got = r;
    say(!!r && Math.abs(r.shiftSec - expectSec) < SHIFT_PROBE_TOL_SEC,
      `평균근점이각 +${deg}° → 시각 차이 ${r ? r.shiftSec.toFixed(1) : "?"}초(기대 ${expectSec.toFixed(1)}초) · 위치 ${r ? r.km.toFixed(0) : "?"}km`);
  }
  say(!!got && got.alongKm > 0, "앞선 위성은 진행 방향 차이가 양수다");
  const behind = driftOf(ctx, pushedBy(360 - SHIFT_PROBE_DEG), iss);
  say(!!behind && behind.alongKm < 0, "뒤처진 위성은 진행 방향 차이가 음수다");
  say(!!got && got.band === "leo", `대역을 읽는다(${got && got.band})`);

  // 짝짓기와 구간 나누기 — 에포크를 이틀 앞당긴 기록은 1~3일 칸에 한 번만 들어가야 한다
  const dayText = (day - 2).toFixed(8).padStart(12, "0");
  const earlier = { name: "ISS", tle1: iss.tle1.slice(0, 20) + dayText + iss.tle1.slice(32), tle2: iss.tle2 };
  const twice = compareSnapshots(ctx, [{ tles: { 25544: earlier } }, { tles: { 25544: earlier } }], { tles: { 25544: iss } });
  say(twice.rows.length === 1, `같은 에포크는 기록이 둘이어도 한 번만 잰다(${twice.rows.length}쌍)`);
  say(twice.rows[0] && Math.abs(twice.rows[0].age - 2) < 1e-6 && bucketLabel(bucketIndex(twice.rows[0].age)) === "1~3일",
    `나이 ${twice.rows[0] ? twice.rows[0].age.toFixed(2) : "?"}일이 1~3일 칸에 든다`);
  // 옛 TLE 를 **새 TLE 의 에포크까지** 전파하는가 — SGP4 를 경과 분으로 직접 불러 같은 거리가 나와야 한다
  const recEarlier = ctx.satellite.twoline2satrec(earlier.tle1, earlier.tle2);
  const recIss = ctx.satellite.twoline2satrec(iss.tle1, iss.tle2);
  const pa = ctx.satellite.sgp4(recEarlier, 2 * 1440).position, pb = ctx.satellite.sgp4(recIss, 0).position;
  const direct = Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z);
  const viaTool = twice.rows[0] ? twice.rows[0].km : NaN;
  say(direct > 1 && Math.abs(viaTool - direct) < 0.01, `전파 시각이 새 TLE 의 에포크다(도구 ${viaTool.toFixed(2)}km · 직접 ${direct.toFixed(2)}km)`);
  const reversed = compareSnapshots(ctx, [{ tles: { 25544: iss } }], { tles: { 25544: earlier } });
  say(reversed.rows.length === 0, "더 새 TLE 를 옛것으로 전파하지 않는다(나이가 음수면 뺀다)");
  const missing = compareSnapshots(ctx, [{ tles: { 99999: earlier } }], { tles: { 25544: iss } });
  say(missing.rows.length === 0 && missing.failed === 0, "새 기록에 없는 위성은 건너뛴다");

  const cached = readCacheTles()["25544"];
  if (cached) {
    const real = driftOf(ctx, iss, cached);
    const age = (epochMs(cached.tle1) - parsed) / DAY_MS;
    if (real) console.log(`       (참고) 픽스처 ISS ${age.toFixed(0)}일 묵은 TLE → 시각 차이 ${real.shiftSec.toFixed(0)}초 · 위치 ${real.km.toFixed(0)}km`);
    else console.log(`       (참고) 픽스처 ISS ${age.toFixed(0)}일 묵은 TLE → 전파 실패`);
  }
  return bad;
}

if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === "--selftest") {
    const bad = selftest();
    console.log(`\n${bad ? "[FAIL]" : "[OK]"} tle_drift --selftest`);
    process.exit(bad ? 1 : 0);
  }
  if (cmd === "snapshot") process.exit(takeSnapshot());
  if (cmd === "compare") process.exit(compare());
  console.log("사용: node tools/tle_drift.js snapshot | compare | --selftest");
  process.exit(2);
}
