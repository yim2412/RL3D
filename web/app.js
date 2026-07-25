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
let lastLaunchLoad = null;  // 마지막 발사 데이터 기준 시각(ms) — "N분 전 갱신"(P7-7)

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
      },
      layers: [{ id: "carto", type: "raster", source: "carto" }],
    },
    center: [10, 20],
    zoom: 1.6,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
  map.on("load", () => {
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
      "circle-radius": ["case", ["==", ["get", "outcome"], "upcoming"], 8, 5],
      "circle-stroke-width": ["case", ["==", ["get", "outcome"], "upcoming"], 2.5, 1.2],
      "circle-stroke-color": "#ffffff",
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
        properties: { id: d.id, outcome: d.outcome },
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

// ── 발사 목록 사이드바 (P6-4) ─────────────────────────────────────────────────
// 임박한 예정 발사를 위로(오름차순), 지난 발사는 최근 순(내림차순)으로 정렬.
function renderSidebar(list) {
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
    return `<button class="sb-row" data-id="${escapeHtml(String(d.id))}">` +
      `<span class="dot d-${d.outcome}"></span>` +
      `<span class="sb-main"><span class="sb-name">${escapeHtml(d.name)}</span>` +
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

/** 실패/지연 사유처럼 강조가 필요한 긴 텍스트 블록. */
function reasonBlock(label, text, kind) {
  return `<div class="reason reason-${kind}">` +
    `<div class="reason-k">${escapeHtml(label)}</div>` +
    `<div class="reason-v">${escapeHtml(text)}</div></div>`;
}

function openPanel(d) {
  const panel = document.getElementById("panel");
  const body = document.getElementById("panel-body");
  const cd = d.outcome === "upcoming"
    ? `<div class="cd" data-net="${escapeHtml(d.net)}">${escapeHtml(countdown(d.net))}</div>` : "";
  body.innerHTML = `
    ${d.image ? `<img src="${escapeHtml(d.image)}" alt="" onerror="this.remove()" />` : ""}
    <h2>${escapeHtml(d.name)}</h2>
    <span class="badge m-${d.outcome}">${escapeHtml(tr(STATUS_KO, d.status) || OUTCOME_LABEL[d.outcome])}</span>
    ${cd}
    ${d.fail_reason ? reasonBlock("실패 사유", d.fail_reason, "fail") : ""}
    ${d.hold_reason ? reasonBlock("지연·보류 사유", d.hold_reason, "warn") : ""}
    ${row("발사 시각", fmtDate(d.net))}
    ${row("로켓", d.rocket)}
    ${row("기관", d.provider)}
    ${row("국가", countryKo(d.provider_country))}
    ${row("미션", d.mission_name)}
    ${row("종류", tr(MISSION_TYPE_KO, d.mission_type))}
    ${row("궤도", tr(ORBIT_KO, d.orbit))}
    ${row("발사장", d.location_name)}
    ${row("패드", d.pad_name)}
    ${d.mission_desc ? `<div class="mission-desc">${escapeHtml(d.mission_desc)}</div>` : ""}
  `;
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

function openSatPanel(s) {
  satPanelId = s.norad;  // 이 위성이 열려 있는 동안 매 초 값 갱신
  const d = satDetails(s.rec);
  const body = document.getElementById("panel-body");
  const rows = d
    ? row("NORAD ID", String(s.norad)) +
      row("고도", d.alt != null ? Math.round(d.alt).toLocaleString() + " km" : null) +
      row("속도", d.vel != null ? d.vel.toFixed(2) + " km/s" : null) +
      row("현재 위치", `${d.lat.toFixed(2)}°, ${d.lng.toFixed(2)}°`) +
      row("궤도 주기", d.periodMin != null ? d.periodMin.toFixed(1) + "분" : null) +
      row("경사각", d.incl != null ? d.incl.toFixed(2) + "°" : null) +
      row("이심률", d.ecc != null ? d.ecc.toFixed(4) : null)
    : `<div class="pass-empty">궤도 정보를 계산할 수 없습니다.</div>`;
  body.innerHTML =
    `<h2>🛰 ${escapeHtml(s.name)}</h2>` +
    `<span class="badge m-upcoming">위성</span>` +
    `<div class="st-note">값은 실시간으로 갱신됩니다.</div>` + rows;
  document.getElementById("panel").classList.remove("hidden");
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
      "circle-radius": 2.8,
      "circle-color": "#e8ecff",
      "circle-opacity": 0.9,
      "circle-stroke-width": 0.6,
      "circle-stroke-color": "#9fb0ff",
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
        if (rec && !rec.error) satrecs.push({ name: s.name, norad: s.norad_id, rec });
      } catch (_) { /* 이 위성만 건너뜀 */ }
    }
    document.getElementById("sat-count").textContent = satrecs.length ? `(${satrecs.length})` : "";
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
  for (const s of satrecs) {
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
      properties: { name: s.name, norad: s.norad, alt: Math.round(geo.height) },
    });
  }
  map.getSource("satellites").setData({ type: "FeatureCollection", features });
  if (tracking && selectedSat) centerOnSelected();  // 추적 모드: 매 초 지도 중심 갱신
  // 상세 패널이 열려 있으면 고도·속도·위치를 실시간 갱신
  if (satPanelId && selectedSat && String(selectedSat.norad) === String(satPanelId)
      && !document.getElementById("panel").classList.contains("hidden")) {
    openSatPanel(selectedSat);
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
  }
  if (s.observer && typeof s.observer.lat === "number" && typeof s.observer.lng === "number") {
    observer = s.observer;
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
    }).join("");
    box.querySelectorAll(".satg").forEach((c) => c.addEventListener("change", onSatGroupChange));
  } catch (e) { console.error("위성 그룹 로드 실패", e); }
}

function onSatGroupChange() {
  satGroups = Array.from(document.querySelectorAll(".satg:checked")).map((c) => c.value);
  const enabled = document.getElementById("toggle-sat").checked;
  saveSettings({ satellites: { enabled, groups: satGroups } });
  if (enabled) { satrecs = []; loadSatellites(); }  // 그룹이 바뀌었으니 재로드
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
function statBars(entries, color) {
  const max = Math.max(1, ...entries.map((e) => e[1]));
  return entries.map(([k, v]) =>
    `<div class="st-row"><span class="st-k">${escapeHtml(String(k))}</span>` +
    `<span class="st-bar"><span style="width:${(v / max * 100).toFixed(1)}%;background:${color}"></span></span>` +
    `<span class="st-v">${v}</span></div>`
  ).join("");
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
    saveSettings({ satellites: { enabled: e.target.checked, groups: satGroups } });
  });
  document.getElementById("sat-groups-btn").addEventListener("click", toggleSatGroups);
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
    const d = findLaunch(rowEl.dataset.id);
    if (d) openPanel(d);
  });
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
