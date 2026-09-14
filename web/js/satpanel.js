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
function satBadgeHtml(norad) {
  const m = satMeta(norad);
  if (m && m.decay_date) return `<span class="badge m-failure">재진입</span>`;
  if (m && m.type && m.type !== "위성체") return `<span class="badge m-partial">${escapeHtml(m.type)}</span>`;
  return `<span class="badge m-upcoming">위성</span>`;
}

function openSatPanel(s) {
  satPanelId = s.norad;  // 이 위성이 열려 있는 동안 매 초 값 갱신
  const body = document.getElementById("panel-body");
  body.innerHTML =
    `<h2>🛰 ${escapeHtml(s.name)}</h2>` +
    satBadgeHtml(s.norad) +
    favBtnHtml("sat", s.norad) +
    satMetaHtml(s.norad) +
    `<div class="st-note">아래 값은 실시간으로 갱신됩니다.</div>` +
    `<div id="sat-rows">${satRowsHtml(s)}</div>`;
  bindFavBtn(body);
  document.getElementById("panel").classList.remove("hidden");
}

/** 매 초 호출 — 값만 갈아끼운다. 패널 전체를 다시 그리면 ⭐ 버튼 클릭이 씹힌다. */
function refreshSatPanel(s) {
  const el = document.getElementById("sat-rows");
  if (el) el.innerHTML = satRowsHtml(s);
  else openSatPanel(s);
}
