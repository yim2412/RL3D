/* RL3D — 궤도 대역 분류, 위성 레이어와 실시간 위치, 지상궤적·추적, 통과 예측, 그룹 선택 UI. */

// ── 궤도 대역 분류 (P11-3) ────────────────────────────────────────────────────
// 실시간 고도(P10-5의 색)가 아니라 평균운동에서 얻은 **평균 고도**로 나눈다.
// 전파(propagate) 없이 즉시 구할 수 있고, 타원 궤도도 한 대역에 안정적으로 머문다.
const BANDS = [
  { key: "leo", label: "저궤도 LEO", short: "LEO", note: "~2,000km" },
  { key: "meo", label: "중궤도 MEO", short: "MEO", note: "~35,000km" },
  { key: "geo", label: "정지궤도 GEO", short: "GEO", note: "35,000km~" },
];

function orbitBand(rec) {
  const n = rec && rec.no > 0 ? rec.no / 60 : 0;   // rad/min → rad/s
  if (!n || !isFinite(n)) return "leo";            // 값이 이상하면 다수인 LEO 로
  const a = Math.cbrt(398600.4418 / (n * n));      // 반장축(km)
  const alt = a - 6371;
  if (alt < 2000) return "leo";
  return alt < 35000 ? "meo" : "geo";
}

function bandLabel(key) {
  const b = BANDS.find((x) => x.key === key);
  return b ? b.short : "";
}

/** 대역·종류·소유국 필터를 통과하는 위성만. 지도·목록·개수가 **같은 기준**을 쓰게 한 곳에 둔다.
 *  관심 위성은 필터와 무관하게 남긴다 — 관심 탭에서 골랐는데 지도에 점이 없으면 고장으로 보인다. */
function visibleSats() {
  return satrecs.filter((s) => {
    if (isFavSat(s.norad)) return true;
    if (satBands[s.band] === false) return false;
    // 메타가 아직 안 왔거나(비동기) 실패했으면 **숨기지 않는다.** 분류를 모르는 것을
    // 숨기면 SATCAT 이 늦게 올 때 위성이 사라졌다 나타난다.
    const m = satMeta(s.norad);
    if (!m) return true;
    if (m.type && satTypesOff[m.type]) return false;
    if (m.owner && satOwnersOff[m.owner]) return false;
    return true;
  });
}

/** 불러온 위성의 종류·소유국 분포. 필터 UI 는 **고정 표가 아니라 이 결과**로 만든다.
 *  SATCAT 의 나라 코드는 130종이고 그룹마다 달라서, 고정 목록을 두면 반드시 어긋난다.
 *  반환: [{ value, count }] — 많은 순. */
function satFacet(field) {
  const counts = new Map();
  for (const s of satrecs) {
    const m = satMeta(s.norad);
    const v = m && m[field];
    if (!v) continue;   // 메타가 없는 위성은 세지 않는다(필터로 숨기지도 않는다)
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, "ko"));
}

// ── 위성 (Celestrak TLE → satellite.js SGP4 실시간 위치) ──────────────────────
function setupSatelliteLayer() {
  // 지상궤적선 — 위성 소스보다 먼저 추가해 위성 점이 선 위에 렌더되게.
  map.addSource("sat-track", { type: "geojson", data: EMPTY_FC });
  map.addLayer({
    id: "sat-track-line",
    type: "line",
    source: "sat-track",
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": "#7dd3fc", "line-width": 1.6, "line-opacity": 0.75 },
  });

  map.addSource("satellites", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  map.addLayer({
    id: "sat-layer",
    type: "circle",
    source: "satellites",
    layout: { visibility: "none" },  // 기본 OFF — 발사 지도에 집중, 필요 시 토글
    paint: {
      "circle-radius": ["case", ["==", ["get", "fav"], true], 5.5, 2.8],  // 관심 위성은 크게(P11-2)
      // 고도(km)로 색을 나눈다 — LEO(하늘색) → MEO(보라) → GEO(주황).
      // 점 하나하나가 어느 궤도 대역인지 눈으로 구분된다.
      "circle-color": [
        "interpolate", ["linear"], ["coalesce", ["get", "alt"], 500],
        300, "#7dd3fc",     // 저궤도 — ISS·Starlink 대역
        2000, "#a78bfa",    // 중궤도 진입
        20000, "#f472b6",   // GPS·Galileo 대역
        35786, "#fbbf24",   // 정지궤도
      ],
      "circle-opacity": 0.9,
      "circle-stroke-width": ["case", ["==", ["get", "fav"], true], 2, 0.6],
      "circle-stroke-color": ["case", ["==", ["get", "fav"], true], FAV_COLOR, "#9fb0ff"],
    },
  });
  // 넓은 투명 클릭 영역 — 위성 점이 작고 계속 움직여 클릭이 빗나가지 않게(보이지 않음)
  map.addLayer({
    id: "sat-hit",
    type: "circle",
    source: "satellites",
    layout: { visibility: "none" },
    paint: { "circle-radius": 10, "circle-color": "#000000", "circle-opacity": 0 },
  });
  // 위성 클릭 → 상세 정보 패널 + 선택(지상궤적 표시)
  map.on("click", "sat-hit", (e) => {
    if (settingObserver) return;  // 관측 위치 지정 중엔 선택하지 않음
    const f = e.features && e.features[0];
    if (!f) return;
    const s = satrecs.find((x) => String(x.norad) === String(f.properties.norad));
    if (s) { selectSatellite(s); openSatPanel(s); }
  });
  // 커서: 손 모양 대신 십자(정확한 조준) — 작은 위성 점을 겨냥하기 쉽게
  map.on("mouseenter", "sat-hit", () => { map.getCanvas().style.cursor = "crosshair"; });
  map.on("mouseleave", "sat-hit", () => { map.getCanvas().style.cursor = ""; });

  // 사용자가 지도를 직접 드래그하면 추적 모드 자동 해제(easeTo는 dragstart를 발생시키지 않음)
  map.on("dragstart", () => { if (tracking) { tracking = false; updateSatCtrl(); } });
  // 관측 위치 지정 모드일 때만 지도 클릭을 소비
  map.on("click", onMapClickForObserver);
}

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

// ── 관측 위치 + 통과 예측 (P6-2) ──────────────────────────────────────────────
const DIRS8 = ["북", "북동", "동", "남동", "남", "남서", "서", "북서"];
function azToCompass(azDeg) {
  return DIRS8[Math.round((((azDeg % 360) + 360) % 360) / 45) % 8];
}

function showObserverMarker() {
  if (!observer) return;
  if (!observerMarker) {
    const el = document.createElement("div");
    el.className = "obs-marker";
    el.textContent = "📍";
    observerMarker = new maplibregl.Marker({ element: el, anchor: "bottom" });
  }
  observerMarker.setLngLat([observer.lng, observer.lat]).addTo(map);
}

/** "지도를 클릭해 관측 위치 지정" 모드 진입. 다음 지도 클릭이 위치를 확정한다. */
function beginSetObserver() {
  settingObserver = true;
  map.getCanvas().style.cursor = "crosshair";
  showStatus("지도를 클릭해 관측 위치를 지정하세요");
}

function onMapClickForObserver(e) {
  if (!settingObserver) return;
  observer = { lat: +e.lngLat.lat.toFixed(4), lng: +e.lngLat.lng.toFixed(4) };
  saveSettings({ observer });  // settings.json에 저장(P8-9)
  showObserverMarker();
  settingObserver = false;
  map.getCanvas().style.cursor = "";
  showStatus(null);
  updateSatCtrl();  // 통과 예측 버튼 활성화
}

// ── 가시 판정 (P12-1) ─────────────────────────────────────────────────────────
// "기하학적으로 지나간다"와 "실제로 눈에 보인다"는 다르다. visual 그룹의 존재 이유가
// 후자인데 그 판정이 없었다. 두 조건을 함께 봐야 한다:
//   ① 관측자가 어둡다 (해가 졌다)  ② 위성은 아직 햇빛을 받는다 (지구 그림자 밖)
// 태양 위치는 map.js 의 sunEquatorial/gmstHours 를 그대로 쓴다 — 터미네이터(P6-3)가
// 이미 쓰던 계산이라 두 벌 만들지 않는다. index.html 로드 순서상 map.js 가 먼저다.

const EARTH_RADIUS_KM = 6378.137;
// 시민박명 종료. 이보다 태양이 낮으면 하늘이 충분히 어둡다고 본다.
// −12°(항해박명)·−18°(천문박명)로 올릴수록 엄격해지고 통과 수가 줄어든다.
const DARK_SUN_ELEV = -6;

/** 태양 방향 단위벡터(ECI, 지구중심). 거리는 판정에 필요 없어 방향만 쓴다. */
function sunEciUnit(date) {
  const { alpha, delta } = sunEquatorial(julianDay(date));
  const a = alpha * DEG, d = delta * DEG;
  return { x: Math.cos(d) * Math.cos(a), y: Math.cos(d) * Math.sin(a), z: Math.sin(d) };
}

/** 위성이 햇빛을 받는가 — 원통 그림자 근사.
 *
 * 반그림자·대기 굴절은 무시한다(수 초 차이라 "볼 만한 통과" 판단을 바꾸지 않는다).
 * 태양 쪽 반구에 있으면 무조건 조명. 반대쪽이면 태양축에서의 수직거리가 지구
 * 반지름보다 클 때만 조명이다.
 */
function isSunlit(posEci, sunUnit) {
  if (!posEci) return false;
  const dot = posEci.x * sunUnit.x + posEci.y * sunUnit.y + posEci.z * sunUnit.z;
  if (dot >= 0) return true;                       // 태양 쪽 반구
  const r2 = posEci.x * posEci.x + posEci.y * posEci.y + posEci.z * posEci.z;
  const perp = Math.sqrt(Math.max(0, r2 - dot * dot));   // 태양축에서의 수직거리
  return perp > EARTH_RADIUS_KM;
}

/** 관측지에서 본 태양 고도(도). 음수가 클수록 어둡다. */
function observerSunElev(obs, date) {
  const jd = julianDay(date);
  const { alpha, delta } = sunEquatorial(jd);
  const ha = (gmstHours(jd) * 15 + obs.lng - alpha) * DEG;   // 시간각
  const phi = obs.lat * DEG, dec = delta * DEG;
  const sinEl = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha);
  return Math.asin(Math.max(-1, Math.min(1, sinEl))) / DEG;
}

/** 시각별 태양 정보를 미리 계산해 둔다 — 위성마다 다시 구하면 같은 값을 수백 번 만든다.
 *  (2026-09-11 실측: visual 157개 × 24시간 30초 간격 = 전파 45만 회 / 413ms) */
function sunTable(obs, start, end, stepMs) {
  const table = [];
  for (let t = start; t <= end; t += stepMs) {
    const date = new Date(t);
    table.push({ t, unit: sunEciUnit(date), dark: observerSunElev(obs, date) < DARK_SUN_ELEV });
  }
  return table;
}

/** 관측지 기준, 향후 hours시간의 위성 통과(고도>minEl 연속 구간)를 계산.
 *
 * 통과마다 `visible` 을 붙인다(P12-1) — 그 통과 중 **한 순간이라도** 관측자가 어둡고
 * 위성이 햇빛을 받으면 true. 걸러내지 않고 표시만 하는 이유는, 전파 수신·안테나 목적이면
 * 낮 통과도 의미가 있어서다(화면의 체크박스로 사용자가 고른다).
 *
 * sun 을 넘기면 미리 계산한 태양표를 쓴다(P12-2 가 157개 위성에 같은 표를 공유).
 * 안 넘기면 이 함수가 직접 만든다 — 위성 1개짜리 기존 호출부는 고치지 않아도 된다.
 */
function computePasses(rec, obs, hours = 24, stepSec = 30, minEl = 10, sun = null) {
  const observerGd = { latitude: obs.lat * DEG, longitude: obs.lng * DEG, height: 0 };
  const passes = [];
  let cur = null;
  const stepMs = stepSec * 1000;
  const start = Date.now();
  const end = start + hours * 3600 * 1000;
  const table = sun || sunTable(obs, start, end, stepMs);
  let i = 0;
  for (let t = start; t <= end; t += stepMs, i++) {
    const date = new Date(t);
    let pv;
    try { pv = satellite.propagate(rec, date); } catch (_) { continue; }
    if (!pv || !pv.position) continue;
    const ecf = satellite.eciToEcf(pv.position, satellite.gstime(date));
    const look = satellite.ecfToLookAngles(observerGd, ecf);
    const elDeg = look.elevation / DEG;
    const azDeg = look.azimuth / DEG;
    if (elDeg >= minEl) {
      const sky = table[i];
      // 관측자가 밝으면 조명 판정 자체를 건너뛴다(어차피 안 보인다) — 계산도 아낀다.
      const lit = !!sky && sky.dark && isSunlit(pv.position, sky.unit);
      if (!cur) cur = { start: t, startAz: azDeg, maxEl: elDeg, maxAz: azDeg, visible: lit };
      else if (elDeg > cur.maxEl) { cur.maxEl = elDeg; cur.maxAz = azDeg; }
      if (lit) {
        cur.visible = true;
        if (cur.visStart === undefined) cur.visStart = t;
        cur.visEnd = t;
        if (elDeg > (cur.visMaxEl || -90)) cur.visMaxEl = elDeg;
      }
      cur.end = t; cur.endAz = azDeg;
    } else if (cur) {
      passes.push(cur); cur = null;
    }
  }
  if (cur) passes.push(cur);  // 창 끝에서 진행 중이던 통과도 포함
  return passes;
}

function fmtPassTime(ms) {
  return new Date(ms).toLocaleString("ko-KR", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

/** 통과 1건을 목록 행으로. 가시 통과는 ☀ 로 표시하고 조명 구간 시각을 앞세운다. */
function passRow(p, name) {
  const dir = `${azToCompass(p.startAz)}→${azToCompass(p.endAz)}`;
  const dur = Math.max(1, Math.round((p.end - p.start) / 60000));
  // 가시 통과는 "언제 보이기 시작하는가"가 알고 싶은 값이다 — 통과 시작이 아니라 조명 시작.
  const when = p.visible && p.visStart !== undefined ? p.visStart : p.start;
  const el = p.visible && p.visMaxEl !== undefined ? p.visMaxEl : p.maxEl;
  const mark = p.visible ? `<span class="pass-vis" title="관측자가 어둡고 위성이 햇빛을 받는다">☀</span>` : "";
  const dim = p.visible ? "" : " pass-row-dim";
  return `<div class="pass-row${dim}">` +
    (name ? `<div class="pass-name">${escapeHtml(name)}</div>` : "") +
    `<div class="pass-time">${mark}${escapeHtml(fmtPassTime(when))}</div>` +
    `<div class="pass-meta">${escapeHtml(dir)} · 최대고도 ${Math.round(el)}° · ${dur}분</div>` +
    `</div>`;
}

function visibleOnly() {
  const el = document.getElementById("toggle-visible-only");
  return el ? el.checked : true;
}

function showPasses() {
  if (!selectedSat || !observer) return;
  const all = computePasses(selectedSat.rec, observer);
  const onlyVis = visibleOnly();
  const passes = onlyVis ? all.filter((p) => p.visible) : all;
  const panel = document.getElementById("pass-panel");
  const body = document.getElementById("pass-body");
  const head =
    `<h2>🛰 ${escapeHtml(selectedSat.name)} 통과 예측</h2>` +
    `<div class="pass-obs">관측지 ${observer.lat.toFixed(3)}, ${observer.lng.toFixed(3)} · 향후 24시간 · 최대고도 10° 이상` +
    (onlyVis ? ` · <b>눈에 보이는 것만</b>` : "") + `</div>`;
  if (passes.length === 0) {
    // 빈 이유를 구분해 알려준다 — "계산이 안 된 것"과 "조건에 안 맞는 것"은 다르다.
    const why = onlyVis && all.length > 0
      ? `통과는 ${all.length}건 있지만 <b>눈에 보이는 것은 없습니다</b>(낮이거나 위성이 지구 그림자 안).`
      : "예측된 통과가 없습니다.";
    body.innerHTML = head + `<div class="pass-empty">${why}</div>`;
  } else {
    body.innerHTML = head + passes.map((p) => passRow(p, null)).join("");
  }
  panel.classList.remove("hidden");
}

// ── 오늘 밤 볼 만한 통과 (P12-2) ──────────────────────────────────────────────
// 지금까지는 위성을 **1개 골라야** 통과를 볼 수 있었다 — 무엇을 고를지 모르면 못 쓴다.
// 관심 위성 + visual 그룹을 한 번에 훑어 최대고도 순으로 세운다.
const TONIGHT_HOURS = 24;

/** 훑을 대상: 관심 위성(전부) + visual 그룹. norad 로 중복 제거. */
function tonightTargets() {
  const seen = new Set();
  const out = [];
  for (const r of satrecs) {
    const isFav = favSats && favSats.includes(r.norad);
    // visual 그룹 여부는 로드된 satrecs 만으로 알 수 없다 → 관심 위성은 항상,
    // 나머지는 현재 로드된 것 전부를 본다(그룹 선택이 곧 사용자의 관심 범위다).
    if (!isFav && !r.rec) continue;
    if (seen.has(r.norad)) continue;
    seen.add(r.norad);
    out.push(r);
  }
  return out;
}

function computeTonight(obs, hours = TONIGHT_HOURS, stepSec = 30) {
  const start = Date.now(), end = start + hours * 3600 * 1000;
  const table = sunTable(obs, start, end, stepSec * 1000);
  const rows = [];
  for (const r of tonightTargets()) {
    let passes;
    try { passes = computePasses(r.rec, obs, hours, stepSec, 10, table); } catch (_) { continue; }
    for (const p of passes) {
      if (p.visible) rows.push({ name: r.name, norad: r.norad, pass: p });
    }
  }
  // 최대고도 순 — "가장 높이 뜨는 것"이 가장 잘 보이는 것이다.
  rows.sort((a, b) => (b.pass.visMaxEl || b.pass.maxEl) - (a.pass.visMaxEl || a.pass.maxEl));
  return rows;
}

/** 한 위성의 메타데이터. 없으면 null — 호출부는 항상 null 을 감당해야 한다. */
function satMeta(norad) {
  return (satcat && satcat[String(norad)]) || null;
}

/** 위성 메타데이터(P12-5)를 받아 둔다.
 *
 * 위성 표시와 **분리**한다: TTL 이 24시간이라 갱신 주기가 다르고, 이게 실패해도
 * 위성은 지도에 떠야 한다. 그래서 await 하지 않고 실패도 조용히 넘긴다.
 */
async function loadSatcat() {
  try {
    const res = await window.pywebview.api.get_satcat(satGroups, false);
    satcat = (res && res.satcat) || {};
    // 종류·소유국 목록은 메타가 있어야 만들 수 있다 → 도착한 지금 그린다(P12-5b).
    renderFacetFilters();
    applySatFilter();   // 저장돼 있던 필터가 이제서야 적용될 수 있다
  } catch (_) {
    satcat = satcat || {};   // 실패해도 이전 값을 버리지 않는다
  }
}

async function loadSatellites() {
  try {
    deselectSatellite();  // 재로드로 satrec이 갈리므로 이전 선택/궤적은 해제
    const res = await window.pywebview.api.get_satellites(false, satGroups);
    const sats = res.satellites || [];
    // TLE → SGP4 레코드. 파싱 실패한 위성 1개가 전체를 막지 않게 개별 try.
    satrecs = [];
    for (const s of sats) {
      try {
        const rec = satellite.twoline2satrec(s.tle1, s.tle2);
        if (rec && !rec.error) satrecs.push({ name: s.name, norad: s.norad_id, rec, band: orbitBand(rec) });
      } catch (_) { /* 이 위성만 건너뜀 */ }
    }
    loadSatcat();   // 메타데이터는 따로·늦게 와도 된다(위성 표시를 막지 않는다)
    updateSatCount();
    if (sidebarTab === "sats") renderSatList();  // 목록 탭이 열려 있으면 즉시 반영
    else if (sidebarTab === "favs") renderFavList();  // 관심 위성이 이제 붙는다
    if (res.error && !res.stale) showStatus(`⚠ 위성: ${res.error}`);
    // 토글이 켜져 있을 때만 계산 루프 시작(기본 OFF)
    if (document.getElementById("toggle-sat").checked) startSatelliteLoop();
  } catch (e) {
    console.error("위성 로드 실패", e);
  }
}

/** 모든 위성의 현재 위경도/고도를 계산해 GeoJSON 으로 지도에 반영. */
function updateSatellitePositions() {
  if (!map.getSource("satellites")) return;
  const now = new Date();
  const gmst = satellite.gstime(now);
  const features = [];
  for (const s of visibleSats()) {
    let pv;
    try { pv = satellite.propagate(s.rec, now); } catch (_) { continue; }
    const eci = pv && pv.position;
    if (!eci) continue;  // 전파 실패(궤도 붕괴/에폭 이탈 등)
    const geo = satellite.eciToGeodetic(eci, gmst);
    const lng = satellite.degreesLong(geo.longitude);
    const lat = satellite.degreesLat(geo.latitude);
    if (!isFinite(lng) || !isFinite(lat)) continue;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [lng, lat] },
      properties: {
        name: s.name, norad: s.norad, alt: Math.round(geo.height), fav: isFavSat(s.norad),
      },
    });
  }
  map.getSource("satellites").setData({ type: "FeatureCollection", features });
  if (tracking && selectedSat) centerOnSelected();  // 추적 모드: 매 초 지도 중심 갱신
  // 상세 패널이 열려 있으면 고도·속도·위치를 실시간 갱신
  if (satPanelId && selectedSat && String(selectedSat.norad) === String(satPanelId)
      && !document.getElementById("panel").classList.contains("hidden")) {
    refreshSatPanel(selectedSat);
  }
}

function startSatelliteLoop() {
  if (satTimer) clearInterval(satTimer);
  updateSatellitePositions();
  satTimer = setInterval(updateSatellitePositions, 1000);
}

function setSatelliteVisible(on) {
  if (!map.getLayer("sat-layer")) return;
  const vis = on ? "visible" : "none";
  map.setLayoutProperty("sat-layer", "visibility", vis);
  map.setLayoutProperty("sat-hit", "visibility", vis);  // 클릭 영역도 함께 토글
  if (sidebarTab === "sats") renderSatList();           // 목록 탭의 안내 문구도 함께 갱신
  else if (sidebarTab === "favs") renderFavList();
  if (on) {
    if (satrecs.length === 0) loadSatellites();  // 첫 켜기 때 lazy 로드
    else if (!satTimer) startSatelliteLoop();
  } else {
    deselectSatellite();  // 레이어를 끄면 선택/궤적/추적도 함께 해제
    if (satTimer) {
      clearInterval(satTimer);
      satTimer = null;  // 숨김 상태에선 계산도 멈춰 자원 절약
    }
  }
}

// ── 위성 그룹 선택 UI (P7-6) ──────────────────────────────────────────────────
async function initSatGroups() {
  try {
    const cat = await window.pywebview.api.get_satellite_groups();
    const box = document.getElementById("sat-groups");
    box.innerHTML = (cat || []).map((g) => {
      const checked = satGroups.includes(g.key) ? "checked" : "";
      const cap = g.cap ? ` <span class="muted">(최대 ${g.cap})</span>` : "";
      return `<label><input type="checkbox" class="satg" value="${escapeHtml(g.key)}" ${checked}/> ${escapeHtml(g.label)}${cap}</label>`;
    }).join("")
      // 궤도 대역 필터(P11-3) — 그룹은 "무엇을 받을지", 대역은 "받은 것 중 무엇을 볼지"
      + `<div class="satg-sec">궤도 대역</div>`
      + BANDS.map((b) =>
        `<label><input type="checkbox" class="satb" value="${b.key}" ${satBands[b.key] !== false ? "checked" : ""}/> ` +
        `${escapeHtml(b.label)} <span class="muted">${escapeHtml(b.note)}</span></label>`).join("")
      // 종류·소유국은 SATCAT 이 온 뒤에야 채워진다 → 자리만 만들어 두고 따로 그린다.
      + `<div id="sat-facets"></div>`;
    box.querySelectorAll(".satg").forEach((c) => c.addEventListener("change", onSatGroupChange));
    box.querySelectorAll(".satb").forEach((c) => c.addEventListener("change", onSatBandChange));
    renderFacetFilters();   // 종류·소유국(P12-5b). 메타가 오면 다시 그린다
  } catch (e) { console.error("위성 그룹 로드 실패", e); }
}

// ── 종류·소유국 필터 (P12-5b) ──────────────────────────────────────────────────
// 실측이 근거다(2026-09-11): `visual` 159개 중 위성체는 66개뿐이고 92개가 다 쓴
// 로켓 몸체다. "밝게 보이는 위성"의 58%가 위성이 아니다.
const FACETS = [
  { field: "type", cls: "satt", title: "종류", off: () => satTypesOff },
  { field: "owner", cls: "sato", title: "소유국", off: () => satOwnersOff },
];

function facetSectionHtml(f) {
  const items = satFacet(f.field);
  if (!items.length) return "";   // 메타가 아직 없으면 빈 제목만 남기지 않는다
  const off = f.off();
  return `<div class="satg-sec">${escapeHtml(f.title)}</div>` +
    items.map((it) =>
      `<label><input type="checkbox" class="${f.cls}" value="${escapeHtml(it.value)}" ` +
      `${off[it.value] ? "" : "checked"}/> ${escapeHtml(it.value)} ` +
      `<span class="muted">${it.count}</span></label>`).join("");
}

/** 종류·소유국 구역만 다시 그린다 — 그룹·대역 체크박스는 건드리지 않는다
 *  (전부 다시 그리면 열어 둔 드롭다운에서 방금 누른 체크가 튄다). */
function renderFacetFilters() {
  const host = document.getElementById("sat-facets");
  if (!host) return;
  host.innerHTML = FACETS.map(facetSectionHtml).join("");
  host.querySelectorAll(".satt").forEach((c) => c.addEventListener("change", onFacetChange));
  host.querySelectorAll(".sato").forEach((c) => c.addEventListener("change", onFacetChange));
}

function onFacetChange() {
  // **끈 것만** 모은다 — 켠 것을 담으면 새로 나타난 종류·나라가 조용히 숨겨진다.
  satTypesOff = {};
  document.querySelectorAll(".satt:not(:checked)").forEach((c) => { satTypesOff[c.value] = true; });
  satOwnersOff = {};
  document.querySelectorAll(".sato:not(:checked)").forEach((c) => { satOwnersOff[c.value] = true; });
  saveSatSettings();
  applySatFilter();
}

/** 필터가 바뀐 뒤 화면을 맞춘다 — 대역·종류·소유국이 같은 뒷정리를 쓰게 한 곳에 모은다. */
function applySatFilter() {
  // 숨겨진 위성이 선택돼 있으면 해제 — 지도에 점이 없는데 패널만 떠 있으면 혼란스럽다.
  if (selectedSat && !visibleSats().some((s) => s.norad === selectedSat.norad)) {
    deselectSatellite();
  }
  updateSatCount();
  if (satTimer) updateSatellitePositions();  // 다음 초를 기다리지 않고 바로 반영
  if (sidebarTab === "sats") renderSatList();
  else if (sidebarTab === "favs") renderFavList();
}

/** 위성 설정을 통째로 저장한다.
 *
 * 저장 지점이 셋(그룹·대역·종류/소유국)인데 각자 객체를 만들고 있었다. 새 필드를 늘리면
 * **한 곳만 빠뜨려도 그 경로로 저장할 때 조용히 사라진다** — 실제로 P12-5b 을 넣으며 그럴
 * 뻔했다. 저장 모양은 여기 한 곳에만 둔다(전역 규칙 6번과 같은 이유).
 */
function saveSatSettings() {
  saveSettings({ satellites: {
    enabled: document.getElementById("toggle-sat").checked,
    groups: satGroups,
    bands: satBands,
    typesOff: satTypesOff,
    ownersOff: satOwnersOff,
  } });
}

function onSatGroupChange() {
  satGroups = Array.from(document.querySelectorAll(".satg:checked")).map((c) => c.value);
  saveSatSettings();
  if (document.getElementById("toggle-sat").checked) {
    satrecs = []; loadSatellites();   // 그룹이 바뀌었으니 재로드
  }
}

/** 대역 필터 변경 — 재로드 없이 즉시 반영(이미 받아둔 TLE만 걸러낸다). */
function onSatBandChange() {
  BANDS.forEach((b) => { satBands[b.key] = false; });
  document.querySelectorAll(".satb:checked").forEach((c) => { satBands[c.value] = true; });
  saveSatSettings();
  applySatFilter();
}

/** 툴바 위성 개수 — 대역 필터가 걸려 있으면 "보이는 수/전체" 로 보여준다. */
function updateSatCount() {
  const el = document.getElementById("sat-count");
  if (!el) return;
  if (!satrecs.length) { el.textContent = ""; return; }
  const shown = visibleSats().length;
  el.textContent = shown === satrecs.length ? `(${shown})` : `(${shown}/${satrecs.length})`;
}

function toggleSatGroups() {
  document.getElementById("sat-groups").classList.toggle("hidden");
}
