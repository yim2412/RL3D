/* RL3D — 지도·마커·티커·필터 로직.
 * 파이썬 브릿지(window.pywebview.api)에서 받은 JSON을 MapLibre 지도에 그린다.
 */

// ── 상태 ─────────────────────────────────────────────────────────────────────
let map = null;
let launches = [];          // 라이브 발사(예정+최근 previous). 5분마다 갱신되며 통째 교체됨
let archiveLaunches = [];   // 불러온 과거 연도 발사(P7-5). 라이브 갱신에 안 지워짐
let loadedYears = new Set();// 이미 불러온 아카이브 연도
let allLaunches = [];       // 라이브+아카이브 합본(id 중복 제거) — 필터/목록/타임라인이 사용
let tickerTimer = null;

let satrecs = [];           // { name, norad, rec } — satellite.js SGP4 레코드
let satTimer = null;        // 위성 위치 갱신 타이머(초당)

let selectedSat = null;     // 선택된 위성 { name, norad, rec } — 지상궤적/추적 대상
let tracking = false;       // 추적 모드(지도 중심을 위성에 고정)
let trackTimer = null;      // 지상궤적선 주기적 재계산 타이머

let satPanelId = null;      // 상세 패널이 열려 있는 위성 norad(매 초 값 갱신용)
let observer = null;        // 관측 위치 { lat, lng } — 통과 예측 기준(settings.json 저장)
let observerMarker = null;  // 지도 위 관측 위치 마커
let settingObserver = false;  // 지도 클릭으로 관측 위치 지정 중인지

const EMPTY_FC = { type: "FeatureCollection", features: [] };
const DEG = Math.PI / 180;

let terminatorTimer = null;  // 낮/밤 오버레이 분 단위 갱신 타이머

let autoTimer = null;       // 발사 자동 갱신 타이머
const AUTO_REFRESH_MS = 5 * 60 * 1000;  // 5분마다 폴링(실제 API는 캐시 TTL이 제어)

let satGroups = ["stations", "visual"];  // 선택된 위성 그룹(P7-6). 설정으로 덮어씀
let satBands = { leo: true, meo: true, geo: true };  // 궤도 대역 필터(P11-3). 설정으로 덮어씀
let lastLaunchLoad = null;  // 마지막 발사 데이터 기준 시각(ms) — "N분 전 갱신"(P7-7)

// 관심 목록(P11-2) — id/norad 는 항상 문자열로 넣는다(LL2 id는 문자열, NORAD는 숫자로 와 섞인다)
let favLaunches = new Set();
let favSats = new Set();

let tlMin = null, tlMax = null;   // 타임라인 net 범위(ms)
let timelineMax = null;           // 이 시각 이하의 발사만 표시(null=무제한)
let timelineInited = false;

// ── 유틸 ─────────────────────────────────────────────────────────────────────
function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** 라이브+아카이브 합본 재계산(라이브 id 우선, 아카이브 중복 제거). */
function rebuildAll() {
  const seen = new Set(launches.map((d) => d.id));
  allLaunches = launches.concat(archiveLaunches.filter((d) => !seen.has(d.id)));
}

function findLaunch(id) {
  return allLaunches.find((x) => String(x.id) === String(id));
}

function showStatus(msg) {
  const el = document.getElementById("status");
  if (!msg) { el.classList.add("hidden"); return; }
  el.textContent = msg;
  el.classList.remove("hidden");
}

function fmtDate(iso) {
  if (!iso) return "미정";
  const d = new Date(iso);
  if (isNaN(d)) return escapeHtml(iso);
  return d.toLocaleString("ko-KR", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

/** net까지 남은 시간 → "T-02:14:33" / 지났으면 "T+…" */
function countdown(iso) {
  if (!iso) return "";
  const diff = new Date(iso).getTime() - Date.now();
  const sign = diff >= 0 ? "T-" : "T+";
  let s = Math.floor(Math.abs(diff) / 1000);
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const pad = (n) => String(n).padStart(2, "0");
  return sign + (d > 0 ? `${d}일 ` : "") + `${pad(h)}:${pad(m)}:${pad(s)}`;
}

const OUTCOME_LABEL = {
  upcoming: "예정", success: "성공", failure: "실패", partial: "부분 실패",
};

// 범주형 필드 한국어 매핑(고유명사는 번역하지 않고 원문 유지).
// 매핑에 없는 값은 tr()이 원문을 그대로 돌려준다.
const STATUS_KO = {
  "Launch Successful": "발사 성공",
  "Launch Failure": "발사 실패",
  "Launch was a Partial Failure": "부분 실패",
  "Go for Launch": "발사 준비 완료",
  "To Be Determined": "일정 미정",
  "To Be Confirmed": "일정 미확정",
  "In Flight": "비행 중",
  "Hold": "발사 보류",
  "Payload Deployed": "탑재체 전개 완료",
};
const ORBIT_KO = {
  "Low Earth Orbit": "지구 저궤도(LEO)",
  "Medium Earth Orbit": "지구 중궤도(MEO)",
  "Geostationary Transfer Orbit": "정지천이궤도(GTO)",
  "Geostationary Orbit": "정지궤도(GEO)",
  "Sun-Synchronous Orbit": "태양동기궤도(SSO)",
  "Polar Orbit": "극궤도",
  "Elliptical Orbit": "타원궤도",
  "Suborbital": "준궤도",
  "Lunar Orbit": "달 궤도",
  "Mars Orbit": "화성 궤도",
  "Sun-Earth L2": "태양–지구 L2",
  "Unknown": "미상",
};
const MISSION_TYPE_KO = {
  "Communications": "통신",
  "Earth Science": "지구 과학",
  "Government/Top Secret": "정부/기밀",
  "Test Flight": "시험 비행",
  "Technology": "기술 시연",
  "Navigation": "항법",
  "Planetary Science": "행성 과학",
  "Astrophysics": "천체물리",
  "Resupply": "보급",
  "Human Exploration": "유인 탐사",
  "Lunar Exploration": "달 탐사",
  "Dedicated Rideshare": "전용 라이드셰어",
  "Mission Extension": "임무 연장",
  "Tourism": "우주 관광",
  "Unknown": "미상",
};
const COUNTRY_KO = {
  USA: "미국", CHN: "중국", RUS: "러시아", KOR: "대한민국", JPN: "일본",
  FRA: "프랑스", IND: "인도", DEU: "독일", ITA: "이탈리아", GBR: "영국",
  ESP: "스페인", NZL: "뉴질랜드", LUX: "룩셈부르크", UKR: "우크라이나",
  IRN: "이란", ISR: "이스라엘", BRA: "브라질", CAN: "캐나다", AUS: "호주",
};

function tr(map, v) {
  if (v == null) return v;
  return map[v] || v;  // 매핑 없으면 원문 유지
}

/** 국가코드(단일 또는 콤마 다국) → 한국어. 다국이면 "유럽 다국적" 등으로. */
function countryKo(code) {
  if (!code) return "";
  if (code.includes(",")) return "다국적";
  return COUNTRY_KO[code] || code;
}

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

// ── 발사 데이터 로드 ──────────────────────────────────────────────────────────
async function loadLaunches(force = false, silent = false) {
  const btn = document.getElementById("refresh");
  if (!silent) btn.disabled = true;
  try {
    const prev = launches;  // 변화 감지용 직전 스냅샷
    const res = await window.pywebview.api.get_launches(force);
    launches = res.launches || [];
    rebuildAll();
    if (res.age != null) { lastLaunchLoad = Date.now() - res.age * 1000; updateFreshness(); }
    if (res.error) showStatus(res.stale ? `⚠ ${res.error} (저장된 데이터 표시)` : `⚠ ${res.error}`);
    else if (!silent) showStatus(null);
    recomputeTimeline();  // 아카이브가 붙으면 범위가 과거로 늘어날 수 있어 매번 재계산
    applyFilters();
    startTicker();
    if (silent) announceChanges(prev, launches);  // 자동 갱신 때만 변화 알림
  } catch (e) {
    if (!silent) showStatus("데이터를 불러오지 못했습니다.");
    console.error(e);
  } finally {
    if (!silent) btn.disabled = false;
  }
}

/** 자동 갱신 시 직전↔현재 비교 → 새 발사·상태 변화를 잠깐 알린다. */
function announceChanges(prev, curr) {
  if (!prev || prev.length === 0) return;
  const prevMap = new Map(prev.map((d) => [d.id, d]));
  let added = 0;
  const changed = [];
  for (const d of curr) {
    const old = prevMap.get(d.id);
    if (!old) { added++; continue; }
    // 결과가 확정된 경우(예정→성공/실패)만 의미 있는 변화로 취급
    if (old.outcome !== d.outcome && d.outcome !== "upcoming") changed.push(d);
  }
  const msgs = [];
  if (added > 0) msgs.push(`새 발사 ${added}건 추가`);
  for (const d of changed.slice(0, 2)) {
    msgs.push(`${d.name} → ${tr(STATUS_KO, d.status) || OUTCOME_LABEL[d.outcome]}`);
  }
  if (msgs.length === 0) return;
  showStatus("🔔 " + msgs.join(" · "));
  setTimeout(() => showStatus(null), 8000);
}

// ── 발사 레이어 (GeoJSON 클러스터 + circle) ──────────────────────────────────
// 예정은 밝은 하늘색 + 큰 원으로 강조.
const LAUNCH_COLORS = {
  upcoming: "#7dd3fc", success: "#22c55e", failure: "#ef4444", partial: "#f59e0b",
};
const FAV_COLOR = "#fbbf24";  // 관심 항목 강조(금색) — 발사 마커·위성 점 공통

function setupLaunchLayers() {
  map.addSource("launches", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
    cluster: true,
    clusterRadius: 44,
    clusterMaxZoom: 6,  // 이 줌 이상에선 클러스터를 풀어 개별 발사로
  });
  // 클러스터 원 (개수에 따라 크기 단계)
  map.addLayer({
    id: "clusters", type: "circle", source: "launches", filter: ["has", "point_count"],
    paint: {
      "circle-color": "#12314f",
      "circle-stroke-color": "#4da3ff",
      "circle-stroke-width": 1.5,
      "circle-radius": ["step", ["get", "point_count"], 13, 5, 17, 15, 22],
      "circle-opacity": 0.92,
    },
  });
  // 개별 발사 — 예정만 밝은색·큰 원·두꺼운 테두리
  map.addLayer({
    id: "launch-point", type: "circle", source: "launches", filter: ["!", ["has", "point_count"]],
    paint: {
      "circle-color": ["match", ["get", "outcome"],
        "upcoming", LAUNCH_COLORS.upcoming, "success", LAUNCH_COLORS.success,
        "failure", LAUNCH_COLORS.failure, "partial", LAUNCH_COLORS.partial, "#94a3b8"],
      // 관심 발사(P11-2)는 금색 테두리를 굵게 둘러 색 구분(결과)을 잃지 않고 눈에 띄게 한다
      "circle-radius": ["case",
        ["==", ["get", "fav"], true], 9,
        ["==", ["get", "outcome"], "upcoming"], 8, 5],
      "circle-stroke-width": ["case",
        ["==", ["get", "fav"], true], 3.2,
        ["==", ["get", "outcome"], "upcoming"], 2.5, 1.2],
      "circle-stroke-color": ["case", ["==", ["get", "fav"], true], FAV_COLOR, "#ffffff"],
    },
  });

  // 클러스터 클릭 → 네이티브 확대(뭉친 발사장이 갈라짐)
  map.on("click", "clusters", (e) => {
    if (settingObserver) return;
    const f = e.features[0];
    map.getSource("launches").getClusterExpansionZoom(f.properties.cluster_id)
      .then((z) => map.easeTo({ center: f.geometry.coordinates, zoom: z }))
      .catch(() => {});
  });
  // 개별 발사 클릭 → 상세 패널
  map.on("click", "launch-point", (e) => {
    if (settingObserver) return;
    const id = e.features[0].properties.id;
    const d = findLaunch(id);
    if (d) openPanel(d);
  });
  // 호버 툴팁 + 커서
  map.on("mouseenter", "launch-point", (e) => { map.getCanvas().style.cursor = "pointer"; showLaunchTooltip(e); });
  map.on("mousemove", "launch-point", showLaunchTooltip);
  map.on("mouseleave", "launch-point", () => { map.getCanvas().style.cursor = ""; hideTooltip(); });
  map.on("mouseenter", "clusters", (e) => { map.getCanvas().style.cursor = "pointer"; showClusterTooltip(e); });
  map.on("mousemove", "clusters", showClusterTooltip);
  map.on("mouseleave", "clusters", () => { map.getCanvas().style.cursor = ""; hideTooltip(); });
}

/** 발사 배열 → GeoJSON. 좌표 없는 발사는 제외. 상세는 id로 원본을 되찾는다. */
function launchesToFC(list) {
  return {
    type: "FeatureCollection",
    features: list
      .filter((d) => typeof d.lat === "number" && typeof d.lng === "number")
      .map((d) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [d.lng, d.lat] },
        properties: { id: d.id, outcome: d.outcome, fav: isFavLaunch(d.id) },
      })),
  };
}

// ── 필터 / 검색 / 타임라인 ────────────────────────────────────────────────────
function launchPasses(d, active, q) {
  if (!active.has(d.outcome)) return false;
  if (q) {
    const hay = `${d.name || ""} ${d.rocket || ""} ${d.provider || ""} ${d.mission_name || ""}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  if (timelineMax != null && d.net) {
    const t = new Date(d.net).getTime();
    if (!isNaN(t) && t > timelineMax) return false;
  }
  return true;
}

function applyFilters() {
  const active = new Set(
    Array.from(document.querySelectorAll(".flt:checked")).map((c) => c.value)
  );
  const q = document.getElementById("search").value.trim().toLowerCase();
  const filtered = allLaunches.filter((d) => launchPasses(d, active, q));
  const src = map.getSource("launches");
  if (src) src.setData(launchesToFC(filtered));  // 클러스터는 자동 재계산
  renderSidebar(filtered);  // 같은 필터 결과를 좌측 목록에도 반영
}

// ── 관심 목록 (P11-2) ─────────────────────────────────────────────────────────
function isFavLaunch(id) { return favLaunches.has(String(id)); }
function isFavSat(norad) { return favSats.has(String(norad)); }

function saveFavorites() {
  saveSettings({ favorites: { launches: [...favLaunches], sats: [...favSats] } });
}

/** 관심 토글 후 영향받는 화면을 모두 갱신한다(지도 강조·목록·별 버튼). */
function toggleFavLaunch(id) {
  const k = String(id);
  if (favLaunches.has(k)) favLaunches.delete(k); else favLaunches.add(k);
  saveFavorites();
  applyFilters();  // 지도 강조 + 목록(발사/관심 탭) 반영
  updateFavBtn(isFavLaunch(k));
}

function toggleFavSat(norad) {
  const k = String(norad);
  if (favSats.has(k)) favSats.delete(k); else favSats.add(k);
  saveFavorites();
  updateSatellitePositions();  // 강조가 바로 보이게(다음 초를 기다리지 않음)
  if (sidebarTab === "favs") renderFavList();
  updateFavBtn(isFavSat(k));
}

/** 상세 패널의 ⭐ 버튼 표시 갱신. */
function updateFavBtn(on) {
  const b = document.getElementById("fav-btn");
  if (!b) return;
  b.classList.toggle("active", on);
  b.textContent = on ? "★ 관심" : "☆ 관심";
  b.title = on ? "관심 목록에서 빼기" : "관심 목록에 넣기";
}

/** 상세 패널 헤더의 ⭐ 버튼 HTML. kind: launch | sat */
function favBtnHtml(kind, key) {
  const on = kind === "launch" ? isFavLaunch(key) : isFavSat(key);
  return `<button id="fav-btn" class="fav-btn${on ? " active" : ""}" ` +
    `data-kind="${kind}" data-key="${escapeHtml(String(key))}" ` +
    `title="${on ? "관심 목록에서 빼기" : "관심 목록에 넣기"}">${on ? "★" : "☆"} 관심</button>`;
}

function bindFavBtn(root) {
  const b = root.querySelector("#fav-btn");
  if (!b) return;
  b.addEventListener("click", () => {
    if (b.dataset.kind === "launch") toggleFavLaunch(b.dataset.key);
    else toggleFavSat(b.dataset.key);
  });
}

/** 관심 탭 — 발사와 위성을 함께 보여준다(발사 먼저). */
function renderFavList() {
  const cont = document.getElementById("sidebar-list");
  const countEl = document.getElementById("sidebar-count");
  const favL = allLaunches.filter((d) => isFavLaunch(d.id));
  const favS = satrecs.filter((s) => isFavSat(s.norad));
  countEl.textContent = `${favL.length + favS.length}개`;
  if (!favL.length && !favS.length) {
    // 저장은 돼 있는데 아직 데이터가 안 붙은 경우(위성 레이어 OFF 등)를 구분해 안내
    const pending = favLaunches.size + favSats.size;
    cont.innerHTML = `<div class="sb-empty">${pending
      ? "저장된 관심 항목이 아직 불러오지 않은 데이터입니다.<br />위성 레이어를 켜거나 과거 연도를 불러와 보세요."
      : "관심 항목이 없습니다.<br />상세 패널의 <b>☆ 관심</b>을 눌러 담아두면 여기 모입니다."}</div>`;
    return;
  }
  const launchRows = favL.map((d) =>
    `<button class="sb-row" data-id="${escapeHtml(String(d.id))}">` +
    `<span class="dot d-${d.outcome}"></span>` +
    `<span class="sb-main"><span class="sb-name">★ ${escapeHtml(d.name)}</span>` +
    `<span class="sb-sub">${escapeHtml(d.outcome === "upcoming" ? countdown(d.net) : fmtDate(d.net))}</span>` +
    `</span></button>`).join("");
  const satRows = favS.map((s) =>
    `<button class="sb-row" data-norad="${escapeHtml(String(s.norad))}">` +
    `<span class="dot d-sat"></span>` +
    `<span class="sb-main"><span class="sb-name">★ ${escapeHtml(s.name)}</span>` +
    `<span class="sb-sub">NORAD ${escapeHtml(String(s.norad))}</span></span></button>`).join("");
  cont.innerHTML =
    (launchRows ? `<div class="sb-group">🚀 발사 ${favL.length}</div>` + launchRows : "") +
    (satRows ? `<div class="sb-group">🛰 위성 ${favS.length}</div>` + satRows : "");
}

// ── 발사 목록 사이드바 (P6-4) ─────────────────────────────────────────────────
// 임박한 예정 발사를 위로(오름차순), 지난 발사는 최근 순(내림차순)으로 정렬.
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

// ── 사이드바 탭 (발사 / 위성) ─────────────────────────────────────────────────
let basemap = "dark";       // 배경 지도: dark(CARTO) | satellite(Esri)
let sidebarTab = "launches";

function setSidebarTab(tab) {
  sidebarTab = tab;
  document.getElementById("tab-launches").classList.toggle("active", tab === "launches");
  document.getElementById("tab-sats").classList.toggle("active", tab === "sats");
  document.getElementById("tab-favs").classList.toggle("active", tab === "favs");
  document.getElementById("sat-search").classList.toggle("hidden", tab !== "sats");
  if (tab === "sats") renderSatList();
  else if (tab === "favs") renderFavList();
  else applyFilters();   // 발사 탭은 현재 필터 결과를 다시 그린다
}

/** 위성 목록 — satrecs(로드된 TLE) 기준. 이름·NORAD 로 걸러 보여준다. */
function renderSatList() {
  const cont = document.getElementById("sidebar-list");
  const countEl = document.getElementById("sidebar-count");
  if (!satrecs.length) {
    countEl.textContent = "0개";
    const on = document.getElementById("toggle-sat").checked;
    cont.innerHTML = `<div class="sb-empty">${on
      ? "위성을 불러오는 중…"
      : "위성 레이어가 꺼져 있습니다.<br />툴바의 <b>위성</b>을 켜면 목록이 채워집니다."}</div>`;
    return;
  }
  const q = document.getElementById("sat-search").value.trim().toLowerCase();
  const list = visibleSats().filter((s) =>
    !q || s.name.toLowerCase().includes(q) || String(s.norad).includes(q));
  countEl.textContent = `${list.length}개`;
  if (!list.length) {
    const allBands = BANDS.every((b) => satBands[b.key] !== false);
    cont.innerHTML = `<div class="sb-empty">${allBands
      ? "검색 결과가 없습니다."
      : "조건에 맞는 위성이 없습니다.<br />툴바 <b>그룹 ▾</b>의 궤도 대역 필터를 확인해 보세요."}</div>`;
    return;
  }
  cont.innerHTML = list.slice(0, 400).map((s) =>
    `<button class="sb-row" data-norad="${escapeHtml(String(s.norad))}">` +
    `<span class="dot d-sat"></span>` +
    `<span class="sb-main"><span class="sb-name">${escapeHtml(s.name)}</span>` +
    `<span class="sb-sub">NORAD ${escapeHtml(String(s.norad))} · ${bandLabel(s.band)}</span></span></button>`).join("") +
    (list.length > 400 ? `<div class="sb-empty">…외 ${list.length - 400}개. 검색으로 좁혀보세요.</div>` : "");
}

/** 목록에서 위성을 고르면 지도에서 클릭한 것과 같게 동작. */
function pickSatellite(norad) {
  const s = satrecs.find((x) => String(x.norad) === String(norad));
  if (!s) return;
  selectSatellite(s);
  openSatPanel(s);
  const d = satDetails(s.rec);
  if (d) map.flyTo({ center: [d.lng, d.lat], zoom: 3.5, speed: 1.2 });
}

function renderSidebar(list) {
  if (sidebarTab === "favs") { renderFavList(); return; }  // 관심 탭도 발사 갱신에 따라 바뀐다
  if (sidebarTab !== "launches") return;  // 위성 탭이 열려 있으면 발사 목록으로 덮지 않는다
  const cont = document.getElementById("sidebar-list");
  document.getElementById("sidebar-count").textContent = `${list.length}건`;
  const upcoming = list.filter((d) => d.outcome === "upcoming")
    .sort((a, b) => new Date(a.net) - new Date(b.net));
  const rest = list.filter((d) => d.outcome !== "upcoming")
    .sort((a, b) => new Date(b.net) - new Date(a.net));
  cont.innerHTML = upcoming.concat(rest).map((d) => {
    const loc = d.location_name ? " · " + escapeHtml(d.location_name) : "";
    const sub = d.outcome === "upcoming"
      ? escapeHtml(countdown(d.net)) + loc
      : escapeHtml(fmtDate(d.net)) + loc;
    const star = isFavLaunch(d.id) ? "★ " : "";
    return `<button class="sb-row" data-id="${escapeHtml(String(d.id))}">` +
      `<span class="dot d-${d.outcome}"></span>` +
      `<span class="sb-main"><span class="sb-name">${star}${escapeHtml(d.name)}</span>` +
      `<span class="sb-sub">${sub}</span></span></button>`;
  }).join("");
}

function toggleSidebar() {
  const sb = document.getElementById("sidebar");
  const show = sb.classList.contains("hidden");
  sb.classList.toggle("hidden", !show);
  document.getElementById("toggle-list").classList.toggle("active", show);
}

// ── 마커 호버 툴팁 ────────────────────────────────────────────────────────────
let tooltipEl = null;
function showLaunchTooltip(e) {
  const f = e.features && e.features[0];
  if (!f) return;
  const d = findLaunch(f.properties.id);
  if (!d) return;
  if (!tooltipEl) {
    tooltipEl = document.createElement("div");
    tooltipEl.className = "tooltip";
    document.body.appendChild(tooltipEl);
  }
  const cd = d.outcome === "upcoming" ? ` · ${escapeHtml(countdown(d.net))}` : "";
  tooltipEl.innerHTML = `<b>${escapeHtml(d.name)}</b><br><span class="tt-sub">${escapeHtml(tr(STATUS_KO, d.status) || OUTCOME_LABEL[d.outcome])}${cd}</span>`;
  tooltipEl.style.left = `${e.originalEvent.clientX}px`;
  tooltipEl.style.top = `${e.originalEvent.clientY - 14}px`;
  tooltipEl.style.display = "block";
}
function showClusterTooltip(e) {
  const f = e.features && e.features[0];
  if (!f) return;
  if (!tooltipEl) {
    tooltipEl = document.createElement("div");
    tooltipEl.className = "tooltip";
    document.body.appendChild(tooltipEl);
  }
  tooltipEl.innerHTML = `<b>${f.properties.point_count}건의 발사</b><br><span class="tt-sub">클릭하면 펼쳐집니다</span>`;
  tooltipEl.style.left = `${e.originalEvent.clientX}px`;
  tooltipEl.style.top = `${e.originalEvent.clientY - 14}px`;
  tooltipEl.style.display = "block";
}
function hideTooltip() { if (tooltipEl) tooltipEl.style.display = "none"; }

// ── 타임라인 슬라이더 ─────────────────────────────────────────────────────────
function recomputeTimeline() {
  const times = allLaunches
    .filter((d) => d.net).map((d) => new Date(d.net).getTime()).filter((t) => !isNaN(t));
  if (!times.length) return;
  tlMin = Math.min(...times);
  tlMax = Math.max(...times);
  timelineInited = true;
}

// ── 과거 발사 아카이브 (P7-5) ─────────────────────────────────────────────────
function populateArchiveYears() {
  const sel = document.getElementById("arch-year");
  const cur = new Date().getUTCFullYear();
  for (let y = cur; y >= cur - 4; y--) {  // 최근 5년(올해 포함)
    const opt = document.createElement("option");
    opt.value = String(y);
    opt.textContent = y + "년";
    sel.appendChild(opt);
  }
}

async function loadArchive(year) {
  if (loadedYears.has(year)) {
    showStatus(`${year}년은 이미 불러왔습니다.`);
    setTimeout(() => showStatus(null), 3000);
    return;
  }
  const btn = document.getElementById("arch-load");
  btn.disabled = true;
  showStatus(`${year}년 발사 아카이브 불러오는 중… (최초 1회, 수 초 소요)`);
  try {
    const res = await window.pywebview.api.get_archive(year);
    const list = res.launches || [];
    const have = new Set(archiveLaunches.map((d) => d.id));
    for (const d of list) if (!have.has(d.id)) archiveLaunches.push(d);
    loadedYears.add(year);
    rebuildAll();
    recomputeTimeline();
    applyFilters();
    if (res.error) showStatus(res.stale ? `⚠ ${res.error} (저장된 데이터)` : `⚠ ${res.error}`);
    else {
      showStatus(`${year}년 ${list.length}건 추가됨`);
      setTimeout(() => showStatus(null), 4000);
    }
  } catch (e) {
    showStatus("아카이브를 불러오지 못했습니다.");
    console.error(e);
  } finally {
    btn.disabled = false;
  }
}

function tlLabelDate(ms) {
  return new Date(ms).toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric" });
}

function onTimeline() {
  const v = +document.getElementById("tl-range").value;
  const label = document.getElementById("tl-label");
  // 최대(100)면 무제한 → 자동 갱신으로 들어온 더 먼 미래 발사도 안 잘림
  if (v >= 100 || tlMin == null) {
    timelineMax = null;
    label.textContent = "전체 기간";
  } else {
    timelineMax = tlMin + (v / 100) * (tlMax - tlMin);
    label.textContent = `${tlLabelDate(timelineMax)} 까지`;
  }
  applyFilters();
}

// ── 상세 패널 ─────────────────────────────────────────────────────────────────
function row(k, v) {
  if (!v) return "";
  return `<div class="row"><div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(v)}</div></div>`;
}

/** 클릭하면 그 대상(발사장·기관·로켓)만의 관점 화면으로 가는 행. */
function entityRow(k, v, kind) {
  if (!v) return "";
  return `<div class="row"><div class="k">${escapeHtml(k)}</div><div class="v">` +
    `<button class="site-link" data-kind="${kind}" data-val="${escapeHtml(v)}">` +
    `${escapeHtml(v)} ›</button></div></div>`;
}

/** 외부 링크는 파이썬 브릿지로 기본 브라우저에서 연다(http/https만 허용됨). */
function openExternal(url) {
  if (!url) return;
  try { window.pywebview.api.open_url(url); } catch (_) { /* 브릿지 없으면 무시 */ }
}

/** 실패/지연 사유처럼 강조가 필요한 긴 텍스트 블록. */
function reasonBlock(label, text, kind) {
  return `<div class="reason reason-${kind}">` +
    `<div class="reason-k">${escapeHtml(label)}</div>` +
    `<div class="reason-v">${escapeHtml(text)}</div></div>`;
}

/** net_precision 이 초 단위가 아니면 카운트다운을 곧이곧대로 믿으면 안 된다. */
const NET_PRECISION_KO = {
  Second: null, Minute: null,        // 확정에 가까움 — 따로 알리지 않음
  Hour: "시각이 시간 단위까지만 확정",
  Day: "날짜만 확정 (시각 미정)",
  Week: "주 단위로만 확정",
  Month: "월 단위로만 확정",
  Quarter: "분기 단위로만 확정",
  Year: "연 단위로만 확정",
};

/** 발사 윈도우가 net 과 다른 구간을 가질 때만 "22:45~00:15 (90분)" 로 보여준다. */
function windowText(d) {
  if (!d.window_start || !d.window_end) return null;
  const s = new Date(d.window_start), e = new Date(d.window_end);
  if (isNaN(s) || isNaN(e) || e <= s) return null;
  const mins = Math.round((e - s) / 60000);
  if (mins < 2) return null;  // 순간 발사(instantaneous)면 net 과 같아 의미 없음
  const hhmm = (dt) => dt.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  const dur = mins >= 60 ? `${Math.floor(mins / 60)}시간 ${mins % 60 ? (mins % 60) + "분" : ""}`.trim() : `${mins}분`;
  return `${hhmm(s)} ~ ${hhmm(e)} (${dur})`;
}

/** 중계 링크 버튼들. 클릭 시 파이썬 브릿지로 기본 브라우저에서 연다. */
function vidLinksBlock(d) {
  const vids = d.vid_urls || [];
  if (!vids.length) return "";
  const live = d.webcast_live ? `<span class="live-badge">● 생중계 중</span>` : "";
  const btns = vids.map((v) =>
    `<button class="vid-btn" data-url="${escapeHtml(v.url)}" title="${escapeHtml(v.url)}">` +
    `▶ ${escapeHtml(v.title)}</button>`).join("");
  return `<div class="vid-block"><div class="vid-head">중계 ${live}</div>${btns}</div>`;
}

/** "이 발사대 285번째 · SpaceX 올해 90번째" — 숫자 하나로 맥락이 생긴다. */
function contextText(d) {
  const parts = [];
  if (d.pad_count) parts.push(`이 발사대 ${Number(d.pad_count).toLocaleString()}번째`);
  if (d.agency_year_count) parts.push(`${d.provider || "이 기관"} 올해 ${d.agency_year_count}번째`);
  return parts.length ? parts.join(" · ") : null;
}

function updatesBlock(d) {
  const ups = d.updates || [];
  if (!ups.length) return "";
  const rows = ups.map((u) => {
    const when = u.created_on ? fmtDate(u.created_on) : "";
    const link = u.info_url
      ? `<button class="up-link" data-url="${escapeHtml(u.info_url)}">원문</button>` : "";
    return `<div class="up-row"><div class="up-when">${escapeHtml(when)}${link}</div>` +
           `<div class="up-text">${escapeHtml(u.comment)}</div></div>`;
  }).join("");
  return `<div class="updates"><div class="updates-head">발사 소식</div>${rows}</div>`;
}

function openPanel(d) {
  const panel = document.getElementById("panel");
  const body = document.getElementById("panel-body");
  const cd = d.outcome === "upcoming"
    ? `<div class="cd" data-net="${escapeHtml(d.net)}">${escapeHtml(countdown(d.net))}</div>` : "";
  const precision = NET_PRECISION_KO[d.net_precision];
  const progs = (d.programs || []).map((p) =>
    `<span class="prog-tag">${escapeHtml(p)}</span>`).join("");
  body.innerHTML = `
    ${d.image ? `<img src="${escapeHtml(d.image)}" alt="" onerror="this.remove()" />` : ""}
    <h2>${escapeHtml(d.name)}</h2>
    ${d.patch ? `<img class="patch" src="${escapeHtml(d.patch)}" alt="" onerror="this.remove()" />` : ""}
    <span class="badge m-${d.outcome}">${escapeHtml(tr(STATUS_KO, d.status) || OUTCOME_LABEL[d.outcome])}</span>
    ${favBtnHtml("launch", d.id)}
    ${progs}
    ${cd}
    ${precision ? `<div class="net-precision">⚠ ${escapeHtml(precision)}</div>` : ""}
    ${vidLinksBlock(d)}
    ${d.fail_reason ? reasonBlock("실패 사유", d.fail_reason, "fail") : ""}
    ${d.hold_reason ? reasonBlock("지연·보류 사유", d.hold_reason, "warn") : ""}
    ${d.weather_concerns ? reasonBlock("기상 우려", d.weather_concerns, "warn") : ""}
    ${row("발사 시각", fmtDate(d.net))}
    ${row("발사 윈도우", windowText(d))}
    ${row("발사 확률", d.probability != null && d.probability >= 0 ? d.probability + "%" : null)}
    ${entityRow("로켓", d.rocket, "rocket")}
    ${entityRow("기관", d.provider, "provider")}
    ${row("국가", countryKo(d.provider_country))}
    ${row("미션", d.mission_name)}
    ${row("종류", tr(MISSION_TYPE_KO, d.mission_type))}
    ${row("궤도", tr(ORBIT_KO, d.orbit))}
    ${entityRow("발사장", d.location_name, "site")}
    ${row("패드", d.pad_name)}
    ${row("기록", contextText(d))}
    ${d.mission_desc ? `<div class="mission-desc">${escapeHtml(d.mission_desc)}</div>` : ""}
    ${updatesBlock(d)}
  `;
  // 링크는 파이썬 브릿지로만 연다(창 안에서 열리면 지도로 못 돌아온다)
  body.querySelectorAll(".vid-btn, .up-link").forEach((b) =>
    b.addEventListener("click", () => openExternal(b.dataset.url)));
  body.querySelectorAll(".site-link").forEach((b) =>
    b.addEventListener("click", () => showEntityStats(b.dataset.kind, b.dataset.val)));
  bindFavBtn(body);
  satPanelId = null;  // 발사 상세를 열면 위성 상세 라이브 갱신은 중지
  panel.classList.remove("hidden");
  // 좌표 없는 발사(목록에서 열 수 있음)는 flyTo가 NaN이 되므로 좌표가 있을 때만 이동
  if (typeof d.lng === "number" && typeof d.lat === "number")
    map.flyTo({ center: [d.lng, d.lat], zoom: 4.5, speed: 1.2 });
}

function closePanel() {
  document.getElementById("panel").classList.add("hidden");
  satPanelId = null;
}

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
  };
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
      row("이심률", d.ecc != null ? d.ecc.toFixed(4) : null)
    : `<div class="pass-empty">궤도 정보를 계산할 수 없습니다.</div>`;
}

function openSatPanel(s) {
  satPanelId = s.norad;  // 이 위성이 열려 있는 동안 매 초 값 갱신
  const body = document.getElementById("panel-body");
  body.innerHTML =
    `<h2>🛰 ${escapeHtml(s.name)}</h2>` +
    `<span class="badge m-upcoming">위성</span>` +
    favBtnHtml("sat", s.norad) +
    `<div class="st-note">값은 실시간으로 갱신됩니다.</div>` +
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

// ── 발사 자동 갱신 ────────────────────────────────────────────────────────────
function startAutoRefresh() {
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = setInterval(() => loadLaunches(false, true), AUTO_REFRESH_MS);
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

/** 대역 필터를 통과하는 위성만. 지도·목록이 같은 기준을 쓰게 한 곳에 둔다.
 *  관심 위성은 필터와 무관하게 남긴다 — 관심 탭에서 골랐는데 지도에 점이 없으면 고장으로 보인다. */
function visibleSats() {
  return satrecs.filter((s) => satBands[s.band] !== false || isFavSat(s.norad));
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
function computeGroundTrack(rec) {
  // 평균운동(rad/min)에서 주기 산출. 비정상값이면 LEO 기본 90분으로 대체.
  let periodMin = (rec.no && rec.no > 0) ? (2 * Math.PI) / rec.no : 90;
  if (!isFinite(periodMin) || periodMin <= 0 || periodMin > 24 * 60) periodMin = 90;
  const half = periodMin / 2;
  const segments = [];
  let cur = [];
  let prevLng = null;
  for (let dm = -half; dm <= half; dm += 1) {
    const t = new Date(Date.now() + dm * 60000);
    let pv;
    try { pv = satellite.propagate(rec, t); } catch (_) { continue; }
    if (!pv || !pv.position) continue;
    const geo = satellite.eciToGeodetic(pv.position, satellite.gstime(t));
    const lng = satellite.degreesLong(geo.longitude);
    const lat = satellite.degreesLat(geo.latitude);
    if (!isFinite(lng) || !isFinite(lat)) continue;
    if (prevLng != null && Math.abs(lng - prevLng) > 180) {
      if (cur.length > 1) segments.push(cur);  // 날짜변경선 통과 → 세그먼트 분리
      cur = [];
    }
    cur.push([lng, lat]);
    prevLng = lng;
  }
  if (cur.length > 1) segments.push(cur);
  return { type: "Feature", geometry: { type: "MultiLineString", coordinates: segments }, properties: {} };
}

function drawGroundTrack() {
  const src = map.getSource("sat-track");
  if (!src) return;
  src.setData(selectedSat ? computeGroundTrack(selectedSat.rec) : EMPTY_FC);
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

/** 관측지 기준, 향후 hours시간의 위성 통과(고도>minEl 연속 구간)를 계산. */
function computePasses(rec, obs, hours = 24, stepSec = 30, minEl = 10) {
  const observerGd = { latitude: obs.lat * DEG, longitude: obs.lng * DEG, height: 0 };
  const passes = [];
  let cur = null;
  const start = Date.now();
  const end = start + hours * 3600 * 1000;
  for (let t = start; t <= end; t += stepSec * 1000) {
    const date = new Date(t);
    let pv;
    try { pv = satellite.propagate(rec, date); } catch (_) { continue; }
    if (!pv || !pv.position) continue;
    const ecf = satellite.eciToEcf(pv.position, satellite.gstime(date));
    const look = satellite.ecfToLookAngles(observerGd, ecf);
    const elDeg = look.elevation / DEG;
    const azDeg = look.azimuth / DEG;
    if (elDeg >= minEl) {
      if (!cur) cur = { start: t, startAz: azDeg, maxEl: elDeg, maxAz: azDeg };
      else if (elDeg > cur.maxEl) { cur.maxEl = elDeg; cur.maxAz = azDeg; }
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

function showPasses() {
  if (!selectedSat || !observer) return;
  const passes = computePasses(selectedSat.rec, observer);
  const panel = document.getElementById("pass-panel");
  const body = document.getElementById("pass-body");
  const head =
    `<h2>🛰 ${escapeHtml(selectedSat.name)} 통과 예측</h2>` +
    `<div class="pass-obs">관측지 ${observer.lat.toFixed(3)}, ${observer.lng.toFixed(3)} · 향후 24시간 · 최대고도 10° 이상</div>`;
  if (passes.length === 0) {
    body.innerHTML = head + `<div class="pass-empty">예측된 통과가 없습니다.</div>`;
  } else {
    body.innerHTML = head + passes.map((p) => {
      const dir = `${azToCompass(p.startAz)}→${azToCompass(p.endAz)}`;
      const dur = Math.max(1, Math.round((p.end - p.start) / 60000));
      return `<div class="pass-row">` +
        `<div class="pass-time">${escapeHtml(fmtPassTime(p.start))}</div>` +
        `<div class="pass-meta">${escapeHtml(dir)} · 최대고도 ${Math.round(p.maxEl)}° · ${dur}분</div>` +
        `</div>`;
    }).join("");
  }
  panel.classList.remove("hidden");
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

// ── 속보 티커 (임박한 예정 발사 + 최근 발사 결과 순환) ────────────────────────
const TICKER_RESULT_MAX = 8;   // 티커에 섞을 최근 결과 개수 상한

/** "3시간 전" / "2일 전" — 티커의 결과 항목이 언제 일인지 알려준다. */
function agoText(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  if (!isFinite(diff)) return "";
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${Math.max(mins, 0)}분 전`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

/** 예정 2건마다 최근 결과 1건을 끼운다 — 예정이 주(主)이되 결과도 계속 흐르게. */
function buildTickerItems() {
  const now = Date.now();
  const upcoming = launches
    .filter((d) => d.outcome === "upcoming" && d.net && new Date(d.net).getTime() >= now)
    .sort((a, b) => new Date(a.net) - new Date(b.net));
  const recent = launches
    .filter((d) => d.outcome !== "upcoming" && d.net && new Date(d.net).getTime() < now)
    .sort((a, b) => new Date(b.net) - new Date(a.net))
    .slice(0, TICKER_RESULT_MAX);

  const items = [];
  let ri = 0;
  upcoming.forEach((d, i) => {
    items.push({ kind: "upcoming", d });
    if (i % 2 === 1 && ri < recent.length) items.push({ kind: "result", d: recent[ri++] });
  });
  while (ri < recent.length) items.push({ kind: "result", d: recent[ri++] });  // 예정이 적어 남은 결과
  return items;
}

function tickerHtml(item) {
  const d = item.d;
  const where = d.location_name ? ` · ${escapeHtml(d.location_name)}` : "";
  if (item.kind === "upcoming") {
    return `<span class="tk-cd">${escapeHtml(countdown(d.net))}</span> · ${escapeHtml(d.name)}${where}`;
  }
  const label = OUTCOME_LABEL[d.outcome] || d.outcome;
  return `<span class="tk-res tk-${escapeHtml(d.outcome)}">${escapeHtml(label)}</span>` +
         ` · ${escapeHtml(d.name)}${where} · <span class="tk-ago">${escapeHtml(agoText(d.net))}</span>`;
}

function startTicker() {
  if (tickerTimer) clearInterval(tickerTimer);
  const items = buildTickerItems();
  const el = document.getElementById("ticker-text");
  if (items.length === 0) {
    el.textContent = "표시할 발사 정보가 없습니다.";
    return;
  }
  let idx = 0;
  let shown = -1;   // 마지막으로 그린 인덱스 — 결과 항목은 매초 다시 그릴 필요가 없다
  const tick = () => {
    // 카운트다운이 끝난 예정 항목은 건너뛴다(한 바퀴까지만 탐색)
    for (let n = 0; n < items.length; n++) {
      const it = items[idx];
      if (it.kind === "upcoming" && new Date(it.d.net).getTime() < Date.now()) {
        idx = (idx + 1) % items.length;
      } else break;
    }
    const item = items[idx];
    if (item.kind === "upcoming" || idx !== shown) {
      el.innerHTML = tickerHtml(item);
      shown = idx;
    }
    // 패널이 열려있으면 그 카운트다운도 갱신
    const cd = document.querySelector("#panel-body .cd");
    if (cd && cd.dataset.net) cd.textContent = countdown(cd.dataset.net);
  };
  tick();
  let secs = 0;
  tickerTimer = setInterval(() => {
    secs++;
    if (secs % 5 === 0) idx = (idx + 1) % items.length;  // 5초마다 다음 항목
    tick();
  }, 1000);
}

// ── 마지막 갱신 시각 (P7-7) ───────────────────────────────────────────────────
function updateFreshness() {
  const el = document.getElementById("freshness");
  if (!el) return;
  if (lastLaunchLoad == null) { el.textContent = ""; return; }
  const mins = Math.floor((Date.now() - lastLaunchLoad) / 60000);
  el.textContent = "🕒 " + (mins <= 0 ? "방금 갱신" : `${mins}분 전 갱신`);
}

// ── 설정 저장/복원 (P8-9) ─────────────────────────────────────────────────────
function saveSettings(patch) {
  try { window.pywebview.api.save_settings(patch); } catch (_) { /* 저장 실패는 무시 */ }
}

function currentFilters() {
  const o = {};
  document.querySelectorAll(".flt").forEach((c) => { o[c.value] = c.checked; });
  return o;
}

/** 저장된 설정을 UI 상태로 반영(지도 초기화 전에 호출). */
function applySettings(s) {
  if (!s) return;
  if (s.filters) {
    document.querySelectorAll(".flt").forEach((c) => {
      if (s.filters[c.value] != null) c.checked = !!s.filters[c.value];
    });
  }
  if (typeof s.terminator === "boolean") document.getElementById("toggle-terminator").checked = s.terminator;
  if (s.satellites) {
    if (Array.isArray(s.satellites.groups) && s.satellites.groups.length) satGroups = s.satellites.groups;
    if (s.satellites.enabled) document.getElementById("toggle-sat").checked = true;
    const b = s.satellites.bands;
    // 전부 꺼진 설정이 저장돼 있으면 위성이 하나도 안 보여 앱이 고장난 것처럼 된다 → 무시
    if (b && BANDS.some((x) => b[x.key])) {
      BANDS.forEach((x) => { satBands[x.key] = b[x.key] !== false; });
    }
  }
  if (s.observer && typeof s.observer.lat === "number" && typeof s.observer.lng === "number") {
    observer = s.observer;
  }
  if (s.basemap === "satellite" || s.basemap === "dark") setBasemap(s.basemap);
  const cam = s.camera;
  if (cam && typeof cam.lng === "number" && typeof cam.lat === "number"
      && typeof cam.zoom === "number" && isFinite(cam.lng) && isFinite(cam.lat)) {
    savedCamera = { lng: cam.lng, lat: cam.lat, zoom: Math.min(Math.max(cam.zoom, 0), 20) };
  }
  if (s.favorites) {
    if (Array.isArray(s.favorites.launches)) favLaunches = new Set(s.favorites.launches.map(String));
    if (Array.isArray(s.favorites.sats)) favSats = new Set(s.favorites.sats.map(String));
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
        `${escapeHtml(b.label)} <span class="muted">${escapeHtml(b.note)}</span></label>`).join("");
    box.querySelectorAll(".satg").forEach((c) => c.addEventListener("change", onSatGroupChange));
    box.querySelectorAll(".satb").forEach((c) => c.addEventListener("change", onSatBandChange));
  } catch (e) { console.error("위성 그룹 로드 실패", e); }
}

function onSatGroupChange() {
  satGroups = Array.from(document.querySelectorAll(".satg:checked")).map((c) => c.value);
  const enabled = document.getElementById("toggle-sat").checked;
  saveSettings({ satellites: { enabled, groups: satGroups, bands: satBands } });
  if (enabled) { satrecs = []; loadSatellites(); }  // 그룹이 바뀌었으니 재로드
}

/** 대역 필터 변경 — 재로드 없이 즉시 반영(이미 받아둔 TLE만 걸러낸다). */
function onSatBandChange() {
  BANDS.forEach((b) => { satBands[b.key] = false; });
  document.querySelectorAll(".satb:checked").forEach((c) => { satBands[c.value] = true; });
  saveSettings({
    satellites: { enabled: document.getElementById("toggle-sat").checked, groups: satGroups, bands: satBands },
  });
  // 선택 위성이 필터 밖으로 나가면 궤적선만 지도에 남으므로 함께 해제
  if (selectedSat && satBands[selectedSat.band] === false && !isFavSat(selectedSat.norad)) deselectSatellite();
  updateSatCount();
  if (satTimer) updateSatellitePositions();  // 다음 초를 기다리지 않고 바로 반영
  if (sidebarTab === "sats") renderSatList();
  else if (sidebarTab === "favs") renderFavList();
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

// ── 발사 통계 패널 (P8-10) ────────────────────────────────────────────────────
function computeStats(list) {
  const byOutcome = { success: 0, failure: 0, partial: 0, upcoming: 0 };
  const byProvider = {}, byCountry = {}, byYear = {};
  for (const d of list) {
    if (byOutcome[d.outcome] != null) byOutcome[d.outcome]++;
    if (d.provider) byProvider[d.provider] = (byProvider[d.provider] || 0) + 1;
    const c = countryKo(d.provider_country);
    if (c) byCountry[c] = (byCountry[c] || 0) + 1;
    if (d.net) { const y = new Date(d.net).getFullYear(); if (!isNaN(y)) byYear[y] = (byYear[y] || 0) + 1; }
  }
  return { byOutcome, byProvider, byCountry, byYear, total: list.length };
}

/** {키:수} → 가로 막대 HTML. entries는 미리 정렬해 넘긴다. */
/** 패드 이름은 "Space Launch Complex 4E" 처럼 길어 좁은 라벨에서 잘린다 → 통용 약어로. */
const PAD_ABBREV = [
  [/^Space Launch Complex\s*/i, "SLC "],
  [/^Orbital Launch Pad\s*/i, "OLP "],
  [/^Launch Complex\s*/i, "LC "],
  [/^Launch Pad\s*/i, "LP "],
  [/^Launch Area\s*/i, "LA "],
  [/^Launch Vehicle Pad\s*/i, "LVP "],
];

function shortenPad(name) {
  let s = String(name);
  for (const [re, rep] of PAD_ABBREV) {
    if (re.test(s)) return s.replace(re, rep).trim();
  }
  return s;
}

function statBars(entries, color) {
  const max = Math.max(1, ...entries.map((e) => e[1]));
  return entries.map(([k, v]) =>
    // 축약해도 잘릴 수 있으니 원문은 title 로 남긴다
    `<div class="st-row"><span class="st-k" title="${escapeHtml(String(k))}">${escapeHtml(String(k))}</span>` +
    `<span class="st-bar"><span style="width:${(v / max * 100).toFixed(1)}%;background:${color}"></span></span>` +
    `<span class="st-v">${v}</span></div>`
  ).join("");
}

// ── 관점 화면 (발사장 / 기관 / 로켓) — P10-3, P11-1 ───────────────────────────
// 셋 다 "특정 대상의 발사만 모아 성적을 본다"는 같은 화면이다.
// 뼈대(타일·결과별·예정/최근 목록)는 공유하고 중간 막대 구성만 관점별로 바꾼다.
const ENTITY_VIEWS = {
  site:     { icon: "🛫", field: "location_name" },
  provider: { icon: "🏢", field: "provider" },
  rocket:   { icon: "🚀", field: "rocket" },
};

function countBy(list, pick) {
  const o = {};
  for (const d of list) { const k = pick(d); if (k) o[k] = (o[k] || 0) + 1; }
  return o;
}

const topEntries = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);

/** 관점별 막대 구성 → [제목, entries, 색, 최소개수] 목록. 최소개수 미만이면 그 절은 생략. */
function entityBars(kind, list, s) {
  const rockets = () => topEntries(countBy(list, (d) => d.rocket), 6);
  const providers = () => topEntries(countBy(list, (d) => d.provider), 6);
  const sites = () => topEntries(countBy(list, (d) => d.location_name), 6);
  const pads = () => topEntries(countBy(list, (d) => d.pad_name && shortenPad(d.pad_name)), 6);
  const years = () => Object.entries(s.byYear).sort((a, b) => a[0] - b[0]);
  if (kind === "site")
    // 패드가 하나뿐인 발사장에선 "패드별" 막대가 총합과 같아 의미 없다 → 2개 이상일 때만
    return [["주요 로켓", rockets(), "#f472b6"], ["기관", providers(), "#a78bfa"],
            ["패드별", pads(), "#7dd3fc", 2]];
  if (kind === "provider")
    return [["주요 로켓", rockets(), "#f472b6"], ["발사장", sites(), "#7dd3fc"],
            ["연도별", years(), "#34d399"]];
  return [["기관", providers(), "#a78bfa"], ["발사장", sites(), "#7dd3fc"],
          ["연도별", years(), "#34d399"]];
}

/** 발사장·기관·로켓 중 하나를 기준으로 그 대상만의 성적·목록을 낸다. */
function showEntityStats(kind, value) {
  const view = ENTITY_VIEWS[kind];
  if (!view || !value) return;
  const list = allLaunches.filter((d) => d[view.field] === value);
  if (!list.length) return;

  const s = computeStats(list);
  const decided = s.byOutcome.success + s.byOutcome.failure + s.byOutcome.partial;
  const rate = decided ? Math.round(s.byOutcome.success / decided * 100) : null;

  const dated = list.filter((d) => d.net && !isNaN(new Date(d.net)));
  const past = dated.filter((d) => d.outcome !== "upcoming")
    .sort((a, b) => new Date(b.net) - new Date(a.net));
  const upcoming = dated.filter((d) => d.outcome === "upcoming")
    .sort((a, b) => new Date(a.net) - new Date(b.net));
  const span = dated.length
    ? `${tlLabelDate(Math.min(...dated.map((d) => +new Date(d.net))))} ~ ` +
      `${tlLabelDate(Math.max(...dated.map((d) => +new Date(d.net))))}`
    : null;

  const rows = (arr, n) => arr.slice(0, n).map((d) =>
    `<button class="site-row" data-id="${escapeHtml(String(d.id))}">` +
    `<span class="dot d-${d.outcome}"></span>` +
    `<span class="site-row-main"><span class="site-row-name">${escapeHtml(d.name)}</span>` +
    `<span class="site-row-sub">${escapeHtml(d.outcome === "upcoming" ? countdown(d.net) : fmtDate(d.net))}</span>` +
    `</span></button>`).join("");

  const bars = entityBars(kind, list, s)
    .map(([label, entries, color, min]) =>
      entries.length >= (min || 1) ? `<div class="st-sec">${label}</div>` + statBars(entries, color) : "")
    .join("");

  document.getElementById("stats-body").innerHTML =
    `<h2>${view.icon} ${escapeHtml(value)}</h2>` +
    `<div class="st-note">현재 불러온 ${s.total}건 기준 · 과거 연도를 불러오면 더 정확해집니다.` +
      (span ? `<br />${escapeHtml(span)}` : "") + `</div>` +
    `<div class="st-tiles">` +
      `<div class="st-tile"><div class="st-num">${s.total}</div><div class="st-lab">총 발사</div></div>` +
      `<div class="st-tile"><div class="st-num">${rate == null ? "—" : rate + "%"}</div><div class="st-lab">성공률</div></div>` +
      `<div class="st-tile"><div class="st-num">${s.byOutcome.upcoming}</div><div class="st-lab">예정</div></div>` +
    `</div>` +
    `<div class="st-sec">결과별</div>` +
    statBars([["성공", s.byOutcome.success], ["실패", s.byOutcome.failure],
              ["부분 실패", s.byOutcome.partial], ["예정", s.byOutcome.upcoming]], "var(--accent)") +
    bars +
    (upcoming.length ? `<div class="st-sec">예정 발사</div>` + rows(upcoming, 5) : "") +
    (past.length ? `<div class="st-sec">최근 발사</div>` + rows(past, 5) : "");

  const panel = document.getElementById("stats-panel");
  panel.querySelectorAll(".site-row").forEach((b) => b.addEventListener("click", () => {
    const d = findLaunch(b.dataset.id);
    if (d) { panel.classList.add("hidden"); openPanel(d); }
  }));
  panel.classList.remove("hidden");
}

function showStats() {
  const s = computeStats(allLaunches);
  const decided = s.byOutcome.success + s.byOutcome.failure + s.byOutcome.partial;
  const rate = decided ? Math.round(s.byOutcome.success / decided * 100) : null;
  const providers = Object.entries(s.byProvider).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const countries = Object.entries(s.byCountry).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const years = Object.entries(s.byYear).sort((a, b) => a[0] - b[0]);

  document.getElementById("stats-body").innerHTML =
    `<h2>📊 발사 통계</h2>` +
    `<div class="st-note">현재 불러온 ${s.total}건 기준 · 과거 연도를 불러오면 더 정확해집니다.</div>` +
    `<div class="st-tiles">` +
      `<div class="st-tile"><div class="st-num">${s.total}</div><div class="st-lab">총 발사</div></div>` +
      `<div class="st-tile"><div class="st-num">${rate == null ? "—" : rate + "%"}</div><div class="st-lab">성공률</div></div>` +
      `<div class="st-tile"><div class="st-num">${s.byOutcome.upcoming}</div><div class="st-lab">예정</div></div>` +
    `</div>` +
    `<div class="st-sec">결과별</div>` +
    statBars([["성공", s.byOutcome.success], ["실패", s.byOutcome.failure],
              ["부분 실패", s.byOutcome.partial], ["예정", s.byOutcome.upcoming]], "var(--accent)") +
    (years.length ? `<div class="st-sec">연도별</div>` + statBars(years, "#7dd3fc") : "") +
    (providers.length ? `<div class="st-sec">기관 (상위 8)</div>` + statBars(providers, "#a78bfa") : "") +
    (countries.length ? `<div class="st-sec">국가 (상위 8)</div>` + statBars(countries, "#34d399") : "");
  document.getElementById("stats-panel").classList.remove("hidden");
}

// ── 이벤트 바인딩 ─────────────────────────────────────────────────────────────
function bindUI() {
  document.getElementById("search").addEventListener("input", applyFilters);
  document.querySelectorAll(".flt").forEach((c) => c.addEventListener("change", () => {
    applyFilters();
    saveSettings({ filters: currentFilters() });
  }));
  document.getElementById("panel-close").addEventListener("click", closePanel);
  document.getElementById("toggle-terminator").addEventListener("change", (e) => {
    updateTerminator();
    saveSettings({ terminator: e.target.checked });
  });
  document.getElementById("toggle-sat").addEventListener("change", (e) => {
    setSatelliteVisible(e.target.checked);
    saveSettings({ satellites: { enabled: e.target.checked, groups: satGroups, bands: satBands } });
  });
  document.getElementById("sat-groups-btn").addEventListener("click", toggleSatGroups);
  document.getElementById("basemap-btn").addEventListener("click", toggleBasemap);
  document.getElementById("stats-btn").addEventListener("click", showStats);
  document.getElementById("stats-close").addEventListener("click", () =>
    document.getElementById("stats-panel").classList.add("hidden"));
  document.getElementById("sat-track-btn").addEventListener("click", toggleTracking);
  document.getElementById("sat-obs-btn").addEventListener("click", beginSetObserver);
  document.getElementById("sat-pass-btn").addEventListener("click", showPasses);
  document.getElementById("sat-ctrl-close").addEventListener("click", deselectSatellite);
  document.getElementById("pass-close").addEventListener("click", () =>
    document.getElementById("pass-panel").classList.add("hidden"));
  document.getElementById("toggle-list").addEventListener("click", toggleSidebar);
  document.getElementById("sidebar-list").addEventListener("click", (e) => {
    const rowEl = e.target.closest(".sb-row");
    if (!rowEl) return;
    if (rowEl.dataset.norad) { pickSatellite(rowEl.dataset.norad); return; }
    const d = findLaunch(rowEl.dataset.id);
    if (d) openPanel(d);
  });
  document.getElementById("tab-launches").addEventListener("click", () => setSidebarTab("launches"));
  document.getElementById("tab-sats").addEventListener("click", () => setSidebarTab("sats"));
  document.getElementById("tab-favs").addEventListener("click", () => setSidebarTab("favs"));
  document.getElementById("sat-search").addEventListener("input", renderSatList);
  document.getElementById("tl-range").addEventListener("input", onTimeline);
  populateArchiveYears();
  document.getElementById("arch-load").addEventListener("click", () =>
    loadArchive(+document.getElementById("arch-year").value));
  document.getElementById("refresh").addEventListener("click", () => {
    showStatus("강제 갱신 중… (시간당 요청 제한에 주의)");
    loadLaunches(true);
    if (document.getElementById("toggle-sat").checked) loadSatellites();
  });
}

// pywebview 브릿지가 준비된 뒤 시작
window.addEventListener("pywebviewready", async () => {
  bindUI();
  const settings = await window.pywebview.api.get_settings().catch(() => null);
  applySettings(settings);       // 필터·토글·그룹·관측 위치 복원(지도 초기화 전)
  await initSatGroups();         // 그룹 체크박스를 satGroups 기준으로 생성
  setInterval(updateFreshness, 30000);  // "N분 전 갱신" 주기 갱신(P7-7)
  initMap();
});
