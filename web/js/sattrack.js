/* RL3D — 위성 지상궤적선·추적 모드·미래 위치(P6-1·P12-16). sats.js 에서 분리(P12-23). */

// ── 지상궤적선 + 추적 모드 (P6-1) ─────────────────────────────────────────────
/** 선택 위성의 지상궤적(약 1주기)을 1분 간격으로 계산해 MultiLineString Feature로.
 *  날짜변경선(±180°) 통과 지점에서 선을 끊어 지도를 가로지르는 가짜 선을 막는다. */
/** 날짜변경선에서 끊어 세그먼트로 나눈다 — **순수 함수**라 합성 입력으로 규칙을 잴 수 있다.
 *
 * 끊지 않으면 +179° 에서 -179° 로 가는 점 두 개가 지도를 가로지르는 **가짜 직선**이 된다.
 * 점이 1개뿐인 세그먼트는 버린다(선이 그려지지 않는다).
 *
 * (2026-09-11 분리) 이 규칙이 루프 안에 박혀 있어 테스트가 실제 SGP4 결과에 의존했고,
 * **"1주기면 반드시 날짜변경선을 넘는다"는 전제가 틀려** 시각에 따라 통과/실패가 갈렸다 —
 * 실측: 경도가 156.4° → -177.9° 로 연속 감소만 하고 넘지 않는 구간이 있다.
 */
function splitAtDateline(points) {
  const segments = [];
  let cur = [];
  let prevLng = null;
  for (const [lng, lat] of points) {
    if (prevLng != null && Math.abs(lng - prevLng) > 180) {
      if (cur.length > 1) segments.push(cur);
      cur = [];
    }
    cur.push([lng, lat]);
    prevLng = lng;
  }
  if (cur.length > 1) segments.push(cur);
  return segments;
}

/** 평균운동(rad/min) → 주기(분). 비정상값이면 LEO 기본 90분. */
function orbitPeriodMin(rec) {
  const p = (rec && rec.no > 0) ? (2 * Math.PI) / rec.no : 90;
  return (!isFinite(p) || p <= 0 || p > 24 * 60) ? 90 : p;
}

/**
 * 궤적을 그릴 시간 범위(분, 현재 기준) — **순수 함수** (P12-16).
 *
 * 기본은 ±½주기(P6-1 그대로). "앞으로 볼 시간"을 늘리면 **앞쪽만** 길어진다:
 * 뒤쪽(지나온 길)까지 같이 늘리면 화면이 선으로 덮여 지금 어디인지가 묻힌다.
 * 점 간격은 범위에 맞춰 성기게 잡는다 — 6시간을 1분 간격으로 그리면 360점이 되고,
 * 그 해상도는 화면에서 구분되지도 않으면서 30초마다 다시 계산된다.
 */
function trackWindow(periodMin, aheadMin) {
  const half = periodMin / 2;
  const ahead = Math.max(0, aheadMin || 0);
  const span = half + half + ahead;
  // ceil 이라야 점 수가 실제로 상한 아래로 들어온다(round 면 GEO+6시간에서 257점이 됐다).
  return { from: -half, to: half + ahead, stepMin: Math.max(1, Math.ceil(span / 240)) };
}

/** 슬라이더 값 → 사람이 읽는 말. 0 은 "지금"이다(0분 뒤가 아니다). */
function aheadLabel(min) {
  if (!min) return "지금";
  const h = Math.floor(min / 60), m = min % 60;
  if (!h) return `${m}분 뒤`;
  return m ? `${h}시간 ${m}분 뒤` : `${h}시간 뒤`;
}

/** 지정 시각(분 뒤)의 위성 위치 [lng, lat]. 계산 불가면 null. */
function satPointAt(rec, minutesAhead) {
  const t = new Date(Date.now() + (minutesAhead || 0) * 60000);
  let pv;
  try { pv = satellite.propagate(rec, t); } catch (_) { return null; }
  if (!pv || !pv.position) return null;
  const geo = satellite.eciToGeodetic(pv.position, satellite.gstime(t));
  const lng = satellite.degreesLong(geo.longitude);
  const lat = satellite.degreesLat(geo.latitude);
  return (isFinite(lng) && isFinite(lat)) ? [lng, lat] : null;
}

function computeGroundTrack(rec, aheadMin) {
  const win = trackWindow(orbitPeriodMin(rec), aheadMin);
  const points = [];
  for (let dm = win.from; dm <= win.to; dm += win.stepMin) {
    const t = new Date(Date.now() + dm * 60000);
    let pv;
    try { pv = satellite.propagate(rec, t); } catch (_) { continue; }
    if (!pv || !pv.position) continue;
    const geo = satellite.eciToGeodetic(pv.position, satellite.gstime(t));
    const lng = satellite.degreesLong(geo.longitude);
    const lat = satellite.degreesLat(geo.latitude);
    if (!isFinite(lng) || !isFinite(lat)) continue;
    points.push([lng, lat]);
  }
  return { type: "Feature",
           geometry: { type: "MultiLineString", coordinates: splitAtDateline(points) },
           properties: {} };
}

function drawGroundTrack() {
  const src = map.getSource("sat-track");
  if (!src) return;
  src.setData(selectedSat ? computeGroundTrack(selectedSat.rec, trackAheadMin) : EMPTY_FC);
  drawFutureMarker();
}

/** "N분 뒤 어디" 고스트 마커 (P12-16). 슬라이더가 0이면 지우고, 아니면 그 시각 위치로.
 *  라벨은 DOM 마커로 그린다 — **symbol text 는 쓰지 않는다**(WebView2 에서 온라인 glyphs
 *  요청이 지도 전체 렌더를 막은 적이 있다). */
function drawFutureMarker() {
  const at = (selectedSat && trackAheadMin > 0)
    ? satPointAt(selectedSat.rec, trackAheadMin) : null;
  if (!at) {
    if (futureMarker) { futureMarker.remove(); futureMarker = null; }
    return;
  }
  if (!futureMarker) {
    const el = document.createElement("div");
    el.className = "future-marker";
    futureMarker = new maplibregl.Marker({ element: el, anchor: "center" });
  }
  futureMarker.getElement().textContent = aheadLabel(trackAheadMin);
  futureMarker.setLngLat(at).addTo(map);
}

/** 컨트롤에 적을 말 — 시간 + **그때 어디인지**.
 *
 * 좌표를 함께 적는 이유: 지도가 확대돼 있으면 2시간 뒤 위치는 **화면 밖**이다(ISS 는
 * 지구 반대편에 가 있다). 그러면 슬라이더를 올려도 아무 일도 안 일어난 것처럼 보인다
 * — 2026-09-11 실제 화면 확인에서 그렇게 보였다.
 */
function aheadStatus(min, point) {
  const label = aheadLabel(min);
  if (!min || !point) return label;
  return `${label} · ${point[1].toFixed(1)}°, ${point[0].toFixed(1)}°`;
}

/** 슬라이더 변경 — 궤적과 고스트 마커를 다시 그린다(저장하지 않는다: 일시적인 상태다). */
function onTrackAhead() {
  const el = document.getElementById("sat-ahead");
  trackAheadMin = +el.value || 0;
  drawGroundTrack();
  const at = (selectedSat && trackAheadMin > 0)
    ? satPointAt(selectedSat.rec, trackAheadMin) : null;
  document.getElementById("sat-ahead-label").textContent = aheadStatus(trackAheadMin, at);
}

function selectSatellite(s) {
  selectedSat = s;
  drawGroundTrack();
  // 궤적은 지구 자전으로 서서히 이동 → 30초마다 재계산해 신선도 유지
  if (trackTimer) clearInterval(trackTimer);
  trackTimer = setInterval(drawGroundTrack, 30000);
  updateSatCtrl();
}

function deselectSatellite() {
  selectedSat = null;
  tracking = false;
  if (futureMarker) { futureMarker.remove(); futureMarker = null; }
  if (trackTimer) { clearInterval(trackTimer); trackTimer = null; }
  const src = map.getSource("sat-track");
  if (src) src.setData(EMPTY_FC);
  document.getElementById("sat-ctrl").classList.add("hidden");
  document.getElementById("pass-panel").classList.add("hidden");  // 통과 예측은 위성 종속
  if (satPanelId != null) {  // 위성 상세 패널이 이 위성 것이면 닫는다
    document.getElementById("panel").classList.add("hidden");
    satPanelId = null;
  }
}

/** 선택 위성 컨트롤 박스(이름·추적 버튼) 상태 갱신 + 표시. */
function updateSatCtrl() {
  const box = document.getElementById("sat-ctrl");
  if (!selectedSat) { box.classList.add("hidden"); return; }
  document.getElementById("sat-ctrl-name").textContent = "🛰 " + selectedSat.name;
  const btn = document.getElementById("sat-track-btn");
  btn.textContent = tracking ? "추적 중지" : "추적";
  btn.classList.toggle("active", tracking);
  document.getElementById("sat-obs-btn").classList.toggle("active", !!observer);
  document.getElementById("sat-pass-btn").disabled = !observer;  // 관측지 없으면 예측 불가
  box.classList.remove("hidden");
}

function toggleTracking() {
  if (!selectedSat) return;
  tracking = !tracking;
  updateSatCtrl();
  if (tracking) centerOnSelected();
}

/** 선택 위성의 현재 위치로 지도 중심을 부드럽게 이동. */
function centerOnSelected() {
  if (!selectedSat) return;
  const now = new Date();
  let pv;
  try { pv = satellite.propagate(selectedSat.rec, now); } catch (_) { return; }
  if (!pv || !pv.position) return;
  const geo = satellite.eciToGeodetic(pv.position, satellite.gstime(now));
  const lng = satellite.degreesLong(geo.longitude);
  const lat = satellite.degreesLat(geo.latitude);
  if (!isFinite(lng) || !isFinite(lat)) return;
  map.easeTo({ center: [lng, lat], duration: 950 });
}
