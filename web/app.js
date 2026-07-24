/* RL3D — 지도·마커·티커·필터 로직.
 * 파이썬 브릿지(window.pywebview.api)에서 받은 JSON을 MapLibre 지도에 그린다.
 */

// ── 상태 ─────────────────────────────────────────────────────────────────────
let map = null;
let launches = [];          // 정규화된 발사 배열
let tickerTimer = null;

let satrecs = [];           // { name, norad, rec } — satellite.js SGP4 레코드
let satTimer = null;        // 위성 위치 갱신 타이머(초당)

let autoTimer = null;       // 발사 자동 갱신 타이머
const AUTO_REFRESH_MS = 5 * 60 * 1000;  // 5분마다 폴링(실제 API는 캐시 TTL이 제어)

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
    setupLaunchLayers();    // 발사 클러스터/포인트 레이어(빈 소스로 먼저 생성)
    setupSatelliteLayer();  // 빈 레이어만(기본 숨김). 위성은 토글 켤 때 로드
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
    if (res.error) showStatus(res.stale ? `⚠ ${res.error} (저장된 데이터 표시)` : `⚠ ${res.error}`);
    else if (!silent) showStatus(null);
    if (!timelineInited) setupTimeline();  // net 범위는 첫 로드 기준으로 고정
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
    const f = e.features[0];
    map.getSource("launches").getClusterExpansionZoom(f.properties.cluster_id)
      .then((z) => map.easeTo({ center: f.geometry.coordinates, zoom: z }))
      .catch(() => {});
  });
  // 개별 발사 클릭 → 상세 패널
  map.on("click", "launch-point", (e) => {
    const id = e.features[0].properties.id;
    const d = launches.find((x) => x.id === id);
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
  const filtered = launches.filter((d) => launchPasses(d, active, q));
  const src = map.getSource("launches");
  if (src) src.setData(launchesToFC(filtered));  // 클러스터는 자동 재계산
}

// ── 마커 호버 툴팁 ────────────────────────────────────────────────────────────
let tooltipEl = null;
function showLaunchTooltip(e) {
  const f = e.features && e.features[0];
  if (!f) return;
  const d = launches.find((x) => x.id === f.properties.id);
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
function setupTimeline() {
  const times = launches
    .filter((d) => d.net).map((d) => new Date(d.net).getTime()).filter((t) => !isNaN(t));
  if (!times.length) return;
  tlMin = Math.min(...times);
  tlMax = Math.max(...times);
  timelineInited = true;
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
    ${row("발사 시각", fmtDate(d.net))}
    ${row("로켓", d.rocket)}
    ${row("기관", d.provider)}
    ${row("국가", countryKo(d.provider_country))}
    ${row("미션", d.mission_name)}
    ${row("종류", tr(MISSION_TYPE_KO, d.mission_type))}
    ${row("궤도", tr(ORBIT_KO, d.orbit))}
    ${row("발사장", d.location_name)}
    ${row("패드", d.pad_name)}
  `;
  panel.classList.remove("hidden");
  map.flyTo({ center: [d.lng, d.lat], zoom: 4.5, speed: 1.2 });
}

function closePanel() { document.getElementById("panel").classList.add("hidden"); }

// ── 발사 자동 갱신 ────────────────────────────────────────────────────────────
function startAutoRefresh() {
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = setInterval(() => loadLaunches(false, true), AUTO_REFRESH_MS);
}

// ── 위성 (Celestrak TLE → satellite.js SGP4 실시간 위치) ──────────────────────
function setupSatelliteLayer() {
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
      "circle-radius": 2.6,
      "circle-color": "#e8ecff",
      "circle-opacity": 0.9,
      "circle-stroke-width": 0.6,
      "circle-stroke-color": "#9fb0ff",
    },
  });
  // 위성 클릭 → 이름 팝업
  map.on("click", "sat-layer", (e) => {
    const f = e.features && e.features[0];
    if (!f) return;
    new maplibregl.Popup({ closeButton: false, offset: 8 })
      .setLngLat(e.lngLat)
      .setHTML(
        `<div style="font:12px 'Segoe UI',sans-serif;color:#0b0f1a">` +
        `🛰 ${escapeHtml(f.properties.name)}<br>` +
        `<span style="color:#4a5568">NORAD ${escapeHtml(f.properties.norad)} · 고도 ${escapeHtml(f.properties.alt)}km</span></div>`
      )
      .addTo(map);
  });
  map.on("mouseenter", "sat-layer", () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", "sat-layer", () => { map.getCanvas().style.cursor = ""; });
}

async function loadSatellites() {
  try {
    const res = await window.pywebview.api.get_satellites(false);
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
}

function startSatelliteLoop() {
  if (satTimer) clearInterval(satTimer);
  updateSatellitePositions();
  satTimer = setInterval(updateSatellitePositions, 1000);
}

function setSatelliteVisible(on) {
  if (!map.getLayer("sat-layer")) return;
  map.setLayoutProperty("sat-layer", "visibility", on ? "visible" : "none");
  if (on) {
    if (satrecs.length === 0) loadSatellites();  // 첫 켜기 때 lazy 로드
    else if (!satTimer) startSatelliteLoop();
  } else if (satTimer) {
    clearInterval(satTimer);
    satTimer = null;  // 숨김 상태에선 계산도 멈춰 자원 절약
  }
}

// ── 속보 티커 (임박한 예정 발사 순환) ─────────────────────────────────────────
function startTicker() {
  if (tickerTimer) clearInterval(tickerTimer);
  const upcoming = launches
    .filter((d) => d.outcome === "upcoming" && d.net)
    .sort((a, b) => new Date(a.net) - new Date(b.net));
  const el = document.getElementById("ticker-text");
  if (upcoming.length === 0) {
    el.textContent = "예정된 발사 정보가 없습니다.";
    return;
  }
  let idx = 0;
  const tick = () => {
    // 이미 지난 발사는 건너뛴다
    while (idx < upcoming.length && new Date(upcoming[idx].net).getTime() < Date.now()) idx++;
    if (idx >= upcoming.length) idx = 0;
    const d = upcoming[idx];
    el.textContent = `${countdown(d.net)} · ${d.name}${d.location_name ? " · " + d.location_name : ""}`;
    // 패널이 열려있으면 그 카운트다운도 갱신
    const cd = document.querySelector("#panel-body .cd");
    if (cd && cd.dataset.net) cd.textContent = countdown(cd.dataset.net);
  };
  tick();
  let secs = 0;
  tickerTimer = setInterval(() => {
    secs++;
    if (secs % 5 === 0) idx = (idx + 1) % upcoming.length;  // 5초마다 다음 발사
    tick();
  }, 1000);
}

// ── 이벤트 바인딩 ─────────────────────────────────────────────────────────────
function bindUI() {
  document.getElementById("search").addEventListener("input", applyFilters);
  document.querySelectorAll(".flt").forEach((c) => c.addEventListener("change", applyFilters));
  document.getElementById("panel-close").addEventListener("click", closePanel);
  document.getElementById("toggle-sat").addEventListener("change", (e) => setSatelliteVisible(e.target.checked));
  document.getElementById("tl-range").addEventListener("input", onTimeline);
  document.getElementById("refresh").addEventListener("click", () => {
    showStatus("강제 갱신 중… (시간당 요청 제한에 주의)");
    loadLaunches(true);
    if (document.getElementById("toggle-sat").checked) loadSatellites();
  });
}

// pywebview 브릿지가 준비된 뒤 시작
window.addEventListener("pywebviewready", () => {
  bindUI();
  initMap();
});
