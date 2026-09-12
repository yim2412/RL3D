/* RL3D — 발사 궤적 근사선 (P12-4).
 *
 * 보류된 Phase 4(실시간 텔레메트리)의 **실현 가능한 대체**다. 무료 텔레메트리 소스가 없으니
 * 실제 비행 경로는 못 그린다. 대신 발사장 좌표와 **목표 궤도 경사각**으로 발사 방위각을 풀어
 * 상승 구간을 대권(great circle)으로 근사한다.
 *
 * **이건 실측이 아니다.** 그래서 "근사입니다" 한 줄로 때우지 않고 화면에 **가정을 숫자로**
 * 적는다(`ascentNote`) — 사용자가 이 선을 믿을지 스스로 판단할 근거는 그 한 줄뿐이다.
 */

// LL2 의 `mission.orbit.name` → 가정 경사각(deg). null 은 "발사장 위도"(최소 에너지)라는 뜻.
//
// **실측(2026-09-12, 캐시 441건 전수)**: 가장 많은 것이 `Low Earth Orbit` 250건(57%)인데
// LEO 경사는 28~97° 어디든 되므로 **이름만으로는 정할 수 없다.** 최소 에너지(=발사장 위도)로
// 두되 그 사실을 화면에 적는다. 그리지 않는 쪽도 검토했으나 절반 이상의 발사에서
// 기능이 사라지고, "모른다"는 사실은 문구로 전할 수 있다.
const ORBIT_INCLINATION = {
  "Sun-Synchronous Orbit": { inc: 98, why: "태양동기" },
  "Polar Orbit": { inc: 90, why: "극궤도" },
  "Medium Earth Orbit": { inc: 55, why: "중궤도 통상값" },
  "Geostationary Transfer Orbit": { inc: null, why: "정지궤도 전이 — 최소 에너지" },
  "Geosynchronous Transfer Orbit": { inc: null, why: "정지궤도 전이 — 최소 에너지" },
  "Supersynchronous Transfer Orbit": { inc: null, why: "초동기 전이 — 최소 에너지" },
  "Geosynchronous Orbit": { inc: null, why: "정지궤도 — 최소 에너지" },
  "Low Earth Orbit": { inc: null, why: "최소 에너지", vague: true },
  "Elliptical Orbit": { inc: null, why: "최소 에너지", vague: true },
  "Unknown": { inc: null, why: "최소 에너지", vague: true },
  // 지구를 벗어나는 미션도 상승 구간은 주차 궤도(경사 ≈ 발사장 위도)에서 시작한다
  "Lunar Orbit": { inc: null, why: "주차 궤도 — 최소 에너지" },
  "Mars Orbit": { inc: null, why: "주차 궤도 — 최소 에너지" },
  "Heliocentric L1": { inc: null, why: "주차 궤도 — 최소 에너지" },
  "Sun-Earth L2": { inc: null, why: "주차 궤도 — 최소 에너지" },
  "Asteroid": { inc: null, why: "주차 궤도 — 최소 에너지" },
  // 궤도 진입이 없다 → 그릴 것이 없다. 억지로 그리면 없는 궤도를 지어내는 셈이다.
  "Suborbital": null,
};

const ASCENT_RANGE_KM = 2200;   // 상승~궤도 진입까지의 대략적인 downrange(약 8~9분)
const ASCENT_POINTS = 30;
const EARTH_R_KM = 6371;

/**
 * 목표 경사각 `inc`(deg)와 발사장 위도 `lat`(deg) → 발사 방위각(deg, 북=0 시계방향). 순수 함수.
 *
 * 구면 삼각법: `sin A = cos i / cos φ`.
 *  - 순행(i < 90) → 북동쪽 해를 쓴다(실제 순행 발사는 동쪽으로 나간다)
 *  - 역행(i ≥ 90) → `180 − A`(남쪽 해). 반덴버그의 태양동기 발사가 남서로 나가는 이유다
 *  - **|cos i / cos φ| > 1 이면 그 경사각은 이 위도에서 불가능하다**(i < |φ|).
 *    최소 경사 = 위도이므로 정동(90°)으로 클램프한다 — 예외를 던지면 선만 사라진다.
 */
function ascentAzimuth(inc, lat) {
  const cosLat = Math.cos(lat * DEG);
  if (!isFinite(inc) || !isFinite(lat) || Math.abs(cosLat) < 1e-9) return 90;
  const s = Math.cos(inc * DEG) / cosLat;
  if (s >= 1) return 90;      // i ≤ |φ| — 이 위도에서 가능한 최소 경사 = 정동
  if (s <= -1) return 270;    // 역행 쪽 극단
  const a = Math.asin(s) / DEG;
  return inc >= 90 ? 180 - a : ((a % 360) + 360) % 360;
}

/** 이 발사에 쓸 경사각 가정. 그리지 않는 궤도면 null. 순수 함수. */
function ascentAssumption(launch) {
  if (!launch || typeof launch.lat !== "number" || typeof launch.lng !== "number") return null;
  const key = launch.orbit || "Unknown";
  const spec = Object.prototype.hasOwnProperty.call(ORBIT_INCLINATION, key)
    ? ORBIT_INCLINATION[key] : ORBIT_INCLINATION.Unknown;
  if (spec === null) return null;                       // Suborbital 등 — 그릴 것이 없다
  const siteLat = Math.abs(launch.lat);
  const inc = spec.inc == null ? siteLat : spec.inc;
  return { inc, why: spec.why, vague: !!spec.vague, fromSiteLat: spec.inc == null };
}

/**
 * 대권을 따라 `distKm` 만큼 간 지점 [lng, lat]. 순수 함수.
 * 방위각이 일정한 항정선(rhumb)이 아니라 **대권**을 쓴다 — 로켓이 따르는 것은 궤도면이다.
 */
function greatCirclePoint(lat, lng, azimuthDeg, distKm) {
  const d = distKm / EARTH_R_KM;
  const br = azimuthDeg * DEG, la = lat * DEG, lo = lng * DEG;
  const sinLat = Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(br);
  const lat2 = Math.asin(Math.max(-1, Math.min(1, sinLat)));
  const lng2 = lo + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(la),
                               Math.cos(d) - Math.sin(la) * sinLat);
  // 경도를 -180~180 으로 되돌린다(±180 을 넘는 값은 splitAtDateline 이 못 알아본다)
  return [(((lng2 / DEG + 540) % 360) - 180), lat2 / DEG];
}

/** 발사 1건 → 근사 상승 경로. 그리지 않는 궤도면 null. 순수 함수. */
function ascentPath(launch) {
  const a = ascentAssumption(launch);
  if (!a) return null;
  const az = ascentAzimuth(a.inc, launch.lat);
  const points = [];
  for (let i = 0; i <= ASCENT_POINTS; i++) {
    points.push(greatCirclePoint(launch.lat, launch.lng, az, (ASCENT_RANGE_KM * i) / ASCENT_POINTS));
  }
  return { azimuth: az, inc: a.inc, why: a.why, vague: a.vague,
           fromSiteLat: a.fromSiteLat, points };
}

/** 나침반 방위 — 숫자만 적으면 어느 쪽인지 바로 안 읽힌다. 순수 함수. */
const COMPASS_KO = ["북", "북동", "동", "남동", "남", "남서", "서", "북서"];
function compassKo(az) {
  return COMPASS_KO[Math.round((((az % 360) + 360) % 360) / 45) % 8];
}

/**
 * 화면에 적을 **가정**. "근사입니다"만으로는 무엇을 가정했는지 알 수 없다. 순수 함수.
 * 경사각을 발사장 위도로 놓은 경우(특히 LEO)는 그 값이 **모른다는 뜻**임을 함께 적는다.
 */
function ascentNote(path) {
  if (!path) return null;
  const head = `가정: 경사 ${path.inc.toFixed(1)}° (${path.why})` +
               ` · 방위 ${path.azimuth.toFixed(0)}° ${compassKo(path.azimuth)}쪽`;
  const warn = path.vague
    ? "실제 저궤도 경사는 28~97° 어디든 됩니다 — 이 선은 목표 궤도를 모를 때의 최소 에너지 가정입니다."
    : null;
  return { head, warn };
}

/** 가정 문구 → 패널 HTML. **패널 위쪽에 둔다** — 맨 아래에 붙이면 긴 패널에서
 *  스크롤 끝까지 내려야 보이고, 그건 "명시했다"고 할 수 없다(P12-16 에서 배운 것). */
function ascentNoteHtml(note) {
  if (!note) return "";
  return `<div class="ascent-note"><b>🚀 상승 궤적(근사)</b>` +
    `<div class="an-head">${escapeHtml(note.head)}</div>` +
    (note.warn ? `<div class="an-warn">${escapeHtml(note.warn)}</div>` : "") +
    `<div class="an-foot">실제 비행 기록이 아니라 발사장 좌표와 목표 궤도로 푼 계산입니다.</div></div>`;
}

// ── 지도 레이어 ───────────────────────────────────────────────────────────────
// 점선으로 그린다 — **실선은 실측처럼 보인다.** 화면 문구와 같은 말을 선 모양으로도 한다.
function setupAscentLayer() {
  map.addSource("launch-track", { type: "geojson", data: EMPTY_FC });
  map.addLayer({
    id: "launch-track", type: "line", source: "launch-track",
    layout: { "line-cap": "round" },
    paint: {
      "line-color": "#7dd3fc",
      "line-width": 2,
      "line-opacity": 0.75,
      "line-dasharray": [2, 2],
    },
  });
}

/** 상세 패널에서 연 발사의 근사 상승선을 그린다. 그릴 수 없으면 지운다. */
function drawAscentPath(launch) {
  const src = map && map.getSource && map.getSource("launch-track");
  if (!src) return null;
  const path = ascentPath(launch);
  if (!path) { src.setData(EMPTY_FC); return null; }
  src.setData({
    type: "Feature",
    // 날짜변경선을 넘는 경로(적도 부근 동향 발사가 실제로 넘는다)를 가짜 직선으로 만들지 않는다
    geometry: { type: "MultiLineString", coordinates: splitAtDateline(path.points) },
    properties: {},
  });
  return path;
}

function clearAscentPath() {
  const src = map && map.getSource && map.getSource("launch-track");
  if (src) src.setData(EMPTY_FC);
}
