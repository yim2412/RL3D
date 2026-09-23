/* RL3D — 위성 상세 패널과 궤도 값 계산. panels.js 에서 분리(P14-4). */

// ── 위성 상세 패널 ────────────────────────────────────────────────────────────
/** satrec + 현재 시각으로 위성의 실시간 궤도 값을 계산. */
function satDetails(rec) {
  const now = new Date();
  let pv;
  try { pv = satellite.propagate(rec, now); } catch (_) { return null; }
  if (!pv || !pv.position) return null;
  const geo = satellite.eciToGeodetic(pv.position, satellite.gstime(now));
  const v = pv.velocity;
  return {
    lat: satellite.degreesLat(geo.latitude),
    lng: satellite.degreesLong(geo.longitude),
    alt: geo.height,  // km
    vel: v ? Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) : null,  // km/s
    periodMin: rec.no > 0 ? (2 * Math.PI) / rec.no : null,
    incl: rec.inclo != null ? rec.inclo / DEG : null,   // 경사각(deg)
    ecc: rec.ecco,
    // 원지점·근지점 고도(P14-3). 이심률만으로는 궤도 모양이 안 읽힌다 — `0.0005` 와
    // `0.7` 이 각각 어떤 궤도인지는 km 로 봐야 안다.
    ...apsides(rec),
  };
}

// 지구 중력상수(km³/s²)와 적도반지름(km). 고도는 **지표 기준**이라 반지름을 빼야 한다.
const MU_EARTH = 398600.4418;
const R_EARTH = 6378.137;

/**
 * TLE 평균운동 → 장반경 → 원지점·근지점 **고도**(P14-3).
 *
 * **SATCAT 의 `APOGEE`·`PERIGEE` 를 쓰지 않고 계산한다**(2026-09-13 실측):
 * 실제 `visual` 157건 대조에서 두 값의 차이는 중앙값 **2.69km** 로 둘 다 맞는 값인데,
 * TLE 는 **위성이 있으면 반드시 있고**(157/157) 현재 궤도를 반영한다. SATCAT 은
 * 스냅샷이고 그룹에 따라 아예 안 받는다(GPS·Starlink 등은 SATCAT 을 안 부른다).
 *
 * 같은 실측에서 SATCAT 의 `PERIOD`·`INCLINATION` 은 화면에 이미 있는 TLE 값과
 * 중앙값 0.06분 · 0.00° 차이라 **중복이어서 넣지 않았다** — 나란히 두면 같은 값이
 * 두 줄 나오고, 어쩌다 어긋나면 어느 쪽이 맞는지 화면이 말해주지 못한다.
 */
function apsides(rec) {
  if (!rec || !(rec.no > 0) || rec.ecco == null || rec.ecco < 0 || rec.ecco >= 1)
    return { apogee: null, perigee: null };
  const nRadPerSec = rec.no / 60;                       // rad/min → rad/s
  const a = Math.pow(MU_EARTH / (nRadPerSec * nRadPerSec), 1 / 3);   // 장반경(km)
  if (!isFinite(a) || a <= 0) return { apogee: null, perigee: null };
  return {
    apogee: a * (1 + rec.ecco) - R_EARTH,
    perigee: a * (1 - rec.ecco) - R_EARTH,
  };
}

/**
 * 원지점·근지점 한 줄. **원궤도면 두 값을 따로 쓰지 않는다** — `800 km · 799 km` 는
 * 두 줄을 차지하고도 "거의 원궤도"라는 한마디를 못 한다.
 * 기준 10km 는 실측에서 왔다: `visual` 157건의 원지점–근지점 차가 이 아래면
 * 사실상 원궤도로 읽힌다.
 */
function apsidesText(d) {
  if (d.apogee == null || d.perigee == null) return null;
  const ap = Math.round(d.apogee), pe = Math.round(d.perigee);
  const km = (v) => v.toLocaleString("ko-KR") + " km";
  if (Math.abs(ap - pe) < 10) return `${km(ap)} (거의 원궤도)`;
  return `${km(pe)} ~ ${km(ap)}`;
}

// ── 재진입 예보 (S16-2) ──────────────────────────────────────────────────────
// P12-8(재진입 표시)은 *"지난 실행에 있던 NORAD 가 사라졌는가"* 를 기억해야 해서 보류됐다.
// 그런데 **SGP4 자신이 답을 갖고 있다**: 대기권에 들어가면 값을 못 낸다. 그 첫 시점을
// 이진 탐색으로 찾으면 **새 저장 구조 없이** 예보가 나온다.
//
// 실측(2026-09-14, 최신 TLE 2,926건): **190건(6.5%)** 에 365일 안 예보가 나온다
// (30일 안 20건 · 가장 임박 1.0일 · 근지점 중앙 332km). GEO·MEO 는 0건이다.
// 비용은 위성당 16회 propagate ≈ **0.24ms** — 상세 패널 한 건이면 무시할 수준이다.
const DECAY_HORIZON_DAYS = 365;   // 이보다 먼 예보는 내지 않는다(불확실성이 값보다 크다)
const DECAY_SOON_DAYS = 30;       // 이 안이면 경고 색 + 배지. 실측 20건이 여기 든다
const DECAY_SEARCH_STEPS = 14;    // 365일을 0.02일까지 좁힌다

/** 그 시각에 SGP4 가 값을 내는가 — 못 내면 이미 대기권 안이라는 뜻이다. */
function sgp4Alive(rec, when) {
  let pv;
  try { pv = satellite.propagate(rec, when); } catch (_) { return false; }
  return !!(pv && pv.position && isFinite(pv.position.x));
}

/**
 * SGP4 가 값을 못 내는 첫 시점(일) — 순수 함수. 상한 안에서 안 죽으면 null.
 *
 * **이건 예보이지 관측이 아니다.** 궤도를 올리는 기동은 계산에 없다 — 화면이 그 가정을
 * 같이 적는다(P12-4 에서 정한 방식: "근사입니다"가 아니라 가정을 명시한다).
 * 실측에서 ISS 는 예보가 안 나온다(기동으로 유지). 걸리는 것은 방출된 큐브위성·로켓
 * 몸체처럼 **기동을 안 하는 물체**와, 의도적으로 고도를 내리는 중인 Starlink 다.
 */
function decayForecastDays(rec, nowMs, maxDays) {
  // **`rec.error` 로 거르면 안 된다.** 그건 TLE 의 성질이 아니라 **직전 전파가 남긴 찌꺼기**다
  // — 재진입 시점 너머로 한 번 전파하면 `error = 6` 이 박혀, **두 번째 호출부터 null** 이
  // 된다(실시간 위치는 멀쩡하다: `propagate` 가 매번 다시 쓴다). 2026-09-14 에 테스트가
  // 잡았다. 쓸 수 있는 rec 인지는 궤도요소로 본다 — `orbitBand()` 와 같은 기준.
  if (!rec || !(rec.no > 0)) return null;
  const t0 = nowMs == null ? Date.now() : nowMs;
  const hiDay = maxDays == null ? DECAY_HORIZON_DAYS : maxDays;
  const at = (d) => new Date(t0 + d * 86400000);
  if (!sgp4Alive(rec, at(0))) return 0;        // 지금 이미 못 낸다
  if (sgp4Alive(rec, at(hiDay))) return null;  // 상한까지 멀쩡하다
  let lo = 0, hi = hiDay;
  for (let i = 0; i < DECAY_SEARCH_STEPS; i++) {
    const mid = (lo + hi) / 2;
    if (sgp4Alive(rec, at(mid))) lo = mid; else hi = mid;
  }
  return hi;
}

/** 예보를 사람 말로 — 순수 함수. 먼 예보는 일 단위로 적으면 정밀해 보여서 거짓말이 된다. */
function decayText(days) {
  if (days == null || !isFinite(days)) return null;
  if (days < 1) return "이대로면 하루 안에 재진입";
  if (days < 100) return `이대로면 약 ${Math.round(days)}일 뒤 재진입`;
  return `이대로면 약 ${Math.round(days / 30.44)}개월 뒤 재진입`;
}

/** 재진입 예보 블록 — 예보가 없으면 빈 문자열(실측 93.5%가 여기다). */
function decayBlock(rec) {
  const days = decayForecastDays(rec);
  const text = decayText(days);
  if (!text) return "";
  const soon = days <= DECAY_SOON_DAYS;
  return `<div class="decay${soon ? " decay-soon" : ""}">🔥 ${escapeHtml(text)}` +
    `<div class="decay-note">궤도를 올리는 기동은 계산에 없습니다</div></div>`;
}

/**
 * 이 위성의 궤도가 **언제 관측된 것인지**(S16-1). 위 값들은 전부 이 TLE 에서 나온 것이라,
 * 그 나이를 모르면 화면의 좌표가 얼마나 믿을 만한지 알 수 없다.
 *
 * 실측(2026-09-14): 50일 된 TLE 로 계산한 위치는 최신 대비 **중앙 1,250km** 어긋났다
 * (저궤도 HXMT 2,880km · 고궤도 SDO 73km). 낡으면 줄에 경고 색을 준다.
 */
function tleAgeRow(rec) {
  const days = tleAgeDays(rec);
  const text = tleAgeText(days);
  if (!text) return "";
  if (days <= tleStaleLimit(rec)) return row("궤도 데이터", text);
  return `<div class="row"><div class="k">궤도 데이터</div>` +
    `<div class="v tle-old">${escapeHtml(text)} ⚠</div></div>`;
}

/** 매 초 바뀌는 값만 만든다 — 헤더·⭐ 버튼은 그대로 두고 이 부분만 교체한다. */
function satRowsHtml(s) {
  const d = satDetails(s.rec);
  return d
    ? row("NORAD ID", String(s.norad)) +
      row("고도", d.alt != null ? Math.round(d.alt).toLocaleString() + " km" : null) +
      row("속도", d.vel != null ? d.vel.toFixed(2) + " km/s" : null) +
      row("현재 위치", `${d.lat.toFixed(2)}°, ${d.lng.toFixed(2)}°`) +
      row("궤도 주기", d.periodMin != null ? d.periodMin.toFixed(1) + "분" : null) +
      row("경사각", d.incl != null ? d.incl.toFixed(2) + "°" : null) +
      row("근지점 ~ 원지점", apsidesText(d)) +
      row("이심률", d.ecc != null ? d.ecc.toFixed(4) : null) +
      tleAgeRow(s.rec)
    : `<div class="pass-empty">궤도 정보를 계산할 수 없습니다.</div>`;
}

/** SATCAT 메타데이터 행(P12-5) — **변하지 않는 값**이라 매 초 갱신에서 뺀다.
 *  메타가 없으면 빈 문자열: 위성은 그대로 보여야 하고, 없는 것을 "알 수 없음"으로
 *  채우면 화면이 거짓을 말한다. */
function satMetaHtml(norad) {
  const m = satMeta(norad);
  if (!m) return "";
  const rows =
    row("타입", m.type) +
    row("소유", m.owner) +
    row("상태", m.status) +
    row("발사일", m.launch_date) +
    row("발사장", m.launch_site) +
    row("국제 식별번호", m.intl_code) +
    row("크기", m.size) +
    row("재진입", m.decay_date);
  return rows ? `<div class="sat-meta">${rows}</div>` : "";
}

/** 재진입한 물체는 배지로 먼저 알린다 — 표 안의 한 줄은 눈에 안 들어온다. */
function satBadgeHtml(norad, rec) {
  const m = satMeta(norad);
  if (m && m.decay_date) return `<span class="badge m-failure">재진입</span>`;
  // **이미 재진입한 것**과 **곧 할 것**은 다른 말이다(S16-2). SATCAT 의 `decay_date` 는
  // 우리가 쓰는 그룹에서 실측 0건이라(P12-8) 위 배지는 사실상 안 뜬다 — 이쪽이 실제로 뜬다.
  const d = rec == null ? null : decayForecastDays(rec);
  if (d != null && d <= DECAY_SOON_DAYS) return `<span class="badge m-failure">재진입 임박</span>`;
  if (m && m.type && m.type !== "위성체") return `<span class="badge m-partial">${escapeHtml(m.type)}</span>`;
  return `<span class="badge m-upcoming">위성</span>`;
}

function openSatPanel(s) {
  satPanelId = s.norad;  // 이 위성이 열려 있는 동안 매 초 값 갱신
  const body = document.getElementById("panel-body");
  body.innerHTML =
    `<h2>🛰 ${escapeHtml(s.name)}</h2>` +
    satBadgeHtml(s.norad, s.rec) +
    favBtnHtml("sat", s.norad) +
    // 예보는 **여기(정적 부분)에서 한 번만** 계산한다. `satRowsHtml` 은 매 초 다시 도는데
    // 이 값은 초 단위로 바뀌지 않는다 — 넣으면 1초마다 16회 propagate 를 버리게 된다.
    decayBlock(s.rec) +
    satMetaHtml(s.norad) +
    `<div class="st-note">아래 값은 실시간으로 갱신됩니다.</div>` +
    `<div id="sat-rows">${satRowsHtml(s)}</div>`;
  bindFavBtn(body);
  openRightPanel("panel");
}

/** 매 초 호출 — 값만 갈아끼운다. 패널 전체를 다시 그리면 ⭐ 버튼 클릭이 씹힌다. */
function refreshSatPanel(s) {
  const el = document.getElementById("sat-rows");
  if (el) el.innerHTML = satRowsHtml(s);
  else openSatPanel(s);
}
