/* RL3D — 지도 초기화, 카메라 저장/복원, 오프라인 배지, 배경 지도 전환, 낮/밤 터미네이터. */

// ── 지도 ─────────────────────────────────────────────────────────────────────
// ── 지도 카메라 저장/복원 (P11-4) ────────────────────────────────────────────
let savedCamera = null;       // 설정에서 복원한 카메라 — 지도 생성 시 초기 위치로 쓴다
let cameraSaveTimer = null;

/** 지도를 움직일 때마다 파일을 쓰지 않도록, 조작이 잠잠해진 뒤 한 번만 저장한다. */
function scheduleCameraSave() {
  if (tracking) return;  // 추적 모드는 매 초 지도를 옮긴다 → 그 위치까지 저장할 이유는 없다
  if (cameraSaveTimer) clearTimeout(cameraSaveTimer);
  cameraSaveTimer = setTimeout(() => {
    const c = map.getCenter();
    saveSettings({ camera: { lng: c.lng, lat: c.lat, zoom: map.getZoom() } });
  }, 1000);
}

function initMap() {
  map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      sources: {
        carto: {
          type: "raster",
          tiles: [
            "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
            "https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
            "https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
          ],
          tileSize: 256,
          maxzoom: 20,  // CARTO dark 타일은 z20까지 → 그 이상은 overzoom(배경 안 깨짐)
          attribution: "© OpenStreetMap © CARTO",
        },
        // 위성사진 배경. 두 소스를 함께 두고 visibility 로 바꾼다
        // (setStyle 로 갈아끼우면 마커·궤적·터미네이터 레이어를 전부 다시 만들어야 한다).
        // 숨겨진 레이어는 타일을 받지 않으므로 평소 트래픽 부담도 없다.
        esri: {
          type: "raster",
          tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
          tileSize: 256,
          maxzoom: 19,
          attribution: "Esri, Maxar, Earthstar Geographics",
        },
      },
      layers: [
        { id: "carto", type: "raster", source: "carto" },
        { id: "esri", type: "raster", source: "esri", layout: { visibility: "none" } },
      ],
    },
    center: savedCamera ? [savedCamera.lng, savedCamera.lat] : [10, 20],
    zoom: savedCamera ? savedCamera.zoom : 1.6,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
  map.on("moveend", scheduleCameraSave);  // 마지막으로 보던 위치를 다음 실행에 복원(P11-4)
  setupOfflineBadge();
  map.on("load", () => {
    if (basemap === "satellite") setBasemap("satellite");  // 저장된 배경 복원
    setupTerminator();      // 낮/밤 음영 — 마커보다 먼저 추가해 그 아래에 깔리게
    setupLaunchLayers();    // 발사 클러스터/포인트 레이어(빈 소스로 먼저 생성)
    setupSatelliteLayer();  // 빈 레이어만(기본 숨김). 위성은 토글 켤 때 로드
    if (observer) showObserverMarker();          // 저장된 관측 위치 복원(P8-9)
    if (document.getElementById("toggle-sat").checked) setSatelliteVisible(true);  // 설정에 켜져 있었으면 로드
    loadLaunches();
    startAutoRefresh();
  });
}

// ── 오프라인 안내 배지 (P11-7) ────────────────────────────────────────────────
// 배경 타일만 온라인 전용이라, 오프라인이면 데이터(stale 캐시)는 뜨는데 지도만 회색으로 남는다.
// 그 상태를 "앱이 깨진 것"으로 오해하지 않게 알려준다.
const TILE_FAIL_LIMIT = 3;   // 타일 한두 개 실패는 흔하다 → 연속 실패만 오프라인으로 본다
let tileFails = 0;
let badgeDismissed = false;  // 사용자가 닫으면 이 세션에선 다시 띄우지 않는다

function setOfflineBadge(on) {
  const el = document.getElementById("offline-badge");
  if (!el) return;
  if (on && badgeDismissed) return;
  el.textContent = "🌐 오프라인 — 배경 지도를 못 받았습니다 (발사·위성은 저장된 데이터)";
  el.classList.toggle("hidden", !on);
}

function setupOfflineBadge() {
  map.on("error", (e) => {
    if (e && (e.sourceId === "carto" || e.sourceId === "esri")) {
      if (++tileFails >= TILE_FAIL_LIMIT) setOfflineBadge(true);
    }
  });
  // 타일이 하나라도 성공하면 연결이 살아난 것 → 카운터와 배지를 함께 되돌린다
  map.on("data", (e) => {
    if (e && e.dataType === "source" && e.tile && e.tile.state === "loaded"
        && (e.sourceId === "carto" || e.sourceId === "esri")) {
      tileFails = 0;
      setOfflineBadge(false);
    }
  });
  window.addEventListener("offline", () => setOfflineBadge(true));
  window.addEventListener("online", () => { tileFails = 0; setOfflineBadge(false); });
  if (navigator.onLine === false) setOfflineBadge(true);  // 시작부터 오프라인인 경우
  document.getElementById("offline-badge").addEventListener("click", () => {
    badgeDismissed = true;
    setOfflineBadge(false);
  });
}

// ── 배경 지도 전환 (다크 / 위성사진) ──────────────────────────────────────────
function setBasemap(kind) {
  basemap = kind === "satellite" ? "satellite" : "dark";
  if (map && map.getLayer("carto")) {
    map.setLayoutProperty("carto", "visibility", basemap === "dark" ? "visible" : "none");
    map.setLayoutProperty("esri", "visibility", basemap === "satellite" ? "visible" : "none");
  }
  const btn = document.getElementById("basemap-btn");
  if (btn) {
    btn.classList.toggle("active", basemap === "satellite");
    btn.textContent = basemap === "satellite" ? "🛰 위성사진" : "🗺 다크";
  }
}

function toggleBasemap() {
  setBasemap(basemap === "dark" ? "satellite" : "dark");
  saveSettings({ basemap });
}

// ── 낮/밤 터미네이터 오버레이 (P6-3) ─────────────────────────────────────────
// 외부 데이터 없이 현재 태양 위치(적위·적경)로 야간 반구를 반투명 폴리곤으로 음영.
// 각 경도에서 태양 고도=0 이 되는 위도(터미네이터)를 구해 야간 쪽을 채운다.
function julianDay(date) { return date.getTime() / 86400000 + 2440587.5; }

/** 태양 황경(deg) — 저정밀 근사(오버레이 용도로 충분). */
function sunEclipticLongitude(jd) {
  const n = jd - 2451545.0;
  const L = (((280.460 + 0.9856474 * n) % 360) + 360) % 360;  // 평균 황경
  const g = ((((357.528 + 0.9856003 * n) % 360) + 360) % 360) * DEG;  // 평균 근점이각
  return L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g);
}

/** 태양의 적경(alpha)·적위(delta) (deg). */
function sunEquatorial(jd) {
  const lambda = sunEclipticLongitude(jd) * DEG;
  const eps = (23.4393 - 0.0000004 * (jd - 2451545.0)) * DEG;  // 황도경사
  const alpha = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda)) / DEG;
  const delta = Math.asin(Math.sin(eps) * Math.sin(lambda)) / DEG;
  return { alpha, delta };
}

/** 그리니치 평균 항성시(시간 단위, 0~24). */
function gmstHours(jd) {
  const d = jd - 2451545.0;
  return ((((18.697374558 + 24.06570982441908 * d) % 24) + 24) % 24);
}

/** 현재 시각의 야간 반구를 덮는 폴리곤 Feature. */
function computeTerminator() {
  const jd = julianDay(new Date());
  const gst = gmstHours(jd);
  const eq = sunEquatorial(jd);
  const tanDelta = Math.tan(eq.delta * DEG);
  const poleLat = eq.delta < 0 ? 90 : -90;  // 태양이 남반구(적위<0)면 북극권이 야간
  const ring = [[-180, poleLat]];
  for (let lng = -180; lng <= 180; lng += 1) {
    const ha = (gst * 15 + lng - eq.alpha) * DEG;  // 시간각(rad)
    const lat = Math.atan(-Math.cos(ha) / tanDelta) / DEG;  // 터미네이터 위도
    ring.push([lng, lat]);
  }
  ring.push([180, poleLat]);
  ring.push([-180, poleLat]);  // 링 닫기
  return { type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: {} };
}

function setupTerminator() {
  map.addSource("terminator", { type: "geojson", data: EMPTY_FC });
  map.addLayer({
    id: "terminator-fill", type: "fill", source: "terminator",
    paint: { "fill-color": "#000010", "fill-opacity": 0.33 },
  });
  updateTerminator();
  terminatorTimer = setInterval(updateTerminator, 60000);  // 분 단위 갱신
}

function updateTerminator() {
  const src = map.getSource("terminator");
  if (!src) return;
  const on = document.getElementById("toggle-terminator").checked;
  src.setData(on ? computeTerminator() : EMPTY_FC);
}
